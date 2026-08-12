#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MorningAgentLambdaStack } from '../lib/lambdaStack.js';
import { MorningAgentSchedulerStack } from '../lib/schedulerStack.js';
import { MorningAgentSiteStack } from '../lib/siteStack.js';

const app = new cdk.App();

const account = process.env.CDK_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '788041541975';
const env = { account, region: 'ap-northeast-1' };

// siteStack（us-east-1）と lambdaStack（ap-northeast-1）はこの2つの literal で繋ぐ。
// CDK のクロスリージョン参照は SSM を経由する隠れたスタックを増やすので、名前を固定して避ける
const SITE_BUCKET_NAME = `morning-agent-site-${account}`;
const LAMBDA_ROLE_NAME = 'morning-agent-lambda';

const lambdaStack = new MorningAgentLambdaStack(app, 'MorningAgentLambdaStack', {
  env,
  siteBucketName: SITE_BUCKET_NAME,
  lambdaRoleName: LAMBDA_ROLE_NAME,
});

new MorningAgentSchedulerStack(app, 'MorningAgentSchedulerStack', {
  env,
  lambdaFunction: lambdaStack.lambdaFunction,
});

// CloudFront の証明書は us-east-1 にしか置けないため、スタックごと us-east-1 に置く
new MorningAgentSiteStack(app, 'MorningAgentSiteStack', {
  env: { account, region: 'us-east-1' },
  description: 'morning-agent 閲覧サイト（概観＝公開 / 紙面＝Basic認証）',
  domainName: 'news.imai.me',
  zoneName: 'imai.me',
  hostedZoneId: 'Z07967483MFT3YWEGWUGM',
  siteBucketName: SITE_BUCKET_NAME,
});
