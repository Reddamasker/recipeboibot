import { catalogProjection, exactCatalogDuplicate, publicationProblems } from './generated-catalog.js';

export async function reviewCatalogCandidate(candidate, catalog, review) {
  const original=catalogProjection(candidate), exact=exactCatalogDuplicate(original,catalog);
  if(exact)return {state:'duplicate',duplicateId:exact.id,reason:'same_dish'};
  const result=await review(original,catalog);
  if(!result||!['publish','duplicate','reject'].includes(result.decision))throw Error('Invalid catalog review');
  if(result.decision==='duplicate'){
    if(!catalog.some(r=>r.id===result.duplicateId))throw Error('Unknown duplicate');
    return {state:'duplicate',duplicateId:result.duplicateId,reason:'same_dish'};
  }
  if(result.decision==='reject')return {state:'rejected',reason:result.reason};
  if(!result.recipe||publicationProblems(result.recipe).length||result.recipe.warnings?.length)throw Error('Incomplete reviewed recipe');
  const recipe=catalogProjection(result.recipe), duplicate=exactCatalogDuplicate(recipe,catalog);
  if(duplicate)return {state:'duplicate',duplicateId:duplicate.id,reason:'same_dish'};
  return {state:'published',recipe,reason:result.reason};
}
