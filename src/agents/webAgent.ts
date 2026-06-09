import Anthropic from '@anthropic-ai/sdk';
import { type Agent, type AgentInput, type AgentOutput, type Topic } from './base.js';
import { handleWebFetch } from '../tools/webFetchTool.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';

const MODEL = 'claude-haiku-4-5-20251001';

/** web_search の1トピックあたりの最大検索回数（コスト上限の主レバー。$0.01/検索） */
const WEB_SEARCH_MAX_USES_DEFAULT = 1;

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

    // web_search 補強フェーズ（ENABLE_WEB_SEARCH=true のとき、webSearch:true のトピックのみ）
    let webSearchTokens = 0;
    if (process.env.ENABLE_WEB_SEARCH === 'true') {
      const r = await this.augmentWithWebSearch(input.config.topics, dateStr, data, startTime);
      webSearchTokens = r.inputTokens + r.outputTokens;
    }

    return {
      agentId: this.id,
      data,
      tokensUsed: inputTokens + outputTokens + webSearchTokens,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * webSearch:true のトピックを web_search ツールで補強し、結果を data.byTopic にマージする。
   * 既存の一次情報フェッチ結果は温存し、その上に鮮度レイヤーを重ねる。
   */
  private async augmentWithWebSearch(
    topics: Topic[],
    dateStr: string,
    data: WebAgentData,
    startTime: number
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    const searchTopics = topics.filter((t) => t.webSearch);
    if (searchTopics.length === 0) return { inputTokens: 0, outputTokens: 0 };

    const results = await Promise.all(searchTopics.map((t) => this.searchTopic(t, dateStr)));

    let totalInput = 0;
    let totalOutput = 0;
    let totalRequests = 0;

    searchTopics.forEach((t, idx) => {
      const res = results[idx];
      totalInput += res.inputTokens;
      totalOutput += res.outputTokens;
      totalRequests += res.webSearchRequests;

      // byTopic にマージ（同一URLの重複は除去）
      const existing = data.byTopic[t.id] ?? [];
      const seen = new Set(existing.map((i) => i.url));
      for (const item of res.items) {
        if (!seen.has(item.url)) {
          existing.push(item);
          seen.add(item.url);
        }
      }
      data.byTopic[t.id] = existing;
      console.log(
        `[WebAgent] web_search ${t.id}: +${res.items.length} items, ${res.webSearchRequests} searches`
      );
    });

    logLlm({
      traceId: process.env.AWS_LAMBDA_REQUEST_ID ?? 'local',
      agentId: this.id,
      model: MODEL,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      costUsd: calcCost(
        { input_tokens: totalInput, output_tokens: totalOutput },
        MODEL,
        totalRequests
      ),
      durationMs: Date.now() - startTime,
      success: true,
      webSearchRequests: totalRequests,
    });

    return { inputTokens: totalInput, outputTokens: totalOutput };
  }

  /** 1トピックを web_search で検索し、WebItem[] に正規化して返す。 */
  private async searchTopic(
    topic: Topic,
    dateStr: string
  ): Promise<{
    items: WebItem[];
    inputTokens: number;
    outputTokens: number;
    webSearchRequests: number;
  }> {
    const maxUses = Number(process.env.WEB_SEARCH_MAX_USES ?? WEB_SEARCH_MAX_USES_DEFAULT);

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `今日は ${dateStr} です。「${topic.label}」に関する直近の重要なニュースを web 検索し、特に注目すべき記事を最大3件選んでください。

【方針】
- 一次情報（公式発表・公的機関の資料）や公共放送を優先し、論説・オピニオン記事は避けてください。
- 出典URLは実在する検索結果のものを使ってください。
- ${dateStr} に近い最新の記事を優先してください。

出力は次のJSONのみ（前後に説明文を付けない）:
{
  "items": [
    { "url": "https://...", "title": "記事タイトル", "summary": "2〜3文の要約", "score": 5 }
  ]
}`,
      },
    ];

    let inputTokens = 0;
    let outputTokens = 0;
    let webSearchRequests = 0;
    let finalText = '';

    // server-side ツールループは pause_turn で中断しうるため再送して継続する
    const maxContinuations = 3;
    for (let i = 0; i <= maxContinuations; i++) {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: 2048,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: maxUses,
            // blocked_domains はプロンプトの中立性指示に委ね空。特定ソース除外が必要ならここに列挙。
          },
        ],
        messages,
      });

      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
      webSearchRequests += response.usage.server_tool_use?.web_search_requests ?? 0;

      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      finalText = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      break;
    }

    const parsed = extractJson<{
      items?: Array<{ url?: string; title?: string; summary?: string; score?: number }>;
    }>(finalText);

    const items: WebItem[] = (parsed?.items ?? [])
      .filter((it): it is { url: string; title: string; summary?: string; score?: number } =>
        Boolean(it?.url && it?.title)
      )
      .map((it) => ({
        url: it.url,
        title: it.title,
        summary: it.summary ?? '',
        score: typeof it.score === 'number' ? it.score : 3,
        topic: topic.id,
      }));

    console.log(`[WebAgent] searchTopic ${topic.id}: parsed ${items.length} items from web_search`);
    return { items, inputTokens, outputTokens, webSearchRequests };
  }
}

/** マークダウンコードブロックまたは生テキストから最初のJSONオブジェクトを抽出する。 */
function extractJson<T>(text: string): T | null {
  try {
    const m =
      text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ?? text.match(/(\{[\s\S]*\})/);
    if (!m) return null;
    return JSON.parse(m[1] ?? m[0]) as T;
  } catch {
    return null;
  }
}
