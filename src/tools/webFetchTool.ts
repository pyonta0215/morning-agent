import axios from 'axios';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';
import { normalizeUrl } from '../utils/deliveredHistory.js';

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
  /** RSS/Atom: この日時より古い記事を除外する（日付不明の記事は残す） */
  sinceDate?: Date;
  /** RSS/Atom: 除外するURL集合（normalizeUrl で正規化済みであること） */
  excludeUrls?: Set<string>;
}

interface FetchResult {
  url: string;
  text?: string;
  error?: string;
  /** RSS のとき、LLMを通さずに確定する情報（#1）。HTML取得のときは undefined */
  rssItems?: RssItemMeta[];
}

/**
 * RSS/Atom/RDF かどうかを判定する。
 *
 * 先頭200字・`<rss|<feed|<channel` だけを見ていたころ、**RSS 1.0（RDF）が漏れていた**。
 * RDFは `<rdf:RDF ...>` の名前空間宣言が長く、`<channel>` が200字の外に出る
 * （e-Gov パブリックコメントで実測 約190字、4gamer も同型）。漏れるとフィードが
 * HTMLとして雑にタグ剥がしされ、記事URLも日付も取れないまま本文だけがLLMに渡る。
 *
 * 窓を広げるかわりに、HTMLを先に弾く。HTMLの `<head>` には RSS 自動検出用の
 * `<link type="application/rss+xml">` が入っていることがあるため。
 */
export function isRss(body: string): boolean {
  const head = body.trimStart().slice(0, 1000);
  if (/^<(?:!doctype\s+html|html)\b/i.test(head)) return false;
  return /<(?:rss|feed|rdf:RDF|channel)[\s>]/i.test(head);
}

/**
 * RSS の1件から取れる、LLMを通さずに確定する情報（#1）。
 * 本文テキストはLLMに渡すが、こちらは**素通しで記事に付ける**。
 * LLMに要約させたものと違い、あとから検証できる値だけをここに入れる。
 */
export interface RssItemMeta {
  url: string;
  /** RSS の生の見出し。Google News は末尾に発行元が付く */
  title: string;
  guid?: string;
  pubDate?: string;
  /** <source url="..."> */
  sourceUrl?: string;
  /** <source> のテキスト。「PC Watch」など */
  sourceName?: string;
}

interface ParseRssOptions {
  maxItems?: number;
  sinceDate?: Date;
  excludeUrls?: Set<string>;
}

/** RSS/Atom の <item> / <entry> を構造化テキストに変換し、素通しの情報も併せて返す */
export function parseRss(
  body: string,
  options: ParseRssOptions = {}
): { text: string; metas: RssItemMeta[] } {
  const { maxItems = 10, sinceDate, excludeUrls } = options;
  const metas: RssItemMeta[] = [];
  // <item>...</item> または <entry>...</entry> を抽出
  const itemPattern = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  const items: string[] = [];
  let skippedOld = 0;
  let skippedDelivered = 0;

  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(body)) !== null && items.length < maxItems) {
    const block = match[1];

    const title = extractTag(block, 'title');
    // RSS の <link> は self-closing でない場合とCDATA両方を考慮
    const link =
      extractTag(block, 'link') ||
      extractAttr(block, 'link', 'href') ||
      extractTag(block, 'guid');
    // RSS 2.0 は pubDate、Atom は published/updated、RSS 1.0（RDF）は dc:date。
    // dc:date を見ないと RDF の記事は全て「日付不明＝最新扱い」になり、sinceDate で古い記事を切れない
    const pubDate =
      extractTag(block, 'pubDate') ||
      extractTag(block, 'published') ||
      extractTag(block, 'dc:date') ||
      extractTag(block, 'updated');
    const description =
      stripTags(extractTag(block, 'description') || extractTag(block, 'summary'))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);

    if (!title && !link) continue;

    // 古い記事をコード側で除外（日付がパースできない記事は最新扱いで残す）
    if (sinceDate && pubDate) {
      const parsed = new Date(pubDate);
      if (!Number.isNaN(parsed.getTime()) && parsed < sinceDate) {
        skippedOld++;
        continue;
      }
    }

    // 配信済みURLを除外
    if (excludeUrls && link && excludeUrls.has(normalizeUrl(link))) {
      skippedDelivered++;
      continue;
    }

    metas.push({
      url: link,
      title,
      guid: extractTag(block, 'guid') || undefined,
      pubDate: pubDate || undefined,
      sourceUrl: extractAttr(block, 'source', 'url') || undefined,
      sourceName: extractTag(block, 'source') || undefined,
    });

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

  if (skippedOld > 0 || skippedDelivered > 0) {
    console.log(`[webFetch] rss filtered: ${skippedOld} old, ${skippedDelivered} delivered`);
  }

  const text =
    items.length > 0
      ? items.map((item, i) => `[記事${i + 1}]\n${item}`).join('\n\n')
      : '（新着記事はありませんでした）';
  return { text, metas };
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
  const { url, maxLength = 3000, sinceDate, excludeUrls } = input;
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
      const parsed = parseRss(body, { sinceDate, excludeUrls });
      const text = parsed.text.slice(0, maxLength);
      console.log(`[webFetch] rss ok: ${url} (${text.length} chars, ${parsed.metas.length} items)`);
      // metas は maxLength で切らない。LLMには渡さず、記事に素通しで付ける情報なので
      return { url, text, rssItems: parsed.metas };
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
