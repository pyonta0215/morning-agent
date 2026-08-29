/**
 * Cognito 認証済みのブラウザにだけ紙面データを返す Lambda Function URL。
 *
 * Function URL 自体は AWS_IAM にし、CloudFront OAC からの呼び出しだけを許可する。
 * CloudFront の SigV4 が Authorization ヘッダーを使うため、Cognito のアクセス
 * トークンは X-Morning-Token で受け取る。
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

export const TOKEN_HEADER = 'x-morning-token';

interface RequestEvent {
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
}

interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface AuthConfig {
  cognitoDomain: string;
  clientId: string;
  redirectUri: string;
  logoutUri: string;
  scopes: string;
  tokenHeader: string;
}

export interface PaperApiDependencies {
  authConfig: AuthConfig;
  verify(token: string): Promise<unknown>;
  getPaperData(): Promise<string>;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff',
};

function response(statusCode: number, body: unknown, cacheControl = 'no-store'): Response {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, 'cache-control': cacheControl },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function header(event: RequestEvent, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** 依存を差し替えられる形にし、認証境界を AWS へ接続せずテストできるようにする。 */
export function createPaperApiHandler(deps: PaperApiDependencies) {
  return async (event: RequestEvent): Promise<Response> => {
    const method = event.requestContext?.http?.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      return response(405, { error: 'method_not_allowed' });
    }

    const path = event.rawPath ?? '';
    if (path === '/paper/auth-config.json') {
      const result = response(200, deps.authConfig, 'public, max-age=300');
      if (method === 'HEAD') result.body = '';
      return result;
    }
    if (path !== '/paper/data.json') {
      return response(404, { error: 'not_found' });
    }

    const token = header(event, TOKEN_HEADER);
    if (!token) return response(401, { error: 'unauthorized' });

    try {
      await deps.verify(token);
    } catch {
      return response(401, { error: 'unauthorized' });
    }

    try {
      const data = await deps.getPaperData();
      const result = response(200, data, 'private, no-store');
      if (method === 'HEAD') result.body = '';
      return result;
    } catch (error) {
      // データ本文やトークンはログに出さない。
      console.error('[paper-api] paper/data.json could not be read', {
        name: error instanceof Error ? error.name : 'UnknownError',
      });
      return response(503, { error: 'paper_unavailable' });
    }
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

let productionHandler: ReturnType<typeof createPaperApiHandler> | undefined;

function makeProductionHandler(): ReturnType<typeof createPaperApiHandler> {
  const userPoolId = required('COGNITO_USER_POOL_ID');
  const clientId = required('COGNITO_CLIENT_ID');
  const bucket = required('SITE_BUCKET');
  const verifier = CognitoJwtVerifier.create({
    userPoolId,
    clientId,
    tokenUse: 'access',
  });
  const s3 = new S3Client({ region: process.env.AWS_REGION });

  return createPaperApiHandler({
    authConfig: {
      cognitoDomain: required('COGNITO_DOMAIN'),
      clientId,
      redirectUri: required('REDIRECT_URI'),
      logoutUri: required('LOGOUT_URI'),
      scopes: 'openid email aws.cognito.signin.user.admin',
      tokenHeader: TOKEN_HEADER,
    },
    verify: (token) => verifier.verify(token),
    getPaperData: async () => {
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'paper/data.json' }));
      if (!object.Body) throw new Error('paper/data.json has no body');
      return object.Body.transformToString('utf-8');
    },
  });
}

export async function handler(event: RequestEvent): Promise<Response> {
  productionHandler ??= makeProductionHandler();
  return productionHandler(event);
}
