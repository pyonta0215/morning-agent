import { loadTopics, storyTopicIds } from '../src/config/settings.js';

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) {
    console.error(`FAIL ${name}`, detail ?? '');
    process.exitCode = 1;
    return;
  }
  console.log(`PASS ${name}`);
}

const topics = loadTopics();
const ids = topics.map((topic) => topic.id);
const byId = new Map(topics.map((topic) => [topic.id, topic]));
const storyIds = storyTopicIds(topics);

check('topic id が重複していない', new Set(ids).size === ids.length, ids);
check(
  'maxItems は正の整数',
  topics.every(
    (topic) => topic.maxItems === undefined || (Number.isInteger(topic.maxItems) && topic.maxItems > 0)
  )
);
check('ai は既存どおりストーリー対象', storyIds.has('ai'));
check('ai_oss は観測中のためストーリー対象外', !storyIds.has('ai_oss'));
check('ai_model は観測中のためストーリー対象外', !storyIds.has('ai_model'));

const aiFamily = ['ai', 'ai_oss', 'ai_model'].map((id) => byId.get(id));
check('AI系3トピックが定義されている', aiFamily.every(Boolean), aiFamily);
check(
  'AI系の紙面上限は合計12件',
  aiFamily.reduce((sum, topic) => sum + (topic?.maxItems ?? 8), 0) === 12,
  aiFamily.map((topic) => ({ id: topic?.id, maxItems: topic?.maxItems }))
);

if (process.exitCode) process.exit(process.exitCode);
