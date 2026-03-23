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
}

const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  'claude-sonnet-4-20250514': { inputPerM: 3, outputPerM: 15 },
  'claude-haiku-4-5': { inputPerM: 0.8, outputPerM: 4 },
};

export function calcCost(
  usage: { input_tokens: number; output_tokens: number },
  model: string
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) {
    console.warn(`[llmLogger] Unknown model: ${model}. Cost will be 0.`);
    return 0;
  }
  return (
    (usage.input_tokens / 1_000_000) * pricing.inputPerM +
    (usage.output_tokens / 1_000_000) * pricing.outputPerM
  );
}

export function logLlm(log: LlmLog): void {
  console.log(JSON.stringify({ type: 'LLM_CALL', ...log }));
}
