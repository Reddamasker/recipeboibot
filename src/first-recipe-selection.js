import {db} from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS first_recipe_selections (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 recipe_id TEXT NOT NULL, recipe_key TEXT, selected_id TEXT,
 title TEXT NOT NULL, image_url TEXT, source TEXT NOT NULL,
 recipe_json TEXT NOT NULL, selected_at TEXT NOT NULL, unlocked_at TEXT
)`);

export function selectionRecord(userId){return db.prepare('SELECT * FROM first_recipe_selections WHERE user_id=?').get(userId)||null;}
export function selectionMetadata(userId){const row=selectionRecord(userId);return row?{recipeId:row.recipe_id,title:row.title,imageUrl:row.image_url||null,selectedId:row.selected_id||null,source:row.source,unlocked:Boolean(row.unlocked_at)}:null;}
export function stageSelection(userId,{recipe,recipeId,recipeKey,selectedId,source='request',imageUrl}){
 if(!recipe||!String(recipeId||recipe.id||''))return null;
 const row=selectionRecord(userId);
 if(row){
  // A retry may materialize the same chosen recipe as a saved UUID. Never replace a choice.
  if(!row.unlocked_at&&selectedId&&row.selected_id===selectedId&&recipeId&&row.recipe_id!==recipeId)db.prepare('UPDATE first_recipe_selections SET recipe_id=? WHERE user_id=?').run(String(recipeId),userId);
  return selectionMetadata(userId);
 }
 db.prepare('INSERT INTO first_recipe_selections(user_id,recipe_id,recipe_key,selected_id,title,image_url,source,recipe_json,selected_at) VALUES(?,?,?,?,?,?,?,?,?)')
 .run(userId,String(recipeId||recipe.id),String(recipeKey||recipe.id||recipeId),selectedId||null,String(recipe.title||'Выбранный рецепт'),imageUrl||recipe.imageUrl||recipe.thumbnailUrl||null,source,JSON.stringify(recipe),new Date().toISOString());
 return selectionMetadata(userId);
}
export function unlockSelection(userId,at=new Date()){
 db.prepare('UPDATE first_recipe_selections SET unlocked_at=? WHERE user_id=? AND unlocked_at IS NULL').run(at.toISOString(),userId);
 return selectionMetadata(userId);
}
export function previewRecipe(recipe){
 if(!recipe||typeof recipe!=='object')return recipe;
 const preview={};for(const key of ['id','title','imageUrl','thumbnailUrl','servings','prepMinutes','cookMinutes','status'])if(recipe[key]!==undefined)preview[key]=recipe[key];
 return {...preview,previewOnly:true};
}
export function redactRecipeData(value){
 if(Array.isArray(value))return value.map(redactRecipeData);
 if(!value||typeof value!=='object')return value;
 if(Array.isArray(value.ingredients)||Array.isArray(value.steps))return previewRecipe(value);
 const copy={};for(const [key,child] of Object.entries(value)){
  if(['pantryMatch','pantryCoverage','ingredientText','sourceText','pitch','reasons'].includes(key))continue;
  copy[key]=redactRecipeData(child);
 }
 return copy;
}
