import { createHash } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { createCampaign, funnelReport } from './funnel.js';
import { log } from './log.js';

export const DIRECT_REPORT_URL = 'https://api.direct.yandex.com/json/v501/reports';
export const DIRECT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const fields = ['CampaignId', 'Impressions', 'Clicks', 'Cost'];
db.exec(`CREATE TABLE IF NOT EXISTS acquisition_direct_stats (
  slug TEXT PRIMARY KEY REFERENCES acquisition_campaigns(slug), campaign_id TEXT NOT NULL,
  impressions INTEGER, clicks INTEGER, cost_kopeks INTEGER, synced_at TEXT,
  attempted_at TEXT, status TEXT NOT NULL DEFAULT 'waiting', error TEXT
);`);

export function directImportSettings(slug = config.yandexDirectPlacement) {
  if (slug === 'ya-dinner-landing-202610') return { token: config.yandexDirectToken, login: config.yandexDirectLogin,
    campaignId: config.yandexDirectLandingCampaignId, slug, name: 'Яндекс — ужин через лендинг, октябрь 2026' };
  if (slug !== config.yandexDirectPlacement) throw new Error('Кампания не подключена к импорту Директа');
  return { token: config.yandexDirectToken, login: config.yandexDirectLogin,
    campaignId: config.yandexDirectCampaignId, slug: config.yandexDirectPlacement };
}
export function directImportStatus(slug) {
  const row = db.prepare('SELECT * FROM acquisition_direct_stats WHERE slug=?').get(slug);
  if (!row) return null;
  return { campaignId: row.campaign_id, impressions: row.impressions, clicks: row.clicks,
    costRub: row.cost_kopeks === null ? null : row.cost_kopeks / 100,
    cpcRub: row.clicks ? Number((row.cost_kopeks / 100 / row.clicks).toFixed(2)) : null,
    syncedAt: row.synced_at, attemptedAt: row.attempted_at, status: row.status, error: row.error,
    includesVat: true, reachAvailable: false };
}
export function dashboardFunnelReport(slug = 'all') {
  const report = funnelReport(slug);
  report.linkRequests = report.clicks;
  const imported = new Map(report.campaigns.map(campaign => [campaign.slug, directImportStatus(campaign.slug)]));
  report.campaigns = report.campaigns.map(campaign => ({ ...campaign, statsSource: imported.get(campaign.slug) ? 'direct' : 'manual' }));
  const scope = report.campaign ? [report.campaign] : report.campaigns;
  const hasDirect = scope.some(campaign => imported.get(campaign.slug));
  report.clickSource = hasDirect ? 'direct' : 'link';
  if (hasDirect) {
    // Unknown clicks from another placement cannot be replaced with URL requests.
    const rows = scope.map(campaign => imported.get(campaign.slug));
    report.clicks = rows.every(row => row?.clicks !== null && row?.clicks !== undefined)
      ? rows.reduce((sum, row) => sum + row.clicks, 0) : null;
    report.conversions.clickFromImpression = report.clicks !== null && report.impressions
      ? Number((100 * report.clicks / report.impressions).toFixed(1)) : null;
    report.conversions.startFromClick = report.campaign && report.clicks
      ? Number((100 * report.convertedClicks / report.clicks).toFixed(1)) : null;
  } else {
    // Requests to a redirect are not confirmed advertising clicks or CTR.
    report.conversions.clickFromImpression = null;
  }
  report.directStats = directImportStatus(report.campaign?.slug || config.yandexDirectPlacement);
  report.defaultCampaign = imported.get(config.yandexDirectPlacement) ? config.yandexDirectPlacement : null;
  return report;
}
export function directReportRequest(campaignId, at = new Date()) {
  if (!/^[1-9]\d{0,15}$/.test(String(campaignId))) throw new Error('Неверный ID кампании Директа');
  const params = { SelectionCriteria: { Filter: [{ Field: 'CampaignId', Operator: 'EQUALS', Values: [String(campaignId)] }] },
    FieldNames: fields, ReportType: 'CAMPAIGN_PERFORMANCE_REPORT', DateRangeType: 'ALL_TIME',
    Format: 'TSV', IncludeVAT: 'YES' };
  // Each import gets a new report; retries within that import keep the same request.
  params.ReportName = `recipes-${createHash('sha256').update(JSON.stringify(params) + at.toISOString()).digest('hex').slice(0, 24)}`;
  return { params };
}
export function parseDirectReport(text, campaignId) {
  const lines = String(text).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.shift() !== fields.join('\t')) throw new Error('Неверный заголовок отчёта Директа');
  let result = { impressions: 0, clicks: 0, costKopeks: 0 }, rows = 0;
  for (const line of lines.filter(Boolean)) {
    const values = line.split('\t');
    if (values.length !== 4 || values[0] !== String(campaignId) || ++rows > 1) throw new Error('Неверная кампания или структура отчёта Директа');
    const [impressions, clicks] = values.slice(1, 3).map(value => /^\d+$/.test(value) ? Number(value) : NaN);
    if (!/^\d+(?:\.\d{1,2})?$/.test(values[3])) throw new Error('Неверная сумма отчёта Директа');
    const costKopeks = Math.round(Number(values[3]) * 100);
    if (![impressions, clicks, costKopeks].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Неверные числа отчёта Директа');
    result = { impressions, clicks, costKopeks };
  }
  return result;
}

const running = new Map();
let timer = null;
export function syncDirectStats({ settings = directImportSettings(), transport = fetch, at = new Date(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const key = `${settings.slug}:${settings.campaignId}`;
  if (running.has(key)) return running.get(key);
  const result = importReport(settings, transport, at, wait).finally(() => running.delete(key));
  running.set(key, result);
  return result;
}
async function importReport(settings, transport, at, wait) {
  const { token, login, campaignId, slug } = settings;
  if (!token) throw new Error('Доступ к API Директа ещё не подключён');
  const request = directReportRequest(campaignId, at);
  createCampaign(slug, settings.name || slug);
  const timestamp = at.toISOString();
  db.prepare(`INSERT INTO acquisition_direct_stats(slug,campaign_id,attempted_at,status) VALUES(?,?,?,'waiting')
    ON CONFLICT(slug) DO UPDATE SET campaign_id=excluded.campaign_id,attempted_at=excluded.attempted_at,status='waiting',error=NULL`).run(slug, String(campaignId), timestamp);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await transport(DIRECT_REPORT_URL, { method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}`, ...(login ? { 'Client-Login': login } : {}), 'Content-Type': 'application/json; charset=utf-8',
          'Accept-Language': 'ru', processingMode: 'auto', returnMoneyInMicros: 'false', skipReportHeader: 'true', skipColumnHeader: 'false', skipReportSummary: 'true' },
        body: JSON.stringify(request) });
      if ([201, 202].includes(response.status)) {
        if (attempt === 3) return { ...directImportStatus(slug), pending: true };
        const seconds = Number(response.headers.get('retryIn'));
        await wait(Math.min(30000, Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 5000)));
        continue;
      }
      // Never persist or log API response bodies: they may contain account data or credentials.
      if (response.status !== 200) {
        let code;
        try { code = (await response.json()).error?.error_code; } catch {}
        if (String(code) === '58') throw new Error('Заявка API ожидает одобрения Яндекса. Импорт продолжит проверку автоматически.');
        throw new Error(`Директ не отдал статистику (HTTP ${response.status}). Проверьте доступ API.`);
      }
      const totals = parseDirectReport(await response.text(), campaignId);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('UPDATE acquisition_campaigns SET impressions=?,reach=NULL,stats_updated_at=? WHERE slug=?').run(totals.impressions, timestamp, slug);
        db.prepare(`UPDATE acquisition_direct_stats SET impressions=?,clicks=?,cost_kopeks=?,synced_at=?,status='ready',error=NULL WHERE slug=?`)
          .run(totals.impressions, totals.clicks, totals.costKopeks, timestamp, slug);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return directImportStatus(slug);
    }
  } catch (cause) {
    const safeMessage = /^Директ не отдал|^Неверн|^Заявка API/.test(cause.message || '') ? cause.message : 'Не удалось обновить статистику Директа. Последние данные сохранены.';
    db.prepare("UPDATE acquisition_direct_stats SET status='error',error=? WHERE slug=?").run(safeMessage, slug);
    throw new Error(safeMessage);
  }
}
export function startDirectScheduler() {
  if (timer || !config.yandexDirectToken || config.testContour || config.dashboardPreview) return;
  const tick = () => {
    const slugs = [config.yandexDirectPlacement, ...(config.yandexDirectLandingCampaignId ? ['ya-dinner-landing-202610'] : [])];
    for (const slug of slugs) void syncDirectStats({ settings: directImportSettings(slug) }).catch(error => log('warn', 'direct_import_failed', { slug, error }));
  };
  void tick();
  timer = setInterval(tick, DIRECT_SYNC_INTERVAL_MS); timer.unref?.();
}
export function stopDirectScheduler() { if (timer) clearInterval(timer); timer = null; }
