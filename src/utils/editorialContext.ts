import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { WebItem } from '../agents/webAgent.js';

export interface EditorialContext {
  date: string;
  edition: 'morning' | 'evening';
  picks: Array<{
    title: string;
    comment: string;
  }>;
  topTopics: string[];
  itemCount: number;
}

const S3_CONTEXT_KEY: Record<'morning' | 'evening', string> = {
  morning: 'context/morning.json',
  evening: 'context/evening.json',
};

export async function saveEditorialContext(
  s3: S3Client,
  bucket: string,
  ctx: EditorialContext
): Promise<void> {
  const key = S3_CONTEXT_KEY[ctx.edition];
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
      date: ctx.date,
      picksCount: ctx.picks.length,
    })
  );
}

export async function loadEditorialContext(
  s3: S3Client,
  bucket: string,
  edition: 'morning' | 'evening'
): Promise<EditorialContext | null> {
  const key = S3_CONTEXT_KEY[edition];
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    if (!body) return null;
    const ctx = JSON.parse(body) as EditorialContext;
    console.log(
      JSON.stringify({
        type: 'EDITORIAL_CONTEXT_LOADED',
        edition,
        date: ctx.date,
        picksCount: ctx.picks.length,
      })
    );
    return ctx;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === 'NoSuchKey' || code === 'NotFound') {
      console.log(JSON.stringify({ type: 'EDITORIAL_CONTEXT_NOT_FOUND', edition }));
      return null;
    }
    console.warn(
      JSON.stringify({
        type: 'EDITORIAL_CONTEXT_LOAD_ERROR',
        edition,
        error: (err as Error).message,
      })
    );
    return null;
  }
}

export function buildEditorialContext(
  edition: 'morning' | 'evening',
  date: string,
  picks: Array<{ title: string; comment: string }>,
  byTopic: Record<string, WebItem[]>
): EditorialContext {
  const topTopics = Object.entries(byTopic)
    .sort(([, a], [, b]) => b.length - a.length)
    .slice(0, 3)
    .map(([topic]) => topic);

  return {
    date,
    edition,
    picks,
    topTopics,
    itemCount: Object.values(byTopic).flat().length,
  };
}
