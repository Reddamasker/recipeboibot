import { AsyncLocalStorage } from 'node:async_hooks';

// A failed delivery stops only this update, never future messages from the user.
const delivery = new AsyncLocalStorage();
const codes = new Set(['forbidden', 'access.denied', 'bot.blocked', 'user.blocked', 'chat.denied', 'chat.not.found', 'user.not.found', 'proto.payload', 'attachment.not.ready', 'too.many.requests', 'internal.error']);
export class MaxApiError extends Error {
  constructor(httpStatus, { code, method = 'GET', path, kind } = {}) {
    const status = Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? httpStatus : 502;
    super(`MAX API request failed (${status})`);
    this.name = 'MaxApiError';
    this.status = status;
    this.reason = status === 403 ? 'forbidden' : status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : kind === 'network' ? 'network' : kind === 'invalid_response' ? 'invalid_response' : status >= 500 ? 'upstream' : 'request_rejected';
    this.providerCode = codes.has(code) ? code : 'unknown';
    this.apiMethod = ['GET','POST','PUT','DELETE'].includes(method) ? method : 'other';
    this.apiResource = ['/messages','/answers','/me'].includes(path) ? path.slice(1) : 'other';
  }
}
export const isPermanentMaxError = error => error instanceof MaxApiError && error.status === 403;
export function rememberMaxError(error) {
  const current = delivery.getStore();
  if (current && isPermanentMaxError(error)) current.error ||= error;
  return error;
}
export function assertMaxDeliveryAvailable() {
  const error = delivery.getStore()?.error;
  if (error) throw error;
}
export function withMaxDelivery(fn) {
  return delivery.run({}, async () => {
    try { return await fn(); }
    finally { assertMaxDeliveryAvailable(); }
  });
}
