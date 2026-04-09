import type { Context } from 'aws-lambda';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { loadConfig, setTraceId } from './config/settings.js';
import { SesClient } from './clients/sesClient.js';
import { Pipeline } from './orchestrator/pipeline.js';
import { WebAgent } from './agents/webAgent.js';
import type { WebAgentData } from './agents/webAgent.js';
import { ComposerAgent, formatDateJST } from './agents/composerAgent.js';
import type { AgentInput } from './agents/base.js';
import {
  saveEditorialContext,
  loadEditorialContext,
  buildEditorialContext,
} from './utils/editorialContext.js';

const S3_KEY_MORNING = 'pending/morning-email.json';
const S3_KEY_EVENING = 'pending/evening-email.json';

interface StoredEmail {
  date: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

function getS3Client(region: string): S3Client {
  return new S3Client({ region });
}

async function saveEmailToS3(s3: S3Client, bucket: string, key: string, email: StoredEmail): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(email),
      ContentType: 'application/json',
    })
  );
  console.log(`[index] Email content saved to s3://${bucket}/${key}`);
}

async function loadEmailFromS3(s3: S3Client, bucket: string, key: string): Promise<StoredEmail | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as StoredEmail;
  } catch (err: unknown) {
    const code = (err as { name?: string }).name;
    if (code === 'NoSuchKey' || code === 'NotFound') return null;
    throw err;
  }
}

async function deleteEmailFromS3(s3: S3Client, bucket: string, key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

/** 収集フェーズ共通処理 */
async function runCollectPhaseFor(
  traceId: string,
  edition: 'morning' | 'evening',
  s3Key: string
): Promise<void> {
  const config = await loadConfig();
  const bucket = process.env.STORAGE_BUCKET ?? '';
  if (!bucket) throw new Error('[index] STORAGE_BUCKET env var is not set');

  const sesClient = new SesClient(config.sesRegion);
  const dryRun = process.env.DRY_RUN === 'true';
  const s3 = getS3Client(config.awsRegion);
  const enhancedEditorial = process.env.ENHANCED_EDITORIAL === 'true';

  // 夕刊は朝刊のコンテキストを引き継ぐ（ENHANCED_EDITORIAL=true 時）
  let previousContext = null;
  if (enhancedEditorial && edition === 'evening') {
    previousContext = await loadEditorialContext(s3, bucket, 'morning');
  }

  const pipeline = new Pipeline();
  pipeline.register(new WebAgent(), 'collect');
  pipeline.register(
    new ComposerAgent(sesClient, config, dryRun, /* buildOnly */ true, edition, previousContext),
    'compose'
  );

  const input: AgentInput = { date: new Date(), config };
  const results = await pipeline.run(input);

  const composerResult = results.find((r) => r.agentId === 'composer');
  const data = composerResult?.data as {
    subject?: string;
    htmlBody?: string;
    textBody?: string;
    topicsCount?: number;
    picks?: Array<{ title: string; comment: string }>;
  } | undefined;

  if (!data?.subject || !data?.htmlBody || !data?.textBody) {
    throw new Error('[index] ComposerAgent did not return expected email content');
  }

  const dateStr = formatDateJST(new Date());
  await saveEmailToS3(s3, bucket, s3Key, {
    date: dateStr,
    subject: data.subject,
    htmlBody: data.htmlBody,
    textBody: data.textBody,
  });

  // 編集コンテキストを保存（次の版で使用）
  if (enhancedEditorial && data.picks && data.picks.length > 0) {
    const webResult = results.find((r) => r.agentId === 'web');
    const webData = webResult?.data as WebAgentData | undefined;
    if (webData) {
      const ctx = buildEditorialContext(edition, dateStr, data.picks, webData.byTopic);
      await saveEditorialContext(s3, bucket, ctx);
    }
  }

  console.log(
    JSON.stringify({
      type: 'COLLECT_PHASE_SUCCESS',
      traceId,
      edition,
      topicsCount: data.topicsCount,
      enhancedEditorial,
      hasPreviousContext: previousContext !== null,
      agentResults: results.map((r) => ({
        agentId: r.agentId,
        tokensUsed: r.tokensUsed,
        durationMs: r.durationMs,
        error: r.error,
      })),
    })
  );
}

/** 送信フェーズ共通処理 */
async function runSendPhaseFor(
  traceId: string,
  edition: 'morning' | 'evening',
  s3Key: string
): Promise<void> {
  const config = await loadConfig();
  const bucket = process.env.STORAGE_BUCKET ?? '';
  if (!bucket) throw new Error('[index] STORAGE_BUCKET env var is not set');

  const sesClient = new SesClient(config.sesRegion);
  const dryRun = process.env.DRY_RUN === 'true';
  const s3 = getS3Client(config.awsRegion);
  const editionLabel = edition === 'evening' ? '夕刊' : '朝刊';

  const stored = await loadEmailFromS3(s3, bucket, s3Key);

  if (!stored) {
    console.error(`[index] No stored email found in S3 for ${edition}. Sending error notification.`);
    const dateStr = formatDateJST(new Date());
    if (!dryRun) {
      await sesClient.sendEmail({
        from: config.senderEmail,
        to: config.recipientEmail,
        subject: `[${editionLabel}エージェント便] ${dateStr} 配信エラー`,
        htmlBody: `<p>本日（${dateStr}）の${editionLabel}エージェント便の生成に失敗しました。ログを確認してください。</p>`,
        textBody: `本日（${dateStr}）の${editionLabel}エージェント便の生成に失敗しました。ログを確認してください。`,
      });
    }
    console.log(JSON.stringify({ type: 'SEND_PHASE_ERROR_NOTIFIED', traceId, edition, date: formatDateJST(new Date()) }));
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
    await deleteEmailFromS3(s3, bucket, s3Key);
  } else {
    console.log('[index] Dry run: skipping email send');
    console.log('Subject:', stored.subject);
  }

  console.log(JSON.stringify({ type: 'SEND_PHASE_SUCCESS', traceId, edition, subject: stored.subject }));
}

/** 収集フェーズ: 朝刊 */
async function runCollectPhase(traceId: string): Promise<void> {
  return runCollectPhaseFor(traceId, 'morning', S3_KEY_MORNING);
}

/** 送信フェーズ: 朝刊 */
async function runSendPhase(traceId: string): Promise<void> {
  return runSendPhaseFor(traceId, 'morning', S3_KEY_MORNING);
}

/** 収集フェーズ: 夕刊 */
async function runEveningCollectPhase(traceId: string): Promise<void> {
  return runCollectPhaseFor(traceId, 'evening', S3_KEY_EVENING);
}

/** 送信フェーズ: 夕刊 */
async function runEveningSendPhase(traceId: string): Promise<void> {
  return runSendPhaseFor(traceId, 'evening', S3_KEY_EVENING);
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
    } else if (phase === 'evening-collect') {
      await runEveningCollectPhase(traceId);
    } else if (phase === 'evening-send') {
      await runEveningSendPhase(traceId);
    } else {
      await runFullPhase(traceId);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ type: 'HANDLER_ERROR', traceId, phase, error }));
    throw err;
  }
};
