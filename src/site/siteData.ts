/**
 * 閲覧サイトに置くファイルを、アーカイブとストーリー台帳から**決定的に**組み立てる。
 *
 * ここでLLMは呼ばない。呼び出しは「収集の集約」と「ストーリー割当」の2本で打ち止めにする、
 * というのがこの企画の設計上の性質で、機能を足してもコストが増えないことを保ちたいため。
 *
 * ## 面ごとにファイルを分ける
 *
 * ```
 * overview.json    公開。集計値と活動の推移だけ。記事の要約もストーリー名も入れない
 * paper/data.json  非公開。記事の要約・ストーリーの中身・過去号
 * ```
 *
 * 認証（CloudFront Function）を唯一の防壁にしないための分離。
 * 公開ファイルに何が入っているかは {@link assertOverviewIsPublicSafe} が検査する。
 */
import type { RunArchive } from '../utils/runArchive.js';
import type { StoryLedger } from '../utils/storyLedger.js';
import { ACTIVE_WINDOW_DAYS } from '../utils/storyLedger.js';

/** サイトへ置く1ファイル */
export interface SiteFile {
  /** バケット内のキー。URLのパスと1対1で対応させる */
  key: string;
  body: string;
  contentType: string;
  /** 更新は1日1回なので、無効化ではなくこれで新しさを担保する */
  cacheControl: string;
}

/** 公開層のデータ。**ここに記事の見出し・要約・ストーリー名を入れてはいけない** */
export interface OverviewData {
  generatedAt: string;
  /** 観測を始めた日 */
  firstDate: string;
  /** 最後に更新した日 */
  lastDate: string;
  /** 観測した日数（実行があった日の数。欠測日は含まない） */
  days: number;
  /** 集めた記事の総数 */
  articles: number;
  /** 見つけた話題の総数 */
  stories: number;
  /** 直近 ACTIVE_WINDOW_DAYS 日に動きがあった話題の数 */
  activeStories: number;
  /** 日ごとの記事数。中身は出さずに活動の推移だけ見せる */
  daily: Array<{ date: string; count: number }>;
  /** 追っている分野。ラベルだけで、話題名は含まない */
  topics: Array<{ id: string; label: string }>;
}

const SHORT_CACHE = 'public, max-age=60';

function dayDiff(fromIso: string, toIso: string): number {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00+09:00`) - Date.parse(`${fromIso}T00:00:00+09:00`)) / 86_400_000
  );
}

function countArticles(archive: RunArchive): number {
  return Object.values(archive.byTopic).reduce((n, items) => n + items.length, 0);
}

export function buildOverview(
  archives: RunArchive[],
  ledger: StoryLedger,
  topics: Array<{ id: string; label: string }>,
  generatedAt: string
): OverviewData {
  const sorted = [...archives].sort((a, b) => (a.isoDate < b.isoDate ? -1 : 1));
  const lastDate = sorted[sorted.length - 1]?.isoDate ?? generatedAt.slice(0, 10);
  const live = ledger.stories.filter((s) => !s.mergedInto);

  return {
    generatedAt,
    firstDate: sorted[0]?.isoDate ?? lastDate,
    lastDate,
    days: sorted.length,
    articles: sorted.reduce((n, a) => n + countArticles(a), 0),
    stories: live.length,
    activeStories: live.filter((s) => dayDiff(s.lastSeen, lastDate) <= ACTIVE_WINDOW_DAYS).length,
    daily: sorted.map((a) => ({ date: a.isoDate, count: countArticles(a) })),
    topics,
  };
}

/**
 * 公開ファイルに非公開の中身が混ざっていないことを検査する。
 *
 * 認証の設定ミス1つで漏れる、という状態にしないための二重化。
 * ここで落ちたらデプロイではなくデータの作り方が間違っている。
 */
export function assertOverviewIsPublicSafe(overview: OverviewData, ledger: StoryLedger): void {
  const json = JSON.stringify(overview);

  for (const story of ledger.stories) {
    if (story.title.length >= 4 && json.includes(story.title)) {
      throw new Error(
        `[siteData] 公開データにストーリー名が含まれている: ${story.id} 「${story.title}」`
      );
    }
  }

  // 将来フィールドを足したときに、記事の中身が紛れ込んでも気づけるようにしておく。
  // 公開データはトピックのラベル以外に日本語の長い文字列を持たない
  const allowed = new Set(overview.topics.map((t) => t.label));
  for (const value of collectStrings(overview)) {
    if (allowed.has(value)) continue;
    if (value.length > 24) {
      throw new Error(`[siteData] 公開データに想定外の長い文字列がある: ${value.slice(0, 40)}…`);
    }
  }
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** サイトへ置くファイル一式 */
export function buildSiteFiles(
  archives: RunArchive[],
  ledger: StoryLedger,
  topics: Array<{ id: string; label: string }>,
  generatedAt: string
): SiteFile[] {
  const overview = buildOverview(archives, ledger, topics, generatedAt);
  assertOverviewIsPublicSafe(overview, ledger);

  return [
    {
      key: 'overview.json',
      body: JSON.stringify(overview),
      contentType: 'application/json; charset=utf-8',
      cacheControl: SHORT_CACHE,
    },
  ];
}
