import Anthropic from '@anthropic-ai/sdk';
import type { SesClient } from '../clients/sesClient.js';
import { type Agent, type AgentInput, type AgentOutput, type AppConfig } from './base.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';
import type { WebAgentData, WebItem } from './webAgent.js';
import type { EditorialContext } from '../utils/editorialContext.js';

const MODEL = 'claude-haiku-4-5-20251001';

export class ComposerAgent implements Agent {
  readonly id = 'composer';
  private client: Anthropic;

  constructor(
    private sesClient: SesClient,
    private config: AppConfig,
    private dryRun: boolean = false,
    /** trueのとき: メール送信せずsubject/htmlBody/textBodyをdataに返す */
    private buildOnly: boolean = false,
    private edition: 'morning' | 'evening' = 'morning',
    /** 前回配信のコンテキスト（朝刊→夕刊の継続性に使用） */
    private previousContext: EditorialContext | null = null
  ) {
    this.client = new Anthropic();
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now();
    const context = input.context ?? [];
    const webData = context.find((c) => c.agentId === 'web')?.data as WebAgentData | undefined;
    const dateStr = formatDateJST(input.date);

    const allItems = Object.values(webData?.byTopic ?? {}).flat();

    // 前回コンテキストがある場合の継続性プロンプトを構築
    const prevContextSection = this.previousContext
      ? `
【前回の朝刊で取り上げた注目記事】
${this.previousContext.picks.map((p) => `・${p.title}：${p.comment}`).join('\n')}

夕刊では以下の方針で選んでください：
- 朝刊から進展があったトピックは積極的に取り上げ、変化を補足してください
- 朝刊と同じ記事の重複選出は避けてください
- 朝刊が扱っていない視点や新しいトピックも1件含めてください
`
      : '';

    // Claude には「注目トピック」の editorial コメントだけ生成させる
    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: 'あなたは朝刊エージェント便の編集長です。簡潔・実用的な日本語で出力してください。',
      messages: [
        {
          role: 'user',
          content: `以下の記事一覧から、今日（${dateStr}）特に注目すべき記事を3件選んで、
それぞれ1〜2文のコメントを添えてください。
${prevContextSection}
記事一覧:
${allItems.map((item) => `- [${item.topic}] ${item.title} (score:${item.score})`).join('\n')}

出力形式（JSON）:
{
  "picks": [
    { "title": "記事タイトル", "comment": "注目理由や要点を1〜2文で" }
  ]
}`,
        },
      ],
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const durationMs = Date.now() - startTime;
    const costUsd = calcCost({ input_tokens: inputTokens, output_tokens: outputTokens }, MODEL);

    logLlm({
      traceId: process.env.AWS_LAMBDA_REQUEST_ID ?? 'local',
      agentId: this.id,
      model: MODEL,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
      success: true,
    });

    let picks: Array<{ title: string; comment: string }> = [];
    const textBlock = response.content.find((c) => c.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      try {
        const jsonMatch =
          textBlock.text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ??
          textBlock.text.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as {
            picks: typeof picks;
          };
          picks = parsed.picks ?? [];
        }
      } catch {
        console.warn('[ComposerAgent] Failed to parse picks response');
      }
    }

    const editionLabel = this.edition === 'evening' ? '夕刊' : '朝刊';
    const subject = `[${editionLabel}エージェント便] ${dateStr} ピックアップ情報`;
    const htmlBody = buildHtmlEmail(dateStr, webData, picks, this.edition);
    const textBody = buildTextEmail(dateStr, webData, picks, this.edition);

    if (this.buildOnly) {
      console.log('[ComposerAgent] buildOnly: returning email content without sending');
      return {
        agentId: this.id,
        data: { subject, htmlBody, textBody, topicsCount: allItems.length, picks },
        tokensUsed: inputTokens + outputTokens,
        durationMs,
      };
    }

    if (!this.dryRun) {
      await this.sesClient.sendEmail({
        from: this.config.senderEmail,
        to: this.config.recipientEmail,
        subject,
        htmlBody,
        textBody,
      });
      console.log(`[ComposerAgent] Email sent to ${this.config.recipientEmail}`);
    } else {
      console.log('[ComposerAgent] Dry run: skipping email send');
      console.log('Subject:', subject);
    }

    return {
      agentId: this.id,
      data: { subject, topicsCount: allItems.length },
      tokensUsed: inputTokens + outputTokens,
      durationMs,
    };
  }
}

// ---- 定数 --------------------------------------------------------

/** スコア別の抜粋最大文字数 */
const EXCERPT_MAX: Record<number, number> = { 5: 200, 4: 100, 3: 60, 2: 0, 1: 0 };

/** スコア別のグリッドspan（6カラム基準） */
const GRID_SPAN: Record<number, number> = { 5: 6, 4: 3, 3: 2, 2: 2, 1: 2 };

// ---- HTML ビルダー ------------------------------------------------

function buildHtmlEmail(
  dateStr: string,
  webData: WebAgentData | undefined,
  picks: Array<{ title: string; comment: string }>,
  edition: 'morning' | 'evening' = 'morning'
): string {
  const editionLabel = edition === 'evening' ? '夕刊' : '朝刊';
  const byTopic = webData?.byTopic ?? {};

  const pickSection =
    picks.length > 0
      ? `<div class="section">
    <div class="section-label">🔥 今日の注目</div>
    ${picks.map((p) => `
    <div class="pick-card">
      <div class="pick-title">${escHtml(p.title)}</div>
      <div class="pick-comment">${escHtml(p.comment)}</div>
    </div>`).join('')}
  </div>`
      : '';

  const topicSections = Object.entries(byTopic)
    .map(([topic, items]) => topicSection(topic, items))
    .join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Yu Gothic', 'Segoe UI', sans-serif;
    background: #e8eaed;
    color: #111;
    padding: 12px;
  }
  .container { max-width: 620px; margin: 0 auto; }

  /* ── 新聞ヘッダー ── */
  .masthead {
    background: #111;
    color: #fff;
    text-align: center;
    padding: 18px 16px 14px;
    border-radius: 4px 4px 0 0;
    border-bottom: 3px solid #c00;
    margin-bottom: 12px;
  }
  .masthead-name {
    font-size: 26px;
    font-weight: 900;
    letter-spacing: 4px;
    font-feature-settings: "palt";
  }
  .masthead-date {
    font-size: 11px;
    color: #aaa;
    margin-top: 4px;
    letter-spacing: 1px;
  }

  /* ── セクション ── */
  .section { margin-bottom: 16px; }
  .section-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #c00;
    border-bottom: 2px solid #c00;
    padding-bottom: 4px;
    margin-bottom: 10px;
  }

  /* ── 注目ピック ── */
  .pick-card {
    background: #fff;
    border-left: 3px solid #c00;
    padding: 10px 12px;
    margin-bottom: 8px;
    border-radius: 0 4px 4px 0;
  }
  .pick-title { font-size: 13px; font-weight: 700; margin-bottom: 3px; }
  .pick-comment { font-size: 12px; color: #555; line-height: 1.5; }

  /* ── トピックブロック ── */
  .topic-block {
    background: #fff;
    border-radius: 4px;
    margin-bottom: 16px;
    overflow: hidden;
    border: 1px solid #ddd;
  }
  .topic-banner {
    background: #111;
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    padding: 6px 12px;
    letter-spacing: 1px;
    border-bottom: 2px solid #c00;
  }

  /* ── グリッド（6カラム） ── */
  .article-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 1px;
    background: #ddd; /* gap の色 */
  }

  /* スコア別セル */
  .cell { background: #fff; padding: 10px 11px; overflow: hidden; }
  .cell-6 { grid-column: span 6; border-bottom: 1px solid #e0e0e0; }
  .cell-3 { grid-column: span 3; }
  .cell-2 { grid-column: span 2; }

  /* スコア5: ヒーロー */
  .cell-6 .art-title { font-size: 17px; font-weight: 800; line-height: 1.3; }
  .cell-6 .art-excerpt { font-size: 13px; color: #333; margin-top: 5px; line-height: 1.6; }

  /* スコア4: フィーチャー */
  .cell-3 .art-title { font-size: 14px; font-weight: 700; line-height: 1.3; }
  .cell-3 .art-excerpt { font-size: 12px; color: #444; margin-top: 4px; line-height: 1.5; }

  /* スコア3: スタンダード */
  .cell-2 .art-title { font-size: 12px; font-weight: 600; line-height: 1.3; }
  .cell-2 .art-excerpt { font-size: 11px; color: #555; margin-top: 3px; line-height: 1.4; }

  .art-title a { color: #111; text-decoration: none; }
  .art-title a:hover { text-decoration: underline; }
  .art-score { font-size: 10px; color: #c00; font-weight: 700; margin-top: 5px; }

  /* ── フッター ── */
  .footer {
    text-align: center;
    font-size: 10px;
    color: #999;
    padding: 12px 0 4px;
    border-top: 1px solid #ccc;
    margin-top: 8px;
  }
</style>
</head>
<body>
<div class="container">

  <div class="masthead">
    <div class="masthead-name">${editionLabel}エージェント便</div>
    <div class="masthead-date">${dateStr}</div>
  </div>

  ${pickSection}

  ${topicSections || '<p style="color:#999;font-size:13px;padding:8px;">記事が見つかりませんでした</p>'}

  <div class="footer">${editionLabel}エージェント便 — 情報は各リンク先でご確認ください</div>
</div>
</body>
</html>`;
}

function topicSection(topic: string, items: WebItem[]): string {
  const sorted = [...items].sort((a, b) => b.score - a.score);

  const cells = sorted.map((item) => {
    const span = GRID_SPAN[item.score] ?? 2;
    const maxChars = EXCERPT_MAX[item.score] ?? 0;
    const excerpt =
      maxChars > 0
        ? `<div class="art-excerpt">${escHtml(item.summary.slice(0, maxChars))}${item.summary.length > maxChars ? '…' : ''}</div>`
        : '';
    const scoreLabel = '●'.repeat(item.score) + '○'.repeat(5 - item.score);

    return `<div class="cell cell-${span}">
  <div class="art-title"><a href="${escHtml(item.url)}" target="_blank" rel="noopener">${escHtml(item.title)}</a></div>
  ${excerpt}
  <div class="art-score">${scoreLabel}</div>
</div>`;
  });

  return `<div class="topic-block">
  <div class="topic-banner">${escHtml(topic)}</div>
  <div class="article-grid">
    ${cells.join('\n    ')}
  </div>
</div>`;
}

function articleCard(_item: WebItem): string {
  return ''; // topicSection に統合したため未使用
}

/** JST の日付を YYYY/MM/DD(曜) 形式で返す */
export function formatDateJST(date: Date): string {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  const iso = date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD
  const [year, month, day] = iso.split('-');
  const jstNoon = new Date(`${iso}T12:00:00+09:00`);
  return `${year}/${month}/${day}(${weekdays[jstNoon.getDay()]})`;
}

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- テキスト版 ---------------------------------------------------

function buildTextEmail(
  dateStr: string,
  webData: WebAgentData | undefined,
  picks: Array<{ title: string; comment: string }>,
  edition: 'morning' | 'evening' = 'morning'
): string {
  const editionLabel = edition === 'evening' ? '夕刊' : '朝刊';
  const byTopic = webData?.byTopic ?? {};
  const lines: string[] = [`${editionLabel}エージェント便 ${dateStr}`, ''];

  if (picks.length > 0) {
    lines.push('== 今日の注目 ==');
    picks.forEach((p) => {
      lines.push(`・${p.title}`);
      lines.push(`  ${p.comment}`);
    });
    lines.push('');
  }

  Object.entries(byTopic).forEach(([topic, items]) => {
    lines.push(`== ${topic} ==`);
    items
      .sort((a, b) => b.score - a.score)
      .forEach((item) => {
        lines.push(`・${item.title}`);
        lines.push(`  ${item.summary}`);
        lines.push(`  ${item.url}`);
      });
    lines.push('');
  });

  lines.push('---');
  lines.push(`${editionLabel}エージェント便`);
  return lines.join('\n');
}
