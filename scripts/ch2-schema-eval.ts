/**
 * 第2章 スキーマ契約 — 崩壊耐性ハーネス
 *
 * 仮説: 構造化出力は「形」は強制するが「意味」は強制しない。だが形の設計は意味に波及する
 *       (shape -> semantics spillover)。トピックID键・全required のschemaは、空配列を許容
 *       していてもモデルにトピックを埋めさせ、トピック崩壊を減らす——を定量化する。
 *
 * 方法: 同一の集約プロンプトを保ったまま、出力スキーマだけを V0/V1/V2 で差し替えて
 *       実 sources＋敵対的合成 sources に対し各 K 回実行し、トピック崩壊率を測る。
 *       本番 webAgent.ts は触らない（集約呼び出しを複製）。設計: docs/2026-06-28-ch2-schema-design.md
 *
 * 使い方:
 *   npx tsx scripts/ch2-schema-eval.ts --dry                 # 入力構築だけ確認（LLM呼ばない）
 *   npx tsx scripts/ch2-schema-eval.ts --k 6                 # K=6 で実行（既定）
 *   npx tsx scripts/ch2-schema-eval.ts --dates 2026-06-18,2026-06-28 --k 10
 *   npx tsx scripts/ch2-schema-eval.ts --variants v0,v2      # 変種を絞る
 */
import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { S3Client } from '@aws-sdk/client-s3';
import Anthropic from '@anthropic-ai/sdk';
import {
  listRunArchiveKeys,
  loadRunArchive,
  type RunArchive,
  type ArchivedSource,
} from '../src/utils/runArchive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });
// .env のAWSキーはSES用でS3権限が無い。~/.aws の default プロファイルに委ねる（eval.ts と同じ）。
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;

const S3_REGION = 'ap-northeast-1';
const MODEL = 'claude-haiku-4-5-20251001';

// ---- CLI -----------------------------------------------------------
const argv = process.argv.slice(2);
const argVal = (n: string) => {
  const i = argv.indexOf(n);
  return i !== -1 ? argv[i + 1] : undefined;
};
const DRY = argv.includes('--dry');
const K = argVal('--k') ? Number(argVal('--k')) : 6;
const BUCKET = argVal('--bucket') ?? process.env.STORAGE_BUCKET ?? '';
const VARIANTS = (argVal('--variants') ?? 'v0,v1,v2').split(',') as Variant[];
const EXPLICIT_DATES = argVal('--dates')?.split(',');

type Variant = 'v0' | 'v1' | 'v2';
type TopicDef = RunArchive['topics'][number];
interface AggItem {
  topic: string;
  url: string;
  title: string;
  summary: string;
  score: number;
}

// ---- スキーマ変種（schema強度の3段階） ------------------------------
// itemSchema: V1/V2 は topic をキーで表すので topic フィールドを持たない。
const ITEM_PROPS = {
  url: { type: 'string' },
  title: { type: 'string' },
  summary: { type: 'string' },
  score: { type: 'integer', enum: [1, 2, 3, 4, 5] },
};

/** V0: flat配列＋topic enumフィールド。網羅強制なし（pre-2ea062d の崩壊版を復元）。 */
function schemaV0(topics: TopicDef[]): Anthropic.JSONOutputFormat {
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { topic: { type: 'string', enum: topics.map((t) => t.id) }, ...ITEM_PROPS },
            required: ['topic', 'url', 'title', 'summary', 'score'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
  } as Anthropic.JSONOutputFormat;
}

/** トピックID键オブジェクト。required を空(V1)/全トピック(V2)で切り替える。 */
function schemaKeyed(topics: TopicDef[], allRequired: boolean): Anthropic.JSONOutputFormat {
  const itemSchema = {
    type: 'object',
    properties: ITEM_PROPS,
    required: ['url', 'title', 'summary', 'score'],
    additionalProperties: false,
  };
  const props: Record<string, unknown> = {};
  for (const t of topics) props[t.id] = { type: 'array', items: itemSchema };
  return {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: props,
      required: allRequired ? topics.map((t) => t.id) : [],
      additionalProperties: false,
    },
  } as Anthropic.JSONOutputFormat;
}

function buildSchema(v: Variant, topics: TopicDef[]): Anthropic.JSONOutputFormat {
  if (v === 'v0') return schemaV0(topics);
  if (v === 'v1') return schemaKeyed(topics, false); // 键化のみ
  return schemaKeyed(topics, true); // V2 = 键化＋全required（＝現行 buildSummaryFormat）
}

// ---- 集約呼び出し（プロンプトは全変種で固定。差は schema のみ） -----
function buildSourcesText(sources: ArchivedSource[]): string {
  return sources
    .map((r) => `=== [トピックID: ${r.topicId}] ${r.topicLabel} (${r.url}) ===\n${r.content}`)
    .join('\n\n');
}

/** スキーマ非依存（shapeを規定しない）の集約プロンプト。task だけ記述し形は output_config に委ねる。 */
function buildPrompt(dateStr: string, topics: TopicDef[], sources: ArchivedSource[]): string {
  return `今日は ${dateStr} です。以下の各URLから収集した内容をもとに、設定された全トピック（${topics
    .map((t) => t.id)
    .join(
      ', '
    )}）それぞれについて、収集データ内の候補記事を網羅的に列挙し、各記事に重要度スコア（1-5）を付与してください。件数を自分で絞り込まないでください（掲載可否は後段で機械的に判定します）。
- スコア基準: 5=一次情報の重大発表 / 4=注目に値する進展 / 3=通常ニュース / 2=軽微 / 1=無関係寄り。
- 古い記事（2日以上前と明示されているもの）は含めないでください。日付が不明な記事は最新として扱ってください。
- 実在する記事のみを入れてください（記事を創作しないこと）。該当記事が無いトピックは記事を入れないでください。
収集データ:
${buildSourcesText(sources)}`;
}

/** 出力を Record<topicId, AggItem[]> に正規化する（変種ごとに形が違う）。 */
function parseOutput(v: Variant, text: string, topics: TopicDef[]): Record<string, AggItem[]> {
  const byTopic: Record<string, AggItem[]> = {};
  for (const t of topics) byTopic[t.id] = [];
  const obj = JSON.parse(text) as Record<string, unknown>;
  if (v === 'v0') {
    const items = (obj.items as AggItem[]) ?? [];
    for (const it of items) if (byTopic[it.topic]) byTopic[it.topic].push(it);
  } else {
    for (const t of topics) {
      const arr = (obj[t.id] as Omit<AggItem, 'topic'>[]) ?? [];
      byTopic[t.id] = arr.map((it) => ({ ...it, topic: t.id }));
    }
  }
  return byTopic;
}

async function aggregate(
  client: Anthropic,
  v: Variant,
  dateStr: string,
  topics: TopicDef[],
  sources: ArchivedSource[]
): Promise<{ byTopic: Record<string, AggItem[]>; inTok: number; outTok: number }> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system:
      'あなたはニュース編集者です。収集した情報をトピックごとに整理し、各記事へ重要度スコアを付けて出力してください。',
    output_config: { format: buildSchema(v, topics) },
    messages: [{ role: 'user', content: buildPrompt(dateStr, topics, sources) }],
  });
  const textBlock = res.content.find((c) => c.type === 'text');
  const byTopic =
    textBlock && textBlock.type === 'text'
      ? parseOutput(v, textBlock.text, topics)
      : Object.fromEntries(topics.map((t) => [t.id, []]));
  return { byTopic, inTok: res.usage.input_tokens, outTok: res.usage.output_tokens };
}

// ---- 敵対的合成入力 ------------------------------------------------
interface ExpInput {
  name: string;
  dateStr: string;
  topics: TopicDef[];
  sources: ArchivedSource[];
}

/** 実アーカイブを donor に、崩壊を誘発する合成 sources を生成する（ground-truth=全トピックに候補あり）。 */
function syntheticInputs(donor: RunArchive): ExpInput[] {
  const byTopic = new Map<string, ArchivedSource[]>();
  for (const s of donor.sources) {
    if (!byTopic.has(s.topicId)) byTopic.set(s.topicId, []);
    byTopic.get(s.topicId)!.push(s);
  }
  const topicsWith = donor.topics.filter((t) => (byTopic.get(t.id)?.length ?? 0) > 0);
  const one = (id: string) => byTopic.get(id)!.slice(0, 1);
  const many = (id: string, n: number) => {
    const base = byTopic.get(id)!;
    const out: ArchivedSource[] = [];
    for (let i = 0; i < n; i++) out.push(...base);
    return out.slice(0, n);
  };

  // ai偏重: ai を大量・他トピック各1（6/18崩壊の構造を増幅）。ai が無ければ先頭トピックで代用。
  const floodId = topicsWith.find((t) => t.id === 'ai')?.id ?? topicsWith[0]?.id;
  const aiFlood: ArchivedSource[] = [];
  for (const t of topicsWith) aiFlood.push(...(t.id === floodId ? many(t.id, 8) : one(t.id)));

  // 全トピック大量: 各トピック最大3件。
  const heavy: ArchivedSource[] = topicsWith.flatMap((t) => many(t.id, 3));
  // 薄い日: 各トピック1件。
  const thin: ArchivedSource[] = topicsWith.flatMap((t) => one(t.id));

  return [
    { name: `synth:${floodId}-flood`, dateStr: donor.isoDate, topics: topicsWith, sources: aiFlood },
    { name: 'synth:all-heavy', dateStr: donor.isoDate, topics: topicsWith, sources: heavy },
    { name: 'synth:thin', dateStr: donor.isoDate, topics: topicsWith, sources: thin },
  ];
}

// ---- メトリクス ----------------------------------------------------
interface RunResult {
  topicsCovered: number;
  filled: Set<string>; // 非空だったトピックID
}

function evalRun(byTopic: Record<string, AggItem[]>): RunResult {
  const filled = new Set<string>();
  for (const [id, items] of Object.entries(byTopic)) if (items.length > 0) filled.add(id);
  return { topicsCovered: filled.size, filled };
}

// ---- メイン --------------------------------------------------------
async function main() {
  const s3 = new S3Client({ region: S3_REGION });
  if (!BUCKET) {
    console.error('エラー: --bucket か STORAGE_BUCKET が必要です。');
    process.exit(1);
  }
  let keys = await listRunArchiveKeys(s3, BUCKET);
  if (EXPLICIT_DATES) {
    keys = keys.filter((k) => EXPLICIT_DATES.some((d) => k.includes(d)));
  } else {
    // 既定: 崩壊日 6/18 ＋ 直近2配信
    const recent = keys.slice(-2);
    const collapse = keys.filter((k) => k.includes('2026-06-18'));
    keys = [...new Set([...collapse, ...recent])].sort();
  }
  const archives: RunArchive[] = [];
  for (const k of keys) {
    const a = await loadRunArchive(s3, BUCKET, k);
    if (a) archives.push(a);
  }
  if (archives.length === 0) {
    console.error('アーカイブを取得できませんでした。');
    process.exit(1);
  }

  // 実入力 ＋ 合成入力（donor は最もソースが多い日）
  const realInputs: ExpInput[] = archives.map((a) => ({
    name: `real:${a.isoDate}`,
    dateStr: a.isoDate,
    topics: a.topics,
    sources: a.sources,
  }));
  const donor = [...archives].sort((a, b) => b.sources.length - a.sources.length)[0];
  let inputs = [...realInputs, ...syntheticInputs(donor)];
  // --inputs ai-flood,thin で差が出る入力だけに絞る（コスト削減）。
  const INPUT_FILTER = argVal('--inputs')?.split(',');
  if (INPUT_FILTER) inputs = inputs.filter((i) => INPUT_FILTER.some((f) => i.name.includes(f)));

  const totalCalls = inputs.length * VARIANTS.length * K;
  console.log(`第2章 崩壊耐性ハーネス`);
  console.log(`- 入力: ${inputs.length}（実${realInputs.length}＋合成${inputs.length - realInputs.length}）`);
  console.log(`- 変種: ${VARIANTS.join(', ')} / K=${K}`);
  console.log(`- 総呼び出し: ${totalCalls}（概算 ~$${(totalCalls * 0.003).toFixed(2)}）`);
  for (const inp of inputs) {
    const cnt = new Map<string, number>();
    for (const s of inp.sources) cnt.set(s.topicId, (cnt.get(s.topicId) ?? 0) + 1);
    console.log(
      `  · ${inp.name.padEnd(22)} sources=${inp.sources.length} [${[...cnt.entries()]
        .map(([t, n]) => `${t}:${n}`)
        .join(' ')}]`
    );
  }
  if (DRY) {
    console.log('\n--dry: ここまで（LLM呼び出しなし）。');
    return;
  }

  const client = new Anthropic();
  let inTok = 0;
  let outTok = 0;
  // results[inputName][variant] = RunResult[]
  const results: Record<string, Record<string, RunResult[]>> = {};

  for (const inp of inputs) {
    results[inp.name] = {};
    for (const v of VARIANTS) {
      results[inp.name][v] = [];
      for (let k = 0; k < K; k++) {
        try {
          const { byTopic, inTok: i, outTok: o } = await aggregate(
            client,
            v,
            inp.dateStr,
            inp.topics,
            inp.sources
          );
          inTok += i;
          outTok += o;
          results[inp.name][v].push(evalRun(byTopic));
        } catch (err) {
          console.warn(`  [warn] ${inp.name}/${v}/k${k}: ${(err as Error).message}`);
        }
      }
      const rr = results[inp.name][v];
      const cov = rr.map((r) => r.topicsCovered);
      process.stdout.write(
        `  ${inp.name}/${v}: covered ${cov.join(',')} (n=${rr.length})\n`
      );
    }
  }

  // ---- レポート ----
  console.log('\n## 崩壊耐性レポート\n');
  for (const inp of inputs) {
    // 候補ありトピック = 全変種・全試行で一度でも非空になったトピックの和集合
    const candidates = new Set<string>();
    for (const v of VARIANTS) for (const r of results[inp.name][v]) for (const id of r.filled) candidates.add(id);
    const C = candidates.size;
    console.log(`### ${inp.name}  （候補トピック ${C}）`);
    console.log('| 変種 | 平均網羅 | 崩壊率 | トピック別fill率 |');
    console.log('|---|---|---|---|');
    for (const v of VARIANTS) {
      const rr = results[inp.name][v];
      if (rr.length === 0) {
        console.log(`| ${v} | — | — | — |`);
        continue;
      }
      const meanCov = rr.reduce((s, r) => s + r.topicsCovered, 0) / rr.length;
      const collapse = rr.filter((r) => r.topicsCovered < C).length / rr.length;
      const fill = [...candidates]
        .map((id) => `${id}:${Math.round((rr.filter((r) => r.filled.has(id)).length / rr.length) * 100)}%`)
        .join(' ');
      console.log(
        `| ${v} | ${meanCov.toFixed(1)}/${C} | ${(collapse * 100).toFixed(0)}% | ${fill} |`
      );
    }
    console.log('');
  }

  const cost = (inTok / 1e6) * 1 + (outTok / 1e6) * 5;
  console.log(`コスト: $${cost.toFixed(4)}（入力 ${inTok} / 出力 ${outTok} トークン）`);

  const outDir = path.resolve(__dirname, '../eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `ch2-schema-${Date.now()}.json`);
  const serializable = Object.fromEntries(
    Object.entries(results).map(([name, byV]) => [
      name,
      Object.fromEntries(
        Object.entries(byV).map(([v, rr]) => [
          v,
          rr.map((r) => ({ topicsCovered: r.topicsCovered, filled: [...r.filled] })),
        ])
      ),
    ])
  );
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), k: K, results: serializable }, null, 2));
  console.log(`結果を保存: ${outPath}`);
}

main().catch((err) => {
  console.error('実行失敗:', err instanceof Error ? err.message : err);
  process.exit(1);
});
