import Anthropic from '@anthropic-ai/sdk';
import { logLlm, calcCost } from '../utils/llmLogger.js';
import {
  type Story,
  type StoryLedger,
  activeStories,
  appendToStory,
  createStory,
} from '../utils/storyLedger.js';

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
      storyId: { type: 'string', enum: [...storyIds, 'NEW'] },
      storyTitle: {
        type: 'string',
        description: '既存に割り当てる場合はそのストーリーの既存タイトル、NEWの場合は新しい話題名',
      },
    },
    required: ['storyId', 'storyTitle'],
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
- 同じ出来事・同じ主体についての続報は、既存ストーリーに割り当ててください。**まず既存に寄せられないかを検討する**こと。
- ただし「AI関連」「政治のニュース」のような広すぎる受け皿は作らないでください。**具体的な出来事・主体を指す粒度**にします（良い例:「GPT-5.6の無料開放」「日銀の利上げ観測」／悪い例:「LLMの動向」「経済ニュース」）。
- **トピック（[]内）が異なるストーリーには割り当てないでください。**
- 既存のどれとも別の話題なら storyId に "NEW" を入れ、storyTitle に新しい話題名（15〜30字程度、固有名詞を含める）を書いてください。
- 既存に割り当てる場合、storyTitle にはそのストーリーの既存タイトルをそのまま書いてください。`;
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

  const candidates = activeStories(ledger, isoDate);
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
    { storyId: string; storyTitle: string }
  >;

  const byId = new Map(ledger.stories.map((s) => [s.id, s]));
  const result = { ...empty, inputTokens, outputTokens, costUsd };

  for (const [alias, entry] of Object.entries(parsed)) {
    const article = byAlias.get(alias);
    if (!article) continue;

    const existing = entry.storyId === 'NEW' ? undefined : byId.get(entry.storyId);

    // トピック跨ぎはコード側で拒否し、新規に差し戻す
    if (existing && existing.topic !== article.topic) {
      result.rejectedCrossTopic++;
      const created = createStory(ledger, isoDate, entry.storyTitle, article.topic, article.id);
      byId.set(created.id, created);
      result.created++;
      continue;
    }

    if (existing) {
      appendToStory(existing, article.id, isoDate);
      result.assigned++;
    } else {
      const created = createStory(ledger, isoDate, entry.storyTitle, article.topic, article.id);
      byId.set(created.id, created);
      result.created++;
    }
  }

  ledger.updatedAt = new Date().toISOString();
  return result;
}
