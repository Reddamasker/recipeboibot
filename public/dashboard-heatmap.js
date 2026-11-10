(() => {
  const $=s=>document.querySelector(s), panel=$('#landing-heatmap-panel');if(!panel)return;
  const names={header:'Шапка',hero:'Первый экран',import:'Импорт из соцсетей',collection:'Фото и коллекция',menu:'Меню на неделю',shopping:'Список покупок',pricing:'Тарифы',faq:'Вопросы',finish:'Последний призыв',footer:'Подвал'};
  const targets={area:'Область блока',telegram:'Telegram',max:'MAX',navigation:'Навигация',catalog:'Каталог',pricing:'Тарифы',legal:'Документы',feedback:'Обратная связь',replay:'Повтор анимации',menu:'Мобильное меню',faq_0:'Вопрос 1',faq_1:'Вопрос 2',faq_2:'Вопрос 3',faq_3:'Вопрос 4',faq_4:'Вопрос 5',faq_5:'Вопрос 6'};
  let campaign='all',active=false,revision=0,data=null,frameReady=false;
  const frame=$('#heatmap-frame'),stage=$('#heatmap-stage'),space=$('#heatmap-space');
  const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
  function clear(){data=null;$('#heatmap-summary').replaceChildren();$('#heatmap-actions').replaceChildren();$('#heatmap-depth').replaceChildren();try{frame.contentDocument?.getElementById('heat-overlay')?.remove();}catch{} }
  async function load(){
    if(!active)return;const ticket=++revision;clear();$('#heatmap-status').textContent='Загружаем карту…';
    const q=new URLSearchParams({campaign,layout:$('#heatmap-layout').value,from:$('#heatmap-from').value,to:$('#heatmap-to').value});
    try {
      const r=await fetch('/api/dashboard/landing-heatmap?'+q);const result=await r.json();if(!r.ok)throw Error(result.error||'Карта недоступна');if(ticket!==revision)return;data=result;
      const since=new Date(result.since).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'});
      $('#heatmap-status').textContent=`Сбор с ${since} МСК. ${result.visits?'Старые посещения без карты исключены.':'Для выбранных фильтров пока нет новых замеров.'} Точки приблизительные; масштабирование и раскрытие блоков могут сдвигать их.${result.storageErrors ? ` В ${result.storageErrors} посещениях очередь хранилась только в памяти браузера.` : ""}`;
      for(const [label,value] of [['Посещений с картой',result.visits],['Нажатий',result.clicks],['Среднее время в видимой вкладке',result.visibleMs===null?'Нет замеров':Math.round(result.visibleMs/1000)+' с'],['Потери / очередь при замере',`${result.dropped} / ${result.pending}`]]){const card=node('div');card.className='hm-metric';card.append(node('strong',String(value)),node('span',label));$('#heatmap-summary').append(card);}
      const aggregate=new Map();for(const p of result.points){const key=p.section+'|'+p.target;aggregate.set(key,(aggregate.get(key)||0)+p.clicks);}
      for(const [key,count] of [...aggregate].sort((a,b)=>b[1]-a[1]).slice(0,12)){const [section,target]=key.split('|'),row=node('div');row.className='hm-action';row.append(node('span',`${names[section]} · ${targets[target]}`),node('strong',String(count)));$('#heatmap-actions').append(row);}
      if(!aggregate.size)$('#heatmap-actions').append(node('p','Нажатий пока нет.'));
      for(const item of result.scroll){const row=node('div');row.className='hm-depth-row';const pct=result.visits?Math.round(item.visits/result.visits*100):0,bar=node('span');bar.className='hm-bar';bar.style.setProperty('--reach',pct+'%');row.append(node('span',item.depth+'% страницы'),bar,node('strong',result.visits?`${pct}% (${item.visits})`:'Нет замеров'));$('#heatmap-depth').append(row);}
      if(!frame.src){frame.src='/api/dashboard/landing-preview';}else draw();
    }catch(error){if(ticket!==revision)return;$('#heatmap-status').textContent=error.message;}
  }
  const svgNode=(name,attrs)=>{const n=frame.contentDocument.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));return n;};
  function draw(){
    if(!data||!frameReady||!active)return;
    const doc=frame.contentDocument;if(!doc?.querySelector('#landing'))return;
    const width={mobile:390,tablet:768,desktop:1440}[data.layout];frame.style.width=width+'px';
    doc.getElementById('heat-overlay')?.remove();
    frame.style.height='1000px';const height=Math.ceil(doc.querySelector('#landing').getBoundingClientRect().height);frame.style.height=height+'px';
    const scale=Math.min(1,Math.max(1,stage.clientWidth-20)/width);frame.style.transform=`scale(${scale})`;space.style.width=width*scale+'px';space.style.height=height*scale+'px';
    const svg=svgNode('svg',{id:'heat-overlay',width,height,viewBox:`0 0 ${width} ${height}`});svg.style.cssText='position:absolute;left:0;top:0;pointer-events:none;z-index:9999';
    if($('#heatmap-mode').value==='clicks'){
      const defs=svgNode('defs',{}),gradient=svgNode('radialGradient',{id:'hm-glow'});for(const [offset,color,opacity] of [['0%','#e32722',.85],['40%','#ff9900',.65],['75%','#ffe566',.35],['100%','#ffe566',0]])gradient.append(svgNode('stop',{offset,'stop-color':color,'stop-opacity':opacity}));defs.append(gradient);svg.append(defs);
      const grouped=new Map();for(const p of data.points){const key=[p.section,p.x,p.y].join('|'),old=grouped.get(key);if(old)old.clicks+=p.clicks;else grouped.set(key,{...p});}
      for(const p of grouped.values()){const el=doc.querySelector(data.sections[p.section]);if(!el)continue;const r=el.getBoundingClientRect(),x=r.left+p.x/20*r.width,y=r.top+p.y/20*r.height;svg.append(svgNode('circle',{cx:x,cy:y,r:18+Math.min(35,Math.sqrt(p.clicks)*7),fill:'url(#hm-glow)'}));const label=svgNode('text',{x,y:y+4,'text-anchor':'middle',fill:'#171717','font-size':14,'font-weight':700});label.textContent=String(p.clicks);svg.append(label);}
    }else{
      for(const s of data.scroll){if(s.depth===100)continue;const pct=data.visits?s.visits/data.visits:0,y=height*s.depth/100;svg.append(svgNode('rect',{x:0,y,width,height:height/10,fill:`hsl(${Math.round(125*pct)} 90% 45%)`,opacity:data.visits ? .22 : 0}));const label=svgNode('text',{x:width-10,y:y+24,'text-anchor':'end',fill:'#171717','font-size':18,'font-weight':700,stroke:'white','stroke-width':3,'paint-order':'stroke'});label.textContent=data.visits?`${s.depth}%: ${Math.round(pct*100)}% посещений`:'Нет замеров';svg.append(label);}
    }
    doc.body.append(svg);
  }
  frame.addEventListener('load',async()=>{frameReady=true;try{await frame.contentDocument.fonts.ready;await Promise.all([...frame.contentDocument.images].map(img=>{img.loading='eager';return img.decode().catch(()=>{});}));}catch{}draw();});
  $('#heatmap-filters').addEventListener('submit',event=>{event.preventDefault();void load();});
  $('#heatmap-layout').addEventListener('change',()=>void load());$('#heatmap-mode').addEventListener('change',draw);new ResizeObserver(draw).observe(stage);
  window.LandingHeatmapDashboard={refresh(report){try{localStorage.setItem('recipe-landing-internal-until',String(Date.now()+86400000));}catch{}campaign=report.campaign?.slug||'all';active=true;void load();},clear(){active=false;revision++;clear();frame.removeAttribute('src');frameReady=false;}};
})();
