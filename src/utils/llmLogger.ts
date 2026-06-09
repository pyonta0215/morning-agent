export interface LlmLog {
  traceId: string;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  /** web_search ツールの検索回数（usage.server_tool_use.web_search_requests） */
  webSearchRequests?: number;
}

/** web_search ツール利用料: $10 / 1,000検索 = $0.01/検索（モデル非依存の一律料金） */
const WEB_SEARCH_COST_PER_REQUEST = 0.01;

const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  // Haiku 4.5 の正価（旧 0.8/4 は Haiku 3.5 の価格だった）
  'claude-haiku-4-5-20251001': { inputPerM: 1, outputPerM: 5 },
};

export function calcCost(
  usage: { input_tokens: number; output_tokens: number },
  model: string,
  webSearchRequests = 0
): number {
  const webSearchCost = webSearchRequests * WEB_SEARCH_COST_PER_REQUEST;
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    console.warn(`[llmLogger] Unknown model: ${model}. Token cost will be 0.`);
    return webSearchCost;
  }
  return (
    (usage.input_tokens / 1_000_000) * pricing.inputPerM +
    (usage.output_tokens / 1_000_000) * pricing.outputPerM +
    webSearchCost
  );
}

export function logLlm(log: LlmLog): void {
  console.log(JSON.stringify({ type: 'LLM_CALL', ...log }));
}
