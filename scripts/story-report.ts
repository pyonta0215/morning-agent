/**
 * バックフィルした台帳を評価する。
 *
 * 出す数字:
 *   - ストーリー数と1記事ストーリーの比率（割当プロンプトが機能しているかの判定）
 *   - 型判定（継続中/一時的/発生中/単発）の分布と、長期フラグ
 *   - 上位ストーリーの目視用一覧（無内容な受け皿になっていないかの確認）
 *   - 日次の変化（新規 / steady昇格 / dormant化）← メールを「変化の通知」にできるかの判断材料
 *
 *   npx tsx scripts/story-report.ts [--ledger .local/stories.json]
 */
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type { StoryLedger } from '../src/utils/storyLedger.js';
import {
  stats,
  dailyChanges,
  catchAllWarnings,
  KIND_LABEL,
  CATCH_ALL_SHARE,
  type StoryKind,
} from '../src/utils/storyMetrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf('--ledger');
const ledgerPath = path.resolve(i !== -1 ? args[i + 1] : path.join(__dirname, '../.local/stories.json'));

const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as StoryLedger;
const stories = ledger.stories.filter((s) => !s.mergedInto);

const allDates = [...new Set(stories.flatMap((s) => Object.keys(s.dailyCounts)))].sort();
const totalArticles = stories.reduce((s, x) => s + x.articleIds.length, 0);
const singletons = stories.filter((s) => s.articleIds.length === 1);

console.log('=== 全体 ===');
console.log(`期間          ${allDates[0]} 〜 ${allDates[allDates.length - 1]} (${allDates.length}日)`);
console.log(`記事          ${totalArticles}件`);
console.log(`ストーリー    ${stories.length}本`);
console.log(`1記事のみ     ${singletons.length}本 (${((100 * singletons.length) / stories.length).toFixed(1)}%)`);
console.log(`平均記事数    ${(totalArticles / stories.length).toFixed(2)}件/本`);

console.log('\n=== 型判定の分布 ===');
const kinds: Record<StoryKind, number> = { steady: 0, spike: 0, developing: 0, unknown: 0 };
let longRunning = 0;
for (const s of stories) {
  const st = stats(s);
  if (!st) continue;
  kinds[st.kind]++;
  if (st.isLongRunning) longRunning++;
}
for (const [k, n] of Object.entries(kinds)) {
  console.log(
    `${k.padEnd(12)} ${KIND_LABEL[k as StoryKind].padEnd(5)} ${String(n).padStart(4)}本 (${((100 * n) / stories.length).toFixed(1)}%)`
  );
}
console.log(
  `${'(長期)'.padEnd(12)} ${'14日以上'.padEnd(3)} ${String(longRunning).padStart(4)}本 (${((100 * longRunning) / stories.length).toFixed(1)}%) ※kindと直交`
);

console.log('\n=== トピック別 ===');
const byTopic = new Map<string, { n: number; articles: number }>();
for (const s of stories) {
  const e = byTopic.get(s.topic) ?? { n: 0, articles: 0 };
  e.n++;
  e.articles += s.articleIds.length;
  byTopic.set(s.topic, e);
}
for (const [t, e] of [...byTopic].sort((a, b) => b[1].articles - a[1].articles)) {
  const inTopic = stories.filter((s) => s.topic === t);
  const maxShare = Math.max(...inTopic.map((s) => s.articleIds.length)) / e.articles;
  const single = inTopic.filter((s) => s.articleIds.length === 1).length;
  console.log(
    `${t.padEnd(12)} ストーリー${String(e.n).padStart(4)}本 / 記事${String(e.articles).padStart(4)}件 (${(e.articles / e.n).toFixed(2)}件/本)` +
      ` / 最大ストーリー占有率 ${(100 * maxShare).toFixed(0)}% / 1記事のみ ${((100 * single) / e.n).toFixed(0)}%`
  );
}

console.log(`\n=== 受け皿化の疑い（トピック内 ${(100 * CATCH_ALL_SHARE).toFixed(0)}% 超） ===`);
const warnings = catchAllWarnings(ledger);
if (warnings.length === 0) {
  console.log('なし');
} else {
  for (const w of warnings) {
    console.log(
      `${w.storyId} [${w.topic}] ${w.articleCount}/${w.topicTotal}件 (${(100 * w.share).toFixed(0)}%) ${w.title}`
    );
  }
}

console.log('\n=== 記事数の多いストーリー 上位20（受け皿化していないかの目視用） ===');
for (const s of [...stories].sort((a, b) => b.articleIds.length - a.articleIds.length).slice(0, 20)) {
  const st = stats(s)!;
  console.log(
    `${String(s.articleIds.length).padStart(3)}件 ${String(st.spanDays).padStart(3)}日 ${st.kind.padEnd(11)} [${s.topic}] ${s.title}`
  );
}

console.log('\n=== 継続日数の長いストーリー 上位15 ===');
for (const s of [...stories].sort((a, b) => (stats(b)!.spanDays - stats(a)!.spanDays)).slice(0, 15)) {
  const st = stats(s)!;
  console.log(
    `${String(st.spanDays).padStart(3)}日 ${String(s.articleIds.length).padStart(3)}件 ${st.kind.padEnd(11)} ${s.firstSeen}〜${s.lastSeen} [${s.topic}] ${s.title}`
  );
}

console.log('\n=== 日次の変化（メールを「変化の通知」にできるか） ===');
const changes = dailyChanges(ledger, allDates);
console.log('日付         新規  昇格  終了  既存へ追記');
for (const c of changes) {
  console.log(
    `${c.date}  ${String(c.created).padStart(4)}  ${String(c.promoted).padStart(4)}  ${String(c.wentDormant).padStart(4)}  ${String(c.touched).padStart(4)}`
  );
}

const withPromotion = changes.filter((c) => c.promoted > 0).length;
const withDormant = changes.filter((c) => c.wentDormant > 0).length;
const withAny = changes.filter((c) => c.promoted > 0 || c.wentDormant > 0).length;
const avgCreated = changes.reduce((s, c) => s + c.created, 0) / changes.length;
const avgTouched = changes.reduce((s, c) => s + c.touched, 0) / changes.length;

console.log('\n--- 集計 ---');
console.log(`新規が出た日        ${changes.filter((c) => c.created > 0).length}/${changes.length}日 (平均 ${avgCreated.toFixed(1)}本/日)`);
console.log(`既存への追記があった日 ${changes.filter((c) => c.touched > 0).length}/${changes.length}日 (平均 ${avgTouched.toFixed(1)}本/日)`);
console.log(`steady昇格があった日  ${withPromotion}/${changes.length}日`);
console.log(`dormant化があった日   ${withDormant}/${changes.length}日`);
console.log(`昇格か終了があった日  ${withAny}/${changes.length}日 (${((100 * withAny) / changes.length).toFixed(0)}%)`);
