'use strict';

// Public, opt-in updates from this project's GitHub releases only.
// Transport authenticity comes from HTTPS to GitHub; hashes detect damaged assets.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const {spawn} = require('node:child_process');

const REPOSITORY = 'nevio197/neviotix-timer';
const MAX_ARCHIVE = 8 * 1024 * 1024;
const MAX_EXPANDED = 24 * 1024 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
const MAX_MANIFEST = 128 * 1024;
const RUNTIME_FILES = new Set([
  'core.cjs', 'server.cjs', 'launch.cjs', 'control.cjs', 'updater.cjs',
  'apply-update.cjs', 'start.vbs', 'neviotix-timer.lua', 'package.json',
  'version.json', 'KURZANLEITUNG.txt', 'README.md', 'LICENSE',
  'Install.ps1', 'Uninstall.ps1', 'core.test.cjs', 'server.test.cjs',
  'updater.test.cjs', 'scripts/check.cjs', 'scripts/package-release.cjs',
  'public/index.html', 'public/dock.css', 'public/dock.js',
  'public/overlay.html', 'public/overlay.css', 'public/overlay.js',
]);
const REQUIRED_FILES = ['core.cjs', 'server.cjs', 'updater.cjs', 'apply-update.cjs',
  'launch.cjs', 'package.json', 'public/index.html', 'public/dock.js', 'public/overlay.html'];
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;

function parseVersion(input) {
  if (typeof input !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input)) throw new Error('Ungültige Versionsnummer.');
  const result = input.split('.').map(Number);
  if (result.some(n => !Number.isSafeInteger(n) || n > 1000000)) throw new Error('Ungültige Versionsnummer.');
  return result;
}
function compareVersions(a, b) {
  const aa = parseVersion(a), bb = parseVersion(b);
  for (let i = 0; i < 3; i += 1) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function safeFile(name) {
  if (typeof name !== 'string' || !RUNTIME_FILES.has(name)) throw new Error('Update enthält eine nicht erlaubte Datei.');
  return name;
}
function releaseURL(url, version, filename) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Update-Quelle ist ungültig.'); }
  const segments = parsed.pathname.split('/').filter(Boolean);
  const tail = filename === undefined ? ['releases', 'tag', 'v' + version] : ['releases', 'download', 'v' + version, filename];
  const [owner, repository] = REPOSITORY.split('/');
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash
    || segments.length !== tail.length + 2 || segments[0].toLowerCase() !== owner || segments[1].toLowerCase() !== repository
    || tail.some((segment, index) => segments[index + 2] !== segment)) throw new Error('Update-Download stammt nicht aus diesem Repository.');
  return url;
}
function validateManifest(value, version, asset) {
  if (!value || value.schemaVersion !== 1 || typeof value.repository !== 'string' || value.repository.toLowerCase() !== REPOSITORY || value.version !== version) throw new Error('Update-Manifest passt nicht zur Version.');
  const a = value.asset;
  if (!a || a.name !== asset.name || !digestPattern.test(a.sha256 || '') || !Number.isInteger(a.size) || a.size !== asset.size || a.size <= 0 || a.size > MAX_ARCHIVE) throw new Error('Update-Archiv ist im Manifest ungültig.');
  if (!Array.isArray(value.files) || value.files.length < REQUIRED_FILES.length || value.files.length > RUNTIME_FILES.size) throw new Error('Update-Dateiliste ist ungültig.');
  const seen = new Set();
  let expanded = 0;
  for (const file of value.files) {
    safeFile(file?.path);
    if (seen.has(file.path) || !digestPattern.test(file.sha256 || '') || !Number.isInteger(file.size) || file.size < 0 || file.size > MAX_FILE) throw new Error('Update-Dateiliste ist ungültig.');
    seen.add(file.path);
    expanded += file.size;
  }
  if (expanded > MAX_EXPANDED || REQUIRED_FILES.some(name => !seen.has(name))) throw new Error('Update ist unvollständig oder zu groß.');
  return value;
}

let crcTable;
function crc32(bytes) {
  crcTable ||= Array.from({length: 256}, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Read a small standard ZIP without invoking a shell or trusting archive paths.
// ZIP64, encrypted, symlink and unsupported-method entries are deliberately rejected.
function readVerifiedZip(bytes, manifest) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_ARCHIVE) throw new Error('Update-Archiv ist ungültig.');
  if (bytes.length !== manifest.asset.size || sha256(bytes) !== manifest.asset.sha256) throw new Error('Prüfsumme des Update-Archivs stimmt nicht.');
  let end = -1;
  for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos -= 1) {
    if (bytes.readUInt32LE(pos) === 0x06054b50 && pos + 22 + bytes.readUInt16LE(pos + 20) === bytes.length) { end = pos; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) throw new Error('Mehrteilige ZIP-Archive werden nicht unterstützt.');
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (count === 0xffff || directoryStart === 0xffffffff || count > 256 || bytes.readUInt16LE(end + 8) !== count || directoryStart + directorySize !== end) throw new Error('Update-ZIP-Verzeichnis ist ungültig.');
  const expected = new Map(manifest.files.map(file => [file.path, file]));
  const output = new Map();
  const seenNames = new Set();
  let pos = directoryStart;
  for (let i = 0; i < count; i += 1) {
    if (pos + 46 > end || bytes.readUInt32LE(pos) !== 0x02014b50) throw new Error('Beschädigtes ZIP-Verzeichnis.');
    const flags = bytes.readUInt16LE(pos + 8), method = bytes.readUInt16LE(pos + 10);
    const crc = bytes.readUInt32LE(pos + 16), compressed = bytes.readUInt32LE(pos + 20), size = bytes.readUInt32LE(pos + 24);
    const nameLength = bytes.readUInt16LE(pos + 28), extraLength = bytes.readUInt16LE(pos + 30), commentLength = bytes.readUInt16LE(pos + 32);
    const external = bytes.readUInt32LE(pos + 38), local = bytes.readUInt32LE(pos + 42);
    if (pos + 46 + nameLength + extraLength + commentLength > end || flags & 1 || (method !== 0 && method !== 8) || ((external >>> 16) & 0xf000) === 0xa000) throw new Error('ZIP-Dateityp wird nicht unterstützt.');
    const nameBytes = bytes.subarray(pos + 46, pos + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!name || !Buffer.from(name, 'utf8').equals(nameBytes) || /[\\\0:]/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '.' || part === '..') || seenNames.has(name.toLowerCase())) throw new Error('Unsicherer oder doppelter ZIP-Pfad.');
    seenNames.add(name.toLowerCase());
    pos += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) {
      if (!['public/', 'scripts/'].includes(name) || size !== 0) throw new Error('Nicht erlaubtes ZIP-Verzeichnis.');
      continue;
    }
    safeFile(name);
    const file = expected.get(name);
    if (!file || size !== file.size || size > MAX_FILE || compressed > MAX_ARCHIVE || local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP-Datei stimmt nicht mit dem Manifest überein.');
    const localFlags = bytes.readUInt16LE(local + 6), localMethod = bytes.readUInt16LE(local + 8);
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || localMethod !== method || start + compressed > directoryStart || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)) throw new Error('ZIP-Dateikopf ist widersprüchlich.');
    const packed = bytes.subarray(start, start + compressed);
    const content = method === 0 ? Buffer.from(packed) : zlib.inflateRawSync(packed, {maxOutputLength: Math.max(1, size)});
    if (content.length !== size || crc32(content) !== crc || sha256(content) !== file.sha256) throw new Error('Prüfsumme einer Update-Datei stimmt nicht.');
    output.set(name, content);
  }
  if (pos !== end || output.size !== expected.size) throw new Error('Update-Archiv ist unvollständig.');
  return output;
}

class Updater {
  constructor({installDir = __dirname, currentVersion, repo = REPOSITORY, fetchImpl = fetch, dataDir, onChange = () => {}, canInstall = () => true} = {}) {
    if (typeof repo !== 'string' || repo.toLowerCase() !== REPOSITORY) throw new Error('Nur das NEVIOTIX-Repository wird unterstützt.');
    parseVersion(currentVersion);
    this.installDir = path.resolve(installDir);
    this.currentVersion = currentVersion;
    this.fetchImpl = fetchImpl;
    this.dataDir = path.resolve(dataDir || path.join(process.env.APPDATA || os.tmpdir(), 'NEVIOTIX-Timer', 'updates'));
    this.onChange = onChange;
    this.canInstall = canInstall;
    this.release = null;
    this.prepared = null;
    this.busy = false;
    this.value = {status: 'idle', currentVersion, latestVersion: '', available: false, message: 'Noch nicht nach Updates gesucht.', checkedAt: null, progress: 0, releaseURL: ''};
    try {
      const result = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'last-result.json'), 'utf8'));
      if (result.status === 'rolled-back' || result.status === 'failed') this.value.message = 'Das letzte Update wurde nicht installiert. Die vorherige Version ist weiter verfügbar.';
    } catch {}
  }

  state() { return {...this.value}; }
  update(patch) { Object.assign(this.value, patch); this.onChange(this.state()); return this.state(); }

  async download(url, limit, type = 'asset') {
    let current = new URL(url);
    const isApi = type === 'api';
    const cdn = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (current.protocol !== 'https:' || current.username || current.password || current.port || (isApi ? current.hostname !== 'api.github.com' : !cdn.has(current.hostname))) throw new Error('Unsicherer Update-Download wurde abgelehnt.');
      const response = await this.fetchImpl(current.href, {redirect: 'manual', signal: AbortSignal.timeout(120000), headers: {'User-Agent': 'NEVIOTIX-Timer-Updater', Accept: isApi ? 'application/vnd.github+json' : 'application/octet-stream'}});
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Update-Weiterleitung ist ungültig.');
        current = new URL(location, current);
        continue;
      }
      if (response.status === 404 && isApi) throw new Error('Es gibt noch keine veröffentlichte Version.');
      if (response.status === 403 || response.status === 429) throw new Error('GitHub begrenzt gerade die Anfragen. Bitte später erneut versuchen.');
      if (!response.ok) throw new Error('GitHub-Download ist gerade nicht erreichbar.');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > limit) throw new Error('Update-Download ist zu groß.');
      const parts = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > limit) throw new Error('Update-Download ist zu groß.');
        parts.push(Buffer.from(chunk));
      }
      return Buffer.concat(parts);
    }
    throw new Error('Zu viele Update-Weiterleitungen.');
  }

  async check() {
    if (this.busy) throw new Error('Ein Update wird bereits vorbereitet.');
    this.busy = true;
    this.update({status: 'checking', message: 'Suche nach Updates …', progress: 0});
    try {
      const release = JSON.parse((await this.download(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, 512 * 1024, 'api')).toString('utf8'));
      if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) throw new Error('Keine stabile Update-Version gefunden.');
      const version = release.tag_name.slice(1);
      parseVersion(version);
      const releasePage = releaseURL(release.html_url, version);
      if (compareVersions(version, this.currentVersion) <= 0) {
        this.release = null;
        return this.update({status: 'current', latestVersion: version, available: false, releaseURL: releasePage, checkedAt: new Date().toISOString(), message: 'Du nutzt die aktuelle Version.'});
      }
      const archiveName = `NEVIOTIX-Timer-${version}-windows.zip`;
      const assets = release.assets;
      if (!Array.isArray(assets)) throw new Error('Update-Dateien fehlen.');
      const select = name => {
        const items = assets.filter(asset => asset.name === name);
        if (items.length !== 1 || !Number.isInteger(items[0].size) || items[0].size <= 0) throw new Error('Update-Dateien fehlen oder sind mehrdeutig.');
        releaseURL(items[0].browser_download_url, version, name);
        return items[0];
      };
      const archive = select(archiveName), manifest = select('update-manifest.json');
      if (archive.size > MAX_ARCHIVE || manifest.size > MAX_MANIFEST) throw new Error('Update ist zu groß.');
      this.release = {version, archive, manifest};
      this.prepared = null;
      return this.update({status: 'available', latestVersion: version, available: true, releaseURL: releasePage, checkedAt: new Date().toISOString(), message: `Version ${version} ist verfügbar.`});
    } catch (error) {
      this.release = null;
      this.update({status: 'error', available: false, message: error.message || 'Updates konnten nicht geprüft werden.'});
      throw error;
    } finally { this.busy = false; }
  }

  async prepare() {
    if (!this.release) await this.check();
    if (!this.release) throw new Error('Keine neuere Version verfügbar.');
    if (this.busy) throw new Error('Ein Update wird bereits vorbereitet.');
    if (!await this.canInstall()) throw new Error('Bitte zuerst Stream und Aufnahme beenden.');
    this.busy = true;
    this.update({status: 'downloading', progress: 0, message: 'Update wird heruntergeladen und geprüft …'});
    try {
      const release = this.release;
      const manifestBytes = await this.download(release.manifest.browser_download_url, MAX_MANIFEST);
      const manifest = validateManifest(JSON.parse(manifestBytes.toString('utf8')), release.version, release.archive);
      if (release.archive.digest && release.archive.digest !== `sha256:${manifest.asset.sha256}`) throw new Error('GitHub-Prüfsumme widerspricht dem Manifest.');
      this.update({progress: 0.2});
      const archive = await this.download(release.archive.browser_download_url, MAX_ARCHIVE);
      const files = readVerifiedZip(archive, manifest);
      let packageVersion;
      try { packageVersion = JSON.parse(files.get('package.json').toString('utf8')).version; } catch { throw new Error('Update-Paketinformationen sind ungültig.'); }
      if (packageVersion !== release.version) throw new Error('Paketversion stimmt nicht mit der Update-Version überein.');
      this.update({progress: 0.75});
      fs.mkdirSync(this.dataDir, {recursive: true});
      const stageDir = fs.mkdtempSync(path.join(this.dataDir, 'update-'));
      const filesDir = path.join(stageDir, 'files');
      for (const [name, content] of files) {
        const target = path.join(filesDir, ...name.split('/'));
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, content, {flag: 'wx'});
      }
      // Run the currently installed trusted helper, not the just-downloaded version.
      fs.copyFileSync(path.join(this.installDir, 'apply-update.cjs'), path.join(stageDir, 'runner.cjs'));
      this.prepared = {stageDir, filesDir, manifest};
      return this.update({status: 'ready', progress: 1, message: 'Update geprüft und bereit zum Installieren.'});
    } catch (error) {
      this.update({status: 'error', message: error.message || 'Update konnte nicht vorbereitet werden.'});
      throw error;
    } finally { this.busy = false; }
  }

  async launchPrepared({parentPid = process.pid, nodePath = process.execPath} = {}) {
    if (!this.prepared || this.value.status !== 'ready') throw new Error('Das Update ist noch nicht bereit.');
    if (!await this.canInstall()) throw new Error('Bitte zuerst Stream und Aufnahme beenden.');
    if (!Number.isInteger(parentPid) || parentPid <= 0 || !path.isAbsolute(nodePath) || !fs.existsSync(nodePath)) throw new Error('Update-Neustart ist ungültig.');
    const job = {...this.prepared, installDir: this.installDir, parentPid, nodePath,
      resultPath: path.join(this.dataDir, 'last-result.json'), oldVersion: this.currentVersion};
    const jobPath = path.join(job.stageDir, 'job.json');
    fs.writeFileSync(jobPath, JSON.stringify(job), {flag: 'wx'});
    this.update({status: 'installing', message: 'Update wird installiert. Das Dock verbindet sich gleich neu.'});
    const child = spawn(nodePath, [path.join(job.stageDir, 'runner.cjs'), jobPath], {cwd: job.stageDir, detached: true, windowsHide: true, stdio: 'ignore'});
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return {started: true};
  }
}

module.exports = {Updater, REPOSITORY, RUNTIME_FILES, REQUIRED_FILES, MAX_ARCHIVE,
  parseVersion, compareVersions, safeFile, releaseURL, validateManifest, readVerifiedZip, crc32, sha256};
