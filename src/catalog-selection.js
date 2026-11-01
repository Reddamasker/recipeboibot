// Explicitly authorised catalogue selections; never message text or raw URLs.
const cuisines = ['everyday','italian','georgian','russian','ukrainian','belarusian','greek','indian','hungarian','japanese','chinese','uzbek','lebanese','turkish'];
const categories = ['noodles','rice','pasta','soup','salad','baking','chicken','meat','fish','pizza','home'];
const keys = ['version','products','cuisine','query','minutes','category','excludedCount'];
const sensitive = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[^\s@]+@[^\s@]+\.[^\s@]+|\bBearer\s+|\bsk-[a-z0-9_-]{12,}|\b\d{5,}:[a-z0-9_-]{20,}|\b(?:token|password|secret|api[_-]?key)\s*[:=])/iu;
const text = (s,max) => typeof s==='string' && s.length<=max && s===s.trim() && !/[\u0000-\u001f\u007f]/u.test(s);
export function catalogSelection(value) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==keys.length || Object.keys(value).some(k=>!keys.includes(k))
    || value.version!==1 || !Array.isArray(value.products) || value.products.length>12
    || value.products.some(p=>!text(p,80)||!p) || value.products.join(',').length>250 || !text(value.query,160)
    || value.cuisine!==null&&!cuisines.includes(value.cuisine) || value.category!==null&&!categories.includes(value.category)
    || value.minutes!==null&&(!Number.isSafeInteger(value.minutes)||value.minutes<1||value.minutes>1440)
    || !Number.isSafeInteger(value.excludedCount)||value.excludedCount<0||value.excludedCount>12)throw Object.assign(new Error('Неверные параметры подбора'),{status:400});
  const safe = s => sensitive.test(s)?'[скрыто]':s;
  return {version:1,products:value.products.map(safe),cuisine:value.cuisine,query:safe(value.query),minutes:value.minutes,category:value.category,excludedCount:value.excludedCount};
}
export function validCatalogSelection(value) {
  try { return JSON.stringify(catalogSelection(value))===JSON.stringify(Object.fromEntries(keys.map(k=>[k,value[k]]))); } catch { return false; }
}
