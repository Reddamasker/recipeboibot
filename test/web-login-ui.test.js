import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';

const source = fs.readFileSync(new URL('../public/web-login-prototype.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function browser({loseFinish = false, failRecoveryOnce = false, failTelemetryOnce = false, finishGate} = {}) {
  const nodes = new Map(), timers = new Map(), requests = [], events = [], listeners = new Map();
  const state = {challenge:'none', authenticated:false};
  let timerId = 0, recoveryFailures = 0, telemetryFailures = failTelemetryOnce ? 1 : 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {hidden:false, disabled:false, textContent:'', focus(){}, addEventListener(event, callback){this[event]=callback;}});
    return nodes.get(id);
  };
  const document = {
    visibilityState:'visible', getElementById:node,
    addEventListener(event, callback) { listeners.set(event,callback); }
  };
  const sandbox = {
    document, window:{open(){},addEventListener(){}}, crypto:{randomUUID}, URL, Date, AbortSignal,
    setTimeout(callback, delay) { timers.set(++timerId,{callback,delay});return timerId; },
    clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      const path = url.replace('/api/web-login/prototype','');
      requests.push({path, options});
      assert.equal(options.credentials,'same-origin');
      assert.equal(options.headers['X-Web-Login'],'1');
      let data;
      if (path === '/events') {
        events.push(JSON.parse(options.body));
        if (telemetryFailures) { telemetryFailures--;throw new Error('Event connection lost'); }
        data={ok:true};
      } else if (path === '/me') {
        if (recoveryFailures) { recoveryFailures--;throw new Error('Session check temporarily unavailable'); }
        data=state.authenticated ? {authenticated:true,scope:'prototype-only'} : {authenticated:false};
      } else if (path === '/status') {
        data={state:state.challenge,code:'123456',expiresAt:'2030-01-01T12:00:00Z'};
      } else if (path === '/start') {
        state.challenge='pending';
        data={state:'pending',code:'123456',expiresAt:'2030-01-01T12:00:00Z',botUrl:'https://max.ru/test?start=challenge'};
      } else if (path === '/finish') {
        // The server applies the browser session and clears the pending cookie
        // before the browser necessarily receives the response body.
        state.authenticated=true;state.challenge='none';
        if (finishGate) await finishGate;
        if (loseFinish) { recoveryFailures=failRecoveryOnce?1:0;throw new Error('Finish body lost after Set-Cookie'); }
        data={authenticated:true};
      } else throw new Error('Unexpected request: '+path);
      return {ok:true,json:async()=>data};
    }
  };
  vm.runInNewContext(source,sandbox,{filename:'web-login-prototype.js'});
  return {
    node, state, requests, events, timers,
    click(id) { return node(id).click(); },
    visibility(value) { document.visibilityState=value;listeners.get('visibilitychange')?.(); },
    async runTimer(predicate) {
      const found=[...timers.entries()].find(([,timer])=>predicate(timer.delay));
      assert.ok(found,'Expected a scheduled timer');
      timers.delete(found[0]);found[1].callback();await settle();
    },
    async drainEvents() {
      for(let i=0;i<10;i++) {
        const found=[...timers.entries()].find(([,timer])=>timer.delay===0||timer.delay===100);
        if(!found)return;
        timers.delete(found[0]);found[1].callback();await settle();
      }
      assert.fail('Event queue did not settle within its bounded drain');
    }
  };
}

for (const delayedRecovery of [false,true]) {
  test(`lost finish response restores the applied session ${delayedRecovery?'after status none':'through immediate me'}`, async () => {
    const page=browser({loseFinish:true,failRecoveryOnce:delayedRecovery});
    await settle();
    assert.equal(page.requests.filter(request=>request.path==='/status').length,1,'initial none must not recurse');
    await page.click('login-start');page.state.challenge='approved';
    page.click('login-check-status');await settle();
    if(delayedRecovery) {
      assert.equal(page.node('login-error').hidden,false);
      assert.equal(page.state.challenge,'none');
      page.click('login-check-status');await settle();
    }
    assert.equal(page.node('login-success').hidden,false);
    assert.equal(page.node('login-error').hidden,true);
    assert.equal(page.node('login-challenge').hidden,true);
    assert.equal(page.requests.filter(request=>request.path==='/finish').length,1,'recovery must not repeat finish');
    assert.ok(page.requests.length<12,'no recursive status or session checks');
    assert.equal([...page.timers.values()].some(timer=>timer.delay===3000),false,'successful login stops polling');
  });
}

test('offered remains a pending confirmation and never authenticates the browser', async () => {
  const page=browser();await settle();await page.click('login-start');
  page.state.challenge='offered';page.click('login-check-status');await settle();
  assert.equal(page.node('login-challenge').hidden,false);
  assert.equal(page.node('login-code').textContent,'123456');
  assert.equal(page.node('login-success').hidden,true);
  assert.equal(page.requests.some(request=>request.path==='/finish'),false);
  assert.ok([...page.timers.values()].some(timer=>timer.delay===3000));
});

test('a result completed in a hidden tab is reported only when it becomes visible', async () => {
  let releaseFinish;
  const finishGate=new Promise(resolve=>{releaseFinish=resolve;});
  const page=browser({finishGate});await settle();await page.click('login-start');
  page.state.challenge='approved';page.click('login-check-status');await settle();
  assert.equal(page.requests.filter(request=>request.path==='/finish').length,1);
  page.visibility('hidden');releaseFinish();await settle();
  assert.equal(page.node('login-success').hidden,false);
  await page.drainEvents();
  assert.equal(page.events.filter(event=>event.event==='result_view').length,0);
  page.visibility('visible');await page.drainEvents();
  assert.deepEqual(page.events.filter(event=>event.event==='result_view').map(event=>event.code),['success']);
  page.visibility('hidden');page.visibility('visible');await page.drainEvents();
  assert.equal(page.events.filter(event=>event.event==='result_view').length,1,'visibility changes must not duplicate the result');
});

test('telemetry retries the same event ID without delaying login', async () => {
  const page=browser({failTelemetryOnce:true});await settle();
  await page.runTimer(delay=>delay===0);
  assert.equal(page.events.length,1);
  const original=page.events[0];
  assert.equal(original.event,'screen_view');
  assert.equal(page.node('login-start').disabled,false);
  await page.runTimer(delay=>delay===2000);
  assert.equal(page.events.length,2);
  assert.deepEqual(page.events[1],original);
  assert.deepEqual(Object.keys(original).sort(),['code','event','id']);
  await page.click('login-start');
  assert.equal(page.node('login-challenge').hidden,false);
});
