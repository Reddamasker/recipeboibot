import { createHash, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from './db.js';
import { config } from './config.js';
import { getSubscriptionAccess, getTrialStatus, getFirstRecipeStatus, hasUsedTrialOrPromo, monthsAfter } from './subscriptions.js';
import { promoQuote, reservedPromoOrder, reservePromo, consumePromo } from './promos.js';
import { publicSubscriptionPlans, subscriptionPeriodLabel, subscriptionPlan } from './plans.js';
import { log } from './log.js';
import { campaignPriceAssignment, campaignPromotion } from './campaign-prices.js';

const error = (message, status = 400) => Object.assign(new Error(message), { status });
const PAYMENT_ACTION = 'https://auth.robokassa.ru/Merchant/Index.aspx';
const RECURRING_ACTION = 'https://auth.robokassa.ru/Merchant/Recurring';
const ROBOKASSA_JWS_CERTIFICATE = readFileSync(new URL('./robokassa-jwtsign.cer', import.meta.url));

db.exec(`CREATE TABLE IF NOT EXISTS payment_experiment_assignments (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  experiment_key TEXT NOT NULL,
  variant TEXT NOT NULL,
  amount_kopeks INTEGER NOT NULL CHECK(amount_kopeks > 0),
  assigned_at TEXT NOT NULL,
  exposed_at TEXT,
  PRIMARY KEY(user_id,experiment_key)
);
CREATE TABLE IF NOT EXISTS payment_orders (
  inv_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  experiment_key TEXT NOT NULL,
  variant TEXT NOT NULL,
  amount_kopeks INTEGER NOT NULL CHECK(amount_kopeks > 0),
  currency TEXT NOT NULL DEFAULT 'RUB',
  kind TEXT NOT NULL CHECK(kind IN ('initial','recurring')),
  parent_inv_id INTEGER,
  auto_renew INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','failed','cancelled','refunded')),
  provider_op_key TEXT,
  provider_method TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS payment_orders_user_created ON payment_orders(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS payment_orders_status_created ON payment_orders(status,created_at);
CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  inv_id INTEGER NOT NULL REFERENCES payment_orders(inv_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  signature_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(inv_id,kind,signature_hash)
);
CREATE TABLE IF NOT EXISTS payment_recurring (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  parent_inv_id INTEGER NOT NULL REFERENCES payment_orders(inv_id),
  amount_kopeks INTEGER NOT NULL CHECK(amount_kopeks > 0),
  next_charge_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL
);`);

if (!db.prepare('PRAGMA table_info(payment_orders)').all().some(column => column.name === 'promo_code')) db.exec('ALTER TABLE payment_orders ADD COLUMN promo_code TEXT');
if (!db.prepare('PRAGMA table_info(payment_orders)').all().some(column => column.name === 'period_months')) db.exec('ALTER TABLE payment_orders ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1');
// NULL keeps historical orders explicitly unclassified; current settings cannot
// prove which mode was used for a payment created before this migration.
if (!db.prepare('PRAGMA table_info(payment_orders)').all().some(column => column.name === 'is_test')) db.exec('ALTER TABLE payment_orders ADD COLUMN is_test INTEGER CHECK(is_test IN (0,1))');
if (!db.prepare('PRAGMA table_info(payment_recurring)').all().some(column => column.name === 'period_months')) db.exec('ALTER TABLE payment_recurring ADD COLUMN period_months INTEGER NOT NULL DEFAULT 1');

const nowIso = (at = new Date()) => at.toISOString();
const formatAmount = (kopeks) => `${Math.floor(kopeks / 100)}.${String(kopeks % 100).padStart(2, '0')}`;
const parseAmount = (value) => {
  const match = String(value || '').match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0').slice(0, 2));
};
const hash = (value, password = '') => createHash(config.robokassaHash).update(`${value}${password}`).digest('hex');
const secureEqual = (left, right) => {
  const a = Buffer.from(String(left || '').toLowerCase());
  const b = Buffer.from(String(right || '').toLowerCase());
  return a.length === b.length && timingSafeEqual(a, b);
};
const html = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function hasFirstValue(userId) {
  if (db.prepare("SELECT 1 FROM recipes WHERE user_id=? AND status='ready' LIMIT 1").get(userId)) return 'saved';
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dinner_events'").get()
      && db.prepare("SELECT 1 FROM dinner_events WHERE user_id=? AND event='recipe_cooked' LIMIT 1").get(userId)) return 'cooked';
  return getFirstRecipeStatus(userId).delivered ? 'received' : null;
}

function assignmentFor(userId, at = new Date()) {
  let assignment = db.prepare('SELECT * FROM payment_experiment_assignments WHERE user_id=? AND experiment_key=?').get(userId, config.paymentExperimentKey);
  if (assignment) return assignment;
  const digest = createHash('sha256').update(`${config.paymentExperimentKey}:${userId}`).digest();
  const amountRub = config.paymentPriceVariants[digest.readUInt32BE(0) % config.paymentPriceVariants.length];
  const variant = `price_${amountRub}`;
  db.prepare('INSERT INTO payment_experiment_assignments(user_id,experiment_key,variant,amount_kopeks,assigned_at) VALUES(?,?,?,?,?)')
    .run(userId, config.paymentExperimentKey, variant, amountRub * 100, nowIso(at));
  return db.prepare('SELECT * FROM payment_experiment_assignments WHERE user_id=? AND experiment_key=?').get(userId, config.paymentExperimentKey);
}

function recurringFor(userId) {
  const row = db.prepare('SELECT * FROM payment_recurring WHERE user_id=?').get(userId);
  return row ? { enabled: Boolean(row.enabled), nextChargeAt: row.next_charge_at, cancelledAt: row.cancelled_at } : { enabled: false, nextChargeAt: null, cancelledAt: null };
}

export function billingAvailable() {
  return config.robokassaConfigured;
}

export function canUseAutomaticImport(userId, at = new Date()) {
  return getSubscriptionAccess(userId, at).active || (!hasUsedTrialOrPromo(userId, at) && getFirstRecipeStatus(userId).available);
}

export function getBillingOffer(userId, at = new Date()) {
  const firstValue = hasFirstValue(userId);
  const access = getSubscriptionAccess(userId, at);
  const trial = getTrialStatus(userId, at);
  const assignment = firstValue || hasUsedTrialOrPromo(userId, at) ? assignmentFor(userId, at) : null;
  const pending = db.prepare("SELECT id,inv_id,amount_kopeks,variant,auto_renew,created_at,promo_code,period_months FROM payment_orders WHERE user_id=? AND status='pending' AND kind='initial' ORDER BY created_at DESC LIMIT 1").get(userId);
  return {
    mode: config.robokassaConfigured ? 'provider' : 'unavailable',
    available: config.robokassaConfigured,
    active: access.active,
    accessSource: access.source,
    firstRecipe: getFirstRecipeStatus(userId),
    trial: { ...trial, eligible: !trial.used && !access.active },
    expiresAt: access.expiresAt,
    hasFirstRecipe: Boolean(firstValue),
    firstValue,
    offerShown: Boolean(assignment?.exposed_at),
    recurringSupported: config.robokassaConfigured && config.robokassaRecurring,
    recurring: recurringFor(userId),
    offer: assignment ? { variant: 'period_1_price_199', priceRub: 199, currency: 'RUB', period: 'month', periodMonths: 1 } : null,
    plans: assignment ? publicSubscriptionPlans() : [],
    campaignPromotion: assignment ? campaignPromotion(userId) : null,
    pendingOrder: pending ? publicOrder(pending) : null
  };
}

export function recordBillingExposure(userId, at = new Date()) {
  if (!hasFirstValue(userId)) return false;
  assignmentFor(userId, at);
  return db.prepare('UPDATE payment_experiment_assignments SET exposed_at=? WHERE user_id=? AND experiment_key=? AND exposed_at IS NULL')
    .run(nowIso(at), userId, config.paymentExperimentKey).changes > 0;
}

function publicOrder(row) {
  return {
    id: row.id,
    invId: row.inv_id,
    priceRub: row.amount_kopeks / 100,
    promoCode: row.promo_code || null,
    variant: row.variant,
    status: row.status || 'pending',
    autoRenew: Boolean(row.auto_renew),
    createdAt: row.created_at,
    paidAt: row.paid_at || null,
    periodMonths: Number(row.period_months || 1)
  };
}

export function createPaymentOrder(userId, { autoRenew = false, promoCode, periodMonths = 1 } = {}, at = new Date()) {
  const plan = subscriptionPlan(periodMonths);
  if (!plan) throw error('Выберите срок подписки: 1 месяц, 3 месяца или 1 год');
  const promo = promoCode !== undefined ? promoQuote(userId, promoCode, plan.months) : null;
  if (promo?.discountPercent === 100) throw error('Активируйте бесплатный доступ без оплаты');
  if (promo && autoRenew) throw error('Оплата по промокоду не подключает автопродление');
  if (!config.robokassaConfigured) throw error('Оплата пока не настроена', 503);
  if (!promo && !hasFirstValue(userId) && !getTrialStatus(userId, at).used) throw error('Сначала начните бесплатный пробный период', 409);
  if (autoRenew && !config.robokassaRecurring) throw error('Автопродление пока не подключено у платёжного провайдера', 409);
  const assignment = assignmentFor(userId, at);
  const campaignAssignment = campaignPriceAssignment(userId, at);
  recordBillingExposure(userId, at);
  const recentAfter = new Date(at.getTime() - 30 * 60 * 1000).toISOString();
  const reserved = promo && reservedPromoOrder(userId, promo.code);
  const existing = reserved ? db.prepare("SELECT * FROM payment_orders WHERE id=? AND user_id=? AND status='pending'").get(reserved, userId)
    : !promo && db.prepare("SELECT * FROM payment_orders WHERE user_id=? AND kind='initial' AND status='pending' AND promo_code IS NULL AND auto_renew=? AND period_months=? AND created_at>? ORDER BY created_at DESC LIMIT 1").get(userId, autoRenew ? 1 : 0, plan.months, recentAfter);
  if (existing) {
    if (promo && (existing.period_months !== plan.months || existing.amount_kopeks !== Math.round(promo.priceRub * 100))) {
      throw error('С этим промокодом уже создан заказ на другой срок. Завершите его оплату перед созданием нового заказа.', 409);
    }
    db.prepare('UPDATE payment_orders SET updated_at=? WHERE id=?').run(nowIso(at), existing.id);
    return { ...publicOrder(existing), paymentUrl: `${config.appUrl}/payment/start/${existing.id}` };
  }
  if (reserved) throw error('Заказ с этим промокодом уже завершён', 409);
  const id = randomUUID();
  const timestamp = nowIso(at);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO payment_orders(id,user_id,experiment_key,variant,amount_kopeks,kind,auto_renew,status,created_at,updated_at,promo_code,period_months,is_test)
      VALUES(?,?,?,?,?,'initial',?,'pending',?,?,?,?,?)`)
      .run(id, userId, campaignAssignment?.experiment_key || config.paymentExperimentKey, promo ? promo.discountPercent === 99 ? 'promo_99' : `promo_${promo.code}` : `period_${plan.months}_price_${plan.priceRub}`, Math.round((promo ? promo.priceRub : plan.priceRub) * 100), autoRenew ? 1 : 0, timestamp, timestamp, promo?.code || null, plan.months, config.robokassaTest || config.testContour ? 1 : 0);
    if (promo) reservePromo(userId, promo.code, id);
    db.exec('COMMIT');
  } catch (cause) { db.exec('ROLLBACK'); throw cause; }
  const order = db.prepare('SELECT * FROM payment_orders WHERE id=?').get(id);
  return { ...publicOrder(order), paymentUrl: `${config.appUrl}/payment/start/${id}` };
}

export function getPaymentOrder(userId, id) {
  const row = db.prepare('SELECT * FROM payment_orders WHERE id=? AND user_id=?').get(id, userId);
  if (!row) throw error('Заказ не найден', 404);
  return publicOrder(row);
}

function receiptFor(order) {
  const period = subscriptionPeriodLabel(order.period_months || 1);
  const item = {
    name: `Доступ к сервису «Твои рецепты» на ${period}`,
    quantity: 1,
    sum: order.amount_kopeks / 100,
    payment_method: config.paymentMethod,
    payment_object: 'service',
    tax: config.paymentTax
  };
  return encodeURIComponent(JSON.stringify({ ...(config.paymentSno ? { sno: config.paymentSno } : {}), items: [item] }));
}

function signatureForOrder(order, { recurringChild = false } = {}) {
  const outSum = formatAmount(order.amount_kopeks);
  const receipt = receiptFor(order);
  const resultUrl = `${config.appUrl}/api/payments/robokassa/result`;
  const contour = config.testContour ? 'test' : 'production';
  if (recurringChild) return hash(`${config.robokassaMerchantLogin}:${outSum}:${order.inv_id}:${receipt}:${resultUrl}:${config.robokassaPassword1}:Shp_contour=${contour}`);
  const successUrl = `${config.appUrl}/payment/success?order=${encodeURIComponent(order.id)}`;
  const failUrl = `${config.appUrl}/payment/fail?order=${encodeURIComponent(order.id)}`;
  const base = `${config.robokassaMerchantLogin}:${outSum}:${order.inv_id}:${receipt}:${resultUrl}:${successUrl}:GET:${failUrl}:GET:`;
  return hash(`${base}${config.robokassaPassword1}:Shp_contour=${contour}`);
}

function paymentFields(order) {
  const period = subscriptionPeriodLabel(order.period_months || 1);
  const successUrl = `${config.appUrl}/payment/success?order=${encodeURIComponent(order.id)}`;
  const failUrl = `${config.appUrl}/payment/fail?order=${encodeURIComponent(order.id)}`;
  return [
    ['MerchantLogin', config.robokassaMerchantLogin],
    ['OutSum', formatAmount(order.amount_kopeks)],
    ['InvId', String(order.inv_id)],
    ['Description', `Доступ к сервису Твои рецепты на ${period}`],
    ['SignatureValue', signatureForOrder(order)],
    ['Culture', 'ru'],
    ['Encoding', 'utf-8'],
    ['Receipt', receiptFor(order)],
    ['ResultUrl2', `${config.appUrl}/api/payments/robokassa/result`],
    ['SuccessUrl2', successUrl],
    ['SuccessUrl2Method', 'GET'],
    ['FailUrl2', failUrl],
    ['FailUrl2Method', 'GET'],
    ['Shp_contour', config.testContour ? 'test' : 'production'],
    ...(config.robokassaTest ? [['IsTest', '1']] : []),
    ...(order.auto_renew ? [['Recurring', 'true'], ['PaymentMethods', 'BankCard']] : [])
  ];
}

export function paymentRedirectDocument(id, at = new Date()) {
  if (!config.robokassaConfigured) throw error('Оплата пока не настроена', 404);
  const order = db.prepare("SELECT * FROM payment_orders WHERE id=? AND kind='initial'").get(id);
  if (!order || order.status !== 'pending') throw error('Ссылка на оплату недоступна', 404);
  if (Date.parse(order.updated_at) < at.getTime() - 24 * 60 * 60 * 1000) throw error('Срок ссылки на оплату истёк', 410);
  const fields = paymentFields(order).map(([name, value]) => `<input type="hidden" name="${html(name)}" value="${html(value)}">`).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Переход к оплате</title><body><main><h1>Переходим к защищённой оплате</h1><p>Если страница не открылась автоматически, нажмите кнопку.</p><form id="pay" method="post" action="${PAYMENT_ACTION}">${fields}<button type="submit">Перейти к оплате</button></form></main><script>document.getElementById('pay').submit()</script></body></html>`;
}

export function paymentReturnDocument(kind) {
  const success = kind === 'success';
  const bot = config.testContour ? config.testBotUsername : 'Recipeboibot';
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${success ? 'Платёж принят' : 'Платёж не завершён'}</title><style>body{margin:0;background:#f3f0f7;color:#2d2633;font:16px/1.5 system-ui}main{max-width:520px;margin:12vh auto;padding:32px}a{display:inline-block;margin-top:20px;padding:14px 20px;border-radius:12px;background:#6d4f7d;color:#fff;text-decoration:none;font-weight:700}</style><main><h1>${success ? 'Платёж принят' : 'Платёж не завершён'}</h1><p>${success ? 'Robokassa приняла платёж. Вернитесь в приложение: мы проверим серверное подтверждение и сразу откроем доступ.' : 'Деньги не списаны. Вернитесь в приложение, чтобы повторить оплату.'}</p><a href="https://t.me/${html(bot)}?start=dinner">Вернуться в бот</a></main></html>`;
}

const parameter = (params, name) => params[name] ?? params[name.toLowerCase()] ?? params[name.toUpperCase()];

function confirmRobokassaPayment({ outSum, invId, signatureHash, paymentMethod, opKey }, at = new Date()) {
  const order = db.prepare('SELECT * FROM payment_orders WHERE inv_id=?').get(invId);
  if (!order || parseAmount(outSum) !== order.amount_kopeks) throw error('Заказ или сумма не совпадают', 400);
  const timestamp = nowIso(at);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT * FROM payment_orders WHERE inv_id=?').get(invId);
    if (['pending', 'failed'].includes(current.status)) {
      db.prepare("UPDATE payment_orders SET status='paid',provider_method=?,provider_op_key=?,paid_at=?,updated_at=? WHERE inv_id=?")
        .run(paymentMethod || null, opKey || null, timestamp, timestamp, invId);
      const access = db.prepare('SELECT * FROM user_subscriptions WHERE user_id=?').get(current.user_id);
      const currentAccess = getSubscriptionAccess(current.user_id, at);
      const baseDate = currentAccess.active ? new Date(currentAccess.expiresAt) : at;
      const expiresAt = monthsAfter(baseDate, current.period_months || 1);
      const startsAt = access && !access.revoked_at && Date.parse(access.expires_at) > at.getTime() ? access.starts_at : timestamp;
      db.prepare(`INSERT INTO user_subscriptions(user_id,plan,starts_at,expires_at,updated_at) VALUES(?,'subscription',?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET plan='subscription',starts_at=excluded.starts_at,expires_at=excluded.expires_at,revoked_at=NULL,updated_at=excluded.updated_at`)
        .run(current.user_id, startsAt, expiresAt, timestamp);
      if (current.promo_code) {
        consumePromo(current.user_id, current.id, at, expiresAt);
        db.prepare('UPDATE payment_recurring SET next_charge_at=?,updated_at=? WHERE user_id=? AND enabled=1')
          .run(new Date(Date.parse(expiresAt) - 86400000).toISOString(), timestamp, current.user_id);
      }
      if (current.kind === 'initial' && current.auto_renew) {
        db.prepare(`INSERT INTO payment_recurring(user_id,enabled,parent_inv_id,amount_kopeks,period_months,next_charge_at,retry_count,updated_at)
          VALUES(?,1,?,?,?,?,0,?) ON CONFLICT(user_id) DO UPDATE SET enabled=1,parent_inv_id=excluded.parent_inv_id,amount_kopeks=excluded.amount_kopeks,period_months=excluded.period_months,next_charge_at=excluded.next_charge_at,retry_count=0,cancelled_at=NULL,updated_at=excluded.updated_at`)
          .run(current.user_id, current.inv_id, current.amount_kopeks, current.period_months || 1, new Date(Date.parse(expiresAt) - 24 * 60 * 60 * 1000).toISOString(), timestamp);
      } else if (current.kind === 'recurring') {
        db.prepare('UPDATE payment_recurring SET next_charge_at=?,retry_count=0,updated_at=? WHERE user_id=?')
          .run(new Date(Date.parse(expiresAt) - 24 * 60 * 60 * 1000).toISOString(), timestamp, current.user_id);
      }
    }
    db.prepare("INSERT OR IGNORE INTO payment_events(id,inv_id,kind,signature_hash,created_at) VALUES(?,?,'paid',?,?)")
      .run(randomUUID(), invId, signatureHash, timestamp);
    db.exec('COMMIT');
  } catch (cause) { db.exec('ROLLBACK'); throw cause; }
  return `OK${invId}`;
}

export function processRobokassaResult(params, at = new Date()) {
  if (!config.robokassaConfigured) throw error('Оплата не настроена', 404);
  const outSum = String(parameter(params, 'OutSum') || '');
  const invId = Number(parameter(params, 'InvId'));
  const received = String(parameter(params, 'SignatureValue') || '');
  if (!Number.isSafeInteger(invId) || invId < 1 || !received) throw error('Некорректное уведомление', 400);
  const shp = Object.entries(params).filter(([key]) => /^Shp_/i.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`);
  const base = [outSum, String(invId), config.robokassaPassword2, ...shp].join(':');
  const expected = hash(base);
  if (!secureEqual(received, expected)) throw error('Некорректная подпись', 400);
  return confirmRobokassaPayment({
    outSum,
    invId,
    signatureHash: createHash('sha256').update(received.toLowerCase()).digest('hex'),
    paymentMethod: parameter(params, 'PaymentMethod'),
    opKey: parameter(params, 'OpKey')
  }, at);
}

function decodeJwsPart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw error('Некорректное уведомление', 400);
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw error('Некорректное уведомление', 400); }
}

export function processRobokassaResultJws(compactJws, at = new Date(), publicKey = ROBOKASSA_JWS_CERTIFICATE) {
  if (!config.robokassaConfigured) throw error('Оплата не настроена', 404);
  const token = String(compactJws || '').trim();
  if (token.length > 16_000) throw error('Запрос слишком большой', 413);
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw error('Некорректное уведомление', 400);
  const header = decodeJwsPart(parts[0]);
  const payload = decodeJwsPart(parts[1]);
  if (header.alg !== 'RS256') throw error('Некорректная подпись', 400);
  let verified = false;
  try {
    verified = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), publicKey, Buffer.from(parts[2], 'base64url'));
  } catch {}
  if (!verified) throw error('Некорректная подпись', 400);
  if (payload?.header?.type !== 'PaymentStateNotification' || payload?.header?.version !== '1.0.0') throw error('Некорректное уведомление', 400);
  const data = payload.data;
  const invId = Number(data?.invId);
  const outSum = String(data?.incSum || '');
  if (!Number.isSafeInteger(invId) || invId < 1 || data?.state !== 'OK' || String(data?.shop || '') !== config.robokassaMerchantLogin) {
    throw error('Некорректное уведомление', 400);
  }
  return confirmRobokassaPayment({
    outSum,
    invId,
    signatureHash: createHash('sha256').update(token).digest('hex'),
    paymentMethod: data.paymentMethod,
    opKey: data.opKey
  }, at);
}

export function cancelAutoRenew(userId, at = new Date()) {
  const timestamp = nowIso(at);
  db.prepare('UPDATE payment_recurring SET enabled=0,cancelled_at=?,next_charge_at=NULL,updated_at=? WHERE user_id=?').run(timestamp, timestamp, userId);
  return recurringFor(userId);
}

function createRecurringOrder(row, at) {
  const assignment = db.prepare('SELECT * FROM payment_experiment_assignments WHERE user_id=? AND experiment_key=?').get(row.user_id, config.paymentExperimentKey);
  const parent = db.prepare('SELECT experiment_key,variant FROM payment_orders WHERE inv_id=? AND user_id=?').get(row.parent_inv_id, row.user_id);
  const id = randomUUID();
  const timestamp = nowIso(at);
  db.prepare(`INSERT INTO payment_orders(id,user_id,experiment_key,variant,amount_kopeks,kind,parent_inv_id,auto_renew,status,created_at,updated_at,period_months,is_test)
    VALUES(?,?,?,?,?,'recurring',?,1,'pending',?,?,?,?)`)
    .run(id, row.user_id, parent?.experiment_key || config.paymentExperimentKey, parent?.variant || assignment?.variant || `price_${row.amount_kopeks / 100}`, row.amount_kopeks, row.parent_inv_id, timestamp, timestamp, row.period_months || 1, config.robokassaTest || config.testContour ? 1 : 0);
  return db.prepare('SELECT * FROM payment_orders WHERE id=?').get(id);
}

async function submitRecurring(order, transport = fetch) {
  const period = subscriptionPeriodLabel(order.period_months || 1);
  const fields = new URLSearchParams({
    MerchantLogin: config.robokassaMerchantLogin,
    OutSum: formatAmount(order.amount_kopeks),
    InvoiceID: String(order.inv_id),
    PreviousInvoiceID: String(order.parent_inv_id),
    Description: `Автопродление доступа к сервису Твои рецепты на ${period}`,
    SignatureValue: signatureForOrder(order, { recurringChild: true }),
    Receipt: receiptFor(order),
    ResultUrl2: `${config.appUrl}/api/payments/robokassa/result`,
    ...(config.robokassaTest ? { IsTest: '1' } : {})
  });
  const response = await transport(RECURRING_ACTION, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: fields, signal: AbortSignal.timeout(15000) });
  const text = (await response.text()).trim();
  if (!response.ok || text !== `OK+${order.inv_id}`) throw new Error(`Robokassa recurring rejected: ${response.status} ${text.slice(0, 120)}`);
}

let recurringCycleRunning = false;
export async function runRecurringCycle(at = new Date(), transport = fetch) {
  if (recurringCycleRunning || !config.robokassaConfigured || !config.robokassaRecurring) return;
  recurringCycleRunning = true;
  try {
    const due = db.prepare('SELECT * FROM payment_recurring WHERE enabled=1 AND next_charge_at IS NOT NULL AND next_charge_at<=? ORDER BY next_charge_at LIMIT 20').all(nowIso(at));
    for (const recurring of due) {
      const pending = db.prepare("SELECT * FROM payment_orders WHERE user_id=? AND kind='recurring' AND status='pending' ORDER BY created_at DESC LIMIT 1").get(recurring.user_id);
      if (pending && Date.parse(pending.created_at) > at.getTime() - 36 * 60 * 60 * 1000) continue;
      if (pending) db.prepare("UPDATE payment_orders SET status='failed',updated_at=? WHERE inv_id=?").run(nowIso(at), pending.inv_id);
      if (recurring.retry_count >= 3) {
        db.prepare('UPDATE payment_recurring SET enabled=0,next_charge_at=NULL,updated_at=? WHERE user_id=?').run(nowIso(at), recurring.user_id);
        continue;
      }
      const order = createRecurringOrder(recurring, at);
      try {
        await submitRecurring(order, transport);
        db.prepare('UPDATE payment_recurring SET last_attempt_at=?,next_charge_at=?,updated_at=? WHERE user_id=?')
          .run(nowIso(at), new Date(at.getTime() + 36 * 60 * 60 * 1000).toISOString(), nowIso(at), recurring.user_id);
      } catch (cause) {
        db.prepare("UPDATE payment_orders SET status='failed',updated_at=? WHERE inv_id=?").run(nowIso(at), order.inv_id);
        db.prepare('UPDATE payment_recurring SET retry_count=retry_count+1,last_attempt_at=?,next_charge_at=?,updated_at=? WHERE user_id=?')
          .run(nowIso(at), new Date(at.getTime() + 12 * 60 * 60 * 1000).toISOString(), nowIso(at), recurring.user_id);
        log('warn', 'payment_recurring_failed', { error: cause, invId: order.inv_id });
      }
    }
  } finally { recurringCycleRunning = false; }
}

let recurringTimer = null;
export function startBillingScheduler() {
  if (recurringTimer || !config.robokassaConfigured || !config.robokassaRecurring) return;
  const tick = () => runRecurringCycle().catch((cause) => log('error', 'payment_recurring_cycle_failed', { error: cause }));
  void tick();
  recurringTimer = setInterval(tick, 15 * 60 * 1000);
  recurringTimer.unref?.();
}

export function stopBillingScheduler() {
  if (recurringTimer) clearInterval(recurringTimer);
  recurringTimer = null;
}
