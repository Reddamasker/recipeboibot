import { db } from './db.js';
import { config } from './config.js';
import { parseMaxLandingPayload } from './max-landing-acquisition.js';
import { log } from './log.js';

// This is an observed entry-link association, not a chat start or proof that
// the person clicked an ad. Public deep links can be forwarded.
db.exec(`CREATE TABLE IF NOT EXISTS user_ad_attributions (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  campaign TEXT NOT NULL, click_token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),
  bound_at TEXT NOT NULL, entry_kind TEXT NOT NULL CHECK(entry_kind IN ('app_entry','chat_start'))
);
CREATE INDEX IF NOT EXISTS user_ad_attributions_token ON user_ad_attributions(click_token);
CREATE TABLE IF NOT EXISTS acquisition_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
db.prepare("INSERT OR IGNORE INTO acquisition_metadata(key,value) VALUES('user_ad_attribution_since',?)").run(new Date().toISOString());
const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const platformFor = user => String(user.telegram_id).startsWith('max:') ? 'max' : 'telegram';
const startFor = userId => exists('acquisition_starts') ? db.prepare('SELECT * FROM acquisition_starts WHERE user_id=?').get(userId) : null;
const legacy = (userId, platform) => {
  const row = startFor(userId);
  return row?.click_token && row.campaign ? { user_id: userId, campaign: row.campaign, click_token: row.click_token,
    platform, bound_at: row.started_at, entry_kind: 'chat_start' } : null;
};

export function attributionForUser(userId) {
  const row = db.prepare('SELECT * FROM user_ad_attributions WHERE user_id=?').get(userId);
  if (row) return row;
  const user = db.prepare('SELECT telegram_id FROM users WHERE id=?').get(userId);
  return user ? legacy(userId, platformFor(user)) : null;
}

function insert(user, entry, kind, at) {
  db.prepare(`INSERT OR IGNORE INTO user_ad_attributions(user_id,campaign,click_token,platform,bound_at,entry_kind)
    VALUES(?,?,?,?,?,?)`).run(user.id, entry.campaign, entry.token, platformFor(user), at, kind);
  return attributionForUser(user.id);
}

export function recordChatAdvertising(user) {
  try {
    const previous = legacy(user.id, platformFor(user));
    return previous ? insert(user, { campaign: previous.campaign, token: previous.click_token }, 'chat_start', previous.bound_at) : null;
  } catch { log('warn', 'user_ad_attribution_failed', { entry: 'chat_start' }); return null; }
}

// Caller must only supply start_param from initData whose platform signature
// has already been verified. Query strings and browser initDataUnsafe cannot
// establish a user association.
export function bindAppAdvertising(user, signedStartParam, at = new Date()) {
  try {
    if (!user?.id || typeof signedStartParam !== 'string' || signedStartParam.length > 128 || String(user.telegram_id).startsWith('private-test:')) return null;
    const prior = attributionForUser(user.id);
    if (prior) return prior;
    // A previously observed organic/chat acquisition is immutable as well.
    if (startFor(user.id)) return null;
    let entry;
    if (config.botPlatform === 'max') {
      entry = parseMaxLandingPayload(`/start ${signedStartParam}`);
      const click = entry && exists('acquisition_clicks') && db.prepare('SELECT campaign FROM acquisition_clicks WHERE token=?').get(entry.token);
      if (click && click.campaign !== entry.campaign) return null;
    }
    else {
      const match = signedStartParam.match(/^(ad|lp)_([A-Za-z0-9_-]{24})$/);
      if (!match || !exists('acquisition_clicks')) return null;
      if (match[1] === 'lp' && (!exists('landing_visits') || !db.prepare('SELECT 1 FROM landing_visits WHERE click_token=?').get(match[2]))) return null;
      const click = db.prepare('SELECT token,campaign FROM acquisition_clicks WHERE token=?').get(match[2]);
      if (click) entry = click;
    }
    if (!entry) return null;
    return insert(user, entry, 'app_entry', at.toISOString());
  } catch { log('warn', 'user_ad_attribution_failed', { entry: 'app_entry' }); return null; }
}
