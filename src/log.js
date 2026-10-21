import { markProductError } from './product-context.js';
const redact = (value) => {
  if (value instanceof Error) return { name: value.name, message: value.message, status: Number.isInteger(value.status) ? value.status : undefined, causeCode: value.cause?.code, ...(value.name === 'MaxApiError' ? { reason: value.reason, providerCode: value.providerCode, apiMethod: value.apiMethod, apiResource: value.apiResource } : {}), stack: process.env.NODE_ENV === 'development' ? value.stack : undefined };
  if (!value || typeof value !== 'object') return value;
  const clean = Array.isArray(value) ? [] : {};
  for (const [key, item] of Object.entries(value)) clean[key] = /token|secret|key|initdata|content|text/i.test(key) ? '[redacted]' : redact(item);
  return clean;
};

export function log(level, event, details = {}) {
  if (level === 'error') markProductError(details.error?.status);
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(details) })}\n`);
}
