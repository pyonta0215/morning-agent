import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class MorningAgentLambdaStack extends cdk.Stack {
  public readonly lambdaFunction: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 収集〜送信フェーズ間のメール中間保存用バケット
    const storageBucket = new s3.Bucket(this, 'StorageBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          // メール中間データ: 送信漏れで残ったオブジェクトを1日後に自動削除
          prefix: 'pending/',
          expiration: cdk.Duration.days(1),
        },
        {
          // 編集コンテキスト: 前日コンテキストを翌朝まで保持するため2日間保存
          prefix: 'context/',
          expiration: cdk.Duration.days(2),
        },
      ],
    });

    this.lambdaFunction = new lambda.Function(this, 'MorningAgentFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../dist'),
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      environment: {
        NODE_ENV: 'production',
        SES_REGION: 'us-east-1',
        STORAGE_BUCKET: storageBucket.bucketName,
        // web_search 補強（デフォルト無効。デプロイ時に ENABLE_WEB_SEARCH=true で有効化）
        ENABLE_WEB_SEARCH: process.env.ENABLE_WEB_SEARCH ?? 'false',
        WEB_SEARCH_MAX_USES: process.env.WEB_SEARCH_MAX_USES ?? '1',
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
  }
}
