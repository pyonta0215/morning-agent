import { collectHuggingFaceModels } from '../src/tools/hfTool.js';

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) {
    console.error(`FAIL ${name}`, detail ?? '');
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${name}`);
}

const fixtures: Record<string, unknown[]> = {
  Qwen: [
    {
      id: 'Qwen/Qwen3.8-27B',
      author: 'Qwen',
      createdAt: '2026-08-10T00:00:00.000Z',
      lastModified: '2026-08-16T00:00:00.000Z',
      likes: 1000,
      downloads: 5000,
      pipeline_tag: 'text-generation',
      tags: [],
    },
    {
      id: 'Qwen/Qwen3.8-27B-FP8',
      author: 'Qwen',
      createdAt: '2026-08-11T00:00:00.000Z',
      lastModified: '2026-08-17T00:00:00.000Z',
      likes: 50,
      downloads: 2000,
      tags: ['base_model:Qwen/Qwen3.8-27B'],
    },
    {
      id: 'Qwen/Old-Model',
      lastModified: '2026-07-01T00:00:00.000Z',
      likes: 9999,
      tags: [],
    },
  ],
};

const requested: URL[] = [];
const fetchMock: typeof fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  requested.push(url);
  const author = url.searchParams.get('author') ?? '';
  if (author === 'broken-org') return new Response('unavailable', { status: 503 });
  return new Response(JSON.stringify(fixtures[author] ?? []), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const result = await collectHuggingFaceModels(
  {
    authors: ['Qwen', 'broken-org'],
    limitPerAuthor: 3,
    sinceDays: 7,
    maxItems: 5,
  },
  { now: new Date('2026-08-18T00:00:00.000Z'), fetchImpl: fetchMock }
);

check(
  'Organizationごとにauthor・sort・limitを指定する',
  requested.every(
    (url) =>
      Boolean(url.searchParams.get('author')) &&
      url.searchParams.get('sort') === 'lastModified' &&
      url.searchParams.get('direction') === '-1' &&
      url.searchParams.get('limit') === '3'
  )
);
check('base_modelタグの派生版を1系列に畳む', result.items.length === 1, result.items);
check(
  '代表URLは量子化版でなく基底モデル',
  result.items[0]?.url === 'https://huggingface.co/Qwen/Qwen3.8-27B',
  result.items[0]
);
check(
  '系列の最新更新日時を保つ',
  result.items[0]?.published_at === '2026-08-17T00:00:00.000Z',
  result.items[0]
);
check(
  '古いモデルは候補に入れない',
  !result.items.some((item) => item.title.includes('Old-Model')),
  result.items
);
check(
  '一部Organization失敗でも成功分を返す',
  result.errors.length === 1 && result.errors[0]?.includes('broken-org'),
  result.errors
);

if (process.exitCode) process.exit(process.exitCode);
