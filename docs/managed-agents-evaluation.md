# Managed Agents 適用評価レポート

作成日: 2026-04-09  
対象: morning-agent（朝夕2回のニュースブリーフィングメール自動生成）

---

## 1. 評価背景

Anthropic の Managed Agents（`/v1/agents`, `/v1/sessions`）を、既存の朝夕ニュース配信システムに
どこまで部分適用できるかを検証した。目的は「なんでも Managed Agents 化する」ことではなく、
価値がある箇所だけを小さく安全に試すことにある。

---

## 2. SDK 実態調査の結果

**インストール済み: `@anthropic-ai/sdk@0.80.0`**

```
beta/
├── files.ts
├── messages/
├── models.ts
└── skills/   ← beta: skills-2025-10-02（スキル再利用API）
```

**`agents/` および `sessions/` は SDK 0.80.0 に存在しない。**

Sessions API / Agents API は、現行インストール済み SDK では利用不可。  
利用するには SDK のバージョンアップが必要だが、安定化のタイミングを見て判断する。

---

## 3. 部位別の適用可否判断

### 取得層（WebAgent）
**判断: そのままでよい**

- 現状は parallel fetch（`Promise.all`）で全URL同時取得 → LLM 1回で集約
- 以前の tool-use ループから変更し、コストを約90%削減済み
- Sessions API を使っても取得効率に差は出ない
- ネットワーク取得は規約・レート制限の観点からコードで制御するのが適切

### 重複排除・既読管理
**判断: コードで処理すべき**

- 日付フィルタ以外の重複排除は未実装だが、LLM より URL ハッシュのほうが正確・安価
- Sessions の "memory" は自然言語ベースのため、URL 重複チェックには不向き
- 改善するなら DynamoDB や S3 に送達済み URL を記録するのが正道

### 注目ピック生成（ComposerAgent）
**判断: Messages API で十分。ただし継続性に改善余地あり**

- 現状: `messages.create()` 1回で top 3 記事を選出
- Sessions API があれば朝刊セッションを夕刊まで保持し、
  「朝から変化したトピック」を自然に捉えられる
- ただし **S3 にピック JSON を保存してプロンプトに注入する** ことで同等の効果が得られる
- Lambda 起動間隔（朝6:15→夕5:45）を考えると、S3 経由のほうがシンプルで信頼性が高い

### 新聞ふう編集・コラム文
**判断: プロンプト改善で対応。Haiku で成立**

- 見出し・リード文の質は Haiku でも改善余地がある
- もし「コラム的な読み物」品質を求めるなら Sonnet 系への切り替えを検討
- Sessions での multi-turn refinement（draft→critique→refine）は品質向上に効くが、
  1回の配信で2〜3ターン = コスト2〜3倍になるため導入コストに見合うか要検討

---

## 4. 実装した PoC

### 機能: Enhanced Editorial（朝刊→夕刊の継続性）

**有効化**: `ENHANCED_EDITORIAL=true`（環境変数）

**フロー**:
```
朝刊収集フェーズ (6:15 JST)
  → WebAgent: ニュース取得・集約
  → ComposerAgent: ピック生成
  → S3 保存: pending/morning-email.json（メール本文）
  → S3 保存: context/morning.json（ピック + トピック情報）← 新規

夕刊収集フェーズ (5:45 JST)
  → S3 読み込み: context/morning.json ← 新規
  → WebAgent: ニュース取得・集約
  → ComposerAgent: 朝刊コンテキスト注入 + ピック生成 ← 変更
  → S3 保存: pending/evening-email.json
  → S3 保存: context/evening.json ← 新規
```

**プロンプト注入例（夕刊時）**:
```
【前回の朝刊で取り上げた注目記事】
・Claude 3.7 Sonnet 発表：マルチモーダル性能が大幅向上、実務活用が加速
・日銀 政策金利引き上げ：市場は年内追加利上げを織り込む動き

夕刊では以下の方針で選んでください：
- 朝刊から進展があったトピックは積極的に取り上げ、変化を補足してください
- 朝刊と同じ記事の重複選出は避けてください
- 朝刊が扱っていない視点や新しいトピックも1件含めてください
```

**フォールバック**: S3 ロード失敗・ENHANCED_EDITORIAL 未設定時は従来通り動作

### 新規ファイル
- `src/utils/editorialContext.ts`: EditorialContext 型定義 + S3 読み書きユーティリティ

### 変更ファイル
- `src/agents/composerAgent.ts`: `previousContext` パラメータ追加、プロンプト注入、picks を返り値に含める
- `src/index.ts`: 収集フェーズにコンテキスト読み書きを追加

---

## 5. コスト・運用・品質の評価

| 観点 | 評価 |
|---|---|
| **コスト追加** | S3 の GetObject/PutObject 数回分のみ（コスト増 < $0.01/月）|
| **LLM コスト変化** | なし。Haiku モデル・呼び出し回数はそのまま |
| **Lambda タイムアウトリスク** | S3 読み書きは数十ms程度、影響なし |
| **品質向上の期待値** | 夕刊の「朝からの文脈補足」が自然になる。効果は実際の出力で検証が必要 |
| **失敗時の影響** | S3 ロード失敗時は従来動作にフォールバック。サービス断なし |
| **運用コスト** | 環境変数1つで On/Off。設定変更なし |

### Haiku vs Sonnet の判断

現状の Haiku モデルで成立するか:
- **記事ピック選出**: Haiku で十分（単純なランキング + 1〜2文コメント）
- **継続性コメント**: Haiku で試せる。「朝刊で○○を取り上げた、夕刊では□□の進展を補足」程度なら可
- **新聞ふうコラム**: より文学的な表現を求めるなら Sonnet 4.6 が有効
  - Sonnet への切り替えは `MODEL` 定数の変更のみ（`composerAgent.ts:7`）
  - コスト: Haiku ~$0.003/run → Sonnet ~$0.020/run（約7倍）

---

## 6. 今後の拡張候補

### 優先度高
1. **前日コンテキスト**（日をまたぐ継続性）
   - 現状は同日の朝→夕のみ
   - `context/YYYY-MM-DD-morning.json` 形式で保存すれば翌朝にも参照可能
   
2. **重複排除の強化**
   - 送達済み URL を S3/DynamoDB に記録
   - WebAgent の後段でコードによるフィルタリング

### 優先度中
3. **Sessions API への移行**（SDK が安定したら）
   - S3 JSON 注入を Server-side session に置き換え
   - 移行コストは低い（EditorialContext 型はそのまま使える）

4. **品質評価の仕組み**
   - ComposerAgent の出力ピックを S3 に永続保存（現在は1日で削除）
   - 過去ピックとの重複率・スコア分布をログで追う

### 優先度低
5. **多ターン editorial refinement**
   - draft → critique → refine の2〜3ターン
   - Sessions API が必要。品質向上コスト対効果を検証してから判断

---

## 7. 検証方法

### ローカル動作確認

```bash
# 朝刊収集（コンテキスト保存）
DRY_RUN=true ENHANCED_EDITORIAL=true npm run test-run

# その後、夕刊収集（コンテキスト読み込み）をシミュレートするには
# scripts/test-run.ts の phase を 'evening-collect' に変えて実行
```

### AWS 本番環境での有効化

```bash
# Lambda 環境変数に追加
aws lambda update-function-configuration \
  --function-name MorningAgentFunction \
  --environment Variables="{ENHANCED_EDITORIAL=true,NODE_ENV=production,SES_REGION=us-east-1,STORAGE_BUCKET=<bucket>}"
```

### 効果の確認ポイント
- CloudWatch Logs で `EDITORIAL_CONTEXT_SAVED` / `EDITORIAL_CONTEXT_LOADED` ログを確認
- 夕刊の picks に「朝刊で取り上げた○○の続報」「朝から変化した点」などが含まれているか確認
- 朝夕で同じ記事が重複していないか確認

---

## 8. 結論

**Messages API で十分。Managed Agents（Sessions API）の適用は時期尚早。**

理由:
1. SDK 0.80.0 に Sessions API が存在しない
2. 朝夕2回・1〜2 LLM 呼び出しの規模では、S3 コンテキスト注入で十分な継続性が得られる
3. Sessions API が安定化した時点で、EditorialContext を Sessions に移行する余地は十分ある

今回実装した Enhanced Editorial は「Sessions API が提供したい価値（朝→夕の文脈継続）を
Messages API + S3 で実現した最小 PoC」として位置づける。
