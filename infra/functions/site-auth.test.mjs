/**
 * site-auth.js の公開パス判定だけを検査する。
 *
 * ここは「どのURLが認証なしで見えるか」を決める唯一の場所で、間違えると
 * 紙面がそのまま外へ出る。CloudFront Functions のランタイム（JS 2.0・cloudfront モジュール）は
 * ローカルで動かせないので、判定に使う PUBLIC_PATHS と isPublic だけをソースから切り出して評価する。
 *
 *   node infra/functions/site-auth.test.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'site-auth.js'), 'utf-8');

// import 文と cf.kvs() を落として、判定部分だけを評価できる形にする
const body = src
  .split('\n')
  .filter((l) => !l.startsWith('import ') && !l.startsWith('var kvs'))
  .join('\n')
  .replace(/async function handler[\s\S]*?\n}\n/, '');

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
];

const PRIVATE = [
  // 紙面そのもの
  '/paper/',
  '/paper/index.html',
  '/paper/data.json',
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
