'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Package version must be a stable semantic version.');
let checked = 0;
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['dist', 'node_modules', 'backups', 'updates'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/\.(?:cjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status || 1);
      checked += 1;
    }
  }
}
visit(root);
console.log(`Syntax checked ${checked} JavaScript files; package version ${pkg.version}.`);
