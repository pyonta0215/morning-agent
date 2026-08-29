import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// imai-auth共有Cognito(us-east-1、ImaiAuthStack)のnews用リソース。秘密では
// ない(User Pool ID/Client ID/issuerは非機密)ためソースに置いてよい。値は
// `aws cloudformation describe-stacks --stack-name ImaiAuthStack` の出力を
// 2026-08-30に転記した。参照: https://github.com/pyonta0215/imai-auth
const SHARED_AUTH_USER_POOL_ID = 'us-east-1_aqVfPpe0K';
const SHARED_AUTH_CLIENT_ID = '7h7cm70etgomvam3gt5daarog3';
const SHARED_AUTH_DOMAIN = 'https://auth.imai.me';

export interface SiteStackProps extends cdk.StackProps {
  /** 公開ホスト名（例: news.imai.me） */
  readonly domainName: string;
  /** 親ゾーン（例: imai.me） */
  readonly zoneName: string;
  readonly hostedZoneId: string;
  /** バケット名。lambdaStack 側が同じ名前を literal で参照するため固定する */
  readonly siteBucketName: string;
  /** Cognito が払い出す Hosted UI ドメインの一意なプレフィックス */
  readonly cognitoDomainPrefix: string;
}

/**
 * 閲覧サイト `news.imai.me`。**1つのディストリビューションで2つの面を出す。**
 *
 *   /            概観（公開）        … 集計値・活動の推移・自分のメモ・仕組みの図だけ
 *   /paper/      紙面（Cognito認証） … 記事の要約・全文検索・過去号・ストーリーの中身
 *
 * 紙面 HTML は OAuth を開始するための殻として公開し、中身の paper/data.json は
 * CloudFront OAC で閉じた Lambda が Cognito JWT を検証して返す。S3 の既定 behavior は
 * CloudFront Function の許可リストを通し、未知のパスは引き続き fail closed にする。
 *
 * CloudFront の証明書は us-east-1 にしか置けないため、このスタックごと us-east-1 に置く。
 * 書き込む Lambda は ap-northeast-1 にあるので、スタックを跨いだ参照を作らずに済むよう
 * バケット名を固定し、書き込み許可は Lambda 側のIDベースのポリシーだけで与える
 * （同一アカウントならバケットポリシーは要らない。詳細は下のコメント）。
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

    const callbackUrl = `https://${props.domainName}/paper/`;
    const logoutUrl = `https://${props.domainName}/`;

    // imai-auth共有Cognitoへ移行済み。このproduct-owned User Pool/Client/Domain
    // は、rollbackとsoak期間中の参照用にCloudFormation上は残すが、下のLambda
    // 環境変数からはもう参照しない。削除は2製品のE2E検証・soak完了後に別Issue/
    // 変更で行う(imai-authリポジトリのdocs/migration-guide.md参照)。
    const userPool = new cognito.UserPool(this, 'PaperUserPool', {
      userPoolName: 'morning-agent-paper',
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      // SMS の送信費を発生させず、必要なら認証アプリの TOTP を有効化できる。
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient('PaperWebClient', {
      userPoolClientName: 'morning-agent-paper-web',
      generateSecret: false,
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [callbackUrl],
        logoutUrls: [logoutUrl],
      },
    });

    const userPoolDomain = userPool.addDomain('PaperHostedUiDomain', {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
      // 他プロジェクトで運用実績のある Cognito 提供 UI。独自ログイン画面を保守しない。
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });

    const pathGuard = new cloudfront.Function(this, 'SitePathGuard', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, '..', 'functions', 'site-path-guard.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: 'news.imai.me の S3 公開パス許可リスト（未知のパスは閉じる）',
    });

    const tokenPresenceGuard = new cloudfront.Function(this, 'PaperTokenPresenceGuard', {
      code: cloudfront.FunctionCode.fromFile({
        filePath: path.join(__dirname, '..', 'functions', 'paper-token-presence.js'),
      }),
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      comment: '匿名の紙面データ要求を Lambda 手前で拒否する一次フィルタ',
    });

    const paperApi = new nodejs.NodejsFunction(this, 'PaperApiFunction', {
      entry: path.join(__dirname, '..', 'functions', 'paper-api.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      bundling: { minify: true, sourceMap: true },
      environment: {
        SITE_BUCKET: bucket.bucketName,
        // imai-auth共有Cognitoのnews Client。product-owned pool(userPool/
        // userPoolClient/userPoolDomain、上記)のIDは渡さない(rollback用に
        // 温存のみ)。
        COGNITO_USER_POOL_ID: SHARED_AUTH_USER_POOL_ID,
        COGNITO_CLIENT_ID: SHARED_AUTH_CLIENT_ID,
        COGNITO_DOMAIN: SHARED_AUTH_DOMAIN,
        REDIRECT_URI: callbackUrl,
        LOGOUT_URI: logoutUrl,
      },
    });
    bucket.grantRead(paperApi, 'paper/data.json');

    // 直URLは IAM で拒否し、CloudFront OAC が署名したリクエストだけを通す。
    const paperApiUrl = paperApi.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });
    const paperApiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(paperApiUrl);

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

    const paperTokenOriginRequestPolicy = new cloudfront.OriginRequestPolicy(
      this,
      'PaperTokenOriginRequestPolicy',
      {
        comment: '紙面 API へ Cognito トークンだけを転送する',
        headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList('x-morning-token'),
        cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.none(),
      }
    );

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'morning-agent 閲覧サイト（概観＝公開 / 紙面＝Cognito認証）',
      defaultRootObject: 'index.html',
      domainNames: [props.domainName],
      certificate,
      // 日本から見られれば足りるので、全世界のエッジには置かない
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: responseHeaders,
        // 公開層は短い Cache-Control と CloudFront の通常キャッシュを使う
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: pathGuard, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        // OAuth の公開設定。短時間キャッシュし、通常の閲覧で Lambda を毎回呼ばない。
        '/paper/auth-config.json': {
          origin: paperApiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: responseHeaders,
          compress: true,
        },
        // 機密データ。一次フィルタで匿名要求を落とし、Lambda で JWT を完全検証する。
        '/paper/data.json': {
          origin: paperApiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: paperTokenOriginRequestPolicy,
          responseHeadersPolicy: responseHeaders,
          compress: true,
          functionAssociations: [
            {
              function: tokenPresenceGuard,
              eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
            },
          ],
        },
      },
      errorResponses: [
        // S3 は存在しないキーに 403 を返す（ListBucket を与えていないため）
        { httpStatus: 403, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 404, responsePagePath: '/404.html', ttl: cdk.Duration.minutes(5) },
      ],
    });

    // Lambda Function URL + OAC は InvokeFunctionUrl と InvokeFunction の両方が必要。
    // CDK の FunctionUrlOrigin が前者を追加するので、後者を明示する。
    paperApi.addPermission('InvokeFunctionFromCloudFront', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: distribution.distributionArn,
    });

    // 書き込みは ap-northeast-1 の Lambda から。**バケットポリシーは書かない。**
    // 同一アカウントならIDベースのポリシー（lambdaStack 側）だけで通るうえ、
    // ここにロールARNを書くとロールが先に存在しないとスタックが作れなくなる
    // （S3 はポリシー作成時にプリンシパルの実在を検証する。実際に一度これで失敗した）。
    // スタックの作成順に依存しないよう、許可は Lambda 側に片寄せしている。

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
    new cdk.CfnOutput(this, 'LegacyCognitoUserPoolId', {
      value: userPool.userPoolId,
      description: 'Product-owned pool, kept for rollback only; the running app uses the shared imai-auth pool.',
    });
    new cdk.CfnOutput(this, 'LegacyCognitoUserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Product-owned client, kept for rollback only.',
    });
    new cdk.CfnOutput(this, 'LegacyCognitoHostedUiDomain', { value: userPoolDomain.baseUrl() });
    new cdk.CfnOutput(this, 'ActiveAuthUserPoolId', {
      value: SHARED_AUTH_USER_POOL_ID,
      description: 'Shared imai-auth user pool ID actually used by this product (see COGNITO_USER_POOL_ID).',
    });
    new cdk.CfnOutput(this, 'ActiveAuthClientId', {
      value: SHARED_AUTH_CLIENT_ID,
      description: 'Shared imai-auth news app-client ID actually used by this product.',
    });
    new cdk.CfnOutput(this, 'PaperApiFunctionUrl', { value: paperApiUrl.url });
  }
}
