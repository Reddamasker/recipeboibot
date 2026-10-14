import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const validSecret = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
export function createWebLoginStore(db, { ownerId, now = Date.now, requestTtl = 300000, sessionTtl = 1800000 }) {
  ownerId = String(ownerId || '');
  if (!/^[1-9]\d{0,18}$/.test(ownerId || '')) throw Error('Explicit MAX prototype owner required');
  if (![requestTtl,sessionTtl].every(ttl=>Number.isSafeInteger(ttl)&&ttl>0&&ttl<=604800000)) throw Error('Invalid prototype lifetime');
  db.exec(`CREATE TABLE IF NOT EXISTS web_login_prototype_requests (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, diagnostic_id TEXT NOT NULL UNIQUE, browser_hash TEXT NOT NULL,
    bot_hash TEXT UNIQUE, compare_code TEXT NOT NULL, state TEXT NOT NULL,
    message_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    delivered_at INTEGER, decided_at INTEGER, completed_at INTEGER, decision TEXT);
    CREATE INDEX IF NOT EXISTS web_login_prototype_browser ON web_login_prototype_requests(browser_hash);
    CREATE TABLE IF NOT EXISTS web_login_prototype_sessions (secret_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS web_login_prototype_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS web_login_prototype_events (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, event TEXT NOT NULL, code TEXT, created_at INTEGER NOT NULL);
  `);
  // Legacy requests have no verified owner binding: preserve history, never claim them.
  for (const [table,column,type] of [['web_login_prototype_requests','owner_id','TEXT'],['web_login_prototype_requests','decision','TEXT'],['web_login_prototype_events','owner_id','TEXT']]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result=fn();db.exec('COMMIT');return result; }
    catch(error) { db.exec('ROLLBACK');throw error; }
  }
  transaction(()=>{
    db.prepare("UPDATE web_login_prototype_requests SET decision=CASE WHEN state='denied' THEN 'denied' ELSE 'approved' END WHERE decision IS NULL AND decided_at IS NOT NULL").run();
    db.prepare("UPDATE web_login_prototype_requests SET state='cancelled',bot_hash=NULL WHERE (owner_id IS NULL OR owner_id<>?) AND state IN ('pending','offered','approved')").run(ownerId);
    db.prepare('DELETE FROM web_login_prototype_sessions WHERE owner_id<>?').run(ownerId);
    db.prepare("INSERT INTO web_login_prototype_meta(key,value) VALUES('owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(ownerId);
    db.prepare('INSERT OR IGNORE INTO web_login_prototype_meta VALUES(?,?)').run('since:'+ownerId,new Date(now()).toISOString());
  });
  function assertOwner() {
    if (db.prepare("SELECT value FROM web_login_prototype_meta WHERE key='owner'").get()?.value!==ownerId) throw failure('Владелец прототипа изменён',403);
  }
  function clean() {
    assertOwner();
    db.prepare("UPDATE web_login_prototype_requests SET state='expired',bot_hash=NULL WHERE owner_id=? AND state IN ('pending','offered','approved') AND expires_at<=?").run(ownerId,now());
    db.prepare('DELETE FROM web_login_prototype_sessions WHERE owner_id=? AND expires_at<=?').run(ownerId,now());
    // The prototype keeps a bounded seven-day diagnostic window, without credentials.
    db.prepare('DELETE FROM web_login_prototype_requests WHERE owner_id=? AND created_at<?').run(ownerId,now() - 604800000);
    db.prepare('DELETE FROM web_login_prototype_events WHERE owner_id=? AND created_at<?').run(ownerId,now() - 604800000);
  }
  const browserRequest = browser => validSecret(browser) ? db.prepare('SELECT * FROM web_login_prototype_requests WHERE owner_id=? AND browser_hash=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(ownerId,hash(browser)) : null;
  function state(browser) {
    clean(); const row = browserRequest(browser);
    return row ? { state: row.state, code: row.compare_code, expiresAt: row.expires_at } : { state: 'none' };
  }
  return {
    begin(previousBrowser) {
      return transaction(()=>{
        clean();
        if (validSecret(previousBrowser)) db.prepare("UPDATE web_login_prototype_requests SET state='cancelled',bot_hash=NULL WHERE owner_id=? AND browser_hash=? AND state IN ('pending','offered','approved')").run(ownerId,hash(previousBrowser));
        const browser = secret(), bot = secret(), id = randomUUID(), code = String(randomInt(100000, 1000000)), createdAt=now(), expiresAt=createdAt+requestTtl;
        db.prepare('INSERT INTO web_login_prototype_requests(id,owner_id,diagnostic_id,browser_hash,bot_hash,compare_code,state,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(id,ownerId,randomUUID(),hash(browser),hash(bot),code,'pending',createdAt,expiresAt);
        return {browser,bot,state:'pending',code,expiresAt};
      });
    },
    state,
    // Called only on authenticated MAX ingress. Never persist the deep-link token.
    resolveBotToken(token, actor) {
      clean(); if (String(actor) !== ownerId || !validSecret(token)) return null;
      const row = db.prepare("SELECT id FROM web_login_prototype_requests WHERE owner_id=? AND bot_hash=? AND state='pending'").get(ownerId,hash(token));
      return row?.id || null;
    },
    prompt(id, actor) {
      clean(); if (String(actor) !== ownerId) return null;
      const row = db.prepare("SELECT * FROM web_login_prototype_requests WHERE owner_id=? AND id=? AND state='pending'").get(ownerId,id);
      return row ? { id: row.id, code: row.compare_code } : null;
    },
    delivered(id, actor, messageId) {
      clean(); if (String(actor) !== ownerId || !messageId) return false;
      return Boolean(db.prepare("UPDATE web_login_prototype_requests SET state='offered',message_id=?,delivered_at=?,bot_hash=NULL WHERE owner_id=? AND id=? AND state='pending'").run(String(messageId),now(),ownerId,id).changes);
    },
    decide(id, actor, messageId, approved) {
      clean(); if (String(actor) !== ownerId || typeof approved !== 'boolean') return false;
      const decision=approved?'approved':'denied';
      return Boolean(db.prepare("UPDATE web_login_prototype_requests SET state=?,decision=?,decided_at=? WHERE owner_id=? AND id=? AND state='offered' AND message_id=?").run(decision,decision,now(),ownerId,id,String(messageId)).changes);
    },
    finish(browser) {
      return transaction(()=>{
        clean();const row=browserRequest(browser);
        if (!row||row.state!=='approved')throw failure('Вход ещё не подтверждён или запрос истёк');
        const session=secret(),at=now(),expiresAt=at+sessionTtl;
        if (!db.prepare("UPDATE web_login_prototype_requests SET state='consumed',completed_at=?,browser_hash='',bot_hash=NULL WHERE owner_id=? AND id=? AND state='approved' AND expires_at>?").run(at,ownerId,row.id,at).changes)throw failure('Запрос уже использован');
        db.prepare('INSERT INTO web_login_prototype_sessions VALUES(?,?,?)').run(hash(session),ownerId,expiresAt);
        return {session,expiresAt};
      });
    },
    session(token) {
      clean(); if (!validSecret(token)) return null;
      const row = db.prepare('SELECT expires_at FROM web_login_prototype_sessions WHERE secret_hash=? AND owner_id=?').get(hash(token), ownerId);
      return row ? { authenticated: true, scope: 'prototype-only', expiresAt: row.expires_at } : null;
    },
    logout(token, browser) {
      clean();
      if (validSecret(token)) db.prepare('DELETE FROM web_login_prototype_sessions WHERE owner_id=? AND secret_hash=?').run(ownerId,hash(token));
      if (validSecret(browser)) db.prepare("UPDATE web_login_prototype_requests SET state='cancelled',bot_hash=NULL WHERE owner_id=? AND browser_hash=? AND state IN ('pending','offered','approved')").run(ownerId,hash(browser));
    },
    event({ id, event, code = null }) {
      assertOwner();
      if (!/^[a-f0-9-]{36}$/.test(id || '') || !['screen_view','login_clicked','result_view','client_error','queue_loss'].includes(event) || code !== null && !['success','denied','expired','network','http','storage','queue'].includes(code)) throw failure('Неверное событие',400);
      // Diagnostic failures never break login.
      try { db.prepare('INSERT OR IGNORE INTO web_login_prototype_events(id,owner_id,event,code,created_at) VALUES(?,?,?,?,?)').run(id,ownerId,event,code,now()); } catch {}
    },
    report() {
      clean(); const rows = db.prepare('SELECT state,decision,created_at,expires_at,delivered_at,decided_at,completed_at FROM web_login_prototype_requests WHERE owner_id=?').all(ownerId);
      const timing = values => { values.sort((a,b)=>a-b); return { samples:values.length,p50:values.length ? values[Math.ceil(values.length*.5)-1] : null,p95:values.length ? values[Math.ceil(values.length*.95)-1] : null }; };
      const counts = Object.fromEntries(['pending','offered','approved','denied','expired','cancelled','consumed'].map(s=>[s,rows.filter(r=>r.state===s).length]));
      const mature=rows.filter(r=>r.expires_at<=now());
      return { internalOnly:true,platform:'max',trackingSince:db.prepare('SELECT value FROM web_login_prototype_meta WHERE key=?').get('since:'+ownerId).value,windowDays:7,created:rows.length,delivered:rows.filter(r=>r.delivered_at!==null).length,approvedTotal:rows.filter(r=>r.decision==='approved'&&r.decided_at!==null).length,counts,
        completedMature:mature.filter(r=>r.state==='consumed').length,mature:mature.length,
        timing:{delivery:timing(rows.filter(r=>r.delivered_at!==null).map(r=>r.delivered_at-r.created_at)),decision:timing(rows.filter(r=>r.decided_at!==null).map(r=>r.decided_at-r.delivered_at)),completion:timing(rows.filter(r=>r.completed_at!==null).map(r=>r.completed_at-r.decided_at))},
        client:db.prepare('SELECT event,code,COUNT(*) count FROM web_login_prototype_events WHERE owner_id=? GROUP BY event,code').all(ownerId) };
    }
  };
}
