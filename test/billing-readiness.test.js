import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const requiredProviderEnv = {
  OPENAI_API_KEY: 'test-openai',
  OPENAI_TEXT_MODEL: 'test-model',
  OPENAI_TRANSCRIBE_MODEL: 'test-transcribe',
  TELEGRAM_BOT_TOKEN: '123456:test-token',
  TELEGRAM_POLLING: 'false',
  TEST_CONTOUR: 'false',
  BILLING_REQUIRED: 'true'
};

function runConfig(env = {}, source = "const { config, assertConfig } = await import('./src/config.js'); assertConfig(); console.log(JSON.stringify(config.paymentPriceVariants));") {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

test('legacy experiment defaults remain independent of the public subscription catalog', () => {
  const result = runConfig({ ...requiredProviderEnv, BILLING_REQUIRED: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [199]);
});

test('required billing refuses startup without complete provider credentials', () => {
  const result = runConfig(requiredProviderEnv);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BILLING_REQUIRED=true требует полной настройки Robokassa/);
});

test('required billing accepts a complete provider configuration', () => {
  const result = runConfig({
    ...requiredProviderEnv,
    ROBOKASSA_MERCHANT_LOGIN: 'merchant',
    ROBOKASSA_PASSWORD1: 'one',
    ROBOKASSA_PASSWORD2: 'two',
    PAYMENT_TAX: 'none',
    PAYMENT_PRICE_VARIANTS: '199',
    PAYMENT_EXPERIMENT_KEY: 'monthly-price-199-v1'
  });
  assert.equal(result.status, 0, result.stderr);
});

test('first automatic import is free, subsequent imports require active access', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'recipeboibot-billing-readiness-'));
  const database = path.join(directory, 'recipes.sqlite').replaceAll('\\', '/');
  const source = `
    const fs = await import('node:fs');
    const { db, upsertTelegramUser, createRecipe } = await import('./src/db.js');
    const { canUseAutomaticImport } = await import('./src/billing.js');
    const { grantSubscription } = await import('./src/subscriptions.js');
    const user = upsertTelegramUser({ id: 600000099, first_name: 'Readiness' });
    console.log(canUseAutomaticImport(user.id));
    createRecipe(user.id, { title: 'Первый рецепт', status: 'ready', ingredients: [{ name: 'мука' }], steps: [{ text: 'Приготовить.' }] });
    console.log(canUseAutomaticImport(user.id));
    grantSubscription(user.id, 'subscription', '2027-01-01T00:00:00.000Z', new Date('2026-09-29T00:00:00.000Z'));
    console.log(canUseAutomaticImport(user.id, new Date('2026-09-29T00:01:00.000Z')));
    db.close();
    fs.rmSync(${JSON.stringify(database)}, { force: true });
  `;
  const result = runConfig({
    ...requiredProviderEnv,
    DATABASE_PATH: database,
    ROBOKASSA_MERCHANT_LOGIN: 'merchant',
    ROBOKASSA_PASSWORD1: 'one',
    ROBOKASSA_PASSWORD2: 'two',
    PAYMENT_TAX: 'none',
    PAYMENT_PRICE_VARIANTS: '199'
  }, source);
  rmSync(directory, { force: true, recursive: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['true', 'false', 'true']);
});
