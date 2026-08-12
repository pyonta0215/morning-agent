import type { DeliveredItem } from '../utils/deliveredHistory.js';

/** research-hub（HN / arXiv / GitHub / RSS）からの補強設定。未指定のトピックは従来どおり */
export interface ResearchSpec {
  search?: {
    /** 省略時は topic.keywords を1語ずつ使う */
    queries?: string[];
    /** 省略時は全ソース。arXivは遅いので明示して絞るのが推奨 */
    sources?: string[];
    /** "2d" "24h" など。research-hub の since 形式 */
    since?: string;
    /** 1クエリ・1ソースあたりの件数 */
    limit?: number;
    /** 既定は score（期間内の注目度上位）。date は新着順で、HNでは投稿直後の低スコア記事ばかりになる */
    sort?: 'relevance' | 'date' | 'score';
  };
  trending?: Array<{
    source: string;
    category?: string;
    period?: 'day' | 'week';
    limit?: number;
  }>;
}

export interface Topic {
  id: string;
  label: string;
  urls: string[];
  keywords: string[];
  /** true のトピックのみ web_search による鮮度補強を行う */
  webSearch?: boolean;
  /**
   * true のトピックのみストーリー台帳の対象にする（既定 false）。
   * 「継続する話題」として成立するトピックだけに絞る。判断根拠は topics.yaml のコメント。
   */
  story?: boolean;
  /** research-hub による補強（ENABLE_RESEARCH_HUB=true のときのみ有効） */
  research?: ResearchSpec;
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
