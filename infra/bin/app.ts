#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MorningAgentLambdaStack } from '../lib/lambdaStack.js';
import { MorningAgentSchedulerStack } from '../lib/schedulerStack.js';

const app = new cdk.App();

const env = {
  account: process.env.CDK_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: 'ap-northeast-1',
};

const lambdaStack = new MorningAgentLambdaStack(app, 'MorningAgentLambdaStack', { env });

new MorningAgentSchedulerStack(app, 'MorningAgentSchedulerStack', {
  env,
  lambdaFunction: lambdaStack.lambdaFunction,
});
