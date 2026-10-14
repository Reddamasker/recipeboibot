import { productReport, validProductReport } from './product-analytics.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { db } from './db.js';
import { funnelReport } from './funnel.js';
import { MAX_AD_PLACEMENT } from './max-acquisition.js';
import { activityCounters, emptyRecipeActivity } from './recipe-activity.js';
import { trialCounters, emptyTrialJourney, engagementSince } from './recipe-engagement.js';

const stages = ['starts', 'firstRecipe', 'selectedRecipe', 'trial', 'paid'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const ratio = (n, d) => d ? Number((100 * n / d).toFixed(1)) : null;
const digest = value => createHash('sha256').update(value).digest();
export function maxFunnelAuthorized(header, token = config.maxFunnelToken) {
  return /^[A-Za-z0-9_-]{43,128}$/.test(token) && typeof header === 'string'
    && timingSafeEqual(digest(header), digest('Bearer ' + token));
}
export function maxFunnelSnapshot() {
  const exists = db.prepare('SELECT 1 FROM acquisition_campaigns WHERE slug=?').get(MAX_AD_PLACEMENT);
  const all = funnelReport('all');
  const campaign = exists ? funnelReport(MAX_AD_PLACEMENT) : {
    ...all, productAnalytics: { platforms: [productReport([], true)] }, totals: Object.fromEntries(stages.map(k => [k, 0])), ordered: Object.fromEntries(stages.map(k => [k, 0])), recipeActivity: { ...emptyRecipeActivity(), returnRate: null },
    trialJourney: { ...emptyTrialJourney(), trackingSince: engagementSince() },
    convertedClicks: 0, selectedTrials: 0, returningStarts: 0, testPaidUsers: 0, unclassifiedPaidUsers: 0, historicalStartsWithoutDate: 0, priceExperiment: null
  };
  const summary = report => ({ ...Object.fromEntries(['generatedAt', 'totals', 'ordered', 'convertedClicks', 'selectedTrials', 'returningStarts',
    'testPaidUsers', 'unclassifiedPaidUsers', 'historicalStartsWithoutDate', 'priceExperiment', 'recipeActivity', 'trialJourney', 'productAnalytics'].map(k => [k, report[k]])),
    productAnalytics: { platforms: report.productAnalytics.platforms.map(p => ({ ...p, platform: 'max' })) } });
  return { version: 8, platform: 'max', placement: MAX_AD_PLACEMENT, campaign: summary(campaign), all: summary(all) };
}
function validateSnapshot(data) {
  if (data?.version !== 8 || data.platform !== 'max' || data.placement !== MAX_AD_PLACEMENT) throw new Error('Invalid MAX aggregate');
  for (const scope of ['campaign', 'all']) {
    const report = data[scope];
    if (!report || !Number.isFinite(Date.parse(report.generatedAt))) throw new Error('Invalid MAX timestamp');
    for (const key of stages) if (!count(report.totals?.[key]) || !count(report.ordered?.[key]) || report.ordered[key] > report.totals[key]) throw new Error('Invalid MAX counts');
    if (report.ordered.firstRecipe > report.ordered.starts || report.ordered.selectedRecipe > report.ordered.firstRecipe || report.ordered.trial > report.ordered.firstRecipe || report.ordered.paid > report.ordered.trial) throw new Error('Invalid MAX order');
    if (!count(report.selectedTrials) || report.selectedTrials > report.ordered.selectedRecipe || report.selectedTrials > report.ordered.trial) throw new Error('Invalid MAX selection conversion');
    const a = report.recipeActivity;
    if (activityCounters.some(key => !count(a?.[key])) || a.returnedRecipeUsers > a.repeatRecipeUsers || a.repeatRecipeUsers > a.recipeUsers
      || a.recipeUsers > report.totals.starts || a.savedRecipeUsers > a.savedRecipes || a.notificationsEnabledUsers > a.notificationUsers
      || a.notificationUsers > report.totals.starts) throw new Error('Invalid MAX activity');
    if (a.fullRecipeUsers > a.fullRecipeOpens || a.rereadRecipeUsers > a.fullRecipeUsers
      || a.returnedAnyRecipeUsers < Math.max(a.rereadRecipeUsers, a.returnedRecipeUsers)
      || a.returnedAnyRecipeUsers > a.rereadRecipeUsers + a.returnedRecipeUsers
      || a.returnedAnyRecipeUsers > a.engagedRecipeUsers || a.engagedRecipeUsers > report.totals.starts
      || a.engagedRecipeUsers < Math.max(a.recipeUsers, a.fullRecipeUsers)) throw new Error('Invalid MAX return counts');
    const product = report.productAnalytics?.platforms;
    if (!Array.isArray(product) || product.length !== 1 || !validProductReport(product[0])) throw new Error('Invalid MAX product analytics');
    if (scope === 'campaign' ? product[0].catalogBenefits !== null : product[0].catalogBenefits === null) throw new Error('Invalid MAX catalog scope');
    const j = report.trialJourney;
    if (trialCounters.some(k => !count(j?.[k]) || j[k] > report.totals.starts)
      || j.clicked > j.offered || j.activated > j.clicked || j.opened > j.activated
      || j.clicked > j.clickUsers || j.activated > j.activationUsers
      || !Number.isFinite(Date.parse(j.trackingSince))) throw new Error('Invalid MAX journey');
  }
  if (!count(data.campaign.convertedClicks) || data.campaign.convertedClicks > data.campaign.totals.starts) throw new Error('Invalid MAX attribution');
  return data;
}
function mergePrice(a, b) {
  if (!b) return a;
  if (!a) return b;
  if (a.key !== b.key || !Array.isArray(b.rows) || b.rows.length !== 2) return null;
  const counters = ['starts', 'firstRecipe', 'trial', 'exposed', 'paid', 'maturedTrials', 'maturedPaid', 'monthlyPaid', 'threeMonthsPaid', 'promoPaid'];
  const rows = a.rows.map(row => {
    const other = b.rows.find(r => r.variant === row.variant);
    if (!other || counters.some(k => !count(other[k])) || !Number.isFinite(other.revenueRub) || other.revenueRub < 0) throw new Error('Invalid MAX price counts');
    const total = { ...row };
    for (const key of counters) total[key] += other[key];
    total.revenueRub = Math.round((row.revenueRub + other.revenueRub) * 100) / 100;
    total.revenuePerUserRub = total.starts ? Math.round(total.revenueRub / total.starts * 100) / 100 : null;
    total.paidFromStart = ratio(total.paid, total.starts);
    total.maturedPaidFromTrial = ratio(total.maturedPaid, total.maturedTrials);
    return total;
  });
  return { ...a, rows };
}
export async function mergeMaxFunnelReport(report, { transport = fetch, origin = config.maxFunnelOrigin,
  token = config.maxFunnelToken, enabled = Boolean(config.yandexDirectMaxCampaignId) && !config.testContour && config.botPlatform === 'telegram' } = {}) {
  const specific = report.campaign?.slug === MAX_AD_PLACEMENT;
  if (!enabled || (report.campaign && !specific)) return report;
  const result = structuredClone(report);
  try {
    if (origin !== 'https://recipeboibot-max.89-223-123-75.sslip.io' || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error('MAX bridge unconfigured');
    const response = await transport(origin + '/api/internal/max-funnel', {
      headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000), redirect: 'error'
    });
    if (!response.ok) throw new Error('MAX bridge unavailable');
    const text = await response.text();
    if (text.length > 64000) throw new Error('MAX aggregate too large');
    const data = validateSnapshot(JSON.parse(text));
    const remote = specific ? data.campaign : data.all;
    result.platform = specific ? 'max' : 'combined';
    result.productAnalytics = { platforms: specific ? remote.productAnalytics.platforms : [...(report.productAnalytics?.platforms || []), ...remote.productAnalytics.platforms] };
    result.recipeActivity = Object.fromEntries(activityCounters.map(key => [key, specific ? remote.recipeActivity[key] : result.recipeActivity[key] + remote.recipeActivity[key]]));
    result.recipeActivity.returnRate = ratio(result.recipeActivity.returnedRecipeUsers, result.recipeActivity.recipeUsers);
    result.recipeActivity.anyReturnRate = ratio(result.recipeActivity.returnedAnyRecipeUsers, result.recipeActivity.engagedRecipeUsers);
    result.recipeActivity.trackingSince = specific ? remote.trialJourney.trackingSince : report.recipeActivity.trackingSince;
    result.recipeActivity.trackingSinceMax = remote.trialJourney.trackingSince;
    result.trialJourney = Object.fromEntries(trialCounters.map(k => [k, specific ? remote.trialJourney[k] : (report.trialJourney?.[k] || 0) + remote.trialJourney[k]]));
    result.trialJourney.trackingSince = result.recipeActivity.trackingSince;
    for (const key of stages) {
      result.totals[key] = specific ? remote.totals[key] : result.totals[key] + remote.totals[key];
      result.ordered[key] = specific ? remote.ordered[key] : result.ordered[key] + remote.ordered[key];
    }
    result.convertedClicks = specific ? data.campaign.convertedClicks : (result.convertedClicks ?? 0) + data.campaign.convertedClicks;
    result.selectedTrials = specific ? remote.selectedTrials : result.selectedTrials + remote.selectedTrials;
    result.returningStarts = specific ? remote.returningStarts : result.returningStarts;
    for (const key of ['testPaidUsers', 'unclassifiedPaidUsers', 'historicalStartsWithoutDate']) {
      if (!count(remote[key])) throw new Error('Invalid MAX exclusions');
      result[key] = specific ? remote[key] : (result[key] || 0) + remote[key];
    }
    result.priceExperiment = specific ? remote.priceExperiment : mergePrice(result.priceExperiment, remote.priceExperiment);
    if (specific) result.linkRequests = null;
    result.conversions = { ...result.conversions, startFromClick: ratio(result.convertedClicks, result.clicks),
      firstRecipeFromStart: ratio(result.ordered.firstRecipe, result.ordered.starts),
      selectionFromRecipe: ratio(result.ordered.selectedRecipe, result.ordered.firstRecipe),
      trialAfterSelection: ratio(result.selectedTrials, result.ordered.selectedRecipe),
      trialAfterRecipe: ratio(result.ordered.trial, result.ordered.firstRecipe), paidAfterTrial: ratio(result.ordered.paid, result.ordered.trial) };
    result.remoteFunnel = { platform: 'max', status: 'ready', generatedAt: remote.generatedAt, error: null };
    return result;
  } catch {
    // Keep advertising numbers; unavailable bot data must never become false zeroes.
    const unavailable = structuredClone(report);
    unavailable.platform = specific ? 'max' : 'combined';
    unavailable.remoteFunnel = { platform: 'max', status: 'error', generatedAt: null,
      error: 'Данные MAX сейчас недоступны.' + (specific ? '' : ' Общие пользовательские этапы пока учитывают только Telegram.') };
    if (specific) {
      for (const key of stages) unavailable.totals[key] = unavailable.ordered[key] = null;
      unavailable.productAnalytics = null;
      unavailable.priceExperiment = null; unavailable.convertedClicks = null; unavailable.selectedTrials = null; unavailable.linkRequests = null;
      unavailable.recipeActivity = Object.fromEntries([...activityCounters, 'returnRate'].map(key => [key, null]));
      unavailable.trialJourney = Object.fromEntries(trialCounters.map(key => [key, null]));
      for (const key of ['startFromClick', 'firstRecipeFromStart', 'selectionFromRecipe', 'trialAfterSelection', 'trialAfterRecipe', 'paidAfterTrial']) unavailable.conversions[key] = null;
    } else unavailable.conversions.startFromClick = null;
    return unavailable;
  }
}
