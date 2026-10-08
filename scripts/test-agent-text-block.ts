/**
 * Haiku 5.5 の応答は先頭が thinking ブロックになりうる。CalendarAgent / GmailAgent が
 * 位置ではなく type でテキストを取り出し、要約・分類が空にならないことを検査する。
 *
 *   npm run test:agent-text-block
 */
import type Anthropic from '@anthropic-ai/sdk';
import { CalendarAgent, type CalendarAgentData } from '../src/agents/calendarAgent.js';
import { GmailAgent, type GmailAgentData } from '../src/agents/gmailAgent.js';
import type { CalendarClient } from '../src/clients/calendarClient.js';
import type { GmailClient } from '../src/clients/gmailClient.js';
import type { AgentInput } from '../src/agents/base.js';

let failed = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) return;
  console.error(`✗ ${label}${detail ? `: ${detail}` : ''}`);
  failed++;
}

// SDK のクライアント生成がキー未設定で落ちないようにする（実際の通信は差し替えたクライアントで止める）
process.env.ANTHROPIC_API_KEY ??= 'test-key';

/** thinking ブロックの後に text が続く応答を返すクライアント */
function fakeClient(text: string): Anthropic {
  const response = {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text, citations: null },
    ],
    usage: { input_tokens: 100, output_tokens: 50 },
    stop_reason: 'end_turn',
  };
  return { messages: { create: async () => response } } as unknown as Anthropic;
}

function withClient<T extends object>(agent: T, client: Anthropic): T {
  (agent as unknown as { client: Anthropic }).client = client;
  return agent;
}

const input = { date: new Date('2026-10-08T00:00:00+09:00'), config: {} } as unknown as AgentInput;
const log = console.log;
console.log = () => {};

try {
  const calendar = withClient(
    new CalendarAgent({
      getTodayEvents: async () => [
        { id: 'e1', title: '定例', start: '2026-10-08T10:00:00+09:00', end: '2026-10-08T11:00:00+09:00', isAllDay: false },
      ],
    } as unknown as CalendarClient),
    fakeClient('今日は定例が1件あります。')
  );
  const calendarData = (await calendar.run(input)).data as CalendarAgentData;
  check('calendar: thinking の後の text を要約として取り出す', calendarData.summary === '今日は定例が1件あります。', calendarData.summary);

  const gmail = withClient(
    new GmailAgent({
      getRecentUnread: async () => [
        { id: 'm1', threadId: 't1', from: 'a@example.com', subject: '確認', snippet: '返信ください', receivedAt: '2026-10-08' },
        { id: 'm2', threadId: 't2', from: 'news@example.com', subject: 'ニュース', snippet: '配信', receivedAt: '2026-10-08' },
      ],
    } as unknown as GmailClient),
    fakeClient(JSON.stringify({ replyNeeded: [{ id: 'm1', reason: '返信依頼' }], fyi: [], skip: ['m2'] }))
  );
  const gmailData = (await gmail.run(input)).data as GmailAgentData;
  check('gmail: thinking の後の text から返信要を取り出す', gmailData.replyNeeded.map((c) => c.message.id).join() === 'm1', JSON.stringify(gmailData.replyNeeded));
  check('gmail: thinking の後の text から SKIP を取り出す', gmailData.skip.map((m) => m.id).join() === 'm2', JSON.stringify(gmailData.skip));
} finally {
  console.log = log;
}

if (failed > 0) {
  console.error(`${failed} 件失敗`);
  process.exit(1);
}
console.log('agent text block: all passed');
