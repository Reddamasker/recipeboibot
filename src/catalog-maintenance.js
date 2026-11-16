// Trusted maintenance CLI. It never starts polling, changes a user's recipe,
// or accepts a request from the public HTTP API.
import { db, generatedCatalog } from './db.js';
import { config } from './config.js';
import { publicCatalogRecipes } from './public-catalog.js';
import { reviewCatalogCandidate } from './catalog-review.js';
import { reviewPublicCatalogRecipe } from './openai.js';
import { readCatalogInput } from './generated-catalog.js';

const action=process.argv[2];
const input=()=>readCatalogInput(process.stdin);
function scan(history=false){
  if(config.testContour)return;
  const since=history?'1970-01-01':db.prepare("SELECT value FROM generated_catalog_meta WHERE key='since'").get().value;
  const rows=history?db.prepare("SELECT r.title,r.description,r.servings,r.prep_minutes,r.cook_minutes,r.ingredients_json,r.steps_json,r.tags_json FROM recipes r JOIN users u ON u.id=r.user_id WHERE r.origin='generated' AND r.source_type='generated' AND r.created_at>=?").all(since):[];
  for(const r of rows)generatedCatalog.enqueue(config.botPlatform,{...r,prepMinutes:r.prep_minutes,cookMinutes:r.cook_minutes,ingredients:JSON.parse(r.ingredients_json),steps:JSON.parse(r.steps_json),tags:JSON.parse(r.tags_json)},'generated');
  // Recover a missed queue write without importing historical unsaved suggestions.
  const rollout=db.prepare("SELECT value FROM generated_catalog_meta WHERE key='since'").get().value;
  for(const r of db.prepare("SELECT s.recipe_json FROM recipe_suggestions s JOIN users u ON u.id=s.user_id WHERE s.created_at>=? AND u.telegram_id NOT LIKE '%private-test%' AND u.telegram_id NOT LIKE '%preview%' AND u.telegram_id NOT LIKE '%sandbox%'").all(rollout))generatedCatalog.enqueue(config.botPlatform,JSON.parse(r.recipe_json),'generated');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='dinner_options'").get())for(const r of db.prepare("SELECT o.option_json FROM dinner_options o JOIN users u ON u.id=o.user_id WHERE o.created_at>=? AND json_extract(o.option_json,'$.method')='generated' AND u.telegram_id NOT LIKE '%private-test%' AND u.telegram_id NOT LIKE '%preview%' AND u.telegram_id NOT LIKE '%sandbox%'").all(rollout))generatedCatalog.enqueue(config.botPlatform,JSON.parse(r.option_json).recipe,'generated');
}
try {
  if(action==='scan'||action==='backfill'){scan(action==='backfill');console.log(JSON.stringify(generatedCatalog.exportCandidates()));}
  else if(action==='ingest'){generatedCatalog.ingest(await input());console.log(JSON.stringify({ok:true}));}
  else if(action==='ack'){generatedCatalog.acknowledge(await input());console.log(JSON.stringify({ok:true}));}
  else if(action==='snapshot')console.log(JSON.stringify(generatedCatalog.snapshot()));
  else if(action==='apply'){generatedCatalog.applySnapshot(await input());console.log(JSON.stringify({ok:true,count:generatedCatalog.read().length}));}
  else if(action==='report')console.log(JSON.stringify({report:generatedCatalog.report(),outcomes:db.prepare('SELECT platform,json_extract(recipe_json,\'$.title\') AS title,state,reason,duplicate_id,attempts FROM generated_catalog_candidates ORDER BY created_at,id').all()}));
  else if(action==='review'){
    const limit=Math.min(200,Math.max(1,Number(process.argv[3])||4));
    for(const row of generatedCatalog.pending().slice(0,limit)){
      const started=Date.now();
      try{
        const result=await reviewCatalogCandidate(JSON.parse(row.recipe_json),publicCatalogRecipes(),reviewPublicCatalogRecipe);
        db.exec('SAVEPOINT catalog_review');
        try{
          if(result.state==='published')generatedCatalog.publish(row,result.recipe);
          generatedCatalog.finish(row.id,result.state,{reason:result.reason,duplicateId:result.duplicateId,elapsed:Date.now()-started});
          db.exec('RELEASE catalog_review');
        }catch(e){db.exec('ROLLBACK TO catalog_review');db.exec('RELEASE catalog_review');throw e;}
        console.log(JSON.stringify({id:row.id,state:result.state,reason:result.reason}));
      }catch{
        generatedCatalog.finish(row.id,'error',{reason:'review_unavailable',elapsed:Date.now()-started});
        console.error('generated_catalog_review_failed');
      }
    }
  } else throw Error('Expected scan|backfill|ingest|review|snapshot|apply|report');
}finally{db.close();}
