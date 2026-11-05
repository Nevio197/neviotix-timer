'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {Updater,REPOSITORY,REQUIRED_FILES,compareVersions,validateManifest,readVerifiedZip,crc32,sha256} = require('./updater.cjs');
const {applyTransaction,checkOBSIdle} = require('./apply-update.cjs');

const roots=[];
function temp(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'neviotix-updater-test-'));roots.push(root);return root;}
test.after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true});});

function zip(entries,{deflated=false}={}){
  const data=[],directory=[];
  let offset=0;
  for(const [name,content] of entries){
    const filename=Buffer.from(name),bytes=Buffer.from(content),crc=crc32(bytes),packed=deflated?zlib.deflateRawSync(bytes):bytes,method=deflated?8:0;
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(method,8);header.writeUInt32LE(crc,14);header.writeUInt32LE(packed.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    data.push(header,filename,packed);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);central.writeUInt32LE(offset,42);directory.push(central,filename);
    offset+=header.length+filename.length+packed.length;
  }
  const center=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(center.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...data,center,end]);
}
function fixture(version='1.1.0',extraEntries=[]){
  const entries=REQUIRED_FILES.map(name=>[name,Buffer.from(name==='package.json'?JSON.stringify({name:'neviotix-timer',version}):'new '+name)]);
  const archive=zip([...entries,...extraEntries]);
  const name=`NEVIOTIX-Timer-${version}-windows.zip`;
  const manifest={schemaVersion:1,version,repository:REPOSITORY,asset:{name,size:archive.length,sha256:sha256(archive)},files:entries.map(([path,bytes])=>({path,size:bytes.length,sha256:sha256(bytes)}))};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  const url=file=>`https://github.com/${REPOSITORY}/releases/download/v${version}/${file}`;
  const release={tag_name:'v'+version,draft:false,prerelease:false,html_url:`https://github.com/${REPOSITORY}/releases/tag/v${version}`,assets:[{name,size:archive.length,browser_download_url:url(name),digest:'sha256:'+sha256(archive)},{name:'update-manifest.json',size:manifestBytes.length,browser_download_url:url('update-manifest.json')}]};
  const responses=new Map([[`https://api.github.com/repos/${REPOSITORY}/releases/latest`,Buffer.from(JSON.stringify(release))],[url(name),archive],[url('update-manifest.json'),manifestBytes]]);
  const calls=[];
  const fetchImpl=async(url,options)=>{calls.push({url,options});const value=responses.get(url);if(!value)return new Response('missing',{status:404});return new Response(value,{status:200});};
  return {entries,archive,manifest,manifestBytes,release,responses,fetchImpl,calls,url};
}
function updater(f,more={}){
  const root=temp(),installDir=path.join(root,'install');fs.mkdirSync(installDir);fs.writeFileSync(path.join(installDir,'apply-update.cjs'),'trusted current helper');
  return new Updater({installDir,dataDir:path.join(root,'updates'),currentVersion:'1.0.0',fetchImpl:f.fetchImpl,...more});
}

test('stable versions compare numerically and reject prerelease or malformed versions',()=>{
  assert.equal(compareVersions('1.10.0','1.2.9'),1);
  assert.equal(compareVersions('1.1.0','1.1.0'),0);
  assert.equal(compareVersions('1.0.9','1.1.0'),-1);
  assert.throws(()=>compareVersions('1.1.0-beta','1.0.0'));
  assert.throws(()=>compareVersions('01.1.0','1.0.0'));
});
test('ZIP CRC matches the standard vector and deflated releases are verified correctly',()=>{
  assert.equal(crc32(Buffer.from('123456789')),0xcbf43926);
  const f=fixture(),archive=zip(f.entries,{deflated:true});
  f.manifest.asset={...f.manifest.asset,size:archive.length,sha256:sha256(archive)};
  const result=readVerifiedZip(archive,f.manifest);
  for(const [name,bytes] of f.entries)assert.deepEqual(result.get(name),bytes);
});
test('check and prepare verify the pinned GitHub release, archive and every staged file',async()=>{
  const f=fixture(),u=updater(f);
  assert.equal((await u.check()).status,'available');
  assert.equal((await u.prepare()).status,'ready');
  for(const [name,bytes] of f.entries)assert.deepEqual(fs.readFileSync(path.join(u.prepared.filesDir,name)),bytes);
  assert.equal(fs.readFileSync(path.join(u.prepared.stageDir,'runner.cjs'),'utf8'),'trusted current helper');
  assert.ok(f.calls.every(call=>call.options.redirect==='manual'&&!('Authorization'in call.options.headers)));
});
test('a current or older release never stages a downgrade',async()=>{
  const f=fixture('1.0.0'),u=updater(f,{currentVersion:'1.1.0'});
  assert.equal((await u.check()).status,'current');
  assert.equal(u.state().available,false);
  await assert.rejects(u.prepare(),/Keine neuere Version/);
  assert.equal(u.prepared,null);
});
test('foreign repository download URLs are rejected before any asset request',async()=>{
  const f=fixture();f.release.assets[0].browser_download_url='https://github.com/another/repository/releases/download/v1.1.0/test.zip';f.responses.set(`https://api.github.com/repos/${REPOSITORY}/releases/latest`,Buffer.from(JSON.stringify(f.release)));
  const u=updater(f);await assert.rejects(u.check(),/Repository/);assert.equal(f.calls.length,1);
});
test('canonical GitHub owner capitalization is accepted and actual asset URLs are retained',async()=>{
  const f=fixture();
  f.release.html_url=f.release.html_url.replace('/nevio197/','/Nevio197/');
  for(const asset of f.release.assets){const old=asset.browser_download_url;asset.browser_download_url=old.replace('/nevio197/','/Nevio197/');f.responses.set(asset.browser_download_url,f.responses.get(old));}
  f.responses.set(`https://api.github.com/repos/${REPOSITORY}/releases/latest`,Buffer.from(JSON.stringify(f.release)));
  const u=updater(f,{repo:'Nevio197/neviotix-timer'});
  assert.equal((await u.check()).releaseURL,f.release.html_url);
  await u.prepare();
  assert.ok(f.calls.filter(c=>c.url.includes('/releases/download/')).every(c=>c.url.includes('/Nevio197/')));
});
test('an unsafe redirect is rejected without following it',async()=>{
  const f=fixture();const u=updater(f,{fetchImpl:async()=>new Response(null,{status:302,headers:{location:'http://localhost:1/private'}})});
  await assert.rejects(u.check(),/Unsicherer Update-Download/);
});
test('manifest traversal, duplicate paths, oversized files and missing runtime files fail closed',()=>{
  const f=fixture();
  for(const mutate of [m=>m.files[0].path='../state.json',m=>m.files.push({...m.files[0]}),m=>m.files[0].size=99*1024*1024,m=>m.files.splice(0,1)]){
    const manifest=structuredClone(f.manifest);mutate(manifest);assert.throws(()=>validateManifest(manifest,'1.1.0',f.release.assets[0]));
  }
});
test('archive damage or unlisted ZIP entries are never extracted',()=>{
  const f=fixture(),bad=Buffer.from(f.archive);bad[31]^=1;
  assert.throws(()=>readVerifiedZip(bad,f.manifest),/Prüfsumme/);
  const foreign=fixture('1.1.0',[['../state.json','private']]);assert.throws(()=>readVerifiedZip(foreign.archive,foreign.manifest),/ZIP-Pfad/);
  const extra=fixture('1.1.0',[['version.json','unlisted']]);assert.throws(()=>readVerifiedZip(extra.archive,extra.manifest),/Manifest/);
});
test('file hash mismatch is rejected even when the archive hash matches',()=>{
  const f=fixture();f.manifest.files[0].sha256='0'.repeat(64);
  assert.throws(()=>readVerifiedZip(f.archive,f.manifest),/Prüfsumme einer Update-Datei/);
});
test('a package reporting a different version cannot be staged',async()=>{
  const f=fixture();
  const entries=f.entries.map(([name,bytes])=>[name,name==='package.json'?Buffer.from(JSON.stringify({version:'9.0.0'})):bytes]);
  const archive=zip(entries);
  f.manifest.asset={...f.manifest.asset,size:archive.length,sha256:sha256(archive)};
  f.manifest.files=entries.map(([name,bytes])=>({path:name,size:bytes.length,sha256:sha256(bytes)}));
  f.release.assets[0].size=archive.length;f.release.assets[0].digest='sha256:'+sha256(archive);
  const manifest=Buffer.from(JSON.stringify(f.manifest));f.release.assets[1].size=manifest.length;
  f.responses.set(f.url(f.manifest.asset.name),archive);f.responses.set(f.url('update-manifest.json'),manifest);f.responses.set(`https://api.github.com/repos/${REPOSITORY}/releases/latest`,Buffer.from(JSON.stringify(f.release)));
  const u=updater(f);await u.check();await assert.rejects(u.prepare(),/Paketversion/);assert.equal(u.prepared,null);
});
test('active stream guard prevents preparation before downloading an update',async()=>{
  const f=fixture(),u=updater(f,{canInstall:()=>false});
  await u.check();await assert.rejects(u.prepare(),/Stream und Aufnahme/);assert.equal(f.calls.length,1);assert.equal(u.prepared,null);
});
function transaction(){
  const root=temp(),installDir=path.join(root,'install'),stageDir=path.join(root,'stage'),filesDir=path.join(stageDir,'files');fs.mkdirSync(installDir);fs.mkdirSync(filesDir,{recursive:true});
  fs.writeFileSync(path.join(installDir,'server.cjs'),'old server');fs.writeFileSync(path.join(installDir,'state.json'),'personal state');
  const files=[['server.cjs','new server'],['core.cjs','new core']].map(([name,content])=>{const bytes=Buffer.from(content);fs.writeFileSync(path.join(filesDir,name),bytes);return {path:name,size:bytes.length,sha256:sha256(bytes)};});
  return {installDir,stageDir,filesDir,oldVersion:'1.0.0',manifest:{version:'1.1.0',files}};
}
test('apply replaces only approved application files, preserving timer data',()=>{
  const job=transaction();const result=applyTransaction(job);assert.equal(result.status,'installed');assert.equal(fs.readFileSync(path.join(job.installDir,'server.cjs'),'utf8'),'new server');assert.equal(fs.readFileSync(path.join(job.installDir,'state.json'),'utf8'),'personal state');assert.equal(fs.readFileSync(path.join(result.backup,'server.cjs'),'utf8'),'old server');
});
test('an interrupted replacement rolls back changed files and removes newly added ones',()=>{
  const job=transaction();let calls=0;
  assert.throws(()=>applyTransaction(job,{copyFile:(from,to)=>{calls+=1;if(calls===2)throw new Error('simulated locked file');fs.copyFileSync(from,to);}}),error=>error.result.status==='rolled-back');
  assert.equal(fs.readFileSync(path.join(job.installDir,'server.cjs'),'utf8'),'old server');assert.equal(fs.existsSync(path.join(job.installDir,'core.cjs')),false);assert.equal(fs.readFileSync(path.join(job.installDir,'state.json'),'utf8'),'personal state');
});
test('changed staged content aborts before modifying installation',()=>{
  const job=transaction();fs.writeFileSync(path.join(job.filesDir,'server.cjs'),'changed');assert.throws(()=>applyTransaction(job),/verändert/);assert.equal(fs.readFileSync(path.join(job.installDir,'server.cjs'),'utf8'),'old server');
});
test('the apply helper independently refuses active or unknown OBS state and allows closed OBS',async()=>{
  assert.equal(await checkOBSIdle({isRunning:()=>false,readConfig:()=>{throw new Error('should not read');}}),true);
  assert.equal(await checkOBSIdle({isRunning:()=>true,readConfig:()=>({}),probe:async()=>true}),true);
  assert.equal(await checkOBSIdle({isRunning:()=>true,readConfig:()=>({}),probe:async()=>false}),false);
  assert.equal(await checkOBSIdle({isRunning:()=>{throw new Error('status unavailable');}}),false);
});
