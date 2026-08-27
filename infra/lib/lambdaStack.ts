import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface MorningAgentLambdaStackProps extends cdk.StackProps {
  /** 閲覧サイトのバケット名。siteStack と同じ literal を使う（クロスリージョン参照を作らないため） */
  readonly siteBucketName: string;
  /** Lambda実行ロールの固定名。siteStack がバケットポリシーで literal 参照する */
  readonly lambdaRoleName: string;
}

export class MorningAgentLambdaStack extends cdk.Stack {
  public readonly lambdaFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: MorningAgentLambdaStackProps) {
    super(scope, id, props);

    // 収集〜送信フェーズ間のメール中間保存用バケット。
    // stories/（ストーリー台帳）と notes/（自分のメモ）も入る。この2つは失うと復元できないので:
    //   - removalPolicy を RETAIN にして cdk destroy でも消えないようにする
    //   - バージョニングを有効にして、誤った上書きから戻せるようにする
    // （台帳は archive から再生成できない。LLMの判断が入るのでIDの対応が取れなくなる）
    const storageBucket = new s3.Bucket(this, 'StorageBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
      lifecycleRules: [
        {
          // 3フェーズ分離でメールの中間保存は不要になった（notify がアーカイブから直接作る）。
          // 過去に書かれた pending/ を掃除するためだけに残している
          prefix: 'pending/',
          expiration: cdk.Duration.days(1),
        },
        {
          // 編集コンテキスト: 前日コンテキストを翌朝まで保持するため2日間保存
          prefix: 'context/',
          expiration: cdk.Duration.days(2),
        },
        {
          // バージョニングで溜まる旧版の掃除。90日あれば誤上書きには十分気づける。
          // 全データが2MB程度なので保存料はほぼ生じないが、無限に積むのは避ける
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    // siteStack がバケットポリシーで literal 参照するため、ロール名を固定する
    const lambdaRole = new iam.Role(this, 'MorningAgentFunctionRole', {
      roleName: props.lambdaRoleName,
      description: 'morning-agent Lambda execution role',
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    this.lambdaFunction = new lambda.Function(this, 'MorningAgentFunction', {
      role: lambdaRole,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../dist'),
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      environment: {
        NODE_ENV: 'production',
        SES_REGION: 'us-east-1',
        STORAGE_BUCKET: storageBucket.bucketName,
        // 閲覧サイトの出力先（us-east-1）。publish フェーズが書く
        SITE_BUCKET: props.siteBucketName,
        // web_search 補強（本番デフォルト有効。コスト調整時に ENABLE_WEB_SEARCH=false で無効化）
        ENABLE_WEB_SEARCH: process.env.ENABLE_WEB_SEARCH ?? 'true',
        WEB_SEARCH_MAX_USES: process.env.WEB_SEARCH_MAX_USES ?? '1',
        // research-hub 補強（HN/arXiv/GitHub/RSS。外部APIコストは0）
        ENABLE_RESEARCH_HUB: process.env.ENABLE_RESEARCH_HUB ?? 'true',
        // バンドル後は import.meta.url が失われ購読リストの場所を自力解決できないため明示する
        // （未指定だとrssソースが常時0件になる。ビルド時に dist/feeds.json へコピー済み）
        RESEARCH_HUB_FEEDS: '/var/task/feeds.json',
        // キャッシュは無効。TTLが5〜15分なのに対し実行は1日2回で再利用余地がなく、
        // かつバンドル後は node:sqlite を解決できずどのみちインメモリに落ちる（毎回warnログが出る）
        RESEARCH_HUB_CACHE: 'off',
      },
    });

    // ses:SendEmail
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
      })
    );

    // ssm:GetParameter（/morning-agent/* のみ）
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:aws:ssm:ap-northeast-1:${this.account}:parameter/morning-agent/*`,
        ],
      })
    );

    // secretsmanager:GetSecretValue（morning-agent/* のみ）
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          `arn:aws:secretsmanager:ap-northeast-1:${this.account}:secret:morning-agent/*`,
        ],
      })
    );

    // S3: 中間保存バケットへの読み書き・削除
    storageBucket.grantReadWrite(this.lambdaFunction);
    storageBucket.grantDelete(this.lambdaFunction);

    // S3: 閲覧サイトのバケット（us-east-1・別スタック）。
    // バケット側にもロールARNを許可するポリシーが入っている（siteStack）。
    // 両側に書くのは、クロスリージョンのスタック参照を作らずに済ませるため
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject', 's3:ListBucket'],
        resources: [
          `arn:aws:s3:::${props.siteBucketName}`,
          `arn:aws:s3:::${props.siteBucketName}/*`,
        ],
      })
    );

    new cdk.CfnOutput(this, 'MorningAgentFunctionName', {
      value: this.lambdaFunction.functionName,
    });
  }
}
