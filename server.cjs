'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { TimerCore } = require('./core.cjs');
const { Updater } = require('./updater.cjs');

const HOST = '127.0.0.1';
const PORT = Number(process.env.NEVIOTIX_TIMER_PORT || 18771);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new RangeError('NEVIOTIX_TIMER_PORT muss zwischen 1024 und 65535 liegen.');
const VERSION = require('./package.json').version;
const PRODUCT = 'NEVIOTIX Timer';
const publicRoot = path.join(__dirname, 'public');
const dataRoot = process.env.NEVIOTIX_TIMER_DATA_DIR || path.join(process.env.APPDATA || __dirname, 'NEVIOTIX-Timer');
const statePath = path.join(dataRoot, 'state.json');
const token = crypto.randomBytes(32).toString('hex');
const clients = new Set();
let shuttingDown = false;
let lastSave = 0;
let saved = {};
try { saved = JSON.parse(fs.readFileSync(statePath, 'utf8').replace(/^\uFEFF/, '')); } catch { /* First launch or an obsolete state starts with safe defaults. */ }

class OBSBridge {
  constructor(onScene) {
    this.onScene = onScene;
    this.state = { connected: false, currentScene: '', scenes: [] };
    this.socket = null;
    this.pending = new Map();
    this.counter = 0;
    this.retry = null;
    this.closed = false;
    this.connect();
  }

  connect() {
    if (this.closed) return;
    let config;
    try {
      config = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || '', 'obs-studio/plugin_config/obs-websocket/config.json'), 'utf8').replace(/^\uFEFF/, ''));
      if (!config.server_enabled) throw new Error('OBS connection disabled');
    } catch { this.scheduleReconnect(); return; }
    const socket = new WebSocket(`ws://127.0.0.1:${Number(config.server_port) || 4455}`);
    this.socket = socket;
    const connectionTimeout = setTimeout(() => socket.close(), 10000);
    const cleanup = () => {
      clearTimeout(connectionTimeout);
      if (this.socket !== socket) return;
      this.state.connected = false;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('OBS disconnected'));
      }
      this.pending.clear();
      this.scheduleReconnect();
    };
    socket.addEventListener('close', cleanup, { once: true });
    socket.addEventListener('error', () => { /* Connection failures are shown in the dock, without credentials. */ });
    socket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.op === 0) {
        const identify = { rpcVersion: 1, eventSubscriptions: 7 };
        if (message.d.authentication) {
          const hash = value => crypto.createHash('sha256').update(value).digest('base64');
          const secret = hash(String(config.server_password || '') + message.d.authentication.salt);
          identify.authentication = hash(secret + message.d.authentication.challenge);
        }
        socket.send(JSON.stringify({ op: 1, d: identify }));
      } else if (message.op === 2) {
        clearTimeout(connectionTimeout);
        this.state.connected = true;
        this.refresh().catch(() => {});
      } else if (message.op === 7) {
        const pending = this.pending.get(message.d.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.d.requestId);
        if (message.d.requestStatus.result) pending.resolve(message.d.responseData || {});
        else pending.reject(new Error('OBS request was declined'));
      } else if (message.op === 5) {
        const { eventType, eventData } = message.d;
        if (eventType === 'CurrentProgramSceneChanged') {
          const oldScene = this.state.currentScene;
          this.state.currentScene = eventData.sceneName;
          if (oldScene !== eventData.sceneName) this.onScene(eventData.sceneName);
        } else if (['SceneCreated', 'SceneRemoved', 'SceneNameChanged', 'SceneListChanged', 'CurrentSceneCollectionChanged'].includes(eventType)) {
          this.refresh().catch(() => {});
        } else if (eventType === 'ExitStarted') socket.close();
      }
    });
  }

  scheduleReconnect() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 2500);
    this.retry.unref();
  }

  request(requestType, requestData = {}) {
    if (!this.state.connected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OBS is not connected'));
    const requestId = String(++this.counter);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('OBS request timed out'));
      }, 5000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    });
  }

  async refresh() {
    const scenes = await this.request('GetSceneList');
    this.state.scenes = scenes.scenes.map(scene => scene.sceneName);
    this.state.currentScene = scenes.currentProgramSceneName || '';
  }

  switchScene(name) {
    if (!name || !this.state.scenes.includes(name)) return Promise.resolve();
    return this.request('SetCurrentProgramScene', { sceneName: name });
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}

let obs;
const core = new TimerCore({ saved, onFinish() {
  persist();
  const scene = core.automation.finishScene;
  if (scene && obs) obs.switchScene(scene).catch(() => {});
} });

function persist() {
  try {
    fs.mkdirSync(dataRoot, { recursive: true });
    const temp = statePath + `.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(core.exportState(), null, 2), 'utf8');
    fs.renameSync(temp, statePath);
    lastSave = Date.now();
  } catch { /* A read-only folder must not stop a running countdown. */ }
}

obs = new OBSBridge(scene => {
  if (core.automation.autoStartScene && core.automation.autoStartScene === scene) {
    core.action({ action: 'reset' });
    core.action({ action: 'play' });
    persist();
    broadcast();
  }
});

function state() { return { ...core.snapshot(), appVersion: VERSION, obs: { ...obs.state, scenes: [...obs.state.scenes] } }; }
function broadcast() {
  const payload = `event: state\ndata: ${JSON.stringify(state())}\n\n`;
  for (const client of clients) {
    if (client.destroyed || client.writableEnded) clients.delete(client);
    else client.write(payload);
  }
}

const trustedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
async function assertUpdateSafe() {
  if (obs.state.connected) {
    const [stream, record] = await Promise.all([obs.request('GetStreamStatus'), obs.request('GetRecordStatus')]);
    if (stream.outputActive || record.outputActive) throw new Error('Beende zuerst den Stream oder die Aufnahme, bevor du das Update installierst.');
    return true;
  }
  if (process.platform === 'win32') {
    const running = await new Promise((resolve, reject) => {
      execFile('tasklist', ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
        if (error) return reject(new Error('Der OBS-Status konnte nicht geprüft werden.'));
        resolve(/^"obs64\.exe"/im.test(stdout));
      });
    });
    if (running) throw new Error('Verbinde OBS mit dem Timer oder schließe OBS vor dem Update.');
  }
  return true;
}
const updater = new Updater({ installDir: __dirname, currentVersion: VERSION, repo: 'nevio197/neviotix-timer', dataDir: path.join(dataRoot, 'updates'), canInstall: assertUpdateSafe });
let updateLaunchQueued = false;
function updateStatus() {
  const value = updater.state();
  const statuses = { current: 'uptodate', ready: 'available', installing: 'restarting' };
  return { ...value, status: statuses[value.status] || value.status, releaseUrl: value.releaseURL || '' };
}
function authorizedOrigin(req) {
  if (!trustedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let body = '';
  for await (const part of req) {
    body += part.toString('utf8');
    if (Buffer.byteLength(body) > 16384) throw new RangeError('Befehl ist zu groß.');
  }
  return JSON.parse(body);
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  try {
    if (!authorizedOrigin(req)) return json(res, 403, { error: 'Zugriff nur über das lokale Timer-Dock.' });
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);
    if (req.method === 'GET' && pathname === '/health') return json(res, 200, { product: PRODUCT, version: VERSION, pid: process.pid, port: PORT });
    if (req.method === 'GET' && pathname === '/api/bootstrap') return json(res, 200, { token, state: state() });
    if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, state());
    if (req.method === 'GET' && pathname === '/api/update') return json(res, 200, updateStatus());
    if (req.method === 'POST' && (pathname === '/api/update/check' || pathname === '/api/update/install')) {
      if (req.headers['x-neviotix-token'] !== token || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 403, { error: 'Bitte das Timer-Dock neu laden.' });
      await readJson(req);
      try {
        if (pathname.endsWith('/check')) {
          await updater.check();
          return json(res, 200, { ok: true, update: updateStatus() });
        }
        if (updateLaunchQueued) return json(res, 409, { error: 'Das Update startet bereits.', update: updateStatus() });
        await assertUpdateSafe();
        await updater.prepare();
        await assertUpdateSafe();
        await updater.launchPrepared({ parentPid: process.pid, nodePath: process.execPath });
        updateLaunchQueued = true;
        json(res, 200, { ok: true, update: updateStatus() });
        setTimeout(shutdown, 350);
        return;
      } catch (error) {
        return json(res, 409, { error: String(error.message || 'Update fehlgeschlagen.'), update: updateStatus() });
      }
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/action') {
      if (req.headers['x-neviotix-token'] !== token || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 403, { error: 'Bitte das Timer-Dock neu laden.' });
      const action = await readJson(req);
      core.action(action);
      persist();
      broadcast();
      return json(res, 200, { ok: true, state: state() });
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Unbekannter Timer-Befehl.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Methode nicht erlaubt.' });
    let relative = pathname === '/' || pathname === '/dock' || pathname === '/dock/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (/^overlay\/(starting|brb)\/?$/.test(relative) || relative === 'overlay' || relative === 'overlay/') relative = 'overlay.html';
    const filename = path.resolve(publicRoot, relative);
    if (!filename.startsWith(publicRoot + path.sep) || relative.includes('\\') || relative.includes('\0')) return json(res, 403, { error: 'Ungültiger Pfad.' });
    let stat;
    try { stat = fs.statSync(filename); } catch { return json(res, 404, { error: 'Datei nicht gefunden.' }); }
    if (!stat.isFile()) return json(res, 404, { error: 'Datei nicht gefunden.' });
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'self'" });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filename);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (error) {
    if (!res.headersSent) json(res, error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError ? 400 : 500, { error: error instanceof RangeError || error instanceof TypeError || error instanceof SyntaxError ? error.message : 'Der Timer konnte den Befehl nicht ausführen.' });
    else res.end();
  }
});

const ticker = setInterval(() => {
  core.tick();
  if (core.running && Date.now() - lastSave >= 1000) persist();
  broadcast();
}, 250);
ticker.unref();
server.on('error', async error => {
  if (error.code === 'EADDRINUSE') {
    try {
      const existing = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(1000) }).then(res => res.json());
      if (existing.product === PRODUCT) { obs.close(); process.exit(0); }
    } catch { /* Another application may own this port. */ }
    console.error('NEVIOTIX Timer: Der lokale Timer-Port ist bereits belegt.');
  } else console.error('NEVIOTIX Timer: Der lokale Dienst konnte nicht starten.');
  obs.close();
  process.exit(1);
});
server.listen(PORT, HOST, () => { persist(); console.log(`${PRODUCT} ${VERSION} bereit auf http://${HOST}:${PORT}`); });

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  persist();
  clearInterval(ticker);
  obs.close();
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
