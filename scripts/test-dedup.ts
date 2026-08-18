/**
 * 同一実行内の記事URL重複除去を検査する。
 *
 *   npm run test:dedup
 */
import { dedupeByNormalizedUrl } from '../src/utils/articleDedupe.js';

interface Item {
  url: string;
  title: string;
  score: number;
  topic: string;
}

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) return;
  console.error(`✗ ${label}${detail ? `: ${detail}` : ''}`);
  failed++;
}

const sameRun: Item[] = [
  {
    url: 'https://www.anthropic.com/news/claude-text-watermark',
    title: 'Claudeの透かし技術',
    score: 4,
    topic: 'ai',
  },
  {
    url: 'https://www.anthropic.com/news/claude-text-watermark',
    title: 'Claudeの透かし技術',
    score: 4,
    topic: 'ai',
  },
];
const exact = dedupeByNormalizedUrl(sameRun);
check('同一URLを1件に畳む', exact.length === 1, String(exact.length));

const normalized = dedupeByNormalizedUrl<Item>([
  {
    url: 'https://example.com/article/?utm_source=rss#section',
    title: '先頭',
    score: 4,
    topic: 'ai',
  },
  {
    url: 'https://example.com/article',
    title: '後続',
    score: 4,
    topic: 'ai',
  },
]);
check('追跡パラメータ・フラグメント・末尾スラッシュを無視する', normalized.length === 1);
check('同点なら先頭を残す', normalized[0]?.title === '先頭', normalized[0]?.title);

const scored = dedupeByNormalizedUrl<Item>(
  [
    { url: 'https://example.com/news', title: '低スコア', score: 3, topic: 'ai' },
    {
      url: 'https://example.com/news?gclid=tracking',
      title: '高スコア',
      score: 5,
      topic: 'finance',
    },
  ],
  (candidate, current) => candidate.score > current.score
);
check('重複時は高スコアを残す', scored[0]?.title === '高スコア', scored[0]?.title);
check('高スコア側のトピックを保つ', scored[0]?.topic === 'finance', scored[0]?.topic);

const distinct = dedupeByNormalizedUrl<Item>([
  { url: 'https://example.com/a', title: 'A', score: 4, topic: 'ai' },
  { url: 'https://example.com/b', title: 'B', score: 4, topic: 'ai' },
]);
check('異なるURLはそのまま残す', distinct.length === 2, String(distinct.length));

if (failed > 0) {
  console.error(`\n${failed}件 失敗`);
  process.exit(1);
}
console.log('✓ 同一実行内のURL重複除去はすべて期待どおり');
