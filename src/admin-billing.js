import { db } from './db.js';
import { config } from './config.js';
import './billing.js';

const experimentKey = process.argv[2] || config.paymentExperimentKey;
const rows = db.prepare(`WITH per_user AS (
  SELECT a.user_id,a.variant,a.amount_kopeks,a.exposed_at,
    MAX(CASE WHEN o.kind='initial' THEN 1 ELSE 0 END) AS checkout,
    MAX(CASE WHEN o.kind='initial' AND o.status='paid' THEN 1 ELSE 0 END) AS converted,
    SUM(CASE WHEN o.status='paid' THEN o.amount_kopeks ELSE 0 END) AS revenue_kopeks,
    SUM(CASE WHEN o.status='paid' THEN 1 ELSE 0 END) AS paid_orders
  FROM payment_experiment_assignments a
  LEFT JOIN payment_orders o ON o.user_id=a.user_id AND o.experiment_key=a.experiment_key
  WHERE a.experiment_key=?
  GROUP BY a.user_id,a.variant,a.amount_kopeks,a.exposed_at
)
SELECT variant,amount_kopeks,
  COUNT(*) AS assigned_users,
  SUM(CASE WHEN exposed_at IS NOT NULL THEN 1 ELSE 0 END) AS exposed_users,
  SUM(checkout) AS checkout_users,
  SUM(converted) AS paid_users,
  SUM(paid_orders) AS paid_orders,
  SUM(revenue_kopeks) AS revenue_kopeks
FROM per_user
GROUP BY variant,amount_kopeks
ORDER BY amount_kopeks`).all(experimentKey);

const report = rows.map((row) => ({
  variant: row.variant,
  priceRub: row.amount_kopeks / 100,
  assignedUsers: row.assigned_users,
  exposedUsers: row.exposed_users,
  checkoutUsers: row.checkout_users,
  paidUsers: row.paid_users,
  paidOrders: row.paid_orders,
  conversionFromExposure: row.exposed_users ? Number((row.paid_users / row.exposed_users).toFixed(4)) : null,
  checkoutFromExposure: row.exposed_users ? Number((row.checkout_users / row.exposed_users).toFixed(4)) : null,
  revenueRub: row.revenue_kopeks / 100,
  revenuePerExposedUserRub: row.exposed_users ? Number((row.revenue_kopeks / 100 / row.exposed_users).toFixed(2)) : null
}));

console.log(JSON.stringify({ experimentKey, generatedAt: new Date().toISOString(), variants: report }, null, 2));
db.close();
