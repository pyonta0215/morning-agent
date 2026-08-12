import * as cdk from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface SchedulerStackProps extends cdk.StackProps {
  lambdaFunction: lambda.Function;
}

export class MorningAgentSchedulerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SchedulerStackProps) {
    super(scope, id, props);

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['lambda:InvokeFunction'],
        resources: [props.lambdaFunction.functionArn],
      })
    );

    // 収集フェーズ: 6:15 JST (21:15 UTC 前日) — ニュース収集・LLM統合・S3保存
    new scheduler.CfnSchedule(this, 'CollectSchedule', {
      name: 'morning-agent-collect',
      description: '朝刊エージェント便 収集フェーズ 毎朝6:15 JST (UTC 21:15) に実行',
      scheduleExpression: 'cron(15 21 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'scheduler', phase: 'collect' }),
      },
      state: 'ENABLED',
    });

    // 紙面生成フェーズ: 6:25 JST (21:25 UTC 前日) — アーカイブと台帳からサイトを組み立てて置く
    new scheduler.CfnSchedule(this, 'PublishSchedule', {
      name: 'morning-agent-publish',
      description: '朝刊エージェント便 紙面生成フェーズ 毎朝6:25 JST (UTC 21:25) に実行',
      scheduleExpression: 'cron(25 21 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'scheduler', phase: 'publish' }),
      },
      state: 'ENABLED',
    });

    // 通知フェーズ: 6:30 JST (21:30 UTC 前日) — その日のアーカイブから文面を作って送信
    new scheduler.CfnSchedule(this, 'SendSchedule', {
      name: 'morning-agent-send',
      description: '朝刊エージェント便 通知フェーズ 毎朝6:30 JST (UTC 21:30) に実行',
      scheduleExpression: 'cron(30 21 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'scheduler', phase: 'notify' }),
      },
      state: 'ENABLED',
    });

    // 夕刊（evening-collect / evening-send）は廃止し、朝刊のみの配信に変更。
    // 夕刊のアプリコード（index.ts の evening phase ハンドラ）は手動実行用に温存。
  }
}
