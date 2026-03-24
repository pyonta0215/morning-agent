import type { Context } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { loadConfig, setTraceId } from './config/settings.js';
import { SesClient } from './clients/sesClient.js';
import { Pipeline } from './orchestrator/pipeline.js';
import { WebAgent } from './agents/webAgent.js';
import { ComposerAgent, formatDateJST } from './agents/composerAgent.js';
import type { AgentInput } from './agents/base.js';

const S3_KEY = 'pending/email.json';

interface StoredEmail {
  date: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

function getS3Client(region: string): S3Client {
  return new S3Client({ region });
}

async function saveEmailToS3(s3: S3Client, bucket: string, email: StoredEmail): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: S3_KEY,
      Body: JSON.stringify(email),
      ContentType: 'application/json',
    })
  );
  console.log(`[index] Email content saved to s3://${bucket}/${S3_KEY}`);
}

async function loadEmailFromS3(s3: S3Client, bucket: string): Promise<StoredEmail | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: S3_KEY }));
    const body = await res.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as StoredEmail;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === 'NoSuchKey' || code === 'NotFound') return null;
    throw err;
  }
}

async function deleteEmailFromS3(s3: S3Client, bucket: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: S3_KEY }));
}

/** 収集フェーズ: WebAgent + ComposerAgent(buildOnly) → S3に保存 */
async function runCollectPhase(traceId: string): Promise<void> {
  const config = await loadConfig();
  const bucket = process.env.STORAGE_BUCKET ?? '';
  if (!bucket) throw new Error('[index] STORAGE_BUCKET env var is not set');

  const sesClient = new SesClient(config.sesRegion);
  const dryRun = process.env.DRY_RUN === 'true';
  const s3 = getS3Client(config.awsRegion);

  const pipeline = new Pipeline();
  pipeline.register(new WebAgent(), 'collect');
  pipeline.register(new ComposerAgent(sesClient, config, dryRun, /* buildOnly */ true), 'compose');

  const input: AgentInput = { date: new Date(), config };
  const results = await pipeline.run(input);

  const composerResult = results.find((r) => r.agentId === 'composer');
  const data = composerResult?.data as { subject?: string; htmlBody?: string; textBody?: string; topicsCount?: number } | undefined;

  if (!data?.subject || !data?.htmlBody || !data?.textBody) {
    throw new Error('[index] ComposerAgent did not return expected email content');
  }

  const dateStr = formatDateJST(new Date());
  await saveEmailToS3(s3, bucket, {
    date: dateStr,
    subject: data.subject,
    htmlBody: data.htmlBody,
    textBody: data.textBody,
  });

  console.log(
    JSON.stringify({
      type: 'COLLECT_PHASE_SUCCESS',
      traceId,
      topicsCount: data.topicsCount,
      agentResults: results.map((r) => ({
        agentId: r.agentId,
        tokensUsed: r.tokensUsed,
        durationMs: r.durationMs,
        error: r.error,
      })),
    })
  );
}

/** 送信フェーズ: S3からHTML読み出し → SES送信 */
async function runSendPhase(traceId: string): Promise<void> {
  const config = await loadConfig();
  const bucket = process.env.STORAGE_BUCKET ?? '';
  if (!bucket) throw new Error('[index] STORAGE_BUCKET env var is not set');

  const sesClient = new SesClient(config.sesRegion);
  const dryRun = process.env.DRY_RUN === 'true';
  const s3 = getS3Client(config.awsRegion);

  const stored = await loadEmailFromS3(s3, bucket);

  if (!stored) {
    // 収集フェーズのデータが存在しない場合: エラー通知メールを送信
    console.error('[index] No stored email found in S3. Sending error notification.');
    const dateStr = formatDateJST(new Date());
    if (!dryRun) {
      await sesClient.sendEmail({
        from: config.senderEmail,
        to: config.recipientEmail,
        subject: `[朝刊エージェント便] ${dateStr} 配信エラー`,
        htmlBody: `<p>本日（${dateStr}）の朝刊エージェント便の生成に失敗しました。ログを確認してください。</p>`,
        textBody: `本日（${dateStr}）の朝刊エージェント便の生成に失敗しました。ログを確認してください。`,
      });
    }
    console.log(JSON.stringify({ type: 'SEND_PHASE_ERROR_NOTIFIED', traceId, date: dateStr }));
    return;
  }

  if (!dryRun) {
    await sesClient.sendEmail({
      from: config.senderEmail,
      to: config.recipientEmail,
      subject: stored.subject,
      htmlBody: stored.htmlBody,
      textBody: stored.textBody,
    });
    console.log(`[index] Email sent to ${config.recipientEmail}`);
    await deleteEmailFromS3(s3, bucket);
  } else {
    console.log('[index] Dry run: skipping email send');
    console.log('Subject:', stored.subject);
  }

  console.log(JSON.stringify({ type: 'SEND_PHASE_SUCCESS', traceId, subject: stored.subject }));
}

/** フルフェーズ: 収集〜送信を一括実行（ローカル開発用） */
async function runFullPhase(traceId: string): Promise<void> {
  const config = await loadConfig();
  const sesClient = new SesClient(config.sesRegion);
  const dryRun = process.env.DRY_RUN === 'true';

  const pipeline = new Pipeline();
  pipeline.register(new WebAgent(), 'collect');
  pipeline.register(new ComposerAgent(sesClient, config, dryRun), 'compose');

  const input: AgentInput = { date: new Date(), config };
  const results = await pipeline.run(input);

  console.log(
    JSON.stringify({
      type: 'HANDLER_SUCCESS',
      traceId,
      agentResults: results.map((r) => ({
        agentId: r.agentId,
        tokensUsed: r.tokensUsed,
        durationMs: r.durationMs,
        error: r.error,
      })),
    })
  );
}

export const handler = async (event: unknown, context?: Context): Promise<void> => {
  const traceId = context?.awsRequestId ?? 'local';
  setTraceId(traceId);

  const phase = (event as Record<string, unknown>)?.phase as string | undefined;
  console.log(JSON.stringify({ type: 'HANDLER_START', traceId, phase, event }));

  try {
    if (phase === 'collect') {
      await runCollectPhase(traceId);
    } else if (phase === 'send') {
      await runSendPhase(traceId);
    } else {
      await runFullPhase(traceId);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ type: 'HANDLER_ERROR', traceId, phase, error }));
    throw err;
  }
};
