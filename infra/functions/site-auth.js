// CloudFront Function（viewer-request）。パスごとに認証の要否を切り替える。
//
// **既定は認証必須。公開するパスだけを明示的に除外する（fail closed）。**
// 逆に「/paper/ だけ認証」と書くと、将来 /admin/ や /data/ を足したときに素通りする。
// 判定を間違えたときに漏れる側ではなく閉まる側へ倒すため、この向きにしている。
//
// 公開層と紙面層はデータファイルも分けてある（overview.json と paper/data.json）。
// この関数が唯一の防壁にならないよう、公開層のファイルにはそもそも
// 記事の要約もストーリー名も入れない（ビルド時にassertで検査する）。
//
// CloudFront Functions には環境変数もシークレット参照も無いため、素朴に書くと資格情報が
// 関数コードに残る。KeyValueStore から読むことでコードの外に出している（JS runtime 2.0 必須）。
//
// 資格情報の登録（リポジトリには置かない）:
//   ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn "$KVS_ARN" --query ETag --output text)
//   aws cloudfront-keyvaluestore put-key --kvs-arn "$KVS_ARN" --if-match "$ETAG" \
//     --key authorization --value "Basic $(printf '%s' 'ユーザ名:パスワード' | base64)"

import cf from 'cloudfront';

var kvs = cf.kvs();

// 認証なしで見せるパス。ここに書いたものだけが公開される
var PUBLIC_PATHS = [
  /^\/$/,
  /^\/index\.html$/,
  /^\/overview\.json$/,
  /^\/assets\/[A-Za-z0-9._-]+$/,
  /^\/favicon\.ico$/,
  /^\/robots\.txt$/,
];

function isPublic(uri) {
  for (var i = 0; i < PUBLIC_PATHS.length; i++) {
    if (PUBLIC_PATHS[i].test(uri)) return true;
  }
  return false;
}

function unauthorized() {
  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: {
      'www-authenticate': { value: 'Basic realm="morning-agent", charset="UTF-8"' },
      'cache-control': { value: 'no-store' },
    },
  };
}

async function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // ディレクトリ指定を index.html に寄せてから判定する。
  // 判定の後にやると /paper/ が公開扱いのまま /paper/index.html に化ける
  if (uri.endsWith('/') && uri !== '/') {
    request.uri = uri + 'index.html';
    uri = request.uri;
  }

  if (isPublic(uri)) return request;

  var expected;
  try {
    expected = await kvs.get('authorization');
  } catch (e) {
    // 鍵が未登録のまま素通りさせるほうが危険なので、開くのではなく閉じる
    return {
      statusCode: 503,
      statusDescription: 'Service Unavailable',
      headers: { 'cache-control': { value: 'no-store' } },
    };
  }
  if (!expected) return unauthorized();

  var header = request.headers.authorization;
  if (!header || !header.value) return unauthorized();
  if (!safeEqual(header.value, expected)) return unauthorized();

  return request;
}

/** 比較時間が入力に依存しないように、長さを揃えてから全文字を走査する。 */
function safeEqual(a, b) {
  var diff = a.length ^ b.length;
  var n = a.length > b.length ? a.length : b.length;
  for (var i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
