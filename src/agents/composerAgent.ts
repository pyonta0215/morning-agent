import Anthropic from '@anthropic-ai/sdk';
import type { SesClient } from '../clients/sesClient.js';
import { type Agent, type AgentInput, type AgentOutput, type AppConfig } from './base.js';
import { logLlm, calcCost } from '../utils/llmLogger.js';
import type { WebAgentData } from './webAgent.js';

const MODEL = 'claude-haiku-4-5-20251001';

interface EmailSections {
  subject: string;
  sections: {
    topTopics: string;
    byTheme: string;
    readLater: string;
  };
}

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

    const response = await this.client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system:
        'あなたは朝刊エージェント便のメール作成担当です。モバイルで3分以内に読めるよう、各セクションは箇条書きで簡潔にまとめてください。出力は必ずJSON形式で返してください。',
      messages: [
        {
          role: 'user',
          content: `以下のWeb収集情報をもとに、朝刊エージェント便のメール本文を作成してください。

## Web収集情報
${JSON.stringify(webData ?? {}, null, 2)}

以下のJSON形式で出力してください:
{
  "subject": "[朝刊エージェント便] ${dateStr} 今日のブリーフ",
  "sections": {
    "topTopics": "今日の重要トピック（マークダウン形式の箇条書き、全テーマから特に重要な3〜5件）",
    "byTheme": "テーマ別まとめ（マークダウン形式、各テーマのトップニュースを箇条書き）",
    "readLater": "あとで読む候補（マークダウン形式の箇条書き、スコアが低めだが気になる記事）"
  }
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

    let emailData: EmailSections = {
      subject: `[朝刊エージェント便] ${dateStr} 今日のブリーフ`,
      sections: {
        topTopics: '情報なし',
        byTheme: '情報なし',
        readLater: '情報なし',
      },
    };

    const textBlock = response.content.find((c) => c.type === 'text');
    if (textBlock && textBlock.type === 'text') {
      try {
        const jsonMatch =
          textBlock.text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ??
          textBlock.text.match(/(\{[\s\S]*\})/);
        if (jsonMatch) {
          emailData = JSON.parse(jsonMatch[1] ?? jsonMatch[0]) as EmailSections;
        } else {
          console.warn('[ComposerAgent] No JSON found in response');
        }
      } catch {
        console.warn('[ComposerAgent] Failed to parse Claude response as JSON');
      }
    }

    const htmlBody = buildHtmlEmail(emailData, dateStr);
    const textBody = buildTextEmail(emailData);

    if (!this.dryRun) {
      await this.sesClient.sendEmail({
        from: this.config.senderEmail,
        to: this.config.recipientEmail,
        subject: emailData.subject,
        htmlBody,
        textBody,
      });
      console.log(`[ComposerAgent] Email sent to ${this.config.recipientEmail}`);
    } else {
      console.log('[ComposerAgent] Dry run: skipping email send');
      console.log('Subject:', emailData.subject);
    }

    return {
      agentId: this.id,
      data: { subject: emailData.subject, sections: emailData.sections },
      tokensUsed: inputTokens + outputTokens,
      durationMs,
    };
  }
}

function buildHtmlEmail(emailData: EmailSections, dateStr: string): string {
  const { sections } = emailData;

  const markdownToHtml = (md: string): string => {
    return md
      .split('\n')
      .map((line) => {
        if (line.startsWith('### ')) return `<h3>${line.slice(4)}</h3>`;
        if (line.startsWith('## ')) return `<h2>${line.slice(3)}</h2>`;
        if (line.startsWith('# ')) return `<h1>${line.slice(2)}</h1>`;
        if (line.startsWith('- ') || line.startsWith('* '))
          return `<li>${line.slice(2)}</li>`;
        if (line.trim() === '') return '<br>';
        return `<p>${line}</p>`;
      })
      .join('\n');
  };

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333; }
  h1 { color: #1a1a2e; border-bottom: 2px solid #e94560; padding-bottom: 8px; }
  h2 { color: #16213e; border-left: 4px solid #e94560; padding-left: 12px; margin-top: 24px; }
  li { margin: 4px 0; line-height: 1.6; }
  .section { background: #f8f9fa; border-radius: 8px; padding: 16px; margin: 16px 0; }
  .footer { font-size: 12px; color: #999; text-align: center; margin-top: 32px; }
</style>
</head>
<body>
<h1>朝刊エージェント便 ${dateStr}</h1>

<div class="section">
<h2>🔥 今日の重要トピック</h2>
${markdownToHtml(sections.topTopics)}
</div>

<div class="section">
<h2>📰 テーマ別まとめ</h2>
${markdownToHtml(sections.byTheme)}
</div>

<div class="section">
<h2>📌 あとで読む</h2>
${markdownToHtml(sections.readLater)}
</div>

<div class="footer">朝刊エージェント便 — Powered by Claude</div>
</body>
</html>`;
}

function buildTextEmail(emailData: EmailSections): string {
  const { sections } = emailData;
  return `朝刊エージェント便

== 今日の重要トピック ==
${sections.topTopics}

== テーマ別まとめ ==
${sections.byTheme}

== あとで読む ==
${sections.readLater}

---
朝刊エージェント便 — Powered by Claude
`;
}
