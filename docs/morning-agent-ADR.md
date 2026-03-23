# 朝刊エージェント便 — ADR集 & Claude Code プロンプト集

> 作成日: 2026-03-23  
> プロジェクト: morning-agent  
> ステータス: MVP設計フェーズ

---

## ADR-001: 実行基盤にAWS Lambda (Node.js) を採用する

### ステータス
承認済み

### コンテキスト
毎朝1回の定時バッチ処理が必要。常時起動サーバーは不要。MVPフェーズでは運用コストと複雑性を最小化したい。

### 決定
AWS Lambda (Node.js 22.x) + EventBridge Scheduler を採用する。

### 根拠
- 1日1回の実行で課金が発生しない（無料枠内に収まる見込み）
- 常時起動サーバー（ECS Fargate等）に比べて運用負荷が低い
- EventBridge との統合がネイティブで簡単
- Node.js は Claude SDK / Google APIs / SES の公式SDKが揃っている

### トレードオフ
| 観点 | Lambda | ECS Fargate |
|---|---|---|
| コスト（MVP） | ◎ ほぼ無料 | △ 起動コストあり |
| 実行時間上限 | △ 15分 | ◎ 無制限 |
| 将来のスケール | △ 要再設計 | ◎ そのまま拡張 |
| 運用複雑性 | ◎ 低い | △ 高い |

### 結果
MVP期間中（〜2週間検証）はLambdaで運用。5分以内の生成を非機能要件とし、超過しそうであればECS Fargateへ移行を検討する。

---

## ADR-002: エージェント設計にStrategyパターンを採用する

### ステータス
承認済み

### コンテキスト
情報収集ソース（Calendar / Gmail / Web）は今後増減する可能性がある。MVPでは3系統だが、将来的にNotion・RSS・X等の追加が想定される。

### 決定
`Agent` インターフェースを定義し、各収集エージェントをStrategyとして実装する。Pipelineがエージェントのレジストリを保持し、収集層は `Promise.allSettled` で並列実行する。

### 根拠
- エージェントの追加・削除が `pipeline.register()` の1行で完結する
- 収集層を並列化することで実行時間を短縮できる（直列14秒 → 並列9秒の試算）
- 1つのエージェントが失敗しても他の結果が捨てられない（`allSettled`）
- テスト時にモックエージェントへの差し替えが容易

### インターフェース定義
```typescript
interface Agent {
  readonly id: string;
  run(input: AgentInput): Promise<AgentOutput>;
}
```

### 結果
収集層（collect phase）は並列、統合層（compose phase）は直列という2フェーズ構成をPipelineが管理する。

---

## ADR-003: LLM観測基盤に自前CloudWatchログを採用する（Langfuse不採用）

### ステータス
承認済み

### コンテキスト
LLMのトークン使用量・コスト・レイテンシを把握したい。Langfuseというオープンソースの観測基盤の採用を検討した。

### 決定
MVPではLangfuseを採用せず、構造化JSONログをCloudWatch Logsに出力し、Logs Insightsで集計する自前実装を採用する。

### 根拠
- MVPは1ユーザー・1日1回の実行であり、Langfuseのオーバーヘッドが見合わない
- 外部SaaSへの情報送信を避けたい（Gmail・Calendar内容が含まれる可能性）
- CloudWatch Logs InsightsでSQL的にクエリできるため、コスト集計は十分対応可能
- Langfuseは複数ユーザー展開・プロンプトA/Bテスト段階で導入を再検討する

### ログフォーマット
```json
{
  "type": "LLM_CALL",
  "traceId": "<Lambda RequestId>",
  "agentId": "calendar",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 1200,
  "outputTokens": 450,
  "costUsd": 0.0034,
  "durationMs": 1840,
  "success": true
}
```

### 結果
将来的にプロンプト管理・品質評価・マルチユーザー対応が必要になった時点でLangfuseへ移行する。移行コストを下げるため、ログ構造はLangfuseのtraceモデルに近い形にしておく。

---

## ADR-004: Google認証にOAuth2 + refresh_token固定保存を採用する

### ステータス
承認済み

### コンテキスト
Gmail・Google Calendarへのアクセスには認証が必要。個人Gmailアカウントを対象とするため、Service Accountは利用不可。

### 決定
OAuth2フローで初回手動認証を行い、取得したrefresh_tokenをAWS Secrets Managerに保存。Lambda起動時にSecrets Managerから取得してaccess_tokenを都度再発行する。

### 根拠
- 個人Gmailに対してService Accountは使用不可（Google Workspaceドメイン管理が必要）
- refresh_tokenは有効期限が長く、Lambda実行のたびに再認証不要
- Secrets ManagerはIAMロールで制御でき、環境変数より安全

### 初回セットアップ手順
1. `scripts/oauth-setup.ts` をローカル実行
2. ブラウザでGoogle認証 → authorization code取得
3. スクリプトがrefresh_tokenを出力
4. Secrets Managerに保存

### 結果
初回のみ手動操作が必要だが、それ以降は完全自動化される。

---

## Claude Code プロンプト集

以下のプロンプトを Claude Code に順番に投入して実装を進める。
各プロンプトは独立して動作するよう設計されているが、上から順に実行することを推奨する。

---

### PROMPT-01: プロジェクト初期化

```
以下の仕様でNode.js TypeScriptプロジェクトを初期化してください。

## プロジェクト名
morning-agent

## 要件
- Node.js 22.x / TypeScript 5.x
- パッケージマネージャー: npm
- Lambda対応のため、esbuildでバンドルする構成にする

## インストールするパッケージ
### dependencies
- @anthropic-ai/sdk
- @aws-sdk/client-ses
- @aws-sdk/client-ssm
- @aws-sdk/client-secrets-manager
- googleapis
- axios
- js-yaml

### devDependencies
- typescript
- @types/node
- @types/js-yaml
- esbuild
- aws-cdk-lib
- constructs

## 作成するファイル
- package.json（scriptsに build / deploy / test-run を含める）
- tsconfig.json（target: ES2022, moduleResolution: bundler）
- .env.example（必要な環境変数のコメント付きテンプレート）
- .gitignore（node_modules, dist, .env, cdk.out）
- README.md（プロジェクト概要と初回セットアップ手順）

## ディレクトリ構造
以下を空ファイル（またはスタブ）で作成してください：
src/index.ts
src/orchestrator/pipeline.ts
src/agents/base.ts
src/agents/calendarAgent.ts
src/agents/gmailAgent.ts
src/agents/webAgent.ts
src/agents/composerAgent.ts
src/tools/googleCalendarTool.ts
src/tools/gmailTool.ts
src/tools/webFetchTool.ts
src/clients/googleAuth.ts
src/clients/calendarClient.ts
src/clients/gmailClient.ts
src/clients/sesClient.ts
src/config/settings.ts
src/config/topics.yaml
src/utils/llmLogger.ts
src/utils/retry.ts
scripts/oauth-setup.ts
scripts/test-run.ts
infra/bin/app.ts
infra/lib/lambdaStack.ts
infra/lib/schedulerStack.ts
```

---

### PROMPT-02: Agent インターフェース & Pipeline 実装

```
以下の仕様で2つのファイルを実装してください。

## src/agents/base.ts

### AgentInput型
- date: Date           // 処理対象日付
- config: AppConfig    // 設定オブジェクト（後述）
- context?: AgentOutput[]  // compose phaseで前段の結果を受け取る

### AgentOutput型
- agentId: string
- data: unknown
- tokensUsed: number
- durationMs: number
- error?: string       // 失敗時のみ

### Agent インターフェース
- readonly id: string
- run(input: AgentInput): Promise<AgentOutput>

### AppConfig型
- deliveryTime: string          // "07:00"
- recipientEmail: string
- senderEmail: string
- topics: Topic[]

### Topic型
- id: string
- label: string
- urls: string[]
- keywords: string[]

---

## src/orchestrator/pipeline.ts

### Pipeline クラス
以下の仕様で実装すること：

1. collectors: Agent[] と composers: Agent[] を内部で保持する

2. register(agent: Agent, phase: 'collect' | 'compose') メソッド
   - 対応するリストにagentを追加する

3. unregister(agentId: string) メソッド
   - idを指定してagentを削除できる

4. run(input: AgentInput): Promise<AgentOutput[]> メソッド
   - 収集層: collectors を Promise.allSettled で並列実行
   - 失敗したagentはエラーをAgentOutput.errorに格納してスキップ（処理継続）
   - 統合層: 収集結果をcontextに追加してcomposersを直列実行
   - 各ステップの開始・終了をconsole.logで出力（後でllmLoggerに置き換え可能な形で）

5. エラーハンドリング:
   - 全collectorsが失敗した場合はErrorをthrowする
   - composersの失敗はErrorをthrowする

TypeScriptの型を厳密につけること。any禁止。
```

---

### PROMPT-03: LLMLogger & Retry ユーティリティ

```
以下の仕様で2つのユーティリティを実装してください。

## src/utils/llmLogger.ts

CloudWatch Logs Insightsで集計可能な構造化ログを出力するモジュール。

### LlmLog型
- traceId: string
- agentId: string
- model: string
- inputTokens: number
- outputTokens: number
- costUsd: number
- durationMs: number
- success: boolean
- errorCode?: string

### logLlm(log: LlmLog): void 関数
- console.log で { type: 'LLM_CALL', ...log } をJSON出力

### calcCost(usage: { input_tokens: number, output_tokens: number }, model: string): number 関数
- claude-sonnet-4-20250514 の料金: input $3/1M tokens, output $15/1M tokens
- claude-haiku-4-5 の料金: input $0.8/1M tokens, output $4/1M tokens
- 未知のmodelは0を返してwarning出力

---

## src/utils/retry.ts

### withRetry<T> 関数
シグネチャ: withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>

### RetryOptions型
- maxAttempts: number  // デフォルト3
- delayMs: number      // デフォルト1000
- backoff: 'fixed' | 'exponential'  // デフォルト 'exponential'

### 仕様
- 失敗したらdelayMs待機して再試行
- exponentialの場合: delayMs * 2^(attempt-1) で待機
- 全試行失敗時は最後のErrorをthrowする
- 各リトライをconsole.warnで出力
```

---

### PROMPT-04: Google OAuth2セットアップスクリプト

```
scripts/oauth-setup.ts を実装してください。
ローカルで一度だけ実行し、refresh_tokenを取得するためのCLIスクリプトです。

## 仕様

1. googleapis の OAuth2Client を使用する

2. 必要なスコープ:
   - https://www.googleapis.com/auth/calendar.readonly
   - https://www.googleapis.com/auth/gmail.readonly

3. 処理フロー:
   a. .env から GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET を読み込む
   b. 認証URLを生成してコンソールに表示する
   c. readline でユーザーにauthorization codeの入力を促す
   d. codeをトークンに交換する
   e. refresh_token をコンソールに出力する
   f. "次のステップ: このrefresh_tokenをAWS Secrets Managerに保存してください" と案内する

4. エラーハンドリング:
   - 環境変数が未設定の場合は明確なエラーメッセージで終了
   - トークン取得失敗時はGoogle APIのエラーメッセージをそのまま表示

## 実行方法をREADMEに追記
npx ts-node scripts/oauth-setup.ts
```

---

### PROMPT-05: Google Calendar エージェント実装

```
src/agents/calendarAgent.ts と src/clients/calendarClient.ts を実装してください。

## src/clients/calendarClient.ts

### CalendarClient クラス
- constructor(auth: OAuth2Client)
- getTodayEvents(date: Date): Promise<CalendarEvent[]>

### CalendarEvent型
- id: string
- title: string
- start: string
- end: string
- isAllDay: boolean
- location?: string
- description?: string

## src/agents/calendarAgent.ts

### CalendarAgent クラス（Agent インターフェース実装）
- readonly id = 'calendar'

### run() の処理内容
1. CalendarClient.getTodayEvents() で当日イベント取得
2. 以下のプロンプトでClaude API (claude-sonnet-4-20250514) を呼び出す:
   - システム: "あなたは朝のブリーフィングアシスタントです。簡潔・実用的な日本語で出力してください。"
   - ユーザー: 取得したイベント一覧をJSON形式で渡し、以下を出力させる
     * 今日の予定サマリー（1〜2文）
     * 注目イベント（あれば）
     * 準備が必要な事項（あれば）
3. llmLogger.logLlm() でトークン使用量を記録する
4. AgentOutput を返す

### output.data の型
- events: CalendarEvent[]
- summary: string       // Claudeの出力
- tokensUsed: number
```

---

### PROMPT-06: Gmail エージェント実装

```
src/agents/gmailAgent.ts と src/clients/gmailClient.ts を実装してください。

## src/clients/gmailClient.ts

### GmailClient クラス
- constructor(auth: OAuth2Client)
- getRecentUnread(hoursBack: number): Promise<GmailMessage[]>

### GmailMessage型
- id: string
- threadId: string
- from: string
- subject: string
- snippet: string      // 本文の先頭200文字
- receivedAt: string   // ISO8601

## src/agents/gmailAgent.ts

### GmailAgent クラス（Agent インターフェース実装）
- readonly id = 'gmail'

### run() の処理内容
1. GmailClient.getRecentUnread(24) で直近24時間の未読メール取得
2. 件数が0件の場合はClaudeを呼ばずに空結果を返す（コスト節約）
3. 以下の分類をClaudeに依頼する:
   - REPLY_NEEDED: 返信が必要と判断されるメール
   - FYI: 読むべきだが返信不要
   - SKIP: ニュースレター・自動通知等
4. 各カテゴリで理由を1行添える
5. llmLogger.logLlm() でトークン使用量を記録する

### output.data の型
- replyNeeded: { message: GmailMessage, reason: string }[]
- fyi: { message: GmailMessage, reason: string }[]
- skip: GmailMessage[]
```

---

### PROMPT-07: Web収集エージェント実装

```
src/agents/webAgent.ts と src/tools/webFetchTool.ts を実装してください。

## src/tools/webFetchTool.ts

### WebFetchTool
Claude APIのtool_use用のツール定義とハンドラーを実装する。

ツール定義（Anthropic SDK形式）:
- name: "fetch_webpage"
- description: "指定URLのWebページ本文テキストを取得する"
- input_schema:
  - url: string（必須）
  - maxLength: number（任意, デフォルト3000文字）

ハンドラー関数:
- axios で HTMLを取得
- <script>, <style>, <nav>, <footer> タグを除去
- テキスト部分のみ抽出（最大maxLength文字）
- 取得失敗時は { error: "取得失敗", url } を返す

## src/agents/webAgent.ts

### WebAgent クラス（Agent インターフェース実装）
- readonly id = 'web'

### run() の処理内容
1. config.topics から URL一覧を収集
2. Claude APIにtool_use（fetch_webpage）を渡し、各URLの収集をClaude主導で実行
3. tool_useのループ処理（stop_reason === 'tool_use' の間ループ）を実装
4. 収集完了後、テーマ別に重要度スコア（1-5）付きで3〜5件に絞り込む
5. llmLogger.logLlm() でトークン使用量を記録

### output.data の型
- byTopic: Record<string, WebItem[]>

### WebItem型
- url: string
- title: string
- summary: string     // 2〜3文
- score: number       // 1-5
- topic: string
```

---

### PROMPT-08: ComposerAgent & SES配信実装

```
src/agents/composerAgent.ts と src/clients/sesClient.ts を実装してください。

## src/clients/sesClient.ts

### SesClient クラス
- constructor(region: string)
- sendEmail(params: EmailParams): Promise<void>

### EmailParams型
- from: string
- to: string
- subject: string
- htmlBody: string
- textBody: string

## src/agents/composerAgent.ts

### ComposerAgent クラス（Agent インターフェース実装）
- readonly id = 'composer'

### run() の処理内容
1. input.context から calendar / gmail / web の各AgentOutputを取り出す
2. Claudeに以下の構成でメール本文の生成を依頼する:

出力形式はJSON:
{
  "subject": "[朝刊エージェント便] YYYY-MM-DD 今日のブリーフ",
  "sections": {
    "schedule": "今日の予定（マークダウン）",
    "replyNeeded": "要返信メール（マークダウン）",
    "topTopics": "今日の重要トピック（マークダウン）",
    "byTheme": "テーマ別まとめ（マークダウン）",
    "readLater": "あとで読む候補（マークダウン）"
  }
}

3. JSON出力をパースしてHTML形式のメール本文を生成する
   - シンプルなインラインCSS付きHTMLメール
   - モバイルで3分以内に読めるよう、各セクションは箇条書きで簡潔に
4. SesClient.sendEmail() で配信
5. llmLogger でトークン使用量を記録
```

---

### PROMPT-09: Lambda エントリポイント & 統合

```
src/index.ts と src/config/settings.ts を実装してください。

## src/config/settings.ts

### loadConfig(): Promise<AppConfig> 関数
- AWS Secrets Manager から以下を取得:
  - GOOGLE_CLIENT_ID
  - GOOGLE_CLIENT_SECRET
  - GOOGLE_REFRESH_TOKEN
- AWS SSM Parameter Store から以下を取得:
  - /morning-agent/recipient-email
  - /morning-agent/sender-email
  - /morning-agent/delivery-time
- src/config/topics.yaml を読み込んでTopics配列を返す
- ローカル開発時は .env を優先する（process.env にあれば Parameter Store をスキップ）

## src/index.ts

### Lambda handler
export const handler = async (event: unknown): Promise<void>

### 処理フロー
1. loadConfig() で設定読み込み
2. googleAuth.ts でOAuth2クライアント生成
3. Pipeline を初期化して各エージェントを登録:
   pipeline.register(new CalendarAgent(calendarClient), 'collect')
   pipeline.register(new GmailAgent(gmailClient), 'collect')
   pipeline.register(new WebAgent(), 'collect')
   pipeline.register(new ComposerAgent(sesClient, config), 'compose')
4. pipeline.run() 実行
5. 成功時: { status: 'success', agentResults: [...] } をログ出力
6. 失敗時: エラー詳細をログ出力してErrorをthrow（Lambdaのリトライに委ねる）

### context.awsRequestId を traceId としてlogLlm に渡せるよう
LambdaContextをsettingsかglobal経由で各agentから参照可能にすること
```

---

### PROMPT-10: CDK インフラ定義

```
infra/ 以下のCDKスタックを実装してください。

## infra/lib/lambdaStack.ts

### MorningAgentLambdaStack
以下のリソースを定義する:

1. Lambda Function
   - runtime: nodejs22.x
   - handler: index.handler
   - code: lambda.Code.fromAsset('../dist')
   - timeout: Duration.minutes(10)
   - memorySize: 512
   - environment:
     - NODE_ENV: production
     - AWS_REGION: ap-northeast-1

2. IAM Policy（最小権限）
   - ses:SendEmail（自分のメールアドレスのみ）
   - ssm:GetParameter（/morning-agent/* のみ）
   - secretsmanager:GetSecretValue（morning-agent/* のみ）

## infra/lib/schedulerStack.ts

### MorningAgentSchedulerStack
1. EventBridge Scheduler
   - schedule: cron(0 22 * * ? *)  ← UTC 22:00 = JST 07:00
   - target: 上記Lambda
   - flexible_time_window: 5分以内

## infra/bin/app.ts
両スタックをインスタンス化して接続する。
env: { account: process.env.CDK_ACCOUNT, region: 'ap-northeast-1' }
```

---

### PROMPT-11: ローカルテスト実行スクリプト

```
scripts/test-run.ts を実装してください。
ローカルから手動でパイプラインを1回実行して動作確認するためのスクリプトです。

## 仕様
1. .env を読み込む（dotenv）
2. src/index.ts の handler を直接呼び出す
3. 実行結果をコンソールに出力する
4. --agent オプションで特定のエージェントのみ実行できるようにする
   例: npx ts-node scripts/test-run.ts --agent calendar
5. --dry-run オプションでメール送信をスキップする（composerAgentがSES呼び出しをスキップ）

## 実行コマンド例（READMEに追記）
# 全体テスト（メール送信あり）
npx ts-node scripts/test-run.ts

# カレンダーエージェントのみ
npx ts-node scripts/test-run.ts --agent calendar

# ドライラン（メール送信なし）
npx ts-node scripts/test-run.ts --dry-run
```

---

## 実装推奨順序

```
PROMPT-01  プロジェクト初期化
    ↓
PROMPT-02  Agent I/F & Pipeline（骨格）
    ↓
PROMPT-03  Logger & Retry（共通ユーティリティ）
    ↓
PROMPT-04  OAuth2セットアップ → 実際に認証を通す ★ここが最初の壁
    ↓
PROMPT-05  CalendarAgent → test-runで単体確認
    ↓
PROMPT-06  GmailAgent → test-runで単体確認
    ↓
PROMPT-07  WebAgent（tool_use）→ test-runで単体確認
    ↓
PROMPT-08  ComposerAgent + SES → メール1通手動送信で確認
    ↓
PROMPT-09  Lambda handler 統合 → 全体test-run
    ↓
PROMPT-10  CDK デプロイ → 初回本番実行
    ↓
PROMPT-11  test-run スクリプト（随時利用）
```

---

## topics.yaml サンプル

```yaml
topics:
  - id: ai
    label: AI・LLM
    keywords: [Claude, GPT, Gemini, LLM, 生成AI]
    urls:
      - https://www.anthropic.com/news
      - https://openai.com/blog

  - id: finance
    label: 金融・投資
    keywords: [日経平均, S&P500, NISA, 投資信託]
    urls:
      - https://www.nikkei.com/markets/

  - id: game
    label: ゲーム・Nintendo
    keywords: [Nintendo, Switch, ゲーム新作]
    urls:
      - https://www.nintendo.co.jp/news/
```
