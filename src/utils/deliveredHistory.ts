import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

/** 紙面に掲載済みの記事1件分の履歴 */
export interface DeliveredItem {
  url: string;
  title: string;
  topic: string;
  /** 配信日 YYYY-MM-DD (JST) */
  isoDate: string;
}

const HISTORY_KEY = 'context/delivered-history.json';

/** 履歴の保持日数。これより古いエントリは保存時に削除される */
export const HISTORY_RETENTION_DAYS = 14;

/** 重複判定用にURLを正規化する（フラグメント・トラッキングパラメータ・末尾スラッシュを除去） */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const keys = [...u.searchParams.keys()];
    for (const k of keys) {
      if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString().replace(/\/$/, '');
  } catch {
    return raw.trim();
  }
}

export async function loadDeliveredHistory(s3: S3Client, bucket: string): Promise<DeliveredItem[]> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: HISTORY_KEY }));
    const body = await res.Body?.transformToString();
    if (!body) return [];
    const parsed = JSON.parse(body) as { entries?: DeliveredItem[] };
    const entries = parsed.entries ?? [];
    console.log(JSON.stringify({ type: 'DELIVERED_HISTORY_LOADED', count: entries.length }));
    return entries;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code !== 'NoSuchKey' && code !== 'NotFound') {
      console.warn(
        JSON.stringify({ type: 'DELIVERED_HISTORY_LOAD_ERROR', error: (err as Error).message })
      );
    }
    return [];
  }
}

export async function saveDeliveredHistory(
  s3: S3Client,
  bucket: string,
  entries: DeliveredItem[]
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: HISTORY_KEY,
      Body: JSON.stringify({ entries }),
      ContentType: 'application/json',
    })
  );
  console.log(JSON.stringify({ type: 'DELIVERED_HISTORY_SAVED', count: entries.length }));
}

/**
 * 既存履歴に本日掲載分をマージし、保持期間外のエントリを削除して返す。
 * 同一URL（正規化後）は初出の配信日を維持する。
 */
export function updateDeliveredHistory(
  history: DeliveredItem[],
  newItems: DeliveredItem[],
  todayIso: string,
  retentionDays = HISTORY_RETENTION_DAYS
): DeliveredItem[] {
  const cutoff = new Date(`${todayIso}T00:00:00+09:00`);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffIso = cutoff.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  const merged = new Map<string, DeliveredItem>();
  for (const item of [...history, ...newItems]) {
    if (item.isoDate < cutoffIso) continue;
    const key = normalizeUrl(item.url);
    const existing = merged.get(key);
    if (!existing || item.isoDate < existing.isoDate) {
      merged.set(key, item);
    }
  }
  return [...merged.values()];
}
