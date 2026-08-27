import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaperApiHandler, TOKEN_HEADER, type AuthConfig } from './paper-api.js';

const authConfig: AuthConfig = {
  cognitoDomain: 'https://example.auth.us-east-1.amazoncognito.com',
  clientId: 'client-id',
  redirectUri: 'https://news.example.com/paper/',
  logoutUri: 'https://news.example.com/',
  scopes: 'openid',
  tokenHeader: TOKEN_HEADER,
};

function event(path: string, token?: string, method = 'GET') {
  return {
    rawPath: path,
    headers: token ? { [TOKEN_HEADER]: token } : {},
    requestContext: { http: { method } },
  };
}

test('認証設定はトークンなしで取得できる', async () => {
  const handler = createPaperApiHandler({
    authConfig,
    verify: async () => undefined,
    getPaperData: async () => '{}',
  });
  const result = await handler(event('/paper/auth-config.json'));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), authConfig);
});

test('紙面データはトークンなし・無効トークンでは返さない', async () => {
  let reads = 0;
  const handler = createPaperApiHandler({
    authConfig,
    verify: async (token) => {
      if (token !== 'valid') throw new Error('invalid');
    },
    getPaperData: async () => {
      reads++;
      return '{"secret":true}';
    },
  });

  assert.equal((await handler(event('/paper/data.json'))).statusCode, 401);
  assert.equal((await handler(event('/paper/data.json', 'invalid'))).statusCode, 401);
  assert.equal(reads, 0);
});

test('有効な Cognito アクセストークンでだけ紙面データを返す', async () => {
  const handler = createPaperApiHandler({
    authConfig,
    verify: async (token) => assert.equal(token, 'valid'),
    getPaperData: async () => '{"secret":true}',
  });
  const result = await handler(event('/paper/data.json', 'valid'));
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'private, no-store');
  assert.equal(result.body, '{"secret":true}');
});

test('想定外のパスとメソッドは閉じる', async () => {
  const handler = createPaperApiHandler({
    authConfig,
    verify: async () => undefined,
    getPaperData: async () => '{}',
  });
  assert.equal((await handler(event('/paper/other.json', 'valid'))).statusCode, 404);
  assert.equal((await handler(event('/paper/data.json', 'valid', 'POST'))).statusCode, 405);
});
