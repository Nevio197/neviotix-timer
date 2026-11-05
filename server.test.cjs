'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

let child, base, port, dataDir, token;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function start() {
  child = spawn(process.execPath, [path.join(__dirname, 'server.cjs')], {
    env: { ...process.env, NEVIOTIX_TIMER_PORT: String(port), NEVIOTIX_TIMER_DATA_DIR: dataDir },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', part => { errors += part; });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${errors}`);
    try {
      const health = await fetch(`${base}/health`).then(res => res.json());
      if (health.product === 'NEVIOTIX Timer') {
        token = (await fetch(`${base}/api/bootstrap`).then(res => res.json())).token;
        return;
      }
    } catch {}
    await sleep(50);
  }
  throw new Error('Test server did not start');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exit;
}
async function action(body, extra = {}) {
  return fetch(`${base}/api/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NEVIOTIX-Token': token, ...extra }, body: JSON.stringify(body),
  });
}

before(async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  base = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(__dirname, '.http-test-'));
  await start();
});
after(stop);

test('health and bootstrap identify this local service without exposing OBS credentials', async () => {
  const health = await fetch(`${base}/health`).then(res => res.json());
  assert.equal(health.product, 'NEVIOTIX Timer');
  assert.equal(health.version, require('./package.json').version);
  assert.equal(health.port, port);
  const bootstrap = await fetch(`${base}/api/bootstrap`).then(res => res.json());
  assert.match(bootstrap.token, /^[a-f0-9]{64}$/);
  assert.equal(bootstrap.state.displayText, '05:00');
  assert.deepEqual(Object.keys(bootstrap.state.obs).sort(), ['connected', 'currentScene', 'scenes']);
  assert.equal(JSON.stringify(bootstrap).includes('server_password'), false);
});

test('cross-origin writes, missing token and invalid values are rejected without changing state', async () => {
  const before = await fetch(`${base}/api/state`).then(res => res.json());
  assert.equal((await action({ action: 'play' }, { 'X-NEVIOTIX-Token': '' })).status, 403);
  assert.equal((await action({ action: 'play' }, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await action({ action: 'set_duration', seconds: -1 })).status, 400);
  const current = await fetch(`${base}/api/state`).then(res => res.json());
  assert.equal(current.running, before.running);
  assert.equal(current.durationMs, before.durationMs);
});

test('updater status is readable but update commands require the current local token', async () => {
  const update = await fetch(`${base}/api/update`).then(res => res.json());
  assert.equal(update.currentVersion, require('./package.json').version);
  assert.equal(update.available, false);
  assert.equal((await fetch(`${base}/api/update/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).status, 403);
  assert.equal((await fetch(`${base}/api/update/install`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-NEVIOTIX-Token': token, Origin: 'https://example.com' }, body: '{}',
  })).status, 403);
});

test('API commands update one shared timer and SSE publishes its state', async () => {
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reader = stream.body.getReader();
  const initial = new TextDecoder().decode((await reader.read()).value);
  assert.match(initial, /event: state/);
  assert.match(initial, /"displayText":"05:00"/);
  await action({ action: 'set_duration', seconds: 3 });
  await action({ action: 'play' });
  await sleep(150);
  await action({ action: 'pause' });
  const paused = await fetch(`${base}/api/state`).then(res => res.json());
  assert.equal(paused.running, false);
  assert.ok(paused.remainingMs > 2000 && paused.remainingMs < 3000);
  await sleep(120);
  const later = await fetch(`${base}/api/state`).then(res => res.json());
  assert.equal(later.remainingMs, paused.remainingMs);
  await reader.cancel();
  controller.abort();
});

test('static routes reject encoded traversal and refuse unsupported methods', async () => {
  assert.equal((await fetch(`${base}/%2e%2e%2fcore.cjs`)).status, 403);
  assert.equal((await fetch(`${base}/anything`, { method: 'DELETE' })).status, 405);
});

test('saved state survives a server restart as a paused countdown', async () => {
  await action({ action: 'set_duration', seconds: 123 });
  await action({ action: 'design', patch: { theme: 'neon', accent: '#00ffaa' } });
  await action({ action: 'play' });
  await sleep(120);
  await action({ action: 'pause' });
  const before = await fetch(`${base}/api/state`).then(res => res.json());
  await stop();
  await start();
  const restored = await fetch(`${base}/api/state`).then(res => res.json());
  assert.equal(restored.running, false);
  assert.equal(restored.remainingMs, before.remainingMs);
  assert.equal(restored.design.theme, 'neon');
  assert.equal(restored.design.accent, '#00ffaa');
});
