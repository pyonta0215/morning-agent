/**
 * 過去のアーカイブに記事の同一性情報をさかのぼって付ける（#2）。
 *
 * **`archive/` は書き換えない。** 生データとして不変に保ち、派生は `enriched/` に書く。
 *
 * ## 何を、どこから復元するか
 *
 * RSSはもう流れてしまっているが、`archive/*.json` の `sources[].content` に
 * **収集時にパースしたRSSのテキストがそのまま残っている**。ここにURLと日付と
 * RSSの生の見出しが入っているので、記事URLで引き当てて拾える。
 *
 * | | 直fetch由来 | Google News由来 |
 * |---|---|---|
 * | id | URLから（100%） | URLから（100%） |
 * | guid | 無し | URLから復元（100%） |
 * | publishedAt | sources の「日付:」行 | 同左 |
 * | 発行元 | URLのホスト（100%） | RSS見出し末尾の ` - 発行元` |
 *
 * 当初案にあった実URL解決は入れていない。2026-08-13 時点で
 * `Fbv4je`/`garturlreq` がエラーを返し、記事HTMLにも実URLが無いため
 * （詳細は src/utils/articleIdentity.ts のヘッダ）。
 *
 *   AWS_REGION=ap-northeast-1 npx tsx scripts/backfill-identity.ts --dry-run
 *   AWS_REGION=ap-northeast-1 npx tsx scripts/backfill-identity.ts
 *   AWS_REGION=ap-northeast-1 npx tsx scripts/backfill-identity.ts --force
 */
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { S3Client } from '@aws-sdk/client-s3';
import { listRunArchiveKeys, loadRunArchive, type RunArchive } from '../src/utils/runArchive.js';
import { buildIdentity, type ArticleIdentity } from '../src/utils/articleIdentity.js';
import { saveEnrichedRun, loadEnrichedRun } from '../src/utils/enrichedStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env を丸ごと読むと中の SES 用 AWS_ACCESS_KEY_ID が ~/.aws より優先されて権限不足になる
const envPath = path.resolve(__dirname, '../.env');
const envFile = fs.existsSync(envPath)
  ? dotenv.parse(fs.readFileSync(envPath))
  : ({} as Record<string, string>);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}
const from = arg('from');
const to = arg('to');

/**
 * アーカイブ済みのRSSテキストから、URLごとの「日付」と「生の見出し」を拾う。
 *
 * ブロックの形は parseRss が書いたもの:
 *   [記事1]
 *   タイトル: ...
 *   URL: ...
 *   日付: ...
 *   概要: ...
 */
function indexArchivedRss(archive: RunArchive): Map<string, { title?: string; pubDate?: string }> {
  const out = new Map<string, { title?: string; pubDate?: string }>();
  for (const source of archive.sources) {
    for (const block of source.content.split(/\n\n(?=\[記事\d+\])/)) {
      const url = block.match(/^URL: (.+)$/m)?.[1]?.trim();
      if (!url) continue;
      out.set(url, {
        title: block.match(/^タイトル: (.+)$/m)?.[1]?.trim(),
        pubDate: block.match(/^日付: (.+)$/m)?.[1]?.trim(),
      });
    }
  }
  return out;
}

function identitiesFor(archive: RunArchive): ArticleIdentity[] {
  const rss = indexArchivedRss(archive);
  return Object.values(archive.byTopic)
    .flat()
    .map((item) => {
      const meta = rss.get(item.url);
      return buildIdentity({
        url: item.url,
        pubDate: meta?.pubDate,
        // 過去分に <source> は残っていない。Google News は見出し末尾から拾う
        rssTitle: meta?.title,
        fallbackDate: archive.isoDate,
      });
    });
}

async function main(): Promise<void> {
  const bucket = process.env.STORAGE_BUCKET ?? envFile.STORAGE_BUCKET;
  if (!bucket) throw new Error('STORAGE_BUCKET が未設定です');
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? envFile.AWS_REGION ?? 'ap-northeast-1' });

  const keys = await listRunArchiveKeys(s3, bucket);
  console.log(`アーカイブ ${keys.length}件`);

  const totals = { files: 0, skipped: 0, articles: 0, withSource: 0, withRealDate: 0, guid: 0 };
  const bySource: Record<string, number> = {};

  for (const key of keys) {
    const archive = await loadRunArchive(s3, bucket, key);
    if (!archive) continue;
    if (from && archive.isoDate < from) continue;
    if (to && archive.isoDate > to) continue;

    if (!force) {
      const existing = await loadEnrichedRun(s3, bucket, archive.isoDate, archive.edition);
      if (existing) {
        totals.skipped++;
        continue;
      }
    }

    const articles = identitiesFor(archive);
    totals.files++;
    totals.articles += articles.length;
    totals.withSource += articles.filter((a) => a.sourceName).length;
    totals.withRealDate += articles.filter((a) => a.publishedAtSource === 'rss').length;
    totals.guid += articles.filter((a) => a.guid).length;
    for (const a of articles) bySource[a.sourceFrom] = (bySource[a.sourceFrom] ?? 0) + 1;

    const missing = articles.filter((a) => !a.sourceName).length;
    console.log(
      `  ${archive.isoDate}-${archive.edition}  記事${String(articles.length).padStart(2)}件` +
        `  発行元${articles.length - missing}/${articles.length}` +
        `  公開日時(実測)${articles.filter((a) => a.publishedAtSource === 'rss').length}` +
        (dryRun ? '  [dry-run]' : '')
    );

    if (!dryRun) {
      await saveEnrichedRun(s3, bucket, {
        isoDate: archive.isoDate,
        edition: archive.edition,
        generatedAt: new Date().toISOString(),
        articles,
      });
    }
  }

  const pct = (n: number): string =>
    totals.articles === 0 ? '—' : `${((100 * n) / totals.articles).toFixed(1)}%`;
  console.log(
    `\n書き出し ${totals.files}件 / スキップ ${totals.skipped}件（既に enriched/ がある）\n` +
      `記事 ${totals.articles}件\n` +
      `  発行元あり        ${totals.withSource} (${pct(totals.withSource)})\n` +
      `  公開日時が実測    ${totals.withRealDate} (${pct(totals.withRealDate)})  ※残りは紙面掲載日で代用\n` +
      `  guidあり          ${totals.guid} (${pct(totals.guid)})  ※Google News由来\n` +
      `  発行元の取得元    ${JSON.stringify(bySource)}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
