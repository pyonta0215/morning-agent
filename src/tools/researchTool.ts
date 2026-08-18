import { search, trending } from 'research-hub-mcp/lib';
import type { Item } from 'research-hub-mcp/schema';
import type { ResearchSpec, Topic } from '../agents/base.js';
import { normalizeUrl } from '../utils/deliveredHistory.js';
import { collectHuggingFaceModels } from './hfTool.js';

// research-hub（HN / arXiv / GitHub / RSS）から候補記事を集める薄いアダプタ。
// MCPプロトコルは介さず service 層の関数を直接呼ぶ（Lambdaのバッチ処理では往復が純粋な損なため）。
// 責務は「取得の正規化」まで。選別・スコア付けは WebAgent の集約フェーズ（Haiku）に委ねる。

/** 1クエリ・1ソースあたりの取得件数 */
const DEFAULT_LIMIT = 3;
/** 1トピックが集約フェーズへ持ち込める上限（プロンプト肥大の安全弁） */
const MAX_ITEMS_PER_TOPIC = 12;
/** 1呼び出しのハードタイムアウト。arXivは実測6〜14秒かかるため長め、ただし朝刊は止めない */
const CALL_TIMEOUT_MS = 20_000;

export interface ResearchCollectResult {
  items: Item[];
  /** ソース別ヒット数（マージ前） */
  stats: Record<string, number>;
  /** 失敗したソース・クエリ。1件でも取れれば朝刊は続行する */
  errors: string[];
}

/** 指定時間で解決しなければ reject する。research-hub 側のfetchタイムアウトを跨ぐ最終防壁 */
function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: ${CALL_TIMEOUT_MS}ms でタイムアウト`)),
      CALL_TIMEOUT_MS
    );
    // 成功・失敗時にタイマーを必ず破棄する。Promise.raceだけでは成功後も20秒残り、
    // ローカル実行やLambdaのイベントループを不要に待たせてしまう。
    timer.unref();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** 検索クエリ。spec.queries が無ければトピックの keywords を1語ずつ使う（AND検索で0件になるのを避ける） */
function resolveQueries(topic: Topic, spec: ResearchSpec): string[] {
  const q = spec.search?.queries ?? topic.keywords;
  return q.filter((s) => s.trim().length > 0);
}

/**
 * 1トピック分の候補を集める。1呼び出しの失敗は errors に積むだけで全体は落とさない
 * （research-hub 自身の部分成功ポリシーと、Pipeline の「1エージェント失敗で止めない」方針に合わせる）。
 */
export async function collectResearch(
  topic: Topic,
  options: { excludeUrls?: Set<string> } = {}
): Promise<ResearchCollectResult> {
  const spec = topic.research;
  if (!spec) return { items: [], stats: {}, errors: [] };

  const calls: Array<{ label: string; run: () => Promise<{ items: Item[]; stats: Record<string, number>; errors: string[] }> }> = [];

  if (spec.search) {
    const { sources, since, limit } = spec.search;
    for (const query of resolveQueries(topic, spec)) {
      calls.push({
        label: `search(${query})`,
        run: () =>
          search({
            query,
            sources,
            since,
            limit: limit ?? DEFAULT_LIMIT,
            // 既定は score 降順。date 順にすると HN の投稿直後（数ポイントのShow HN等）ばかりを
            // 拾って編集価値が無くなる（2026-08-06 の初回ドライランで採用0件を実測）
            sort: spec.search?.sort ?? 'score',
          }),
      });
    }
  }

  for (const t of spec.trending ?? []) {
    calls.push({
      label: `trending(${t.source})`,
      run: () =>
        trending({
          source: t.source,
          category: t.category,
          period: t.period ?? 'day',
          limit: t.limit ?? DEFAULT_LIMIT,
        }),
    });
  }

  if (spec.huggingFace) {
    calls.push({
      label: 'huggingface',
      run: () => collectHuggingFaceModels(spec.huggingFace!),
    });
  }

  const settled = await Promise.allSettled(
    calls.map((c) => withTimeout(c.run(), c.label))
  );

  const stats: Record<string, number> = {};
  const errors: string[] = [];
  const merged: Item[] = [];
  const seen = new Set<string>(options.excludeUrls ?? []);

  settled.forEach((s, i) => {
    if (s.status === 'rejected') {
      errors.push(`${calls[i].label}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`);
      return;
    }
    // research-hub は一部ソース失敗を errors に載せて成功扱いで返す。握りつぶさず伝播させる
    for (const e of s.value.errors) errors.push(`${calls[i].label}: ${e}`);
    for (const [name, n] of Object.entries(s.value.stats)) stats[name] = (stats[name] ?? 0) + n;

    for (const item of s.value.items) {
      const key = normalizeUrl(item.url ?? item.id);
      if (seen.has(key)) continue; // クエリ間の重複・配信済みURLを落とす
      seen.add(key);
      merged.push(item);
    }
  });

  // 打ち切り順の決定のみに使う並び。score はソース内でしか比較できないので、
  // 単一ソース指定（推奨構成）以外では実質「日付降順」として働く
  merged.sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.published_at ?? '').localeCompare(a.published_at ?? '')
  );
  return { items: merged.slice(0, MAX_ITEMS_PER_TOPIC), stats, errors };
}

/**
 * 集約フェーズのプロンプトに載せるテキスト。既存の RSS 整形（webFetchTool.parseRss）と同じ体裁に揃え、
 * 集約プロンプト側を変更せずに読ませる。HNスコア等は「客観シグナル」として編集判断の材料に残す。
 */
export function formatResearchBlock(items: Item[]): string {
  if (items.length === 0) return '（新着記事はありませんでした）';
  return items
    .map((it, i) => {
      const signals = [
        it.source,
        it.score !== undefined ? `スコア${it.score}` : '',
        it.num_comments !== undefined ? `コメント${it.num_comments}` : '',
      ]
        .filter(Boolean)
        .join(' / ');
      return [
        `[記事${i + 1}]`,
        `タイトル: ${it.title}`,
        `URL: ${it.url ?? it.discussion_url ?? ''}`,
        it.published_at ? `日付: ${it.published_at}` : '',
        `出典: ${signals}`,
        it.snippet ? `概要: ${it.snippet}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');
}

/** 研究ハブが実際に返したURL集合。集約結果の origin 判定に使う（このURLは実在が保証される） */
export function researchUrlSet(items: Item[]): Set<string> {
  const set = new Set<string>();
  for (const it of items) {
    if (it.url) set.add(normalizeUrl(it.url));
    if (it.discussion_url) set.add(normalizeUrl(it.discussion_url));
  }
  return set;
}
