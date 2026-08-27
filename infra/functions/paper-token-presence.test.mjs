import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'paper-token-presence.js'), 'utf-8');
const handler = new Function(`${src}; return handler;`)();

const anonymous = { request: { headers: {} } };
assert.equal(handler(anonymous).statusCode, 401);

const authenticated = { request: { headers: { 'x-morning-token': { value: 'jwt' } } } };
assert.equal(handler(authenticated), authenticated.request);

console.log('✓ 匿名リクエストは401 / トークン付きリクエストはオリジンへ通過');
