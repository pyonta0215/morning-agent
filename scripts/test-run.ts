import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// プロジェクトルートの .env を読み込む
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  console.warn('.env ファイルが見つかりません。環境変数が設定されていることを確認してください。');
}

// LOCAL_DEV フラグを設定（settings.ts がAWS APIをスキップするため）
process.env.LOCAL_DEV = 'true';

// CLI引数のパース
const args = process.argv.slice(2);
const agentIndex = args.indexOf('--agent');
const agentFilter = agentIndex !== -1 ? args[agentIndex + 1] : undefined;
const dryRun = args.includes('--dry-run');

if (agentFilter) {
  process.env.AGENT_FILTER = agentFilter;
}
if (dryRun) {
  process.env.DRY_RUN = 'true';
}

async function main() {
  console.log('=== 朝刊エージェント便 ローカルテスト実行 ===');
  console.log(`日時: ${new Date().toISOString()}`);
  if (agentFilter) console.log(`エージェント絞り込み: ${agentFilter}`);
  if (dryRun) console.log('ドライラン: メール送信をスキップします');
  console.log('');

  try {
    // 動的インポートで handler を呼び出す
    const { handler } = await import('../src/index.js');
    await handler({}, undefined);
    console.log('\n✓ 実行完了');
  } catch (err) {
    console.error('\n✗ 実行失敗:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
