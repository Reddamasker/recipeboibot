(() => {
  'use strict';
  const noop = () => {};
  const empty = {begin:noop,detail:()=>({}),action:noop,watch:noop,mount:noop,recheck:noop};
  if (!/^\/dinner(?:\/|$)/.test(location.pathname) || new URLSearchParams(location.search).get('benefits') === 'preview') {
    window.CatalogDetail = empty;
    return;
  }
  const navigations = new Set(['initial','link','back','filter','search','pagination','reset','sort','favorites','retry']);
  const actions = new Set(['filter_change','filter_reset','search_submit','card_open','back_to_list','pagination','sort_change','favorite_add','favorite_remove','share','print','servings_change','results_jump','more_cuisines','filters_expand','save_open','platform_telegram','platform_max','cancel_save','open_bot','retry']);
  const controls = new Set(['cuisine','category','time','include','exclude']);
  const sections = new Set(['intro','products','cuisines','filters','results','recipe_header','ingredients','steps','save_cta','footer']);
  const listActions = new Set(['filter_change','filter_reset','search_submit','card_open','pagination','sort_change','results_jump','more_cuisines','filters_expand']);
  const recipeActions = new Set(['back_to_list','share','print','servings_change','save_open','platform_telegram','platform_max','cancel_save','open_bot']);
  const ceiling = 86400000;
  function selection() {
    const p=new URLSearchParams(location.search);
    const sensitive=/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[^\s@]+@[^\s@]+\.[^\s@]+|\bBearer\s+|\bsk-[a-z0-9_-]{12,}|\b\d{5,}:[a-z0-9_-]{20,}|\b(?:token|password|secret|api[_-]?key)\s*[:=])/iu;
    const clean=(value,max)=>{const s=String(value||'').replace(/[\u0000-\u001f\u007f]/gu,' ').trim();return sensitive.test(s)?'[скрыто]':s.slice(0,max).trim();};
    const split=key=>String(p.get(key)||'').slice(0,250).split(',').map(s=>s.trim()).filter(Boolean).slice(0,12);
    const cuisines=['everyday','italian','georgian','russian','ukrainian','belarusian','greek','indian','hungarian','japanese','chinese','uzbek','lebanese','turkish'];
    const categories=['noodles','rice','pasta','soup','salad','baking','chicken','meat','fish','pizza','home'];
    const minutes=Number(p.get('time'));
    const products=[];let remaining=250;
    for(const value of split('include')){const product=clean(value,Math.min(80,remaining));if(!product||product.length>remaining)break;products.push(product);remaining-=product.length+1;if(remaining<=0)break;}
    return {version:1,products,cuisine:cuisines.includes(p.get('cuisine'))?p.get('cuisine'):null,
      query:clean(p.get('q'),160),minutes:Number.isSafeInteger(minutes)&&minutes>=1&&minutes<=1440?minutes:null,
      category:categories.includes(p.get('category'))?p.get('category'):null,excludedCount:split('exclude').length};
  }
  let current = null, timer = null, frame = null, pageHidden = false;
  const now = () => performance.now();
  const visibleDocument = () => !pageHidden && document.visibilityState === 'visible';
  const boundedMs = value => Math.max(0,Math.min(ceiling,Math.round(value)));
  const detail = () => current ? {pageId:current.id,screen:current.screen} : {};
  function emit(event, extra) {
    if (!current) return;
    try { window.RecipeAnalytics?.event(event,'catalog',{...window.CatalogHandoff?.detail(),...detail(),...extra}); } catch {}
  }
  function visible(element) {
    if (!visibleDocument() || !element?.isConnected) return false;
    try { return Boolean(window.RecipeAnalytics?.visible(element)); } catch { return false; }
  }
  function measure() {
    if (!current || !visibleDocument()) return;
    for (const [section,elements] of current.watched) {
      if (!current.seenSections.has(section) && elements.some(visible)) {
        current.seenSections.add(section);
        emit('catalog_section_visible',{section});
      }
    }
    current.cards.forEach((element,index) => { if (visible(element)) current.seenCards.add(index); });
    if(!current.mounted)return;
    // Depth describes the visible viewport's lower edge, not reading or attention.
    const height = Math.max(document.documentElement?.scrollHeight || 0,document.body?.scrollHeight || 0,innerHeight);
    const depth = Math.round(Math.max(0,Math.min(100,100 * (Math.max(0,window.scrollY || 0)+innerHeight)/height)));
    current.depth = Math.max(current.depth,depth);
  }
  function recheck() {
    if (!current || !visibleDocument() || frame !== null) return;
    frame = requestAnimationFrame(() => { frame=null;measure(); });
  }
  function progress(reason) {
    if (!current || !current.everVisible) return;
    if (visibleDocument()) measure();
    const at=now(),elapsedMs=boundedMs(at-current.startedAt),visibleMs=Math.min(elapsedMs,boundedMs(current.visibleTotal+(current.visibleSince===null?0:Math.max(0,at-current.visibleSince))));
    const signature=`${visibleMs}:${current.depth}:${current.seenCards.size}`;
    if (signature === current.lastProgress) return;
    current.lastProgress=signature;
    emit('catalog_page_progress',{visibleMs,elapsedMs,scrollDepth:current.depth,cardsSeen:current.seenCards.size,reason});
  }
  function stopTimer() { if(timer!==null){clearTimeout(timer);timer=null;} }
  function schedule() {
    stopTimer();
    if (!current || !visibleDocument()) return;
    const page=current;
    timer=setTimeout(() => {
      timer=null;
      if(current!==page || !visibleDocument())return;
      progress('heartbeat');page.firstHeartbeat=false;schedule();
    },page.firstHeartbeat?5000:15000);
  }
  function pause(reason) {
    if (!current) return;
    const at=now();
    if(current.visibleSince!==null){current.visibleTotal+=Math.max(0,at-current.visibleSince);current.visibleSince=null;}
    stopTimer();
    progress(reason);
    try { window.RecipeAnalytics?.flushBeforeNavigate?.(); } catch {}
  }
  function resume() {
    if(!current || !visibleDocument() || current.visibleSince!==null)return;
    current.visibleSince=now();current.everVisible=true;schedule();recheck();
  }
  function begin(screen,navigation='initial') {
    if (!['list','recipe'].includes(screen)) return;
    if(current)pause('navigation');
    stopTimer();
    if(frame!==null){cancelAnimationFrame(frame);frame=null;}
    const at=now();
    let id;
    try{id=crypto.randomUUID();}catch{current=null;return;}
    current={id,screen,startedAt:at,visibleSince:visibleDocument()?at:null,visibleTotal:0,everVisible:visibleDocument(),firstHeartbeat:true,
      watched:new Map(),seenSections:new Set(),cards:[],seenCards:new Set(),depth:0,lastProgress:null,mounted:false};
    const rawPage=Number(new URLSearchParams(location.search).get('page'));
    const pageNumber=Number.isInteger(rawPage)&&rawPage>=1&&rawPage<=1000?rawPage:1;
    emit('catalog_page_started',{navigation:navigations.has(navigation)?navigation:'initial',viewport:innerWidth<=480?'compact':innerWidth<=1024?'medium':'wide',pageNumber,...(screen==='list'?{selection:selection()}:{})});
    schedule();
  }
  function watch(section,elements) {
    if(!current || !sections.has(section))return;
    if(section!=='footer'&&(current.screen==='list')!==['intro','products','cuisines','filters','results'].includes(section))return;
    const list=Array.isArray(elements)?elements:[elements];
    current.watched.set(section,list.filter(Boolean));recheck();
  }
  function mount() {
    if(!current)return;
    current.mounted=true;
    const all=selector=>[...document.querySelectorAll(selector)];
    if(current.screen==='list'){
      watch('intro',all('#catalog-view .intro'));
      watch('products',all('#ingredient-chips'));
      watch('cuisines',all('#cuisine-tiles'));
      watch('filters',all('#selection-state,#time-chips,#category-chips,#visual-refinements,#filter-panel form'));
      watch('results',all('#catalog-view .results'));
      current.cards=all('#cards .card-link').slice(0,24);
    }else{
      watch('recipe_header',all('#recipe-view .recipe-heading'));
      watch('ingredients',all('#recipe-view .recipe-body section:first-child'));
      watch('steps',all('#recipe-view .recipe-body section:nth-child(2)'));
      watch('save_cta',all('#recipe-view [data-handoff-open]'));
    }
    watch('footer',all('body > footer'));recheck();
  }
  function action(name,options={}) {
    if(!current || !visibleDocument() || !actions.has(name))return;
    if(current.screen!=='list'&&listActions.has(name)||current.screen!=='recipe'&&recipeActions.has(name))return;
    const extra={action:name};
    if(name==='filter_change'&&controls.has(options.control))extra.control=options.control;
    if(['card_open','favorite_add','favorite_remove'].includes(name)&&Number.isInteger(options.position)&&options.position>=1&&options.position<=24)extra.position=options.position;
    emit('catalog_action',extra);
    if(name==='open_bot')progress('navigation');
    recheck();
  }
  window.CatalogDetail={begin,detail,action,watch,mount,recheck};
  // Capture runs before analytics.js's existing bubble listeners, so its
  // keepalive includes the final snapshot with the original queued event IDs.
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible')resume();else pause('hidden');
  },true);
  window.addEventListener('pagehide',()=>{pageHidden=true;pause('pagehide');},true);
  window.addEventListener('pageshow',()=>{pageHidden=false;resume();},true);
  document.addEventListener('scroll',recheck,true);
  document.addEventListener('toggle',recheck,true);
  document.addEventListener('transitionend',recheck,true);
  window.addEventListener('resize',recheck);
})();
