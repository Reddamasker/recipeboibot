import { createHash, randomUUID } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { analyticsExcludedIds, analyticsUserCondition } from './analytics-exclusions.js';

db.exec(`CREATE TABLE IF NOT EXISTS tagged_bot_starts (
  event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign TEXT NOT NULL, click_token TEXT, started_at TEXT NOT NULL,
  is_returning INTEGER NOT NULL CHECK(is_returning IN (0,1))
);
CREATE INDEX IF NOT EXISTS tagged_bot_starts_token ON tagged_bot_starts(click_token,started_at);
CREATE TABLE IF NOT EXISTS tagged_start_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
db.prepare("INSERT OR IGNORE INTO tagged_start_metadata VALUES('since',?)").run(new Date().toISOString());
export const taggedStartsSince = () => db.prepare("SELECT value FROM tagged_start_metadata WHERE key='since'").get().value;

// Delivery identity is hashed, never the message or the whole start payload.
// Called in the same savepoint as first-touch attribution, before it is inserted.
export function recordTaggedStart(user, campaign, token, at, deliveryId) {
  if (!campaign) return;
  const eventId = createHash('sha256').update(JSON.stringify([config.botPlatform,user.id,deliveryId ?? randomUUID()])).digest('hex');
  const returning = Boolean(user.is_allowed || db.prepare('SELECT 1 FROM acquisition_starts WHERE user_id=?').get(user.id));
  db.prepare('INSERT OR IGNORE INTO tagged_bot_starts VALUES(?,?,?,?,?,?)')
    .run(eventId,user.id,campaign,token || null,at.toISOString(),Number(returning));
}

export function taggedStartSnapshot(tokens) {
  if (!Array.isArray(tokens) || tokens.length > 500 || new Set(tokens).size !== tokens.length || tokens.some(t => typeof t !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(t))) {
    throw Object.assign(new Error('Неверные метки переходов'),{status:400});
  }
  const query = db.prepare(`SELECT campaign,
    MAX(CASE WHEN internal=0 AND is_returning=0 THEN started_at END) AS newAt,
    MAX(CASE WHEN internal=0 AND is_returning=1 THEN started_at END) AS returningAt,
    MAX(CASE WHEN internal=1 THEN started_at END) AS internalAt,
    SUM(CASE WHEN internal=0 THEN is_event ELSE 0 END) AS launches FROM (
      SELECT s.campaign,s.started_at,s.is_returning,1 AS is_event,CASE WHEN ${analyticsUserCondition} THEN 0 ELSE 1 END AS internal
        FROM tagged_bot_starts s JOIN users u ON u.id=s.user_id WHERE s.click_token=?
      UNION ALL
      SELECT s.campaign,s.started_at,s.is_returning,0 AS is_event,CASE WHEN ${analyticsUserCondition} THEN 0 ELSE 1 END AS internal
        FROM acquisition_starts s JOIN users u ON u.id=s.user_id WHERE s.click_token=?
    ) GROUP BY campaign`);
  return {version:1,platform:config.botPlatform,trackingSince:taggedStartsSince(),rows:tokens.map(token => {
    // History proves a first start only. It never increases the new event counter.
    const facts=query.all(...analyticsExcludedIds,token,...analyticsExcludedIds,token);
    if(facts.length>1)throw Error('Ambiguous start token');
    return {token,...(facts[0] || {campaign:null,newAt:null,returningAt:null,internalAt:null,launches:0})};
  })};
}
