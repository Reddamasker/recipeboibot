import { db } from './db.js';
import { engagementSince, moscowDay } from './recipe-engagement.js';

export const activityCounters = ['preparedRecipes', 'recipeUsers', 'repeatRecipeUsers', 'returnedRecipeUsers',
  'savedRecipes', 'savedRecipeUsers', 'notificationUsers', 'notificationsEnabledUsers',
  'fullRecipeUsers', 'fullRecipeOpens', 'rereadRecipeUsers', 'returnedAnyRecipeUsers', 'engagedRecipeUsers'];
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
  const returned = new Set();
  for (const [id, values] of requests) {
    if (values.size > 1) result.repeatRecipeUsers++;
    if (new Set([...values.values()].map(day)).size > 1) { result.returnedRecipeUsers++; returned.add(id); }
  }
  const readers = new Set(), rereaders = new Set(), known = new Map();
  for (const row of db.prepare("SELECT * FROM recipe_engagement WHERE event IN ('recipe_opened','recipe_delivered') ORDER BY created_at,rowid").all()) {
    if (!afterStart(row.user_id, row.created_at)) continue;
    const key = `${row.user_id}:${row.recipe_key}`, previous = known.get(key);
    const saved = row.saved_at && (!campaign || row.saved_at >= users.get(row.user_id).started_at) ? row.saved_at : null;
    if (row.event === 'recipe_opened') {
      result.fullRecipeOpens++; readers.add(row.user_id);
      if ((previous && moscowDay(previous) < moscowDay(row.created_at)) || (saved && moscowDay(saved) < moscowDay(row.created_at))) {
        rereaders.add(row.user_id); returned.add(row.user_id);
      }
    }
    if (!previous) known.set(key, row.created_at);
  }
  result.fullRecipeUsers = readers.size;
  result.rereadRecipeUsers = rereaders.size;
  result.returnedAnyRecipeUsers = returned.size;
  result.engagedRecipeUsers = new Set([...requests.keys(), ...readers]).size;
  result.anyReturnRate = result.engagedRecipeUsers ? Number((100 * returned.size / result.engagedRecipeUsers).toFixed(1)) : null;
  result.trackingSince = engagementSince();
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
