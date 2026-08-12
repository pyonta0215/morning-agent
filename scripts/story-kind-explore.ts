/**
 * 型判定（#6）のしきい値を実データの分布から決めるための探索スクリプト。
 *
 * 1回目のバックフィルでは smoldering が0本・spike が1.1%・unknown が74.9% で、
 * 「じわじわ続いている話題」というこの企画の主眼が判定として出てこなかった。
 * しきい値を先に決め打ちしたのが原因なので、ここで生の分布を見てから確定する。
 *
 *   npx tsx scripts/story-kind-explore.ts [--ledger .local/stories.json]
 */
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type { StoryLedger, Story } from '../src/utils/storyLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const i = args.indexOf('--ledger');
const ledgerPath = path.resolve(
  i !== -1 ? args[i + 1] : path.join(__dirname, '../.local/stories.json')
);
const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as StoryLedger;
const stories = ledger.stories.filter((s) => !s.mergedInto);

function dayDiff(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00+09:00`) - Date.parse(`${a}T00:00:00+09:00`)) / 86_400_000
  );
}

interface Row {
  s: Story;
  n: number;
  span: number;
  activeDays: number;
  density: number;
  maxDayShare: number;
}

const rows: Row[] = stories.map((s) => {
  const counts = Object.entries(s.dailyCounts);
  const dates = counts.map(([d]) => d).sort();
  const n = counts.reduce((x, [, c]) => x + c, 0);
  const span = dayDiff(dates[0], dates[dates.length - 1]) + 1;
  return {
    s,
    n,
    span,
    activeDays: counts.length,
    density: n / span,
    maxDayShare: Math.max(...counts.map(([, c]) => c)) / n,
  };
});

function histogram(label: string, values: number[], buckets: Array<[number, number]>): void {
  console.log(`\n--- ${label} ---`);
  for (const [lo, hi] of buckets) {
    const n = values.filter((v) => v >= lo && v < hi).length;
    const bar = '█'.repeat(Math.round((60 * n) / values.length));
    console.log(
      `${String(lo).padStart(4)}〜${hi === Infinity ? '  ∞' : String(hi).padStart(3)}  ${String(n).padStart(4)}本 (${((100 * n) / values.length).toFixed(1).padStart(5)}%) ${bar}`
    );
  }
}

console.log(`ストーリー ${rows.length}本 / 記事 ${rows.reduce((a, r) => a + r.n, 0)}件`);

histogram('記事数', rows.map((r) => r.n), [
  [1, 2], [2, 3], [3, 5], [5, 10], [10, 20], [20, Infinity],
]);
histogram('継続日数(span)', rows.map((r) => r.span), [
  [1, 2], [2, 4], [4, 8], [8, 15], [15, 30], [30, Infinity],
]);
histogram('記事が出た日数(activeDays)', rows.map((r) => r.activeDays), [
  [1, 2], [2, 3], [3, 5], [5, 10], [10, Infinity],
]);

// 記事2件以上のものだけ（1件では型を論じられない）
const multi = rows.filter((r) => r.n >= 2);
console.log(`\n=== 記事2件以上 ${multi.length}本（型判定の対象）===`);
histogram('密度 (記事数÷継続日数)', multi.map((r) => r.density), [
  [0, 0.15], [0.15, 0.3], [0.3, 0.5], [0.5, 1], [1, Infinity],
]);
histogram('最大日シェア', multi.map((r) => r.maxDayShare), [
  [0, 0.4], [0.4, 0.6], [0.6, 0.9], [0.9, Infinity],
]);

// span × density の2軸で実際に散らばりを見る
console.log('\n=== span × density のクロス集計（記事2件以上）===');
const spanBands: Array<[string, number, number]> = [
  ['〜3日', 0, 4],
  ['4〜13日', 4, 14],
  ['14日〜', 14, Infinity],
];
const densBands: Array<[string, number, number]> = [
  ['密度<0.2', 0, 0.2],
  ['0.2〜0.5', 0.2, 0.5],
  ['0.5〜', 0.5, Infinity],
];
console.log(`${''.padEnd(10)}${densBands.map(([l]) => l.padStart(10)).join('')}`);
for (const [sl, slo, shi] of spanBands) {
  const cells = densBands.map(([, dlo, dhi]) => {
    const n = multi.filter(
      (r) => r.span >= slo && r.span < shi && r.density >= dlo && r.density < dhi
    ).length;
    return String(n).padStart(10);
  });
  console.log(`${sl.padEnd(10)}${cells.join('')}`);
}

console.log('\n=== 継続日数14日以上・密度0.3未満（＝じわじわ候補）===');
for (const r of multi
  .filter((x) => x.span >= 14 && x.density < 0.3)
  .sort((a, b) => b.span - a.span)) {
  console.log(
    `${String(r.span).padStart(3)}日 ${String(r.n).padStart(2)}件 密度${r.density.toFixed(2)} [${r.s.topic}] ${r.s.title}`
  );
}
