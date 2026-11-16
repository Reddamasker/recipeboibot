import { randomBytes } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { maxLandingPayload } from './max-landing-acquisition.js';

// Reservations are not clicks. Keep them outside acquisition_clicks and the
// landing click columns until an actual click (or a Telegram start) arrives.
db.exec(`CREATE TABLE IF NOT EXISTS landing_direct_links (
 visit_id TEXT NOT NULL, platform TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
 prepared_at TEXT NOT NULL, received_at TEXT, recovered_at TEXT,
 delay_ms INTEGER, dropped INTEGER NOT NULL DEFAULT 0, storage_error INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(visit_id,platform)
);`);
const fail = (message, status=400) => Object.assign(new Error(message),{status});
const exists = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const username = () => config.testContour ? config.testBotUsername : 'Recipeboibot';
const maxUsername = () => /^[A-Za-z0-9_]{5,64}$/.test(config.maxBotUsername) ? config.maxBotUsername : 'id500912857935_bot';

export function prepareLandingLinks(visit) {
  const links={};
  for(const platform of ['telegram','max']) {
    const existingToken=platform==='telegram'?visit.click_token:visit.max_click_token;
    const token=existingToken||randomBytes(18).toString('base64url');
    const maxPayload=!config.testContour&&maxLandingPayload(visit.campaign||'site-landing',token);
    if(platform==='max'&&!maxPayload){links.max=`https://max.ru/${maxUsername()}?start=collection`;continue;}
    db.prepare('INSERT OR IGNORE INTO landing_direct_links(visit_id,platform,token,prepared_at) VALUES(?,?,?,?)')
      .run(visit.id,platform,token,new Date().toISOString());
    const reservation=db.prepare('SELECT * FROM landing_direct_links WHERE visit_id=? AND platform=?').get(visit.id,platform);
    links[platform]=platform==='telegram'?`https://t.me/${username()}?start=lp_${reservation.token}`:
      `https://max.ru/${maxUsername()}?start=${maxLandingPayload(visit.campaign||'site-landing',reservation.token)}`;
  }
  return links;
}

function saveClick(reservation, at, receivedAt, input={}) {
  const visit=db.prepare('SELECT * FROM landing_visits WHERE id=?').get(reservation.visit_id);
  if(!visit)throw fail('Посещение не найдено',404);
  const platform=reservation.platform, campaign=visit.campaign||'site-landing';
  db.exec('SAVEPOINT direct_landing_click');
  try {
    if(platform==='telegram') {
      db.prepare('INSERT OR IGNORE INTO acquisition_campaigns(slug,name,created_at) VALUES(?,?,?)').run(campaign,campaign,at);
      db.prepare('INSERT OR IGNORE INTO acquisition_clicks(token,campaign,created_at,tags_json) VALUES(?,?,?,?)')
        .run(reservation.token,campaign,at,visit.tags_json);
      db.prepare('UPDATE acquisition_clicks SET created_at=MIN(created_at,?) WHERE token=?').run(at,reservation.token);
    }
    const time=platform==='telegram'?'telegram_clicked_at':'max_clicked_at',token=platform==='telegram'?'click_token':'max_click_token';
    // A legacy cached page may already have clicked the same reserved token.
    if(visit[token]&&visit[token]!==reservation.token)throw fail('Метка перехода уже задана',409);
    db.prepare(`UPDATE landing_visits SET ${time}=CASE WHEN ${time} IS NULL OR ${time}>? THEN ? ELSE ${time} END,${token}=? WHERE id=?`)
      .run(at,at,reservation.token,visit.id);
    if(receivedAt&&!reservation.received_at) {
      db.prepare('UPDATE landing_direct_links SET received_at=?,delay_ms=?,dropped=?,storage_error=? WHERE visit_id=? AND platform=?')
        .run(receivedAt,Math.max(0,Date.parse(receivedAt)-Date.parse(at)),input.dropped||0,input.storageError||0,visit.id,platform);
    } else if(!receivedAt&&!reservation.recovered_at) {
      db.prepare('UPDATE landing_direct_links SET recovered_at=? WHERE visit_id=? AND platform=?').run(at,visit.id,platform);
    }
    db.exec('RELEASE direct_landing_click');
  }catch(error){db.exec('ROLLBACK TO direct_landing_click');db.exec('RELEASE direct_landing_click');throw error;}
}

export function recordDirectLandingClick(input,options={}) {
  if(!input||Object.keys(input).some(k=>!['visitId','platform','elapsedMs','dropped','storageError'].includes(k))||
    !/^[a-f0-9]{32}$/.test(input.visitId||'')||!['telegram','max'].includes(input.platform)||
    !Number.isSafeInteger(input.elapsedMs)||input.elapsedMs<0||input.elapsedMs>86400000||
    !Number.isInteger(input.dropped??0)||(input.dropped??0)<0||(input.dropped??0)>100000||![0,1].includes(input.storageError??0))throw fail('Неверное событие перехода');
  if(options.probe)return{ok:true,skipped:true};
  const row=db.prepare('SELECT * FROM landing_direct_links WHERE visit_id=? AND platform=?').get(input.visitId,input.platform);
  if(!row)throw fail('Ссылка не подготовлена',404);
  if(row.received_at)return{ok:true};
  const now=new Date().toISOString();
  // Use the server reservation clock plus browser monotonic elapsed time. A
  // delayed retry must not move the click past an already received bot start.
  const at=new Date(Math.min(Date.now(),Date.parse(row.prepared_at)+input.elapsedMs)).toISOString();
  saveClick(row,at,now,input);
  return{ok:true};
}

export function recoverDirectTelegramClick(token,at) {
  if(config.botPlatform!=='telegram'||!exists('landing_visits'))return;
  const row=db.prepare("SELECT * FROM landing_direct_links WHERE token=? AND platform='telegram'").get(token);
  if(row&&!row.received_at&&!row.recovered_at)saveClick(row,at.toISOString(),null);
}

export function directLandingDiagnostics(slug='all') {
  const where=slug==='all'?'':slug==='site-landing'?' AND v.campaign IS NULL':' AND v.campaign=?';
  return db.prepare(`SELECT d.platform,COUNT(*) prepared,COUNT(d.received_at) received,
    SUM(CASE WHEN d.recovered_at IS NOT NULL AND d.received_at IS NULL THEN 1 ELSE 0 END) recoveredWithoutReceipt,
    SUM(CASE WHEN d.delay_ms>5000 THEN 1 ELSE 0 END) delayed,SUM(d.dropped) dropped,SUM(d.storage_error) storageErrors
    FROM landing_direct_links d JOIN landing_visits v ON v.id=d.visit_id WHERE 1=1 ${where} GROUP BY d.platform`)
    .all(...(slug==='all'||slug==='site-landing'?[]:[slug]));
}
