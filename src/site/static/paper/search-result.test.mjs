/**
 * 検索の話題グルーピング・フィルタリング（buildSearchResult）と
 * 一致箇所ハイライト（highlightMatch）だけを検査する。
 * index.html は DOM 前提の IIFE を含むため丸ごとは評価せず、IIFE 開始行の手前
 * （純粋関数の定義部分）だけをソースから切り出して評価する。
 *
 *   node --test src/site/static/paper/search-result.test.mjs
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf-8');
const scriptBody = html.split('<script>\n')[1].split('\n(function () {')[0];

const { buildSearchResult, highlightMatch } = new Function(
  `${scriptBody}; return { buildSearchResult: buildSearchResult, highlightMatch: highlightMatch };`
)();

function story(overrides) {
  return Object.assign(
    { id: 's1', title: '話題', topic: 'ai', firstSeen: '2026-08-01', lastSeen: '2026-08-30', dates: [], articleIds: [], count: 1, live: true },
    overrides
  );
}
function article(overrides) {
  return Object.assign(
    { id: 'a1', title: '記事タイトル', summary: '要約文', url: 'https://example.com/a1', topic: 'ai', score: 3, date: '2026-08-30' },
    overrides
  );
}

test('検索語が空なら0件・0話題を返す', () => {
  const r = buildSearchResult([], [], '', {});
  assert.deepEqual(r, { query: '', totalArticles: 0, totalGroups: 0, groups: [], solos: [] });
});

test('タイトルまたは要約に部分一致した記事だけがヒットする（大文字小文字を区別しない）', () => {
  const articles = [
    article({ id: 'a1', title: 'OpenAIが新モデル発表' }),
    article({ id: 'a2', title: '無関係な記事', summary: 'openai の話題も含む要約' }),
    article({ id: 'a3', title: '完全に無関係' }),
  ];
  const r = buildSearchResult(articles, [], 'OpenAI', {});
  assert.equal(r.totalArticles, 2);
});

test('同じ話題に属する記事は1グループへまとまり、重複表示されない', () => {
  const s = story({ id: 's1', title: 'AI規制の議論', articleIds: ['a1', 'a2'], live: true });
  const articles = [
    article({ id: 'a1', title: 'AI規制の草案', date: '2026-08-10' }),
    article({ id: 'a2', title: 'AI規制の続報', date: '2026-08-20' }),
  ];
  const r = buildSearchResult(articles, [s], 'AI規制', {});
  assert.equal(r.totalGroups, 1);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].hitCount, 2);
  assert.equal(r.groups[0].firstHitDate, '2026-08-10');
  assert.equal(r.groups[0].lastHitDate, '2026-08-20');
});

test('話題（story）に属さない記事は単発記事として残る', () => {
  const articles = [article({ id: 'a1', title: '単発ニュース' })];
  const r = buildSearchResult(articles, [], '単発', {});
  assert.equal(r.totalGroups, 0);
  assert.equal(r.solos.length, 1);
  assert.equal(r.solos[0].id, 'a1');
});

test('分野フィルターでグループ・単発記事の両方が絞り込まれる', () => {
  const s = story({ id: 's1', topic: 'ai', articleIds: ['a1'] });
  const articles = [
    article({ id: 'a1', title: 'AI検索対象', topic: 'ai' }),
    article({ id: 'a2', title: 'OSS検索対象', topic: 'ai_oss' }),
  ];
  const r = buildSearchResult(articles, [s], '検索対象', { topic: 'ai_oss' });
  assert.equal(r.totalArticles, 2); // フィルター前の総数は変わらない
  assert.equal(r.groups.length, 0); // ai は絞り込まれて消える
  assert.equal(r.solos.length, 1);
  assert.equal(r.solos[0].id, 'a2');
});

test('期間フィルターでlastDateから指定日数より古いヒットは除外される', () => {
  const articles = [
    article({ id: 'a1', title: '古い記事の検索対象', date: '2026-08-01' }),
    article({ id: 'a2', title: '新しい記事の検索対象', date: '2026-08-29' }),
  ];
  const r = buildSearchResult(articles, [], '検索対象', { periodDays: 7, today: '2026-08-30' });
  assert.equal(r.solos.length, 1);
  assert.equal(r.solos[0].id, 'a2');
});

test('状態フィルター（継続中／停止）でグループが絞り込まれ、単発記事は除外される', () => {
  const liveStory = story({ id: 's-live', articleIds: ['a1'], live: true });
  const dormantStory = story({ id: 's-dormant', articleIds: ['a2'], live: false });
  const articles = [
    article({ id: 'a1', title: '継続話題の検索対象' }),
    article({ id: 'a2', title: '停止話題の検索対象' }),
    article({ id: 'a3', title: '単発の検索対象' }),
  ];
  const r = buildSearchResult(articles, [liveStory, dormantStory], '検索対象', { status: 'live' });
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].storyId, 's-live');
  assert.equal(r.solos.length, 0); // 状態フィルター指定時、単発記事は除外される
});

test('分野・期間・状態フィルターを組み合わせられる', () => {
  const s = story({ id: 's1', topic: 'ai', articleIds: ['a1'], live: true, });
  const articles = [article({ id: 'a1', title: '複合フィルタ対象', topic: 'ai', date: '2026-08-30' })];
  const r = buildSearchResult(articles, [s], '複合フィルタ', { topic: 'ai', periodDays: 7, status: 'live', today: '2026-08-30' });
  assert.equal(r.groups.length, 1);
});

test('0件ヒットでも破綻しない', () => {
  const r = buildSearchResult([article({ title: '無関係' })], [], '一致しない語', {});
  assert.equal(r.totalArticles, 0);
  assert.deepEqual(r.groups, []);
  assert.deepEqual(r.solos, []);
});

test('大量結果（1年分相当）でも同期的に完了し、件数が正しい', () => {
  const articles = [];
  for (let i = 0; i < 2000; i++) {
    articles.push(article({ id: 'a' + i, title: '大量データの検索語その' + i, date: '2026-01-01' }));
  }
  const start = Date.now();
  const r = buildSearchResult(articles, [], '検索語', {});
  const elapsed = Date.now() - start;
  assert.equal(r.totalArticles, 2000);
  assert.ok(elapsed < 500, `想定より遅い: ${elapsed}ms`);
});

test('highlightMatch: 一致箇所を <mark> で囲み、それ以外はエスケープされる', () => {
  const html = highlightMatch('OpenAIが<script>発表', 'OpenAI');
  assert.equal(html, '<mark>OpenAI</mark>が&lt;script&gt;発表');
});

test('highlightMatch: 一致しない場合はエスケープのみ行う', () => {
  const html = highlightMatch('<b>タグ</b>を含む文字列', 'OpenAI');
  assert.equal(html, '&lt;b&gt;タグ&lt;/b&gt;を含む文字列');
});

test('highlightMatch: 検索語自体にHTML特殊文字が含まれても安全にエスケープされる', () => {
  const html = highlightMatch('価格<100円>の話題', '<100円>');
  assert.equal(html, '価格<mark>&lt;100円&gt;</mark>の話題');
});
