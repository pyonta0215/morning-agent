import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { handler } from '../src/index.js';
import { SesClient } from '../src/clients/sesClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// プロジェクトルートの .env を読み込む（import より後だが handler 呼び出し前に実行される）
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.warn('.env ファイルが見つかりません。環境変数が設定されていることを確認してください。');
}

process.env.LOCAL_DEV = 'true';

// CLI 引数のパース
const args = process.argv.slice(2);
const agentIndex = args.indexOf('--agent');
const agentFilter = agentIndex !== -1 ? args[agentIndex + 1] : undefined;
const dryRun = args.includes('--dry-run');
const testEmail = args.includes('--test-email');

if (agentFilter) process.env.AGENT_FILTER = agentFilter;
if (dryRun) process.env.DRY_RUN = 'true';

async function sendTestEmail() {
  const region = process.env.SES_REGION ?? 'us-east-1';
  const to = process.env.RECIPIENT_EMAIL;
  const from = process.env.SENDER_EMAIL;

  if (!to || !from) {
    console.error('Error: RECIPIENT_EMAIL と SENDER_EMAIL を .env に設定してください。');
    process.exit(1);
  }

  console.log(`送信先: ${to}`);
  console.log(`送信元: ${from}`);
  console.log('SES に接続中...');

  const ses = new SesClient(region);
  await ses.sendEmail({
    from,
    to,
    subject: '[朝刊エージェント便] SES 疎通テスト',
    htmlBody: `<h1>SES 疎通テスト</h1><p>このメールが届いていれば SES の設定は正常です。</p><p>送信日時: ${new Date().toISOString()}</p>`,
    textBody: `SES 疎通テスト\n\nこのメールが届いていれば SES の設定は正常です。\n送信日時: ${new Date().toISOString()}`,
  });

  console.log('✓ テストメール送信完了');
}

async function main() {
  console.log('=== 朝刊エージェント便 ローカルテスト実行 ===');
  console.log(`日時: ${new Date().toISOString()}`);

  if (testEmail) {
    console.log('モード: SES 疎通テスト\n');
    try {
      await sendTestEmail();
    } catch (err) {
      console.error('\n✗ 送信失敗:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    return;
  }

  if (agentFilter) console.log(`エージェント絞り込み: ${agentFilter}`);
  if (dryRun) console.log('ドライラン: メール送信をスキップします');
  console.log('');

  try {
    await handler({}, undefined);
    console.log('\n✓ 実行完了');
  } catch (err) {
    console.error('\n✗ 実行失敗:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
