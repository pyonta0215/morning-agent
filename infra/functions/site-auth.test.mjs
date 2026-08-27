/**
 * site-path-guard.js の公開パス判定だけを検査する。
 *
 * ここは「どのURLが認証なしで見えるか」を決める唯一の場所で、間違えると
 * 紙面データがそのまま外へ出る。判定に使う PUBLIC_PATHS と isPublic だけを
 * ソースから切り出して評価する。
 *
 *   node infra/functions/site-auth.test.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'site-path-guard.js'), 'utf-8');

const body = src.split('\nfunction handler')[0];

const isPublic = new Function(`${body}; return isPublic;`)();

/** handler のディレクトリ正規化と同じ変換 */
function normalize(uri) {
  return uri.endsWith('/') && uri !== '/' ? `${uri}index.html` : uri;
}

const PUBLIC = [
  '/',
  '/index.html',
  '/overview.json',
  '/assets/style.css',
  '/assets/app.js',
  '/favicon.ico',
  '/robots.txt',
  // Cognito ログインを開始する静的な殻。記事・要約は含まない
  '/paper/',
  '/paper/index.html',
  '/paper/manifest.webmanifest',
  '/paper/icon.svg',
  '/paper/icon-512.png',
  '/paper/apple-touch-icon.png',
];

const PRIVATE = [
  // ここは CloudFront の別 behavior から認証 Lambda へ送る。S3 側では閉じたままにする
  '/paper/data.json',
  '/paper/auth-config.json',
  '/paper/2026-08-10.html',
  // 将来足しうるもの。既定が認証必須なので、書き足さなくても閉じている必要がある
  '/admin/',
  '/data/full.json',
  '/stories/index.json',
  '/archive/2026-08-10-morning.json',
  '/notes/2026-08-09.md',
  // 素朴なパターンマッチを抜けにいく形
  '/assets/../paper/data.json',
  '/assets/sub/dir/secret.json',
  '/Index.html',
  '/index.html.bak',
  '/overview.json/../paper/data.json',
  '/paper',
  '//paper/data.json',
];

let failed = 0;
for (const uri of PUBLIC) {
  const got = isPublic(normalize(uri));
  if (!got) {
    console.error(`✗ 公開のはずが閉じている: ${uri}`);
    failed++;
  }
}
for (const uri of PRIVATE) {
  const got = isPublic(normalize(uri));
  if (got) {
    console.error(`✗ 認証が必要なのに素通り: ${uri}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed}件 失敗`);
  process.exit(1);
}
console.log(`✓ 公開${PUBLIC.length}件 / 非公開${PRIVATE.length}件 すべて期待どおり`);
