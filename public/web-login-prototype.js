(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = '/api/web-login/prototype';
  const queue = [], queueLimit = 40;
  let eventTimer, eventBusy = false, eventFailures = 0, pollTimer, pollFailures = 0;
  let pending = null, botUrl = null, actionBusy = false, pollBusy = false;
  let screenRecorded = false, initialised = false, authenticated = false;
  let resultKey = null, lastErrorCode = null, deferredResult = null, requestVersion = 0;

  // Telemetry is intentionally memory-only. Retries retain the original event ID.
  function telemetry(event, code = null) {
    try {
      if (queue.length >= queueLimit) {
        queue.shift();
        if (!queue.some(item => item.event === 'queue_loss')) {
          if (queue.length >= queueLimit - 1) queue.shift();
          queue.push({id:crypto.randomUUID(), event:'queue_loss', code:'queue'});
        }
      }
      queue.push({id:crypto.randomUUID(), event, code});
      scheduleEvents(0);
    } catch { /* A telemetry failure must not affect login. */ }
  }
  function scheduleEvents(delay) {
    if (eventTimer || eventBusy || !queue.length || document.visibilityState !== 'visible') return;
    eventTimer = setTimeout(() => { eventTimer = null; void flushEvents(); }, delay);
  }
  async function flushEvents() {
    if (eventBusy || !queue.length || document.visibilityState !== 'visible') return;
    eventBusy = true;
    const item = queue[0];
    try {
      const response = await fetch(base + '/events', {method:'POST', credentials:'same-origin', headers:{'content-type':'application/json', 'X-Web-Login':'1'}, body:JSON.stringify(item), signal:AbortSignal.timeout(6000)});
      if (!response.ok) {
        if ([400,401,403,404].includes(response.status)) {
          const index = queue.indexOf(item); if (index >= 0) queue.splice(index,1);
        }
        throw new Error('telemetry');
      }
      const index = queue.indexOf(item); if (index >= 0) queue.splice(index,1);
      eventFailures = 0;
    } catch { eventFailures = Math.min(eventFailures + 1, 5); }
    finally { eventBusy = false; scheduleEvents(eventFailures ? Math.min(30000, 1000 * 2 ** eventFailures) : 100); }
  }
  async function api(path, method = 'GET') {
    let response;
    try {
      response = await fetch(base + path, {method, credentials:'same-origin', cache:'no-store', headers:{'X-Web-Login':'1', ...(method === 'POST' ? {'content-type':'application/json'} : {})}, ...(method === 'POST' ? {body:'{}'} : {}), signal:AbortSignal.timeout(10000)});
    } catch { throw Object.assign(new Error('network'), {code:'network'}); }
    if (!response.ok) throw Object.assign(new Error('http'), {code:'http', status:response.status});
    try { return await response.json(); } catch { throw Object.assign(new Error('http'), {code:'http'}); }
  }
  function clearError() { $('login-error').hidden = true; lastErrorCode = null; }
  function showError(error, message) {
    const code = error?.code === 'network' ? 'network' : 'http';
    $('login-error').textContent = message || (code === 'network' ? 'Не удалось связаться с сервером. Проверь соединение. Проверка повторится, когда вкладка будет видна.' : 'Сервер не завершил проверку. Попробуй ещё раз.');
    $('login-error').hidden = false;
    if (lastErrorCode !== code) telemetry('client_error', code);
    lastErrorCode = code;
  }
  function result(code) {
    const key = (pending?.code || 'session') + ':' + code;
    if (key === resultKey) return;
    if (document.visibilityState !== 'visible') { deferredResult = {key, code}; return; }
    resultKey = key; deferredResult = null; telemetry('result_view', code);
  }
  function setBusy(value) {
    actionBusy = value;
    for (const id of ['login-start','login-check-status','login-logout']) $(id).disabled = value;
  }
  function dateLabel(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}) : '';
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function schedulePoll(delay = 3000) {
    stopPolling();
    if (!pending || authenticated || document.visibilityState !== 'visible') return;
    pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, delay);
  }
  function ready(message = 'Начни проверку и подтверди её в боте MAX.') {
    pending = null; botUrl = null; authenticated = false; stopPolling();
    $('login-status').textContent = message;
    $('login-challenge').hidden = true; $('login-success').hidden = true;
    $('login-start').hidden = false; $('login-start').textContent = 'Начать проверку входа';
    $('login-start').className = 'button-primary';
    $('login-check-status').hidden = true; $('login-logout').hidden = true; $('login-poll-note').hidden = true;
  }
  function showPending(data) {
    if (typeof data.code !== 'string' || !/^[a-zA-Z0-9 -]{3,24}$/.test(data.code)) throw Object.assign(new Error('http'), {code:'http'});
    pending = {code:data.code, expiresAt:data.expiresAt}; authenticated = false;
    $('login-code').textContent = pending.code;
    const deadline = dateLabel(data.expiresAt);
    $('login-deadline').textContent = deadline ? 'Код действует до ' + deadline + '.' : 'Код действует ограниченное время.';
    $('login-status').textContent = 'Ждём подтверждения в MAX.';
    $('login-challenge').hidden = false; $('login-success').hidden = true;
    $('login-start').hidden = false; $('login-start').textContent = 'Получить новый код';
    $('login-start').className = 'button-secondary';
    $('login-open-max').hidden = !botUrl; $('login-resume-note').hidden = Boolean(botUrl);
    $('login-check-status').hidden = false; $('login-logout').hidden = true; $('login-poll-note').hidden = false;
    schedulePoll();
  }
  function showSuccess(data) {
    authenticated = true; botUrl = null; stopPolling();
    $('login-status').textContent = 'Подтверждение получено.';
    $('login-challenge').hidden = true; $('login-success').hidden = false;
    $('login-start').hidden = true; $('login-check-status').hidden = true; $('login-poll-note').hidden = true;
    $('login-logout').hidden = false;
    const deadline = dateLabel(data.expiresAt);
    $('login-session-deadline').textContent = deadline ? 'Сессия действует до ' + deadline + '.' : 'Сессия действует только для проверки входа.';
    clearError(); result('success'); pending = null;
  }
  function showTerminal(state) {
    result(state);
    ready(state === 'denied' ? 'Вход отклонён в MAX. Сессия браузера не открыта.' : 'Срок подтверждения истёк. Получи новый код.');
    $('login-start').textContent = 'Получить новый код'; $('login-start').className = 'button-primary';
    clearError();
  }
  async function finish(version) {
    setBusy(true);
    $('login-status').textContent = 'MAX подтвердил вход. Завершаем проверку…';
    try {
      const data = await api('/finish', 'POST');
      if (version !== requestVersion) return;
      if (data.authenticated !== true) throw Object.assign(new Error('http'), {code:'http'});
      showSuccess(data);
    } catch (error) {
      if (version !== requestVersion) return;
      // The session cookie may have been applied even when the finish response
      // was lost. The pending cookie is already gone in that case.
      try {
        const session = await api('/me');
        if (version !== requestVersion) return;
        if (session.authenticated === true && session.scope === 'prototype-only') { showSuccess(session); return; }
      } catch { /* Keep the original failure; a later status check can recover. */ }
      throw error;
    } finally { if (version === requestVersion) setBusy(false); }
  }
  async function applyStatus(data, version = requestVersion) {
    if (version !== requestVersion) return;
    if (data.state === 'approved') { await finish(version); return; }
    if (data.state === 'denied' || data.state === 'expired') { showTerminal(data.state); return; }
    if (data.state === 'pending' || data.state === 'offered') { showPending(data); return; }
    if (data.state === 'cancelled') {
      ready('Предыдущая проверка отменена. Получи новый код.');
      $('login-start').textContent = 'Получить новый код';
      return;
    }
    if (['consumed','idle','none','missing'].includes(data.state)) {
      const session = await api('/me');
      if (version !== requestVersion) return;
      if (session.authenticated === true && session.scope === 'prototype-only') showSuccess(session);
      else if (session.authenticated === false) ready(data.state === 'consumed' ? 'Эта проверка уже завершена. Начни новую.' : undefined);
      else throw Object.assign(new Error('http'), {code:'http'});
      return;
    }
    throw Object.assign(new Error('http'), {code:'http'});
  }
  async function poll() {
    if (pollBusy || actionBusy || !pending || document.visibilityState !== 'visible') { schedulePoll(); return; }
    pollBusy = true;
    const version = requestVersion;
    try { await applyStatus(await api('/status'), version); if (version === requestVersion) { pollFailures = 0; clearError(); } }
    catch (error) { if (version === requestVersion) { pollFailures = Math.min(pollFailures + 1, 4); showError(error); } }
    finally { pollBusy = false; if (version === requestVersion) schedulePoll(pollFailures ? Math.min(30000, 3000 * 2 ** pollFailures) : 3000); }
  }
  async function init() {
    if (actionBusy || document.visibilityState !== 'visible') return;
    const version = ++requestVersion;
    initialised = true; setBusy(true); clearError();
    try {
      const session = await api('/me');
      if (version !== requestVersion) return;
      if (session.authenticated === true && session.scope === 'prototype-only') showSuccess(session);
      else if (session.authenticated === false) await applyStatus(await api('/status'), version);
      else throw Object.assign(new Error('http'), {code:'http'});
    } catch (error) {
      ready('Проверка входа пока недоступна.');
      showError(error, error.status === 403 ? 'Этот технический прототип доступен только владельцу.' : undefined);
      $('login-check-status').hidden = false;
    } finally { setBusy(false); }
  }
  $('login-start').addEventListener('click', async () => {
    if (actionBusy) return;
    ++requestVersion;
    stopPolling(); setBusy(true); clearError(); telemetry('login_clicked');
    $('login-status').textContent = 'Готовим код для сравнения…';
    try {
      const data = await api('/start', 'POST');
      const destination = new URL(data.botUrl);
      if (data.state !== 'pending' || destination.protocol !== 'https:' || !(destination.hostname === 'max.ru' || destination.hostname.endsWith('.max.ru')) || destination.username || destination.password) throw Object.assign(new Error('http'), {code:'http'});
      botUrl = destination.href; resultKey = null; deferredResult = null; pollFailures = 0; showPending(data);
      $('login-code-title').focus({preventScroll:true});
    } catch (error) { showError(error); $('login-status').textContent = 'Новый код не получен. Попробуй ещё раз.'; }
    finally { setBusy(false); schedulePoll(); }
  });
  $('login-open-max').addEventListener('click', () => { if (botUrl) window.open(botUrl, '_blank', 'noopener,noreferrer'); });
  $('login-check-status').addEventListener('click', () => { if (pending) void poll(); else void init(); });
  $('login-logout').addEventListener('click', async () => {
    if (actionBusy) return;
    ++requestVersion;
    setBusy(true); clearError();
    try {
      const data = await api('/logout', 'POST');
      if (data.ok !== true) throw Object.assign(new Error('http'), {code:'http'});
      resultKey = null; deferredResult = null; ready('Ты вышел из прототипа.'); $('login-start').className = 'button-primary';
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  });
  function visible() {
    if (document.visibilityState !== 'visible') { stopPolling(); clearTimeout(eventTimer); eventTimer = null; return; }
    if (!screenRecorded) { screenRecorded = true; telemetry('screen_view'); }
    if (deferredResult && deferredResult.key !== resultKey) { resultKey = deferredResult.key; telemetry('result_view', deferredResult.code); deferredResult = null; }
    scheduleEvents(0);
    if (!initialised) void init(); else if (pending) schedulePoll(0);
  }
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', () => { pollFailures = 0; eventFailures = 0; schedulePoll(0); scheduleEvents(0); });
  visible();
})();
