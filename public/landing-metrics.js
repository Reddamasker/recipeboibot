(() => {
  const root = document.getElementById('landing');
  if (!root) return;
  let sent = false;
  const key='recipe-landing-clicks-v1';
  let queue=[],busy=false,timer,attempts=0,dropped=0,storageError=0;
  const visible=()=>document.visibilityState==='visible'&&!root.hidden&&root.getClientRects().length&&!window.__miniLaunch&&!window.Telegram?.WebApp?.initData;
  const save=()=>{try{sessionStorage.setItem(key,JSON.stringify({queue,dropped}));}catch{storageError=1;}};
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>void flush(),Math.min(30000,1000*2**Math.min(attempts,5)));};
  async function flush(){
    if(busy||!queue.length||navigator.onLine===false)return;
    busy=true;
    const item=queue[0];
    const controller=typeof AbortController==='function'?new AbortController():null;
    const timeout=controller?setTimeout(()=>controller.abort(),5000):null;
    try{
      const response=await fetch('/api/landing/click',{method:'POST',credentials:'omit',headers:{'content-type':'application/json','x-landing-request':'1'},
        body:JSON.stringify({...item.event,dropped,storageError}),keepalive:true,...(controller?{signal:controller.signal}:{})});
      if(!response.ok){if([400,403,404,409].includes(response.status)){queue.shift();dropped=Math.min(100000,dropped+1);}throw Error('click');}
      queue.shift();attempts=0;dropped=0;
    }catch{attempts++;}finally{if(timeout!==null)clearTimeout(timeout);busy=false;save();if(queue.length)schedule();}
  }
  let queueLoaded=false;
  const resume=()=>{
    if(!visible())return;
    if(!queueLoaded){queueLoaded=true;try{
      const saved=JSON.parse(sessionStorage.getItem(key)||'{}');
      const items=Array.isArray(saved.queue)?saved.queue:[];
      queue=items.filter(e=>e?.event&&Date.now()-e.at<86400000&&Date.now()>=e.at&&/^[a-f0-9]{32}$/.test(e.event.visitId||'')&&['telegram','max'].includes(e.event.platform)&&Number.isSafeInteger(e.event.elapsedMs)&&e.event.elapsedMs>=0&&e.event.elapsedMs<=86400000).slice(-20);
      dropped=Math.min(100000,Math.max(0,Number.isInteger(saved.dropped)?saved.dropped:0)+items.length-queue.length);
    }catch{storageError=1;}}
    void flush();
  };
  window.addEventListener('online',resume);
  window.addEventListener('pageshow',resume);
  window.addEventListener('pagehide',()=>{void flush();});
  document.addEventListener('visibilitychange',resume);
  const track = async () => {
    if (sent || document.visibilityState !== 'visible' || root.hidden || !root.getClientRects().length || window.__miniLaunch || window.Telegram?.WebApp?.initData) return;
    sent = true;
    resume();
    void import('/landing-metricool.js?v=1').then(module => module.start()).catch(() => {});
    try {
      const visitId = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
      const query = new URLSearchParams(location.search);
      const allowed = new Set(['campaign', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'campaign_id', 'adgroup_id', 'phrase_id', 'device', 'yclid']);
      for (const key of [...query.keys()]) if (!allowed.has(key)) query.delete(key);
      const response = await fetch('/api/landing/view', { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', 'x-landing-request': '1' }, body: JSON.stringify({ visitId, query: query.toString() }), keepalive: true });
      if (!response.ok) { void import('/landing-metrika.js?v=5').then(module => module.start()).catch(() => {}); return; }
      const data = await response.json();
      if (!data.links || !/^https:\/\/t\.me\/[A-Za-z0-9_]+\?start=lp_[A-Za-z0-9_-]{24}$/.test(data.links.telegram||'') ||
        !/^https:\/\/max\.ru\/[A-Za-z0-9_]+\?start=[A-Za-z0-9_-]{1,80}$/.test(data.links.max||'')) return;
      void import('/landing-metrika.js?v=5').then(module => module.start(visitId)).catch(() => {});
      void import('/landing-heatmap.js?v=1').then(module => module.start(visitId)).catch(() => {});
      const receivedAt=performance.now(),tracked=new Map(),clicked=new Set();
      for (const link of root.querySelectorAll('a[href]')) {
        const url = new URL(link.href, location.origin);
        let platform;
        if (link.dataset?.landingPlatform === 'max') platform='max';
        else if (window.__recipePlatform?.name !== 'max' && url.hostname === 't.me' && ['collection', 'save', 'dinner'].includes(url.searchParams.get('start'))) platform='telegram';
        if(platform){link.href=data.links[platform];if(Number.isFinite(data.linkAgesMs?.[platform]))tracked.set(link,platform);}
      }
      root.addEventListener('click',event=>{
        if(!event.isTrusted||!visible()||!(event.target instanceof Element))return;
        const link=event.target.closest('a'),platform=tracked.get(link);
        if(!platform||clicked.has(platform)||link.href!==data.links[platform])return;
        clicked.add(platform);
        if(queue.length>=20){queue.shift();dropped=Math.min(100000,dropped+1);}
        queue.push({at:Date.now(),event:{visitId,platform,elapsedMs:Math.min(86400000,Math.max(0,Math.round(data.linkAgesMs[platform]+performance.now()-receivedAt)))}});
        save();void flush();
        // Do not preventDefault, await analytics, open a popup or replace navigation.
      },{capture:true});
    } catch {
      // Keep the existing unlinked Metrika view if our own collection is down.
      void import('/landing-metrika.js?v=5').then(module => module.start()).catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', track);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', track, { once: true });
  else void track();
})();
