import type { Item } from 'research-hub-mcp/schema';
import type { HuggingFaceSpec } from '../agents/base.js';

const API_URL = 'https://huggingface.co/api/models';
const DEFAULT_LIMIT_PER_AUTHOR = 5;
const DEFAULT_SINCE_DAYS = 7;
const DEFAULT_MAX_ITEMS = 12;
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface HfModel {
  id?: string;
  modelId?: string;
  author?: string;
  createdAt?: string;
  lastModified?: string;
  downloads?: number;
  likes?: number;
  pipeline_tag?: string;
  tags?: string[];
}

export interface HuggingFaceCollectResult {
  items: Item[];
  stats: Record<string, number>;
  errors: string[];
}

interface ModelGroup {
  representative: HfModel & { id: string };
  latestActivity: string;
  variants: number;
}

function modelId(model: HfModel): string | undefined {
  return model.id ?? model.modelId;
}

function activityAt(model: HfModel): string | undefined {
  return model.lastModified ?? model.createdAt;
}

/** APIのbase_modelタグを優先し、無い場合だけ代表的な派生サフィックスを畳む */
export function canonicalModelId(model: HfModel): string | undefined {
  const id = modelId(model);
  if (!id) return undefined;

  const baseTag = model.tags?.find((tag) => tag.startsWith('base_model:'));
  if (baseTag) {
    const base = baseTag.slice('base_model:'.length);
    if (base.includes('/')) return base;
  }

  return id.replace(
    /(?:-(?:instruct|chat|base|fp(?:8|16|32)|bf16|awq|gptq|gguf|mlx|int(?:4|8)))+$/i,
    ''
  );
}

function preferRepresentative(
  current: HfModel & { id: string },
  candidate: HfModel & { id: string },
  canonicalId: string
): HfModel & { id: string } {
  if (candidate.id === canonicalId && current.id !== canonicalId) return candidate;
  if (current.id === canonicalId && candidate.id !== canonicalId) return current;
  if ((candidate.likes ?? 0) !== (current.likes ?? 0)) {
    return (candidate.likes ?? 0) > (current.likes ?? 0) ? candidate : current;
  }
  return (candidate.downloads ?? 0) > (current.downloads ?? 0) ? candidate : current;
}

async function fetchAuthorModels(
  author: string,
  limit: number,
  fetchImpl: FetchLike
): Promise<HfModel[]> {
  const url = new URL(API_URL);
  url.searchParams.set('author', author);
  url.searchParams.set('sort', 'lastModified');
  url.searchParams.set('direction', '-1');
  url.searchParams.set('limit', String(limit));

  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'morning-agent/1.0' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error('モデル一覧が配列ではありません');
  return body as HfModel[];
}

/**
 * 公式Organizationのモデルだけを取得し、量子化・形式違いをシリーズ単位に畳む。
 * Organizationごとの失敗はerrorsへ積み、取れたOrganizationだけで続行する。
 */
export async function collectHuggingFaceModels(
  spec: HuggingFaceSpec,
  options: { now?: Date; fetchImpl?: FetchLike } = {}
): Promise<HuggingFaceCollectResult> {
  const now = options.now ?? new Date();
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = spec.limitPerAuthor ?? DEFAULT_LIMIT_PER_AUTHOR;
  const cutoff = now.getTime() - (spec.sinceDays ?? DEFAULT_SINCE_DAYS) * 86_400_000;

  const settled = await Promise.allSettled(
    spec.authors.map((author) => fetchAuthorModels(author, limit, fetchImpl))
  );

  const errors: string[] = [];
  const recent: HfModel[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'rejected') {
      errors.push(`${spec.authors[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return;
    }
    for (const model of result.value) {
      const activity = activityAt(model);
      if (activity && Date.parse(activity) >= cutoff) recent.push(model);
    }
  });

  const groups = new Map<string, ModelGroup>();
  for (const model of recent) {
    const id = modelId(model);
    const canonicalId = canonicalModelId(model);
    const activity = activityAt(model);
    if (!id || !canonicalId || !activity) continue;

    const candidate = { ...model, id };
    const current = groups.get(canonicalId);
    if (!current) {
      groups.set(canonicalId, { representative: candidate, latestActivity: activity, variants: 1 });
      continue;
    }
    current.representative = preferRepresentative(current.representative, candidate, canonicalId);
    if (activity > current.latestActivity) current.latestActivity = activity;
    current.variants++;
  }

  const items = [...groups.entries()]
    .sort(([, a], [, b]) => b.latestActivity.localeCompare(a.latestActivity))
    .slice(0, spec.maxItems ?? DEFAULT_MAX_ITEMS)
    .map(([canonicalId, group]): Item => {
      const model = group.representative;
      const signals = [
        model.pipeline_tag,
        `likes ${model.likes ?? 0}`,
        `downloads ${model.downloads ?? 0}`,
        group.variants > 1 ? `派生${group.variants}件を統合` : '',
      ].filter(Boolean);
      return {
        id: `huggingface:${canonicalId}`,
        source: 'huggingface',
        type: 'release',
        title: model.id,
        url: `https://huggingface.co/${model.id}`,
        author: model.author ?? model.id.split('/')[0],
        published_at: group.latestActivity,
        score: model.likes ?? 0,
        snippet: signals.join(' / '),
      };
    });

  return { items, stats: { huggingface: items.length }, errors };
}
