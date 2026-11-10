const sections = { header:'.lp-header',hero:'.lp-hero',import:'#features',collection:'#collection',menu:'#meal-plan',shopping:'#shopping-list',pricing:'#pricing',faq:'#questions',finish:'.lp-end',footer:'.lp-footer' };
const key = 'recipe-landing-heatmap-v1', version = 'figma-20261109';
export function start(visitId) {
  try { if(Number(localStorage.getItem('recipe-landing-internal-until'))>Date.now())return; } catch {}
  const root = document.querySelector('#landing');
  if (!root || window.__landingHeatmapStarted || !/^[a-f0-9]{32}$/.test(visitId) || window.__miniLaunch || window.Telegram?.WebApp?.initData || window.top !== window.self) return;
  window.__landingHeatmapStarted = true;
  let queue=[], dropped=0, busy=false, timer, attempts=0, activeAt=performance.now(), visibleMs=0, depth=0, lastProgress=0, storageError=0;
  const visible = () => document.visibilityState==='visible' && !root.hidden && root.getClientRects().length && !window.__miniLaunch;
  const layout = () => innerWidth<600?'mobile':innerWidth<1024?'tablet':'desktop';
  let currentLayout=layout();
  try { const saved=JSON.parse(sessionStorage.getItem(key)||'{}'); queue=Array.isArray(saved.queue)?saved.queue.filter(e=>Date.now()-e.at<86400000).slice(-80):[];dropped=Number.isInteger(saved.dropped)?Math.min(100000,saved.dropped):0; } catch { storageError=1; }
  const save = () => { try { sessionStorage.setItem(key,JSON.stringify({queue,dropped})); } catch { storageError=1; } };
  const schedule = (delay=1500) => { clearTimeout(timer);timer=setTimeout(flush,delay); };
  function enqueue(kind,extra) {
    if(queue.length>=80){queue.shift();dropped=Math.min(100000,dropped+1);}
    queue.push({at:Date.now(),event:{id:crypto.randomUUID(),visitId,version,layout:currentLayout,kind,...extra}});save();schedule();
  }
  async function flush(departing=false) {
    if((busy&&!departing)||!queue.length||navigator.onLine===false)return;
    busy=true;const expired=queue.filter(e=>Date.now()-e.at>=86400000);dropped=Math.min(100000,dropped+expired.length);queue=queue.filter(e=>Date.now()-e.at<86400000);
    const batch=departing?queue.slice(-20):queue.slice(0,20);if(!batch.length){busy=false;save();return;}
    try {
      const response=await fetch('/api/landing/heatmap',{method:'POST',headers:{'content-type':'application/json','x-landing-request':'1'},body:JSON.stringify({events:batch.map(e=>e.event)}),keepalive:true,signal:AbortSignal.timeout(8000)});
      if(!response.ok){if([400,403].includes(response.status)){const ids=new Set(batch.map(e=>e.event.id));queue=queue.filter(e=>!ids.has(e.event.id));dropped=Math.min(100000,dropped+batch.length);}throw Error('heatmap');}
      const result=await response.json(),accepted=new Set(result.accepted||[]);queue=queue.filter(e=>!accepted.has(e.event.id));dropped=Math.min(100000,dropped+(result.limited?.length||0));attempts=0;
    } catch { attempts++; }
    finally { busy=false;save();if(queue.length)schedule(Math.min(60000,1000*2**Math.min(attempts,6))); }
  }
  function measure(force=false) {
    if(!visible())return;
    const now=performance.now();visibleMs=Math.min(86400000,visibleMs+Math.max(0,now-activeAt));activeAt=now;
    const nextLayout=layout();if(nextLayout!==currentLayout){currentLayout=nextLayout;depth=0;visibleMs=0;}
    const rect=root.getBoundingClientRect(),bottom=Math.min(rect.height,innerHeight-rect.top);
    depth=Math.max(depth,rect.bottom<=innerHeight+2?100:Math.min(100,Math.max(0,Math.floor(bottom/Math.max(1,rect.height)*100))));
    if(force||now-lastProgress>=15000){lastProgress=now;enqueue('progress',{depth,visibleMs:Math.round(visibleMs),dropped,pending:queue.length,storageError});}
  }
  function targetOf(node,section) {
    const summary=node.closest('summary');if(summary&&section==='faq'){const i=[...root.querySelectorAll('#questions summary')].indexOf(summary);return i>=0&&i<6?'faq_'+i:'area';}
    const a=node.closest('a');
    if(a){const p=a.dataset.landingPlatform,url=new URL(a.href,location.origin);if(p==='max'||url.pathname==='/open/recipe-bot/max')return'max';if(url.searchParams.get('start')==='feedback')return'feedback';if(p==='telegram'||url.hostname==='t.me'||url.pathname.startsWith('/landing/go/'))return'telegram';if(url.pathname==='/recipes')return'catalog';if(['/offer.html','/privacy.html'].includes(url.pathname))return'legal';if(url.hash==='#pricing')return'pricing';return'navigation';}
    if(node.closest('#lp-flow-replay'))return'replay';if(node.closest('#lp-menu-toggle'))return'menu';return'area';
  }
  root.addEventListener('click',event=>{
    if(!visible()||!event.isTrusted||!(event.target instanceof Element)||event.target.closest('input,textarea,select,[contenteditable]'))return;
    const entry=Object.entries(sections).find(([,selector])=>event.target.closest(selector));if(!entry)return;
    const [section,selector]=entry,box=event.target.closest(selector).getBoundingClientRect();if(!box.width||!box.height)return;
    const target=event.target.closest('a,button,summary')||event.target,rect=target.getBoundingClientRect();
    const x=event.detail===0?rect.left+rect.width/2:event.clientX,y=event.detail===0?rect.top+rect.height/2:event.clientY;
    measure(true);enqueue('click',{section,target:targetOf(event.target,section),x:Math.max(0,Math.min(20,Math.round((x-box.left)/box.width*20))),y:Math.max(0,Math.min(20,Math.round((y-box.top)/box.height*20)))});
    if(event.target.closest('a'))void flush(true);
  },{capture:true});
  let scrollTimer;
  addEventListener('scroll',()=>{clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>measure(true),600);},{passive:true});
  addEventListener('resize',()=>measure(true),{passive:true});
  document.addEventListener('visibilitychange',()=>{if(visible()){activeAt=performance.now();measure(true);}else{visibleMs=Math.min(86400000,visibleMs+Math.max(0,performance.now()-activeAt));activeAt=performance.now();enqueue('progress',{depth,visibleMs:Math.round(visibleMs),dropped,pending:queue.length,storageError});void flush(true);}});
  addEventListener('pagehide',()=>{measure(true);void flush(true);});
  addEventListener('pageshow',event=>{if(event.persisted){activeAt=performance.now();measure(true);void flush();}});
  addEventListener('online',()=>void flush());
  setInterval(()=>measure(),15000);measure(true);void flush();
}
