# morning-agent

毎朝7時に Web からニュース・情報を収集し、ブリーフィングメールを自動送信する AWS Lambda エージェント。

## 使用 LLM

**claude-sonnet-4-20250514** (Web 収集・メール生成の両フェーズで使用)

## 技術スタック

- Node.js 22.x / TypeScript 5.x
- AWS Lambda + EventBridge Scheduler (JST 07:00 = UTC 22:00)
- Claude API (Anthropic SDK) — claude-sonnet-4-20250514
- AWS SES (メール送信)

## 初回セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
# .env を編集して以下を設定:
#   ANTHROPIC_API_KEY   : Anthropic コンソールから取得
#   RECIPIENT_EMAIL     : 受信メールアドレス
#   SENDER_EMAIL        : SES で Verify 済みの送信元アドレス
#   AWS_REGION          : ap-northeast-1 (デフォルト)
```

### 3. AWS 認証情報の確認

SES 送信には AWS 認証情報が必要です。以下いずれかで設定してください:

```bash
# AWS CLI で設定済みの場合はそのまま使える
aws sts get-caller-identity  # 認証確認

# 未設定の場合
aws configure  # アクセスキーを入力

# または .env に直接記述
# AWS_ACCESS_KEY_ID=AKIA...
# AWS_SECRET_ACCESS_KEY=...
```

必要な IAM 権限: `ses:SendEmail`

### 4. AWS SES の送信元アドレス Verify

SES サンドボックス環境では、送信元・送信先の両アドレスを Verify する必要があります。

```bash
aws ses verify-email-identity --email-address sender@example.com --region ap-northeast-1
aws ses verify-email-identity --email-address your@example.com --region ap-northeast-1
```

### 4. ローカル動作確認

```bash
# SES 疎通テスト（パイプライン不使用、テストメールのみ送信）
npx tsx scripts/test-run.ts --test-email

# ドライラン（Web 収集 + メール生成、送信はスキップ）
npx tsx scripts/test-run.ts --dry-run

# 全体実行（Web 収集 → メール生成 → SES 送信）
npm run test-run
```

### 5. ビルド & AWS デプロイ

```bash
npm run build   # esbuild でバンドル + topics.yaml を dist/ にコピー
npm run deploy  # CDK で Lambda + EventBridge をデプロイ
```

デプロイ前に SSM Parameter Store を設定:

```bash
aws ssm put-parameter --name /morning-agent/recipient-email --value "your@email.com" --type String
aws ssm put-parameter --name /morning-agent/sender-email --value "sender@email.com" --type String
aws ssm put-parameter --name /morning-agent/delivery-time --value "07:00" --type String
```

## ローカルテスト コマンド一覧

| コマンド | 内容 |
|---|---|
| `npx tsx scripts/test-run.ts --test-email` | SES 疎通テスト（テストメールのみ送信） |
| `npx tsx scripts/test-run.ts --dry-run` | 全パイプライン実行、メール送信のみスキップ |
| `npm run test-run` | 全体実行（Web 収集 → 生成 → SES 送信） |

## 動作フロー

```
EventBridge Scheduler (毎朝 JST 07:00)
    ↓
Lambda handler (src/index.ts)
    ↓
Pipeline.collect phase — 並列実行
    └─ WebAgent: topics.yaml の URL を fetch_webpage ツールで収集
                 → Claude がトピック別に重要度スコア付きで集約
    ↓
Pipeline.compose phase — 直列実行
    └─ ComposerAgent: 収集結果を Claude でメール本文に整形
                      → SES でメール送信
```

## トピック設定

`src/config/topics.yaml` を編集して収集対象を変更できます:

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
    keywords: [日経平均, S&P500, NISA]
    urls:
      - https://www.nikkei.com/markets/
```

## ディレクトリ構造

```
src/
  index.ts                  # Lambda エントリポイント
  orchestrator/
    pipeline.ts             # 並列収集 → 直列合成 パイプライン
  agents/
    base.ts                 # Agent インターフェース & 型定義
    webAgent.ts             # Web 収集エージェント (tool_use ループ)
    composerAgent.ts        # メール生成・送信エージェント
  tools/
    webFetchTool.ts         # fetch_webpage ツール定義 & ハンドラー
  clients/
    sesClient.ts            # AWS SES クライアント
  config/
    settings.ts             # 設定読み込み (.env / SSM)
    topics.yaml             # 収集トピック定義
  utils/
    llmLogger.ts            # LLM 呼び出しログ (CloudWatch Logs 対応)
    retry.ts                # 指数バックオフ付きリトライ
scripts/
  test-run.ts               # ローカルテスト実行スクリプト
infra/
  bin/app.ts                # CDK アプリエントリポイント
  lib/
    lambdaStack.ts          # Lambda + IAM 最小権限
    schedulerStack.ts       # EventBridge Scheduler (JST 07:00)
```

## ログ形式 (CloudWatch Logs Insights)

LLM 呼び出しは以下の構造化 JSON でログ出力されます:

```json
{
  "type": "LLM_CALL",
  "traceId": "<Lambda RequestId>",
  "agentId": "web",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 10485,
  "outputTokens": 2990,
  "costUsd": 0.076305,
  "durationMs": 54874,
  "success": true
}
```
