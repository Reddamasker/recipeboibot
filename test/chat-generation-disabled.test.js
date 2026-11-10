// Historical compatibility only; deployed defaults are covered by retired-flows.test.js.
process.env.LEGACY_RECIPE_FLOWS_ENABLED = 'true';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('chat generation defaults off only in test; each platform supports an explicit override', () => {
  for (const [platform, contour, override, expected] of [
    ['telegram', 'true', '', false], ['telegram', 'false', '', true], ['max', 'false', '', true],
    ['max', 'false', 'false', false], ['telegram', 'true', 'true', true]
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import {config} from './src/config.js'; console.log(config.chatRecipeGenerationEnabled)"], {
      encoding: 'utf8', env: { ...process.env, BOT_PLATFORM: platform, TEST_CONTOUR: contour, CHAT_RECIPE_GENERATION_ENABLED: override }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), String(expected));
  }
});

for (const platform of ['telegram', 'max']) test(`${platform}: blocked chat requests never reach AI; collection and analytics survive`, () => {
  const result = spawnSync(process.execPath, ['scripts/check-chat-generation-policy.mjs'], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, BOT_PLATFORM: platform }
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /chat policy verified/);
});
