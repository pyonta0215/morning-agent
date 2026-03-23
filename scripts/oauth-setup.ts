import * as readline from 'readline';
import { google } from 'googleapis';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// プロジェクトルートの .env を読み込む
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      'Error: GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET が設定されていません。\n' +
        '.env ファイルに設定してから再実行してください。'
    );
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    'urn:ietf:wg:oauth:2.0:oob' // インストール済みアプリ用のリダイレクトURI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // refresh_token を確実に取得するため
  });

  console.log('\n=== Google OAuth2 セットアップ ===\n');
  console.log('以下のURLをブラウザで開いて認証してください:\n');
  console.log(authUrl);
  console.log('\n認証後に表示される authorization code を入力してください。\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const code = await new Promise<string>((resolve) => {
    rl.question('Authorization code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.error(
        '\nError: refresh_token が取得できませんでした。\n' +
          'Google Cloud Console でアプリの承認を取り消してから再実行してください。\n' +
          '(Google Account > セキュリティ > サードパーティのアクセス)'
      );
      process.exit(1);
    }

    console.log('\n=== 取得した refresh_token ===\n');
    console.log(tokens.refresh_token);
    console.log('\n=== 次のステップ ===');
    console.log('このrefresh_tokenをAWS Secrets Managerに保存してください:\n');
    console.log(
      `aws secretsmanager create-secret --name morning-agent/google-oauth \\
  --secret-string '{"clientId":"${clientId}","clientSecret":"${clientSecret}","refreshToken":"${tokens.refresh_token}"}'`
    );
  } catch (err) {
    const error = err as { message?: string; response?: { data?: unknown } };
    console.error('\nError: トークンの取得に失敗しました。');
    console.error(error.message ?? String(err));
    if (error.response?.data) {
      console.error('Google API response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
