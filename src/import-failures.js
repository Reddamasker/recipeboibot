import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { createImportFailureStore } from './import-failure-store.js';

const file = path.join(config.databasePath + '.failed-imports', 'diagnostics.sqlite');
let timer;
function useStore(fn) {
  const store = createImportFailureStore(file);
  try { return fn(store); } finally { store.close(); }
}
export const isImportFailureOwner = identity => String(identity) === String(config.analyticsOwnerId);
const warn = () => console.error('import_failure_diagnostics_unavailable');
export function captureImportFailure(userId, text, options, error) {
  if (options.diagnosticsDisabled || options.sourceType && options.sourceType !== 'text' || options.image || options.photos?.length || options.sourceUrl) return;
  try { useStore(store => store.capture({ userId, text, source: options.sourceName === 'Текст из Mini App' ? 'miniapp' : 'chat', error })); } catch { warn(); }
}
export function resolveImportFailure(userId, text) {
  try { if (fs.existsSync(file)) useStore(store => store.resolved(userId, text)); } catch { warn(); }
}
export function forgetImportFailures(userId) { if (fs.existsSync(file)) useStore(store => store.forget(userId)); }
export function importFailureReport() { return { ...useStore(store => store.report()), platform: config.botPlatform }; }
export function removeImportFailure(id) { return useStore(store => store.remove(id)); }
export function startImportFailureCleanup() {
  if (timer) return;
  const clean = () => { try { useStore(store => store.purge()); } catch { warn(); } };
  clean(); timer = setInterval(clean, 60000); timer.unref();
}
export function stopImportFailureCleanup() { clearInterval(timer); timer = null; }
