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

/** 日付と版を指定して1件読む。フェーズを跨いで同じ日のアーカイブを参照するのに使う */
export async function loadRunArchiveFor(
  s3: S3Client,
  bucket: string,
  isoDate: string,
  edition: 'morning' | 'evening'
): Promise<RunArchive | null> {
  return loadRunArchive(s3, bucket, archiveKey(isoDate, edition));
}

/**
 * 編集長が選んだ注目記事を、あとから書き足す。
 *
 * アーカイブは生データとして不変に保つのが原則だが、picks だけは例外。
 * 3フェーズに分けた結果、picks を決めるのは notify フェーズになり、
 * アーカイブを書く collect フェーズの時点ではまだ存在しないため。
 * **書き換えるのは picks だけで、sources と byTopic には触れない**
 * （評価ハーネスのゴールデンセット原料はこの2つ）。
 */
export async function updateRunArchivePicks(
  s3: S3Client,
  bucket: string,
  isoDate: string,
  edition: 'morning' | 'evening',
  picks: Array<{ title: string; comment: string }>
): Promise<void> {
  const archive = await loadRunArchiveFor(s3, bucket, isoDate, edition);
  if (!archive) {
    console.warn(`[runArchive] picks を書き戻す対象が見つからない: ${isoDate}-${edition}`);
    return;
  }
  archive.picks = picks;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: archiveKey(isoDate, edition),
      Body: JSON.stringify(archive),
      ContentType: 'application/json',
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
