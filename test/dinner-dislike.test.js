import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
process.env.DATABASE_PATH = path.resolve('data', `dinner-dislike-${process.pid}.sqlite`);
process.env.TELEGRAM_BOT_TOKEN = 'local-dislike-test';
process.env.TELEGRAM_POLLING = 'false';
process.env.DINNER_LLM_ENABLED = 'false';
process.env.DINNER_IMAGES_ENABLED = 'false';
const { db, upsertTelegramUser, allowUser } = await import('../src/db.js');
const { startTrial } = await import('../src/subscriptions.js');
const { startDinner, recommendDinner, replaceDinner, dinnerContext, decideDinner, updateDinnerProfile, prefetchDinner } = await import('../src/dinner-service.js');
const { getFoodProfile, getDinnerRecommendation, getDinnerRejectionReason, openDinnerSession, insertDinnerOption } = await import('../src/dinner-store.js');
const { SEED_RECIPES } = await import('../src/dinner.js');
const { createServer } = await import('../src/server.js');
const { makeTelegramInitData } = await import('../src/security.js');
let userId = 950001;
function fixture(active = true) {
  const telegram = { id: userId++, first_name: 'Локальный тест' };
  const user = upsertTelegramUser(telegram); allowUser(user.id);
  if (active) startTrial(user.id);
  updateDinnerProfile(user.id, { tastePreferencesStatus: 'completed', onboardingCompleted: true, preferredMaxCookingTime: 60 });
  return { ...user, telegram };
}
test.after(() => { db.close(); for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + suffix); } catch {} } });

test('each dislike reason replaces only its card in place, survives reopening and is idempotent', async () => {
  for (const [index, reason] of ['not_today', 'dislike', 'missing_ingredients'].entries()) {
    const user = fixture(), session = startDinner(user.id);
    const initial = await recommendDinner(user.id, session.sessionId);
    const beforeProfile = getFoodProfile(user.id), target = initial.recommendations[index];
    // This also covers sessions created before display positions existed.
    db.prepare('UPDATE dinner_options SET display_position=NULL WHERE session_id=?').run(session.sessionId);
    const after = replaceDinner(user.id, target.id, reason);
    assert.equal(after.recommendations.length, 3);
    assert.equal(new Set(after.recommendations.map(option => option.recipe.id)).size, 3);
    for (let slot = 0; slot < 3; slot++) {
      if (slot === index) {
        assert.notEqual(after.recommendations[slot].id, target.id);
        assert.ok(initial.reserve.some(option => option.id === after.recommendations[slot].id));
      } else assert.deepEqual(after.recommendations[slot].recipe, initial.recommendations[slot].recipe);
    }
    assert.equal(getDinnerRecommendation(user.id, target.id).status, 'rejected');
    assert.equal(getDinnerRejectionReason(user.id, target.id).reason, reason);
    assert.deepEqual(getFoodProfile(user.id), beforeProfile);
    assert.deepEqual(after.pantry, initial.pantry);
    assert.equal(after.rejectedCount, 1);
    assert.equal(after.retryCount, 1);
    const retried = replaceDinner(user.id, target.id, reason);
    assert.deepEqual(retried.recommendations.map(option => option.id), after.recommendations.map(option => option.id));
    assert.equal(retried.rejectedCount, 1);
    assert.equal(retried.retryCount, 1);
    assert.equal(startDinner(user.id).sessionId, session.sessionId);
    const reopened = await recommendDinner(user.id, session.sessionId);
    assert.deepEqual(reopened.recommendations.map(option => option.id), after.recommendations.map(option => option.id));
    assert.deepEqual(prefetchDinner(user.id, session.sessionId).recommendations.map(option => option.id), after.recommendations.map(option => option.id));
    const nextContext = dinnerContext(user.id, openDinnerSession(user.id));
    assert.equal(nextContext.feedback.avoidTitles.includes(target.recipe.title), reason === 'dislike');
    if (reason === 'dislike') {
      db.prepare("UPDATE dinner_events SET created_at='2020-01-01T00:00:00.000Z' WHERE user_id=? AND event='dinner_rejection_reason'").run(user.id);
      assert.ok(dinnerContext(user.id, openDinnerSession(user.id)).feedback.avoidTitles.includes(target.recipe.title));
    }
  }
});

test('exhausted reserve, foreign cards, expired access and stale cards leave the selection intact', async () => {
  const user = fixture(), foreign = fixture(), inactive = fixture(false);
  const session = startDinner(user.id), initial = await recommendDinner(user.id, session.sessionId);
  const target = initial.recommendations[1];
  assert.throws(() => replaceDinner(foreign.id, target.id, 'not_today'), { status: 404 });
  assert.throws(() => replaceDinner(inactive.id, target.id, 'not_today'), { status: 402 });
  assert.throws(() => replaceDinner(user.id, target.id, 'too_long'), { status: 400 });
  // A session with exactly three valid options cannot manufacture a replacement.
  for (const recipe of SEED_RECIPES) insertDinnerOption(user.id, session.sessionId, { id: randomUUID(), recipe, role: 'familiar', method: 'deterministic' }, recipe.title);
  db.prepare("UPDATE dinner_options SET state='discarded' WHERE session_id=? AND state='ready'").run(session.sessionId);
  db.prepare('UPDATE dinner_sessions SET buffer_retry_at=? WHERE id=?').run(Date.now() + 60000, session.sessionId);
  assert.throws(() => replaceDinner(user.id, target.id, 'not_today'), { status: 422 });
  assert.equal(getDinnerRecommendation(user.id, target.id).status, 'shown');
  assert.equal(getDinnerRejectionReason(user.id, target.id), null);
  assert.deepEqual(prefetchDinner(user.id, session.sessionId).recommendations.map(option => option.id), initial.recommendations.map(option => option.id));
  decideDinner(user.id, initial.recommendations[0].id, 'accepted');
  assert.throws(() => replaceDinner(user.id, target.id, 'dislike'), { status: 409 });
});

test('replacement HTTP route requires a reason and changes one authenticated card', async () => {
  const user = fixture(), session = startDinner(user.id);
  const initial = await recommendDinner(user.id, session.sessionId);
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/dinner/recommendations/${initial.recommendations[1].id}/replace`;
  const headers = { 'Content-Type': 'application/json', authorization: `tma ${makeTelegramInitData(user.telegram, process.env.TELEGRAM_BOT_TOKEN)}` };
  try {
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ reason: 'missing_ingredients' }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.recommendations.length, 3);
    assert.equal(result.recommendations[0].id, initial.recommendations[0].id);
    assert.notEqual(result.recommendations[1].id, initial.recommendations[1].id);
    assert.equal(result.recommendations[2].id, initial.recommendations[2].id);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
