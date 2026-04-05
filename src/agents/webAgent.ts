import Anthropic from '@anthropic-ai/sdk';
import { type Agent, type AgentInput, type AgentOutput } from './base.js';
import { handleWebFetch } from '../tools/webFetchTool.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';

const MODEL = 'claude-haiku-4-5-20251001';

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
    const dateStr = input.date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD (JST)

    const yesterday = new Date(input.date);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const twoDaysAgo = new Date(input.date);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

    // 静的URLに加えて、各トピックのキーワードでGoogle News RSSを検索
    const allUrls = input.config.topics.flatMap((topic) => {
      const staticUrls = topic.urls.map((url) => ({
        url,
        topicId: topic.id,
        topicLabel: topic.label,
      }));

      if (topic.keywords.length === 0) {
        return staticUrls;
      }

      const query = encodeURIComponent(
        `${topic.keywords.join(' OR ')} after:${yesterdayStr}`
      );
      const newsSearchUrl = {
        url: `https://news.google.com/rss/search?q=${query}&hl=ja&gl=JP&ceid=JP:ja`,
        topicId: topic.id,
        topicLabel: `${topic.label}（本日のニュース検索）`,
      };

      return [...staticUrls, newsSearchUrl];
    });

    // LLMツールループを使わずにコードで並列フェッチ
    const fetchResults = await Promise.all(
      allUrls.map(async (u) => {
        const result = await handleWebFetch({ url: u.url, maxLength: 2000 });
        return { ...u, content: result.text ?? result.error ?? '（取得失敗）' };
      })
    );

    const fetchedContent = fetchResults
      .map((r) => `=== ${r.topicLabel} (${r.url}) ===\n${r.content}`)
      .join('\n\n');

    // 集約: JSON形式でWebItemを出力させる（1回のみ）
    const summaryResponse = await this.client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'あなたはニュース編集者です。収集した情報を重要度でフィルタリングし、JSON形式で出力してください。',
      messages: [
        {
          role: 'user',
          content: `今日は ${dateStr} です。以下の各URLから収集した内容をもとに、テーマ別に重要度スコア（1-5）付きで3〜5件に絞り込んでください。
【重要】${twoDaysAgoStr} より前に公開された記事は出力に含めないでください。日付が明示されていない記事は最新記事として扱ってください。

収集データ:
${fetchedContent}

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

    const inputTokens = summaryResponse.usage.input_tokens;
    const outputTokens = summaryResponse.usage.output_tokens;
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

    let data: WebAgentData = { byTopic: {} };
    const textBlock = summaryResponse.content.find((c) => c.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      console.log('[WebAgent] summary raw response:\n', textBlock.text);
      try {
        const jsonMatch =
          textBlock.text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ??
          textBlock.text.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          data = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as WebAgentData;
          const topicCount = Object.keys(data.byTopic).length;
          const itemCount = Object.values(data.byTopic).flat().length;
          console.log(`[WebAgent] parsed: ${topicCount} topics, ${itemCount} items`);
        } else {
          console.warn('[WebAgent] No JSON found in summary response');
        }
      } catch {
        console.warn('[WebAgent] Failed to parse summary response as JSON');
      }
    } else {
      console.warn('[WebAgent] No text block in summary response');
    }

    return {
      agentId: this.id,
      data,
      tokensUsed: inputTokens + outputTokens,
      durationMs,
    };
  }
}
