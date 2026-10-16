import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const shell = process.platform === 'win32' ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : '/bin/sh';
assert.ok(existsSync(shell), 'A POSIX shell is required to test the deployed monitor');
const script = path.resolve('deploy/ops-monitor.sh');
const shellQuote = value => {
  const posixPath = value.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
  return `'${posixPath.replaceAll("'", "'\\''")}'`;
};
const paymentFailure = 'Готовность платёжного контура не подтверждена';

// Every external command is isolated. No real Telegram, Docker, app or database is used.
const mockSource = `
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const scenario = JSON.parse(fs.readFileSync(process.env.MONITOR_SCENARIO, 'utf8'));
const [command, ...args] = process.argv.slice(2);
if (command === 'curl') {
  if (args.some(arg => arg.endsWith('/sendMessage'))) {
    if (scenario.alertFailure) process.exit(1);
    if (scenario.alertRejected) { console.log('{"ok":false}'); process.exit(0); }
    fs.appendFileSync(process.env.MONITOR_ALERTS, JSON.stringify(args.find(arg => arg.startsWith('text='))) + '\\n');
    console.log('{"ok":true,"result":{"message_id":1}}');
  } else if (args.some(arg => arg.endsWith('/readyz'))) {
    if (scenario.readinessFailure) process.exit(22);
    process.stdout.write(scenario.body);
  } else if (scenario.healthFailure) process.exit(7);
} else if (command === 'docker') {
  if (args[0] === 'inspect') console.log(scenario.container);
  else if (args.some(arg => arg.includes('mergeMaxFunnelReport'))) process.exit(scenario.bridgeFailure ? 1 : 0);
  else {
    const result = spawnSync(process.execPath, args.slice(args.indexOf('node') + 1), {input: fs.readFileSync(0), encoding:'utf8'});
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    process.exit(result.status ?? 1);
  }
} else if (command === 'df') {
  console.log('Filesystem 1024-blocks Used Available Capacity Mounted on\\nmock 100 20 80 20% /');
} else if (command === 'find') {
  console.log(Date.now() / 1000);
} else if (command === 'stat') {
  console.log(Math.floor(Date.now() / 1000) - (scenario.offsiteAge || 0));
} else if (command === 'flock') {
  process.exit(scenario.retentionBusy ? 75 : scenario.retentionFailure ? 1 : 0);
} else process.exit(2);
`;

function fixture(options = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'recipeboibot-monitor-'));
  const base = path.join(directory, 'base'), state = path.join(directory, 'state'), bin = path.join(directory, 'bin');
  for (const folder of [base, state, bin, path.join(base, 'backups'), path.join(base, 'deploy')]) mkdirSync(folder, { recursive: true });
  if (!options.missingRetention) writeFileSync(path.join(base, 'deploy/retention.sh'), '# fixture policy\n');
  writeFileSync(path.join(base, '.env.local'), `OPS_ALERT_CHAT_ID=123\nTELEGRAM_BOT_TOKEN=fake\nBILLING_REQUIRED=${options.required ?? false}\n`);
  if (!options.missingOffsite) writeFileSync(path.join(base, 'backups/offsite-last-success'), 'fixture');
  if (options.previous) writeFileSync(path.join(state, 'current-status'), options.previous);
  const helper = path.join(directory, 'mock.cjs');
  writeFileSync(helper, mockSource);
  for (const command of ['curl', 'docker', 'df', 'find', 'stat', 'flock']) {
    writeFileSync(path.join(bin, command), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helper)} ${command} "$@"\n`, { mode: 0o755 });
  }
  const scenarioFile = path.join(directory, 'scenario.json'), alertsFile = path.join(directory, 'alerts.jsonl');
  const env = {
    ...process.env,
    RECIPEBOIBOT_BASE_DIR: base.replaceAll('\\', '/'),
    RECIPEBOIBOT_MONITOR_STATE_DIR: state.replaceAll('\\', '/'),
    MONITOR_SCENARIO: scenarioFile,
    MONITOR_ALERTS: alertsFile
  };
  const scenario = {
    body: JSON.stringify({ ok: true, service: 'recipeboibot', billing: { required: options.required ?? false, configured: true } }),
    container: `running healthy 0 false ${new Date().toISOString()}`,
    ...options
  };
  return {
    run(changes = {}) {
      Object.assign(scenario, changes);
      writeFileSync(scenarioFile, JSON.stringify(scenario));
      // Set PATH inside the shell so Git Bash does not replace the fixture directory.
      const result = spawnSync(shell, ['-c', `PATH=${shellQuote(bin)}:$PATH; export PATH; sh ${shellQuote(script)}`], { env, encoding: 'utf8' });
      const alerts = existsSync(alertsFile) ? readFileSync(alertsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      const status = existsSync(path.join(state, 'current-status')) ? readFileSync(path.join(state, 'current-status'), 'utf8') : '';
      return { ...result, alerts, statusText: status };
    },
    cleanup() { rmSync(directory, { recursive: true, force: true }); }
  };
}

function runOnce(options) {
  const context = fixture(options);
  try {
    const result = context.run();
    assert.equal(result.status, 0, result.stderr);
    return result;
  } finally { context.cleanup(); }
}

test('configured billing is healthy with either value of BILLING_REQUIRED', () => {
  for (const required of [false, true]) {
    const result = runOnce({ required });
    assert.equal(result.statusText, '');
    assert.deepEqual(result.alerts, []);
  }
});

test('retention failure alerts once and recovery is reported; an active deployment is tolerated', () => {
  const context = fixture({retentionFailure: true});
  try {
    const first = context.run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.statusText, /Нарушена ротация резервов или Docker в Telegram\/MAX/);
    assert.equal(first.alerts.length, 1);
    assert.equal(context.run().alerts.length, 1);
    const busy = context.run({retentionBusy: true});
    assert.equal(busy.statusText, first.statusText);
    assert.equal(busy.alerts.length, 1, 'A skipped check must not send a false recovery');
    const recovery = context.run({retentionFailure: false, retentionBusy: false});
    assert.equal(recovery.statusText, '');
    assert.equal(recovery.alerts.length, 2);
    assert.equal(context.run({retentionBusy: true}).alerts.length, 2);
  } finally {context.cleanup();}
  assert.match(runOnce({missingRetention: true}).statusText, /Отсутствует общий механизм ротации/);
});

test('monitor parses live JSON independent of whitespace and field order', () => {
  const result = runOnce({ body: JSON.stringify({ billing: { configured: true, required: false }, service: 'recipeboibot', ok: true }, null, 2) });
  assert.equal(result.statusText, '');
});

test('unconfigured, malformed and unsuccessful readiness cannot appear healthy', () => {
  for (const body of [
    JSON.stringify({ ok: true, service: 'recipeboibot', billing: { required: false, configured: false } }),
    JSON.stringify({ ok: true, service: 'recipeboibot', billing: { required: true, configured: false } }),
    JSON.stringify({ ok: false, service: 'recipeboibot', billing: { configured: true } }),
    JSON.stringify({ ok: true, service: 'other', billing: { configured: true } }),
    JSON.stringify({ ok: true, service: 'recipeboibot', billing: { configured: 'true' } }),
    '{"ok":true,"billing":{"configured":true}', '{}'
  ]) {
    const result = runOnce({ body });
    assert.equal(result.statusText, paymentFailure);
    assert.equal(result.alerts.length, 1);
  }
  assert.equal(runOnce({ readinessFailure: true }).statusText, 'Проверка готовности платёжного контура недоступна');
});

test('short normal startup is tolerated but prolonged startup, OOM and restarts alert', () => {
  const recent = new Date(Date.now() - 20000).toISOString();
  const old = new Date(Date.now() - 120000).toISOString();
  assert.equal(runOnce({ container: `running starting 0 false ${recent}` }).statusText, '');
  for (const container of [`running starting 0 false ${old}`, `running unhealthy 0 false ${recent}`, `running starting 1 false ${recent}`, `running starting 0 true ${recent}`, '']) {
    assert.ok(runOnce({ container }).statusText, container);
  }
  assert.match(runOnce({ container: `running starting 0 false ${recent}`, healthFailure: true }).statusText, /healthcheck недоступен/);
});

test('real offsite warning remains and repeated state does not send duplicates', () => {
  const context = fixture({ missingOffsite: true });
  try {
    const first = context.run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.statusText, 'Ещё не подтверждена внешняя резервная копия');
    assert.equal(first.alerts.length, 1);
    assert.equal(context.run().alerts.length, 1);
  } finally { context.cleanup(); }
  assert.equal(runOnce({ offsiteAge: 140000 }).statusText, 'Внешняя резервная копия старше 36 часов');
});

test('obsolete sales warning is replaced once without a false all-clear for backups', () => {
  const result = runOnce({ missingOffsite: true, previous: 'Ещё не подтверждена внешняя резервная копия\nПродажи выключены: BILLING_REQUIRED не равен true' });
  assert.equal(result.alerts.length, 1);
  assert.match(result.alerts[0], /внешняя резервная копия/);
  assert.match(result.alerts[0], /Устранено:\nПродажи выключены/);
  assert.doesNotMatch(result.alerts[0], /снова в норме/);
});

test('failed alert delivery preserves state for retry, recovery sends once', () => {
  const context = fixture({ previous: 'previous failure', readinessFailure: true, alertFailure: true });
  try {
    const failed = context.run();
    assert.notEqual(failed.status, 0);
    assert.equal(failed.statusText, 'previous failure');
    const delivered = context.run({ alertFailure: false });
    assert.equal(delivered.status, 0, delivered.stderr);
    assert.equal(delivered.alerts.length, 1);
    const recovered = context.run({ readinessFailure: false });
    assert.equal(recovered.statusText, '');
    assert.equal(recovered.alerts.length, 2);
    assert.match(recovered.alerts[1], /снова в норме/);
    assert.equal(context.run().alerts.length, 2);
  } finally { context.cleanup(); }
});

test('MAX aggregate failure alerts once and its recovery is visible with a persistent backup warning', () => {
  const context = fixture({ missingOffsite: true, previous: 'Ещё не подтверждена внешняя резервная копия', bridgeFailure: true });
  try {
    const failed = context.run();
    assert.equal(failed.status, 0, failed.stderr);
    assert.match(failed.statusText, /Данные MAX недоступны/);
    assert.equal(failed.alerts.length, 1);
    assert.equal(context.run().alerts.length, 1);
    const recovered = context.run({ bridgeFailure: false });
    assert.equal(recovered.statusText, 'Ещё не подтверждена внешняя резервная копия');
    assert.equal(recovered.alerts.length, 2);
    assert.match(recovered.alerts[1], /Устранено:\nДанные MAX недоступны/);
    assert.doesNotMatch(recovered.alerts[1], /снова в норме/);
    assert.equal(context.run().alerts.length, 2);
  } finally { context.cleanup(); }
});

test('Telegram application rejection preserves the incident for another delivery attempt', () => {
  const context = fixture({ bridgeFailure: true, alertRejected: true });
  try {
    assert.notEqual(context.run().status, 0);
    assert.equal(context.run().statusText, '');
    const retried = context.run({ alertRejected: false });
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.statusText, /Данные MAX недоступны/);
    assert.equal(retried.alerts.length, 1);
  } finally { context.cleanup(); }
});
