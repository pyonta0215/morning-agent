/**
 * 話題詳細の3層組み立て（buildStoryNarrative）だけを検査する。
 * index.html は DOM 前提の IIFE を含むため丸ごとは評価せず、IIFE 開始行の手前
 * （純粋関数の定義部分）だけをソースから切り出して評価する。
 *
 *   node --test src/site/static/paper/story-narrative.test.mjs
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf-8');
const scriptBody = html.split('<script>\n')[1].split('\n(function () {')[0];

const { buildStoryNarrative } = new Function(
  `${scriptBody}; return { buildStoryNarrative: buildStoryNarrative };`
)();

function article(overrides) {
  return Object.assign(
    { id: 'a1', title: '記事', summary: '要約文。', url: 'https://example.com/a1', date: '2026-08-30', sourceName: 'Source A' },
    overrides
  );
}

test('記事0件なら null を返す', () => {
  assert.equal(buildStoryNarrative([], {}), null);
});

test('記事1件: storyline は「初出」のみで latest と同じ記事を指す', () => {
  const a1 = article({ id: 'a1', date: '2026-08-30' });
  const n = buildStoryNarrative(['a1'], { a1 });
  assert.equal(n.latest.id, 'a1');
  assert.equal(n.total, 1);
  assert.deepEqual(n.storyline.map((p) => p.label), ['初出']);
  assert.equal(n.storyline[0].article.id, 'a1');
});

test('記事2件: storyline は「初出」「今回」の2点（前回は初出と同じなので省略）', () => {
  const a1 = article({ id: 'a1', date: '2026-08-20' });
  const a2 = article({ id: 'a2', date: '2026-08-30' });
  const n = buildStoryNarrative(['a1', 'a2'], { a1, a2 });
  assert.equal(n.latest.id, 'a2');
  assert.deepEqual(n.storyline.map((p) => p.label), ['初出', '今回']);
  assert.equal(n.storyline[0].article.id, 'a1');
  assert.equal(n.storyline[1].article.id, 'a2');
});

test('記事3件以上: storyline は「初出」「前回」「今回」の3点', () => {
  const a1 = article({ id: 'a1', date: '2026-08-01' });
  const a2 = article({ id: 'a2', date: '2026-08-15' });
  const a3 = article({ id: 'a3', date: '2026-08-30' });
  const n = buildStoryNarrative(['a1', 'a2', 'a3'], { a1, a2, a3 });
  assert.deepEqual(n.storyline.map((p) => p.label), ['初出', '前回', '今回']);
  assert.deepEqual(n.storyline.map((p) => p.article.id), ['a1', 'a2', 'a3']);
  assert.equal(n.latest.id, 'a3');
});

test('記事は日付の登録順に依存せず、日付昇順に並べ替えてから組み立てる', () => {
  const a1 = article({ id: 'a1', date: '2026-08-30' });
  const a2 = article({ id: 'a2', date: '2026-08-01' });
  const a3 = article({ id: 'a3', date: '2026-08-15' });
  // articleIds の登録順はバラバラでも、日付順で最新が latest になる
  const n = buildStoryNarrative(['a1', 'a3', 'a2'], { a1, a2, a3 });
  assert.equal(n.latest.id, 'a1');
  assert.deepEqual(n.storyline.map((p) => p.article.id), ['a2', 'a3', 'a1']);
});

test('記事5件以下: 根拠記事はすべて可視、折りたたみは無い', () => {
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const byId = {};
  ids.forEach((id, i) => { byId[id] = article({ id, date: '2026-08-' + String(10 + i).padStart(2, '0') }); });
  const n = buildStoryNarrative(ids, byId);
  assert.equal(n.evidenceVisible.length, 5);
  assert.equal(n.evidenceCollapsed.length, 0);
});

test('記事6件以上: 根拠記事は初出＋直近4件が可視、中間は折りたたみへ回る', () => {
  const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
  const byId = {};
  ids.forEach((id, i) => { byId[id] = article({ id, date: '2026-08-' + String(1 + i).padStart(2, '0') }); });
  const n = buildStoryNarrative(ids, byId);
  assert.equal(n.total, 7);
  assert.deepEqual(n.evidenceVisible.map((a) => a.id), ['a1', 'a4', 'a5', 'a6', 'a7']);
  assert.deepEqual(n.evidenceCollapsed.map((a) => a.id), ['a2', 'a3']);
});

test('存在しない articleId は無視される（ART に無い記事はカウントに入らない）', () => {
  const a1 = article({ id: 'a1', date: '2026-08-30' });
  const n = buildStoryNarrative(['a1', 'missing'], { a1 });
  assert.equal(n.total, 1);
  assert.equal(n.latest.id, 'a1');
});
