/**
 * 記事の同一性情報の置き場（#1 #2）。
 *
 * ```
 * archive/<date>-<edition>.json    生データ。**書き換えない**（評価ハーネスの原料）
 * enriched/<date>-<edition>.json   派生。id / publishedAt / 発行元
 * ```
 *
 * 新規収集ぶんは collect が、過去ぶんは `scripts/backfill-identity.ts` が同じ場所に書く。
 * 置き場を分けたのは archive を不変に保つためで、読む側（publish）は経路が1本になる。
 *
 * 「派生」と言っても RSS から素通しで取った値なので、あとから作り直せるとは限らない
 * （RSSは流れていく）。archive ほどではないが、消したら戻らない部分がある。
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { ArticleIdentity } from './articleIdentity.js';

export const ENRICHED_PREFIX = 'enriched/';

export interface EnrichedRun {
  isoDate: string;
  edition: 'morning' | 'evening';
  generatedAt: string;
  articles: ArticleIdentity[];
}

export function enrichedKey(isoDate: string, edition: 'morning' | 'evening'): string {
  return `${ENRICHED_PREFIX}${isoDate}-${edition}.json`;
}

export async function saveEnrichedRun(
  s3: S3Client,
  bucket: string,
  run: EnrichedRun
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: enrichedKey(run.isoDate, run.edition),
      Body: JSON.stringify(run),
      ContentType: 'application/json',
    })
  );
  const bySource = run.articles.reduce<Record<string, number>>((acc, a) => {
    acc[a.sourceFrom] = (acc[a.sourceFrom] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    JSON.stringify({
      type: 'ENRICHED_SAVED',
      isoDate: run.isoDate,
      edition: run.edition,
      articles: run.articles.length,
      withSource: run.articles.filter((a) => a.sourceName).length,
      withPublishedAt: run.articles.filter((a) => a.publishedAt).length,
      bySource,
    })
  );
}

export async function loadEnrichedRun(
  s3: S3Client,
  bucket: string,
  isoDate: string,
  edition: 'morning' | 'evening'
): Promise<EnrichedRun | null> {
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: enrichedKey(isoDate, edition) })
    );
    const body = await res.Body?.transformToString();
    return body ? (JSON.parse(body) as EnrichedRun) : null;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    console.warn(`[enriched] failed to load ${isoDate}-${edition}: ${(err as Error).message}`);
    return null;
  }
}
