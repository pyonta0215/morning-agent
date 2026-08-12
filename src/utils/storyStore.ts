/**
 * ストーリー台帳のS3レイアウトと読み書き。
 *
 * ```
 * s3://<bucket>/
 *   archive/YYYY-MM-DD-<edition>.json   生データ。不変。ライフサイクル無し（既存）
 *   stories/index.json                  台帳の現行版          ← このファイルが扱う
 *   stories/index.prev.json             1つ前の版（誤書き込みからの復旧用）
 * ```
 *
 * **台帳は archive から再生成できない。** LLMの判断が入るため、同じ入力でも同じ割当にはならない。
 * バックフィルで「それらしい台帳」は作り直せるが、いま入っているIDと対応が取れないので、
 * 台帳を参照して書いた自分のメモや外部リンクは全部ずれる。失ったら復元不可と考えること。
 *
 * そのため書き込みは「現行版を prev に退避 → 新しい版を書く」の順で行う。
 * バケットのバージョニング（#10）が入るまでの当座の保険で、直近1世代だけ守れる。
 *
 * 派生データ（紙面・概観のJSON）は別プレフィックスに書く。stories/ には台帳だけを置く。
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { emptyLedger, type StoryLedger } from './storyLedger.js';

export const STORY_LEDGER_KEY = 'stories/index.json';
export const STORY_LEDGER_PREV_KEY = 'stories/index.prev.json';

/** 台帳を読む。まだ無ければ空の台帳を返す（初回実行を特別扱いしないため） */
export async function loadStoryLedger(s3: S3Client, bucket: string): Promise<StoryLedger> {
  const raw = await getJson(s3, bucket, STORY_LEDGER_KEY);
  return raw ? (JSON.parse(raw) as StoryLedger) : emptyLedger();
}

/** 台帳が既にS3にあるか。初回シードを二重に流さないための確認に使う */
export async function storyLedgerExists(s3: S3Client, bucket: string): Promise<boolean> {
  return (await getJson(s3, bucket, STORY_LEDGER_KEY)) !== null;
}

/** 現行版を prev に退避してから書く */
export async function saveStoryLedger(
  s3: S3Client,
  bucket: string,
  ledger: StoryLedger
): Promise<void> {
  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${STORY_LEDGER_KEY}`,
        Key: STORY_LEDGER_PREV_KEY,
      })
    );
  } catch (err) {
    // 初回は現行版が無いので必ず失敗する。退避できないこと自体は書き込みを止める理由にならない
    const name = (err as { name?: string }).name;
    if (name !== 'NoSuchKey' && name !== 'NotFound') {
      console.warn(`[storyStore] failed to snapshot previous ledger: ${(err as Error).message}`);
    }
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: STORY_LEDGER_KEY,
      Body: JSON.stringify(ledger),
      ContentType: 'application/json',
    })
  );
}

async function getJson(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString()) ?? null;
  } catch (err) {
    const name = (err as { name?: string }).name;
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    throw err;
  }
}
