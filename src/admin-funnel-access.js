import { createDashboardPassword } from './funnel-auth.js';
import { config } from './config.js';
import { db } from './db.js';

if (process.argv[2] !== '--create' || process.argv.length !== 3) {
  console.error('Usage: node src/admin-funnel-access.js --create (rotates password and ends existing dashboard sessions)');
  process.exitCode = 2;
} else console.log(JSON.stringify({ url: `${config.appUrl}/dashboard`, password: createDashboardPassword() }));
db.close();
