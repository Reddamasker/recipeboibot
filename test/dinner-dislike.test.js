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
const { SEED_RECIPES, rankCandidates } = await import('../src/dinner.js');
const { productReport } = await import('../src/product-analytics.js');
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
  for (const [index, reason] of ['not_today', 'recently_ate', 'dislike', 'missing_ingredients'].entries()) {
    const user = fixture(), session = startDinner(user.id);
    const initial = await recommendDinner(user.id, session.sessionId);
    const beforeProfile = getFoodProfile(user.id), target = initial.recommendations[index % 3];
    // This also covers sessions created before display positions existed.
    db.prepare('UPDATE dinner_options SET display_position=NULL WHERE session_id=?').run(session.sessionId);
    const after = await replaceDinner(user.id, target.id, reason);
    assert.equal(after.recommendations.length, 3);
    assert.equal(new Set(after.recommendations.map(option => option.recipe.id)).size, 3);
    for (let slot = 0; slot < 3; slot++) {
      if (slot === index % 3) {
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
    const retried = await replaceDinner(user.id, target.id, reason);
    assert.deepEqual(retried.recommendations.map(option => option.id), after.recommendations.map(option => option.id));
    assert.equal(retried.rejectedCount, 1);
    assert.equal(retried.retryCount, 1);
    assert.equal(startDinner(user.id).sessionId, session.sessionId);
    const reopened = await recommendDinner(user.id, session.sessionId);
    assert.deepEqual(reopened.recommendations.map(option => option.id), after.recommendations.map(option => option.id));
    assert.deepEqual(prefetchDinner(user.id, session.sessionId).recommendations.map(option => option.id), after.recommendations.map(option => option.id));
    const nextContext = dinnerContext(user.id, openDinnerSession(user.id));
    assert.equal(nextContext.feedback.avoidTitles.includes(target.recipe.title), ['dislike', 'recently_ate'].includes(reason));
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
  await assert.rejects(() => replaceDinner(foreign.id, target.id, 'not_today'), { status: 404 });
  await assert.rejects(() => replaceDinner(inactive.id, target.id, 'not_today'), { status: 404 });
  await assert.rejects(() => replaceDinner(user.id, target.id, 'too_long'), { status: 400 });
  // A session with exactly three valid options cannot manufacture a replacement.
  for (const recipe of SEED_RECIPES) insertDinnerOption(user.id, session.sessionId, { id: randomUUID(), recipe, role: 'familiar', method: 'deterministic' }, recipe.title);
  db.prepare("UPDATE dinner_options SET state='discarded' WHERE session_id=? AND state='ready'").run(session.sessionId);
  db.prepare('UPDATE dinner_sessions SET buffer_retry_at=? WHERE id=?').run(Date.now() + 60000, session.sessionId);
  await assert.rejects(() => replaceDinner(user.id, target.id, 'not_today'), { status: 422 });
  assert.equal(getDinnerRecommendation(user.id, target.id).status, 'shown');
  assert.equal(getDinnerRejectionReason(user.id, target.id), null);
  assert.deepEqual(prefetchDinner(user.id, session.sessionId).recommendations.map(option => option.id), initial.recommendations.map(option => option.id));
  decideDinner(user.id, initial.recommendations[0].id, 'accepted');
  await assert.rejects(() => replaceDinner(user.id, target.id, 'dislike'), { status: 409 });
});

test('recently eaten hides matching titles for exactly seven days without changing tastes or renewing on retry', async t => {
  const at = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const user = fixture(), session = startDinner(user.id);
  const initial = await recommendDinner(user.id, session.sessionId);
  const target = initial.recommendations[1], profile = getFoodProfile(user.id);
  const signals = dinnerContext(user.id, session.sessionId).categorySignals;
  await replaceDinner(user.id, target.id, 'recently_ate');
  const timestamp = () => db.prepare("SELECT created_at FROM dinner_events WHERE user_id=? AND recommendation_id=? AND event='dinner_rejection_reason'").get(user.id, target.id).created_at;
  const firstTimestamp = timestamp();
  t.mock.timers.setTime(at + 3600000);
  await replaceDinner(user.id, target.id, 'recently_ate');
  assert.equal(timestamp(), firstTimestamp);
  assert.equal(productReport([user]).reasons.recently_ate, 1);
  const matchingCopy = { ...target.recipe, id: 'another-id-for-the-same-dish' };
  const context = () => dinnerContext(user.id, openDinnerSession(user.id));
  for (const elapsed of [3600000, 7 * 86400000 - 1]) {
    t.mock.timers.setTime(at + elapsed);
    const current = context();
    assert.ok(current.feedback.avoidTitles.includes(target.recipe.title));
    assert.equal(rankCandidates([matchingCopy], current).length, 0);
    assert.deepEqual(current.categorySignals, signals);
  }
  t.mock.timers.setTime(at + 7 * 86400000);
  const expired = context();
  assert.ok(!expired.feedback.avoidTitles.includes(target.recipe.title));
  assert.equal(rankCandidates([matchingCopy], expired).length, 1);
  assert.deepEqual(getFoodProfile(user.id), profile);
});

test('replacement HTTP route requires a reason and changes one authenticated card', async () => {
  const user = fixture(), session = startDinner(user.id);
  const initial = await recommendDinner(user.id, session.sessionId);
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/dinner/recommendations/${initial.recommendations[1].id}/replace`;
  const headers = { 'Content-Type': 'application/json', authorization: `tma ${makeTelegramInitData(user.telegram, process.env.TELEGRAM_BOT_TOKEN)}` };
  try {
    assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ reason: 'recently_ate' }) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.recommendations.length, 3);
    assert.equal(result.recommendations[0].id, initial.recommendations[0].id);
    assert.notEqual(result.recommendations[1].id, initial.recommendations[1].id);
    assert.equal(result.recommendations[2].id, initial.recommendations[2].id);
    const repeated = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ reason: 'recently_ate' }) });
    assert.equal(repeated.status, 200);
    assert.deepEqual((await repeated.json()).recommendations.map(option => option.id), result.recommendations.map(option => option.id));
    assert.equal(productReport([user]).reasons.recently_ate, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM dinner_events WHERE user_id=? AND event='dinner_rejection_reason'").get(user.id).n, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('choosing dinner is idempotent and a second card cannot become another accepted dinner', async () => {
  const user = fixture(), session = startDinner(user.id);
  const initial = await recommendDinner(user.id, session.sessionId);
  const selected = decideDinner(user.id, initial.recommendations[1].id, 'accepted');
  assert.equal(selected.status, 'accepted'); assert.ok(selected.savedRecipe.id);
  assert.equal(decideDinner(user.id, initial.recommendations[1].id, 'accepted').savedRecipe.id, selected.savedRecipe.id);
  assert.throws(() => decideDinner(user.id, initial.recommendations[0].id, 'accepted'), { status: 409 });
  assert.equal(getDinnerRecommendation(user.id, initial.recommendations[0].id).status, 'shown');
  assert.equal(getDinnerRecommendation(user.id, initial.recommendations[2].id).status, 'shown');
  assert.equal(db.prepare("SELECT id FROM dinner_recommendations WHERE user_id=? AND session_id=? AND status='accepted'").get(user.id, session.sessionId).id, initial.recommendations[1].id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM dinner_events WHERE user_id=? AND event='recommendation_accepted'").get(user.id).n, 1);
});
