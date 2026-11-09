import { createHash, randomUUID } from 'node:crypto';

// Private operational state. Ingredient names and recipe contents belong here,
// never in product analytics. Ingredient/step/serving data is never modified.
export const WORKSPACE_ACTIONS = Object.freeze([
  'collections.create', 'collections.rename', 'collections.delete', 'collections.setRecipes', 'collections.saveCatalog',
  'collections.updateCard', 'collections.setPhoto', 'collections.removePhoto',
  'plan.add', 'plan.update', 'plan.delete', 'plan.apply',
  'groceries.addManual', 'groceries.updateManual', 'groceries.fromRecipe', 'groceries.fromPlan',
  'groceries.setChecked', 'groceries.removeItem', 'groceries.removeSource', 'groceries.clearChecked'
]);
const meals = new Set(['breakfast', 'lunch', 'dinner', 'snack']);
const planFields = ['kind', 'recipeId', 'note', 'date', 'meal', 'servings', 'cooked'];
const limit = { collections: 100, members: 1000, plan: 2000, manual: 500, sources: 500, ingredients: 400 };
const fields = {
  'collections.create': ['name', 'recipeIds'], 'collections.rename': ['collectionId', 'name'],
  'collections.delete': ['collectionId'], 'collections.setRecipes': ['collectionId', 'recipeIds'],
  'collections.saveCatalog': ['catalogId'],
  'collections.updateCard': ['recipeId', 'pinned', 'cooked', 'rating', 'notes', 'tags'],
  'collections.setPhoto': ['recipeId', 'mime', 'value'], 'collections.removePhoto': ['recipeId'],
  'plan.add': planFields, 'plan.update': ['entryId', ...planFields],
  'plan.delete': ['entryId'], 'plan.apply': ['entries'],
  'groceries.addManual': ['name', 'quantity', 'unit', 'amountText'],
  'groceries.updateManual': ['itemId', 'name', 'quantity', 'unit', 'amountText'],
  'groceries.fromRecipe': ['recipeId', 'servings', 'restoreExcluded'], 'groceries.fromPlan': ['entryIds', 'restoreExcluded'],
  'groceries.setChecked': ['itemId', 'checked'], 'groceries.removeItem': ['itemId'],
  'groceries.removeSource': ['sourceId'], 'groceries.clearChecked': []
};
const fail = (message, status = 400, code = 'INVALID_WORKSPACE_INPUT', extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const own = (value, key) => Object.hasOwn(value, key);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё', 'е').replace(/\s+/gu, ' ').trim();
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function text(value, label, max, required = true) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value) || value.length > max || (required && !value.trim())) throw fail(`Проверьте ${label}.`);
  return value.trim().replace(/\s+/gu, ' ');
}
function identifier(value, label = 'идентификатор') { return text(value, label, 100); }
function date(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw fail('Укажите существующую дату в формате ГГГГ-ММ-ДД.');
  return value;
}
function meal(value) { if (value == null) return null; if (!meals.has(value)) throw fail('Выберите приём пищи.'); return value; }
function planNote(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw fail('Введите заметку длиной от 1 до 2000 символов.');
  return value.trim().replace(/\r\n?/g, '\n');
}
// Defaults are applied only to the read model. Old stored recipe entries and
// their operation hashes remain intact until an actual edit is made.
function planView(row) {
  return { ...row, kind: row.kind ?? 'recipe', note: row.kind === 'note' ? row.note : null,
    meal: row.meal ?? null, cooked: row.cooked === true,
    ...(row.kind === 'note' ? { recipeId: null, servings: null } : {}) };
}
function quantity(value, optional = true) {
  if (value == null && optional) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw fail('Количество должно быть числом от 0 до 1000000.');
  return value;
}
function portions(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.25 || value > 100) throw fail('Число порций должно быть от 0,25 до 100.');
  return value;
}
const empty = () => ({ collections: [], plan: [], groceries: { manual: [], sources: [], checks: {} } });
const rounded = number => Math.round((number + Number.EPSILON) * 1e6) / 1e6;
function numericIngredient(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 && value <= 1_000_000 ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?$/.test(cleaned)) return numericIngredient(Number(cleaned));
  const fraction = cleaned.match(/^(\d+)\/(\d+)$/);
  if (fraction && Number(fraction[2]) > 0) return numericIngredient(Number(fraction[1]) / Number(fraction[2]));
  return null;
}
function unit(value) {
  const key = normalize(value).replace(/\.$/u, '');
  if (['г', 'гр', 'грамм', 'грамма', 'граммов', 'g', 'gram', 'grams'].includes(key)) return { key: 'mass', unit: 'г', factor: 1 };
  if (['кг', 'килограмм', 'килограмма', 'килограммов', 'kg'].includes(key)) return { key: 'mass', unit: 'г', factor: 1000 };
  if (['мл', 'миллилитр', 'миллилитра', 'миллилитров', 'ml'].includes(key)) return { key: 'volume', unit: 'мл', factor: 1 };
  if (['л', 'литр', 'литра', 'литров', 'l'].includes(key)) return { key: 'volume', unit: 'мл', factor: 1000 };
  if (['шт', 'штук', 'штука', 'штуки', 'pc', 'pcs'].includes(key)) return { key: 'count', unit: 'шт', factor: 1 };
  if (['ч. л', 'ч.л', 'ч л', 'чайная ложка', 'чайные ложки', 'чайных ложек', 'tsp'].includes(key)) return { key: 'teaspoon', unit: 'ч. л.', factor: 1 };
  if (['ст. л', 'ст.л', 'ст л', 'столовая ложка', 'столовые ложки', 'столовых ложек', 'tbsp'].includes(key)) return { key: 'tablespoon', unit: 'ст. л.', factor: 1 };
  // Unknown units are deliberately not converted; in particular cups, spoons,
  // packs and volume/mass are never guessed from a product name.
  return { key: 'unit:' + key, unit: String(value || '').trim(), factor: 1 };
}
function recipeIngredients(recipe, servings) {
  const base = typeof recipe.servings === 'number' && Number.isFinite(recipe.servings) && recipe.servings > 0 ? recipe.servings : null;
  if (servings != null && base == null) throw fail('В исходном рецепте не указано число порций. Добавьте ингредиенты без пересчёта.', 422, 'SERVINGS_UNKNOWN');
  const ratio = servings == null || base == null ? 1 : servings / base;
  if (!Array.isArray(recipe.ingredients) || !recipe.ingredients.length) throw fail('В рецепте нет списка ингредиентов.', 422, 'INGREDIENTS_MISSING');
  if (recipe.ingredients.length > limit.ingredients) throw fail('Слишком много ингредиентов в одном рецепте.', 413, 'WORKSPACE_LIMIT');
  return recipe.ingredients.map((raw, index) => {
    const item = typeof raw === 'string' ? { name: raw } : raw;
    if (!plain(item)) throw fail('Не удалось прочитать ингредиент рецепта.', 422, 'INGREDIENT_INVALID');
    const name = text(item.name || item.raw || '', 'название ингредиента', 250);
    const comment = typeof item.comment === 'string' ? item.comment.slice(0, 300).trim() : '';
    const original = numericIngredient(item.quantity), measure = unit(item.unit);
    const q = original == null ? null : rounded(original * ratio * measure.factor);
    if (q != null && (!Number.isFinite(q) || q > 1e9)) throw fail('Слишком большое количество ингредиента.', 422, 'QUANTITY_OVERFLOW');
    const amountText = q != null ? '' : typeof item.quantity === 'string' && item.quantity.trim() ? item.quantity.trim().slice(0, 100) : /по\s+вкусу/iu.test([item.raw, comment].filter(Boolean).join(' ')) ? 'по вкусу' : 'количество не указано';
    const key = hash(canonical([normalize(name), normalize(comment), measure.key]));
    return { index, key, exclusionKey: key + ':' + index, name, comment, quantity: q, unit: measure.unit, amountText };
  });
}

export function createRecipeWorkspace(db, { getRecipe = null, saveCatalogRecipe = null, cardStore = null, now = () => new Date().toISOString(), newId = randomUUID } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS recipe_workspaces (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0), data_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recipe_workspace_operations (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(user_id,operation_id)
  );`);
  const clock = () => { const value = now(); return new Date(value).toISOString(); };
  function requireUser(userId) {
    if (typeof userId !== 'string' || !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) throw fail('Профиль не найден.', 404, 'WORKSPACE_USER_NOT_FOUND');
  }
  function load(userId) {
    const row = db.prepare('SELECT * FROM recipe_workspaces WHERE user_id=?').get(userId);
    return row ? { version: row.version, state: JSON.parse(row.data_json), updatedAt: row.updated_at } : { version: 0, state: empty(), updatedAt: null };
  }
  function personalRecipe(userId, recipeId) {
    identifier(recipeId, 'рецепт');
    const row = db.prepare("SELECT * FROM recipes WHERE id=? AND user_id=? AND status='ready'").get(recipeId, userId);
    if (!row) throw fail('Рецепт не найден в вашей коллекции.', 404, 'RECIPE_NOT_FOUND');
    const supplied = getRecipe?.(userId, recipeId);
    if (supplied && typeof supplied.then === 'function') throw new Error('Workspace getRecipe must be synchronous');
    if (getRecipe && !supplied) throw fail('Рецепт недоступен.', 404, 'RECIPE_NOT_FOUND');
    return supplied || { ...row, ingredients: JSON.parse(row.ingredients_json), updatedAt: row.updated_at, thumbnailUrl: row.thumbnail_url || null };
  }
  function summary(userId, recipeId) {
    const row = db.prepare('SELECT * FROM recipes WHERE id=? AND user_id=?').get(recipeId, userId);
    return row && row.status === 'ready' ? { id: row.id, title: row.title, thumbnailUrl: row.thumbnail_url || null, servings: row.servings, updatedAt: row.updated_at } : null;
  }
  function shoppingItems(state) {
    const items = state.groceries.manual.map(row => ({ id: row.id, name: row.name, quantity: row.quantity, unit: row.unit, amountText: row.amountText,
      comment: '', manual: true, provenance: [{ kind: 'manual', sourceId: row.id, quantity: row.quantity, unit: row.unit }] }));
    const groups = new Map();
    for (const source of state.groceries.sources) {
      for (const ingredient of source.ingredients) {
        if (source.excluded.includes(ingredient.exclusionKey)) continue;
        // Unknown amounts remain separate; no 0 is invented or summed.
        const groupKey = ingredient.key + (ingredient.quantity == null ? ':' + source.id + ':' + ingredient.index : '');
        let item = groups.get(groupKey);
        if (!item) {
          item = { id: 'g-' + hash(groupKey).slice(0, 40), name: ingredient.name, quantity: ingredient.quantity == null ? null : 0,
            unit: ingredient.unit, amountText: ingredient.amountText, comment: ingredient.comment, manual: false, provenance: [] };
          groups.set(groupKey, item);
        }
        if (ingredient.quantity != null) item.quantity = rounded(item.quantity + ingredient.quantity);
        if (item.quantity != null && item.quantity > 1e9) throw fail('Суммарное количество слишком велико.', 422, 'QUANTITY_OVERFLOW');
        item.provenance.push({ kind: source.kind, sourceId: source.id, recipeId: source.recipeId, planEntryId: source.planEntryId,
          title: source.title, ingredientKey: ingredient.exclusionKey, quantity: ingredient.quantity, unit: ingredient.unit });
      }
    }
    items.push(...groups.values());
    return items.map(item => {
      const signature = hash(canonical([item.name, item.comment, item.quantity, item.unit, item.amountText]));
      const saved = state.groceries.checks[item.id];
      return { ...item, checked: Boolean(saved?.checked && saved.signature === signature), signature };
    });
  }
  function snapshot(userId, record) {
    const { state, version, updatedAt } = record, cached = new Map();
    const recipeSummary = id => { if (!cached.has(id)) cached.set(id, summary(userId, id)); return cached.get(id); };
    return { version, updatedAt, recipeCards: cardStore?.list(userId) || {},
      collections: state.collections.map(row => ({ ...row, recipeIds: row.recipeIds.filter(id => recipeSummary(id)) })),
      plan: state.plan.map(row => { const entry = planView(row), recipe = entry.kind === 'recipe' ? recipeSummary(entry.recipeId) : null;
        return { ...entry, recipe, recipeAvailable: Boolean(recipe) }; }).sort((a, b) => a.date.localeCompare(b.date) || [...meals].indexOf(a.meal) - [...meals].indexOf(b.meal) || a.createdAt.localeCompare(b.createdAt)),
      groceries: { items: shoppingItems(state).map(({ signature, ...item }) => item),
        sources: state.groceries.sources.map(({ ingredients, excluded, ...source }) => {
          const recipe = recipeSummary(source.recipeId);
          return { ...source, excludedCount: excluded.length, recipeAvailable: Boolean(recipe), stale: Boolean(recipe && recipe.updatedAt !== source.recipeUpdatedAt) };
        }) }
    };
  }
  function read(userId) { requireUser(userId); return snapshot(userId, load(userId)); }
  function memberRecipes(userId, value) {
    if (!Array.isArray(value) || value.length > limit.members) throw fail('Проверьте список рецептов подборки.');
    const ids = [...new Set(value.map(id => identifier(id, 'рецепт')))];
    ids.forEach(id => personalRecipe(userId, id)); return ids;
  }
  function found(rows, id, label) {
    identifier(id);
    const row = rows.find(item => item.id === id);
    if (!row) throw fail(`${label} не найден.`, 404, 'WORKSPACE_ITEM_NOT_FOUND');
    return row;
  }
  function nameAvailable(state, name, except = null) {
    if (state.collections.some(row => row.id !== except && normalize(row.name) === normalize(name))) throw fail('Подборка с таким названием уже существует.', 409, 'COLLECTION_NAME_EXISTS');
  }
  function planValues(userId, input, previous = null) {
    const old = previous ? planView(previous) : null, kind = own(input, 'kind') ? input.kind : old?.kind || 'recipe';
    if (!['recipe', 'note'].includes(kind)) throw fail('Выберите рецепт или заметку для меню.');
    if (own(input, 'cooked') && typeof input.cooked !== 'boolean') throw fail('Проверьте отметку приготовления.');
    const result = { kind, date: date(own(input, 'date') ? input.date : old?.date),
      meal: meal(own(input, 'meal') ? input.meal : old?.meal), recipeId: null, note: null, servings: null };
    if (kind === 'note') {
      if (own(input, 'recipeId') && input.recipeId !== null || own(input, 'servings') && input.servings !== null) throw fail('У заметки нет рецепта и числа порций.');
      result.note = planNote(own(input, 'note') ? input.note : old?.kind === 'note' ? old.note : undefined);
    } else {
      if (own(input, 'note') && input.note !== null) throw fail('Текст заметки доступен только записи типа «заметка».');
      result.recipeId = identifier(own(input, 'recipeId') ? input.recipeId : old?.recipeId, 'рецепт');
      const replaced = old?.kind !== 'recipe' || old.recipeId !== result.recipeId;
      // Moving or marking an existing entry does not read recipe contents.
      // New recipes and portion changes retain the existing ownership/read gate.
      const recipe = replaced || own(input, 'recipeId') || own(input, 'servings') ? personalRecipe(userId, result.recipeId) : null;
      result.servings = portions(own(input, 'servings') ? input.servings : replaced ? recipe.servings : old.servings);
      if (recipe && result.servings != null && !(Number.isFinite(recipe.servings) && recipe.servings > 0)) throw fail('В исходном рецепте не указано число порций.', 422, 'SERVINGS_UNKNOWN');
    }
    const replaced = old && (old.kind !== kind || old.recipeId !== result.recipeId);
    result.cooked = own(input, 'cooked') ? input.cooked : replaced ? false : old?.cooked || false;
    return result;
  }
  function planEntry(userId, input, timestamp) {
    if (!plain(input) || Object.keys(input).some(key => !planFields.includes(key))) throw fail('Проверьте запись меню.');
    return { id: newId(), ...planValues(userId, input), createdAt: timestamp, updatedAt: timestamp };
  }
  function putSource(state, userId, recipeId, servings, kind, entry, timestamp, restoreExcluded = false) {
    const recipe = personalRecipe(userId, recipeId), target = portions(servings ?? recipe.servings), id = kind + ':' + (entry?.id || recipeId);
    const ingredients = recipeIngredients(recipe, target), existing = state.groceries.sources.find(source => source.id === id);
    const source = { id, kind, recipeId, planEntryId: entry?.id || null, title: recipe.title,
      servings: target, baseServings: recipe.servings || null, recipeUpdatedAt: recipe.updatedAt || recipe.updated_at || null,
      ingredients, excluded: !restoreExcluded && existing?.recipeId === recipeId ? existing.excluded : [], updatedAt: timestamp };
    if (existing) Object.assign(existing, source); else state.groceries.sources.push(source);
    return source;
  }
  function removeItem(state, item) {
    if (item.manual) state.groceries.manual = state.groceries.manual.filter(row => row.id !== item.id);
    else for (const provenance of item.provenance) {
      const source = state.groceries.sources.find(row => row.id === provenance.sourceId);
      if (source && !source.excluded.includes(provenance.ingredientKey)) source.excluded.push(provenance.ingredientKey);
    }
    delete state.groceries.checks[item.id];
  }
  function manualInput(input, old = null) {
    const data = { ...old, ...input };
    const q = quantity(data.quantity);
    return { name: text(data.name, 'название продукта', 250), quantity: q,
      unit: text(data.unit ?? '', 'единицу измерения', 40, false), amountText: q != null ? '' : text(data.amountText ?? '', 'количество', 100, false) };
  }
  function execute(state, userId, input, timestamp) {
    const action = input.action;
    if (own(input, 'restoreExcluded') && typeof input.restoreExcluded !== 'boolean') throw fail('Проверьте восстановление исключённых продуктов.');
    if (['collections.updateCard', 'collections.setPhoto', 'collections.removePhoto'].includes(action)) {
      personalRecipe(userId, input.recipeId);
      if (!cardStore) throw fail('Настройки карточки недоступны.', 422, 'CARD_UNAVAILABLE');
      if (action === 'collections.setPhoto') return cardStore.setPhoto(userId, input.recipeId, { mime: input.mime, value: input.value });
      if (action === 'collections.removePhoto') return cardStore.removePhoto(userId, input.recipeId);
      return cardStore.update(userId, input.recipeId, Object.fromEntries(['pinned', 'cooked', 'rating', 'notes', 'tags'].filter(key => own(input, key)).map(key => [key, input[key]])));
    }
    if (action === 'collections.saveCatalog') {
      if (typeof input.catalogId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(input.catalogId)) throw fail('Проверьте рецепт каталога.');
      if (typeof saveCatalogRecipe !== 'function') throw fail('Сохранение из каталога недоступно.', 422, 'CATALOG_UNAVAILABLE');
      // The trusted callback must use this same database synchronously. Its
      // savepoint nests inside our transaction, so recipe/grant/idempotency
      // writes commit together. No editable recipe fields grant access.
      const before = db.prepare('SELECT total_changes() AS n').get().n;
      const saved = saveCatalogRecipe(userId, input.catalogId, { flowId: input.operationId });
      if (saved && typeof saved.then === 'function') throw new Error('Workspace saveCatalogRecipe must be synchronous');
      const recipe = personalRecipe(userId, saved?.recipe?.id);
      // Includes new catalog grants and restoring an archived copy, even when
      // the callback reuses an existing recipe and state JSON stays unchanged.
      return { count: 1, recipeId: recipe.id, changed: db.prepare('SELECT total_changes() AS n').get().n > before };
    }
    if (action === 'collections.create') {
      const name = text(input.name, 'название подборки', 100); nameAvailable(state, name);
      state.collections.push({ id: newId(), name, recipeIds: memberRecipes(userId, input.recipeIds || []), createdAt: timestamp, updatedAt: timestamp }); return 1;
    }
    if (action.startsWith('collections.')) {
      const row = found(state.collections, input.collectionId, 'Список');
      if (action === 'collections.rename') { const name = text(input.name, 'название подборки', 100); nameAvailable(state, name, row.id); if (name !== row.name) { row.name = name; row.updatedAt = timestamp; } }
      if (action === 'collections.setRecipes') { const ids = memberRecipes(userId, input.recipeIds); if (canonical(ids) !== canonical(row.recipeIds)) { row.recipeIds = ids; row.updatedAt = timestamp; } }
      if (action === 'collections.delete') state.collections = state.collections.filter(item => item !== row);
      return 1;
    }
    if (action === 'plan.add') { state.plan.push(planEntry(userId, Object.fromEntries(fields[action].filter(key => own(input, key)).map(key => [key, input[key]])), timestamp)); return 1; }
    if (action === 'plan.apply') {
      if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 60) throw fail('За один раз можно добавить от 1 до 60 записей меню.');
      const occupied = new Set(state.plan.map(row => row.date + ':' + (row.meal ?? null)));
      const entries = input.entries.map(row => {
        const entry = planEntry(userId, row, timestamp), slot = entry.date + ':' + entry.meal;
        if (occupied.has(slot)) throw fail('Этот приём пищи уже запланирован. Обновите предварительный план.', 409, 'PLAN_SLOT_OCCUPIED');
        occupied.add(slot); return entry;
      });
      state.plan.push(...entries); return entries.length;
    }
    if (action === 'plan.update' || action === 'plan.delete') {
      const row = found(state.plan, input.entryId, 'Запись меню');
      if (action === 'plan.delete') {
        state.plan = state.plan.filter(item => item !== row);
        state.groceries.sources = state.groceries.sources.filter(source => source.planEntryId !== row.id);
      } else {
        const previous = planView(row), values = planValues(userId, input, previous);
        const replaced = previous.kind !== values.kind || previous.recipeId !== values.recipeId;
        if (canonical(previous) !== canonical({ ...previous, ...values })) Object.assign(row, values, { updatedAt: timestamp });
        if (values.kind === 'note') state.groceries.sources = state.groceries.sources.filter(source => source.planEntryId !== row.id);
        else if ((replaced || own(input, 'servings')) && state.groceries.sources.some(source => source.planEntryId === row.id)) putSource(state, userId, row.recipeId, row.servings, 'plan', row, timestamp);
      }
      return 1;
    }
    if (action === 'groceries.addManual') {
      state.groceries.manual.push({ id: newId(), ...manualInput(input), createdAt: timestamp, updatedAt: timestamp }); return 1;
    }
    if (action === 'groceries.updateManual') {
      const row = found(state.groceries.manual, input.itemId, 'Ручной продукт');
      const next = manualInput(input, row);
      if (Object.keys(next).some(key => next[key] !== row[key])) Object.assign(row, next, { updatedAt: timestamp });
      return 1;
    }
    if (action === 'groceries.fromRecipe') { putSource(state, userId, input.recipeId, input.servings, 'recipe', null, timestamp, input.restoreExcluded); return 1; }
    if (action === 'groceries.fromPlan') {
      if (input.entryIds !== undefined && (!Array.isArray(input.entryIds) || input.entryIds.length > 60)) throw fail('Выберите не более 60 записей меню.');
      const selected = input.entryIds === undefined ? state.plan : [...new Set(input.entryIds)].map(id => found(state.plan, id, 'Запись меню'));
      if (selected.length > 60) throw fail('Выберите не более 60 записей меню.');
      const entries = selected.filter(entry => entry.kind !== 'note');
      if (selected.length && !entries.length) throw fail('В заметках нет ингредиентов. Выберите хотя бы один рецепт меню.', 422, 'PLAN_RECIPES_REQUIRED');
      for (const entry of entries) putSource(state, userId, entry.recipeId, entry.servings, 'plan', entry, timestamp, input.restoreExcluded);
      return entries.length;
    }
    if (action === 'groceries.removeSource') {
      const row = found(state.groceries.sources, input.sourceId, 'Источник');
      state.groceries.sources = state.groceries.sources.filter(item => item !== row); return 1;
    }
    if (action === 'groceries.clearChecked') {
      const checked = shoppingItems(state).filter(item => item.checked);
      checked.forEach(item => removeItem(state, item)); return checked.length;
    }
    const item = found(shoppingItems(state), input.itemId, 'Продукт');
    if (action === 'groceries.setChecked') {
      if (typeof input.checked !== 'boolean') throw fail('Проверьте отметку покупки.');
      state.groceries.checks[item.id] = { signature: item.signature, checked: input.checked };
    } else if (action === 'groceries.removeItem') removeItem(state, item);
    return 1;
  }
  function mutate(userId, input) {
    requireUser(userId);
    if (!plain(input) || !WORKSPACE_ACTIONS.includes(input.action)) throw fail('Неизвестное действие.');
    if (typeof input.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)) throw fail('Нужен UUID действия.');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) throw fail('Нужна текущая версия данных.');
    const allowed = new Set(['action', 'operationId', 'expectedVersion', ...fields[input.action]]);
    if (Object.keys(input).some(key => !allowed.has(key)) || Buffer.byteLength(JSON.stringify(input)) > (input.action === 'collections.setPhoto' ? 1_400_000 : 64000)) throw fail('Проверьте параметры действия.');
    const requestHash = hash(canonical(input));
    db.exec('BEGIN IMMEDIATE');
    try {
      if (cardStore?.hasQuestionOperation(userId, input.operationId)) throw fail('Идентификатор уже использован для вопроса.', 409, 'OPERATION_MISMATCH');
      const record = load(userId), prior = db.prepare('SELECT * FROM recipe_workspace_operations WHERE user_id=? AND operation_id=?').get(userId, input.operationId);
      if (prior) {
        if (prior.request_hash !== requestHash) throw fail('Идентификатор уже использован для другого действия.', 409, 'OPERATION_MISMATCH', { currentVersion: record.version });
        const response = { ...snapshot(userId, record), operation: { id: input.operationId, replayed: true, result: JSON.parse(prior.result_json) } };
        db.exec('COMMIT'); return response;
      }
      if (input.expectedVersion !== record.version) throw fail('Данные изменились в другом окне. Обновите экран и повторите действие.', 409, 'VERSION_CONFLICT', { currentVersion: record.version });
      const before = canonical(record.state), timestamp = clock();
      const outcome = execute(record.state, userId, input, timestamp);
      const count = typeof outcome === 'number' ? outcome : outcome.count;
      const state = record.state;
      if (state.collections.length > limit.collections || state.collections.some(row => row.recipeIds.length > limit.members) || state.plan.length > limit.plan || state.groceries.manual.length > limit.manual || state.groceries.sources.length > limit.sources) throw fail('Достигнут предел размера коллекции, меню или списка покупок.', 413, 'WORKSPACE_LIMIT');
      const currentItems = shoppingItems(state);
      state.groceries.checks = Object.fromEntries(currentItems.map(item => [item.id, { checked: item.checked, signature: item.signature }]));
      const changed = before !== canonical(state) || Boolean(outcome?.changed), result = { changed, count,
        ...(outcome?.recipeId ? { recipeId: outcome.recipeId } : {}) };
      if (changed) {
        const serialized = JSON.stringify(state);
        if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) throw fail('Рабочий список слишком велик.', 413, 'WORKSPACE_LIMIT');
        record.version++; record.updatedAt = timestamp;
        db.prepare(`INSERT INTO recipe_workspaces(user_id,version,data_json,updated_at) VALUES(?,?,?,?)
          ON CONFLICT(user_id) DO UPDATE SET version=excluded.version,data_json=excluded.data_json,updated_at=excluded.updated_at`).run(userId, record.version, serialized, timestamp);
      }
      db.prepare('INSERT INTO recipe_workspace_operations(user_id,operation_id,request_hash,result_json,created_at) VALUES(?,?,?,?,?)').run(userId, input.operationId, requestHash, JSON.stringify(result), timestamp);
      const response = { ...snapshot(userId, record), operation: { id: input.operationId, replayed: false, result } };
      db.exec('COMMIT'); return response;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return Object.freeze({ read, mutate });
}
