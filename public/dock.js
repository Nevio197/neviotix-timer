(()=>{'use strict';
const $=id=>document.getElementById(id);
let token='',state=null,events=null,ready=false,reconnectTimer=null,toastTimer=null,durationDirty=false,displayMode='duration',lastDuration=null,queue=Promise.resolve();
let updateState=null,updateBusy=false,updatePoll=null,updateRecoveryStarted=0,seenAppVersion='';
const debounces=new Map();
function notify(message,error=false){const el=$('toast');clearTimeout(toastTimer);el.textContent=message;el.classList.toggle('error',error);el.hidden=false;toastTimer=setTimeout(()=>{el.hidden=true;},error?5000:2200);}
function connection(online){const el=$('connection');if(ready===online&&el.dataset.connected===String(online))return;ready=online;el.dataset.connected=String(online);document.body.classList.toggle('offline',!online);el.className='connection '+(online?'connected':'offline');$('connection-label').textContent=online?'Verbunden':'Offline';$('toggle').disabled=!online;}
function safeSet(el,value){if(document.activeElement!==el)el.value=value;}
function durationParts(seconds){return [Math.floor(seconds/3600),Math.floor(seconds/60)%60,Math.floor(seconds)%60];}
function setMode(mode){displayMode=mode;$('duration-form').hidden=mode!=='duration';$('clock-form').hidden=mode!=='clock';$('presets').hidden=mode!=='duration';for(const name of ['duration','clock']){$('mode-'+name).classList.toggle('selected',name===mode);$('mode-'+name).setAttribute('aria-pressed',String(name===mode));}}
function fillScenes(select,scenes,selected,empty){const signature=JSON.stringify([scenes,selected]);if(select.dataset.signature===signature)return;select.dataset.signature=signature;const unique=[...new Set(scenes)];if(selected&&!unique.includes(selected))unique.push(selected);select.replaceChildren();const first=document.createElement('option');first.value='';first.textContent=empty;select.append(first);for(const scene of unique){const opt=document.createElement('option');opt.value=scene;opt.textContent=scene;select.append(opt);}select.value=selected||'';}
function render(next){if(!next||typeof next!=='object')return;if(typeof next.appVersion==='string'&&next.appVersion){if(seenAppVersion&&seenAppVersion!==next.appVersion){location.reload();return;}seenAppVersion=next.appVersion;}state=next;const d=state.design||{},a=state.automation||{},obs=state.obs||{};const accent=/^#[\da-f]{6}$/i.test(d.accent||'')?d.accent:'#b7ff5b';document.documentElement.style.setProperty('--accent',accent);const rgb=accent.slice(1).match(/../g).map(v=>parseInt(v,16)).join(',');document.documentElement.style.setProperty('--accent-rgb',rgb);
const late=Number(state.remainingMs)<0;const message=state.finished&&!state.overtime&&state.finishMessage;$('timer-card').classList.toggle('overtime',late);$('timer-readout').textContent=message||state.displayText||'00:00';$('timer-readout').classList.toggle('message',Boolean(message));$('timer-state').textContent=late?'VERLÄNGERUNG':state.running?'LÄUFT':state.finished?'ABGELAUFEN':Number(state.remainingMs)<Number(state.durationMs)-50?'PAUSIERT':'BEREIT';$('timer-detail').textContent=state.mode==='clock'?'Bis '+(state.targetTime||'—')+' Uhr':'Countdown';const progress=Math.max(0,Math.min(1,Number(state.progress)||0));$('progress-fill').style.width=(progress*100)+'%';$('progress').setAttribute('aria-valuenow',String(Math.round(progress*100)));$('toggle-icon').setAttribute('href',state.running?'#i-pause':'#i-play');$('toggle-label').textContent=state.running?'Pausieren':state.finished&&!state.overtime?'Neu starten':Number(state.remainingMs)<Number(state.durationMs)-50?'Fortsetzen':'Starten';$('toggle').title='Timer '+(state.running?'pausieren':'starten')+' (Leertaste)';$('visibility-icon').setAttribute('href',state.visible===false?'#i-hidden':'#i-eye');$('visibility').setAttribute('aria-pressed',String(state.visible!==false));$('visibility').setAttribute('aria-label',state.visible===false?'Anzeige einblenden':'Anzeige ausblenden');$('overtime').checked=Boolean(state.overtime);
if(lastDuration!==state.durationMs&&!durationDirty){const parts=durationParts(Math.max(0,Math.round(Number(state.durationMs||0)/1000)));['hours','minutes','seconds'].forEach((id,i)=>safeSet($(id),String(parts[i]).padStart(2,'0')));lastDuration=state.durationMs;}if(!durationDirty&&state.mode&&displayMode!==state.mode)setMode(state.mode);safeSet($('target-time'),state.targetTime||'20:00');for(const b of document.querySelectorAll('[data-seconds]'))b.classList.toggle('active',state.mode==='duration'&&Number(b.dataset.seconds)*1000===Number(state.durationMs));
for(const b of document.querySelectorAll('[data-theme]')){const active=b.dataset.theme===(d.theme||'minimal');b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}safeSet($('accent'),accent);$('accent-value').textContent=accent.toUpperCase();safeSet($('font-size'),d.fontSize||64);$('font-size-value').value=String(d.fontSize||64);$('show-label').checked=d.showLabel!==false;$('show-progress').checked=d.showProgress!==false;safeSet($('overlay-label'),d.label??'LIVE IN');safeSet($('finish-message'),state.finishMessage||'');$('overlay-label').disabled=d.showLabel===false;
$('obs-status').textContent=obs.connected?'OBS verbunden':'OBS nicht verbunden';$('obs-scene').textContent=obs.connected?(obs.currentScene?'Aktiv: '+obs.currentScene:'Keine Szene aktiv'):'Timer und Anzeige sind weiter nutzbar';$('obs-dot').classList.toggle('online',Boolean(obs.connected));const sceneNames=(obs.scenes||[]).map(s=>typeof s==='string'?s:s.sceneName).filter(Boolean);fillScenes($('finish-scene'),sceneNames,a.finishScene,'Kein Szenenwechsel');fillScenes($('auto-start-scene'),sceneNames,a.autoStartScene,'Nur manuell starten');}
async function refreshBootstrap(){const response=await fetch('/api/bootstrap',{cache:'no-store'});if(!response.ok)throw new Error('Der Timer ist gerade nicht verbunden.');const data=await response.json();token=data.token;render(data.state);connection(true);return data;}
function action(actionName,data={},success){queue=queue.catch(()=>{}).then(async()=>{if(!token)await refreshBootstrap();const send=()=>fetch('/api/action',{method:'POST',headers:{'Content-Type':'application/json','X-NEVIOTIX-Token':token},body:JSON.stringify({action:actionName,...data})});let response=await send();if(response.status===403){await refreshBootstrap();response=await send();}let payload;try{payload=await response.json();}catch{throw new Error('Die Änderung konnte nicht übernommen werden.');}if(!response.ok)throw new Error(payload.error||'Die Änderung konnte nicht übernommen werden.');if(payload.state)render(payload.state);else if('remainingMs'in payload)render(payload);if(success)notify(success);return payload;}).catch(error=>{notify(error.message||'Keine Verbindung zum Timer.',true);});return queue;}
function debounce(key,fn,ms=250){clearTimeout(debounces.get(key));debounces.set(key,setTimeout(fn,ms));}
async function boot(){clearTimeout(reconnectTimer);try{await refreshBootstrap();if(events)events.close();events=new EventSource('/api/events');events.addEventListener('state',event=>{try{render(JSON.parse(event.data));if(token)connection(true);}catch{}});events.onopen=async()=>{token='';connection(false);try{await refreshBootstrap();}catch{connection(false);}};events.onerror=()=>{token='';connection(false);};}catch{token='';connection(false);reconnectTimer=setTimeout(boot,1800);}}
function updatesVisible(){return !$('panel-updates').hidden&&!document.hidden;}
function updateStatus(value){
  updateState=value&&typeof value==='object'?value:{};
  const status=String(updateState.status||'idle');
  const labels={idle:'Bereit',unchecked:'Bereit',checking:'Suche läuft',uptodate:'Aktuell',available:'Update verfügbar',downloading:'Wird geladen',restarting:'Neustart',error:'Nicht verfügbar'};
  const defaults={idle:'Suche nach einer neuen Version, wenn du bereit bist.',unchecked:'Suche nach einer neuen Version, wenn du bereit bist.',checking:'Die neueste Version wird gesucht …',uptodate:'Du hast die neueste Version.',available:'Eine neue Version ist für deinen Timer verfügbar.',downloading:'Das Update wird heruntergeladen und geprüft …',restarting:'Dein Timer startet gleich wieder.',error:'Das Update konnte gerade nicht geprüft werden. Versuch es erneut.'};
  const busy=updateBusy||['checking','downloading','restarting'].includes(status);
  $('update-current').textContent=String(updateState.currentVersion||'1.1.0');
  $('update-latest').textContent=String(updateState.latestVersion||'—');
  $('update-badge').textContent=labels[status]||'Bereit';
  $('update-badge').className='update-badge '+(['available','uptodate','error','downloading','restarting'].includes(status)?status:'');
  $('update-message').textContent=String(updateState.message||defaults[status]||defaults.idle);
  $('update-check').disabled=busy;
  $('update-check').textContent=status==='checking'?'Suche läuft …':'Nach Updates suchen';
  $('update-install').hidden=!updateState.available&&!['downloading','restarting'].includes(status);
  $('update-install').disabled=busy;
  $('update-install').textContent=status==='downloading'?'Update wird geladen …':status==='restarting'?'Timer startet neu …':'Update installieren';
  $('update-restart-note').hidden=!updateState.available&&!['downloading','restarting'].includes(status);
  const raw=Number(updateState.progress)||0;
  const progress=Math.max(0,Math.min(100,raw<=1?raw*100:raw));
  $('update-progress').hidden=!['downloading','restarting'].includes(status);
  $('update-progress').setAttribute('aria-valuenow',String(Math.round(progress)));
  $('update-progress-fill').style.width=progress+'%';
  const notes=String(updateState.releaseNotes||updateState.notes||'').trim();
  $('update-notes').textContent=notes;
  $('update-notes').hidden=!notes;
  clearTimeout(updatePoll);
  if(updatesVisible()&&['downloading','restarting'].includes(status))updatePoll=setTimeout(()=>readUpdate(true),1000);
}
async function updateRequest(path,write=false){
  if(write&&!token)await refreshBootstrap();
  const send=()=>fetch('/api/update'+path,write?{method:'POST',headers:{'Content-Type':'application/json','X-NEVIOTIX-Token':token},body:'{}'}:{cache:'no-store'});
  let response=await send();
  if(write&&response.status===403){await refreshBootstrap();response=await send();}
  let value;try{value=await response.json();}catch{throw new Error('Die Update-Verbindung ist gerade nicht verfügbar.');}
  if(!response.ok){const error=new Error(value.error||'Die Update-Verbindung ist gerade nicht verfügbar.');error.httpStatus=response.status;throw error;}
  return value.update||value;
}
async function readUpdate(quiet=false){
  try{const value=await updateRequest('');updateRecoveryStarted=0;updateStatus(value);}
  catch(error){
    if(['downloading','restarting'].includes(updateState?.status)&&updatesVisible()&&!error.httpStatus){
      if(!updateRecoveryStarted)updateRecoveryStarted=Date.now();
      if(Date.now()-updateRecoveryStarted<60000){updateStatus({...updateState,status:'restarting',message:'Dein Timer startet gleich wieder.'});return;}
    }
    updateStatus({...updateState,status:'error',message:error.message});
    if(!quiet)notify(error.message,true);
  }
}
async function runUpdate(operation){
  if(updateBusy)return;
  updateBusy=true;
  updateRecoveryStarted=0;
  updateStatus({...updateState,status:operation==='check'?'checking':'downloading',message:'',progress:0});
  try{updateStatus(await updateRequest('/'+operation,true));}
  catch(error){if(operation==='install'&&!error.httpStatus){updateRecoveryStarted=Date.now();updateStatus({...updateState,status:'restarting',message:'Dein Timer startet gleich wieder.'});}else{updateStatus({...updateState,status:'error',message:error.message});notify(error.message,true);}}
  finally{updateBusy=false;updateStatus(updateState);}
}
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{for(const other of document.querySelectorAll('[data-tab]')){const active=other===button;other.classList.toggle('active',active);other.setAttribute('aria-selected',String(active));$('panel-'+other.dataset.tab).hidden=!active;}clearTimeout(updatePoll);if(button.dataset.tab==='updates')readUpdate();}));
$('update-check').addEventListener('click',()=>runUpdate('check'));
$('update-install').addEventListener('click',()=>runUpdate('install'));
$('toggle').addEventListener('click',async()=>{const restart=state?.finished&&!state?.overtime;if(restart){await action('reset');await action('play');}else{action('toggle');}});
$('reset').addEventListener('click',()=>action('reset'));
$('visibility').addEventListener('click',()=>action('options',{patch:{visible:state?.visible===false}}));
$('mode-duration').addEventListener('click',()=>{durationDirty=true;setMode('duration');});$('mode-clock').addEventListener('click',()=>{durationDirty=true;setMode('clock');});
['hours','minutes','seconds'].forEach(id=>$(id).addEventListener('input',()=>{durationDirty=true;}));
$('duration-form').addEventListener('submit',event=>{event.preventDefault();const hours=Math.max(0,Math.min(99,Number($('hours').value)||0)),minutes=Math.max(0,Math.min(59,Number($('minutes').value)||0)),seconds=Math.max(0,Math.min(59,Number($('seconds').value)||0));const total=hours*3600+minutes*60+seconds;if(total<=0){notify('Stell zuerst eine Dauer über 0 ein.',true);return;}durationDirty=false;lastDuration=null;action('set_duration',{seconds:total},'Dauer übernommen');});
$('clock-form').addEventListener('submit',event=>{event.preventDefault();const time=$('target-time').value;if(!time)return;durationDirty=false;action('set_clock',{time},'Zielzeit übernommen');});
document.querySelectorAll('[data-seconds]').forEach(button=>button.addEventListener('click',()=>{durationDirty=false;lastDuration=null;setMode('duration');action('set_duration',{seconds:Number(button.dataset.seconds)});}));
document.querySelectorAll('[data-adjust]').forEach(button=>button.addEventListener('click',()=>action('adjust',{seconds:Number(button.dataset.adjust)})));
$('overtime').addEventListener('change',()=>action('options',{patch:{overtime:$('overtime').checked}}));
document.querySelectorAll('[data-theme]').forEach(button=>button.addEventListener('click',()=>action('design',{patch:{theme:button.dataset.theme}})));
$('accent').addEventListener('input',()=>{const value=$('accent').value;$('accent-value').textContent=value.toUpperCase();debounce('accent',()=>action('design',{patch:{accent:value}}),100);} );
$('font-size').addEventListener('input',()=>{const size=Number($('font-size').value);$('font-size-value').value=String(size);debounce('font-size',()=>action('design',{patch:{fontSize:size}}),100);} );
$('show-label').addEventListener('change',()=>action('design',{patch:{showLabel:$('show-label').checked}}));$('show-progress').addEventListener('change',()=>action('design',{patch:{showProgress:$('show-progress').checked}}));
$('overlay-label').addEventListener('input',()=>{const value=$('overlay-label').value;debounce('overlay-label',()=>action('design',{patch:{label:value}}),300);});
$('finish-message').addEventListener('input',()=>{const value=$('finish-message').value;debounce('finish-message',()=>action('options',{patch:{finishMessage:value}}),300);});
$('finish-scene').addEventListener('change',()=>action('automation',{patch:{finishScene:$('finish-scene').value}}));$('auto-start-scene').addEventListener('change',()=>action('automation',{patch:{autoStartScene:$('auto-start-scene').value}}));
document.addEventListener('keydown',event=>{if(event.altKey||event.ctrlKey||event.metaKey||event.repeat||event.target.closest('input,select,textarea,[contenteditable=true]'))return;if(event.code==='Space'){if(event.target.closest('button'))return;event.preventDefault();$('toggle').click();}else if(event.code==='KeyR'){event.preventDefault();action('reset');}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!ready)boot();clearTimeout(updatePoll);if(updatesVisible())readUpdate(true);});
setInterval(()=>{if(!ready&&(!events||events.readyState===EventSource.CLOSED))boot();},5000);
boot();
})();
