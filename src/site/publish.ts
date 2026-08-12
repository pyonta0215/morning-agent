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
import * as fs from 'fs';
import * as path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { SiteFile } from './siteData.js';

export const SITE_BUCKET_REGION = 'us-east-1';

/**
 * HTML などの静的ファイル。ビルドで dist/site へコピーされ、Lambda に同梱される。
 *
 * データと一緒に publish が毎回置き直す。別経路（手動アップロードや BucketDeployment）に
 * すると「デプロイしたのに画面が変わらない」が起きるので、出どころを1つにしている。
 */
const STATIC_DIR = process.env.LAMBDA_TASK_ROOT
  ? path.join(process.env.LAMBDA_TASK_ROOT, 'site')
  : path.join(path.dirname(new URL(import.meta.url).pathname), 'static');

const CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** dist/site（ローカルでは src/site/static）以下を再帰的に集める */
export function collectStaticFiles(dir: string = STATIC_DIR): SiteFile[] {
  if (!fs.existsSync(dir)) {
    console.warn(`[publish] 静的ファイルのディレクトリが無い: ${dir}`);
    return [];
  }
  const out: SiteFile[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      out.push({
        key: childRel,
        body: fs.readFileSync(childAbs, 'utf-8'),
        contentType: CONTENT_TYPE[path.extname(entry.name)] ?? 'application/octet-stream',
        // HTML はデータと同じ鮮度で差し替わってほしいので同じく短くする
        cacheControl: 'public, max-age=60',
      });
    }
  };
  walk(dir, '');
  return out;
}

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
