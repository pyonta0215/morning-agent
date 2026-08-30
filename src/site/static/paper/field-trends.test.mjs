/**
 * 「分野の動向」の週次集計（buildFieldTrends）だけを検査する。
 * index.html は DOM 前提の IIFE を含むため丸ごとは評価せず、IIFE 開始行の手前
 * （純粋関数の定義部分）だけをソースから切り出して評価する。
 *
 *   node --test src/site/static/paper/field-trends.test.mjs
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf-8');
const scriptBody = html.split('<script>\n')[1].split('\n(function () {')[0];

const { buildFieldTrends, weekStart } = new Function(
  `${scriptBody}; return { buildFieldTrends: buildFieldTrends, weekStart: weekStart };`
)();

// 2026-08-30 は日曜日（週の始まり）。この日を「今週」の代表日として使う。
const LAST = '2026-08-30';
const TOPICS = [{ id: 'ai', label: 'AI総合' }, { id: 'ai_oss', label: 'OSS実装' }];

function day(date, articleIds) {
  return { date, edition: 'morning', articleIds };
}
function article(id, topic, date) {
  return { id, topic, date };
}

test('weekStart は日曜始まりの週頭を返す', () => {
  assert.equal(weekStart('2026-08-30'), '2026-08-30'); // 日曜そのもの
  assert.equal(weekStart('2026-08-24'), '2026-08-23'); // 月曜 → 前日の日曜
  assert.equal(weekStart('2026-08-29'), '2026-08-23'); // 土曜 → 同じ週の日曜
});

test('直近8週ぶんの週配列を返し、最新週が今日を含む週になる', () => {
  const trends = buildFieldTrends([], [], TOPICS, LAST, 8);
  assert.equal(trends.length, TOPICS.length);
  assert.equal(trends[0].weeklyCounts.length, 8);
  assert.equal(trends[0].weekStarts[7], '2026-08-30');
  assert.equal(trends[0].weekStarts[6], '2026-08-23');
});

test('今週・前週の件数と増減（delta）が正しく計算される', () => {
  const days = [
    day('2026-08-23', ['a1', 'a2']), // 前週: 2件
    day(LAST, ['a3']), // 今週: 1件
  ];
  const articles = [article('a1', 'ai', '2026-08-23'), article('a2', 'ai', '2026-08-23'), article('a3', 'ai', LAST)];
  const trends = buildFieldTrends(days, articles, TOPICS, LAST, 8);
  const ai = trends.find((t) => t.topicId === 'ai');
  assert.equal(ai.thisWeek, 1);
  assert.equal(ai.lastWeek, 2);
  assert.equal(ai.delta, -1);
  assert.equal(ai.trend, 'down');
});

test('前週0件・今週N件のとき delta は今週件数と同じで trend は up（ゼロ除算しない）', () => {
  const days = [day(LAST, ['a1', 'a2', 'a3'])];
  const articles = [article('a1', 'ai', LAST), article('a2', 'ai', LAST), article('a3', 'ai', LAST)];
  const trends = buildFieldTrends(days, articles, TOPICS, LAST, 8);
  const ai = trends.find((t) => t.topicId === 'ai');
  assert.equal(ai.thisWeek, 3);
  assert.equal(ai.lastWeek, 0);
  assert.equal(ai.delta, 3);
  assert.equal(ai.trend, 'up');
});

test('今週・前週とも0件のとき delta は0で trend は flat', () => {
  const trends = buildFieldTrends([], [], TOPICS, LAST, 8);
  trends.forEach((t) => {
    assert.equal(t.thisWeek, 0);
    assert.equal(t.lastWeek, 0);
    assert.equal(t.delta, 0);
    assert.equal(t.trend, 'flat');
  });
});

test('今週=前週で増減なしのとき trend は flat', () => {
  const days = [day('2026-08-23', ['a1']), day(LAST, ['a2'])];
  const articles = [article('a1', 'ai', '2026-08-23'), article('a2', 'ai', LAST)];
  const trends = buildFieldTrends(days, articles, TOPICS, LAST, 8);
  const ai = trends.find((t) => t.topicId === 'ai');
  assert.equal(ai.thisWeek, 1);
  assert.equal(ai.lastWeek, 1);
  assert.equal(ai.delta, 0);
  assert.equal(ai.trend, 'flat');
});

test('観測期間が8週に満たない「初週」でも、古い週は0件のまま破綻しない', () => {
  // 観測はこの1日だけ（初回配信）
  const days = [day(LAST, ['a1'])];
  const articles = [article('a1', 'ai', LAST)];
  const trends = buildFieldTrends(days, articles, TOPICS, LAST, 8);
  const ai = trends.find((t) => t.topicId === 'ai');
  assert.deepEqual(ai.weeklyCounts.slice(0, 7), [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(ai.weeklyCounts[7], 1);
});

test('週境界: 週の最終日と翌週の初日で別の週に集計される', () => {
  // 2026-08-23（日）が週頭、2026-08-29（土）が週末、2026-08-30（日）は翌週
  const days = [day('2026-08-29', ['a1']), day('2026-08-30', ['a2'])];
  const articles = [article('a1', 'ai', '2026-08-29'), article('a2', 'ai', '2026-08-30')];
  const trends = buildFieldTrends(days, articles, TOPICS, '2026-08-30', 8);
  const ai = trends.find((t) => t.topicId === 'ai');
  assert.equal(ai.lastWeek, 1); // 8/29 は前週
  assert.equal(ai.thisWeek, 1); // 8/30 は今週
});

test('観測範囲より8週以上前の記事は無視される', () => {
  const days = [day('2025-01-01', ['a1']), day(LAST, ['a2'])];
  const articles = [article('a1', 'ai', '2025-01-01'), article('a2', 'ai', LAST)];
  const trends = buildFieldTrends(days, articles, TOPICS, LAST, 8);
  const ai = trends.find((t) => t.topicId === 'ai');
  const total = ai.weeklyCounts.reduce((a, b) => a + b, 0);
  assert.equal(total, 1); // 2025-01-01 分はカウントされない
});

test('トピックに属さない記事があっても他の集計は壊れない', () => {
  const days = [day(LAST, ['a1', 'a-unknown-topic'])];
  const articles = [article('a1', 'ai', LAST), article('a-unknown-topic', 'not_in_topics', LAST)];
  const trends = buildFieldTrends(days, articles, TOPICS, LAST, 8);
  const ai = trends.find((t) => t.topicId === 'ai');
  assert.equal(ai.thisWeek, 1);
});
