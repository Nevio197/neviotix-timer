'use strict';

// Copied to the verified staging directory before the old server exits.
// Only files declared by updater.cjs can be replaced; timer state/OBS config are untouched.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const ALLOWED = new Set(['core.cjs','server.cjs','launch.cjs','control.cjs','updater.cjs','apply-update.cjs','start.vbs','neviotix-timer.lua','package.json','version.json','KURZANLEITUNG.txt','README.md','LICENSE','Install.ps1','Uninstall.ps1','core.test.cjs','server.test.cjs','updater.test.cjs','scripts/check.cjs','scripts/package-release.cjs','public/index.html','public/dock.css','public/dock.js','public/overlay.html','public/overlay.css','public/overlay.js']);
const hash = content => crypto.createHash('sha256').update(content).digest('hex');
function childPath(root, name) {
  if (!ALLOWED.has(name)) throw new Error('Nicht erlaubte Update-Datei.');
  const result = path.resolve(root, ...name.split('/'));
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('Unsicherer Update-Pfad.');
  return result;
}
function ensurePlainPath(root, name) {
  const parts = name.split('/');
  let current = path.resolve(root);
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Update-Ziel ist eine Verknüpfung.');
  for (const part of parts) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Update-Datei ist eine Verknüpfung.');
  }
}
function applyTransaction(job, {copyFile = fs.copyFileSync} = {}) {
  const installDir = path.resolve(job.installDir), filesDir = path.resolve(job.filesDir);
  if (installDir === path.parse(installDir).root || installDir === filesDir || !Array.isArray(job.manifest?.files)) throw new Error('Update-Ziel ist ungültig.');
  const files = job.manifest.files;
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error('Doppelte Update-Datei.');
  for (const file of files) {
    const staged = childPath(filesDir, file.path);
    childPath(installDir, file.path);
    ensurePlainPath(filesDir, file.path);
    ensurePlainPath(installDir, file.path);
    const content = fs.readFileSync(staged);
    if (!Number.isInteger(file.size) || content.length !== file.size || hash(content) !== file.sha256) throw new Error('Vorbereitete Datei wurde verändert.');
  }
  const backup = path.join(job.stageDir, 'backup');
  fs.mkdirSync(backup, {recursive: true});
  const touched = [];
  try {
    for (const file of files) {
      const destination = childPath(installDir, file.path);
      const previous = childPath(backup, file.path);
      const existed = fs.existsSync(destination);
      if (existed) {
        if (!fs.statSync(destination).isFile()) throw new Error('Update-Ziel ist keine Datei.');
        fs.mkdirSync(path.dirname(previous), {recursive: true});
        fs.copyFileSync(destination, previous);
      }
      fs.mkdirSync(path.dirname(destination), {recursive: true});
      const temporary = destination + `.neviotix-update-${process.pid}.tmp`;
      touched.push({destination, previous, existed, temporary});
      copyFile(childPath(filesDir, file.path), temporary);
      fs.renameSync(temporary, destination);
    }
    return {status: 'installed', version: job.manifest.version, backup};
  } catch (error) {
    const failures = [];
    for (const item of touched.reverse()) {
      try {
        if (fs.existsSync(item.temporary)) fs.unlinkSync(item.temporary);
        if (item.existed) {
          fs.copyFileSync(item.previous, item.temporary);
          fs.renameSync(item.temporary, item.destination);
        } else if (fs.existsSync(item.destination)) fs.unlinkSync(item.destination);
      } catch { failures.push(path.basename(item.destination)); }
    }
    const failure = new Error(failures.length ? 'Update fehlgeschlagen. Die Sicherung wurde für eine Wiederherstellung aufbewahrt.' : 'Update fehlgeschlagen; die vorherige Version wurde wiederhergestellt.');
    failure.result = {status: failures.length ? 'failed' : 'rolled-back', version: job.oldVersion, backup};
    failure.cause = error;
    throw failure;
  }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function obsIsRunning() {
  if (process.platform !== 'win32') return true;
  const result = spawnSync('tasklist.exe', ['/FI','IMAGENAME eq obs64.exe','/FO','CSV','/NH'], {windowsHide:true,encoding:'utf8',timeout:4000});
  if (result.error || result.status !== 0) throw new Error('OBS-Status konnte nicht geprüft werden.');
  return /^"obs64\.exe"/im.test(result.stdout);
}
async function probeOBS(config) {
  return new Promise(resolve => {
    let socket;
    let identified=false;
    let stream=false, record=false, responses=0;
    let done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timeout);try{socket?.close();}catch{}resolve(value);};
    const timeout=setTimeout(()=>finish(false),6000);
    try {
      const port=Number(config.server_port)||4455;
      if (!config.server_enabled || !Number.isInteger(port) || port<1 || port>65535) return finish(false);
      socket=new WebSocket(`ws://127.0.0.1:${port}`);
      socket.addEventListener('error',()=>finish(false));
      socket.addEventListener('close',()=>{if(!done)finish(false);});
      socket.addEventListener('message',event=>{
        try {
          const m=JSON.parse(event.data);
          if(m.op===0){
            const d={rpcVersion:1,eventSubscriptions:0};
            if(m.d.authentication){const digest=s=>crypto.createHash('sha256').update(s).digest('base64');d.authentication=digest(digest(String(config.server_password||'')+m.d.authentication.salt)+m.d.authentication.challenge);}
            socket.send(JSON.stringify({op:1,d}));
          }else if(m.op===2){
            identified=true;
            for(const [id,requestType] of [['stream','GetStreamStatus'],['record','GetRecordStatus']])socket.send(JSON.stringify({op:6,d:{requestType,requestId:id}}));
          }else if(m.op===7&&identified){
            if(!m.d.requestStatus.result)return finish(false);
            if(m.d.requestId==='stream')stream=m.d.responseData.outputActive===false;
            else if(m.d.requestId==='record')record=m.d.responseData.outputActive===false;
            else return;
            responses+=1;
            if(responses===2)finish(stream&&record);
          }
        }catch{finish(false);}
      });
    }catch{finish(false);}
  });
}
async function checkOBSIdle({isRunning=obsIsRunning,readConfig=()=>JSON.parse(fs.readFileSync(path.join(process.env.APPDATA||'','obs-studio/plugin_config/obs-websocket/config.json'),'utf8').replace(/^\uFEFF/,'')),probe=probeOBS}={}) {
  try {
    if(!isRunning())return true;
    return await probe(readConfig())===true;
  }catch{return false;}
}
async function main(filename) {
  const job = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const jobRoot = path.dirname(path.resolve(filename));
  if (path.resolve(job.stageDir) !== jobRoot || path.resolve(job.filesDir) !== path.join(jobRoot, 'files') || !Number.isInteger(job.parentPid) || job.parentPid <= 0 || job.parentPid === process.pid || !path.isAbsolute(job.nodePath)) throw new Error('Ungültiger Update-Auftrag.');
  const deadline = Date.now() + 30000;
  while (processAlive(job.parentPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 150));
  if (processAlive(job.parentPid)) throw new Error('Der Timer wurde nicht beendet; Update wurde nicht angewendet.');
  let result;
  try {
    // Recheck immediately before replacement: a stream may have started while downloading.
    if(!await checkOBSIdle())throw new Error('OBS ist aktiv oder der Status ist unbekannt; Update wurde nicht angewendet.');
    result = applyTransaction(job);
  }
  catch (error) { result = {...(error.result || {status:'failed',version:job.oldVersion}), message:error.message}; }
  result.completedAt = new Date().toISOString();
  fs.writeFileSync(path.join(jobRoot, 'result.json'), JSON.stringify(result, null, 2));
  const resultPath = path.resolve(job.resultPath);
  if (resultPath === path.join(path.dirname(jobRoot), 'last-result.json')) fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  const launch = childPath(path.resolve(job.installDir), 'launch.cjs');
  const child = spawn(job.nodePath, [launch], {cwd:job.installDir,detached:true,windowsHide:true,stdio:'ignore'});
  child.on('error', () => {});
  child.unref();
}
module.exports = {applyTransaction, childPath, checkOBSIdle, probeOBS};
if (require.main === module) main(process.argv[2]).catch(() => { process.exitCode = 1; });
