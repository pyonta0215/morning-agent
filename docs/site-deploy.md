# 閲覧サイト `news.imai.me` のデプロイ手順

`MorningAgentSiteStack`（us-east-1）で、公開概観と Cognito 認証付き紙面を配信する。

## 構成

```
https://news.imai.me/            概観（公開）        … 集計値・活動の推移・自分のメモ・仕組みの図
https://news.imai.me/paper/      紙面（Cognito認証） … 記事の要約・全文検索・過去号・ストーリーの中身
```

| 要素 | 役割 |
|---|---|
| S3 | `morning-agent-site-<account>`。非公開で、CloudFront OAC 経由だけ読み取り可能 |
| CloudFront | 公開ファイルを配信し、`/paper/data.json` を認証 Lambda へ送る |
| Cognito | [imai-auth](https://github.com/pyonta0215/imai-auth) 共有User Pool(`auth.imai.me`)のnews App Client。Managed Login、OAuth Authorization Code + PKCE。product-owned User Pool/Client/Domainはrollback用にCloudFormation上のみ残存 |
| Paper API Lambda | `aws-jwt-verify` でアクセストークンを検証し、S3 の紙面データだけ返す |
| Route53 / ACM | `news.imai.me` の A / AAAA と TLS 証明書 |

紙面 HTML はログインを開始するための静的な殻で、記事・要約は含まない。機密データは
`paper/data.json` に分離し、次の2段で閉じる。

1. CloudFront Function がトークンのない要求を Lambda 手前で 401 にする
2. Lambda が JWT の署名、期限、token_use、User Pool、App Client を検証する

Lambda Function URL は `AWS_IAM` にし、CloudFront OAC からの
`lambda:InvokeFunctionUrl` / `lambda:InvokeFunction` だけを許可する。直URLは 403 になる。
CloudFront の SigV4 が `Authorization` を使うため、Cognito トークンは
`X-Morning-Token` で渡す。

S3 の既定 behavior は `infra/functions/site-path-guard.js` の許可リスト方式を維持する。
紙面の殻を除く未知のパスは 404 になり、将来 `/admin/` などを足しても自動公開されない。

## 前提

- Route53 に `imai.me` のホストゾーンがある（`Z07967483MFT3YWEGWUGM`）
- CDK が us-east-1 でブートストラップ済み
- `~/.aws` の既定プロファイルに CloudFormation / Cognito / Lambda / CloudFront / IAM / S3 の更新権限がある
- Cognito に作る本人用メールアドレスが決まっている

## 手順

### 1. ローカル検証

```bash
npm ci
npm test
npm run build
cd infra
npx tsc --noEmit -p tsconfig.json
npx cdk synth MorningAgentSiteStack --quiet
```

### 2. デプロイ

ルートから全スタックを更新する。

```bash
npm run deploy
```

完了すると Site Stack に次が出る。

- `ActiveAuthUserPoolId` / `ActiveAuthClientId`（実際に使う共有imai-auth側の値）
- `LegacyCognitoUserPoolId` / `LegacyCognitoUserPoolClientId` / `LegacyCognitoHostedUiDomain`（rollback用、product-owned pool）
- `PaperApiFunctionUrl`
- `PaperUrl`

Basic 認証用 KeyValueStore とその資格情報は不要になり、スタック更新時に削除される。
Product-owned User Pool は削除保護と `RETAIN` を設定しているため、通常のスタック削除では消えない。

### 3. ユーザー作成は不要（共有imai-authに移行済み）

認証は [imai-auth](https://github.com/pyonta0215/imai-auth) の共有User Poolを使うため、このサイト専用のユーザー作成は不要。共有User Poolに既に作成済みの本人アカウントでログインする。

以下はproduct-owned pool（rollback経路）に戻す場合のみ参考にする、旧手順。

```bash
aws cognito-idp admin-create-user --region us-east-1 \
  --user-pool-id <LegacyCognitoUserPoolId> \
  --username <本人メール> \
  --user-attributes Name=email,Value=<本人メール> Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

一時パスワードは Cognito から本人メールへ送られる。初回ログイン時に本人が恒久パスワードへ変更するため、
管理者のコマンド履歴やこのリポジトリにパスワードを残さない。

TOTP MFA は任意で有効化できる。SMS MFA は構成していないため、SMS 料金は発生しない。

### 4. 新しい紙面 HTML を反映

静的ファイルは `publish` フェーズが一元管理する。次の定期 publish を待つか、デプロイ直後に
`MorningAgentLambdaStack.MorningAgentFunctionName` を使って publish だけ実行する。LLM とメール送信は呼ばない。

```bash
aws lambda invoke --region ap-northeast-1 \
  --function-name <MorningAgentFunctionName> \
  --cli-binary-format raw-in-base64-out \
  --payload '{"phase":"publish"}' \
  /tmp/morning-agent-publish-result.json
```

### 5. デプロイ後の確認

```bash
curl -sI https://news.imai.me/                         # 200
curl -sI https://news.imai.me/paper/                   # 200（ログイン開始用HTMLのみ）
curl -sI https://news.imai.me/paper/data.json          # 401、データ本文なし
curl -sI https://news.imai.me/stories/index.json       # 404、未知パスは閉じる
curl -sI https://<PaperApiFunctionUrlのホスト>/paper/data.json  # 403、直URL拒否
```

ブラウザのシークレットウィンドウでも確認する。

1. `https://news.imai.me/paper/` が Cognito Hosted UI へ移動する
2. 作成したユーザーでログインすると紙面が表示される
3. 「ログアウト」で公開トップへ戻る
4. ログアウト後に `/paper/` を開くと再び Hosted UI へ移動する

## コスト判断

個人1名・通常閲覧なら、今回増える認証コストは実質 `$0/月` の想定。

| 要素 | このサイトでの利用 | 判断 |
|---|---|---|
| Cognito | imai-auth共有User Pool(Essentials)の1 MAU分 | 共有コストとしてimai-auth側で計上。直接サインインは月10,000 MAUまで無料枠内 |
| Paper API Lambda | 紙面を開くごとに1回、256MB・短時間 | 月100万リクエスト / 400,000 GB秒の無料枠内 |
| CloudFront Function | 匿名要求の一次拒否 | 既存 CloudFront の小規模利用内 |
| S3 GET | 紙面を開くごとに1回 | 数MB規模・個人利用では無視できる水準 |

公式料金: [Cognito](https://aws.amazon.com/cognito/pricing/) / [Lambda](https://aws.amazon.com/lambda/pricing/) /
[CloudFront](https://aws.amazon.com/cloudfront/pricing/)

ただし AWS にハードな支出上限はない。無料枠はアカウントまたは Organization 単位で他プロジェクトと
合算されるため、デプロイ後1か月は Cost Explorer で `Cognito` / `Lambda` / `CloudFront` の実額を確認する。
認証設定 JSON は5分キャッシュし、匿名の紙面データ要求はエッジで落とすため、通常アクセスで不要な
Lambda 呼び出しが増えないようにしている。

## キャッシュとデータ更新

- 公開 HTML / JSON は `Cache-Control: public, max-age=60`
- 認証設定は `max-age=300`
- 紙面データは `private, no-store` かつ CloudFront キャッシュ無効
- `CreateInvalidation` は通常使わない。日次 publish と短い TTL で更新する

サイトへの書き込み Lambda は ap-northeast-1、サイトバケットと認証 Lambda は us-east-1。
クロスリージョン参照を増やさないため、サイトバケット名と書き込みロール名は
`infra/bin/app.ts` の固定規則で両スタックから同じ値を参照する。
