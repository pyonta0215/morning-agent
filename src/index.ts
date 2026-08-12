import type { Context } from 'aws-lambda';
import Anthropic from '@anthropic-ai/sdk';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { loadConfig, setTraceId } from './config/settings.js';
import { SesClient } from './clients/sesClient.js';
import { Pipeline } from './orchestrator/pipeline.js';
import { WebAgent } from './agents/webAgent.js';
import type { WebAgentData, WebItem } from './agents/webAgent.js';
import { ComposerAgent, formatDateJST } from './agents/composerAgent.js';
import type { AgentInput } from './agents/base.js';
import {
  saveEditorialContext,
  loadEditorialContext,
  buildEditorialContext,
  getJSTIsoDate,
} from './utils/editorialContext.js';
import {
  loadDeliveredHistory,
  saveDeliveredHistory,
  updateDeliveredHistory,
  type DeliveredItem,
} from './utils/deliveredHistory.js';
import { saveRunArchive } from './utils/runArchive.js';
import { loadStoryLedger, saveStoryLedger } from './utils/storyStore.js';
import { articleId } from './utils/storyLedger.js';
import { assignArticlesToStories, type AssignableArticle } from './agents/storyAgent.js';
import { catchAllWarnings } from './utils/storyMetrics.js';

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

/**
 * その日の記事をストーリー台帳に割り当てて保存する。
 *
 * 対象は topics.yaml で `story: true` のトピックだけ（判断根拠はyamlのコメント）。
 * 既定で有効。止めたいときだけ `STORY_LEDGER=false` を明示する
 * （`ENABLE_*` 方式にすると、デプロイでフラグが落ちて数日気づかない事故が実際に起きたため）。
 *
 * 失敗しても収集・配信は止めない。ただし**その日ぶんの割当は自動では戻らない**ので、
 * ログの `STORY_LEDGER_FAILED` を拾ったら archive から
 * `npx tsx scripts/backfill-stories.ts --from <日付> --to <日付>` で埋める。
 * archive は残っているので、遡って復旧できるのはここまで。
 */
async function updateStoryLedger(
  s3: S3Client,
  bucket: string,
  topics: Array<{ id: string; story?: boolean }>,
  byTopic: Record<string, WebItem[]>,
  todayIso: string
): Promise<void> {
  if (process.env.STORY_LEDGER === 'false') {
    console.log(JSON.stringify({ type: 'STORY_LEDGER_SKIPPED', reason: 'STORY_LEDGER=false' }));
    return;
  }

  const storyTopics = new Set(topics.filter((t) => t.story).map((t) => t.id));
  const articles: AssignableArticle[] = Object.entries(byTopic)
    .filter(([topic]) => storyTopics.has(topic))
    .flatMap(([topic, items]) =>
      items.map((i) => ({ id: articleId(i.url), title: i.title, summary: i.summary, topic }))
    );

  if (articles.length === 0) {
    console.log(JSON.stringify({ type: 'STORY_LEDGER_SKIPPED', reason: 'no articles', todayIso }));
    return;
  }

  try {
    const ledger = await loadStoryLedger(s3, bucket);
    const before = ledger.stories.length;
    const r = await assignArticlesToStories(new Anthropic(), ledger, todayIso, articles);
    await saveStoryLedger(s3, bucket, ledger);

    console.log(
      JSON.stringify({
        type: 'STORY_LEDGER_UPDATED',
        todayIso,
        articles: articles.length,
        assigned: r.assigned,
        created: r.created,
        rejectedCrossTopic: r.rejectedCrossTopic,
        mergedByTitle: r.mergedByTitle,
        candidatesBefore: r.candidatesBefore,
        candidatesAfter: r.candidatesAfter,
        storiesBefore: before,
        storiesAfter: ledger.stories.length,
        costUsd: r.costUsd,
      })
    );

    // 受け皿化は静かに進むので、越えた時点でログに出す（プロンプトを見直す合図）
    for (const w of catchAllWarnings(ledger)) {
      console.warn(
        JSON.stringify({
          type: 'STORY_CATCH_ALL_SUSPECTED',
          storyId: w.storyId,
          topic: w.topic,
          title: w.title,
          articleCount: w.articleCount,
          topicTotal: w.topicTotal,
          share: Number(w.share.toFixed(3)),
        })
      );
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        type: 'STORY_LEDGER_FAILED',
        todayIso,
        articles: articles.length,
        error: (err as Error).message,
        recovery: `npx tsx scripts/backfill-stories.ts --from ${todayIso} --to ${todayIso}`,
      })
    );
  }
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

  const now = new Date();
  const todayIso = getJSTIsoDate(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = getJSTIsoDate(yesterday);

  // 前回配信コンテキストを取得（ENHANCED_EDITORIAL=true 時）
  // 夕刊: 同日朝刊 / 朝刊: 前日夕刊（なければ前日朝刊）
  let previousContext = null;
  if (enhancedEditorial) {
    if (edition === 'evening') {
      previousContext = await loadEditorialContext(s3, bucket, 'morning', todayIso);
    } else {
      // 前日夕刊を優先、なければ前日朝刊
      previousContext = await loadEditorialContext(s3, bucket, 'evening', yesterdayIso);
      if (!previousContext) {
        previousContext = await loadEditorialContext(s3, bucket, 'morning', yesterdayIso);
      }
    }
  }

  // 配信済み記事履歴（重複掲載の抑制に使用）
  const deliveredHistory = await loadDeliveredHistory(s3, bucket);

  const pipeline = new Pipeline();
  pipeline.register(new WebAgent(), 'collect');
  pipeline.register(
    new ComposerAgent(sesClient, config, dryRun, /* buildOnly */ true, edition, previousContext),
    'compose'
  );

  const input: AgentInput = { date: new Date(), config, delivered: deliveredHistory };
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

  const webResult = results.find((r) => r.agentId === 'web');
  const webData = webResult?.data as WebAgentData | undefined;

  // 実行アーカイブを保存（評価ハーネスのゴールデンセット原料。失敗しても配信は止めない）
  if (webData) {
    try {
      await saveRunArchive(s3, bucket, {
        isoDate: todayIso,
        edition,
        topics: config.topics.map((t) => ({ id: t.id, label: t.label, keywords: t.keywords })),
        sources: webData.sources ?? [],
        byTopic: webData.byTopic,
        picks: data.picks ?? [],
        usage: results.map((r) => ({
          agentId: r.agentId,
          tokensUsed: r.tokensUsed,
          durationMs: r.durationMs,
        })),
      });
    } catch (err) {
      console.warn(`[index] failed to save run archive: ${(err as Error).message}`);
    }
  }

  // ストーリー台帳を更新する（蓄積の本体。紙面・メール・概観はすべてここから作る）
  if (webData) {
    await updateStoryLedger(s3, bucket, config.topics, webData.byTopic, todayIso);
  }

  // 本日掲載分を配信済み履歴に追加（保持期間外は削除）
  if (webData) {
    const newItems: DeliveredItem[] = Object.entries(webData.byTopic).flatMap(([topic, items]) =>
      items.map((i) => ({ url: i.url, title: i.title, topic, isoDate: todayIso }))
    );
    await saveDeliveredHistory(
      s3,
      bucket,
      updateDeliveredHistory(deliveredHistory, newItems, todayIso)
    );
  }

  // 編集コンテキストを保存（次の版で使用）
  if (enhancedEditorial && data.picks && data.picks.length > 0 && webData) {
    const ctx = buildEditorialContext(edition, dateStr, todayIso, data.picks, webData.byTopic);
    await saveEditorialContext(s3, bucket, ctx);
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
