import { calcCost } from '../src/utils/llmLogger.js';

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) {
    console.error(`FAIL ${name}`, detail ?? '');
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${name}`);
}

const known = calcCost({ input_tokens: 1_000_000, output_tokens: 100_000 }, 'claude-haiku-4-5-20251001', 3);
check('既知のモデルは トークン費用 + 検索費用', known !== null && Math.abs(known - (1 + 0.5 + 0.03)) < 1e-9, known);

const warn = console.warn;
console.warn = () => {};
const unknown = calcCost({ input_tokens: 1_000_000, output_tokens: 100_000 }, 'unknown-model', 3);
console.warn = warn;
check('単価の分からないモデルは 0 や検索費用だけにせず null', unknown === null, unknown);
check('プロトタイプ上の名前を単価として拾わない', calcCost({ input_tokens: 1, output_tokens: 1 }, 'toString') === null);
