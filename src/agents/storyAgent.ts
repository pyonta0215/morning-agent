import Anthropic from '@anthropic-ai/sdk';
import { logLlm, calcCost } from '../utils/llmLogger.js';
import {
  type Story,
  type StoryLedger,
  activeStories,
  appendToStory,
  createStory,
} from '../utils/storyLedger.js';
import { narrowCandidates } from '../utils/storyNarrow.js';

const MODEL = 'claude-haiku-4-5-20251001';

/** 割当対象の記事1件 */
export interface AssignableArticle {
  id: string;
  title: string;
  summary: string;
  topic: string;
}

export interface AssignmentResult {
  /** 既存ストーリーへ割り当てた件数 */
  assigned: number;
  /** 新規ストーリーを起こした件数 */
  created: number;
  /** トピック不一致でコード側が新規に差し戻した件数 */
  rejectedCrossTopic: number;
  /** 同名の既存/新規ストーリーへコード側が寄せ直した件数 */
  mergedByTitle: number;
  /** 直近14日のactiveなストーリー数（絞り込み前） */
  candidatesBefore: number;
  /** 実際にプロンプトへ載せたストーリー数（絞り込み後） */
  candidatesAfter: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * 割当呼び出しの JSON スキーマ。
 *
 * 記事の別名（a1, a2, ...）をキーに持つオブジェクトとし、全記事を required にすることで
 * 「一部の記事だけ返す」崩壊を生成段階で構造的に防ぐ（集約フェーズの buildSummaryFormat と同じ手法）。
 * storyId は既存ID + "NEW" の enum に固定し、存在しないIDの捏造も構造的に防ぐ。
 */
function buildAssignmentFormat(
  aliases: string[],
  storyIds: string[]
): Anthropic.JSONOutputFormat {
  const entrySchema = {
    type: 'object',
    properties: {
      // reason を先に置くのは、判断を書かせてから結論を出させるため（出力順は properties の順に従う）
      reason: {
        type: 'string',
        description:
          '既存に割り当てるなら「どの出来事の続報か」、NEWなら「既存のどれとも違う理由」を1文で。40字以内',
      },
      storyId: { type: 'string', enum: [...storyIds, 'NEW'] },
      storyTitle: {
        type: 'string',
        description: '既存に割り当てる場合はそのストーリーの既存タイトル、NEWの場合は新しい話題名',
      },
    },
    required: ['reason', 'storyId', 'storyTitle'],
    additionalProperties: false,
  };
  const props: Record<string, unknown> = {};
  for (const a of aliases) props[a] = entrySchema;
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: props,
      required: aliases,
      additionalProperties: false,
    },
  } as Anthropic.JSONOutputFormat;
}

function buildPrompt(
  isoDate: string,
  articles: AssignableArticle[],
  aliasOf: Map<string, string>,
  stories: Story[]
): string {
  const storyBlock =
    stories.length === 0
      ? '（まだ1件もありません。すべて新規になります）'
      : stories
          .map(
            (s) =>
              `- ${s.id} [${s.topic}] 「${s.title}」 初出${s.firstSeen} 直近${s.lastSeen} 記事${s.articleIds.length}件`
          )
          .join('\n');

  const articleBlock = articles
    .map((a) => `- ${aliasOf.get(a.id)} [${a.topic}] 「${a.title}」\n    ${a.summary}`)
    .join('\n');

  return `今日は ${isoDate} です。本日の記事を、継続する話題（ストーリー）に割り当ててください。

【既存のストーリー（直近14日に言及があるもの）】
${storyBlock}

【本日の記事】
${articleBlock}

【判断の基準】

**既存に割り当てられるのは「同じ出来事の続報」だけです。「同じ分野の別の話」は割り当てられません。**

- ○ 割り当てる: そのストーリーが扱っている**特定の出来事の、その後の展開**（続報・関連の動き・反応・決着）
- ✕ 割り当てない: 分野が同じ／登場する企業が同じ／似た種類のニュース、というだけのもの

判断に迷ったら、次の一文が自然に読めるかで決めてください。
　「〈ストーリー名〉の件は、その後こうなった: 〈記事の見出し〉」
読めなければ別の話題です。**迷ったら NEW にしてください。**無関係な記事が1本のストーリーに溜まると、話題の流れが追えなくなります。

具体例:
- ストーリー「Anthropicが自律型AIエージェントを発表」に対して
  - ○「同エージェントの提供地域が拡大」（同じ出来事の続き）
  - ✕「GoogleがPixelの新機能を発表」（AIという分野が同じだけ）
- ストーリー「皇位継承をめぐる法案の議論」に対して
  - ○「与野党が要綱案で合意」（同じ議論の進展）
  - ✕「内閣支持率が下落」（政治という分野が同じだけ）

その他:
- 「AI関連」「政治のニュース」のような広すぎるストーリー名は作らないでください。**具体的な出来事・主体を指す粒度**にします（良い例:「GPT-5.6の無料開放」「日銀の利上げ観測」／悪い例:「LLMの動向」「経済ニュース」）。
- **トピック（[]内）が異なるストーリーには割り当てないでください。**
- 既存のどれとも別の話題なら storyId に "NEW"、storyTitle に新しい話題名（15〜30字程度、固有名詞を含める）を書いてください。
- 既存に割り当てる場合、storyTitle にはそのストーリーの既存タイトルをそのまま書いてください。
- reason には判断の根拠を1文（40字以内）で書いてください。`;
}

/**
 * 当日の記事を台帳に割り当てる。台帳は破壊的に更新される。
 *
 * 過去の割当は再計算しない（台帳ルール2）。トピックを跨ぐ割当はコード側で拒否し、
 * 新規ストーリーに差し戻す（プロンプトの遵守に頼らない）。
 */
export async function assignArticlesToStories(
  client: Anthropic,
  ledger: StoryLedger,
  isoDate: string,
  articles: AssignableArticle[]
): Promise<AssignmentResult> {
  const empty: AssignmentResult = {
    assigned: 0,
    created: 0,
    rejectedCrossTopic: 0,
    mergedByTitle: 0,
    candidatesBefore: 0,
    candidatesAfter: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  if (articles.length === 0) return empty;

  // プロンプト上は短い別名を使う（16桁のハッシュをキーにするとトークンを食うため）
  const aliasOf = new Map<string, string>();
  const byAlias = new Map<string, AssignableArticle>();
  articles.forEach((a, i) => {
    const alias = `a${i + 1}`;
    aliasOf.set(a.id, alias);
    byAlias.set(alias, a);
  });

  // 直近14日ぶんに限る（コストを有界に保つ不変条件。ledger.stories を直接渡さないこと）→
  // さらに文字bigram類似度で記事ごとの上位K本に絞る
  const active = activeStories(ledger, isoDate);
  const candidates = narrowCandidates(articles, active);
  const started = Date.now();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system:
      'あなたはニュース編集者です。日々の記事を「継続する話題」の単位にまとめ、話題の流れを追える形に整理してください。',
    output_config: {
      format: buildAssignmentFormat(
        articles.map((a) => aliasOf.get(a.id)!),
        candidates.map((s) => s.id)
      ),
    },
    messages: [{ role: 'user', content: buildPrompt(isoDate, articles, aliasOf, candidates) }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const costUsd = calcCost({ input_tokens: inputTokens, output_tokens: outputTokens }, MODEL);

  logLlm({
    traceId: process.env.AWS_LAMBDA_REQUEST_ID ?? 'local',
    agentId: 'story',
    model: MODEL,
    inputTokens,
    outputTokens,
    costUsd,
    durationMs: Date.now() - started,
    success: true,
  });

  const textBlock = response.content.find((c) => c.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('[storyAgent] no text block in response');
  }
  const parsed = JSON.parse(textBlock.text) as Record<
    string,
    { reason: string; storyId: string; storyTitle: string }
  >;

  const byId = new Map(ledger.stories.map((s) => [s.id, s]));

  /**
   * 同じ呼び出しの中で「NEW かつ同じ storyTitle」が複数返ることがある（実測: 60日で9組・余剰13本）。
   * また、候補の絞り込みで既存が漏れたとき、モデルが既存とまったく同じタイトルで NEW を返すこともある。
   * どちらもタイトルの完全一致で拾えるので、コード側で寄せ直す。
   * 対象は active な既存だけに限る（休眠したストーリーを黙って蘇らせない）。
   */
  const byTitle = new Map<string, Story>();
  for (const s of active) byTitle.set(`${s.topic} ${s.title}`, s);

  const result = {
    ...empty,
    candidatesBefore: active.length,
    candidatesAfter: candidates.length,
    inputTokens,
    outputTokens,
    costUsd,
  };

  for (const [alias, entry] of Object.entries(parsed)) {
    const article = byAlias.get(alias);
    if (!article) continue;

    const existing =
      entry.storyId === 'NEW'
        ? byTitle.get(`${article.topic} ${entry.storyTitle}`)
        : byId.get(entry.storyId);
    if (entry.storyId === 'NEW' && existing) result.mergedByTitle++;

    // トピック跨ぎはコード側で拒否し、新規に差し戻す
    if (existing && existing.topic !== article.topic) {
      result.rejectedCrossTopic++;
      const created = createStory(ledger, isoDate, entry.storyTitle, article.topic, article.id);
      byId.set(created.id, created);
      byTitle.set(`${created.topic} ${created.title}`, created);
      result.created++;
      continue;
    }

    if (existing) {
      appendToStory(existing, article.id, isoDate);
      result.assigned++;
    } else {
      const created = createStory(ledger, isoDate, entry.storyTitle, article.topic, article.id);
      byId.set(created.id, created);
      byTitle.set(`${created.topic} ${created.title}`, created);
      result.created++;
    }
  }

  ledger.updatedAt = new Date().toISOString();
  return result;
}
