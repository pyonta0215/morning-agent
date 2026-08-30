/**
 * 「今朝の要点」候補抽出・順位付け（selectMorningHighlights）だけを検査する。
 * index.html は DOM 前提の IIFE を含むため丸ごとは評価せず、IIFE 開始行の手前
 * （純粋関数の定義部分）だけをソースから切り出して評価する。
 *
 *   node --test src/site/static/paper/highlights.test.mjs
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf-8');
const scriptBody = html.split('<script>\n')[1].split('\n(function () {')[0];

const { selectMorningHighlights } = new Function(
  `${scriptBody}; return { selectMorningHighlights: selectMorningHighlights };`
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

function article(overrides) {
  return Object.assign(
    {
      id: 'a1',
      title: '記事',
      summary: '要約文。',
      url: 'https://example.com/a1',
      topic: 'ai',
      score: 3,
      date: '2026-08-30',
      sourceName: 'Source A',
    },
    overrides
  );
}

const LAST = '2026-08-30';

test('今日はじめて出た話題は新規として1件返る', () => {
  const s = story({ id: 'new1', firstSeen: LAST, lastSeen: LAST, dates: [LAST], articleIds: ['a1'], count: 1 });
  const a = article({ id: 'a1', date: LAST, score: 4, summary: '新しい話題の要約。' });
  const result = selectMorningHighlights([s], [a], LAST);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'new1');
  assert.equal(result[0].status, '新規');
  assert.equal(result[0].summary, '新しい話題の要約。');
});

test('今日 dates に含まれる話題は続報として返る', () => {
  const s = story({ id: 'cont1', firstSeen: '2026-08-20', lastSeen: LAST, dates: ['2026-08-20', LAST], articleIds: ['a1'], count: 2 });
  const a = article({ id: 'a1', date: LAST });
  const result = selectMorningHighlights([s], [a], LAST);
  assert.equal(result.length, 1);
  assert.equal(result[0].status, '続報');
});

test('今日の記事が無い話題（終了のみ）は候補に入らない', () => {
  const s = story({ id: 'ended', firstSeen: '2026-08-01', lastSeen: '2026-08-22', dates: ['2026-08-01', '2026-08-22'], articleIds: ['a1'], count: 2 });
  const a = article({ id: 'a1', date: '2026-08-22' });
  const result = selectMorningHighlights([s], [a], LAST);
  assert.deepEqual(result, []);
});

test('今日動いた話題が0件のときは空配列を返す（一面のフォールバック判定に使う）', () => {
  const s = story({ id: 'old', firstSeen: '2026-08-01', lastSeen: '2026-08-01', dates: ['2026-08-01'], articleIds: ['a1'], count: 1 });
  const a = article({ id: 'a1', date: '2026-08-01' });
  const result = selectMorningHighlights([s], [a], LAST);
  assert.deepEqual(result, []);
});

test('順位1: 当日の記事重要度が高いほど上位になる', () => {
  const low = story({ id: 'low', firstSeen: LAST, dates: [LAST], articleIds: ['a-low'], count: 1 });
  const high = story({ id: 'high', firstSeen: LAST, dates: [LAST], articleIds: ['a-high'], count: 1 });
  const articles = [
    article({ id: 'a-low', date: LAST, score: 2 }),
    article({ id: 'a-high', date: LAST, score: 5 }),
  ];
  const result = selectMorningHighlights([low, high], articles, LAST);
  assert.deepEqual(result.map((h) => h.id), ['high', 'low']);
});

test('順位2: 重要度が同点なら複数ソースの話題が上位になる', () => {
  const single = story({ id: 'single', firstSeen: LAST, dates: [LAST], articleIds: ['a1'], count: 1 });
  const multi = story({ id: 'multi', firstSeen: LAST, dates: [LAST], articleIds: ['a2', 'a3'], count: 2 });
  const articles = [
    article({ id: 'a1', date: LAST, score: 3, sourceName: 'Source A' }),
    article({ id: 'a2', date: LAST, score: 3, sourceName: 'Source A' }),
    article({ id: 'a3', date: LAST, score: 3, sourceName: 'Source B' }),
  ];
  const result = selectMorningHighlights([single, multi], articles, LAST);
  assert.deepEqual(result.map((h) => h.id), ['multi', 'single']);
});

test('順位3: 重要度・複数ソースが同点なら再始動間隔が長い話題が上位になる', () => {
  const recentGap = story({
    id: 'recent-gap', firstSeen: '2026-08-25', lastSeen: LAST,
    dates: ['2026-08-25', LAST], articleIds: ['a1'], count: 2,
  });
  const longGap = story({
    id: 'long-gap', firstSeen: '2026-08-01', lastSeen: LAST,
    dates: ['2026-08-01', LAST], articleIds: ['a2'], count: 2,
  });
  const articles = [
    article({ id: 'a1', date: LAST, score: 3, sourceName: 'Source A' }),
    article({ id: 'a2', date: LAST, score: 3, sourceName: 'Source A' }),
  ];
  const result = selectMorningHighlights([recentGap, longGap], articles, LAST);
  assert.deepEqual(result.map((h) => h.id), ['long-gap', 'recent-gap']);
});

test('順位4: 重要度・複数ソース・再始動間隔が同点なら記事数が多い話題が上位になる', () => {
  const fewer = story({ id: 'fewer', firstSeen: LAST, dates: [LAST], articleIds: ['a1'], count: 2 });
  const more = story({ id: 'more', firstSeen: LAST, dates: [LAST], articleIds: ['a2'], count: 9 });
  const articles = [
    article({ id: 'a1', date: LAST, score: 3, sourceName: 'Source A' }),
    article({ id: 'a2', date: LAST, score: 3, sourceName: 'Source A' }),
  ];
  const result = selectMorningHighlights([fewer, more], articles, LAST);
  assert.deepEqual(result.map((h) => h.id), ['more', 'fewer']);
});

test('順位が完全に同点なら id 昇順で決定的に並ぶ', () => {
  const b = story({ id: 'b-story', firstSeen: LAST, dates: [LAST], articleIds: ['a1'], count: 1 });
  const a = story({ id: 'a-story', firstSeen: LAST, dates: [LAST], articleIds: ['a2'], count: 1 });
  const articles = [
    article({ id: 'a1', date: LAST, score: 3, sourceName: 'Source A' }),
    article({ id: 'a2', date: LAST, score: 3, sourceName: 'Source A' }),
  ];
  const result = selectMorningHighlights([b, a], articles, LAST);
  assert.deepEqual(result.map((h) => h.id), ['a-story', 'b-story']);
});

test('候補が4件以上あっても上位3件だけ返る', () => {
  const stories = ['s1', 's2', 's3', 's4'].map((id, i) =>
    story({ id, firstSeen: LAST, dates: [LAST], articleIds: ['a' + i], count: 1 })
  );
  const articles = ['a0', 'a1', 'a2', 'a3'].map((id, i) => article({ id, date: LAST, score: i + 1 }));
  const result = selectMorningHighlights(stories, articles, LAST);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map((h) => h.id), ['s4', 's3', 's2']);
});

test('1件目の要約は当日追加分のうち最も重要度が高い記事のもの', () => {
  const s = story({ id: 's1', firstSeen: LAST, dates: [LAST], articleIds: ['a1', 'a2'], count: 2 });
  const articles = [
    article({ id: 'a1', date: LAST, score: 2, summary: '重要度が低い記事の要約。' }),
    article({ id: 'a2', date: LAST, score: 5, summary: '重要度が高い記事の要約。' }),
  ];
  const result = selectMorningHighlights([s], articles, LAST);
  assert.equal(result[0].summary, '重要度が高い記事の要約。');
});
