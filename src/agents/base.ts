import type { DeliveredItem } from '../utils/deliveredHistory.js';

export interface Topic {
  id: string;
  label: string;
  urls: string[];
  keywords: string[];
  /** true のトピックのみ web_search による鮮度補強を行う */
  webSearch?: boolean;
}

export interface AppConfig {
  deliveryTime: string;
  recipientEmail: string;
  senderEmail: string;
  sesRegion: string;
  topics: Topic[];
}

export interface AgentInput {
  date: Date;
  config: AppConfig;
  context?: AgentOutput[];
  /** 過去に紙面掲載済みの記事履歴（重複掲載の抑制に使用） */
  delivered?: DeliveredItem[];
}

export interface AgentOutput {
  agentId: string;
  data: unknown;
  tokensUsed: number;
  durationMs: number;
  error?: string;
}

export interface Agent {
  readonly id: string;
  run(input: AgentInput): Promise<AgentOutput>;
}
