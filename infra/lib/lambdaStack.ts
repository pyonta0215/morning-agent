import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class MorningAgentLambdaStack extends cdk.Stack {
  public readonly lambdaFunction: lambda.Function;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    this.lambdaFunction = new lambda.Function(this, 'MorningAgentFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('../dist'),
      timeout: cdk.Duration.minutes(10),
      memorySize: 512,
      environment: {
        NODE_ENV: 'production',
        SES_REGION: 'us-east-1',
      },
    });

    // ses:SendEmail（最小権限: 宛先メールアドレスを実際の値に絞る場合はリソースARNを指定）
    this.lambdaFunction.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'], // SESの送信権限はリソースARN指定が複雑なため * を使用
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
  }
}
