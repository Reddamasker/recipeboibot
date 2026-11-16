import { createHash } from 'node:crypto';
import { recipeNutrition } from './nutrition.js';

export const CATALOG_SCHEMA = 1;
const hash = text => createHash('sha256').update(text).digest('hex');
const now = () => new Date().toISOString();
const states = ['pending','published','duplicate','rejected','error'];
export const normalizedTitle = value => String(value || '').toLocaleLowerCase('ru').replaceAll('ё','е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const clean = (s, max) => typeof s === 'string' ? s.trim().slice(0,max) : '';
const sensitive = /https?:\/\/|www\.|[\w.+-]+@[\w.-]+\.[a-z]+|\bBearer\s|\bsk-[a-z0-9_-]{12,}|\p{Extended_Pictographic}/iu;

// Positive allowlist: never copy notes, prompts, source text, user IDs, URLs,
// private photos, attribution or personal profile constraints into publication.
export function catalogProjection(raw) {
  return {
    title: clean(raw?.title,160), description: clean(raw?.description,600),
    servings: raw?.servings, prepMinutes: raw?.prepMinutes, cookMinutes: raw?.cookMinutes,
    ingredients: Array.isArray(raw?.ingredients) ? raw.ingredients.slice(0,40).map(i=>({name:clean(i.name,120),quantity:i.quantity,unit:clean(i.unit,30),comment:clean(i.comment,200)})) : [],
    steps: Array.isArray(raw?.steps) ? raw.steps.slice(0,30).map((s,i)=>({position:i+1,text:clean(typeof s==='string'?s:s.text,1800)})) : [],
    tags: Array.isArray(raw?.tags) ? raw.tags.slice(0,12).map(t=>clean(t,50)).filter(Boolean) : [],
  };
}
export function publicationProblems(raw) {
  const r=catalogProjection(raw), problems=[];
  if(r.title.length<3 || !r.description)problems.push('incomplete');
  if(!Number.isInteger(r.servings)||r.servings<1||r.servings>30)problems.push('servings');
  if(![r.prepMinutes,r.cookMinutes].every(n=>Number.isInteger(n)&&n>=0&&n<=4320)||r.prepMinutes+r.cookMinutes<1)problems.push('timing');
  if(r.ingredients.length<2||r.ingredients.some(i=>!i.name||!Number.isFinite(i.quantity)||i.quantity<=0||!i.unit))problems.push('ingredients');
  if(r.steps.length<3||r.steps.some(s=>s.text.length<12))problems.push('steps');
  if(sensitive.test(JSON.stringify(r)))problems.push('private_or_invalid_text');
  if(!recipeNutrition(r))problems.push('nutrition');
  return [...new Set(problems)];
}
export function compositionKey(raw) {
  const r=catalogProjection(raw);
  return hash(JSON.stringify(r.ingredients.map(i=>[normalizedTitle(i.name),Math.round((i.quantity/(r.servings||1))*1000)/1000,normalizedTitle(i.unit)]).sort((a,b)=>a[0].localeCompare(b[0]))));
}
export function exactCatalogDuplicate(recipe, catalog) {
  const title=normalizedTitle(recipe.title), composition=compositionKey(recipe);
  return catalog.find(r=>normalizedTitle(r.title)===title||compositionKey(r)===composition) || null;
}
export function publicRecipe(recipe,id) {
  const safe=catalogProjection(recipe);
  return {...safe,id:`seed:${id}`,origin:'seed',sourceName:'Общая подборка «Твоих рецептов»',sourceUrl:null,thumbnailUrl:null,imageGenerated:false,userSaved:false,
    warnings:[],nutrition:recipeNutrition(safe)};
}
export function validateCatalogSnapshot(data) {
  if(data?.version!==CATALOG_SCHEMA||!Array.isArray(data.recipes)||data.recipes.length>10000||!data.report||data.report.version!==1||!Array.isArray(data.report.platforms))throw Error('Invalid catalog snapshot');
  const ids=new Set(), titles=new Set();
  for(const r of data.recipes){
    if(!/^community-[a-f0-9]{24}$/.test(r.id)||ids.has(r.id)||titles.has(normalizedTitle(r.recipe?.title))||publicationProblems(r.recipe).length)throw Error('Invalid catalog recipe');
    ids.add(r.id);titles.add(normalizedTitle(r.recipe.title));
  }
  if(data.report.platforms.length!==2||!['telegram','max'].every(p=>data.report.platforms.some(x=>x.platform===p)))throw Error('Invalid catalog report');
  for(const p of data.report.platforms){
    if(!Number.isFinite(Date.parse(p.since))||!states.every(s=>Number.isSafeInteger(p[s])&&p[s]>=0)||!Number.isSafeInteger(p.total)||p.total!==states.reduce((n,s)=>n+p[s],0)||!(p.meanReviewMs===null||Number.isFinite(p.meanReviewMs)&&p.meanReviewMs>=0))throw Error('Invalid catalog report');
  }
  if(!Number.isFinite(Date.parse(data.report.generatedAt)))throw Error('Invalid catalog report date');
  return data;
}
export function createGeneratedCatalogStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS generated_catalog_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS generated_catalog_candidates(
      id TEXT PRIMARY KEY,platform TEXT NOT NULL CHECK(platform IN ('telegram','max')),recipe_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',reason TEXT,duplicate_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL,review_ms INTEGER, next_attempt_at TEXT);
    CREATE INDEX IF NOT EXISTS generated_catalog_pending ON generated_catalog_candidates(state,next_attempt_at);
    CREATE TABLE IF NOT EXISTS generated_catalog_recipes(id TEXT PRIMARY KEY,title_key TEXT UNIQUE NOT NULL,recipe_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
  if(!db.prepare('PRAGMA table_info(generated_catalog_candidates)').all().some(c=>c.name==='forwarded_at'))db.exec('ALTER TABLE generated_catalog_candidates ADD COLUMN forwarded_at TEXT');
  db.prepare("INSERT OR IGNORE INTO generated_catalog_meta VALUES('since',?)").run(now());
  let cacheKey='',cache=[];
  const read=()=>{
    const key=db.prepare("SELECT value FROM generated_catalog_meta WHERE key='revision'").get()?.value||'';
    if(key!==cacheKey){cache=db.prepare('SELECT id,recipe_json FROM generated_catalog_recipes ORDER BY id').all().map(r=>publicRecipe(JSON.parse(r.recipe_json),r.id));cacheKey=key;}
    return cache;
  };
  function enqueue(platform,recipe,provenance) {
    if(!['telegram','max'].includes(platform)||provenance!=='generated')return false;
    const safe=catalogProjection(recipe), json=JSON.stringify(safe);
    if(!safe.title||!safe.ingredients.length||!safe.steps.length||json.length>20000)return false;
    const id=hash(`${platform}\0${json}`), at=now();
    if(db.prepare('SELECT 1 FROM generated_catalog_candidates WHERE id=?').get(id))return false;
    if(db.prepare("SELECT count(*) AS n FROM generated_catalog_candidates WHERE state IN ('pending','error') AND forwarded_at IS NULL").get().n>=10000)throw Error('Catalog queue full');
    return db.prepare('INSERT OR IGNORE INTO generated_catalog_candidates(id,platform,recipe_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,platform,json,at,at).changes>0;
  }
  function ingest(rows){
    if(!Array.isArray(rows)||rows.length>10000)throw Error('Invalid catalog candidates');
    for(const r of rows)enqueue(r.platform,r.recipe,'generated');
  }
  const pending=()=>db.prepare("SELECT * FROM generated_catalog_candidates WHERE state IN ('pending','error') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,id").all(now());
  function finish(id,state,{reason=null,duplicateId=null,elapsed=0}={}){
    if(!states.includes(state)||state==='pending')throw Error('Invalid review state');
    db.prepare('UPDATE generated_catalog_candidates SET state=?,reason=?,duplicate_id=?,review_ms=?,attempts=attempts+1,updated_at=?,next_attempt_at=? WHERE id=?')
      .run(state,reason,duplicateId,Math.max(0,Math.round(elapsed)),now(),state==='error'?new Date(Date.now()+3600000).toISOString():null,id);
  }
  function publish(candidate,recipe){
    if(publicationProblems(recipe).length)throw Error('Invalid reviewed recipe');
    const safe=catalogProjection(recipe),id=`community-${hash(JSON.stringify(safe)).slice(0,24)}`,at=now();
    db.prepare('INSERT OR IGNORE INTO generated_catalog_recipes(id,title_key,recipe_json,created_at) VALUES(?,?,?,?)').run(id,normalizedTitle(safe.title),JSON.stringify(safe),at);
    db.prepare("INSERT INTO generated_catalog_meta VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`${at}:${id}`);
    return id;
  }
  function report(){
    const since=db.prepare("SELECT value FROM generated_catalog_meta WHERE key='since'").get().value;
    return {version:1,generatedAt:now(),platforms:['telegram','max'].map(platform=>{
      const rows=db.prepare('SELECT state,count(*) AS n FROM generated_catalog_candidates WHERE platform=? GROUP BY state').all(platform);
      const values=Object.fromEntries(states.map(s=>[s,rows.find(r=>r.state===s)?.n||0]));
      const meanReviewMs=db.prepare('SELECT avg(review_ms) AS mean FROM generated_catalog_candidates WHERE platform=? AND review_ms IS NOT NULL').get(platform).mean;
      return {platform,since,...values,total:Object.values(values).reduce((a,b)=>a+b,0),meanReviewMs};
    })};
  }
  function snapshot(){return {version:1,recipes:db.prepare('SELECT id,recipe_json FROM generated_catalog_recipes ORDER BY id').all().map(r=>({id:r.id,recipe:JSON.parse(r.recipe_json)})),report:report()};}
  function applySnapshot(data){
    validateCatalogSnapshot(data);
    db.exec('SAVEPOINT catalog_replication');
    try{
      for(const row of data.recipes)db.prepare('INSERT INTO generated_catalog_recipes(id,title_key,recipe_json,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET title_key=excluded.title_key,recipe_json=excluded.recipe_json').run(row.id,normalizedTitle(row.recipe.title),JSON.stringify(catalogProjection(row.recipe)),now());
      // Replication is append-only: an incomplete or empty snapshot never erases cards.
      db.prepare("INSERT INTO generated_catalog_meta VALUES('revision',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(hash(JSON.stringify(data.recipes)));
      db.prepare("INSERT INTO generated_catalog_meta VALUES('report',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(data.report));
      db.exec('RELEASE catalog_replication');
    }catch(e){db.exec('ROLLBACK TO catalog_replication');db.exec('RELEASE catalog_replication');throw e;}
  }
  return {read,enqueue,ingest,pending,finish,publish,report,snapshot,applySnapshot,
    diagnostics:()=>{const saved=db.prepare("SELECT value FROM generated_catalog_meta WHERE key='report'").get();return saved?JSON.parse(saved.value):null;},
    acknowledge:ids=>{if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>!/^\w{64}$/.test(id)))throw Error('Invalid receipt');for(const id of ids)db.prepare('UPDATE generated_catalog_candidates SET forwarded_at=? WHERE id=?').run(now(),id);},
    exportCandidates:()=>db.prepare("SELECT id,platform,recipe_json FROM generated_catalog_candidates WHERE forwarded_at IS NULL AND state IN ('pending','error') ORDER BY created_at,id LIMIT 1000").all().map(r=>({id:r.id,platform:r.platform,recipe:JSON.parse(r.recipe_json)}))};
}
