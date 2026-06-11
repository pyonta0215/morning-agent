import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { WebItem } from '../agents/webAgent.js';
import type { Topic } from '../agents/base.js';

/** 収集ソース1件分の生データ（評価ハーネスの忠実性判定・A/B再実行の入力に使用） */
export interface ArchivedSource {
  topicId: string;
  topicLabel: string;
  url: string;
  content: string;
}

/** 1配信分の実行アーカイブ。評価ハーネス（scripts/eval.ts）のゴールデンセット原料 */
export interface RunArchive {
  isoDate: string;
  edition: 'morning' | 'evening';
  /** 実行時点のトピック定義（カテゴリ精度判定の基準） */
  topics: Array<Pick<Topic, 'id' | 'label' | 'keywords'>>;
  /** LLMに渡した収集ソースの生データ */
  sources: ArchivedSource[];
  /** 紙面に掲載された記事（集約＋web_search マージ・重複除去後） */
  byTopic: Record<string, WebItem[]>;
  /** 編集長コメント付きの注目記事 */
  picks: Array<{ title: string; comment: string }>;
  /** エージェント別の実行統計 */
  usage: Array<{ agentId: string; tokensUsed: number; durationMs: number }>;
}

const ARCHIVE_PREFIX = 'archive/';

function archiveKey(isoDate: string, edition: 'morning' | 'evening'): string {
  return `${ARCHIVE_PREFIX}${isoDate}-${edition}.json`;
}

export async function saveRunArchive(
  s3: S3Client,
  bucket: string,
  archive: RunArchive
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: archiveKey(archive.isoDate, archive.edition),
      Body: JSON.stringify(archive),
      ContentType: 'application/json',
    })
  );
  const itemCount = Object.values(archive.byTopic).flat().length;
  console.log(
    JSON.stringify({
      type: 'RUN_ARCHIVE_SAVED',
      isoDate: archive.isoDate,
      edition: archive.edition,
      sources: archive.sources.length,
      items: itemCount,
    })
  );
}

/** アーカイブのS3キー一覧を日付昇順で返す */
export async function listRunArchiveKeys(s3: S3Client, bucket: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: ARCHIVE_PREFIX, ContinuationToken: token })
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key?.endsWith('.json')) keys.push(obj.Key);
    }
    token = res.NextContinuationToken;
  } while (token);
  return keys.sort();
}

export async function loadRunArchive(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<RunArchive | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as RunArchive;
  } catch (err) {
    console.warn(`[runArchive] failed to load ${key}: ${(err as Error).message}`);
    return null;
  }
}
