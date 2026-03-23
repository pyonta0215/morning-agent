import type { Context } from 'aws-lambda';
import { loadConfig, setTraceId } from './config/settings.js';
import { SesClient } from './clients/sesClient.js';
import { Pipeline } from './orchestrator/pipeline.js';
import { WebAgent } from './agents/webAgent.js';
import { ComposerAgent } from './agents/composerAgent.js';
import type { AgentInput } from './agents/base.js';

export const handler = async (event: unknown, context?: Context): Promise<void> => {
  const traceId = context?.awsRequestId ?? 'local';
  setTraceId(traceId);

  console.log(JSON.stringify({ type: 'HANDLER_START', traceId, event }));

  try {
    const config = await loadConfig();
    const sesClient = new SesClient(config.awsRegion);
    const dryRun = process.env.DRY_RUN === 'true';

    const pipeline = new Pipeline();
    pipeline.register(new WebAgent(), 'collect');
    pipeline.register(new ComposerAgent(sesClient, config, dryRun), 'compose');

    const input: AgentInput = {
      date: new Date(),
      config,
    };

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
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ type: 'HANDLER_ERROR', traceId, error }));
    throw err;
  }
};
