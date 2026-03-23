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

    new scheduler.CfnSchedule(this, 'MorningAgentSchedule', {
      name: 'morning-agent-daily',
      description: '朝刊エージェント便 毎朝7:00 JST (UTC 22:00) に実行',
      scheduleExpression: 'cron(0 22 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: {
        mode: 'FLEXIBLE',
        maximumWindowInMinutes: 5,
      },
      target: {
        arn: props.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ source: 'scheduler' }),
      },
      state: 'ENABLED',
    });
  }
}
