// Public campaign labels carry no authority or access rights. Keep the registry
// shared across contours: a landing URL cannot create an arbitrary campaign.
export const MAX_LANDING_CAMPAIGNS = Object.freeze([
  'site-landing', 'ya-product-landing-202611', 'ya-product-rsya-202611',
  'ya-dinner-202610', 'ya-dinner-outside-202610', 'ya-dinner-landing-202610',
  'ya-max-dinner-202610', 'ya-recipe-first-202610'
]);
export function maxLandingPayload(campaign, token) {
  if (!MAX_LANDING_CAMPAIGNS.includes(campaign) || !/^[A-Za-z0-9_-]{24}$/.test(token || '')) return null;
  return `lc_${campaign}_${token}`;
}
export function parseMaxLandingPayload(text) {
  const match = String(text).match(/^\/start(?:@[A-Za-z0-9_]+)?\s+lc_([a-z0-9][a-z0-9_-]{0,35})_([A-Za-z0-9_-]{24})\s*$/i);
  return match && MAX_LANDING_CAMPAIGNS.includes(match[1]) ? { campaign: match[1], token: match[2] } : null;
}
