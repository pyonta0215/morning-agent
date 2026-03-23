import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { handler } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// プロジェクトルートの .env を読み込む（import より後だが handler 呼び出し前に実行される）
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.warn('.env ファイルが見つかりません。環境変数が設定されていることを確認してください。');
}

// LOCAL_DEV フラグを設定（settings.ts が AWS API をスキップするため）
process.env.LOCAL_DEV = 'true';

// CLI 引数のパース
const args = process.argv.slice(2);
const agentIndex = args.indexOf('--agent');
const agentFilter = agentIndex !== -1 ? args[agentIndex + 1] : undefined;
const dryRun = args.includes('--dry-run');

if (agentFilter) process.env.AGENT_FILTER = agentFilter;
if (dryRun) process.env.DRY_RUN = 'true';

async function main() {
  console.log('=== 朝刊エージェント便 ローカルテスト実行 ===');
  console.log(`日時: ${new Date().toISOString()}`);
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
