import { findPrice, tokenCostUsd, webSearchCostUsd, type CostBasis, type TokenPrice } from '@pyonta0215/research-kit/cost';

export interface LlmLog {
  traceId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 使用量 × 単価の推定（請求額ではない）。単価の分からないモデルは null（0 にしない） */
  costUsd: number | null;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  /** web_search ツールの検索回数（usage.server_tool_use.web_search_requests） */
  webSearchRequests?: number;
}

/** web_search ツール利用料: $10 / 1,000検索 = $0.01/検索（モデル非依存の一律料金） */
const WEB_SEARCH_COST_PER_REQUEST = 0.01;

const MODEL_PRICING: Readonly<Record<string, TokenPrice>> = {
  // Haiku 4.5 の正価（旧 0.8/4 は Haiku 3.5 の価格だった）
  'claude-haiku-4-5-20251001': { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
};

/**
 * 推定費用。単価表に無いモデルは null を返す。
 *
 * 以前は単価が分からないとトークン分を 0 として web_search 分だけを返していた。
 * ログや集計でそれを足すと「安く済んだ」と読めてしまうので、分からないことを null で残す。
 */
export function calcCost(
  usage: { input_tokens: number; output_tokens: number },
  model: string,
  webSearchRequests = 0
): number | null {
  const price = findPrice(MODEL_PRICING, model);
  if (!price) {
    console.warn(`[llmLogger] Unknown model: ${model}. Cost is not measured.`);
    return null;
  }
  return (
    tokenCostUsd(price, { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }) +
    webSearchCostUsd({ calls: webSearchRequests }, { perCallUsd: WEB_SEARCH_COST_PER_REQUEST, count: 'all-calls' })
  );
}

export function logLlm(log: LlmLog): void {
  const costBasis: CostBasis = log.costUsd === null ? 'unmeasured' : 'metered';
  console.log(JSON.stringify({ type: 'LLM_CALL', ...log, costBasis }));
}
