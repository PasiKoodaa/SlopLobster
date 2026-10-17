
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
 const reload=async()=>{
  const previous=navigationCount;await call('Page.reload',{},sessionId);
  const deadline=Date.now()+15000;
  while(navigationCount===previous&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  if(navigationCount===previous)throw new Error('Reload did not finish');
 };
 await call('Page.navigate',{url:pathToFileURL(path.resolve('SlopLobster.html')).href},sessionId);
 const deadline=Date.now()+25000;
 while(Date.now()<deadline){if(await evaluate("!!document.getElementById('harness-features')"))break;await new Promise(resolve=>setTimeout(resolve,200));}
 await evaluate('openHarnessFeatures()');
 if(!await evaluate("document.getElementById('harness-features').open"))throw new Error('Harness dialog did not open');
 for(const tab of ['isolation','evidence','journal','recipes','queue','knowledge','evaluations','options']){
  await evaluate("harnessFeatureState.tab="+JSON.stringify(tab)+";renderHarnessFeatures()");
  if(!await evaluate("document.querySelector('#harness-features .hf-content').innerText.length>0"))throw new Error('Empty tab: '+tab);
 }
 await evaluate("document.getElementById('hf-option-queue').checked=true;harnessFeatureAction('save-options','')");
 if(!await evaluate("harnessFeatureState.prefs.queue && JSON.parse(localStorage.getItem('SlopLobster_features')).queue"))throw new Error('Option did not save');
 await evaluate("state.conversations=[{id:'delete-test',title:'Old',messages:[]},{id:'keep-test',title:'Keep',messages:[]}];state.activeConvId='keep-test';state.messages=[];saveConversations()");
 await evaluate("deleteConv('delete-test',{stopPropagation(){}})");
 if(await evaluate("dbGet('conversations','delete-test').then(Boolean)"))throw new Error('Deleted conversation remains in IndexedDB');
 const priorNavigation=navigationCount;
 await reload();
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
 await evaluate(`(async()=>{
   const saved={fetch,model:state.model,connected:state.connected,controller:state.runController,tokenBudget:state.tokenBudget};
   try {
     applySafetyProfileByName('Minimal / Low-Context');
     const compact=getToolDefs().map(t=>t.function.name);
     if(compact.includes('think')||compact.includes('deep_research')||!compact.includes('run_tests'))throw Error('Compact tool selection is wrong');
     await toolHandlers.get_tool_schema({tool_name:'deep_research'});
     if(!getToolDefs().some(t=>t.function.name==='deep_research'))throw Error('Specialist schema did not load');
     state.disabledTools.add('deep_research');
     if(!(await toolHandlers.get_tool_schema({tool_name:'deep_research'})).output.includes('not found'))throw Error('Discovery bypassed disabled tool');
     state.model='fixture';state.connected=true;state.tokenBudget=0;state.runController=HarnessRunState.create();
     fetch=async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:'Fixture complete'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:4}})+'\\n\\ndata: [DONE]\\n\\n');
     const result=await streamChat([{role:'user',content:'Explain this fixture'}],()=>{},()=>{});
     if(result.content!=='Fixture complete'||state.runController.snapshot().outputTokens!==4)throw Error('Main model transport did not account for its response');
     if(!state._lastPromptBreakdown.schemas||state._lastPromptBreakdown.instructions<=0)throw Error('Prompt breakdown is missing');
     await executeTool('get_tool_schema',JSON.stringify({tool_name:'read_file'}));
     const runId=state.runController.snapshot().id;
     await Promise.all([1,2].map(n=>appendJournalEvent({id:crypto.randomUUID(),version:1,runId,convId:state.activeConvId,objective:'Concurrent append fixture',type:'diagnostic.concurrent',created:Date.now(),detail:{n}})));
     const journal=await loadRunJournal(runId);
     if(!journal.some(e=>e.type==='model.started')||!journal.some(e=>e.type==='model.completed')||!journal.some(e=>e.type==='tool.completed'))throw Error('Run events did not persist');
     if(journal.some((e,i)=>e.seq!==i+1))throw Error('Journal sequence is not contiguous');
     await refreshRunJournals(runId);harnessFeatureState.tab='journal';renderHarnessFeatures();
     if(!document.querySelector('#harness-features .hf-content').textContent.includes('model.completed'))throw Error('Journal timeline is empty');
     globalThis.journalSmokeRun=runId;
     globalThis.journalSmokeEvents=journal.length;
     openSettings();
     if(!document.getElementById('s-compact-tools').checked||!document.getElementById('s-compact-prompt').checked)throw Error('Compact settings are not visible');
     closeSettings();
   } finally {fetch=saved.fetch;state.model=saved.model;state.connected=saved.connected;state.runController=saved.controller;state.tokenBudget=saved.tokenBudget;applySafetyProfileByName('Balanced (default)');}
 })()`);
 await evaluate(`(async()=>{
   const saved={chat:streamChat,exec:execViaCompanion,write:toolHandlers.write_file,command:state.autoVerifyCommand,comp:state.compConnected,max:state.maxIters,controller:state.runController,task:state.taskState,disabled:state.disabledTools};
   const order=[];let modelTurns=0,checks=0;
   try {
     state.runController=HarnessRunState.create();state.taskState=null;state.verificationState=null;state.messages=[];
     state.autoVerifyCommand='fixture-tests';state.compConnected=true;state.maxIters=4;state.disabledTools=new Set();
     execViaCompanion=async()=>{order.push(checks?'check':'baseline');checks++;return {status:'error',exitCode:1,output:'FAILED tests/fixture.py::'+(checks===1?'old':'new')+' - failure\\n1 failed in 0.01s'};};
     toolHandlers.write_file=async()=>{order.push('write');return {status:'ok',output:'Applied fixture edit'};};
     streamChat=async()=>{
       if(modelTurns++===0)return {content:'',toolCalls:[{id:'fixture-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'journal-fixture.txt',content:'fixture'})}}],usage:{out:1}};
       const index=state.messages.findIndex(m=>m.role==='assistant'&&m.tool_calls?.some(t=>t.id==='fixture-write'));
       if(state.messages[index+1]?.role!=='tool')throw Error('Verification context interrupted tool result ordering');
       if(!state.messages.some(m=>m.content?.includes('AUTO-VERIFY REGRESSION')))throw Error('The new failure was not passed to the model');
       return {content:'Fixture finished with a regression requiring review.',toolCalls:[],usage:{out:1}};
     };
     await agentLoop();
     if(order.join(',')!=='baseline,write,check')throw Error('Baseline was not captured before editing: '+order);
     if(state.verificationState.latest?.comparison.outcome!=='regression')throw Error('New failure was not classified');
     if(activeEvidence()?.outcome!=='needs_review')throw Error('The regression was incorrectly reported as verified');
     const events=await loadRunJournal(state.runController.snapshot().id);
     for(const kind of ['run.started','verification.baseline','tool.started','tool.completed','verification.result','run.finished'])if(!events.some(e=>e.type===kind))throw Error('Missing journal event '+kind);
   } finally {streamChat=saved.chat;execViaCompanion=saved.exec;toolHandlers.write_file=saved.write;state.autoVerifyCommand=saved.command;state.compConnected=saved.comp;state.maxIters=saved.max;state.runController=saved.controller;state.taskState=saved.task;state.disabledTools=saved.disabled;}
 })()`);
 const shot=await call('Page.captureScreenshot',{format:'png'},sessionId);
 fs.writeFileSync(path.resolve('tests/harness-panel.png'),Buffer.from(shot.data,'base64'));
 if(errors.length)throw new Error(errors.join('\n'));
 await reload();
 const journalDeadline=Date.now()+10000;
 while(Date.now()<journalDeadline){if(await evaluate("typeof loadRunJournal==='function' && typeof state!=='undefined'"))break;await new Promise(resolve=>setTimeout(resolve,100));}
 if(!await evaluate("dbGetAll('run_journals').then(runs=>runs.length>0)"))throw new Error('Journal vanished after reload');
 await evaluate("deleteConv('keep-test',{stopPropagation(){}})");
 if(await evaluate("dbGetAll('run_journals').then(runs=>runs.some(r=>r.convId==='keep-test'))"))throw new Error('Conversation deletion kept its journals');
 if(await evaluate("dbGetAll('run_events').then(events=>events.some(e=>e.convId==='keep-test'))"))throw new Error('Conversation deletion kept journal events');
 await evaluate(`(async()=>{
   const database=await getDB();database.close();_dbInstance=null;
   await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase(DB_NAME);r.onsuccess=resolve;r.onerror=reject;r.onblocked=()=>reject(Error('Database deletion blocked by another connection'));});
   await new Promise((resolve,reject)=>{
     const request=indexedDB.open(DB_NAME,1);
     request.onblocked=()=>reject(Error('Legacy fixture database creation was blocked'));
     request.onupgradeneeded=()=>{request.result.createObjectStore('conversations',{keyPath:'id'});request.result.createObjectStore('agent_states',{keyPath:'id'});request.result.createObjectStore('settings',{keyPath:'key'});};
     request.onerror=reject;request.onsuccess=()=>{const db=request.result,tx=db.transaction('conversations','readwrite');tx.objectStore('conversations').put({id:'legacy-migration-fixture',title:'Legacy',messages:[]});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=reject;};
   });
 })()`);
 await reload();
 const migrationDeadline=Date.now()+10000;
 while(Date.now()<migrationDeadline){if(await evaluate("typeof getDB==='function'"))break;await new Promise(resolve=>setTimeout(resolve,100));}
 if(!await evaluate("getDB().then(db=>db.version===2&&db.objectStoreNames.contains('run_events'))"))throw new Error('Journal database migration did not run');
 if(!await evaluate("dbGet('conversations','legacy-migration-fixture').then(Boolean)"))throw new Error('Journal migration lost an existing conversation');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Browser: eight Harness tabs, persisted journal timeline, journal deletion, compact tools, model transport, and token pairing pass.');
 await call('Browser.close');
} finally {
 socket?.close(); child.kill();
 // Profile cleanup is limited to the exact temporary directory created above.
 if(path.dirname(profile)===os.tmpdir()&&path.basename(profile).startsWith('sloplobster-ui-')){
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch{}
 }
}
