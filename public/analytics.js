(() => {
  const version = 'product-1', publicMode = location.pathname.startsWith('/recipes');
  const key = publicMode ? 'recipe-public-analytics-v1' : 'recipe-private-analytics-v1';
  let stored = {}, queue = [], user = null, busy = false, timer, dropped = 0, storageError = false;
  try { stored = JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { storageError = true; }
  const visitor = /^[\w-]{16,80}$/.test(stored.visitor || '') ? stored.visitor : crypto.randomUUID();
  queue = Array.isArray(stored.queue) ? stored.queue.slice(-80) : [];
  dropped = Number.isSafeInteger(stored.dropped) ? stored.dropped : 0;
  let activeStep = publicMode ? 'catalog' : 'boot';
  const auth = () => window.RecipePlatform?.authHeader?.() || `tma ${window.Telegram?.WebApp?.initData || ''}`;
  function save() {
    try { sessionStorage.setItem(key, JSON.stringify({visitor,queue,dropped,user:user||stored.user||null})); } catch { storageError = true; }
  }
  function schedule(delay = 300) { clearTimeout(timer); timer = setTimeout(flush, delay); }
  function enqueue(event, step = activeStep, extra = {}) {
    if (!publicMode && !user && !['client_error','screen_view','telemetry_health'].includes(event)) return;
    if (queue.length >= 80) { queue.shift(); dropped++; }
    queue.push({ id:crypto.randomUUID(), event, step, version, session:visitor, ...extra, queuedAt:Date.now(), attempts:0 });
    save(); schedule();
  }
  async function flush() {
    if (busy || !queue.length || navigator.onLine === false) return;
    busy = true;
    const expired = queue.filter(r => Date.now()-r.queuedAt > 86400000);
    dropped += expired.length; queue = queue.filter(r => Date.now()-r.queuedAt <= 86400000);
    const anonymous = publicMode || !user;
    const batch = queue.filter(r=>!anonymous || (!r.receipt && (publicMode || ['client_error','telemetry_health'].includes(r.event)))).slice(0,20);
    if(!batch.length){busy=false;return;}
    batch.forEach(r => r.attempts++); save();
    try {
      // Signed recipe receipts retain their original ID across retries and page reloads.
      for (const r of batch.filter(r => r.receipt)) {
        const response = await fetch('/api/engagement', {method:'POST',headers:{authorization:auth(),'content-type':'application/json'},body:JSON.stringify(r.receipt),signal:AbortSignal.timeout(5000)});
        if (!response.ok) {
          if ([400,403].includes(response.status)) { queue=queue.filter(q=>q.id!==r.id); dropped++; }
          else throw new Error('receipt');
        } else {queue=queue.filter(q=>q.id!==r.id);if(r.attempts>1)enqueue('telemetry_receipt','recipe',{recoveredAttempts:r.attempts});}
      }
      const events = batch.filter(r=>!r.receipt).map(({queuedAt, ...r})=>({...r,ageMs:Math.min(86400000,Date.now()-queuedAt)}));
      if(events.length) {
        const response=await fetch(anonymous?'/api/analytics/public':'/api/analytics',{method:'POST',headers:{'content-type':'application/json','x-analytics-request':'1',...(!anonymous?{authorization:auth()}: {})},body:JSON.stringify({visitor,events}),signal:AbortSignal.timeout(5000)});
        if(!response.ok) { if(response.status===400) { dropped+=events.length; const ids=new Set(events.map(r=>r.id));queue=queue.filter(r=>!ids.has(r.id)); } throw new Error('telemetry'); }
        const result=await response.json(); const accepted=new Set(result.accepted || []);queue=queue.filter(r=>!accepted.has(r.id));
      }
    } catch { /* Retained for bounded retry; health reports expose pending/dropped counts. */ }
    finally { busy=false;save();if(queue.length)schedule(Math.min(60000,1000*2**Math.min(batch[0]?.attempts||1,6))); }
  }
  function health() {
    enqueue('telemetry_health', activeStep, {pending:queue.length,dropped,code:storageError?'storage':'queue'});
  }
  function visible(element) {
    if(!element?.isConnected||document.visibilityState!=='visible')return false;
    const r=element.getBoundingClientRect(),s=getComputedStyle(element);
    const l=Math.max(0,r.left),t=Math.max(0,r.top),right=Math.min(innerWidth,r.right),bottom=Math.min(innerHeight,r.bottom);
    return s.visibility==='visible'&&Number(s.opacity)!==0&&right>l&&bottom>t&&element.contains(document.elementFromPoint((l+right)/2,(t+bottom)/2));
  }
  const watched=new Map();
  function observe(element,event,step,extra={}) { if(element){watched.set(element,{event,step,extra});requestAnimationFrame(check);} }
  function check() { for(const [element,entry] of watched){if(!element.isConnected){watched.delete(element);continue;}if(visible(element)){const {_started,...extra}=entry.extra;if(_started)extra.durationMs=Math.min(86400000,Date.now()-_started);enqueue(entry.event,entry.step,extra);watched.delete(element);}} }
  function setUser(id) {
    if(!id)return;
    if(stored.user && stored.user!==String(id)){queue=[];dropped=0;}
    user=String(id);stored.user=user;save();health();schedule();
  }
  function receipt(entry) {
    if(!queue.some(r=>r.id===entry.eventId)) {
      if(queue.length>=80){queue.shift();dropped++;}
      queue.push({id:entry.eventId,receipt:entry,queuedAt:Date.now(),attempts:0});save();schedule();
    }
    return Promise.resolve();
  }
  const pendingRequests=new Map();
  function requestStarted(id,step){pendingRequests.clear();pendingRequests.set(id,{step,at:Date.now()});}
  function requestVisible(element,id,preview=false){const r=pendingRequests.get(id);if(r){observe(element,preview?'request_preview_visible':'request_visible',r.step,{flowId:id,_started:r.at});pendingRequests.delete(id);}}
  window.RecipeAnalytics={event:enqueue,observe,visible,setUser,receipt,requestStarted,requestVisible,step(value){activeStep=value;},health};
  window.addEventListener('online',()=>schedule(0));
  document.addEventListener('visibilitychange',()=>{check();if(document.visibilityState==='visible'){health();schedule(0);}});
  document.addEventListener('scroll',check,true);window.addEventListener('resize',check);
  document.addEventListener('transitionend',check,true);document.addEventListener('animationend',check,true);
  window.addEventListener('error',()=>enqueue('client_error',activeStep,{code:'script'}));
  window.addEventListener('unhandledrejection',()=>enqueue('client_error',activeStep,{code:'promise'}));
  setInterval(health,60000);
  if(publicMode){health();schedule();}
})();
