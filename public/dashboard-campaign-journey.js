(() => {
  const $ = id => document.getElementById(id);
  let campaign, revision = 0;
  const count = n => n === null ? 'Нет данных' : n.toLocaleString('ru-RU');
  const rate = n => n === null ? '—' : n.toLocaleString('ru-RU') + '%';
  const el = (tag, text, className) => { const n=document.createElement(tag);n.textContent=text;if(className)n.className=className;return n; };
  const labels=['Сайт','Переход в бота','Запуск','Первый сохранённый рецепт','Возврат','Оплата'];
  const notes=['Посещения лендинга','Нажали кнопку мессенджера','Сервер получил запуск чата','Сохранили после запуска','Видимый экран в другой день','Реальная оплата после возврата'];
  async function refresh(data) {
    if(data)campaign=data.campaign?.slug || 'all';
    if(!campaign)return;
    const current=++revision;
    $('campaign-journey-body').replaceChildren();
    $('campaign-journey-extra').textContent='';
    $('campaign-journey-status').textContent='Загружаем воронку…';
    const params=new URLSearchParams({campaign,from:$('journey-from').value,to:$('journey-to').value});
    try {
      const response=await fetch('/api/dashboard/campaign-journey?'+params,{credentials:'same-origin'});
      const report=await response.json();
      if(current!==revision)return;
      if(!response.ok)throw Error(report.error || 'Не удалось загрузить воронку');
      for(let i=0;i<labels.length;i++) {
        const tr=el('tr',''), title=el('th','');title.scope='row';
        title.append(el('span',(i+1)+'. '+labels[i]),el('small',notes[i]));tr.append(title);
        for(const p of report.platforms) {
          const cell=el('td',''), value=el('strong',count(p.counts[i]));
          const progress=el('div','','journey-progress');progress.style.setProperty('--progress',(p.fromSite[i]??0)+'%');
          cell.append(value,progress,el('small',i ? rate(p.conversions[i])+' от шага · '+rate(p.fromSite[i])+' от сайта' : 'Общий вход на сайт'));tr.append(cell);
        }
        $('campaign-journey-body').append(tr);
      }
      $('campaign-journey-status').textContent='Посещения '+report.from.split('-').reverse().join('.')+' — '+report.to.split('-').reverse().join('.')+' · Действия по '+new Date(report.generatedAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК';
      const extras=report.platforms.map(p=>{
        const name=p.platform==='max'?'MAX':'Telegram';
        if(p.status!=='ready')return name+': подтверждения недоступны. Переходы известны, дальнейшие этапы не равны нулю.';
        return name+': оплатили после запуска '+count(p.paidAfterStart)+'; из них вне полной цепочки '+count(p.paidOutsideChain)+'. Старая история без подтверждения '+count(p.historicalUnknown)+', без метки '+count(p.missingToken)+', исключено внутренних посещений '+count(p.excludedInternal)+'. Полный учёт запусков с '+new Date(p.trackingSince).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК.';
      });
      $('campaign-journey-extra').replaceChildren(...extras.map(text=>el('p',text)));
    } catch(error) {
      if(current!==revision)return;
      $('campaign-journey-status').textContent=error.message;
    }
  }
  $('journey-from').value='2026-11-10';
  $('journey-to').value=new Date(Date.now()+10800000).toISOString().slice(0,10);
  $('journey-filters').addEventListener('submit',event=>{event.preventDefault();void refresh();});
  window.CampaignJourneyDashboard={refresh,clear(){revision++;campaign=null;$('campaign-journey-body').replaceChildren();}};
})();
