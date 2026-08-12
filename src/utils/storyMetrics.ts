import { type Story, type StoryLedger, DORMANT_AFTER_DAYS } from './storyLedger.js';

/**
 * ストーリーの型判定。
 *
 * しきい値は 2026-08-12 のバックフィル実データ（60日 / 141本 / 記事282件）の分布から決めた。
 * 当初は yt-research-radar に倣って「1日への偏り（maxDayShare）」で spike を切っていたが、
 * **実データでは maxDayShare が 0.6 を一度も超えない**（最大でも 0.4〜0.6 帯）。
 * 収集が1日1回・URL重複除去つきなので、1つの話題に同日複数の記事が付くことがほとんど無い。
 * つまり spike は構造的に到達不能な判定だった。smoldering も steady より後段だったため0本。
 *
 * そこで軸を「1日への偏り」から「継続日数と、記事が出た日数」に置き換えた。
 * さらに「長く続いている」は型に混ぜず {@link StoryStats.isLongRunning} として直交させる。
 * 1軸に詰め込むと、記事が多い長期スレッドと、細く長い話題のどちらかが必ず潰れるため。
 */
export type StoryKind = 'steady' | 'spike' | 'developing' | 'unknown';

/** 表示用の日本語ラベル。紙面・メールで使う */
export const KIND_LABEL: Record<StoryKind, string> = {
  steady: '継続中',
  developing: '発生中',
  spike: '一時的',
  unknown: '単発',
};

/** spike（一時的）と判定する継続日数の上限。実データでは6本(4.3%)が該当 */
export const SPIKE_MAX_SPAN = 3;
/** steady（継続中）と判定するのに必要な、記事が現れた日数。実データでは15本(10.6%)が該当 */
export const STEADY_MIN_DAYS = 3;
/**
 * 「長く続いている」と見なす継続日数。実データでは7本(5.0%)。
 * 型ではなくフラグにしてあるので、継続中かつ長期＝紙面の主役、が素直に取れる。
 */
export const LONG_RUNNING_SPAN = 14;

export interface StoryStats {
  kind: StoryKind;
  /** firstSeen から lastSeen までの日数（両端含む） */
  spanDays: number;
  /** 記事が現れた日数 */
  activeDays: number;
  articleCount: number;
  /** 記事数 ÷ 継続日数 */
  density: number;
  /** 最も記事が多い日が全体に占める比率。判定には使わないが、偏りの実測を残すために出す */
  maxDayShare: number;
  /** 継続日数が LONG_RUNNING_SPAN 以上。kind と直交する目印 */
  isLongRunning: boolean;
}

function dayDiff(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00+09:00`);
  const b = Date.parse(`${toIso}T00:00:00+09:00`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * asOfIso 時点までの情報だけでストーリーを評価する。
 * 「いつ steady に昇格したか」を後から求めるために時点指定できる形にしている。
 */
export function statsAsOf(story: Story, asOfIso: string): StoryStats | null {
  const counts = Object.entries(story.dailyCounts).filter(([d]) => d <= asOfIso);
  if (counts.length === 0) return null;

  const total = counts.reduce((s, [, n]) => s + n, 0);
  const dates = counts.map(([d]) => d).sort();
  const spanDays = dayDiff(dates[0], dates[dates.length - 1]) + 1;
  const activeDays = counts.length;
  const maxDay = Math.max(...counts.map(([, n]) => n));
  const maxDayShare = maxDay / total;
  const density = total / spanDays;

  // spike を steady より先に見るのは、3日で終わった話題を「継続中」と呼ばないため
  let kind: StoryKind;
  if (total < 2) {
    kind = 'unknown';
  } else if (spanDays <= SPIKE_MAX_SPAN) {
    kind = 'spike';
  } else if (activeDays >= STEADY_MIN_DAYS) {
    kind = 'steady';
  } else {
    kind = 'developing';
  }

  return {
    kind,
    spanDays,
    activeDays,
    articleCount: total,
    density,
    maxDayShare,
    isLongRunning: spanDays >= LONG_RUNNING_SPAN,
  };
}

export function stats(story: Story): StoryStats | null {
  return statsAsOf(story, story.lastSeen);
}

/** その日に起きた台帳の変化。メールを「変化の通知」にできるかの判断材料 */
export interface DailyChange {
  date: string;
  /** その日に生まれたストーリー数 */
  created: number;
  /** その日に steady へ昇格したストーリー数 */
  promoted: number;
  /** その日に dormant へ落ちたストーリー数 */
  wentDormant: number;
  /** その日に記事が付いた既存ストーリー数（新規を除く） */
  touched: number;
}

/** 日付範囲について、日ごとの台帳の変化を求める */
export function dailyChanges(ledger: StoryLedger, dates: string[]): DailyChange[] {
  return dates.map((date) => {
    let created = 0;
    let promoted = 0;
    let wentDormant = 0;
    let touched = 0;

    for (const s of ledger.stories) {
      if (s.mergedInto) continue;
      const hitToday = (s.dailyCounts[date] ?? 0) > 0;

      if (s.firstSeen === date) {
        created++;
      } else if (hitToday) {
        touched++;
      }

      if (hitToday && s.firstSeen !== date) {
        const before = statsAsOf(s, prevDay(date));
        const after = statsAsOf(s, date);
        if (after?.kind === 'steady' && before?.kind !== 'steady') promoted++;
      }

      if (dayDiff(s.lastSeen, date) === DORMANT_AFTER_DAYS + 1) wentDormant++;
    }

    return { date, created, promoted, wentDormant, touched };
  });
}

/**
 * 受け皿化（catch-all）の検出。
 *
 * 1本のストーリーがそのトピックの記事の CATCH_ALL_SHARE を超えて抱えていたら、
 * 「継続する話題」ではなく無関係な記事の受け皿になっている疑いが強い。
 * 2026-08-11 の1回目のバックフィルでは game 51% / finance 65% がこれに該当し、
 * 目視で無関係な記事の混入を確認した（jp_politics 21% / ai 22% は健全だった）。
 *
 * しきい値を「トピック内の比率」に置いているのは、記事数の絶対値だと
 * 供給量の多いトピックが常に引っかかるため。
 */
export const CATCH_ALL_SHARE = 0.3;
/** 母数が小さいうちは比率が暴れる（記事2件目で50%）ので、この件数に満たないトピックは見ない */
export const CATCH_ALL_MIN_TOPIC_ARTICLES = 20;
/** 単発ストーリーが比率だけで引っかかるのを防ぐ */
export const CATCH_ALL_MIN_ARTICLES = 5;

export interface CatchAllWarning {
  topic: string;
  storyId: string;
  title: string;
  articleCount: number;
  /** そのトピックの総記事数 */
  topicTotal: number;
  share: number;
}

export function catchAllWarnings(
  ledger: StoryLedger,
  threshold: number = CATCH_ALL_SHARE
): CatchAllWarning[] {
  const totals = new Map<string, number>();
  for (const s of ledger.stories) {
    if (s.mergedInto) continue;
    totals.set(s.topic, (totals.get(s.topic) ?? 0) + s.articleIds.length);
  }

  return ledger.stories
    .filter((s) => !s.mergedInto)
    .map((s) => {
      const topicTotal = totals.get(s.topic) ?? 0;
      return {
        topic: s.topic,
        storyId: s.id,
        title: s.title,
        articleCount: s.articleIds.length,
        topicTotal,
        share: topicTotal === 0 ? 0 : s.articleIds.length / topicTotal,
      };
    })
    .filter(
      (w) =>
        w.share > threshold &&
        w.articleCount >= CATCH_ALL_MIN_ARTICLES &&
        w.topicTotal >= CATCH_ALL_MIN_TOPIC_ARTICLES
    )
    .sort((a, b) => b.share - a.share);
}

function prevDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00+09:00`);
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
