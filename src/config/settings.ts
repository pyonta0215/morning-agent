import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import type { AppConfig, Topic } from '../agents/base.js';

interface TopicsYaml {
  topics: Topic[];
}

async function getParameter(name: string, region: string): Promise<string> {
  const client = new SSMClient({ region });
  const command = new GetParameterCommand({ Name: name, WithDecryption: true });
  const response = await client.send(command);
  return response.Parameter?.Value ?? '';
}

function getTopicsDir(): string {
  // Lambda runtime
  if (process.env.LAMBDA_TASK_ROOT) return process.env.LAMBDA_TASK_ROOT;
  // Local dev with tsx (import.meta.url works in ESM)
  return path.dirname(fileURLToPath(import.meta.url));
}

function loadTopics(): Topic[] {
  const yamlPath = path.resolve(getTopicsDir(), 'topics.yaml');
  const raw = fs.readFileSync(yamlPath, 'utf-8');
  const parsed = yaml.load(raw) as TopicsYaml;
  return parsed.topics;
}

export interface FullConfig extends AppConfig {
  awsRegion: string;
}

export async function loadConfig(): Promise<FullConfig> {
  const region = process.env.AWS_REGION ?? 'ap-northeast-1';
  const topics = loadTopics();

  const sesRegion = process.env.SES_REGION ?? region;

  // ローカル開発時: process.env を優先して AWS APIをスキップ
  if (process.env.LOCAL_DEV === 'true') {
    return {
      recipientEmail: process.env.RECIPIENT_EMAIL ?? '',
      senderEmail: process.env.SENDER_EMAIL ?? '',
      deliveryTime: process.env.DELIVERY_TIME ?? '07:00',
      sesRegion,
      awsRegion: region,
      topics,
    };
  }

  // 本番: SSM Parameter Store から取得
  const [recipientEmail, senderEmail, deliveryTime, anthropicApiKey] = await Promise.all([
    getParameter('/morning-agent/recipient-email', region),
    getParameter('/morning-agent/sender-email', region),
    getParameter('/morning-agent/delivery-time', region),
    getParameter('/morning-agent/anthropic-api-key', region),
  ]);

  process.env.ANTHROPIC_API_KEY = anthropicApiKey;

  return {
    recipientEmail,
    senderEmail,
    deliveryTime,
    sesRegion,
    awsRegion: region,
    topics,
  };
}

// Lambda の traceId をグローバルに保持
let currentTraceId = 'local';

export function setTraceId(traceId: string): void {
  currentTraceId = traceId;
  process.env.AWS_LAMBDA_REQUEST_ID = traceId;
}

export function getTraceId(): string {
  return currentTraceId;
}
