'use strict';

// Local service launcher. No shell, no visible console, no external packages.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');

const PORT = Number(process.env.NEVIOTIX_TIMER_PORT || 18771);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('Ungültiger lokaler Timer-Port.');
const VERSION = require('./package.json').version;
const BASE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = process.env.NEVIOTIX_TIMER_DATA_DIR || path.join(process.env.APPDATA || __dirname, 'NEVIOTIX-Timer');
const LOCK = path.join(STATE_DIR, 'launch.lock');
const ACTIONS = Object.freeze({
  start: null,
  toggle: {action: 'toggle'},
  reset: {action: 'reset'},
  plus60: {action: 'adjust', seconds: 60},
  minus60: {action: 'adjust', seconds: -60},
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(url, options = {}) {
  return fetch(url, {...options, signal: AbortSignal.timeout(1500)});
}

async function health() {
  try {
    const response = await request(`${BASE}/health`);
    if (!response.ok) return {ready: false, occupied: true};
    const data = await response.json();
    const product = String(data.product || '');
    const own = /neviotix/i.test(product) && /timer/i.test(product)
      && data.version === VERSION && data.port === PORT;
    return {ready: own, occupied: !own, data: own ? data : undefined};
  } catch (error) {
    if (error && error.name === 'SyntaxError') return {ready: false, occupied: true};
    return {ready: false, occupied: false};
  }
}

async function acquireLock() {
  fs.mkdirSync(STATE_DIR, {recursive: true});
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeFileSync(fd, JSON.stringify({pid: process.pid, created: Date.now()}));
      fs.closeSync(fd);
      return () => {
        try {
          const owner = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
          if (owner.pid === process.pid) fs.unlinkSync(LOCK);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
        let alive = true;
        try { process.kill(lock.pid, 0); } catch { alive = false; }
        if (!alive || Date.now() - Number(lock.created) > 15000) {
          fs.unlinkSync(LOCK);
          continue;
        }
      } catch (lockError) {
        // A writer may have created the file just before writing its JSON.
        if (lockError.code === 'ENOENT') continue;
        try {
          if (Date.now() - fs.statSync(LOCK).mtimeMs > 15000) fs.unlinkSync(LOCK);
        } catch {}
      }
      const current = await health();
      if (current.ready) return () => {};
      if (current.occupied) throw new Error('Port 18771 wird bereits von einem anderen Dienst verwendet.');
      await sleep(125);
    }
  }
  throw new Error('Der Timer-Dienst wird bereits gestartet. Bitte kurz warten.');
}

async function ensureServer() {
  let current = await health();
  if (current.ready) return current.data;
  if (current.occupied) throw new Error('Port 18771 wird bereits von einem anderen Dienst verwendet.');
  const release = await acquireLock();
  try {
    current = await health();
    if (current.ready) return current.data;
    if (current.occupied) throw new Error('Port 18771 wird bereits von einem anderen Dienst verwendet.');
    const server = path.join(__dirname, 'server.cjs');
    if (!fs.existsSync(server)) throw new Error('server.cjs fehlt im NEVIOTIX-Timer-Ordner.');
    const child = spawn(process.execPath, [server], {
      cwd: __dirname,
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: {...process.env, NEVIOTIX_TIMER_PORT: String(PORT)},
    });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (spawnError) throw spawnError;
      await sleep(100);
      current = await health();
      if (current.ready) return current.data;
      if (current.occupied) throw new Error('Der lokale Timer-Port ist belegt.');
    }
    throw new Error('Der Timer-Dienst ist noch nicht erreichbar.');
  } finally {
    release();
  }
}

async function sendAction(alias) {
  if (!Object.hasOwn(ACTIONS, alias)) throw new Error('Unbekannter Timer-Befehl.');
  await ensureServer();
  const action = ACTIONS[alias];
  if (action === null) return;
  const bootstrapResponse = await request(`${BASE}/api/bootstrap`);
  if (!bootstrapResponse.ok) throw new Error('Timer-Verbindung fehlgeschlagen.');
  const bootstrap = await bootstrapResponse.json();
  if (typeof bootstrap.token !== 'string' || bootstrap.token.length < 8) {
    throw new Error('Timer-Zugriff konnte nicht bestätigt werden.');
  }
  const response = await request(`${BASE}/api/action`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-NEVIOTIX-Token': bootstrap.token},
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new Error(`Timer-Befehl fehlgeschlagen (${response.status}).`);
}

function logError(error) {
  try {
    fs.mkdirSync(STATE_DIR, {recursive: true});
    const file = path.join(STATE_DIR, 'launcher.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) fs.writeFileSync(file, '');
    fs.appendFileSync(file, `${new Date().toISOString()} ${String(error.message || error).replace(/[\r\n]/g, ' ')}\n`);
  } catch {}
}

async function main(alias = 'start') {
  try {
    await sendAction(alias);
  } catch (error) {
    logError(error);
    process.exitCode = 1;
  }
}

module.exports = {ensureServer, health, sendAction, main};
if (require.main === module) main(process.argv[2] || 'start');
