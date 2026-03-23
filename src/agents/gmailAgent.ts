import Anthropic from '@anthropic-ai/sdk';
import type { GmailClient, GmailMessage } from '../clients/gmailClient.js';
import { type Agent, type AgentInput, type AgentOutput } from './base.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';

const MODEL = 'claude-sonnet-4-20250514';

export interface ClassifiedMessage {
  message: GmailMessage;
  reason: string;
}

export interface GmailAgentData {
  replyNeeded: ClassifiedMessage[];
  fyi: ClassifiedMessage[];
  skip: GmailMessage[];
}

interface ClassificationResult {
  replyNeeded: Array<{ id: string; reason: string }>;
  fyi: Array<{ id: string; reason: string }>;
  skip: string[];
}

export class GmailAgent implements Agent {
  readonly id = 'gmail';
  private client: Anthropic;

  constructor(private gmailClient: GmailClient) {
    this.client = new Anthropic();
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now();

    const messages = await this.gmailClient.getRecentUnread(24);

    if (messages.length === 0) {
      return {
        agentId: this.id,
        data: { replyNeeded: [], fyi: [], skip: [] } satisfies GmailAgentData,
        tokensUsed: 0,
        durationMs: Date.now() - startTime,
      };
    }

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system:
        'あなたはメール管理アシスタントです。メールを分析して重要度と対応要否を判断してください。出力は必ずJSON形式で返してください。',
      messages: [
        {
          role: 'user',
          content: `以下のメール一覧を3つのカテゴリに分類してください。

メール一覧:
${JSON.stringify(
  messages.map((m) => ({ id: m.id, from: m.from, subject: m.subject, snippet: m.snippet })),
  null,
  2
)}

分類カテゴリ:
- REPLY_NEEDED: 返信が必要と判断されるメール
- FYI: 読むべきだが返信不要
- SKIP: ニュースレター・自動通知等

各カテゴリのメールIDと理由（1行）をJSON形式で出力してください:
{
  "replyNeeded": [{"id": "...", "reason": "..."}],
  "fyi": [{"id": "...", "reason": "..."}],
  "skip": ["id1", "id2"]
}`,
        },
      ],
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
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

    let classification: ClassificationResult = { replyNeeded: [], fyi: [], skip: [] };
    if (response.content[0].type === 'text') {
      try {
        const text = response.content[0].text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          classification = JSON.parse(jsonMatch[0]) as ClassificationResult;
        }
      } catch {
        console.warn('[GmailAgent] Failed to parse Claude response as JSON');
      }
    }

    const messageMap = new Map(messages.map((m) => [m.id, m]));

    const data: GmailAgentData = {
      replyNeeded: (classification.replyNeeded ?? [])
        .filter((item) => messageMap.has(item.id))
        .map((item) => ({ message: messageMap.get(item.id)!, reason: item.reason })),
      fyi: (classification.fyi ?? [])
        .filter((item) => messageMap.has(item.id))
        .map((item) => ({ message: messageMap.get(item.id)!, reason: item.reason })),
      skip: (classification.skip ?? [])
        .filter((id) => messageMap.has(id))
        .map((id) => messageMap.get(id)!),
    };

    return {
      agentId: this.id,
      data,
      tokensUsed: inputTokens + outputTokens,
      durationMs,
    };
  }
}
