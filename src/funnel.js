import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

db.exec(`CREATE TABLE IF NOT EXISTS acquisition_campaigns (
  slug TEXT PRIMARY KEY, name TEXT NOT NULL, impressions INTEGER, reach INTEGER,
  stats_updated_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS acquisition_clicks (
  token TEXT PRIMARY KEY, campaign TEXT NOT NULL REFERENCES acquisition_campaigns(slug),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS acquisition_clicks_campaign ON acquisition_clicks(campaign,created_at);
CREATE TABLE IF NOT EXISTS acquisition_starts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  campaign TEXT REFERENCES acquisition_campaigns(slug),
  click_token TEXT REFERENCES acquisition_clicks(token), started_at TEXT NOT NULL,
  is_returning INTEGER NOT NULL DEFAULT 0
);`);
db.exec('CREATE TABLE IF NOT EXISTS acquisition_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
db.prepare("INSERT OR IGNORE INTO acquisition_metadata(key,value) VALUES('tracking_since',?)").run(new Date().toISOString());

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const botUsername = () => config.testContour ? config.testBotUsername : 'Recipeboibot';
const slugPattern = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function campaignLink(slug) {
  return `${config.appUrl}/go/${slug}`;
}
export function createCampaign(slug, name = slug) {
  if (!slugPattern.test(slug || '') || slug === 'all') throw fail('Название ссылки: до 40 латинских букв, цифр, дефисов или подчёркиваний; all зарезервировано.');
  name = String(name || slug).trim();
  if (!name || name.length > 120) throw fail('Название размещения: от 1 до 120 символов.');
  db.prepare('INSERT OR IGNORE INTO acquisition_campaigns(slug,name,created_at) VALUES(?,?,?)').run(slug, name, new Date().toISOString());
  return db.prepare('SELECT * FROM acquisition_campaigns WHERE slug=?').get(slug);
}
function getCampaign(slug) {
  const campaign = db.prepare('SELECT * FROM acquisition_campaigns WHERE slug=?').get(slug);
  if (!campaign) throw fail('Рекламная ссылка не найдена. Создайте размещение в дашборде.', 404);
  return campaign;
}
export function setCampaignStats(slug, impressions, reach = null) {
  getCampaign(slug);
  if (!Number.isSafeInteger(impressions) || impressions < 0 || (reach !== null && (!Number.isSafeInteger(reach) || reach < 0 || reach > impressions))) throw fail('Укажите общее число показов и, если известно, охват. Охват не больше показов.');
  db.prepare('UPDATE acquisition_campaigns SET impressions=?,reach=?,stats_updated_at=? WHERE slug=?')
    .run(impressions, reach, new Date().toISOString(), slug);
}

// No IP addresses, user agents or cookies are persisted. A click is a request,
// not an identified person or proof that Telegram successfully opened.
export function advertisingRedirect(slug, { method = 'GET', userAgent = '', purpose = '' } = {}) {
  getCampaign(slug);
  if (!['GET', 'HEAD'].includes(method)) throw fail('Метод не поддерживается', 405);
  if (method === 'HEAD' || /bot\b|crawler|spider|preview|facebookexternalhit|slackbot|discordbot/i.test(userAgent) || /prefetch|preview/i.test(purpose)) return `https://t.me/${botUsername()}?start=dinner`;
  const token = randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO acquisition_clicks(token,campaign,created_at) VALUES(?,?,?)').run(token, slug, new Date().toISOString());
  return `https://t.me/${botUsername()}?start=ad_${token}`;
}

export function recordBotStart(user, text, at = new Date()) {
  const match = String(text).match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+([A-Za-z0-9_-]{1,64}))?\s*$/i);
  if (!match) return;
  const click = match[1]?.startsWith('ad_') ? db.prepare('SELECT * FROM acquisition_clicks WHERE token=?').get(match[1].slice(3)) : null;
  // First start attribution is immutable; existing accounts are is_returning visits.
  db.prepare('INSERT OR IGNORE INTO acquisition_starts(user_id,campaign,click_token,started_at,is_returning) VALUES(?,?,?,?,?)')
    .run(user.id, click?.campaign || null, click?.token || null, at.toISOString(), user.is_allowed ? 1 : 0);
}

function recipeSources() {
  const sources = ["SELECT user_id,created_at AS at FROM recipes WHERE status IN ('ready','archived')"];
  if (exists('recipe_suggestions')) sources.push('SELECT user_id,created_at AS at FROM recipe_suggestions');
  if (exists('first_recipe_results')) {
    const completedTime = db.prepare('PRAGMA table_info(first_recipe_results)').all().some(c => c.name === 'completed_at') ? 'COALESCE(completed_at,started_at)' : 'started_at';
    sources.push(`SELECT user_id,${completedTime} AS at FROM first_recipe_results WHERE result_json IS NOT NULL`);
  }
  if (exists('dinner_events')) sources.push("SELECT user_id,created_at AS at FROM dinner_events WHERE event='recommendation_shown'");
  return sources.join(' UNION ALL ');
}
const percentage = (count, base) => base ? Number((100 * count / base).toFixed(1)) : null;

export function funnelReport(slug = 'all') {
  const campaign = slug === 'all' ? null : getCampaign(slug);
  const cohort = campaign
    ? db.prepare(`SELECT u.id,s.started_at FROM acquisition_starts s JOIN users u ON u.id=s.user_id
        WHERE s.campaign=? AND s.is_returning=0 AND u.telegram_id<>? AND u.telegram_id NOT LIKE 'private-test:%'`).all(slug, config.analyticsOwnerId)
    : db.prepare(`SELECT u.id,CASE WHEN s.is_returning=0 THEN s.started_at END AS started_at FROM users u LEFT JOIN acquisition_starts s ON s.user_id=u.id
        WHERE (u.is_allowed=1 OR s.user_id IS NOT NULL) AND u.telegram_id<>? AND u.telegram_id NOT LIKE 'private-test:%'`).all(config.analyticsOwnerId);
  const recipeTimes = new Map(db.prepare(`SELECT user_id,MIN(at) AS at FROM (${recipeSources()}) GROUP BY user_id`).all().map(r => [r.user_id, r.at]));
  const trialTimes = new Map((exists('user_trials') ? db.prepare('SELECT user_id,starts_at AS at FROM user_trials').all() : []).map(r => [r.user_id, r.at]));
  const classifiedPayments = exists('payment_orders') && db.prepare('PRAGMA table_info(payment_orders)').all().some(c => c.name === 'is_test');
  const paidTimes = new Map((classifiedPayments ? db.prepare("SELECT user_id,MIN(paid_at) AS at FROM payment_orders WHERE status='paid' AND is_test=0 GROUP BY user_id").all() : []).map(r => [r.user_id, r.at]));
  const excludedPayments = exists('payment_orders') ? db.prepare(classifiedPayments
    ? `SELECT user_id,is_test FROM payment_orders WHERE status='paid' AND (is_test=1 OR is_test IS NULL) GROUP BY user_id,is_test`
    : `SELECT DISTINCT user_id,NULL AS is_test FROM payment_orders WHERE status='paid'`).all() : [];
  const ids = new Set(cohort.map(u => u.id));
  const totals = { starts: cohort.length, firstRecipe: 0, trial: 0, paid: 0 };
  const ordered = { starts: cohort.length, firstRecipe: 0, trial: 0, paid: 0 };
  for (const user of cohort) {
    const recipe = recipeTimes.get(user.id), trial = trialTimes.get(user.id), paid = paidTimes.get(user.id);
    const afterStart = time => Boolean(time && (!campaign || time >= user.started_at));
    if (afterStart(recipe)) totals.firstRecipe++;
    if (afterStart(trial)) totals.trial++;
    if (afterStart(paid)) totals.paid++;
    if (afterStart(recipe)) {
      ordered.firstRecipe++;
      if (afterStart(trial) && trial >= recipe) {
        ordered.trial++;
        if (afterStart(paid) && paid >= trial) ordered.paid++;
      }
    }
  }
  const clicks = db.prepare(`SELECT COUNT(*) AS count FROM acquisition_clicks ${campaign ? 'WHERE campaign=?' : ''}`).get(...(campaign ? [slug] : [])).count;
  const convertedClicks = campaign ? db.prepare(`SELECT COUNT(DISTINCT s.click_token) AS count FROM acquisition_starts s JOIN users u ON u.id=s.user_id WHERE s.campaign=? AND s.is_returning=0 AND u.telegram_id<>? AND u.telegram_id NOT LIKE 'private-test:%'`).get(slug, config.analyticsOwnerId).count : null;
  const campaigns = db.prepare('SELECT slug,name,impressions,reach FROM acquisition_campaigns ORDER BY created_at').all();
  // Summing reach across placements would count overlapping people repeatedly.
  const impressions = campaign ? campaign.impressions : campaigns.length && campaigns.every(c => c.impressions !== null) ? campaigns.reduce((sum, c) => sum + c.impressions, 0) : null;
  return {
    generatedAt: new Date().toISOString(), trackingSince: db.prepare("SELECT value FROM acquisition_metadata WHERE key='tracking_since'").get().value,
    contour: config.testContour ? 'test' : 'main', preview: config.dashboardPreview, campaign: campaign || null, campaigns,
    impressions, reach: campaign?.reach ?? null, clicks, totals, ordered,
    convertedClicks,
    conversions: { clickFromImpression: percentage(clicks, impressions), startFromClick: campaign ? percentage(convertedClicks, clicks) : null,
      firstRecipeFromStart: percentage(ordered.firstRecipe, ordered.starts), trialAfterRecipe: percentage(ordered.trial, ordered.firstRecipe), paidAfterTrial: percentage(ordered.paid, ordered.trial) },
    returningStarts: campaign ? db.prepare(`SELECT COUNT(*) AS count FROM acquisition_starts s JOIN users u ON u.id=s.user_id WHERE s.campaign=? AND s.is_returning=1 AND u.telegram_id<>? AND u.telegram_id NOT LIKE 'private-test:%'`).get(slug, config.analyticsOwnerId).count : null,
    historicalStartsWithoutDate: cohort.filter(u => !u.started_at).length,
    testPaidUsers: excludedPayments.filter(p => p.is_test === 1 && ids.has(p.user_id)).length,
    unclassifiedPaidUsers: excludedPayments.filter(p => p.is_test === null && ids.has(p.user_id)).length
  };
}
