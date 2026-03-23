# morning-agent

毎朝7時に Google Calendar・Gmail・Webから情報を収集し、ブリーフィングメールを自動送信するAWSLambdaエージェント。

## 技術スタック

- Node.js 22.x / TypeScript 5.x
- AWS Lambda + EventBridge Scheduler
- Claude API (Anthropic SDK)
- Google Calendar / Gmail API
- AWS SES

## 初回セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
# .env を編集して各値を設定
```

### 3. Google OAuth2 認証

Google Cloud Console で OAuth2 クレデンシャルを作成し、`.env` に設定後:

```bash
npm run oauth-setup
# または
npx ts-node scripts/oauth-setup.ts
```

> `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` が `.env` に設定されていない場合、明確なエラーメッセージで終了します。

ブラウザで認証後、表示される `refresh_token` を AWS Secrets Manager に保存する。

### 4. AWS Secrets Manager / SSM Parameter Store の設定

```bash
# Secrets Manager にOAuth認証情報を保存
aws secretsmanager create-secret --name morning-agent/google-oauth \
  --secret-string '{"clientId":"...","clientSecret":"...","refreshToken":"..."}'

# SSM Parameter Storeにメール設定を保存
aws ssm put-parameter --name /morning-agent/recipient-email --value "your@email.com" --type String
aws ssm put-parameter --name /morning-agent/sender-email --value "sender@email.com" --type String
aws ssm put-parameter --name /morning-agent/delivery-time --value "07:00" --type String
```

### 5. ビルド & デプロイ

```bash
npm run build   # esbuildでバンドル
npm run deploy  # CDKでAWSデプロイ
```

## ローカルテスト実行

```bash
# 全体テスト（メール送信あり）
npx ts-node scripts/test-run.ts
# または
npm run test-run

# カレンダーエージェントのみ
npx ts-node scripts/test-run.ts --agent calendar

# Gmailエージェントのみ
npx ts-node scripts/test-run.ts --agent gmail

# Webエージェントのみ
npx ts-node scripts/test-run.ts --agent web

# ドライラン（メール送信なし）
npx ts-node scripts/test-run.ts --dry-run
```

## ディレクトリ構造

```
src/
  index.ts                  # Lambda エントリポイント
  orchestrator/
    pipeline.ts             # エージェント実行パイプライン
  agents/
    base.ts                 # Agent インターフェース & 型定義
    calendarAgent.ts        # Google Calendar 収集エージェント
    gmailAgent.ts           # Gmail 収集エージェント
    webAgent.ts             # Web収集エージェント
    composerAgent.ts        # メール生成・送信エージェント
  tools/
    googleCalendarTool.ts
    gmailTool.ts
    webFetchTool.ts
  clients/
    googleAuth.ts           # OAuth2クライアント
    calendarClient.ts
    gmailClient.ts
    sesClient.ts
  config/
    settings.ts             # 設定読み込み
    topics.yaml             # 収集トピック定義
  utils/
    llmLogger.ts            # LLM呼び出しログ
    retry.ts                # リトライユーティリティ
scripts/
  oauth-setup.ts            # 初回OAuth認証スクリプト
  test-run.ts               # ローカルテスト実行スクリプト
infra/
  bin/app.ts                # CDK アプリエントリポイント
  lib/
    lambdaStack.ts          # Lambda + IAM スタック
    schedulerStack.ts       # EventBridge Scheduler スタック
```
