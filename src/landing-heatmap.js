import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { analyticsExcludedIds, analyticsUserCondition } from './analytics-exclusions.js';
import { isAdvertisingProbe } from './funnel.js';
import './landing-funnel.js';

export const HEATMAP_VERSION = 'figma-20261109';
export const HEATMAP_SECTIONS = Object.freeze({ header: '.lp-header', hero: '.lp-hero', import: '#features', collection: '#collection', menu: '#meal-plan', shopping: '#shopping-list', pricing: '#pricing', faq: '#questions', finish: '.lp-end', footer: '.lp-footer' });
const layouts = ['mobile', 'tablet', 'desktop'];
const targets = ['area', 'telegram', 'max', 'navigation', 'catalog', 'pricing', 'legal', 'feedback', 'replay', 'menu', ...Array.from({ length: 6 }, (_, i) => `faq_${i}`)];
db.exec(`CREATE TABLE IF NOT EXISTS landing_heatmap_events (
 id TEXT PRIMARY KEY, visit_id TEXT NOT NULL REFERENCES landing_visits(id), version TEXT NOT NULL,
 layout TEXT NOT NULL, kind TEXT NOT NULL, section TEXT, target TEXT, x INTEGER, y INTEGER,
 depth INTEGER, visible_ms INTEGER, dropped INTEGER, pending INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS landing_heatmap_visit ON landing_heatmap_events(visit_id,version,layout);
CREATE TABLE IF NOT EXISTS landing_heatmap_sessions (
 visit_id TEXT NOT NULL REFERENCES landing_visits(id), version TEXT NOT NULL, layout TEXT NOT NULL,
 max_depth INTEGER NOT NULL, visible_ms INTEGER NOT NULL, dropped INTEGER NOT NULL, pending INTEGER NOT NULL,
 first_at TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY(visit_id,version,layout)
);`);
if (!db.prepare('PRAGMA table_info(landing_heatmap_sessions)').all().some(c=>c.name==='storage_error')) db.exec('ALTER TABLE landing_heatmap_sessions ADD COLUMN storage_error INTEGER NOT NULL DEFAULT 0');
db.prepare("INSERT OR IGNORE INTO acquisition_metadata(key,value) VALUES('landing_heatmap_since',?)").run(new Date().toISOString());
const fail = message => Object.assign(new Error(message), { status: 400 });
const integer = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
export function recordLandingHeatmap(input, options = {}) {
  if (!input || Object.keys(input).some(k => k !== 'events') || !Array.isArray(input.events) || !input.events.length || input.events.length > 20) throw fail('Неверный пакет карты');
  for (const e of input.events) {
    const common = ['id','visitId','version','layout','kind'];
    const extra = e?.kind === 'click' ? ['section','target','x','y'] : ['depth','visibleMs','dropped','pending','storageError'];
    if (!e || Object.keys(e).some(k => ![...common,...extra].includes(k)) || !/^[a-f0-9-]{36}$/.test(e.id || '') || !/^[a-f0-9]{32}$/.test(e.visitId || '') || e.version !== HEATMAP_VERSION || !layouts.includes(e.layout)) throw fail('Неверное событие карты');
    if (e.kind === 'click') {
      if (!Object.hasOwn(HEATMAP_SECTIONS,e.section) || !targets.includes(e.target) || !integer(e.x,20) || !integer(e.y,20)) throw fail('Неверная точка карты');
    } else if (e.kind !== 'progress' || !integer(e.depth,100) || !integer(e.visibleMs,86400000) || !integer(e.dropped,100000) || !integer(e.pending,80) || !integer(e.storageError??0,1)) throw fail('Неверный замер прокрутки');
  }
  if (options.internal || isAdvertisingProbe(options)) return { accepted: input.events.map(e => e.id), skipped: true };
  const at = new Date().toISOString(), accepted = [], limited = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of input.events) {
      const visit = db.prepare('SELECT id FROM landing_visits WHERE id=?').get(e.visitId);
      if (!visit) throw fail('Посещение карты не найдено');
      if (db.prepare('SELECT 1 FROM landing_heatmap_events WHERE id=?').get(e.id)) { accepted.push(e.id); continue; }
      if (db.prepare('SELECT COUNT(*) n FROM landing_heatmap_events WHERE visit_id=?').get(e.visitId).n >= 1500) { accepted.push(e.id); limited.push(e.id); continue; }
      db.prepare('INSERT INTO landing_heatmap_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(e.id,e.visitId,e.version,e.layout,e.kind,e.section??null,e.target??null,e.x??null,e.y??null,e.depth??null,e.visibleMs??null,e.dropped??null,e.pending??null,at);
      if (e.kind === 'progress') db.prepare(`INSERT INTO landing_heatmap_sessions VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(visit_id,version,layout) DO UPDATE SET max_depth=MAX(max_depth,excluded.max_depth),visible_ms=MAX(visible_ms,excluded.visible_ms),dropped=MAX(dropped,excluded.dropped),pending=excluded.pending,last_at=excluded.last_at,storage_error=MAX(storage_error,excluded.storage_error)`)
        .run(e.visitId,e.version,e.layout,e.depth,e.visibleMs,e.dropped,e.pending,at,at,e.storageError??0);
      accepted.push(e.id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { accepted, limited };
}
function dateBoundary(value, end = false) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw fail('Неверная дата');
  const d = new Date(`${value}T00:00:00+03:00`);
  if (!Number.isFinite(d.getTime()) || new Date(d.getTime()+10800000).toISOString().slice(0,10)!==value) throw fail('Неверная дата');
  return new Date(d.getTime()+(end?86400000:0)).toISOString();
}
export function landingHeatmapReport(params = new URLSearchParams()) {
  const campaign = params.get('campaign') || 'all', layout = params.get('layout') || 'mobile';
  if (!layouts.includes(layout)) throw fail('Неизвестный экран');
  if (campaign !== 'all' && campaign !== 'site-landing' && !db.prepare('SELECT 1 FROM acquisition_campaigns WHERE slug=?').get(campaign)) throw fail('Неизвестная кампания');
  const since = db.prepare("SELECT value FROM acquisition_metadata WHERE key='landing_heatmap_since'").get().value;
  const from = dateBoundary(params.get('from')) || since, to = dateBoundary(params.get('to'), true) || new Date().toISOString();
  if (from >= to) throw fail('Начало периода должно быть раньше конца');
  const exclusions = `NOT EXISTS (SELECT 1 FROM acquisition_starts s JOIN users u ON u.id=s.user_id WHERE s.click_token=v.click_token AND NOT (${analyticsUserCondition}))`;
  const scope = `v.opened_at>=? AND v.opened_at<? AND ${exclusions}` + (campaign==='all'?'':campaign==='site-landing'?' AND v.campaign IS NULL':' AND v.campaign=?');
  const args = [from,to,...analyticsExcludedIds,...(campaign==='all'||campaign==='site-landing'?[]:[campaign])];
  const sessions = db.prepare(`SELECT h.max_depth,h.visible_ms,h.dropped,h.pending,h.storage_error FROM landing_heatmap_sessions h JOIN landing_visits v ON v.id=h.visit_id WHERE ${scope} AND h.version=? AND h.layout=?`).all(...args,HEATMAP_VERSION,layout);
  const points = db.prepare(`SELECT e.section,e.target,e.x,e.y,COUNT(*) clicks,COUNT(DISTINCT e.visit_id) visits FROM landing_heatmap_events e JOIN landing_visits v ON v.id=e.visit_id WHERE ${scope} AND e.version=? AND e.layout=? AND e.kind='click' GROUP BY e.section,e.target,e.x,e.y ORDER BY clicks DESC`).all(...args,HEATMAP_VERSION,layout);
  return { version:HEATMAP_VERSION, campaign, layout, since, from, to, generatedAt:new Date().toISOString(), visits:sessions.length,
    clicks:points.reduce((n,p)=>n+p.clicks,0), points, sections:HEATMAP_SECTIONS,
    scroll:Array.from({length:11},(_,i)=>({depth:i*10,visits:sessions.filter(s=>s.max_depth>=i*10).length})),
    visibleMs:sessions.length?Math.round(sessions.reduce((n,s)=>n+s.visible_ms,0)/sessions.length):null,
    dropped:sessions.reduce((n,s)=>n+s.dropped,0), pending:sessions.reduce((n,s)=>n+s.pending,0), storageErrors:sessions.filter(s=>s.storage_error).length };
}
export function landingHeatmapPreview(publicDir) {
  return fs.readFileSync(path.join(publicDir,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/\s(?:href|action)="(?!\/[^\"]+\.css)[^\"]*"/gi,'').replace('</head>','<style>html{scroll-behavior:auto!important}.lp-header{position:static!important}*,*::before,*::after{animation:none!important;transition:none!important}#landing{display:block!important}body{pointer-events:none!important}.lp-flow-row,.lp-artifact{opacity:1!important;transform:none!important}</style></head>');
}
