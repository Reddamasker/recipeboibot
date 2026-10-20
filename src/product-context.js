import { AsyncLocalStorage } from 'node:async_hooks';
// Lightweight: importing the logger must never open a database or load configuration.
export const productContext = new AsyncLocalStorage();
export function setProductResult(mode) {
  const current = productContext.getStore();
  if (current && !current.finished && ['catalog', 'generated', 'cache', 'mixed', 'empty'].includes(mode)) current.resultMode = mode;
}
export async function measureProductStage(stage, fn) {
  const current = productContext.getStore(), started = Date.now();
  try { return await fn(); }
  finally {
    if (current && !current.finished && ['interpretation', 'generation', 'validation', 'nutrition', 'catalog'].includes(stage)) {
      current.stages ||= [];
      if (current.stages.length < 24) current.stages.push({ stage, durationMs: Math.min(86400000, Date.now() - started) });
    }
  }
}
export function markProductError(code = 500) {
  const current = productContext.getStore();
  if (current) current.error = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
}
