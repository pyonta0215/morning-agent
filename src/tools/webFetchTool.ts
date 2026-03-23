import axios from 'axios';
import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export const webFetchToolDefinition: Tool = {
  name: 'fetch_webpage',
  description: '指定URLのWebページ本文テキストを取得する',
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

export async function handleWebFetch(input: FetchInput): Promise<FetchResult> {
  const { url, maxLength = 3000 } = input;

  try {
    const response = await axios.get<string>(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MorningAgentBot/1.0)',
      },
      responseType: 'text',
    });

    let html: string = response.data;

    // script / style / nav / footer タグを除去
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    html = html.replace(/<footer[\s\S]*?<\/footer>/gi, '');

    // HTMLタグを除去してテキスト抽出
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

    return { url, text };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { url, error: `取得失敗: ${error}` };
  }
}
