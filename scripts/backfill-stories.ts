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
import { catchAllWarnings } from '../src/utils/storyMetrics.js';
import { storyTopicIds } from '../src/config/settings.js';
import { dedupeByNormalizedUrl } from '../src/utils/articleDedupe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// .env は丸ごと流し込まない。中の AWS_ACCESS_KEY_ID（SES用）が ~/.aws のプロファイルより
// 優先されてしまい、バケットの権限が足りずに必ず失敗するため、必要なキーだけ取る
const envPath = path.resolve(__dirname, '../.env');
const envFile = fs.existsSync(envPath)
  ? dotenv.parse(fs.readFileSync(envPath))
  : ({} as Record<string, string>);
if (!process.env.ANTHROPIC_API_KEY && envFile.ANTHROPIC_API_KEY) {
  process.env.ANTHROPIC_API_KEY = envFile.ANTHROPIC_API_KEY;
}

const args = process.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}
const dryRun = args.includes('--dry-run');
/** S3を読まず、キャッシュ済みのアーカイブだけで走る。.env のSESキーではS3権限が無いため既定にしたい場面が多い */
const localOnly = args.includes('--local');
const from = arg('from');
const to = arg('to');
const outPath = path.resolve(arg('out') ?? path.join(__dirname, '../.local/stories.json'));
const cacheDir = path.resolve(arg('cache') ?? path.join(__dirname, '../.local/archive'));

function inRange(archive: RunArchive): boolean {
  if (from && archive.isoDate < from) return false;
  if (to && archive.isoDate > to) return false;
  return true;
}

/** キャッシュ済みのアーカイブだけで走る（--local）。S3の認証も通信も要らない */
function loadArchivesFromCache(): RunArchive[] {
  return fs
    .readdirSync(cacheDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf-8')) as RunArchive)
    .filter(inRange)
    .sort((a, b) => (a.isoDate < b.isoDate ? -1 : 1));
}

/** アーカイブをローカルにキャッシュしてから読む（再実行でS3を叩き直さない） */
async function loadArchives(): Promise<RunArchive[]> {
  if (localOnly) return loadArchivesFromCache();
  fs.mkdirSync(cacheDir, { recursive: true });
  const bucket = process.env.STORAGE_BUCKET ?? envFile.STORAGE_BUCKET;
  if (!bucket) throw new Error('STORAGE_BUCKET が未設定です');

  const s3 = new S3Client({ region: process.env.AWS_REGION ?? envFile.AWS_REGION ?? 'ap-northeast-1' });
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
    if (!inRange(archive)) continue;
    out.push(archive);
  }
  return out.sort((a, b) => (a.isoDate < b.isoDate ? -1 : 1));
}

// 台帳に載せるのは topics.yaml で story: true のトピックだけ（判断根拠は topics.yaml のコメント）
const STORY_TOPICS = storyTopicIds();

function toArticles(archive: RunArchive): AssignableArticle[] {
  const candidates = Object.entries(archive.byTopic)
    .filter(([topic]) => STORY_TOPICS.has(topic))
    .flatMap(([topic, items]) =>
      items.map((item) => ({ ...item, topic }))
    );
  return dedupeByNormalizedUrl(
    candidates,
    (candidate, current) => candidate.score > current.score
  ).map((item) => ({
    id: articleId(item.url),
    title: item.title,
    summary: item.summary,
    topic: item.topic,
  }));
}

async function main(): Promise<void> {
  const archives = await loadArchives();
  const totalArticles = archives.reduce((s, a) => s + toArticles(a).length, 0);
  console.log(
    `対象: ${archives.length}日 (${archives[0]?.isoDate} 〜 ${archives[archives.length - 1]?.isoDate}) / 記事 ${totalArticles}件`
  );
  console.log(`対象トピック: ${[...STORY_TOPICS].join(', ')}\n`);

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
  const warned = new Set<string>();
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
        (r.mergedByTitle > 0 ? ` (同名寄せ${r.mergedByTitle})` : '') +
        `  候補${r.candidatesBefore}→${r.candidatesAfter}本` +
        `  累計ストーリー${ledger.stories.length}本  $${cost.toFixed(4)}`
    );

    // 受け皿化はその場で気づけないと最後まで走ってから作り直しになる
    for (const w of catchAllWarnings(ledger)) {
      if (!warned.has(w.storyId)) {
        warned.add(w.storyId);
        console.log(
          `    ⚠ 受け皿化の疑い: ${w.storyId} [${w.topic}] 「${w.title}」` +
            ` ${w.articleCount}/${w.topicTotal}件 (${(100 * w.share).toFixed(0)}%)`
        );
      }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(ledger, null, 2));
  }

  console.log(`\n台帳: ${outPath}`);
  console.log(`ストーリー ${ledger.stories.length}本 / 総コスト $${cost.toFixed(4)}`);

  const finalWarnings = catchAllWarnings(ledger);
  if (finalWarnings.length === 0) {
    console.log('受け皿化の疑いがあるストーリー: なし');
  } else {
    console.log(`受け皿化の疑い ${finalWarnings.length}本:`);
    for (const w of finalWarnings) {
      console.log(
        `  ${w.storyId} [${w.topic}] 「${w.title}」 ${w.articleCount}/${w.topicTotal}件 (${(100 * w.share).toFixed(0)}%)`
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
