import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS recipe_engagement (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL, event TEXT NOT NULL, recipe_key TEXT,
 saved_at TEXT, created_at TEXT NOT NULL, PRIMARY KEY(user_id,event_id));
 CREATE INDEX IF NOT EXISTS recipe_engagement_user_time ON recipe_engagement(user_id,created_at);
 CREATE TABLE IF NOT EXISTS recipe_engagement_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
db.prepare("INSERT OR IGNORE INTO recipe_engagement_metadata VALUES('tracking_since',?)").run(new Date().toISOString());
export const engagementSince = () => db.prepare("SELECT value FROM recipe_engagement_metadata WHERE key='tracking_since'").get().value;
export const moscowDay = at => new Date(Date.parse(at) + 3 * 3600000).toISOString().slice(0, 10);
db.prepare("INSERT OR IGNORE INTO recipe_engagement_metadata VALUES('receipt_key',?)").run(randomBytes(32).toString('hex'));
const secret = Buffer.from(db.prepare("SELECT value FROM recipe_engagement_metadata WHERE key='receipt_key'").get().value, 'hex');
const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
export function recipeKey(recipe) {
  // Independent of storage ID, image, nutrition and suggestion-to-collection copying.
  const text = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(JSON.stringify([text(recipe.title),
    recipe.ingredients.map(i => [text(i.name || i.raw || i), i.quantity ?? null, text(i.unit)]),
    recipe.steps.map(s => text(s.text || s))])).digest('hex');
}
export function recordEngagement(userId, event, { eventId = randomBytes(18).toString('base64url'), key = null, savedAt = null, at = new Date().toISOString() } = {}) {
  return Boolean(db.prepare('INSERT OR IGNORE INTO recipe_engagement(user_id,event_id,event,recipe_key,saved_at,created_at) VALUES(?,?,?,?,?,?)')
    .run(userId, eventId, event, key, savedAt, at).changes);
}
function receipt(userId, event, key = null, savedAt = null) {
  const value = Buffer.from(JSON.stringify({ userId, event, key, savedAt, expires: Date.now() + 86400000 })).toString('base64url');
  return value + '.' + sign(value);
}
// Issuing a receipt is not a view. Only a visible client acknowledgement counts.
export function withEngagementReceipts(userId, value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => withEngagementReceipts(userId, item));
  const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withEngagementReceipts(userId, v)]));
  if (value.ingredients?.length && value.steps?.length) {
    const saved = value.id && db.prepare("SELECT updated_at,created_at FROM recipes WHERE user_id=? AND id=? AND status IN ('ready','archived')").get(userId, value.id);
    result.recipeViewToken = receipt(userId, 'recipe_opened', recipeKey(value), saved?.updated_at || saved?.created_at || null);
  }
  if (value.trial?.eligible && !value.active) result.trialViewToken = receipt(userId, 'trial_offer_viewed');
  return result;
}
export function acknowledgeEngagement(userId, input) {
  if (typeof input.token !== 'string' || input.token.length > 1500 || !/^[\w-]{16,80}$/.test(input.eventId || '')) throw Object.assign(new Error('Invalid event'), { status: 400 });
  const [value, signature, extra] = input.token.split('.');
  const expected = sign(value);
  if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw Object.assign(new Error('Invalid receipt'), { status: 400 });
  const data = JSON.parse(Buffer.from(value, 'base64url').toString());
  if (data.userId !== userId || data.expires < Date.now()) throw Object.assign(new Error('Expired receipt'), { status: 400 });
  return recordEngagement(userId, data.event, { eventId: input.eventId, key: data.key, savedAt: data.savedAt });
}
export const trialCounters = ['offered', 'clicked', 'activated', 'opened', 'clickUsers', 'activationUsers', 'paidWithoutTrialUsers'];
export const emptyTrialJourney = () => Object.fromEntries(trialCounters.map(k => [k, 0]));
export function trialJourneyReport(cohort, campaign = false) {
  const result = emptyTrialJourney();
  const hasPayments = db.prepare('PRAGMA table_info(payment_orders)').all().some(c => c.name === 'is_test');
  const hasTrials = db.prepare('PRAGMA table_info(user_trials)').all().length > 0;
  const payments = hasPayments && hasTrials ? db.prepare(`SELECT p.user_id,p.paid_at FROM payment_orders p WHERE p.status='paid' AND p.is_test=0
    AND NOT EXISTS(SELECT 1 FROM user_trials t WHERE t.user_id=p.user_id AND t.starts_at<=p.paid_at)`).all() : [];
  const events = new Map();
  for (const row of db.prepare('SELECT * FROM recipe_engagement ORDER BY created_at,rowid').all()) {
    if (!events.has(row.user_id)) events.set(row.user_id, []);
    events.get(row.user_id).push(row);
  }
  for (const user of cohort) {
    const rows = (events.get(user.id) || []).filter(r => !campaign || r.created_at >= user.started_at);
    const offer = rows.findIndex(r => r.event === 'trial_offer_viewed');
    const click = rows.findIndex((r, i) => i > offer && offer >= 0 && r.event === 'trial_clicked');
    const activation = rows.findIndex((r, i) => i > click && click >= 0 && r.event === 'trial_activated');
    const opened = rows.findIndex((r, i) => i > activation && activation >= 0 && r.event === 'recipe_opened');
    if (offer >= 0) result.offered++;
    if (click >= 0) result.clicked++;
    if (activation >= 0) result.activated++;
    if (opened >= 0) result.opened++;
    if (rows.some(r => r.event === 'trial_clicked')) result.clickUsers++;
    if (rows.some(r => r.event === 'trial_activated')) result.activationUsers++;
    if (payments.some(p => p.user_id === user.id && (!campaign || p.paid_at >= user.started_at))) result.paidWithoutTrialUsers++;
  }
  return { ...result, trackingSince: engagementSince() };
}
