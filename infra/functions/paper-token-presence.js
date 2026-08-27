// 紙面データへの匿名リクエストを Lambda まで到達させないための一次フィルタ。
// JWT の署名・期限・client_id は必ずオリジン Lambda でも検証する。
function handler(event) {
  var request = event.request;
  var token = request.headers['x-morning-token'];
  if (token && token.value) return request;

  return {
    statusCode: 401,
    statusDescription: 'Unauthorized',
    headers: {
      'cache-control': { value: 'no-store' },
      'content-type': { value: 'application/json; charset=utf-8' },
    },
    body: JSON.stringify({ error: 'unauthorized' }),
  };
}
