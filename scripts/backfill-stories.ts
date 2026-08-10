/**
 * 過去の実行アーカイブからストーリー台帳を遡って生成する。
 *
 * 記事は publishedAt を持つストック型のデータなので、ストーリーの過去は復元できる
 * （yt-research-radar が「動画データは初回取得で過去が復元できる」と切り分けていたのと同じ）。
 * これにより「話題の寿命」「じわじわ続いている話題」が観測初日から出せる。
 *
 * 使い方:
 *   npx tsx scripts/backfill-stories.ts --dry-run          # LLMを呼ばず対象日と件数だけ出す
 *   npx tsx scripts/backfill-stories.ts --from 2026-06-12 --to 2026-06-20
 *   npx tsx scripts/backfill-stories.ts                    # 全期間
 *
 * 既定ではS3を読み、台帳はローカルに書く（--out）。本番の台帳は上書きしない。
 */
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { S3Client } from '@aws-sdk/client-s3';
import { listRunArchiveKeys, loadRunArchive, type RunArchive } from '../src/utils/runArchive.js';
import {
  emptyLedger,
  articleId,
  type StoryLedger,
} from '../src/utils/storyLedger.js';
import { assignArticlesToStories, type AssignableArticle } from '../src/agents/storyAgent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}
const dryRun = args.includes('--dry-run');
const from = arg('from');
const to = arg('to');
const outPath = path.resolve(arg('out') ?? path.join(__dirname, '../.local/stories.json'));
const cacheDir = path.resolve(arg('cache') ?? path.join(__dirname, '../.local/archive'));

/** アーカイブをローカルにキャッシュしてから読む（再実行でS3を叩き直さない） */
async function loadArchives(): Promise<RunArchive[]> {
  fs.mkdirSync(cacheDir, { recursive: true });
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error('STORAGE_BUCKET が未設定です');

  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
  const keys = await listRunArchiveKeys(s3, bucket);
  const out: RunArchive[] = [];

  for (const key of keys) {
    const local = path.join(cacheDir, path.basename(key));
    let archive: RunArchive | null = null;
    if (fs.existsSync(local)) {
      archive = JSON.parse(fs.readFileSync(local, 'utf-8')) as RunArchive;
    } else {
      archive = await loadRunArchive(s3, bucket, key);
      if (archive) fs.writeFileSync(local, JSON.stringify(archive));
    }
    if (!archive) continue;
    if (from && archive.isoDate < from) continue;
    if (to && archive.isoDate > to) continue;
    out.push(archive);
  }
  return out.sort((a, b) => (a.isoDate < b.isoDate ? -1 : 1));
}

function toArticles(archive: RunArchive): AssignableArticle[] {
  return Object.entries(archive.byTopic).flatMap(([topic, items]) =>
    items.map((i) => ({
      id: articleId(i.url),
      title: i.title,
      summary: i.summary,
      topic,
    }))
  );
}

async function main(): Promise<void> {
  const archives = await loadArchives();
  const totalArticles = archives.reduce((s, a) => s + toArticles(a).length, 0);
  console.log(
    `対象: ${archives.length}日 (${archives[0]?.isoDate} 〜 ${archives[archives.length - 1]?.isoDate}) / 記事 ${totalArticles}件`
  );

  if (dryRun) {
    for (const a of archives) console.log(`  ${a.isoDate}  記事${toArticles(a).length}件`);
    return;
  }

  const client = new Anthropic();
  const ledger: StoryLedger = fs.existsSync(outPath)
    ? (JSON.parse(fs.readFileSync(outPath, 'utf-8')) as StoryLedger)
    : emptyLedger();

  // 既に処理済みの日はスキップする（途中で落ちても再開できる）
  const done = new Set(ledger.stories.flatMap((s) => Object.keys(s.dailyCounts)));

  let cost = 0;
  for (const archive of archives) {
    if (done.has(archive.isoDate)) {
      console.log(`  ${archive.isoDate}  skip (処理済み)`);
      continue;
    }
    const articles = toArticles(archive);
    if (articles.length === 0) {
      console.log(`  ${archive.isoDate}  記事0件`);
      continue;
    }

    const r = await assignArticlesToStories(client, ledger, archive.isoDate, articles);
    cost += r.costUsd;
    console.log(
      `  ${archive.isoDate}  記事${articles.length}件 → 既存${r.assigned} 新規${r.created}` +
        (r.rejectedCrossTopic > 0 ? ` (トピック跨ぎ差戻し${r.rejectedCrossTopic})` : '') +
        `  累計ストーリー${ledger.stories.length}本  $${cost.toFixed(4)}`
    );

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(ledger, null, 2));
  }

  console.log(`\n台帳: ${outPath}`);
  console.log(`ストーリー ${ledger.stories.length}本 / 総コスト $${cost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
