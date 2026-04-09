import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { WebItem } from '../agents/webAgent.js';

export interface EditorialContext {
  /** 表示用日付 YYYY/MM/DD(曜) */
  date: string;
  /** S3キー用 ISO 日付 YYYY-MM-DD */
  isoDate: string;
  edition: 'morning' | 'evening';
  picks: Array<{
    title: string;
    comment: string;
  }>;
  topTopics: string[];
  itemCount: number;
}

/** JST の ISO 日付（YYYY-MM-DD）を返す */
export function getJSTIsoDate(date: Date): string {
  return date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** S3 オブジェクトキーを返す */
function getContextKey(edition: 'morning' | 'evening', isoDate: string): string {
  return `context/${isoDate}-${edition}.json`;
}

export async function saveEditorialContext(
  s3: S3Client,
  bucket: string,
  ctx: EditorialContext
): Promise<void> {
  const key = getContextKey(ctx.edition, ctx.isoDate);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(ctx),
      ContentType: 'application/json',
    })
  );
  console.log(
    JSON.stringify({
      type: 'EDITORIAL_CONTEXT_SAVED',
      edition: ctx.edition,
      isoDate: ctx.isoDate,
      picksCount: ctx.picks.length,
      s3Key: key,
    })
  );
}

export async function loadEditorialContext(
  s3: S3Client,
  bucket: string,
  edition: 'morning' | 'evening',
  isoDate: string
): Promise<EditorialContext | null> {
  const key = getContextKey(edition, isoDate);
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    if (!body) return null;
    const ctx = JSON.parse(body) as EditorialContext;
    console.log(
      JSON.stringify({
        type: 'EDITORIAL_CONTEXT_LOADED',
        edition,
        isoDate,
        picksCount: ctx.picks.length,
        s3Key: key,
      })
    );
    return ctx;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === 'NoSuchKey' || code === 'NotFound') {
      console.log(JSON.stringify({ type: 'EDITORIAL_CONTEXT_NOT_FOUND', edition, isoDate, s3Key: key }));
      return null;
    }
    console.warn(
      JSON.stringify({
        type: 'EDITORIAL_CONTEXT_LOAD_ERROR',
        edition,
        isoDate,
        error: (err as Error).message,
      })
    );
    return null;
  }
}

export function buildEditorialContext(
  edition: 'morning' | 'evening',
  date: string,
  isoDate: string,
  picks: Array<{ title: string; comment: string }>,
  byTopic: Record<string, WebItem[]>
): EditorialContext {
  const topTopics = Object.entries(byTopic)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 3)
    .map(([topic]) => topic);

  return {
    date,
    isoDate,
    edition,
    picks,
    topTopics,
    itemCount: Object.values(byTopic).flat().length,
  };
}
