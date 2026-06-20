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

/** 集約フェーズの採用スコア閾値。これ以上の fetch 記事を全件掲載する */
const SCORE_THRESHOLD = 4;
/** 1トピックあたりの掲載上限（暴発防止の安全弁。通常は到達しない） */
const MAX_ITEMS_PER_TOPIC = 8;

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
      const staticUrls = (topic.urls ?? []).map((url) => ({
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
      max_tokens: 8192,
      system:
        'あなたはニュース編集者です。収集した情報をトピックごとに整理し、各記事へ重要度スコアを付けて出力してください。',
      output_config: { format: buildSummaryFormat(input.config.topics) },
      messages: [
        {
          role: 'user',
          content: `今日は ${dateStr} です。以下の各URLから収集した内容をもとに、設定された全トピック（${input.config.topics
            .map((t) => t.id)
            .join(
              ', '
            )}）それぞれについて、収集データ内の候補記事を網羅的に列挙し、各記事に重要度スコア（1-5）を付与してください。件数を自分で絞り込まないでください（掲載可否は後段で機械的に判定します）。
- スコア基準: 5=一次情報の重大発表 / 4=注目に値する進展 / 3=通常ニュース / 2=軽微 / 1=無関係寄り。
- 古い記事（2日以上前と明示されているもの）は含めないでください。日付が不明な記事は最新として扱ってください。
- 各トピックのキーには、そのトピックの収集データに実在する記事のみを入れてください（記事を創作しないこと）。該当記事が無いトピックのみ空配列にしてください。
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
        // structured outputs によりスキーマ準拠のJSON（トピックID別オブジェクト）が保証される
        const parsed = JSON.parse(textBlock.text) as Record<string, SummaryItem[]>;
        let rescued = 0;
        for (const topic of input.config.topics) {
          const raw = (parsed[topic.id] ?? []).map((it) => ({
            ...it,
            topic: topic.id,
            origin: 'fetch' as const,
          }));
          // スコア閾値以上を全件採用。閾値超えが無いが候補はあるトピックは最高スコア1件を救済（空トピック=崩壊を防ぐ）
          let kept = raw.filter((i) => i.score >= SCORE_THRESHOLD);
          if (kept.length === 0 && raw.length > 0) {
            kept = [raw.reduce((a, b) => (b.score > a.score ? b : a))];
            rescued++;
          }
          kept.sort((a, b) => b.score - a.score);
          data.byTopic[topic.id] = kept.slice(0, MAX_ITEMS_PER_TOPIC);
        }
        const itemCount = Object.values(data.byTopic).flat().length;
        const topicCount = Object.values(data.byTopic).filter((v) => v.length > 0).length;
        console.log(
          `[WebAgent] parsed: ${topicCount} topics, ${itemCount} items (threshold>=${SCORE_THRESHOLD}, rescued ${rescued})`
        );
      } catch (err) {
        console.warn(`[WebAgent] Failed to parse summary response as JSON: ${(err as Error).message}`);
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
        content: `今日は ${dateStr} です。「${topic.label}」分野で、${dateStr} の数日以内に報じられた具体的なニュース記事を web 検索で最大3件見つけてください。日本語・英語どちらの記事でも構いません（この分野は英語が一次情報になりやすい）。

【検索方針】
- 固有名詞や出来事で具体的に検索してください（例:「○○社 発表 ${dateStr.slice(0, 7)}」「英語: 固有名詞 announcement ${dateStr}」）。一般語だけの検索は避ける。
- 一次情報（公式発表・公的機関の資料）・公共放送・報道機関の「個別記事」を優先し、論説・オピニオン記事は避けてください。

【URLの厳守事項（重要）】
- url には必ず「その記事1本そのものの個別ページURL」を入れてください。ニュース一覧・アグリゲーター・タグページ・サイトのトップ/カテゴリページのURLを記事URLとして使ってはいけません（例: .../news/ や .../ai/ で終わる一覧URLは不可）。
- 個別記事のURLが検索結果に無い記事は、内容が良くても選ばないでください。
- 出典URLは検索結果に実在するものをそのまま使い、推測・改変しないでください。${dateStr} に近い新しい記事を優先してください。${deliveredSection}

出力は必ず下記JSON「のみ」にしてください（前後に説明文・前置き・謝罪文を一切付けない）。条件を満たす個別記事が無い場合は items を空配列 [] にしてください（その場合も文章ではなくJSONを返す）:
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
    // web_search が実際に返した結果URL（citation照合の真実集合）。
    // Claude の出力JSONはこの集合に含まれるURLだけを残し、捏造URLを弾く。
    const resultUrls = new Set<string>();

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

      // 各レスポンス（pause_turn 中継分も含む）から web_search の実結果URLを集める
      for (const block of response.content) {
        if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
          for (const r of block.content) resultUrls.add(normalizeUrl(r.url));
        }
      }

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

    const parsedItems: WebItem[] = (parsed?.items ?? [])
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

    // citation照合ゲート: web_search が実際に返したURLに無い記事は捏造（ハルシネーション）
    // 疑いとして除外する。searchTopic はモデルが出力JSONを手書きするため実在検証が無く、
    // 存在しないarxiv ID等が混入しうる（例: 2026-06-19 JetFlow 2606.18394）。
    // 結果URLを1件も取得できなかった場合のみ、挙動維持のためゲートをスキップして警告する。
    let items: WebItem[];
    if (resultUrls.size === 0) {
      items = parsedItems;
      if (parsedItems.length > 0) {
        console.warn(
          `[WebAgent] searchTopic ${topic.id}: web_search結果URLを取得できずcitation照合をスキップ（${parsedItems.length}件を無検証で通過）`
        );
      }
    } else {
      items = parsedItems.filter((it) => resultUrls.has(normalizeUrl(it.url)));
      const dropped = parsedItems.filter((it) => !resultUrls.has(normalizeUrl(it.url)));
      if (dropped.length > 0) {
        console.warn(
          `[WebAgent] searchTopic ${topic.id}: citation照合で${dropped.length}件をハルシネーション疑いとして除外: ${dropped
            .map((d) => d.url)
            .join(', ')}`
        );
      }
    }

    console.log(
      `[WebAgent] searchTopic ${topic.id}: parsed ${parsedItems.length} → verified ${items.length} items from web_search`
    );
    return { items, inputTokens, outputTokens, webSearchRequests };
  }
}

/** 集約呼び出しの structured outputs 1件分（topic で byTopic にグループ化される） */
interface SummaryItem {
  url: string;
  title: string;
  summary: string;
  score: number;
}

/**
 * 集約呼び出し用の JSON スキーマ。トピックIDをキーに持つオブジェクトとし、
 * 全トピックを required にすることで「特定トピックだけ返す」崩壊を生成段階で構造的に防ぐ。
 * 該当記事が無いトピックは空配列を許容（記事の創作を避けるため minItems は課さない）。
 */
function buildSummaryFormat(topics: Topic[]): Anthropic.JSONOutputFormat {
  const itemSchema = {
    type: 'object',
    properties: {
      url: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string', description: '2〜3文の要約' },
      score: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    },
    required: ['url', 'title', 'summary', 'score'],
    additionalProperties: false,
  };
  const topicProps: Record<string, unknown> = {};
  for (const t of topics) {
    topicProps[t.id] = { type: 'array', items: itemSchema };
  }
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: topicProps,
      required: topics.map((t) => t.id),
      additionalProperties: false,
    },
  } as Anthropic.JSONOutputFormat;
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
