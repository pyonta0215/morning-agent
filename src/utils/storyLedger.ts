import { createHash } from 'node:crypto';
import { normalizeUrl } from './deliveredHistory.js';

/**
 * ストーリー台帳。継続する話題を追跡する単位で、このプロジェクト固有の資産にあたる。
 *
 * 記事は dedup により再登場しないため（実測: 59日/451ユニークURL中、複数日登場は4件）、
 * 記事を追跡対象にすると日次差分が常にゼロになる。ストーリーをその位置に置く。
 *
 * 台帳を壊さないためのルール:
 *   1. 一度振ったストーリーIDは変えない
 *   2. 過去の割当は再計算しない（割当は当日の記事に対してのみ行う）
 *   3. articleIds は追記のみ。記事がストーリーから外れることはない
 *   4. マージは許すが削除はしない（mergedInto を残して参照を切らない）
 *   5. LLMの判断が入るため archive から再生成できない。失うと復元できない
 */
export interface Story {
  /** `st-YYYYMMDD-NNNN`。発生日 + 連番。不変 */
  id: string;
  title: string;
  /** topics.yaml の topic id。トピックを跨ぐ割当は行わない */
  topic: string;
  firstSeen: string;
  lastSeen: string;
  /** 追記のみ */
  articleIds: string[];
  /** 日付 → その日に割り当たった記事数 */
  dailyCounts: Record<string, number>;
  /** マージ先。設定されている場合このストーリーは表示しない */
  mergedInto?: string;
}

export interface StoryLedger {
  version: 1;
  updatedAt: string;
  stories: Story[];
}

/** lastSeen からこの日数が経過したストーリーは dormant（活動終了）とみなす */
export const DORMANT_AFTER_DAYS = 7;

/** 割当プロンプトに載せる既存ストーリーの対象期間（日） */
export const ACTIVE_WINDOW_DAYS = 14;

export function emptyLedger(): StoryLedger {
  return { version: 1, updatedAt: new Date().toISOString(), stories: [] };
}

/** 記事の安定ID。正規化URLのSHA-256先頭16桁 */
export function articleId(url: string): string {
  return createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 16);
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00+09:00`);
  const b = Date.parse(`${toIso}T00:00:00+09:00`);
  return Math.round((b - a) / 86_400_000);
}

/** todayIso 時点で dormant か */
export function isDormant(story: Story, todayIso: string): boolean {
  return daysBetween(story.lastSeen, todayIso) > DORMANT_AFTER_DAYS;
}

/**
 * 割当プロンプトに載せる既存ストーリーを返す。
 * 直近 ACTIVE_WINDOW_DAYS 日以内に言及があり、マージされていないもののみ。
 */
export function activeStories(ledger: StoryLedger, todayIso: string, topic?: string): Story[] {
  return ledger.stories.filter(
    (s) =>
      !s.mergedInto &&
      daysBetween(s.lastSeen, todayIso) <= ACTIVE_WINDOW_DAYS &&
      (!topic || s.topic === topic)
  );
}

/** その日に採番済みの件数から次のストーリーIDを作る */
export function nextStoryId(ledger: StoryLedger, isoDate: string): string {
  const prefix = `st-${isoDate.replace(/-/g, '')}-`;
  const used = ledger.stories.filter((s) => s.id.startsWith(prefix)).length;
  return `${prefix}${String(used + 1).padStart(4, '0')}`;
}

/** 既存ストーリーに記事を追記する。ルール2・3を守り、過去の値は書き換えない */
export function appendToStory(story: Story, articleIdValue: string, isoDate: string): void {
  if (story.articleIds.includes(articleIdValue)) return;
  story.articleIds.push(articleIdValue);
  story.dailyCounts[isoDate] = (story.dailyCounts[isoDate] ?? 0) + 1;
  if (isoDate > story.lastSeen) story.lastSeen = isoDate;
}

export function createStory(
  ledger: StoryLedger,
  isoDate: string,
  title: string,
  topic: string,
  articleIdValue: string
): Story {
  const story: Story = {
    id: nextStoryId(ledger, isoDate),
    title,
    topic,
    firstSeen: isoDate,
    lastSeen: isoDate,
    articleIds: [articleIdValue],
    dailyCounts: { [isoDate]: 1 },
  };
  ledger.stories.push(story);
  return story;
}
