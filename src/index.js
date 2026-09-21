import { assertConfig, config } from './config.js';
import { createServer } from './server.js';
import { startTelegramPolling, stopTelegramPolling } from './telegram.js';
import { log } from './log.js';
import { interruptActiveJobs } from './db.js';

assertConfig();
const interruptedJobs = interruptActiveJobs();
if (interruptedJobs) log('warn', 'import_jobs_recovered', { count: interruptedJobs });
const server = createServer();
server.listen(config.port, '0.0.0.0', () => {
  log('info', 'server_started', { port: config.port, appUrlConfigured: Boolean(config.appUrl) });
  if (config.telegramPolling) startTelegramPolling().catch((error) => log('error', 'telegram_fatal', { error }));
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopTelegramPolling(); server.close(() => process.exit(0)); });
