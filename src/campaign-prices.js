import { createHash } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';

export const DINNER_PRICE_EXPERIMENT = Object.freeze({
  key: 'ya-dinner-promo-199-159-v1', campaign: 'ya-dinner-202610', promoCode: 'UZHIN159',
  basePriceRub: 199, promoPriceRub: 159, threeMonthsPriceRub: 499, threeMonthsPromoPriceRub: 399
});
db.exec(`CREATE TABLE IF NOT EXISTS campaign_price_assignments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  experiment_key TEXT NOT NULL, campaign TEXT NOT NULL,
  variant TEXT NOT NULL CHECK(variant IN ('A','B')),
  assigned_at TEXT NOT NULL, exposed_at TEXT,
  PRIMARY KEY(user_id,experiment_key)
);`);

export function campaignPriceAssignment(userId, at = new Date()) {
  const experiment = DINNER_PRICE_EXPERIMENT;
  const previous = db.prepare('SELECT * FROM campaign_price_assignments WHERE user_id=? AND experiment_key=?').get(userId, experiment.key);
  if (previous) return previous;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acquisition_starts'").get()) return null;
  const eligible = db.prepare(`SELECT 1 FROM acquisition_starts s JOIN users u ON u.id=s.user_id
    WHERE s.user_id=? AND s.campaign=? AND s.is_returning=0 AND u.telegram_id<>? AND u.telegram_id NOT LIKE 'private-test:%'`).get(userId, experiment.campaign, config.analyticsOwnerId);
  if (!eligible) return null;
  const variant = createHash('sha256').update(`${experiment.key}:${userId}`).digest()[0] < 128 ? 'A' : 'B';
  db.prepare('INSERT OR IGNORE INTO campaign_price_assignments(user_id,experiment_key,campaign,variant,assigned_at) VALUES(?,?,?,?,?)')
    .run(userId, experiment.key, experiment.campaign, variant, at.toISOString());
  return db.prepare('SELECT * FROM campaign_price_assignments WHERE user_id=? AND experiment_key=?').get(userId, experiment.key);
}

export function campaignPromoAvailable(userId) {
  const assignment = campaignPriceAssignment(userId);
  if (assignment?.variant !== 'B') return false;
  for (const [table, status] of [['payment_orders', 'paid'], ['mock_orders', 'success']]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      && db.prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND status=? LIMIT 1`).get(userId, status)) return false;
  }
  return true;
}

export function campaignPromotion(userId) {
  if (!campaignPromoAvailable(userId)) return null;
  const experiment = DINNER_PRICE_EXPERIMENT;
  return { code: experiment.promoCode, basePriceRub: experiment.basePriceRub, priceRub: experiment.promoPriceRub,
    discountRub: 40, periodMonths: 1, oneTime: true, autoRenew: false,
    plans: [{ months: 1, basePriceRub: 199, priceRub: 159, discountRub: 40 },
      { months: 3, basePriceRub: 499, priceRub: 399, discountRub: 100 }] };
}

export function recordCampaignPriceExposure(userId, at = new Date()) {
  const assignment = campaignPriceAssignment(userId, at);
  if (!assignment) return false;
  return db.prepare('UPDATE campaign_price_assignments SET exposed_at=? WHERE user_id=? AND experiment_key=? AND exposed_at IS NULL')
    .run(at.toISOString(), userId, DINNER_PRICE_EXPERIMENT.key).changes > 0;
}
