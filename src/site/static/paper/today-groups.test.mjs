/**
 * 「今日」画面の記事分類（classifyTodayArticles）だけを検査する。
 * index.html は DOM 前提の IIFE を含むため丸ごとは評価せず、IIFE 開始行の手前
 * （純粋関数の定義部分）だけをソースから切り出して評価する。
 *
 *   node --test src/site/static/paper/today-groups.test.mjs
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf-8');
const scriptBody = html.split('<script>\n')[1].split('\n(function () {')[0];

const { classifyTodayArticles } = new Function(
  `${scriptBody}; return { classifyTodayArticles: classifyTodayArticles };`
)();

function story(overrides) {
  return Object.assign(
    {
      id: 's1',
      title: 'テスト話題',
      topic: 'ai',
      firstSeen: '2026-08-29',
      lastSeen: '2026-08-30',
      dates: ['2026-08-29', '2026-08-30'],
      articleIds: [],
      count: 2,
    },
    overrides
  );
}

const LAST = '2026-08-30';

test('新規話題の記事は new グループへ入る', () => {
  const s = story({ id: 'new1', firstSeen: LAST, lastSeen: LAST, dates: [LAST], articleIds: ['a1'], count: 1 });
  const groups = classifyTodayArticles([s], ['a1'], LAST);
  assert.equal(groups.new.length, 1);
  assert.equal(groups.new[0].id, 'a1');
  assert.equal(groups.new[0].storyId, 'new1');
  assert.equal(groups.continued.length, 0);
  assert.equal(groups.solo.length, 0);
});

test('続報の記事は continued グループへ入り、何日目・何日ぶりが付く', () => {
  const s = story({
    id: 'cont1', firstSeen: '2026-08-10', lastSeen: LAST,
    dates: ['2026-08-10', '2026-08-20', LAST], articleIds: ['a1'], count: 3,
  });
  const groups = classifyTodayArticles([s], ['a1'], LAST);
  assert.equal(groups.continued.length, 1);
  assert.equal(groups.continued[0].dayNumber, 3);
  assert.equal(groups.continued[0].gapDays, 10);
});

test('話題化されていない記事（どの story にも属さない）は solo グループへ入る', () => {
  const s = story({ id: 's1', firstSeen: LAST, lastSeen: LAST, dates: [LAST], articleIds: ['a1'], count: 1 });
  const groups = classifyTodayArticles([s], ['a1', 'a-orphan'], LAST);
  assert.equal(groups.solo.length, 1);
  assert.equal(groups.solo[0].id, 'a-orphan');
});

test('話題が0件（stories が空）でもエラーにならず全記事が solo になる', () => {
  const groups = classifyTodayArticles([], ['a1', 'a2'], LAST);
  assert.deepEqual(groups.new, []);
  assert.deepEqual(groups.continued, []);
  assert.equal(groups.solo.length, 2);
});

test('今日の記事が0件なら全グループが空配列', () => {
  const s = story({ id: 's1', firstSeen: LAST, dates: [LAST], articleIds: ['a1'], count: 1 });
  const groups = classifyTodayArticles([s], [], LAST);
  assert.deepEqual(groups, { new: [], continued: [], solo: [] });
});

test('1記事は必ず1グループにのみ入る（新規・続報・単発が混在しても重複しない）', () => {
  const stories = [
    story({ id: 'new1', firstSeen: LAST, dates: [LAST], articleIds: ['a-new'], count: 1 }),
    story({ id: 'cont1', firstSeen: '2026-08-20', dates: ['2026-08-20', LAST], articleIds: ['a-cont'], count: 2 }),
  ];
  const todayIds = ['a-new', 'a-cont', 'a-solo'];
  const groups = classifyTodayArticles(stories, todayIds, LAST);
  const allIds = groups.new.map((x) => x.id).concat(groups.continued.map((x) => x.id), groups.solo.map((x) => x.id));
  assert.deepEqual(allIds.slice().sort(), todayIds.slice().sort());
  assert.equal(new Set(allIds).size, todayIds.length);
});

test('続報で前回出現日が無い（データ不整合な単日 story）場合 gapDays は null', () => {
  const s = story({ id: 'weird', firstSeen: '2026-08-01', lastSeen: LAST, dates: [LAST], articleIds: ['a1'], count: 1 });
  const groups = classifyTodayArticles([s], ['a1'], LAST);
  assert.equal(groups.continued.length, 1);
  assert.equal(groups.continued[0].gapDays, null);
});
