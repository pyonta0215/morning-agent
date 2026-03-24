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

    // 送信フェーズ: 6:30 JST (21:30 UTC 前日) — S3から読み出してメール送信
    new scheduler.CfnSchedule(this, 'SendSchedule', {
      name: 'morning-agent-send',
      description: '朝刊エージェント便 送信フェーズ 毎朝6:30 JST (UTC 21:30) に実行',
      scheduleExpression: 'cron(30 21 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'scheduler', phase: 'send' }),
      },
      state: 'ENABLED',
    });

    // 夕刊収集フェーズ: 17:45 JST (08:45 UTC) — ニュース収集・LLM統合・S3保存
    new scheduler.CfnSchedule(this, 'EveningCollectSchedule', {
      name: 'morning-agent-evening-collect',
      description: '夕刊エージェント便 収集フェーズ 毎夕17:45 JST (UTC 08:45) に実行',
      scheduleExpression: 'cron(45 8 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'scheduler', phase: 'evening-collect' }),
      },
      state: 'ENABLED',
    });

    // 夕刊送信フェーズ: 18:00 JST (09:00 UTC) — S3から読み出してメール送信
    new scheduler.CfnSchedule(this, 'EveningSendSchedule', {
      name: 'morning-agent-evening-send',
      description: '夕刊エージェント便 送信フェーズ 毎夕18:00 JST (UTC 09:00) に実行',
      scheduleExpression: 'cron(0 9 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'scheduler', phase: 'evening-send' }),
      },
      state: 'ENABLED',
    });
  }
}
