import { type Story, type StoryLedger, DORMANT_AFTER_DAYS } from './storyLedger.js';

/**
 * ストーリーの型判定。yt-research-radar の steady/spike/flat/unknown に倣い、
 * 「1本（1日）に偏っていないか」を必ず見る。
 *
 * しきい値は暫定。バックフィルの実データで分布を確認してから確定する
 * （先に決め打ちすると、データに合っていない判定が固定される）。
 */
export type StoryKind = 'steady' | 'spike' | 'smoldering' | 'developing' | 'unknown';

/** 1日に記事が集中している比率。これ以上なら spike */
export const SPIKE_SHARE = 0.6;
/** steady と判定するのに必要な、記事が現れた日数 */
export const STEADY_MIN_DAYS = 3;
/** smoldering と判定する継続日数の下限 */
export const SMOLDERING_MIN_SPAN = 14;
/** smoldering と判定する密度（記事数 ÷ 継続日数）の上限 */
export const SMOLDERING_MAX_DENSITY = 0.3;

export interface StoryStats {
  kind: StoryKind;
  /** firstSeen から lastSeen までの日数（両端含む） */
  spanDays: number;
  /** 記事が現れた日数 */
  activeDays: number;
  articleCount: number;
  /** 記事数 ÷ 継続日数 */
  density: number;
  /** 最も記事が多い日が全体に占める比率 */
  maxDayShare: number;
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

  let kind: StoryKind;
  if (total < 2) {
    kind = 'unknown';
  } else if (maxDayShare >= SPIKE_SHARE) {
    kind = 'spike';
  } else if (activeDays >= STEADY_MIN_DAYS) {
    kind = 'steady';
  } else if (spanDays > SMOLDERING_MIN_SPAN && density < SMOLDERING_MAX_DENSITY) {
    kind = 'smoldering';
  } else {
    kind = 'developing';
  }

  return { kind, spanDays, activeDays, articleCount: total, density, maxDayShare };
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

function prevDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00+09:00`);
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}
