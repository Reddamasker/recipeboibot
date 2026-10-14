import fs from 'node:fs';
import { config } from './config.js';
import { db } from './db.js';
import { createWebLoginStore } from './web-login-store.js';

export function prototypeSettings(settings) {
  if (!settings.webLoginPrototypeEnabled) return null;
  const origin = new URL(settings.webLoginOrigin);
  if (settings.botPlatform !== 'max' || !/^[1-9]\d{0,18}$/.test(settings.webLoginOwnerId) || !/^[A-Za-z0-9_]{5,64}$/.test(settings.maxBotUsername) || origin.origin !== settings.webLoginOrigin || origin.username || origin.password || (origin.protocol !== 'https:' && (settings.production || origin.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(origin.hostname)))) throw Error('Invalid explicit MAX web login prototype configuration');
  return { origin:origin.origin, secure:origin.protocol==='https:', ownerId:settings.webLoginOwnerId, botUsername:settings.maxBotUsername };
}
const settings = prototypeSettings(config);
export function webLoginPreviewDocument() {
  return fs.readFileSync('public/web-login-prototype.html','utf8')
    .replace(/<link rel="stylesheet"[^>]+>/,()=>`<style>${fs.readFileSync('public/web-login-prototype.css','utf8')}</style>`)
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g,'')
    .replace('Технический прототип</span>','Предпросмотр</span>')
    .replace('Проверяем текущий вход…','Предпросмотр экрана. Подтверждение через MAX ещё не подключено.')
    .replace('Начать проверку входа</button>','Вход пока не подключён</button>')
    .replace(/<noscript>[\s\S]*?<\/noscript>/g,'');
}
export const webLoginStore = settings ? createWebLoginStore(db,settings) : null;
const prefix=settings?.secure?'__Host-':'';
const pendingName=prefix+'recipe_login_pending', sessionName=prefix+'recipe_login_session';
const cookie=(name,value,age)=>`${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${settings?.secure?'; Secure':''}`;
const readCookie=(request,name)=>String(request.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';
function reply(response,status,body,type='application/json; charset=utf-8') {
  response.writeHead(status,{'content-type':type,'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
  response.end(type.startsWith('application/json')?JSON.stringify(body):body);
}
export async function webLoginRoute(request,response,url,{bodyJson,rateLimit,ip}) {
  if (!url.pathname.startsWith('/api/web-login/prototype') && !url.pathname.startsWith('/web-login/prototype') && !url.pathname.startsWith('/web-login-prototype.')) return false;
  if (!settings) {reply(response,404,{error:'Не найдено'});return true;}
  try {
    if (request.headers.host !== new URL(settings.origin).host) {reply(response,403,{error:'Неверный адрес сайта'});return true;}
    const assets={'/web-login/prototype':['public/web-login-prototype.html','text/html; charset=utf-8'],'/web-login-prototype.html':['public/web-login-prototype.html','text/html; charset=utf-8'],'/web-login-prototype.js':['public/web-login-prototype.js','text/javascript; charset=utf-8'],'/web-login-prototype.css':['public/web-login-prototype.css','text/css; charset=utf-8']};
    if (request.method==='GET' && assets[url.pathname]) {const [file,type]=assets[url.pathname];reply(response,200,fs.readFileSync(file),type);return true;}
    const browser=readCookie(request,pendingName),session=readCookie(request,sessionName);
    if(request.method==='GET' && url.pathname==='/api/web-login/prototype/me'){reply(response,200,webLoginStore.session(session)||{authenticated:false});return true;}
    if(request.method==='GET' && url.pathname==='/api/web-login/prototype/status'){reply(response,200,webLoginStore.state(browser));return true;}
    if(request.method!=='POST'){reply(response,405,{error:'Метод не поддерживается'});return true;}
    if(request.headers.origin!==settings.origin || request.headers['x-web-login']!=='1' || !String(request.headers['content-type']||'').startsWith('application/json')) {reply(response,403,{error:'Запрос отклонён'});return true;}
    const input=await bodyJson(request,1000);
    if(url.pathname==='/api/web-login/prototype/start') {
      rateLimit('web-login-start:'+ip,5,300000);rateLimit('web-login-start-global',100,300000);
      const result=webLoginStore.begin(browser);
      response.setHeader('set-cookie',cookie(pendingName,result.browser,300));
      reply(response,200,{state:result.state,code:result.code,expiresAt:result.expiresAt,botUrl:`https://max.ru/${settings.botUsername}?start=wl_${result.bot}`});
    } else if(url.pathname==='/api/web-login/prototype/finish') {
      const result=webLoginStore.finish(browser);
      response.setHeader('set-cookie',[cookie(pendingName,'',0),cookie(sessionName,result.session,1800)]);
      reply(response,200,{authenticated:true,scope:'prototype-only',expiresAt:result.expiresAt});
    } else if(url.pathname==='/api/web-login/prototype/logout') {
      webLoginStore.logout(session,browser);response.setHeader('set-cookie',[cookie(pendingName,'',0),cookie(sessionName,'',0)]);reply(response,200,{ok:true});
    } else if(url.pathname==='/api/web-login/prototype/events') {
      rateLimit('web-login-events:'+ip,30);rateLimit('web-login-events-global',300);
      webLoginStore.event(input);reply(response,200,{ok:true});
    } else reply(response,404,{error:'Не найдено'});
  } catch(error) {reply(response,error.status||500,{error:error.status?error.message:'Не удалось выполнить вход'});}
  return true;
}

// This runs after webhook authentication and BEFORE durable queuing. Incoming
// internal fields are never trusted; only this function can create the reference.
export function sanitizeWebLoginEvent(source) {
  const event=structuredClone(source);
  delete event._webLoginRequest;
  if(event.update_type==='bot_started' && /^wl[_:]/.test(String(event.payload||''))) {
    const token=String(event.payload).startsWith('wl_')?String(event.payload).slice(3):'';
    event._webLoginRequest=webLoginStore?.resolveBotToken(token,String(event.user?.user_id))||'invalid';
    event.payload='wl_redacted';
  }
  // A manually pasted command is not a trusted deep-link event. Redact it too.
  if(event.update_type==='message_created' && /^\/start\s+wl[_:]/.test(event.message?.body?.text||'')) event.message.body.text='/start wl_redacted';
  return event;
}
export async function handleWebLoginUpdate(update,call) {
  const message=update.message,callback=update.callback_query;
  const relevant=message?message.webLoginRequest || /^\/start\s+wl[_:]/.test(message.text||''):String(callback?.data||'').startsWith('wl:');
  if(!relevant || config.botPlatform!=='max')return false;
  const actor=String((callback||message).from?.id||'').replace(/^max:/,'');
  if(!settings || actor!==settings.ownerId)return true;
  if(callback) {
    const match=/^wl:(a|d):([a-f0-9-]{36})$/.exec(callback.data);
    const ok=match && callback.message?.chat?.type==='private' && callback.message.chat.id===callback.from.id && webLoginStore.decide(match[2],actor,callback.message.message_id,match[1]==='a');
    await call('answerCallbackQuery',{callback_query_id:callback.id,text:ok?(match[1]==='a'?'Вход подтверждён. Вернись в исходный браузер.':'Вход отменён.'):'Запрос уже завершён или истёк.'});
    return true;
  }
  if(message.chat?.type!=='private'||message.chat.id!==message.from.id)return true;
  const prompt=webLoginStore.prompt(message.webLoginRequest||'',actor);
  if(!prompt){await call('sendMessage',{chat_id:message.chat.id,text:'Запрос входа недоступен. Начни заново на сайте.'});return true;}
  const sent=await call('sendMessage',{chat_id:message.chat.id,text:`Вход на ${new URL(settings.origin).hostname}\n\nКод на сайте: ${prompt.code}\n\nПодтверждай только если ты сам начал вход и в исходном браузере показан этот же код. Если нет — отклони запрос.\n\nЭто проверка входа, без доступа к рецептам и оплате.`,reply_markup:{inline_keyboard:[[{text:'Подтвердить вход',callback_data:`wl:a:${prompt.id}`}],[{text:'Отклонить',callback_data:`wl:d:${prompt.id}`}]]}});
  webLoginStore.delivered(prompt.id,actor,sent.message_id);
  return true;
}
