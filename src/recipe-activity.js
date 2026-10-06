import { db } from './db.js';

export const activityCounters = ['preparedRecipes', 'recipeUsers', 'repeatRecipeUsers', 'returnedRecipeUsers',
  'savedRecipes', 'savedRecipeUsers', 'notificationUsers', 'notificationsEnabledUsers'];
export const emptyRecipeActivity = () => Object.fromEntries(activityCounters.map(key => [key, 0]));
const exists = table => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const day = at => new Date(Date.parse(at) + 3 * 3600000).toISOString().slice(0, 10);

// The caller supplies the same filtered cohort as acquisition analytics.
export function recipeActivityReport(cohort, campaign = false) {
  const users = new Map(cohort.map(user => [user.id, user]));
  const afterStart = (id, at) => users.has(id) && (!campaign || at >= users.get(id).started_at);
  const result = emptyRecipeActivity(), requests = new Map();
  const addRequest = (id, key, at) => {
    if (!afterStart(id, at)) return;
    if (!requests.has(id)) requests.set(id, new Map());
    const previous = requests.get(id).get(key);
    if (!previous || at < previous) requests.get(id).set(key, at);
  };
  for (const row of db.prepare('SELECT * FROM recipe_request_results').all()) {
    if (!afterStart(row.user_id, row.created_at)) continue;
    result.preparedRecipes++;
    addRequest(row.user_id, row.result_key, row.created_at);
  }
  if (exists('dinner_recommendations') && exists('dinner_sessions')) {
    // Options in the reserve have no recommendation row. Duplicate recipes in
    // one session count once; the same recipe in another session counts again.
    const rows = db.prepare(`SELECT r.user_id,r.session_id,r.recipe_key,MIN(r.shown_at) AS prepared_at,
      s.viewed_at,MIN(r.decided_at) FILTER (WHERE r.status='accepted') AS accepted_at
      FROM dinner_recommendations r JOIN dinner_sessions s ON s.id=r.session_id
      GROUP BY r.user_id,r.session_id,r.recipe_key`).all();
    for (const row of rows) {
      if (afterStart(row.user_id, row.prepared_at)) result.preparedRecipes++;
      // A background reminder/prefetch alone does not prove a return.
      const opened = row.viewed_at || row.accepted_at;
      if (opened) addRequest(row.user_id, `dinner:${row.session_id}`, opened > row.prepared_at ? opened : row.prepared_at);
    }
  }
  result.recipeUsers = requests.size;
  for (const values of requests.values()) {
    if (values.size > 1) result.repeatRecipeUsers++;
    if (new Set([...values.values()].map(day)).size > 1) result.returnedRecipeUsers++;
  }
  const savers = new Set();
  for (const row of db.prepare("SELECT user_id,created_at FROM recipes WHERE status IN ('ready','archived')").all()) {
    if (afterStart(row.user_id, row.created_at)) { result.savedRecipes++; savers.add(row.user_id); }
  }
  result.savedRecipeUsers = savers.size;
  if (exists('notification_schedules')) {
    for (const row of db.prepare('SELECT user_id,enabled,first_enabled_at FROM notification_schedules').all()) {
      if (!row.first_enabled_at || !afterStart(row.user_id, row.first_enabled_at)) continue;
      result.notificationUsers++;
      if (row.enabled) result.notificationsEnabledUsers++;
    }
  }
  result.returnRate = result.recipeUsers ? Number((100 * result.returnedRecipeUsers / result.recipeUsers).toFixed(1)) : null;
  return result;
}
