import type { Context } from 'aws-lambda';
import Anthropic from '@anthropic-ai/sdk';
import { S3Client } from '@aws-sdk/client-s3';
import { loadConfig, setTraceId } from './config/settings.js';
import { SesClient } from './clients/sesClient.js';
import { Pipeline } from './orchestrator/pipeline.js';
import { WebAgent } from './agents/webAgent.js';
import type { WebAgentData, WebItem } from './agents/webAgent.js';
import { ComposerAgent, formatDateJST } from './agents/composerAgent.js';
import type { AgentInput, AgentOutput } from './agents/base.js';
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
import {
  saveRunArchive,
  loadRunArchive,
  loadRunArchiveFor,
  listRunArchiveKeys,
  updateRunArchivePicks,
  type RunArchive,
} from './utils/runArchive.js';
import { buildSiteFiles } from './site/siteData.js';
import { getSiteS3Client, publishSiteFiles } from './site/publish.js';
import { loadStoryLedger, saveStoryLedger } from './utils/storyStore.js';
import { articleId } from './utils/storyLedger.js';
import { assignArticlesToStories, type AssignableArticle } from './agents/storyAgent.js';
import { catchAllWarnings } from './utils/storyMetrics.js';

function getS3Client(region: string): S3Client {
  return new S3Client({ region });
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

/**
 * 収集フェーズ。**メールのことを知らない。**
 *
 * ニュースを集めて、アーカイブと台帳と配信済み履歴を更新するところまで。
 * メールの文面生成（LLM）は notify フェーズに移した。分けていないと
 * 「メールの見た目を直したいだけなのに収集をやり直す」が日常化するため。
 *
 * 3つの出力の重要度は同じではない:
 *   archive/  失うとWeb上から消えて復元できない
 *   stories/  LLMの判断が入るので archive からも再生成できない
 *   delivered/ 14日で回るので落ちても自然に回復する
 * 台帳の更新だけは失敗しても収集を巻き戻さず、復旧手順をログに出す（updateStoryLedger）。
 */
async function runCollectPhaseFor(traceId: string, edition: 'morning' | 'evening'): Promise<void> {
  const config = await loadConfig();
  const bucket = process.env.STORAGE_BUCKET ?? '';
  if (!bucket) throw new Error('[index] STORAGE_BUCKET env var is not set');

  const s3 = getS3Client(config.awsRegion);
  const todayIso = getJSTIsoDate(new Date());

  // 配信済み記事履歴（重複掲載の抑制に使用）
  const deliveredHistory = await loadDeliveredHistory(s3, bucket);

  const pipeline = new Pipeline();
  pipeline.register(new WebAgent(), 'collect');

  const input: AgentInput = { date: new Date(), config, delivered: deliveredHistory };
  const results = await pipeline.run(input);

  const webData = results.find((r) => r.agentId === 'web')?.data as WebAgentData | undefined;
  if (!webData) throw new Error('[index] WebAgent did not return data');

  // 実行アーカイブ。picks は notify フェーズで決まるのであとから書き足す
  await saveRunArchive(s3, bucket, {
    isoDate: todayIso,
    edition,
    topics: config.topics.map((t) => ({ id: t.id, label: t.label, keywords: t.keywords })),
    sources: webData.sources ?? [],
    byTopic: webData.byTopic,
    picks: [],
    usage: results.map((r) => ({
      agentId: r.agentId,
      tokensUsed: r.tokensUsed,
      durationMs: r.durationMs,
    })),
  });

  // ストーリー台帳を更新する（蓄積の本体。紙面・メール・概観はすべてここから作る）
  await updateStoryLedger(s3, bucket, config.topics, webData.byTopic, todayIso);

  // 本日掲載分を配信済み履歴に追加（保持期間外は削除）
  const newItems: DeliveredItem[] = Object.entries(webData.byTopic).flatMap(([topic, items]) =>
    items.map((i) => ({ url: i.url, title: i.title, topic, isoDate: todayIso }))
  );
  await saveDeliveredHistory(
    s3,
    bucket,
    updateDeliveredHistory(deliveredHistory, newItems, todayIso)
  );

  console.log(
    JSON.stringify({
      type: 'COLLECT_PHASE_SUCCESS',
      traceId,
      edition,
      isoDate: todayIso,
      items: Object.values(webData.byTopic).flat().length,
      agentResults: results.map((r) => ({
        agentId: r.agentId,
        tokensUsed: r.tokensUsed,
        durationMs: r.durationMs,
        error: r.error,
      })),
    })
  );
}

/**
 * 紙面生成フェーズ。**メールのことを知らない。**
 *
 * アーカイブと台帳だけを入力に、閲覧サイトのファイルを決定的に組み立てて置く。
 * LLMは呼ばない。落ちてもメールは出るし、翌日の実行で作り直される。
 */
async function runPublishPhase(traceId: string): Promise<void> {
  const config = await loadConfig();
  const bucket = process.env.STORAGE_BUCKET ?? '';
  if (!bucket) throw new Error('[index] STORAGE_BUCKET env var is not set');

  const siteBucket = process.env.SITE_BUCKET ?? '';
  if (!siteBucket) {
    console.log(JSON.stringify({ type: 'PUBLISH_PHASE_SKIPPED', reason: 'SITE_BUCKET 未設定' }));
    return;
  }

  const s3 = getS3Client(config.awsRegion);
  const ledger = await loadStoryLedger(s3, bucket);
  const keys = await listRunArchiveKeys(s3, bucket);
  const loaded = await Promise.all(keys.map((k) => loadRunArchive(s3, bucket, k)));
  const archives = loaded.filter((a): a is RunArchive => a !== null);

  const files = buildSiteFiles(
    archives,
    ledger,
    config.topics.map((t) => ({ id: t.id, label: t.label })),
    new Date().toISOString()
  );

  if (process.env.DRY_RUN === 'true') {
    console.log(
      JSON.stringify({
        type: 'PUBLISH_PHASE_DRY_RUN',
        traceId,
        files: files.map((f) => ({ key: f.key, bytes: Buffer.byteLength(f.body) })),
      })
    );
    return;
  }

  await publishSiteFiles(getSiteS3Client(), siteBucket, files);
  console.log(
    JSON.stringify({
      type: 'PUBLISH_PHASE_SUCCESS',
      traceId,
      archives: archives.length,
      stories: ledger.stories.length,
      files: files.length,
    })
  );
}

/**
 * 通知フェーズ。**蓄積を読むだけで、書かない。**
 *
 * その日のアーカイブから文面を作って送る。収集をやり直さずに文面だけ直せる。
 * アーカイブが無い日（収集が落ちた日）はエラー通知を送る。
 */
async function runNotifyPhaseFor(traceId: string, edition: 'morning' | 'evening'): Promise<void> {
  const config = await loadConfig();
  const bucket = process.env.STORAGE_BUCKET ?? '';
  if (!bucket) throw new Error('[index] STORAGE_BUCKET env var is not set');

  const sesClient = new SesClient(config.sesRegion);
  const dryRun = process.env.DRY_RUN === 'true';
  const s3 = getS3Client(config.awsRegion);
  const enhancedEditorial = process.env.ENHANCED_EDITORIAL === 'true';
  const editionLabel = edition === 'evening' ? '夕刊' : '朝刊';

  const now = new Date();
  const todayIso = getJSTIsoDate(now);
  const dateStr = formatDateJST(now);

  const archive = await loadRunArchiveFor(s3, bucket, todayIso, edition);
  if (!archive) {
    console.error(`[index] ${todayIso}-${edition} のアーカイブが無い。エラー通知を送る`);
    if (!dryRun) {
      await sesClient.sendEmail({
        from: config.senderEmail,
        to: config.recipientEmail,
        subject: `[${editionLabel}エージェント便] ${dateStr} 配信エラー`,
        htmlBody: `<p>本日（${dateStr}）の${editionLabel}エージェント便の収集に失敗しました。ログを確認してください。</p>`,
        textBody: `本日（${dateStr}）の${editionLabel}エージェント便の収集に失敗しました。ログを確認してください。`,
      });
    }
    console.log(JSON.stringify({ type: 'NOTIFY_PHASE_ERROR_NOTIFIED', traceId, edition, isoDate: todayIso }));
    return;
  }

  // 前回配信コンテキスト（ENHANCED_EDITORIAL=true 時）
  // 夕刊: 同日朝刊 / 朝刊: 前日夕刊（なければ前日朝刊）
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = getJSTIsoDate(yesterday);

  let previousContext = null;
  if (enhancedEditorial) {
    if (edition === 'evening') {
      previousContext = await loadEditorialContext(s3, bucket, 'morning', todayIso);
    } else {
      previousContext = await loadEditorialContext(s3, bucket, 'evening', yesterdayIso);
      if (!previousContext) {
        previousContext = await loadEditorialContext(s3, bucket, 'morning', yesterdayIso);
      }
    }
  }

  // ComposerAgent は WebAgent の出力を context 経由で受け取る。
  // 収集はもう終わっているので、アーカイブから同じ形を組み直して渡す
  const webOutput: AgentOutput = {
    agentId: 'web',
    data: { byTopic: archive.byTopic } satisfies WebAgentData,
    tokensUsed: 0,
    durationMs: 0,
  };

  const composer = new ComposerAgent(
    sesClient,
    config,
    dryRun,
    /* buildOnly */ true,
    edition,
    previousContext
  );
  const result = await composer.run({ date: now, config, context: [webOutput] });
  const data = result.data as {
    subject?: string;
    htmlBody?: string;
    textBody?: string;
    topicsCount?: number;
    picks?: Array<{ title: string; comment: string }>;
  };

  if (!data?.subject || !data?.htmlBody || !data?.textBody) {
    throw new Error('[index] ComposerAgent did not return expected email content');
  }

  if (!dryRun) {
    await sesClient.sendEmail({
      from: config.senderEmail,
      to: config.recipientEmail,
      subject: data.subject,
      htmlBody: data.htmlBody,
      textBody: data.textBody,
    });
    console.log(`[index] Email sent to ${config.recipientEmail}`);
  } else {
    console.log('[index] Dry run: skipping email send');
    console.log('Subject:', data.subject);
  }

  // picks はここで初めて決まるのでアーカイブに書き足す（sources と byTopic には触れない）
  if (data.picks && data.picks.length > 0) {
    try {
      await updateRunArchivePicks(s3, bucket, todayIso, edition, data.picks);
    } catch (err) {
      console.warn(`[index] failed to write picks back to archive: ${(err as Error).message}`);
    }
    if (enhancedEditorial) {
      const ctx = buildEditorialContext(edition, dateStr, todayIso, data.picks, archive.byTopic);
      await saveEditorialContext(s3, bucket, ctx);
    }
  }

  console.log(
    JSON.stringify({
      type: 'NOTIFY_PHASE_SUCCESS',
      traceId,
      edition,
      isoDate: todayIso,
      subject: data.subject,
      topicsCount: data.topicsCount,
      enhancedEditorial,
      hasPreviousContext: previousContext !== null,
      tokensUsed: result.tokensUsed,
    })
  );
}

/** ローカル開発用: 収集 → 紙面生成 → 通知 を一気に流す */
async function runFullPhase(traceId: string): Promise<void> {
  await runCollectPhaseFor(traceId, 'morning');
  await runPublishPhase(traceId);
  await runNotifyPhaseFor(traceId, 'morning');
  console.log(JSON.stringify({ type: 'HANDLER_SUCCESS', traceId }));
}

export const handler = async (event: unknown, context?: Context): Promise<void> => {
  const traceId = context?.awsRequestId ?? 'local';
  setTraceId(traceId);

  const phase = (event as Record<string, unknown>)?.phase as string | undefined;
  console.log(JSON.stringify({ type: 'HANDLER_START', traceId, phase, event }));

  try {
    switch (phase) {
      case 'collect':
        await runCollectPhaseFor(traceId, 'morning');
        break;
      case 'publish':
        await runPublishPhase(traceId);
        break;
      // 'send' は3フェーズ分離より前のスケジューラが送ってくる名前。
      // スケジューラとLambdaは同時にデプロイされるが、入れ替わりの瞬間に
      // 旧イベントが飛んでもメールが落ちないよう受け付けておく
      case 'notify':
      case 'send':
        await runNotifyPhaseFor(traceId, 'morning');
        break;
      case 'evening-collect':
        await runCollectPhaseFor(traceId, 'evening');
        break;
      case 'evening-notify':
      case 'evening-send':
        await runNotifyPhaseFor(traceId, 'evening');
        break;
      default:
        await runFullPhase(traceId);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ type: 'HANDLER_ERROR', traceId, phase, error }));
    throw err;
  }
};
