# 閲覧サイト `news.imai.me` のデプロイ手順

`MorningAgentSiteStack`（us-east-1）を立てて、パス別のBasic認証をかけるまでの手順。

## 構成

```
https://news.imai.me/            概観（公開）      … 集計値・活動の推移・自分のメモ・仕組みの図
https://news.imai.me/paper/      紙面（Basic認証） … 記事の要約・全文検索・過去号・ストーリーの中身
```

| | |
|---|---|
| S3 | `morning-agent-site-<account>`（us-east-1・非公開・OAC経由でのみCloudFrontに読ませる） |
| CloudFront | PriceClass 200／証明書はACM（us-east-1）／`X-Robots-Tag: noindex, nofollow` |
| 認証 | CloudFront Function（JS 2.0）＋ KeyValueStore |
| DNS | Route53 `imai.me` ゾーンに A / AAAA のエイリアス |

**認証は「既定で必須、公開パスだけ明示除外」**（`infra/functions/site-auth.js`）。
逆向き（`/paper/` だけ認証）にすると、あとから `/admin/` や `/data/` を足したときに素通りする。

公開パスの判定はセキュリティ境界なのでテストがある:

```bash
npm run test:site-auth
```

## 前提

- Route53 に `imai.me` のホストゾーンがある（`Z07967483MFT3YWEGWUGM`）
- CDK が us-east-1 でブートストラップ済み（未実施なら `npx cdk bootstrap aws://<account>/us-east-1`）
- 認証情報は `~/.aws` の既定プロファイル。**`.env` の SES 用キーでは権限が足りない**

## 手順

### 1. デプロイ

```bash
cd infra && npx cdk deploy MorningAgentSiteStack
```

ACM の証明書は Route53 に検証用CNAMEを自動で入れて発行される。数分かかる。
完了すると出力に `SiteUrl` / `PaperUrl` / `SiteBucketName` / `DistributionId` / `KvsArn` が出る。

### 2. Basic認証の資格情報を入れる

**リポジトリにもCDKにも置かない。** CLIで KeyValueStore に直接入れる。

```bash
KVS_ARN=<出力の KvsArn>
ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store --kvs-arn "$KVS_ARN" --query ETag --output text)
aws cloudfront-keyvaluestore put-key --kvs-arn "$KVS_ARN" --if-match "$ETAG" \
  --key authorization --value "Basic $(printf '%s' 'ユーザ名:パスワード' | base64)"
```

鍵を入れるまで、認証が要るパスは **401 ではなく 503** を返す。
未登録のまま素通りさせるほうが危険なので、開くのではなく閉じる作りにしてある。

### 3. 確認

```bash
curl -sI https://news.imai.me/            # 200（認証なしで見える）
curl -sI https://news.imai.me/paper/      # 401
curl -sI -u 'ユーザ名:パスワード' https://news.imai.me/paper/   # 200
curl -sI https://news.imai.me/stories/index.json   # 401（whitelistに無いものは閉じる）
```

## Lambda 側の権限

サイトへの書き込みは ap-northeast-1 の Lambda から行う。
CDKのクロスリージョン参照（裏でSSMのスタックが増える）を避けるため、
**バケット名とロール名を `infra/bin/app.ts` の literal で固定**し、両側から同じ名前を参照している。

```
SITE_BUCKET_NAME = morning-agent-site-<account>
LAMBDA_ROLE_NAME = morning-agent-lambda
```

片方だけ変えると権限が切れる。変えるときは必ず両方。

## キャッシュ無効化はしない

サイトの更新は1日1回なので、オリジン側の `Cache-Control` を短くしておけば足りる。
`CreateInvalidation` は月1,000件を超えると課金対象になるうえ、権限とクロススタック参照を
1つずつ増やすので採らなかった。publish フェーズは `Cache-Control: public, max-age=60` を付けて書く。

## 既存スタックへの影響（`MorningAgentLambdaStack`）

同時に次を変更している。どちらもバケットの置き換えは起きない（論理IDもバケット名も変えていない）。

- `removalPolicy` を `DESTROY` → **`RETAIN`**、`autoDeleteObjects` を撤去。
  `stories/`（台帳）と `notes/`（メモ）は失うと復元できないので、`cdk destroy` で消えないようにする
- **バージョニングを有効化**。誤った上書きから戻せるようにする。
  旧版は90日で消す（全データが2MB程度なので保存料はほぼ生じない）
- Lambda実行ロールを**固定名 `morning-agent-lambda`** の明示ロールに変更。
  CloudFormation が新ロールを作って関数を差し替え、旧ロールを消す

## コスト

| | 月額 | 根拠 |
|---|---|---|
| S3（サイト） | 実質 $0 | 数MB |
| CloudFront | $0 | 常時無料枠（1TB転送／1,000万リクエスト／200万Function呼び出し）内 |
| KeyValueStore | $0 | Functions の無料枠に含まれる |
| ACM / Route53 | $0 | 証明書は無料、ゾーンは既存でサブドメイン追加は無料 |

**無料枠はアカウント単位**（job-posting-lifespan と合算）なので、デプロイ後1ヶ月は Cost Explorer で実額を確認する。
