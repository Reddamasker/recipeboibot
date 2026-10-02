import './billing.js';
import './dinner-store.js';
import { db } from './db.js';
import { funnelReport } from './funnel.js';

console.log(JSON.stringify(funnelReport(process.argv[2] || 'all'), null, 2));
db.close();
