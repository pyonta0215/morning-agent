/**
 * 組み立てたファイルを閲覧サイトのバケットへ置く。
 *
 * サイトのバケットは us-east-1（CloudFront の証明書がそこにしか置けないため、
 * スタックごと us-east-1 に置いている）。Lambda は ap-northeast-1 なので、
 * ここだけ別リージョンのクライアントを使う。
 *
 * CloudFront のキャッシュ無効化はしない。更新は1日1回なので、
 * オブジェクトの Cache-Control を短くしておけば足りる。
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { SiteFile } from './siteData.js';

export const SITE_BUCKET_REGION = 'us-east-1';

export function getSiteS3Client(): S3Client {
  return new S3Client({ region: SITE_BUCKET_REGION });
}

export async function publishSiteFiles(
  s3: S3Client,
  bucket: string,
  files: SiteFile[]
): Promise<void> {
  for (const f of files) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: f.key,
        Body: f.body,
        ContentType: f.contentType,
        CacheControl: f.cacheControl,
      })
    );
  }
  console.log(
    JSON.stringify({
      type: 'SITE_PUBLISHED',
      bucket,
      files: files.map((f) => ({ key: f.key, bytes: Buffer.byteLength(f.body) })),
    })
  );
}
