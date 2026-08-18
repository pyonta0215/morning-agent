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

事前に SSM Parameter Store へ必要な値を登録してください:

```bash
# リージョン: ap-northeast-1 (Lambda デプロイ先)
aws ssm put-parameter --name /morning-agent/recipient-email \
  --value "your@email.com" --type String --region ap-northeast-1
aws ssm put-parameter --name /morning-agent/sender-email \
  --value "sender@example.com" --type String --region ap-northeast-1
aws ssm put-parameter --name /morning-agent/delivery-time \
  --value "07:00" --type String --region ap-northeast-1
aws ssm put-parameter --name /morning-agent/anthropic-api-key \
  --value "sk-ant-..." --type SecureString --region ap-northeast-1
```

ビルド & デプロイ:

```bash
npm run build   # esbuild でバンドル + topics.yaml を dist/ にコピー
npm run deploy  # CDK で Lambda + EventBridge をデプロイ
```

CDK bootstrap が未済みの場合は先に実施:

```bash
npx cdk bootstrap aws://ACCOUNT_ID/ap-northeast-1
```

**リージョン構成:**
- Lambda / SSM: `ap-northeast-1` (東京)
- SES: `us-east-1` (バージニア) — 送信元ドメインをこのリージョンで Verify する
- Lambda の環境変数 `SES_REGION=us-east-1` で自動切り替え

## Enhanced Editorial（朝刊→夕刊の継続性）

`ENHANCED_EDITORIAL=true` を設定すると、朝刊で選んだ注目記事を夕刊の編集プロンプトに注入します。

**効果**: 夕刊が朝刊の内容を踏まえた選出・コメントになる（重複回避・続報補足）

**有効化**:
```bash
# ローカル: .env に追記
ENHANCED_EDITORIAL=true

# Lambda 本番環境:
aws lambda update-function-configuration \
  --function-name MorningAgentFunction \
  --environment Variables="{ENHANCED_EDITORIAL=true,...}"
```

**仕組み**: 朝刊収集時に `context/morning.json` を S3 に保存。夕刊収集時に読み込んでプロンプトに注入。
S3 ロード失敗時は従来通りの動作にフォールバックします。

設計の詳細と Managed Agents 評価については [`docs/managed-agents-evaluation.md`](docs/managed-agents-evaluation.md) を参照。

## 外部研究ソース補強（Hacker News / arXiv / GitHub / RSS / Hugging Face）

`ENABLE_RESEARCH_HUB=true` を設定すると、`topics.yaml` に `research:` を書いたトピックについて
[research-hub-mcp](https://github.com/pyonta0215/research-hub-mcp) から候補記事を集め、直 fetch の結果と
同じ集約フェーズに渡します。Hugging Face公式モデルAPIも専用アダプタから同じ経路に合流します。
外部 API はいずれも無料・無認証のため**追加コストは Haiku の入力トークン分のみ**です。

MCP プロトコルは介さず、service 層（`search` / `trending`）を直接呼びます。Lambda のバッチ処理では
プロセス起動と JSON-RPC 往復が純粋な損になるためです（MCP サーバーとしては Claude Code から別途利用）。

```yaml
  - id: ai
    label: AI・LLM
    keywords: [Claude, GPT, Gemini, LLM, 生成AI]
    urls: [...]
    research:
      search:
        queries: [Claude, OpenAI, Gemini, LLM]  # 省略時は keywords を1語ずつ
        sources: [hackernews]                   # 省略時は全ソース（arXiv は実測6〜14秒と遅い）
        since: 2d
        limit: 3                                # 1クエリあたり
        # sort: score                           # 既定。date にすると HN の低スコア新着ばかりになる
      # trending:
      #   - { source: github, category: typescript, period: week }
      # huggingFace:
      #   authors: [Qwen, deepseek-ai, zai-org, moonshotai, MiniMaxAI]
      #   sinceDays: 7
```

**依存関係**: `research-hub-mcp` は GitHub のタグ参照（`github:pyonta0215/research-hub-mcp#v0.1.0`）で
入ります。`npm install` 時に依存側の `prepare` がビルドを走らせるため、追加の手順は不要です。

**環境変数**（Lambda では `infra/lib/lambdaStack.ts` が自動設定）:

| 変数 | 役割 |
|---|---|
| `ENABLE_RESEARCH_HUB` | `true` で補強を有効化 |
| `RESEARCH_HUB_FEEDS` | 購読リストの絶対パス。**バンドル後は自力解決できないため必須**（未指定だと rss ソースが常時0件になる） |
| `RESEARCH_HUB_CACHE` | `off` 推奨。TTL 5〜15分のキャッシュは1日2回の実行では再利用余地がない |

**計測**: 採用記事には取得経路が `origin` として付きます。`origin: 'research'` は
「外部研究ソースが返し、かつ直 fetch のテキストには存在しなかった」記事＝**純寄与**を意味します
（両方に出た記事は `fetch` に数えます）。ログは `[WebAgent] parsed: ... research由来 N`。

## ローカルテスト コマンド一覧

| コマンド | 内容 |
|---|---|
| `npx tsx scripts/test-run.ts --test-email` | SES 疎通テスト（テストメールのみ送信） |
| `npx tsx scripts/test-run.ts --dry-run` | 全パイプライン実行、メール送信のみスキップ |
| `npm run test-run` | 全体実行（Web 収集 → 生成 → SES 送信） |

## 動作フロー

Lambda は1本で、EventBridge Scheduler から `phase` を変えて3回呼ばれる。
**依存の向きは一方向で、後ろのフェーズが前のフェーズを知らない。**

```
6:15 JST  phase: collect   ★ メールを知らない
  WebAgent: topics.yaml の URL / Google News / research-hub から収集
            → Claude がトピック別に重要度スコア付きで集約（LLM 1回目）
  → archive/YYYY-MM-DD-morning.json   生データ。失うと復元できない
  → stories/index.json                ストーリー台帳（LLM 2回目）
  → delivered/                        配信済み履歴（14日で回る）

6:25 JST  phase: publish   ★ メールを知らない
  archive + stories → 閲覧サイトのファイルを決定的に組み立てて置く（LLMなし）

6:30 JST  phase: notify    ★ 蓄積を読むだけ
  その日の archive + 台帳の差分 → メール文面を組み立て → SES で送信（LLMなし）
```

分けている理由は、**蓄積は止めてはいけないが、紙面とメールは1日落ちても取り返せる**から。
一体にしておくと「メールの見た目を直したいだけなのに収集をやり直す」ことになる。

**LLM呼び出しは collect の2本（集約・ストーリー割当）で打ち止め。**
紙面も概観もメールも台帳からの決定的な計算で作るので、機能を足してもコストが増えない。

ローカルで通しで動かすときは `phase` を付けずに呼べば3つ順に走る（`DRY_RUN=true` で送信を抑止）。

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
    researchTool.ts         # research-hub アダプタ（HN/arXiv/GitHub/RSS の取得と正規化）
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
  cdk.json                  # CDK 設定 (app: npx tsx bin/app.ts)
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
