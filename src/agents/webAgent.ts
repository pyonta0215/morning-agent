import Anthropic from '@anthropic-ai/sdk';
import { type Agent, type AgentInput, type AgentOutput, type Topic } from './base.js';
import { handleWebFetch } from '../tools/webFetchTool.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';
import { normalizeUrl, type DeliveredItem } from '../utils/deliveredHistory.js';

const MODEL = 'claude-haiku-4-5-20251001';

/** プロンプトに載せる配信済みタイトルの上限（トークン抑制） */
const DELIVERED_TITLES_MAX = 20;
/** 配信済みタイトルをプロンプトに載せる対象期間（日） */
const DELIVERED_TITLES_DAYS = 7;

/** web_search の1トピックあたりの最大検索回数（コスト上限の主レバー。$0.01/検索） */
const WEB_SEARCH_MAX_USES_DEFAULT = 1;

export interface WebItem {
  url: string;
  title: string;
  summary: string;
  score: number;
  topic: string;
  /** 記事の取得経路（web_search寄与の計測用）。旧データには無い */
  origin?: 'fetch' | 'web_search';
}

export interface WebAgentData {
  byTopic: Record<string, WebItem[]>;
  /** 収集ソースの生データ（実行アーカイブ用。composer は参照しない） */
  sources?: Array<{ topicId: string; topicLabel: string; url: string; content: string }>;
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

    const delivered = input.delivered ?? [];
    const deliveredUrls = new Set(delivered.map((d) => normalizeUrl(d.url)));
    const recentDeliveredTitles = pickRecentDeliveredTitles(delivered, dateStr);

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
    // RSSは日付（2日以内）と配信済みURLをコード側でフィルタして入力トークンを削減
    const fetchResults = await Promise.all(
      allUrls.map(async (u) => {
        const result = await handleWebFetch({
          url: u.url,
          maxLength: 2000,
          sinceDate: twoDaysAgo,
          excludeUrls: deliveredUrls,
        });
        return { ...u, content: result.text ?? result.error ?? '（取得失敗）' };
      })
    );

    const fetchedContent = fetchResults
      .map((r) => `=== [トピックID: ${r.topicId}] ${r.topicLabel} (${r.url}) ===\n${r.content}`)
      .join('\n\n');

    const deliveredSection =
      recentDeliveredTitles.length > 0
        ? `
【既に配信済みの記事（直近${DELIVERED_TITLES_DAYS}日）】
${recentDeliveredTitles.map((t) => `・${t}`).join('\n')}
上記と同一または実質同内容（同じ発表・同じ製品を扱う記事など）は選ばないでください。重要な進展がある場合のみ、タイトルの先頭に「続報：」を付けて選んでください。
`
        : '';

    // 集約: structured outputs でスキーマを強制（1回のみ）
    const summaryResponse = await this.client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'あなたはニュース編集者です。収集した情報を重要度でフィルタリングして出力してください。',
      output_config: { format: buildSummaryFormat(input.config.topics) },
      messages: [
        {
          role: 'user',
          content: `今日は ${dateStr} です。以下の各URLから収集した内容をもとに、トピックごとに重要度スコア（1-5）付きで3〜5件に絞り込んでください。
- 古い記事（2日以上前と明示されているもの）は含めないでください。日付が不明な記事は最新として扱ってください。
- 各記事の topic には収集データのヘッダーに記載されたトピックIDを使ってください。
${deliveredSection}
収集データ:
${fetchedContent}`,
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

    const data: WebAgentData = {
      byTopic: {},
      sources: fetchResults.map((r) => ({
        topicId: r.topicId,
        topicLabel: r.topicLabel,
        url: r.url,
        content: r.content,
      })),
    };
    const textBlock = summaryResponse.content.find((c) => c.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      try {
        // structured outputs によりスキーマ準拠のJSONが保証される
        const parsed = JSON.parse(textBlock.text) as { items: SummaryItem[] };
        for (const item of parsed.items) {
          (data.byTopic[item.topic] ??= []).push({ ...item, origin: 'fetch' });
        }
        const topicCount = Object.keys(data.byTopic).length;
        console.log(`[WebAgent] parsed: ${topicCount} topics, ${parsed.items.length} items`);
      } catch {
        console.warn('[WebAgent] Failed to parse summary response as JSON');
        console.log('[WebAgent] summary raw response:\n', textBlock.text);
      }
    } else {
      console.warn('[WebAgent] No text block in summary response');
    }

    // web_search 補強フェーズ（ENABLE_WEB_SEARCH=true のとき、webSearch:true のトピックのみ）
    let webSearchTokens = 0;
    if (process.env.ENABLE_WEB_SEARCH === 'true') {
      const r = await this.augmentWithWebSearch(
        input.config.topics,
        dateStr,
        data,
        startTime,
        delivered
      );
      webSearchTokens = r.inputTokens + r.outputTokens;
    }

    // 最終セーフティネット: 配信済みURLが紛れ込んでいたら除去（続報は新URLなので残る）
    for (const [topicId, items] of Object.entries(data.byTopic)) {
      const filtered = items.filter((i) => !deliveredUrls.has(normalizeUrl(i.url)));
      if (filtered.length !== items.length) {
        console.log(
          `[WebAgent] dropped ${items.length - filtered.length} already-delivered items from ${topicId}`
        );
      }
      data.byTopic[topicId] = filtered;
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
    startTime: number,
    delivered: DeliveredItem[]
  ): Promise<{ inputTokens: number; outputTokens: number }> {
    const searchTopics = topics.filter((t) => t.webSearch);
    if (searchTopics.length === 0) return { inputTokens: 0, outputTokens: 0 };

    const results = await Promise.all(
      searchTopics.map((t) =>
        this.searchTopic(
          t,
          dateStr,
          pickRecentDeliveredTitles(delivered, dateStr, t.id)
        )
      )
    );

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
    dateStr: string,
    deliveredTitles: string[] = []
  ): Promise<{
    items: WebItem[];
    inputTokens: number;
    outputTokens: number;
    webSearchRequests: number;
  }> {
    const maxUses = Number(process.env.WEB_SEARCH_MAX_USES ?? WEB_SEARCH_MAX_USES_DEFAULT);

    const deliveredSection =
      deliveredTitles.length > 0
        ? `
- 以下は既に配信済みのため、同一または実質同内容の記事は選ばないでください（重要な進展がある場合のみ「続報：」を冠して選出可）:
${deliveredTitles.map((t) => `  ・${t}`).join('\n')}`
        : '';

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `今日は ${dateStr} です。「${topic.label}」に関する直近の重要なニュースを web 検索し、特に注目すべき記事を最大3件選んでください。

【方針】
- 一次情報（公式発表・公的機関の資料）や公共放送を優先し、論説・オピニオン記事は避けてください。
- 出典URLは実在する検索結果のものを使ってください。
- ${dateStr} に近い最新の記事を優先してください。${deliveredSection}

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
        origin: 'web_search' as const,
      }));

    console.log(`[WebAgent] searchTopic ${topic.id}: parsed ${items.length} items from web_search`);
    return { items, inputTokens, outputTokens, webSearchRequests };
  }
}

/** 集約呼び出しの structured outputs 1件分（topic で byTopic にグループ化される） */
interface SummaryItem {
  topic: string;
  url: string;
  title: string;
  summary: string;
  score: number;
}

/** 集約呼び出し用の JSON スキーマ。topic は設定済みトピックIDに限定する */
function buildSummaryFormat(topics: Topic[]): Anthropic.JSONOutputFormat {
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              topic: { type: 'string', enum: topics.map((t) => t.id) },
              url: { type: 'string' },
              title: { type: 'string' },
              summary: { type: 'string', description: '2〜3文の要約' },
              score: { type: 'integer', enum: [1, 2, 3, 4, 5] },
            },
            required: ['topic', 'url', 'title', 'summary', 'score'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  };
}

/**
 * プロンプトに載せる配信済みタイトルを返す。
 * 直近 DELIVERED_TITLES_DAYS 日・最大 DELIVERED_TITLES_MAX 件（topicId 指定時はそのトピックのみ）。
 */
function pickRecentDeliveredTitles(
  delivered: DeliveredItem[],
  todayIso: string,
  topicId?: string
): string[] {
  const cutoff = new Date(`${todayIso}T00:00:00+09:00`);
  cutoff.setDate(cutoff.getDate() - DELIVERED_TITLES_DAYS);
  const cutoffIso = cutoff.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

  return delivered
    .filter((d) => d.isoDate >= cutoffIso && (!topicId || d.topic === topicId))
    .sort((a, b) => (a.isoDate < b.isoDate ? 1 : -1))
    .slice(0, DELIVERED_TITLES_MAX)
    .map((d) => d.title);
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
