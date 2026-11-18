(() => {
  let revision = 0, activeRoot, refresh, timer;
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  const date = value => new Date(value).toLocaleString('ru-RU', { timeZone:'Europe/Moscow' });
  const clear = () => { revision++; clearTimeout(timer); if (activeRoot) activeRoot.replaceChildren(); activeRoot = null; refresh = null; };
  async function render(root, api, back) {
    const expanded = new Set([...root.querySelectorAll('details[open]')].map(el=>el.dataset.record));
    clear(); activeRoot = root; refresh = () => render(root,api,back); const current = revision;
    root.classList.remove('review-shell'); root.classList.add('import-failures');
    root.replaceChildren(); const main = node('main'), heading = node('h1','Ошибки импорта');
    const close = node('button','В коллекцию'); close.onclick = () => { clear(); root.classList.remove('import-failures'); back(); };
    const reload = node('button','Обновить'); reload.onclick = refresh;
    const status = node('p','Проверяем доступ…'); status.setAttribute('role','status');
    main.append(close,heading,node('p','Только владелец. Тексты хранятся 7 дней и удаляются автоматически. Время — московское.'),reload,status); root.append(main);
    if (document.visibilityState === 'hidden') { status.textContent = 'Откройте страницу для просмотра.'; return; }
    try {
      const data = await api('/api/owner/import-failures');
      if (current !== revision || document.visibilityState === 'hidden') return;
      status.textContent = `${data.platform === 'max' ? 'MAX' : 'Telegram'} · Записей: ${data.rows.length}. Начало сбора: ${date(data.counters.since)}.`;
      main.append(node('p',`Попыток с сохранённым текстом: ${data.counters.captured || 0}. Удалено по сроку: ${data.counters.expired || 0}. После успешного повтора: ${data.counters.resolved || 0}. По лимиту: ${data.counters.evicted || 0}.`));
      if (!data.rows.length) main.append(node('p','Неудачных импортов с сохранённым текстом пока нет. Старые тексты не восстанавливаются.'));
      for (const row of data.rows) {
        if (row.expiresAt <= Date.now()) continue;
        const card = node('details'), summary = node('summary',`${date(row.createdAt)} · ${row.source === 'miniapp' ? 'Форма приложения' : 'Чат'} · ${row.code}`);
        card.dataset.record = row.id; card.open = expanded.has(row.id);
        const remove = node('button','Удалить сейчас');
        remove.onclick = async () => {
          remove.disabled = true;
          try { await api('/api/owner/import-failures/'+encodeURIComponent(row.id),{method:'DELETE'}); if(current===revision) await render(root,api,back); }
          catch { if(current===revision) { status.textContent='Не удалось удалить. Повторите попытку.'; remove.disabled=false; } }
        };
        card.append(summary,node('p',`Попыток: ${row.attempts}. Последняя: ${date(row.lastAt)}. Удаление: ${date(row.expiresAt)}.`),node('pre',row.text));
        if (row.truncated) card.append(node('p',`Показаны первые ${data.maxTextChars} символов.`));
        card.append(remove); main.append(card);
      }
      const nearest = Math.min(...data.rows.map(r=>r.expiresAt),Date.now()+60000);
      timer = setTimeout(() => { if(current===revision) void render(root,api,back); },Math.max(1000,Math.min(60000,nearest-Date.now())));
    } catch (error) { if(current===revision) status.textContent=error.status===401?'Откройте раздел кнопкой из бота.':error.status===403?'Доступ только владельцу.':'Не удалось загрузить данные. Нажмите «Обновить».'; }
  }
  document.addEventListener('visibilitychange',()=>{
    if(!activeRoot)return;
    if(document.visibilityState==='hidden') { revision++; clearTimeout(timer); activeRoot.replaceChildren(node('p','Тексты скрыты.')); }
    else void refresh?.();
  });
  window.addEventListener('pagehide',clear);
  window.ImportFailuresView={render,clear};
})();
