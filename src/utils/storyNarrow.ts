/**
 * ストーリー割当の候補を、LLMを呼ぶ前に絞り込む。
 *
 * プロンプトの支配的な項目は「既存ストーリー一覧」（実測: input 9,000トークン中 4,041）で、
 * 記事本文ではない。ここを削るのが唯一効くコスト対策。
 *
 * 手法は文字bigramのJaccard類似度。日本語は分かち書きが要らず、外部ライブラリも
 * 追加のAPI呼び出しも不要。既存の distinctiveTokens() は英数字＋数字のトークンしか
 * 拾わないので日本語のタイトルには効かない。
 *
 * 絞り込みは**再現率だけが重要**。最終判断はLLMがやるので余計な候補が混ざる害は小さいが、
 * 正解が候補から漏れると誤って新規ストーリーが生まれ、台帳が汚れて回復できない。
 * 60日・286件の実測で K=8 が再現率 99.7%（K=5 は 95.1%）だったため 8 を既定にする。
 */
import type { Story } from './storyLedger.js';

export const NARROW_TOP_K = 8;

/** 文字bigramの集合。空白は落とす（「日銀 利上げ」と「日銀利上げ」を同一視するため） */
export function bigrams(text: string): Set<string> {
  const t = text.replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export interface NarrowableArticle {
  title: string;
  summary: string;
  topic: string;
}

/**
 * 記事ごとに同一トピックの上位K本を選び、その和集合を候補として返す。
 *
 * 和集合を取るのは、プロンプトが記事全件をまとめて1回で処理するため。
 * 返り値の順序は入力（= activeStories の順）を保つ。
 */
export function narrowCandidates(
  articles: NarrowableArticle[],
  stories: Story[],
  topK: number = NARROW_TOP_K
): Story[] {
  if (stories.length === 0 || articles.length === 0) return [];

  const storyBigrams = new Map(stories.map((s) => [s.id, bigrams(s.title)]));
  const picked = new Set<string>();

  for (const article of articles) {
    const ab = bigrams(`${article.title}${article.summary}`);
    stories
      .filter((s) => s.topic === article.topic)
      .map((s) => ({ id: s.id, score: jaccard(ab, storyBigrams.get(s.id)!) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, topK)
      .forEach(({ id }) => picked.add(id));
  }

  return stories.filter((s) => picked.has(s.id));
}
