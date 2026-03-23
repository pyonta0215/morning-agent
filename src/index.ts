import type { Context } from 'aws-lambda';
import { loadConfig, setTraceId } from './config/settings.js';
import { createOAuth2Client } from './clients/googleAuth.js';
import { CalendarClient } from './clients/calendarClient.js';
import { GmailClient } from './clients/gmailClient.js';
import { SesClient } from './clients/sesClient.js';
import { Pipeline } from './orchestrator/pipeline.js';
import { CalendarAgent } from './agents/calendarAgent.js';
import { GmailAgent } from './agents/gmailAgent.js';
import { WebAgent } from './agents/webAgent.js';
import { ComposerAgent } from './agents/composerAgent.js';
import type { AgentInput } from './agents/base.js';

export const handler = async (event: unknown, context?: Context): Promise<void> => {
  const traceId = context?.awsRequestId ?? 'local';
  setTraceId(traceId);

  console.log(JSON.stringify({ type: 'HANDLER_START', traceId, event }));

  try {
    const config = await loadConfig();

    const auth = createOAuth2Client({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      refreshToken: config.googleRefreshToken,
    });

    const calendarClient = new CalendarClient(auth);
    const gmailClient = new GmailClient(auth);
    const sesClient = new SesClient(config.awsRegion);

    const dryRun = process.env.DRY_RUN === 'true';
    const agentFilter = process.env.AGENT_FILTER;

    const pipeline = new Pipeline();

    if (!agentFilter || agentFilter === 'calendar') {
      pipeline.register(new CalendarAgent(calendarClient), 'collect');
    }
    if (!agentFilter || agentFilter === 'gmail') {
      pipeline.register(new GmailAgent(gmailClient), 'collect');
    }
    if (!agentFilter || agentFilter === 'web') {
      pipeline.register(new WebAgent(), 'collect');
    }
    if (!agentFilter) {
      pipeline.register(new ComposerAgent(sesClient, config, dryRun), 'compose');
    }

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
