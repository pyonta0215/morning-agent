import Anthropic from '@anthropic-ai/sdk';
import type { SesClient } from '../clients/sesClient.js';
import { type Agent, type AgentInput, type AgentOutput, type AppConfig } from './base.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';
import type { WebAgentData, WebItem } from './webAgent.js';

const MODEL = 'claude-haiku-4-5-20251001';

export class ComposerAgent implements Agent {
  readonly id = 'composer';
  private client: Anthropic;

  constructor(
    private sesClient: SesClient,
    private config: AppConfig,
    private dryRun: boolean = false
  ) {
    this.client = new Anthropic();
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now();
    const context = input.context ?? [];
    const webData = context.find((c) => c.agentId === 'web')?.data as WebAgentData | undefined;
    const dateStr = input.date.toISOString().split('T')[0];

    const allItems = Object.values(webData?.byTopic ?? {}).flat();

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

    const subject = `[朝刊エージェント便] ${dateStr} 今日のブリーフ`;
    const htmlBody = buildHtmlEmail(dateStr, webData, picks);
    const textBody = buildTextEmail(dateStr, webData, picks);

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

// ---- HTML ビルダー ------------------------------------------------

function buildHtmlEmail(
  dateStr: string,
  webData: WebAgentData | undefined,
  picks: Array<{ title: string; comment: string }>
): string {
  const byTopic = webData?.byTopic ?? {};

  const pickCards = picks
    .map(
      (p) => `
    <div class="pick-card">
      <div class="pick-title">${escHtml(p.title)}</div>
      <div class="pick-comment">${escHtml(p.comment)}</div>
    </div>`
    )
    .join('');

  const topicSections = Object.entries(byTopic)
    .map(([topic, items]) => {
      const cards = items
        .sort((a, b) => b.score - a.score)
        .map((item) => articleCard(item))
        .join('');
      return `
    <div class="topic-section">
      <h2 class="topic-heading">${escHtml(topic)}</h2>
      ${cards}
    </div>`;
    })
    .join('');

  const allItems = Object.values(byTopic).flat();
  const readLaterItems = allItems
    .filter((item) => item.score <= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const readLaterList = readLaterItems
    .map(
      (item) =>
        `<li><a href="${escHtml(item.url)}" class="read-later-link">${escHtml(item.title)}</a></li>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Segoe UI', sans-serif;
    background: #f0f2f5;
    color: #1a1a2e;
    padding: 16px;
  }
  .container { max-width: 600px; margin: 0 auto; }

  /* ヘッダー */
  .header {
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    color: #fff;
    border-radius: 12px;
    padding: 24px 20px;
    margin-bottom: 16px;
  }
  .header-label {
    font-size: 11px;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: #e94560;
    margin-bottom: 6px;
  }
  .header-title { font-size: 22px; font-weight: 700; }
  .header-date { font-size: 13px; color: #aaa; margin-top: 4px; }

  /* セクション見出し */
  .section { margin-bottom: 20px; }
  .section-heading {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: #e94560;
    border-bottom: 2px solid #e94560;
    padding-bottom: 6px;
    margin-bottom: 12px;
  }

  /* 注目ピックカード */
  .pick-card {
    background: #fff;
    border-left: 4px solid #e94560;
    border-radius: 0 8px 8px 0;
    padding: 12px 14px;
    margin-bottom: 10px;
    box-shadow: 0 1px 4px rgba(0,0,0,.06);
  }
  .pick-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .pick-comment { font-size: 13px; color: #555; line-height: 1.5; }

  /* トピック見出し */
  .topic-section { margin-bottom: 24px; }
  .topic-heading {
    font-size: 16px;
    font-weight: 700;
    background: #1a1a2e;
    color: #fff;
    padding: 8px 14px;
    border-radius: 6px;
    margin-bottom: 10px;
  }

  /* 記事カード */
  .article-card {
    background: #fff;
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 8px;
    box-shadow: 0 1px 4px rgba(0,0,0,.06);
  }
  .article-title {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 5px;
  }
  .article-title a {
    color: #1a1a2e;
    text-decoration: none;
  }
  .article-title a:hover { text-decoration: underline; }
  .article-summary { font-size: 13px; color: #555; line-height: 1.55; margin-bottom: 6px; }
  .article-meta { font-size: 11px; color: #999; }
  .score-dot {
    display: inline-block;
    width: 8px; height: 8px;
    border-radius: 50%;
    margin-right: 2px;
    vertical-align: middle;
  }

  /* あとで読む */
  .read-later-list { list-style: none; }
  .read-later-list li { margin-bottom: 6px; }
  .read-later-link { font-size: 13px; color: #e94560; }

  /* フッター */
  .footer {
    text-align: center;
    font-size: 11px;
    color: #999;
    padding: 16px 0 8px;
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <div class="header-label">Morning Agent</div>
    <div class="header-title">朝刊エージェント便</div>
    <div class="header-date">${dateStr}</div>
  </div>

  ${
    picks.length > 0
      ? `<div class="section">
    <div class="section-heading">🔥 今日の注目</div>
    ${pickCards}
  </div>`
      : ''
  }

  <div class="section">
    <div class="section-heading">📰 テーマ別ニュース</div>
    ${topicSections || '<p style="color:#999;font-size:13px;">記事が見つかりませんでした</p>'}
  </div>

  ${
    readLaterItems.length > 0
      ? `<div class="section">
    <div class="section-heading">📌 あとで読む</div>
    <div style="background:#fff;border-radius:8px;padding:12px 14px;box-shadow:0 1px 4px rgba(0,0,0,.06)">
      <ul class="read-later-list">${readLaterList}</ul>
    </div>
  </div>`
      : ''
  }

  <div class="footer">朝刊エージェント便 — Powered by Claude Haiku</div>
</div>
</body>
</html>`;
}

function articleCard(item: WebItem): string {
  const scoreDots = Array.from({ length: 5 }, (_, i) => {
    const color = i < item.score ? '#e94560' : '#e0e0e0';
    return `<span class="score-dot" style="background:${color}"></span>`;
  }).join('');

  return `
  <div class="article-card">
    <div class="article-title">
      <a href="${escHtml(item.url)}" target="_blank" rel="noopener">${escHtml(item.title)}</a>
    </div>
    <div class="article-summary">${escHtml(item.summary)}</div>
    <div class="article-meta">${scoreDots} 重要度 ${item.score}/5</div>
  </div>`;
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
  picks: Array<{ title: string; comment: string }>
): string {
  const byTopic = webData?.byTopic ?? {};
  const lines: string[] = [`朝刊エージェント便 ${dateStr}`, ''];

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
  lines.push('朝刊エージェント便 — Powered by Claude Haiku');
  return lines.join('\n');
}
