/**
 * 公開データに非公開の中身が混ざらないことを検査する。
 *
 * 認証（CloudFront Function）と並ぶもう一方の防壁なので、こちらもテストを持つ。
 * 認証の設定を1つ間違えただけで漏れる、という状態にしないための二重化。
 *
 *   npm run test:site-data
 */
import {
  buildOverview,
  buildSiteFiles,
  assertOverviewIsPublicSafe,
  type OverviewData,
} from '../src/site/siteData.js';
import type { StoryLedger } from '../src/utils/storyLedger.js';
import type { RunArchive } from '../src/utils/runArchive.js';

const TOPICS = [
  { id: 'ai', label: 'AI・LLM' },
  { id: 'jp_politics', label: '政治・行政' },
];

const ledger: StoryLedger = {
  version: 1,
  updatedAt: '2026-08-10T21:30:00.000Z',
  stories: [
    {
      id: 'st-20260612-0001',
      title: '皇位継承をめぐる法整備検討：男系男子養子案の論点整理',
      topic: 'jp_politics',
      firstSeen: '2026-06-12',
      lastSeen: '2026-08-10',
      articleIds: ['a1', 'a2'],
      dailyCounts: { '2026-06-12': 1, '2026-08-10': 1 },
    },
    {
      id: 'st-20260612-0002',
      title: 'Anthropicが長時間自律型AIエージェントをリリース',
      topic: 'ai',
      firstSeen: '2026-06-12',
      lastSeen: '2026-06-20',
      articleIds: ['a3'],
      dailyCounts: { '2026-06-12': 1 },
    },
  ],
};

const archives: RunArchive[] = [
  {
    isoDate: '2026-06-12',
    edition: 'morning',
    topics: [],
    sources: [],
    byTopic: {
      ai: [
        {
          url: 'https://example.com/1',
          title: 'アンソロピックの新モデルは「長時間働くAI」',
          summary: '企業向けエージェントの次段階を示した。',
          score: 5,
          topic: 'ai',
        },
      ],
      jp_politics: [
        {
          url: 'https://example.com/2',
          title: '皇位継承 男系男子の養子案 論点整理へ',
          summary: '政府が論点を整理する方針を固めた。',
          score: 4,
          topic: 'jp_politics',
        },
      ],
    },
    picks: [{ title: 'アンソロピックの新モデル', comment: '注目。' }],
    usage: [],
  },
  {
    isoDate: '2026-08-10',
    edition: 'morning',
    topics: [],
    sources: [],
    byTopic: {
      jp_politics: [
        {
          url: 'https://example.com/3',
          title: '高市総理が長崎原爆犠牲者慰霊平和祈念式典で挨拶',
          summary: '式典で挨拶を行った。',
          score: 3,
          topic: 'jp_politics',
        },
      ],
    },
    picks: [],
    usage: [],
  },
];

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) return;
  console.error(`✗ ${label}${detail ? `: ${detail}` : ''}`);
  failed++;
}

// ── 集計値が正しいこと
const overview = buildOverview(archives, ledger, TOPICS, '2026-08-10T21:25:00.000Z');
check('観測日数', overview.days === 2, String(overview.days));
check('記事総数', overview.articles === 3, String(overview.articles));
check('話題の総数', overview.stories === 2, String(overview.stories));
// 2026-08-10 時点で lastSeen が14日以内なのは皇位継承の1本だけ（AIの方は 06-20 で51日前）
check('継続中の本数', overview.activeStories === 1, String(overview.activeStories));
check('初日', overview.firstDate === '2026-06-12', overview.firstDate);
check('最終日', overview.lastDate === '2026-08-10', overview.lastDate);
check('日次の件数', JSON.stringify(overview.daily) === JSON.stringify([
  { date: '2026-06-12', count: 2 },
  { date: '2026-08-10', count: 1 },
]), JSON.stringify(overview.daily));

// ── 公開データに中身が入っていないこと
const json = JSON.stringify(overview);
for (const s of ledger.stories) {
  check(`ストーリー名が出ていない (${s.id})`, !json.includes(s.title));
}
for (const a of archives) {
  for (const item of Object.values(a.byTopic).flat()) {
    check('記事の見出しが出ていない', !json.includes(item.title), item.title);
    check('記事の要約が出ていない', !json.includes(item.summary), item.summary);
  }
}

// ── assert が実際に落ちること（落ちない assert は無いのと同じ）
function expectThrow(label: string, mutate: (o: OverviewData) => void): void {
  const o = buildOverview(archives, ledger, TOPICS, '2026-08-10T21:25:00.000Z');
  mutate(o);
  try {
    assertOverviewIsPublicSafe(o, ledger);
    console.error(`✗ ${label}: 通ってしまった`);
    failed++;
  } catch {
    /* 期待どおり */
  }
}
expectThrow('ストーリー名を混ぜたら落ちる', (o) => {
  (o as unknown as Record<string, unknown>).leaked = ledger.stories[0].title;
});
expectThrow('長い日本語を混ぜたら落ちる', (o) => {
  (o as unknown as Record<string, unknown>).leaked =
    '高市総理が長崎原爆犠牲者慰霊平和祈念式典で挨拶を行いました';
});
expectThrow('配列の奥に混ぜても落ちる', (o) => {
  (o as unknown as Record<string, unknown>).nested = [{ deep: [ledger.stories[1].title] }];
});

// ── 正常系ではファイルが組み上がること
const files = buildSiteFiles(archives, ledger, TOPICS, '2026-08-10T21:25:00.000Z');
check('公開ファイルが1つ', files.length === 1, String(files.length));
check('キーが overview.json', files[0]?.key === 'overview.json', files[0]?.key);
check('Cache-Control が付いている', /max-age=\d+/.test(files[0]?.cacheControl ?? ''));

if (failed > 0) {
  console.error(`\n${failed}件 失敗`);
  process.exit(1);
}
console.log('✓ 公開データの集計値・非公開の中身の非混入・assertの発火 すべて期待どおり');
