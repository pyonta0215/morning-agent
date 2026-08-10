/**
 * 指定ストーリーに実際に入っている記事タイトルを時系列で表示する。
 * 「具体的なタイトルが付いているが中身はトピックの受け皿」になっていないかの検証用。
 *
 *   npx tsx scripts/story-inspect.ts st-20260612-0003
 *   npx tsx scripts/story-inspect.ts --top 3
 */
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type { RunArchive } from '../src/utils/runArchive.js';
import { articleId, type StoryLedger } from '../src/utils/storyLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ledger = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../.local/stories.json'), 'utf-8')
) as StoryLedger;

// アーカイブから 記事ID → {日付, タイトル} を作る
const cacheDir = path.join(__dirname, '../.local/archive');
const titleOf = new Map<string, { date: string; title: string }>();
for (const f of fs.readdirSync(cacheDir).sort()) {
  const a = JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf-8')) as RunArchive;
  for (const items of Object.values(a.byTopic)) {
    for (const it of items) titleOf.set(articleId(it.url), { date: a.isoDate, title: it.title });
  }
}

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const targets =
  topIdx !== -1
    ? [...ledger.stories]
        .sort((x, y) => y.articleIds.length - x.articleIds.length)
        .slice(0, Number(args[topIdx + 1] ?? 3))
    : ledger.stories.filter((s) => args.includes(s.id));

for (const s of targets) {
  console.log(`\n=== ${s.id} [${s.topic}] 記事${s.articleIds.length}件 ${s.firstSeen}〜${s.lastSeen}`);
  console.log(`    「${s.title}」`);
  const rows = s.articleIds
    .map((id) => titleOf.get(id))
    .filter((r): r is { date: string; title: string } => Boolean(r))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const r of rows) console.log(`  ${r.date}  ${r.title}`);
}
