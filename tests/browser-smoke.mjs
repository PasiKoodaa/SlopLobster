
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const candidates=[process.env.PROGRAMFILES+'/Google/Chrome/Application/chrome.exe',process.env['PROGRAMFILES(X86)']+'/Microsoft/Edge/Application/msedge.exe',process.env.PROGRAMFILES+'/Microsoft/Edge/Application/msedge.exe'];
const executable=candidates.find(p=>fs.existsSync(p));
if(!executable) throw new Error('No installed Chromium browser for the UI smoke test');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'sloplobster-ui-'));
const child=spawn(executable,['--headless','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true});
let socket;
try {
 const endpoint=await new Promise((resolve,reject)=>{
  let log=''; const timer=setTimeout(()=>reject(new Error('Browser startup timed out')),15000);
  child.stderr.on('data',data=>{log+=data;const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
  child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(new Error('Browser exited '+code));});
 });
 socket=new WebSocket(endpoint);
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let serial=0, navigationCount=0; const pending=new Map(),errors=[];
 socket.addEventListener('message',event=>{
  const message=JSON.parse(event.data);
  if(message.method==='Page.loadEventFired') navigationCount++;
  if(message.id){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result);}}
  if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
 });
 const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,sessionId}));});
 const target=await call('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await call('Target.attachToTarget',{targetId:target.targetId,flatten:true});
 await call('Runtime.enable',{},sessionId); await call('Page.enable',{},sessionId);
 const evaluate=async expression=>{
  const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);
  return result.result.value;
 };
 await call('Page.navigate',{url:pathToFileURL(path.resolve('SlopLobster.html')).href},sessionId);
 const deadline=Date.now()+25000;
 while(Date.now()<deadline){if(await evaluate("!!document.getElementById('harness-features')"))break;await new Promise(resolve=>setTimeout(resolve,200));}
 await evaluate('openHarnessFeatures()');
 if(!await evaluate("document.getElementById('harness-features').open"))throw new Error('Harness dialog did not open');
 for(const tab of ['isolation','evidence','recipes','queue','knowledge','evaluations','options']){
  await evaluate("harnessFeatureState.tab="+JSON.stringify(tab)+";renderHarnessFeatures()");
  if(!await evaluate("document.querySelector('#harness-features .hf-content').innerText.length>0"))throw new Error('Empty tab: '+tab);
 }
 await evaluate("document.getElementById('hf-option-queue').checked=true;harnessFeatureAction('save-options','')");
 if(!await evaluate("harnessFeatureState.prefs.queue && JSON.parse(localStorage.getItem('SlopLobster_features')).queue"))throw new Error('Option did not save');
 await evaluate("state.conversations=[{id:'delete-test',title:'Old',messages:[]},{id:'keep-test',title:'Keep',messages:[]}];state.activeConvId='keep-test';state.messages=[];saveConversations()");
 await evaluate("deleteConv('delete-test',{stopPropagation(){}})");
 if(await evaluate("dbGet('conversations','delete-test').then(Boolean)"))throw new Error('Deleted conversation remains in IndexedDB');
 const priorNavigation=navigationCount;
 await call('Page.reload',{},sessionId);
 const loadDeadline=Date.now()+15000;
 while(navigationCount===priorNavigation && Date.now()<loadDeadline) await new Promise(resolve=>setTimeout(resolve,50));
 if(navigationCount===priorNavigation)throw new Error('Reload did not finish');
 const reloadDeadline=Date.now()+10000;
 while(Date.now()<reloadDeadline){if(await evaluate("document.getElementById('harness-features') && state.conversations.some(c=>c.id==='keep-test')"))break;await new Promise(resolve=>setTimeout(resolve,100));}
 if(await evaluate("state.conversations.some(c=>c.id==='delete-test')"))throw new Error('Deleted conversation returned after reload');
 await evaluate(`globalThis.originalCompanionFetch=fetch;globalThis.originalGitCheck=checkGitRepo;checkGitRepo=()=>{};fetch=async(url,options={})=>{
  if(String(url)===state.compUrl+'/status') {
   const auth=new Headers(options.headers).get('Authorization');
   return auth==='Bearer pairing-test-token'?new Response(JSON.stringify({version:'1.6.0',command_lifecycle:true,platform:'Test',release:'',python:'3',cwd:'fixture'}),{status:200,headers:{'Content-Type':'application/json'}}):new Response(JSON.stringify({error:'Pair this companion'}),{status:401,headers:{'Content-Type':'application/json'}});
  }return originalCompanionFetch(url,options);
 };state.compToken='';updateCompanionPairing('missing');`);
 if(!await evaluate("!document.getElementById('companion-pairing').hidden && document.getElementById('companion-pair-title').textContent.includes('not set')"))throw new Error('Missing token has no visible warning');
 await evaluate("document.getElementById('companion-pair-token').value='wrong-token';pairCompanionFromBanner()");
 if(!await evaluate("!state.compConnected && document.getElementById('companion-pair-title').textContent.includes('rejected')"))throw new Error('Invalid token was not explained');
 await evaluate("document.getElementById('companion-pair-token').value='pairing-test-token';pairCompanionFromBanner()");
 if(!await evaluate("state.compConnected && document.getElementById('companion-pairing').hidden && !document.getElementById('companion-pair-token').value && document.getElementById('s-comp-token').value==='pairing-test-token'"))throw new Error('Successful pairing did not clear warning or sync Settings');
 await evaluate("state.compToken='';updateCompanionPairing('unauthorized')");
 await new Promise(resolve=>setTimeout(resolve,100));
 if(!await evaluate("(()=>{const button=document.getElementById('companion-pair-submit'),r=button.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===button;})()"))throw new Error('Preview panel covers pairing button');
 const pairShot=await call('Page.captureScreenshot',{format:'png'},sessionId);
 fs.writeFileSync(path.resolve('tests/companion-pairing.png'),Buffer.from(pairShot.data,'base64'));
 await evaluate("updateCompanionPairing('connected');fetch=originalCompanionFetch;checkGitRepo=originalGitCheck;openHarnessFeatures()");
 const shot=await call('Page.captureScreenshot',{format:'png'},sessionId);
 fs.writeFileSync(path.resolve('tests/harness-panel.png'),Buffer.from(shot.data,'base64'));
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser: Harness dialog, seven tabs, option persistence, permanent conversation deletion, and token pairing pass.');
 await call('Browser.close');
} finally {
 socket?.close(); child.kill();
 // Profile cleanup is limited to the exact temporary directory created above.
 if(path.dirname(profile)===os.tmpdir()&&path.basename(profile).startsWith('sloplobster-ui-')){
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch{}
 }
}
