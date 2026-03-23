import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources/messages.js';
import { type Agent, type AgentInput, type AgentOutput } from './base.js';
import { webFetchToolDefinition, handleWebFetch } from '../tools/webFetchTool.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';

const MODEL = 'claude-sonnet-4-20250514';

export interface WebItem {
  url: string;
  title: string;
  summary: string;
  score: number;
  topic: string;
}

export interface WebAgentData {
  byTopic: Record<string, WebItem[]>;
}

export class WebAgent implements Agent {
  readonly id = 'web';
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic();
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now();

    const allUrls = input.config.topics.flatMap((topic) =>
      topic.urls.map((url) => ({ url, topicId: topic.id, topicLabel: topic.label }))
    );

    const urlList = allUrls.map((u) => `- ${u.url} (トピック: ${u.topicLabel})`).join('\n');

    const messages: MessageParam[] = [
      {
        role: 'user',
        content: `以下のURLからWebページを収集し、重要なニュースや情報をトピック別にまとめてください。

収集するURL一覧:
${urlList}

各URLについてfetch_webpageツールを使って内容を取得してください。`,
      },
    ];

    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // tool_use ループ
    while (true) {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 4096,
        tools: [webFetchToolDefinition],
        messages,
      });

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;

      if (response.stop_reason !== 'tool_use') {
        // 収集完了 → 結果をメッセージに追加して集約を依頼
        messages.push({ role: 'assistant', content: response.content });
        break;
      }

      // ツール呼び出し処理
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        if (block.name === 'fetch_webpage') {
          const fetchInput = block.input as { url: string; maxLength?: number };
          const result = await handleWebFetch(fetchInput);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // 集約: JSON形式でWebItemを出力させる
    const summaryResponse = await this.client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system:
        'あなたはニュース編集者です。収集した情報を重要度でフィルタリングし、JSON形式で出力してください。',
      messages: [
        ...messages,
        {
          role: 'user',
          content: `収集した情報をもとに、テーマ別に重要度スコア（1-5）付きで3〜5件に絞り込んでください。

出力形式（JSON）:
{
  "byTopic": {
    "トピックID": [
      {
        "url": "https://...",
        "title": "記事タイトル",
        "summary": "2〜3文の要約",
        "score": 5,
        "topic": "トピックID"
      }
    ]
  }
}`,
        },
      ],
    });

    totalInputTokens += summaryResponse.usage.input_tokens;
    totalOutputTokens += summaryResponse.usage.output_tokens;

    const durationMs = Date.now() - startTime;
    const costUsd = calcCost(
      { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      MODEL
    );

    logLlm({
      traceId: process.env.AWS_LAMBDA_REQUEST_ID ?? 'local',
      agentId: this.id,
      model: MODEL,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd,
      durationMs,
      success: true,
    });

    let data: WebAgentData = { byTopic: {} };
    const textBlock = summaryResponse.content.find((c) => c.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      try {
        const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          data = JSON.parse(jsonMatch[0]) as WebAgentData;
        } else {
          console.warn('[WebAgent] No JSON found in summary response');
        }
      } catch {
        console.warn('[WebAgent] Failed to parse summary response as JSON');
      }
    }

    return {
      agentId: this.id,
      data,
      tokensUsed: totalInputTokens + totalOutputTokens,
      durationMs,
    };
  }
}
