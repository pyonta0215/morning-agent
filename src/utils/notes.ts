/**
 * 自分で書いたメモ。`notes/YYYY-MM-DD.md` に1日1本。
 *
 * **いまは読む側だけ。** 書く口（メールへの返信をSESで受ける）は #13 で作る。
 * 先に読む側を入れておくのは、メールと概観ページの置き場所を決めてしまうため。
 * 場所が決まっていないと、書けるようになった日に両方を直すことになる。
 *
 * `notes/` は台帳と同じく**失うと復元できない**。バケットはバージョニング済み（#10）。
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export const NOTES_PREFIX = 'notes/';

export function noteKey(isoDate: string): string {
  return `${NOTES_PREFIX}${isoDate}.md`;
}

/** その日のメモ。無ければ null */
export async function loadNote(
  s3: S3Client,
  bucket: string,
  isoDate: string
): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: noteKey(isoDate) }));
    const body = (await res.Body?.transformToString())?.trim();
    return body ? body : null;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    // メモが読めないことでメールを止めない
    console.warn(`[notes] failed to load ${noteKey(isoDate)}: ${(err as Error).message}`);
    return null;
  }
}
