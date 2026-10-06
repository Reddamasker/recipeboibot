// A separate invoice namespace keeps one merchant safe across independent DBs.
export const MAX_INVOICE_FLOOR = 1_000_000_000_000;
export const MAX_RESULT_URL = 'https://recipeboibot-max.89-223-123-75.sslip.io/api/payments/robokassa/result';
export const paymentContour = settings => settings.botPlatform === 'max' ? 'max' : settings.testContour ? 'test' : 'production';
export function invoiceBelongsToContour(invId, settings) {
  return Number.isSafeInteger(invId) && invId > 0 && (settings.botPlatform === 'max' ? invId >= MAX_INVOICE_FLOOR : invId < MAX_INVOICE_FLOOR);
}
export function callbackDestination(params, settings, { jws = false } = {}) {
  const invId = Number(params.InvId ?? params.invid ?? params.INVID);
  if (!Number.isSafeInteger(invId) || invId < 1) throw Object.assign(new Error('Некорректное уведомление'), { status: 400 });
  if (settings.botPlatform === 'max') return null;
  if (invId >= MAX_INVOICE_FLOOR) {
    if (settings.testContour || (!jws && params.Shp_contour !== 'max') || !settings.robokassaMaxResultUrl) throw Object.assign(new Error('Неверный контур платежа'), { status: 400 });
    return settings.robokassaMaxResultUrl;
  }
  if (!jws && params.Shp_contour === 'max') throw Object.assign(new Error('Неверный контур платежа'), { status: 400 });
  if (!jws && !settings.testContour && params.Shp_contour === 'test' && settings.robokassaTestResultUrl) return settings.robokassaTestResultUrl;
  return null;
}
// This is only a routing hint. The destination verifies RSA, merchant, amount,
// invoice ownership and signature before it may grant access.
export function jwsRoutingParameters(body) {
  try {
    const parts = String(body).trim().split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return { InvId: payload?.data?.invId };
  } catch { throw Object.assign(new Error('Некорректное уведомление'), { status: 400 }); }
}
