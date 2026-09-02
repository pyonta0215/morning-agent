// CloudFront Function（viewer-request）。S3 オリジンから直接配ってよいパスだけを通す。
//
// 紙面の HTML は Cognito ログインを開始するための「殻」なので公開する。記事の見出し・
// 要約を含む paper/data.json は別 behavior の Lambda が JWT を検証して返す。
// それ以外は既定で閉じ、将来 S3 に /admin/ などを足しても誤公開しない。

var PUBLIC_PATHS = [
  /^\/$/,
  /^\/index\.html$/,
  /^\/overview\.json$/,
  /^\/assets\/[A-Za-z0-9._-]+$/,
  /^\/favicon\.ico$/,
  /^\/robots\.txt$/,
  // 認証開始と OAuth コールバックを処理する。機密データは HTML 内に置かない
  /^\/paper\/index\.html$/,
  /^\/paper\/manifest\.webmanifest$/,
  /^\/paper\/icon\.svg$/,
  /^\/paper\/favicon-32\.png$/,
  /^\/paper\/icon-192\.png$/,
  /^\/paper\/icon-512\.png$/,
  /^\/paper\/apple-touch-icon\.png$/,
];

function isPublic(uri) {
  for (var i = 0; i < PUBLIC_PATHS.length; i++) {
    if (PUBLIC_PATHS[i].test(uri)) return true;
  }
  return false;
}

function notFound() {
  return {
    statusCode: 404,
    statusDescription: 'Not Found',
    headers: { 'cache-control': { value: 'no-store' } },
  };
}

function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // ディレクトリ指定を index.html に寄せてから判定する。
  if (uri.endsWith('/') && uri !== '/') {
    request.uri = uri + 'index.html';
    uri = request.uri;
  }

  return isPublic(uri) ? request : notFound();
}
