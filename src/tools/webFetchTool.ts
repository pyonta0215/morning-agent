import axios from 'axios';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export const webFetchToolDefinition: Tool = {
  name: 'fetch_webpage',
  description: '指定URLのWebページ本文テキストを取得する。RSS/Atomフィードは記事リストとして返す。',
  input_schema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: '取得するWebページのURL',
      },
      maxLength: {
        type: 'number',
        description: '取得するテキストの最大文字数（デフォルト: 3000）',
      },
    },
    required: ['url'],
  },
};

interface FetchInput {
  url: string;
  maxLength?: number;
}

interface FetchResult {
  url: string;
  text?: string;
  error?: string;
}

/** RSS/Atom かどうかを判定 */
function isRss(body: string): boolean {
  const head = body.trimStart().slice(0, 200);
  return /<rss|<feed|<channel/i.test(head);
}

/** RSS/Atom の <item> / <entry> を構造化テキストに変換 */
function parseRss(body: string, maxItems = 20): string {
  // <item>...</item> または <entry>...</entry> を抽出
  const itemPattern = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  const items: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(body)) !== null && items.length < maxItems) {
    const block = match[1];

    const title = extractTag(block, 'title');
    // RSS の <link> は self-closing でない場合とCDATA両方を考慮
    const link =
      extractTag(block, 'link') ||
      extractAttr(block, 'link', 'href') ||
      extractTag(block, 'guid');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published');
    const description =
      stripTags(extractTag(block, 'description') || extractTag(block, 'summary'))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);

    if (!title && !link) continue;

    items.push(
      [
        `タイトル: ${title}`,
        `URL: ${link}`,
        pubDate ? `日付: ${pubDate}` : '',
        description ? `概要: ${description}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  }

  return items.length > 0
    ? items.map((item, i) => `[記事${i + 1}]\n${item}`).join('\n\n')
    : '（記事が見つかりませんでした）';
}

function extractTag(block: string, tag: string): string {
  const m =
    block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, 'i')) ||
    block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function extractAttr(block: string, tag: string, attr: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`, 'i'));
  return m ? m[1].trim() : '';
}

function stripTags(str: string): string {
  return str.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

export async function handleWebFetch(input: FetchInput): Promise<FetchResult> {
  const { url, maxLength = 3000 } = input;
  console.log(`[webFetch] fetching: ${url}`);

  try {
    const response = await axios.get<string>(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MorningAgentBot/1.0)',
      },
      responseType: 'text',
    });

    const body: string = response.data;

    // RSS/Atom なら記事リストとして返す
    if (isRss(body)) {
      const text = parseRss(body).slice(0, maxLength * 3); // RSS は情報量が多いので制限を緩く
      console.log(`[webFetch] rss ok: ${url} (${text.length} chars)`);
      return { url, text };
    }

    // 通常 HTML
    let html = body;
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    html = html.replace(/<footer[\s\S]*?<\/footer>/gi, '');

    const text = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, maxLength);

    console.log(`[webFetch] ok: ${url} (${text.length} chars)`);
    return { url, text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.warn(`[webFetch] failed: ${url} — ${error}`);
    return { url, error: `取得失敗: ${error}` };
  }
}
