export interface Topic {
  id: string;
  label: string;
  urls: string[];
  keywords: string[];
}

export interface AppConfig {
  deliveryTime: string;
  recipientEmail: string;
  senderEmail: string;
  topics: Topic[];
}

export interface AgentInput {
  date: Date;
  config: AppConfig;
  context?: AgentOutput[];
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
