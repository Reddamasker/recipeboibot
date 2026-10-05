import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateMaxInitData, maxIdentity, verifyMaxWebhookSecret } from '../src/max-auth.js';

function signed(user, token = 'max-test-secret', fields = {}) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user), ...fields });
  const check = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
test('signed MAX identity cannot collide with a Telegram numeric ID', () => {
  const identity = validateMaxInitData(signed({ id: 123, first_name: 'Автор' }), 'max-test-secret');
  assert.equal(identity.id, 'max:123');
  assert.equal(identity.first_name, 'Автор');
});
test('MAX rejects tampered data, wrong transport key, duplicates and expired session', () => {
  const valid = signed({ id: 123 });
  for (const data of [valid.replace('123', '124'), valid + '&auth_date=1', signed({ id: 123 }, 'max-test-secret', { auth_date: '1' }), signed({ id: 123 }, 'telegram-test-secret')]) assert.throws(() => validateMaxInitData(data, 'max-test-secret'), { status: 401 });
});
test('MAX rejects malformed, bot, missing and unsafe user identities', () => {
  for (const user of [null, {}, { id: -5 }, { id: 'max:123' }, { id: Number.MAX_SAFE_INTEGER + 1 }, { id: 123, is_bot: true }]) assert.throws(() => validateMaxInitData(signed(user), 'max-test-secret'), { status: 401 });
  assert.throws(() => maxIdentity({ user_id: '0' }), { status: 401 });
});
test('MAX webhook secret requires exact constant-time comparable string', () => {
  const secret = 'a'.repeat(64);
  assert.equal(verifyMaxWebhookSecret(secret, secret), true);
  for (const value of [undefined, '', 'a'.repeat(63), 'b'.repeat(64), [secret]]) assert.equal(verifyMaxWebhookSecret(value, secret), false);
});
