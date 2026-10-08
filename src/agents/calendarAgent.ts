import Anthropic from '@anthropic-ai/sdk';
import type { CalendarClient, CalendarEvent } from '../clients/calendarClient.js';
import { type Agent, type AgentInput, type AgentOutput } from './base.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';

const MODEL = 'claude-haiku-5-5';

export interface CalendarAgentData {
  events: CalendarEvent[];
  summary: string;
  tokensUsed: number;
}

export class CalendarAgent implements Agent {
  readonly id = 'calendar';
  private client: Anthropic;

  constructor(private calendarClient: CalendarClient) {
    this.client = new Anthropic();
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now();

    const events = await this.calendarClient.getTodayEvents(input.date);

    let summary = '今日の予定はありません。';
    let inputTokens = 0;
    let outputTokens = 0;

    if (events.length > 0) {
      const message = await this.client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        // Haiku 5.5 は既定で思考する（思考分も max_tokens に数える）。要約だけなので low に下げる
        output_config: { effort: 'low' },
        system:
          'あなたは朝のブリーフィングアシスタントです。簡潔・実用的な日本語で出力してください。',
        messages: [
          {
            role: 'user',
            content: `以下の今日の予定一覧をもとに、以下の形式でブリーフィングを作成してください。

予定一覧:
${JSON.stringify(events, null, 2)}

出力形式:
1. 今日の予定サマリー（1〜2文）
2. 注目イベント（あれば）
3. 準備が必要な事項（あれば）`,
          },
        ],
      });

      // 応答の先頭は thinking ブロックになりうるので、位置ではなく type で選ぶ
      summary = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      inputTokens = message.usage.input_tokens;
      outputTokens = message.usage.output_tokens;
    }

    const durationMs = Date.now() - startTime;
    const costUsd = calcCost({ input_tokens: inputTokens, output_tokens: outputTokens }, MODEL);

    logLlm({
      traceId: process.env.AWS_LAMBDA_REQUEST_ID ?? 'local',
      agentId: this.id,
      model: MODEL,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
      success: true,
    });

    const data: CalendarAgentData = {
      events,
      summary,
      tokensUsed: inputTokens + outputTokens,
    };

    return {
      agentId: this.id,
      data,
      tokensUsed: inputTokens + outputTokens,
      durationMs,
    };
  }
}
