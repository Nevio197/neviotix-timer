'use strict';
// A small dependency-free ZIP writer. The fixed list excludes all machine data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only stable semantic versions can be released.');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Release tag and package version differ.');
for (const runtimeFile of ['server.cjs', 'launch.cjs']) {
  const runtimeText = fs.readFileSync(path.join(root, runtimeFile), 'utf8');
  const literalVersion = runtimeText.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
  const fromPackage = /const\s+VERSION\s*=\s*require\(['"]\.\/package\.json['"]\)\.version\s*;/.test(runtimeText);
  if ((!literalVersion && !fromPackage) || (literalVersion && literalVersion[1] !== version)) {
    throw new Error(`${runtimeFile} must use the package version.`);
  }
}

const FILES = [
  'LICENSE', 'README.md', 'KURZANLEITUNG.txt', 'package.json',
  'core.cjs', 'server.cjs', 'launch.cjs', 'control.cjs',
  'updater.cjs', 'apply-update.cjs', 'start.vbs', 'neviotix-timer.lua',
  'core.test.cjs', 'server.test.cjs', 'updater.test.cjs',
  'public/index.html', 'public/dock.css', 'public/dock.js',
  'public/overlay.html', 'public/overlay.css', 'public/overlay.js',
  'scripts/check.cjs', 'scripts/package-release.cjs',
].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
const localParts = [], directoryParts = [], files = [];
let offset = 0;
// 2000-01-01 00:00:00, independent of local timezone and file mtimes.
const dosDate = 33 | (20 << 9);
for (const name of FILES) {
  if (name.includes('..') || name.includes('\\') || name.startsWith('/')) throw new Error('Unsafe release path.');
  const filename = path.join(root, ...name.split('/'));
  if (!fs.lstatSync(filename).isFile()) throw new Error(`Missing regular release file: ${name}`);
  const data = fs.readFileSync(filename);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const encodedName = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  localParts.push(local, encodedName, compressed);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosDate, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(encodedName.length, 28); central.writeUInt32LE(offset, 42);
  directoryParts.push(central, encodedName);
  offset += local.length + encodedName.length + compressed.length;
  files.push({ path: name, sha256: sha256(data), size: data.length });
}
const centralDirectory = Buffer.concat(directoryParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...localParts, centralDirectory, end]);
const assetName = `NEVIOTIX-Timer-${version}-windows.zip`;
const manifest = {
  schemaVersion: 1, version, repository: 'nevio197/neviotix-timer',
  asset: { name: assetName, sha256: sha256(archive), size: archive.length }, files,
};
if (manifest.version !== pkg.version) throw new Error('Manifest version differs from package version.');
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(path.join(dist, assetName), archive);
fs.writeFileSync(path.join(dist, 'update-manifest.json'), manifestBytes);
fs.writeFileSync(path.join(dist, 'SHA256SUMS'), `${sha256(archive)}  ${assetName}\n${sha256(manifestBytes)}  update-manifest.json\n`);
console.log(JSON.stringify({ version, archive: assetName, files: files.length, bytes: archive.length, sha256: manifest.asset.sha256 }, null, 2));
