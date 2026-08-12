import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface SiteStackProps extends cdk.StackProps {
  /** 公開ホスト名（例: news.imai.me） */
  readonly domainName: string;
  /** 親ゾーン（例: imai.me） */
  readonly zoneName: string;
  readonly hostedZoneId: string;
  /** サイトへ書き込む Lambda のロールARN。別リージョンの別スタックにあるため文字列で渡す */
  readonly publisherRoleArn: string;
  /** バケット名。lambdaStack 側が同じ名前を literal で参照するため固定する */
  readonly siteBucketName: string;
}

/**
 * 閲覧サイト `news.imai.me`。**1つのディストリビューションで2つの面を出す。**
 *
 *   /            概観（公開）        … 集計値・活動の推移・自分のメモ・仕組みの図だけ
 *   /paper/      紙面（Basic認証）   … 記事の要約・全文検索・過去号・ストーリーの中身
 *
 * 認証は CloudFront Function で行い、**既定は認証必須・公開パスのみ明示除外**にしてある
 * （functions/site-auth.js）。資格情報は KeyValueStore に置き、関数コードにも
 * リポジトリにも残さない。
 *
 * CloudFront の証明書は us-east-1 にしか置けないため、このスタックごと us-east-1 に置く。
 * 書き込む Lambda は ap-northeast-1 にあるので、スタックを跨いだ参照を作らずに済むよう
 * バケット名を固定し、権限はバケットポリシーでロールARNを直接許可する。
 *
 * キャッシュ無効化（CreateInvalidation）は使わない。サイトの更新は1日1回で、
 * オリジン側の Cache-Control を短くしておけば足りる。無効化は月1,000件を超えると
 * 課金対象になるうえ、権限とクロススタック参照を1つずつ増やすので割に合わない。
 */
export class MorningAgentSiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    // サイトは毎日作り直される派生データだが、消し忘れの事故を避けてスタック削除では残す
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: props.siteBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 中身は空で作る。資格情報は AWS CLI で入れる（リポジトリにも CDK にも置かない）
    const store = new cloudfront.KeyValueStore(this, 'AuthStore', {
      comment: 'Basic 認証の資格情報。key=authorization, value="Basic <base64>"',
    });

    const authFn = new cloudfront.Function(this, 'SiteAuthFn', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, '..', 'functions', 'site-auth.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0, // KeyValueStore は 2.0 必須
      keyValueStore: store,
      comment: 'news.imai.me のパス別Basic認証（既定は認証必須・公開パスのみ除外）',
    });

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.zoneName,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const responseHeaders = new cloudfront.ResponseHeadersPolicy(this, 'ResponseHeaders', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          // 公開層も含めて検索避けする。人に見せるのはURLを渡す運用で、検索から来る必要が無い。
          // 索引に載せたくなったら公開層だけ別behaviorに切り出してこのヘッダを外す
          { header: 'X-Robots-Tag', value: 'noindex, nofollow', override: true },
        ],
      },
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'morning-agent 閲覧サイト（概観＝公開 / 紙面＝Basic認証）',
      defaultRootObject: 'index.html',
      domainNames: [props.domainName],
      certificate,
      // 日本から見られれば足りるので、全世界のエッジには置かない
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: responseHeaders,
        // 401 を配りたくないので、認証がかかる面はキャッシュせず毎回関数を通す
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: authFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      errorResponses: [
        // S3 は存在しないキーに 403 を返す（ListBucket を与えていないため）
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) },
      ],
    });

    // 書き込みは ap-northeast-1 の Lambda から。クロスリージョンのスタック参照を
    // 作らずに済むよう、ロールARNを文字列で受けてバケットポリシーに直接書く
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ArnPrincipal(props.publisherRoleArn)],
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject', 's3:ListBucket'],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      })
    );

    new route53.ARecord(this, 'ARecord', {
      zone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'AaaaRecord', {
      zone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: `https://${props.domainName}` });
    new cdk.CfnOutput(this, 'PaperUrl', { value: `https://${props.domainName}/paper/` });
    new cdk.CfnOutput(this, 'SiteBucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'KvsArn', { value: store.keyValueStoreArn });
  }
}
