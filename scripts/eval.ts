/**
 * 評価ハーネス — 朝刊エージェント便の配信品質を3指標で測定する
 *
 *   重複率        : 過去配信との同一・類似記事の混入率（コード計算・無料）
 *   カテゴリ精度  : 記事がトピック定義に合致しているか（LLM-as-Judge）
 *   見出し忠実性  : タイトル・要約が収集ソースに裏付けられているか（LLM-as-Judge）
 *
 * judge は1配信分につき Haiku 1呼び出しに集約（目安 ~$0.01/配信分）。
 *
 * 使い方:
 *   npx tsx scripts/eval.ts                     # S3の全アーカイブを評価
 *   npx tsx scripts/eval.ts --days 15           # 直近15配信分のみ
 *   npx tsx scripts/eval.ts --no-judge          # 重複率のみ（無料）
 *   npx tsx scripts/eval.ts --file sample.json  # ローカルのアーカイブJSONで実行
 *   npx tsx scripts/eval.ts --bucket <name>     # バケット名を明示（既定: STORAGE_BUCKET）
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
} from '../src/utils/runArchive.js';
import { normalizeUrl } from '../src/utils/deliveredHistory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// .env のAWSキーはSES送信用でS3権限がないため、~/.aws の default プロファイルに委ねる
delete process.env.AWS_ACCESS_KEY_ID;
delete process.env.AWS_SECRET_ACCESS_KEY;

const MODEL = 'claude-haiku-4-5-20251001';
/** judge に渡すソース抜粋の上限文字数（トークン抑制） */
const SOURCE_EXCERPT_MAX = 1200;
/** タイトル類似による重複判定のしきい値（文字bigramのJaccard係数） */
const TITLE_SIM_THRESHOLD = 0.75;

// ---- CLI 引数 -----------------------------------------------------

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const noJudge = args.includes('--no-judge');
const localFile = argValue('--file');
const days = argValue('--days') ? Number(argValue('--days')) : undefined;
const bucket = argValue('--bucket') ?? process.env.STORAGE_BUCKET ?? '';

// ---- 重複率（コード計算） -----------------------------------------

function titleBigrams(title: string): Set<string> {
  const norm = title.toLowerCase().replace(/[\s　、。・「」『』（）()\[\]:：,.]/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < norm.length - 1; i++) grams.add(norm.slice(i, i + 2));
  return grams;
}

function titleSimilarity(a: string, b: string): number {
  const ga = titleBigrams(a);
  const gb = titleBigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}

interface SeenItem {
  url: string;
  title: string;
  isoDate: string;
}

interface DupResult {
  total: number;
  duplicates: Array<{ title: string; matchedTitle: string; matchedDate: string; reason: string }>;
}

function detectDuplicates(archive: RunArchive, seen: SeenItem[]): DupResult {
  const items = Object.values(archive.byTopic).flat();
  const duplicates: DupResult['duplicates'] = [];

  for (const item of items) {
    const url = normalizeUrl(item.url);
    const urlMatch = seen.find((s) => s.url === url);
    if (urlMatch) {
      duplicates.push({
        title: item.title,
        matchedTitle: urlMatch.title,
        matchedDate: urlMatch.isoDate,
        reason: 'url',
      });
      continue;
    }
    // 続報は新規扱い（タイトル先頭に「続報：」が付く運用）
    if (item.title.startsWith('続報')) continue;
    const simMatch = seen.find((s) => titleSimilarity(item.title, s.title) >= TITLE_SIM_THRESHOLD);
    if (simMatch) {
      duplicates.push({
        title: item.title,
        matchedTitle: simMatch.title,
        matchedDate: simMatch.isoDate,
        reason: 'title-similarity',
      });
    }
  }
  return { total: items.length, duplicates };
}

// ---- LLM-as-Judge（カテゴリ精度・見出し忠実性） --------------------

interface JudgeVerdict {
  url: string;
  category_ok: boolean;
  fidelity: 'ok' | 'ng' | 'unknown';
  note: string;
}

const JUDGE_FORMAT: Anthropic.JSONOutputFormat = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            category_ok: {
              type: 'boolean',
              description: '記事が割り当てトピックの定義に合致しているか',
            },
            fidelity: {
              type: 'string',
              enum: ['ok', 'ng', 'unknown'],
              description:
                'タイトルと要約が収集ソースに裏付けられているか。ソース抜粋に記事が見つからない場合は unknown',
            },
            note: { type: 'string', description: '判定理由（1文・ngとunknownのみ必須相当）' },
          },
          required: ['url', 'category_ok', 'fidelity', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['results'],
    additionalProperties: false,
  },
};

async function judgeRun(
  client: Anthropic,
  archive: RunArchive
): Promise<{ verdicts: JudgeVerdict[]; inputTokens: number; outputTokens: number }> {
  const items = Object.entries(archive.byTopic).flatMap(([topic, list]) =>
    list.map((i) => ({ topic, url: i.url, title: i.title, summary: i.summary }))
  );
  if (items.length === 0) return { verdicts: [], inputTokens: 0, outputTokens: 0 };

  const topicsDef = archive.topics
    .map((t) => `- ${t.id}（${t.label}）: キーワード例 [${t.keywords.join(', ')}]`)
    .join('\n');

  const sourcesText = archive.sources
    .map((s) => `=== [${s.topicId}] ${s.url} ===\n${s.content.slice(0, SOURCE_EXCERPT_MAX)}`)
    .join('\n\n');

  const itemsText = items
    .map(
      (i, idx) =>
        `${idx + 1}. [topic: ${i.topic}] ${i.title}\n   URL: ${i.url}\n   要約: ${i.summary}`
    )
    .join('\n');

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system:
      'あなたはニュース配信の品質監査員です。掲載記事を1件ずつ厳密に判定してください。',
    output_config: { format: JUDGE_FORMAT },
    messages: [
      {
        role: 'user',
        content: `${archive.isoDate} 配信の掲載記事を判定してください。

【トピック定義】
${topicsDef}

【判定基準】
- category_ok: 記事内容が割り当てられたトピック定義に合致していれば true
- fidelity: タイトル・要約が下記の収集ソース抜粋に裏付けられていれば ok、ソースと食い違う・誇張があれば ng、ソース抜粋内に該当記事が見つからなければ unknown（web検索由来の記事は通常 unknown になる）

【掲載記事】
${itemsText}

【収集ソース抜粋】
${sourcesText}`,
      },
    ],
  });

  const textBlock = response.content.find((c) => c.type === 'text');
  const verdicts =
    textBlock && textBlock.type === 'text'
      ? (JSON.parse(textBlock.text) as { results: JudgeVerdict[] }).results
      : [];
  return {
    verdicts,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

// ---- レポート -----------------------------------------------------

interface RunReport {
  isoDate: string;
  edition: string;
  items: number;
  dupRate: number;
  duplicates: DupResult['duplicates'];
  categoryAccuracy: number | null;
  fidelityPass: number | null;
  fidelityCoverage: number | null;
  verdicts: JudgeVerdict[];
}

function pct(v: number | null): string {
  return v === null ? '  —  ' : `${(v * 100).toFixed(0).padStart(4)}%`;
}

async function main() {
  // アーカイブの読み込み
  let archives: RunArchive[] = [];
  if (localFile) {
    archives = [JSON.parse(fs.readFileSync(localFile, 'utf-8')) as RunArchive];
    console.log(`ローカルファイルを評価: ${localFile}`);
  } else {
    if (!bucket) {
      console.error('エラー: --bucket または STORAGE_BUCKET 環境変数を指定してください。');
      process.exit(1);
    }
    const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'ap-northeast-1' });
    let keys = await listRunArchiveKeys(s3, bucket);
    if (days) keys = keys.slice(-days);
    console.log(`S3アーカイブ ${keys.length} 件を評価します（bucket: ${bucket}）`);
    for (const key of keys) {
      const a = await loadRunArchive(s3, bucket, key);
      if (a) archives.push(a);
    }
  }

  if (archives.length === 0) {
    console.log('評価対象のアーカイブがありません。配信が実行されると archive/ に蓄積されます。');
    return;
  }

  const client = noJudge ? null : new Anthropic();
  const seen: SeenItem[] = [];
  const reports: RunReport[] = [];
  let judgeInputTokens = 0;
  let judgeOutputTokens = 0;

  for (const archive of archives) {
    const dup = detectDuplicates(archive, seen);

    let categoryAccuracy: number | null = null;
    let fidelityPass: number | null = null;
    let fidelityCoverage: number | null = null;
    let verdicts: JudgeVerdict[] = [];

    if (client) {
      const judged = await judgeRun(client, archive);
      verdicts = judged.verdicts;
      judgeInputTokens += judged.inputTokens;
      judgeOutputTokens += judged.outputTokens;
      if (verdicts.length > 0) {
        categoryAccuracy = verdicts.filter((v) => v.category_ok).length / verdicts.length;
        const judged_ = verdicts.filter((v) => v.fidelity !== 'unknown');
        fidelityCoverage = judged_.length / verdicts.length;
        fidelityPass =
          judged_.length > 0
            ? judged_.filter((v) => v.fidelity === 'ok').length / judged_.length
            : null;
      }
    }

    reports.push({
      isoDate: archive.isoDate,
      edition: archive.edition,
      items: dup.total,
      dupRate: dup.total > 0 ? dup.duplicates.length / dup.total : 0,
      duplicates: dup.duplicates,
      categoryAccuracy,
      fidelityPass,
      fidelityCoverage,
      verdicts,
    });

    // 次の配信の重複判定用に蓄積
    for (const item of Object.values(archive.byTopic).flat()) {
      seen.push({ url: normalizeUrl(item.url), title: item.title, isoDate: archive.isoDate });
    }
  }

  // ---- 出力 ----
  console.log('\n## 配信別レポート\n');
  console.log('| 配信日 | 記事数 | 重複率 | カテゴリ精度 | 忠実性 | 忠実性判定率 |');
  console.log('|---|---|---|---|---|---|');
  for (const r of reports) {
    console.log(
      `| ${r.isoDate} | ${r.items} | ${pct(r.dupRate)} | ${pct(r.categoryAccuracy)} | ${pct(r.fidelityPass)} | ${pct(r.fidelityCoverage)} |`
    );
  }

  const totalItems = reports.reduce((s, r) => s + r.items, 0);
  const totalDups = reports.reduce((s, r) => s + r.duplicates.length, 0);
  const allVerdicts = reports.flatMap((r) => r.verdicts);
  const catOk = allVerdicts.filter((v) => v.category_ok).length;
  const fidJudged = allVerdicts.filter((v) => v.fidelity !== 'unknown');
  const fidOk = fidJudged.filter((v) => v.fidelity === 'ok').length;

  console.log('\n## 総合\n');
  console.log(`- 評価対象: ${reports.length} 配信 / ${totalItems} 記事`);
  console.log(`- 重複率: ${totalItems > 0 ? ((totalDups / totalItems) * 100).toFixed(1) : '—'}%（${totalDups}/${totalItems}）`);
  if (allVerdicts.length > 0) {
    console.log(`- カテゴリ精度: ${((catOk / allVerdicts.length) * 100).toFixed(1)}%（${catOk}/${allVerdicts.length}）`);
    console.log(
      `- 見出し忠実性: ${fidJudged.length > 0 ? ((fidOk / fidJudged.length) * 100).toFixed(1) : '—'}%（${fidOk}/${fidJudged.length}、判定率 ${((fidJudged.length / allVerdicts.length) * 100).toFixed(0)}%）`
    );
    const judgeCost = (judgeInputTokens / 1e6) * 1 + (judgeOutputTokens / 1e6) * 5;
    console.log(`- judge コスト: $${judgeCost.toFixed(4)}（入力 ${judgeInputTokens} / 出力 ${judgeOutputTokens} トークン）`);
  }

  // 問題のあった項目の詳細
  const issues = [
    ...reports.flatMap((r) =>
      r.duplicates.map((d) => `- [重複 ${r.isoDate}] 「${d.title}」 ≒ 「${d.matchedTitle}」(${d.matchedDate}, ${d.reason})`)
    ),
    ...reports.flatMap((r) =>
      r.verdicts
        .filter((v) => !v.category_ok || v.fidelity === 'ng')
        .map((v) => `- [judge ${r.isoDate}] ${v.url}: category_ok=${v.category_ok}, fidelity=${v.fidelity} — ${v.note}`)
    ),
  ];
  if (issues.length > 0) {
    console.log('\n## 検出された問題\n');
    issues.forEach((i) => console.log(i));
  }

  // JSON保存
  const outDir = path.resolve(__dirname, '../eval-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `eval-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
  console.log(`\n結果を保存しました: ${outPath}`);
}

main().catch((err) => {
  console.error('評価ハーネスの実行に失敗:', err instanceof Error ? err.message : err);
  process.exit(1);
});
