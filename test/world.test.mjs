/** Shape checks that need no Coopanion install: manifest-visible describe.json and the World API. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import definition from '../src/index.js';
import { DESCRIBE } from '../src/describe.js';

const describeFile = JSON.parse(readFileSync(new URL('../describe.json', import.meta.url), 'utf8'));
assert.deepEqual(describeFile, DESCRIBE, 'describe.json must match src/describe.js');
assert.equal(definition.id, 'mouse-polling-fix');
assert.equal(definition.label, 'Mouse Polling Fix');
assert.deepEqual(definition.defaults(), { enabled: false, pollMs: 5, autoApply: true });
assert.deepEqual(definition.describe, DESCRIBE);

const ctx = {
  id: definition.id,
  cfg: { ...definition.defaults(), enabled: false },
  timezone: 'Asia/Taipei',
  botName: 'test',
  botDir: process.cwd(),
  packageDir: process.cwd(),
  dataDir: process.cwd(),
  repoRoot: process.cwd(),
  secret: () => '',
  storeSecret() {},
  persist() {},
  restart: async () => {},
};

const world = definition.create(ctx);
assert.equal(world.id, 'mouse-polling-fix');
assert.equal(world.envPromptVars(), null);
const tools = world.tools();
assert.equal(tools.length, 3);
assert.deepEqual(tools.map((tool) => tool.name).sort(), ['mouse_fix_apply', 'mouse_fix_restore', 'mouse_fix_status']);
for (const tool of tools) {
  assert.equal(typeof tool.handler, 'function');
  assert.equal(tool.summary, undefined, 'summary is display-only and must not reach the model schema');
  assert.equal(tool.parameters.type, 'object');
}
await world.start({ log: { info() {}, warn() {}, debug() {} } });
assert.match(world.status(), /not running inside Coopanion|Mouse Polling Fix/);

console.log('world tests passed');

