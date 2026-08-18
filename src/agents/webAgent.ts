import Anthropic from '@anthropic-ai/sdk';
import { type Agent, type AgentInput, type AgentOutput, type Topic } from './base.js';
import { handleWebFetch, type RssItemMeta } from '../tools/webFetchTool.js';
import { collectResearch, formatResearchBlock, researchUrlSet } from '../tools/researchTool.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';
import { normalizeUrl, type DeliveredItem } from '../utils/deliveredHistory.js';
import { dedupeByNormalizedUrl } from '../utils/articleDedupe.js';

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
/**
 * 救済（閾値超えが無いトピックで最高スコア1件を拾う）の下限スコア。
 *
 * 救済はトピック崩壊（集約が特定トピックだけ返す）への保険であって、
 * 「無関係な記事でも1件は載せる」という意味ではない。スコア基準では
 * 1=無関係寄り / 2=軽微 なので、そこまで下がったら**載せないのが正しい**。
 *
 * この下限が要るのは、対象が狭い一次情報を足したときに効いてくるため。
 * 例: 欧州委のデジタル政策フィードにはAI以外（域内メディア支援・人材育成）も流れ、
 * e-Govのパブコメは全省庁の全案件が流れる。ヒットしない日のほうが多い情報源は、
 * 「鳴らない日は黙る」のでなければノイズ源にしかならない。
 */
const RESCUE_MIN_SCORE = 3;
/** web_search由来itemのスコア上限。fetch（>=SCORE_THRESHOLD）より必ず下に置き、
 *  二次ソースの鮮度補強が一次情報の見出しを押しのけて紙面先頭に立つのを防ぐ（demote）。 */
const WEB_SEARCH_SCORE_CAP = SCORE_THRESHOLD - 1;

export interface WebItem {
  url: string;
  title: string;
  summary: string;
  score: number;
  topic: string;
  /** 記事の取得経路（各経路の純寄与の計測用）。旧データには無い */
  origin?: 'fetch' | 'web_search' | 'research';
}

export interface WebAgentData {
  byTopic: Record<string, WebItem[]>;
  /** 収集ソースの生データ（実行アーカイブ用。composer は参照しない） */
  sources?: Array<{ topicId: string; topicLabel: string; url: string; content: string }>;
  /**
   * RSSから素通しで取れた情報（#1）。記事URLをキーにした対応表。
   * LLMの出力ではないので、集約で見出しが書き換わっても値は動かない
   */
  rssMeta?: Record<string, RssItemMeta>;
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

    // 外部研究ソース補強の対象トピック（ENABLE_RESEARCH_HUB=true かつ topics.yaml に research: があるもの）
    const researchTopics =
      process.env.ENABLE_RESEARCH_HUB === 'true'
        ? input.config.topics.filter((t) => t.research)
        : [];

    // LLMツールループを使わずにコードで並列フェッチ
    // RSSは日付（2日以内）と配信済みURLをコード側でフィルタして入力トークンを削減
    // 直fetchと研究ハブはどちらも外部I/O待ちなので同時に走らせる
    const [fetchResults, researchResults] = await Promise.all([
      Promise.all(
        allUrls.map(async (u) => {
          const result = await handleWebFetch({
            url: u.url,
            maxLength: 2000,
            sinceDate: twoDaysAgo,
            excludeUrls: deliveredUrls,
          });
          return {
            ...u,
            content: result.text ?? result.error ?? '（取得失敗）',
            rssItems: result.rssItems,
          };
        })
      ),
      Promise.all(
        researchTopics.map(async (topic) => ({
          topic,
          result: await collectResearch(topic, { excludeUrls: deliveredUrls }),
        }))
      ),
    ]);

    // 研究ハブの結果を、直fetchと同じ体裁の「収集ソース」に変換して集約フェーズへ渡す
    const researchSources = researchResults.map(({ topic, result }) => {
      console.log(
        `[WebAgent] research ${topic.id}: ${result.items.length} items ${JSON.stringify(result.stats)}` +
          (result.errors.length > 0 ? ` / errors: ${result.errors.join(' | ')}` : '')
      );
      return {
        topicId: topic.id,
        topicLabel: `${topic.label}（研究補強: HN/arXiv/GitHub/RSS/Hugging Face）`,
        url: `research-hub://${topic.id}`,
        content: formatResearchBlock(result.items),
      };
    });

    // 研究ハブが実際に返したURL集合。集約結果の取得経路タグ付けに使う
    const researchUrls = researchUrlSet(researchResults.flatMap((r) => r.result.items));
    // 直fetchが持ってきた生テキスト。両方に出ているURLは fetch 側の手柄として数え、
    // origin='research' を「研究ハブでしか拾えなかった記事」＝純寄与の意味に保つ
    const fetchOnlyContent = fetchResults.map((r) => r.content).join('\n');

    const allSources = [...fetchResults, ...researchSources];
    const fetchedContent = allSources
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

    // 集約で見出しが書き換わっても引けるよう、正規化URLをキーにする
    const rssMeta: Record<string, RssItemMeta> = {};
    for (const r of fetchResults) {
      for (const meta of r.rssItems ?? []) {
        if (meta.url) rssMeta[normalizeUrl(meta.url)] = meta;
      }
    }

    const data: WebAgentData = {
      byTopic: {},
      sources: allSources.map((r) => ({
        topicId: r.topicId,
        topicLabel: r.topicLabel,
        url: r.url,
        content: r.content,
      })),
      rssMeta,
    };
    const textBlock = summaryResponse.content.find((c) => c.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      try {
        // structured outputs によりスキーマ準拠のJSON（トピックID別オブジェクト）が保証される
        const parsed = JSON.parse(textBlock.text) as Record<string, SummaryItem[]>;
        let rescued = 0;
        let duplicateDropped = 0;
        // 救済の下限に届かず空のままにしたトピック数。ここが常に高いソースは足しても無駄
        let dropped = 0;
        for (const topic of input.config.topics) {
          // origin は「研究ハブが返したURLと一致し、かつ直fetchの取得テキストに存在しない」で判定する。
          // 研究ハブのURLはモデルの出力を経由せずコード側に残っているため実在が保証される
          const candidates = (parsed[topic.id] ?? []).map((it) => ({
            ...it,
            topic: topic.id,
            origin: (researchUrls.has(normalizeUrl(it.url)) && !fetchOnlyContent.includes(it.url)
              ? 'research'
              : 'fetch') as 'research' | 'fetch',
          }));
          // 集約モデルが同じ記事を複数回返しても、上限判定より前に1件へ畳む。
          // スコアが違う場合は高い方を残し、同点ならモデル出力の先頭を維持する。
          const raw = dedupeByNormalizedUrl(
            candidates,
            (candidate, current) => candidate.score > current.score
          );
          duplicateDropped += candidates.length - raw.length;
          // スコア閾値以上を全件採用。閾値超えが無いが候補はあるトピックは最高スコア1件を救済（空トピック=崩壊を防ぐ）
          let kept = raw.filter((i) => i.score >= SCORE_THRESHOLD);
          if (kept.length === 0 && raw.length > 0) {
            const best = raw.reduce((a, b) => (b.score > a.score ? b : a));
            if (best.score >= RESCUE_MIN_SCORE) {
              kept = [best];
              rescued++;
            } else {
              dropped++;
            }
          }
          kept.sort((a, b) => b.score - a.score);
          data.byTopic[topic.id] = kept.slice(0, topic.maxItems ?? MAX_ITEMS_PER_TOPIC);
        }
        const allItems = Object.values(data.byTopic).flat();
        const itemCount = allItems.length;
        const topicCount = Object.values(data.byTopic).filter((v) => v.length > 0).length;
        const researchCount = allItems.filter((i) => i.origin === 'research').length;
        console.log(
          `[WebAgent] parsed: ${topicCount} topics, ${itemCount} items (threshold>=${SCORE_THRESHOLD}, rescued ${rescued}, 低スコアで見送り ${dropped}, 同一URL重複${duplicateDropped}件除外, research由来 ${researchCount})`
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

    // 最終セーフティネット1: 配信済みURLが紛れ込んでいたら除去（続報は新URLなので残る）
    for (const [topicId, items] of Object.entries(data.byTopic)) {
      const filtered = items.filter((i) => !deliveredUrls.has(normalizeUrl(i.url)));
      if (filtered.length !== items.length) {
        console.log(
          `[WebAgent] dropped ${items.length - filtered.length} already-delivered items from ${topicId}`
        );
      }
      data.byTopic[topicId] = filtered;
    }

    // 最終セーフティネット2: web_search合流後も含め、同一実行内ではURLを一意にする。
    // トピックを跨いだ重複は高スコアを優先し、同点ならtopics.yamlの先行トピックを残す。
    const beforeCurrentRunDedup = Object.values(data.byTopic).flat();
    const uniqueCurrentRun = dedupeByNormalizedUrl(
      input.config.topics.flatMap((topic) => data.byTopic[topic.id] ?? []),
      (candidate, current) => candidate.score > current.score
    );
    data.byTopic = Object.fromEntries(input.config.topics.map((topic) => [topic.id, []]));
    for (const item of uniqueCurrentRun) data.byTopic[item.topic].push(item);
    for (const items of Object.values(data.byTopic)) items.sort((a, b) => b.score - a.score);
    const currentRunDuplicates = beforeCurrentRunDedup.length - uniqueCurrentRun.length;
    if (currentRunDuplicates > 0) {
      console.log(`[WebAgent] dropped ${currentRunDuplicates} duplicate items within current run`);
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

      // byTopic にマージ。URL一致dedup（seen）に加え、トピック重複ガードで
      // 既存fetch記事・既配信記事と同一ストーリー（モデル名＋版数などの識別トークン一致）の
      // web_search記事を除外する。別URLで同一ネタを蒸し返す穴（例: 6/23 GPT-5.6再掲）を塞ぐ。
      const existing = data.byTopic[t.id] ?? [];
      const priorTokenSets = [
        ...existing.map((i) => distinctiveTokens(i.title)),
        ...pickRecentDeliveredTitles(delivered, dateStr, t.id).map(distinctiveTokens),
      ];
      const seen = new Set(existing.map((i) => normalizeUrl(i.url)));
      let added = 0;
      let topicalDropped = 0;
      for (const item of res.items) {
        const normalizedUrl = normalizeUrl(item.url);
        if (seen.has(normalizedUrl)) continue;
        if (isTopicalDup(item.title, priorTokenSets)) {
          topicalDropped++;
          continue;
        }
        existing.push(item);
        seen.add(normalizedUrl);
        added++;
      }
      data.byTopic[t.id] = existing;
      console.log(
        `[WebAgent] web_search ${t.id}: +${added} items (候補${res.items.length}・トピック重複${topicalDropped}除外), ${res.webSearchRequests} searches`
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
        score: Math.min(typeof it.score === 'number' ? it.score : 3, WEB_SEARCH_SCORE_CAP),
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

/**
 * タイトルから「モデル名＋版数」型の識別トークンを抽出する（トピック重複判定用）。
 * 英字と数字の両方を含む長さ4以上の正規化トークンのみ採用。
 * 例: "GPT-5.6"→"gpt56" / "Claude Opus 4.8"→（"claude"等は数字無しで除外、"opus4.8"連結時のみ"opus48"）。
 * 年（2026）や単独数字は「英字＋数字」条件で除外され誤検知しにくい。言語非依存（日英タイトル横断で機能）。
 */
export function distinctiveTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of title.toLowerCase().match(/[a-z0-9][a-z0-9.\-]*[a-z0-9]/g) ?? []) {
    const norm = raw.replace(/[.\-]/g, '');
    if (norm.length >= 4 && /[a-z]/.test(norm) && /[0-9]/.test(norm)) tokens.add(norm);
  }
  return tokens;
}

/** title が priorTokenSets のいずれかと識別トークンを共有する（＝同一ストーリー）かを判定する。 */
export function isTopicalDup(title: string, priorTokenSets: Set<string>[]): boolean {
  const t = distinctiveTokens(title);
  if (t.size === 0) return false;
  for (const prior of priorTokenSets) {
    for (const tok of t) if (prior.has(tok)) return true;
  }
  return false;
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
