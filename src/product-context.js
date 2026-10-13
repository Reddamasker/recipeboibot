import { AsyncLocalStorage } from 'node:async_hooks';
// Lightweight: importing the logger must never open a database or load configuration.
export const productContext = new AsyncLocalStorage();
export function markProductError(code = 500) {
  const current = productContext.getStore();
  if (current) current.error = code;
}
