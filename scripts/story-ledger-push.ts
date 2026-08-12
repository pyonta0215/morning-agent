/**
 * ローカルでバックフィルした台帳をS3へ載せる（初回シード用）。
 *
 * 台帳は失うと復元できないので、既にS3にあるときは既定で何もしない。
 * 上書きするときだけ `--force` を明示する（上書き前の版は index.prev.json に退避される）。
 *
 *   AWS_REGION=ap-northeast-1 npx tsx scripts/story-ledger-push.ts --dry-run
 *   AWS_REGION=ap-northeast-1 npx tsx scripts/story-ledger-push.ts
 *   AWS_REGION=ap-northeast-1 npx tsx scripts/story-ledger-push.ts --force
 *
 * 注意: `.env` の SES 用キーではバケットの権限が足りない。~/.aws の既定プロファイルで実行すること。
 */
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { S3Client } from '@aws-sdk/client-s3';
import type { StoryLedger } from '../src/utils/storyLedger.js';
import { loadStoryLedger, saveStoryLedger, storyLedgerExists } from '../src/utils/storyStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const i = args.indexOf('--ledger');
const ledgerPath = path.resolve(
  i !== -1 ? args[i + 1] : path.join(__dirname, '../.local/stories.json')
);

async function main(): Promise<void> {
  const bucket = process.env.STORAGE_BUCKET;
  if (!bucket) throw new Error('STORAGE_BUCKET が未設定です');

  const local = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8')) as StoryLedger;
  const dates = [...new Set(local.stories.flatMap((s) => Object.keys(s.dailyCounts)))].sort();
  console.log(
    `ローカル台帳: ${ledgerPath}\n` +
      `  ストーリー ${local.stories.length}本 / ${dates[0]} 〜 ${dates[dates.length - 1]} (${dates.length}日)`
  );

  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
  const exists = await storyLedgerExists(s3, bucket);

  if (exists) {
    const remote = await loadStoryLedger(s3, bucket);
    console.log(`S3の台帳: ストーリー ${remote.stories.length}本 / 更新 ${remote.updatedAt}`);
    if (!force) {
      console.log('\n既にS3に台帳があります。上書きするなら --force を付けてください。');
      return;
    }
    console.log('\n--force が指定されました。上書きします（旧版は stories/index.prev.json に退避）。');
  }

  if (dryRun) {
    console.log('\n--dry-run なので書き込みません。');
    return;
  }

  await saveStoryLedger(s3, bucket, local);
  console.log(`\ns3://${bucket}/stories/index.json に書き込みました。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
