import { db } from './db.js';
import { config } from './config.js';
import { advertisingRedirect, createCampaign, isAdvertisingProbe } from './funnel.js';

db.exec(`CREATE TABLE IF NOT EXISTS landing_html_loads (
  id INTEGER PRIMARY KEY, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS landing_visits (
  id TEXT PRIMARY KEY, campaign TEXT REFERENCES acquisition_campaigns(slug),
  tags_json TEXT NOT NULL, opened_at TEXT NOT NULL,
  telegram_clicked_at TEXT, click_token TEXT UNIQUE REFERENCES acquisition_clicks(token)
);
CREATE INDEX IF NOT EXISTS landing_visits_campaign ON landing_visits(campaign);`);
if (!db.prepare('PRAGMA table_info(landing_visits)').all().some(column => column.name === 'intent')) {
  db.exec("ALTER TABLE landing_visits ADD COLUMN intent TEXT NOT NULL DEFAULT 'save'");
}
db.prepare("INSERT OR IGNORE INTO acquisition_metadata(key,value) VALUES('landing_tracking_since',?)").run(new Date().toISOString());
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const tagsFrom = query => {
  const params = new URLSearchParams(query), tags = {};
  for (const [key, limit] of Object.entries({ campaign: 40, utm_source: 64, utm_medium: 64, utm_campaign: 160, utm_content: 160, utm_term: 256, campaign_id: 64, adgroup_id: 64, phrase_id: 64, device: 32, yclid: 128 })) {
    const value = String(params.get(key) || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
    if (value) tags[key] = value;
  }
  return tags;
};
function campaignFrom(tags) {
  const landing = tags.utm_campaign === 'ya_dinner_landing_search_202610' || (config.yandexDirectLandingCampaignId && tags.campaign_id === config.yandexDirectLandingCampaignId);
  const candidate = tags.campaign || (landing ? 'ya-dinner-landing-202610' : tags.campaign_id === config.yandexDirectCampaignId || tags.utm_campaign === 'ya_dinner_search_202610' ? config.yandexDirectPlacement : null);
  return candidate && db.prepare('SELECT slug FROM acquisition_campaigns WHERE slug=?').get(candidate)?.slug || null;
}
export function recordLandingHtmlLoad(options) {
  if (options.method !== 'GET' || isAdvertisingProbe(options)) return;
  db.prepare('INSERT INTO landing_html_loads(created_at) VALUES(?)').run(new Date().toISOString());
}
export function recordLandingView(input, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(input?.visitId || '') || typeof input.query !== 'string' || input.query.length > 4000) throw fail('Неверное событие лендинга');
  if (isAdvertisingProbe(options)) return { skipped: true };
  const tags = tagsFrom(input.query);
  const campaign = campaignFrom(tags);
  db.prepare('INSERT OR IGNORE INTO landing_visits(id,campaign,tags_json,opened_at,intent) VALUES(?,?,?,?,?)')
    .run(input.visitId, campaign, JSON.stringify(tags), new Date().toISOString(), campaign === 'ya-dinner-landing-202610' ? 'dinner' : 'save');
  return { href: `/landing/go/${input.visitId}` };
}
export function landingRedirect(id, options = {}) {
  const visit = db.prepare('SELECT * FROM landing_visits WHERE id=?').get(id);
  if (!visit) throw fail('Переход с лендинга не найден', 404);
  const username = config.testContour ? config.testBotUsername : 'Recipeboibot';
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) throw fail('Метод не поддерживается', 405);
  if (isAdvertisingProbe(options)) return `https://t.me/${username}?start=${visit.intent}`;
  if (visit.click_token) return `https://t.me/${username}?start=lp_${visit.click_token}`;
  db.exec('BEGIN IMMEDIATE');
  try {
    const slug = visit.campaign || 'site-landing';
    createCampaign(slug, visit.campaign || 'Лендинг — прямые посещения');
    const url = advertisingRedirect(slug, { ...options, searchParams: new URLSearchParams(JSON.parse(visit.tags_json)) });
    const token = new URL(url).searchParams.get('start').slice(3);
    db.prepare('UPDATE landing_visits SET click_token=?,telegram_clicked_at=? WHERE id=?').run(token, new Date().toISOString(), id);
    db.exec('COMMIT');
    return `https://t.me/${username}?start=lp_${token}`;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function landingStartIntent(text) {
  const token = String(text).match(/^\/start(?:@[A-Za-z0-9_]+)?\s+lp_([A-Za-z0-9_-]{24})\s*$/i)?.[1];
  return token && db.prepare('SELECT intent FROM landing_visits WHERE click_token=?').get(token)?.intent || null;
}
export function landingReport(slug = 'all') {
  const scope = slug === 'all' ? '' : slug === 'site-landing' ? 'WHERE v.campaign IS NULL' : 'WHERE v.campaign=?';
  const params = slug === 'all' || slug === 'site-landing' ? [] : [slug];
  const counts = db.prepare(`SELECT COUNT(*) AS views,COUNT(telegram_clicked_at) AS telegramClicks FROM landing_visits v ${scope}`).get(...params);
  const starts = db.prepare(`SELECT COUNT(DISTINCT s.user_id) AS n FROM landing_visits v
    JOIN acquisition_starts s ON s.click_token=v.click_token JOIN users u ON u.id=s.user_id
    WHERE s.is_returning=0 AND u.telegram_id<>? AND u.telegram_id NOT LIKE 'private-test:%'
    ${slug === 'all' ? '' : slug === 'site-landing' ? 'AND v.campaign IS NULL' : 'AND v.campaign=?'}`).get(config.analyticsOwnerId, ...params).n;
  return { trackingSince: db.prepare("SELECT value FROM acquisition_metadata WHERE key='landing_tracking_since'").get().value,
    totalViews: db.prepare('SELECT COUNT(*) AS n FROM landing_visits').get().n,
    taggedViews: db.prepare('SELECT COUNT(*) AS n FROM landing_visits WHERE campaign IS NOT NULL').get().n,
    htmlLoads: db.prepare('SELECT COUNT(*) AS n FROM landing_html_loads').get().n,
    views: counts.views, telegramClicks: counts.telegramClicks, starts };
}
