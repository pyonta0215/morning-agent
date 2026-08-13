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
import { ACTIVE_WINDOW_DAYS, DORMANT_AFTER_DAYS, articleId } from '../utils/storyLedger.js';
import { stats, dailyChanges, KIND_LABEL, type StoryKind } from '../utils/storyMetrics.js';
import type { ArticleIdentity } from '../utils/articleIdentity.js';

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

// ── 紙面（非公開） ────────────────────────────────────────────────

export interface PaperArticle {
  id: string;
  title: string;
  summary: string;
  url: string;
  topic: string;
  score: number;
  /** 紙面に載った日 */
  date: string;
  /** 発行元の表示名（「PC Watch」など）。取れなかった記事には無い（#1） */
  sourceName?: string;
  /** 記事の公開日時（ISO） */
  publishedAt?: string;
  /** publishedAt が実測（rss）か、紙面掲載日での代用（delivered）か */
  publishedAtSource?: 'rss' | 'delivered';
}

export interface PaperStory {
  id: string;
  title: string;
  topic: string;
  firstSeen: string;
  lastSeen: string;
  /** 記事が出た日（昇順）。経過表の点になる */
  dates: string[];
  articleIds: string[];
  count: number;
  kind: StoryKind;
  kindLabel: string;
  spanDays: number;
  isLongRunning: boolean;
  /** 直近 DORMANT_AFTER_DAYS 日に動きがある。経過表の色分けに使う */
  live: boolean;
}

export interface PaperDay {
  date: string;
  edition: 'morning' | 'evening';
  articleIds: string[];
}

export interface PaperData {
  generatedAt: string;
  firstDate: string;
  lastDate: string;
  topics: Array<{ id: string; label: string }>;
  stories: PaperStory[];
  articles: PaperArticle[];
  days: PaperDay[];
  /** 日ごとの台帳の変化。メールの「動いた話題」と同じ材料 */
  changes: Array<{
    date: string;
    created: number;
    promoted: number;
    wentDormant: number;
    touched: number;
  }>;
}

/**
 * 紙面のデータ。DBは持たず、これ1本を配ってブラウザ側で検索・絞り込みする。
 *
 * **実測（60日・記事455件・話題140本）: 321KB / gzip 118KB。** 1年で 2MB / gzip 700KB 程度。
 * 単独で見るぶんには問題ないが、当初見積り（年700KB）の3倍だったので書き残しておく。
 * 重いのは記事の要約で、増え続けるのもここ。効いてくるようなら
 * 「直近90日ぶんだけ要約を持ち、それ以前は見出しだけ」に落とすのが最初の一手。
 *
 * DBを持たないのは記事が再登場しない（dedupが効く）ため。
 * yt-research-radar が D1 を使うのは日次スナップショット×チャンネル数で行が増えるからで、
 * こちらは増え方が2桁遅い。
 */
export function buildPaperData(
  archives: RunArchive[],
  ledger: StoryLedger,
  topics: Array<{ id: string; label: string }>,
  generatedAt: string,
  /** 記事IDをキーにした同一性情報（#1 #2）。無い記事は発行元・公開日時が空になるだけ */
  identities: Map<string, ArticleIdentity> = new Map()
): PaperData {
  const sorted = [...archives].sort((a, b) => (a.isoDate < b.isoDate ? -1 : 1));
  const lastDate = sorted[sorted.length - 1]?.isoDate ?? generatedAt.slice(0, 10);

  // 同じURLが複数日に出ることは稀にある（実測 451件中4件）。最初に出た日を採る
  const articles = new Map<string, PaperArticle>();
  const days: PaperDay[] = [];
  for (const a of sorted) {
    const ids: string[] = [];
    for (const [topic, items] of Object.entries(a.byTopic)) {
      for (const item of items) {
        const id = articleId(item.url);
        ids.push(id);
        if (!articles.has(id)) {
          const ident = identities.get(id);
          articles.set(id, {
            id,
            title: item.title,
            summary: item.summary,
            url: item.url,
            topic,
            score: item.score,
            date: a.isoDate,
            sourceName: ident?.sourceName,
            publishedAt: ident?.publishedAt,
            publishedAtSource: ident?.publishedAtSource,
          });
        }
      }
    }
    days.push({ date: a.isoDate, edition: a.edition, articleIds: ids });
  }

  const stories: PaperStory[] = ledger.stories
    .filter((s) => !s.mergedInto)
    .map((s) => {
      const st = stats(s);
      return {
        id: s.id,
        title: s.title,
        topic: s.topic,
        firstSeen: s.firstSeen,
        lastSeen: s.lastSeen,
        dates: Object.keys(s.dailyCounts).sort(),
        articleIds: s.articleIds,
        count: s.articleIds.length,
        kind: st?.kind ?? 'unknown',
        kindLabel: KIND_LABEL[st?.kind ?? 'unknown'],
        spanDays: st?.spanDays ?? 1,
        isLongRunning: st?.isLongRunning ?? false,
        live: dayDiff(s.lastSeen, lastDate) <= DORMANT_AFTER_DAYS,
      };
    })
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : b.count - a.count));

  return {
    generatedAt,
    firstDate: sorted[0]?.isoDate ?? lastDate,
    lastDate,
    topics,
    stories,
    articles: [...articles.values()],
    days,
    changes: dailyChanges(ledger, sorted.map((a) => a.isoDate)),
  };
}

/** サイトへ置くファイル一式 */
export function buildSiteFiles(
  archives: RunArchive[],
  ledger: StoryLedger,
  topics: Array<{ id: string; label: string }>,
  generatedAt: string,
  identities: Map<string, ArticleIdentity> = new Map()
): SiteFile[] {
  const overview = buildOverview(archives, ledger, topics, generatedAt);
  assertOverviewIsPublicSafe(overview, ledger);
  const paper = buildPaperData(archives, ledger, topics, generatedAt, identities);

  return [
    {
      key: 'overview.json',
      body: JSON.stringify(overview),
      contentType: 'application/json; charset=utf-8',
      cacheControl: SHORT_CACHE,
    },
    {
      // 認証の内側。CloudFront Function の PUBLIC_PATHS に入れないこと
      key: 'paper/data.json',
      body: JSON.stringify(paper),
      contentType: 'application/json; charset=utf-8',
      cacheControl: SHORT_CACHE,
    },
  ];
}
