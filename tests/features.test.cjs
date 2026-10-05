const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const F=require('../src/features-core.js');
const H=require('../src/harness-runtime.js');

test('execution features default to opt-in; persisted toggles round trip',()=>{
  assert.equal(F.defaults.isolation,false); assert.equal(F.defaults.queue,false); assert.equal(F.defaults.autoRetrieve,false);
  assert.equal(F.defaults.evidence,true);
  const saved=F.preferences(JSON.parse(JSON.stringify({...F.defaults,isolation:true,queue:true})));
  assert.equal(saved.isolation,true); assert.equal(saved.queue,true);
  assert.equal(F.preferences({unknown:true}).unknown,undefined);
});
test('queue skips a blocked predecessor only for explicitly independent work',()=>{
  const tasks=[{id:'a',status:'blocked'},{id:'b',status:'pending'},{id:'c',status:'pending',independent:true}];
  assert.equal(F.nextQueueTask(tasks).id,'c');
  tasks[0].status='done'; assert.equal(F.nextQueueTask(tasks).id,'b');
});
test('queue budgets are bounded and prompts cannot be empty',()=>{
  assert.throws(()=>F.newQueueTask(''));
  const task=F.newQueueTask('fix',{id:'t',maxIters:999,tokenBudget:999999});
  assert.equal(task.maxIters,200); assert.equal(task.tokenBudget,100000);
});
test('verification requires successful checks after the most recent edit',()=>{
  const events=[{kind:'change',path:'a.js',status:'ok'},{kind:'check',tool:'run_tests',command:'npm test',status:'ok',exitCode:0}];
  assert.equal(F.evidenceSummary(events).verified,true);
  events.push({kind:'change',path:'b.js',status:'ok'});
  assert.equal(F.evidenceSummary(events).verified,false);
  events.push({kind:'check',command:'npm test',status:'ok',exitCode:0});
  assert.equal(F.evidenceSummary(events).verified,true);
  assert.equal(F.evidenceSummary([{kind:'tool',status:'ok',output:'Everything passed'}]).verified,false);
});
test('knowledge retrieval is scoped to a workspace and preserves its source',()=>{
  const source={convId:'conversation',toolCallId:'call'};
  const records=[{id:1,workspace:'a',title:'Python',text:'Use python in this venv',verified:true,created:1,source},
    {id:2,workspace:'b',title:'Python',text:'Use python3',verified:true,created:2,source}];
  const found=F.searchKnowledge(records,'python venv','a');
  assert.equal(found.length,1); assert.equal(found[0].id,1); assert.deepEqual(found[0].source,source);
});
test('recipe discovery proposes configured scripts without executing anything',()=>{
  const recipes=F.recipeCandidates({'package.json':JSON.stringify({name:'app',scripts:{test:'node --test',dev:'vite'}}),'pnpm-lock.yaml':''});
  assert.equal(recipes[0].test,'pnpm run test'); assert.equal(recipes[0].preview,'pnpm run dev');
  assert.equal(recipes[0].lint,'');
});
test('benchmark validation rejects escaping fixture paths and missing assertions',()=>{
  assert.throws(()=>F.validateBenchmark({tasks:[{prompt:'x',files:{'../outside':'x'},allowedWrites:[],assertions:[{path:'a'}]}]}));
  assert.throws(()=>F.validateBenchmark({tasks:[{prompt:'x',files:{a:'x'},allowedWrites:['a']}]}));
  assert.doesNotThrow(()=>F.validateBenchmark({tasks:[{prompt:'x',files:{a:'x'},allowedWrites:['a'],assertions:[{path:'a',equals:'fixed'}]}]}));
});
function uiContext(extra={}) {
  const context={HarnessFeatures:F,HarnessRuntime:H,crypto:{randomUUID:()=>Math.random().toString(16)},console,
    TextEncoder,TextDecoder,Uint8Array,Blob,File,DOMException,AbortController,AbortSignal,URL,performance,
    atob,btoa,confirm:()=>true,
    state:{activeConvId:'conversation',conversations:[{id:'conversation'}],messages:[{role:'user',content:'Fix it'}],originalTask:'Fix it',planItems:[],fileCache:new Map(),disabledTools:new Set(),dirName:'Project'},
    dbGet:async()=>null,dbSet:async()=>true,
    appendMsg:()=>{},saveCurrentConv:()=>{},showToast:()=>{},refreshFileTree:async()=>{},
    tokenTracker:{totalOutputTokens:10},redactSecrets:s=>s,
    document:{getElementById:()=>null},
    ...extra};
  vm.createContext(context); vm.runInContext(fs.readFileSync(require.resolve('../src/features-ui.js'),'utf8'),context);
  return context;
}
test('isolation disabled makes no companion call before a normal run',async()=>{
  const context=uiContext({companionFetch:()=>{throw new Error('Unexpected companion call')}});
  assert.equal(await vm.runInContext('beforeHarnessRun()',context),true);
  assert.equal(context.state.messages.some(m=>m._harnessContext),false);
});
test('queue ask_user parks its task without waiting for the answer',async()=>{
  const context=uiContext();
  vm.runInContext("harnessFeatureState.queueRunning=true; harnessFeatureState.queueTask={status:'running'}; state.running=true;",context);
  const result=await vm.runInContext("harnessFeatureHandler('ask_user')({question:'Which format?'})",context);
  assert.equal(result.status,'blocked'); assert.equal(context.state.running,false);
  assert.equal(context.harnessFeatureState.queueTask.status,'blocked');
});
test('managed file handles read and write through the task adapter',async()=>{
  let content='old', hash='before', requests=[];
  const context=uiContext({companionFetch:async(url,options)=>{
    const body=JSON.parse(options.body); requests.push(body);
    if(body.action==='read') return {json:async()=>({base64:btoa(content),hash})};
    if(body.action==='write') { assert.equal(body.expectedHash,hash); content=atob(body.base64); hash='after'; return {json:async()=>({hash})}; }
    throw new Error('Unexpected operation');
  }});
  vm.runInContext("harnessFeatureState.currentTask={id:'managed'}; globalThis.handle=new ManagedFileHandle('file.txt');",context);
  assert.equal(await vm.runInContext('handle.getFile().then(f=>f.text())',context),'old');
  await vm.runInContext("handle.createWritable().then(async w=>{await w.write('new');await w.close()})",context);
  assert.equal(content,'new'); assert.ok(requests.every(r=>r.taskId==='managed'));
});
test('fake model evaluation verifies file assertions and records metrics',async()=>{
  let fixture='bad', cleaned=false, calls=0;
  const context=uiContext({fetch:async()=>({ok:true,json:async()=>{
    calls++;
    return {usage:{completion_tokens:12,prompt_tokens:40},choices:[{message:calls===1?
      {role:'assistant',tool_calls:[{id:'call',function:{name:'write_file',arguments:JSON.stringify({path:'greeting.txt',content:'fixed'})}}]}:
      {role:'assistant',content:'done'}}]};
  }}),companionFetch:async(url,options)=>{
    const body=JSON.parse(options.body);
    if(url.endsWith('/evaluations/create')) return {json:async()=>({id:'fixture'})};
    if(url.endsWith('/tasks/file')) {
      if(body.action==='read') return {json:async()=>({base64:btoa(fixture),hash:'old'})};
      if(body.action==='write') { fixture=atob(body.base64); return {json:async()=>({hash:'new'})}; }
    }
    if(url.endsWith('/evaluations/result')) return {json:async()=>({passed:fixture==='fixed',unintendedWrites:[],assertions:[{passed:true}]})};
    if(url.endsWith('/tasks/discard')) { cleaned=true; return {json:async()=>({ok:true})}; }
    throw new Error(url);
  }});
  context.state.apiUrl='http://localhost:1234';
  const result=await vm.runInContext("evaluateHarnessModel('model',{name:'default'},{name:'fix',prompt:'fix',files:{'greeting.txt':'bad'},allowedWrites:['greeting.txt'],assertions:[{path:'greeting.txt',equals:'fixed'}],checks:[]},{maxIters:3,tokenBudget:100},new AbortController().signal)",context);
  assert.equal(result.status,'passed'); assert.equal(result.outputTokens,24);
  assert.equal(result.peakContextTokens,40); assert.equal(result.unintendedWrites,0);
  assert.equal(cleaned,true); assert.equal(result.cleanedUp,true);
});

test('queue parks questions, respects budgets, and resumes without rerunning independent work',async()=>{
  const runs=[]; let serial=0;
  const context=uiContext({_sessionTotalOut:100,updateSendBtn:()=>{}});
  context.doNewConversation=async()=>{
    const id='queue-'+(++serial); context.state.activeConvId=id;
    context.state.conversations.push({id}); context.state.messages=[];
  };
  context.switchConv=async id=>{context.state.activeConvId=id;context.state.messages=[];};
  context.agentLoop=async()=>{
    const f=context.harnessFeatureState, task=f.queueTask;
    runs.push({id:task.id,iters:context.state.maxIters,budget:context.state.tokenBudget,answer:context.state.messages.at(-1)?.content});
    assert.equal(await vm.runInContext('beforeHarnessRun()',context),true);
    context.state.running=true;
    if(task.id==='question'&&!task.answered) {
      await vm.runInContext("harnessFeatureHandler('ask_user')({question:'Choose a format'})",context);
    } else {
      vm.runInContext('harnessModelFinished()',context); context.state.running=false;
    }
    await vm.runInContext('afterHarnessRun()',context);
  };
  vm.runInContext("harnessFeatureState.prefs.queue=true; state.maxIters=99;state.tokenBudget=900;state.allowAskUser=false; harnessFeatureState.data.queue=[HarnessFeatures.newQueueTask('Ask',{id:'question',maxIters:3,tokenBudget:500}),HarnessFeatures.newQueueTask('Dependent',{id:'dependent'}),HarnessFeatures.newQueueTask('Independent',{id:'independent',independent:true})];harnessFeatureState.workspace='no-workspace';",context);
  await vm.runInContext('startHarnessQueue()',context);
  assert.deepEqual(runs.map(r=>r.id),['question','independent']);
  assert.equal(runs[0].iters,3); assert.equal(runs[0].budget,600);
  assert.equal(context.state.maxIters,99); assert.equal(context.state.tokenBudget,900);
  assert.equal(context.state.allowAskUser,false);
  const queue=context.harnessFeatureState.data.queue;
  assert.equal(queue[0].status,'blocked'); assert.equal(queue[1].status,'pending');
  queue[0].status='pending'; queue[0].answer='JSON'; queue[0].answered=true;
  await vm.runInContext('startHarnessQueue()',context);
  assert.equal(runs.at(-1).id,'question'); assert.match(runs.at(-1).answer,/JSON/);
  queue[0].status='done';
  await vm.runInContext('startHarnessQueue()',context);
  assert.equal(runs.at(-1).id,'dependent'); assert.equal(runs.filter(r=>r.id==='independent').length,1);
});
test('saved managed file handles keep their task after switching workspaces',async()=>{
  const requests=[];
  const context=uiContext({companionFetch:async(url,options)=>{
    const body=JSON.parse(options.body); requests.push(body);
    return {json:async()=>body.action==='stat'?{kind:'file',hash:'old'}:{base64:btoa('saved'),hash:'old'}};
  }});
  vm.runInContext("harnessFeatureState.currentTask={id:'other'};globalThis.dir=new ManagedDirectoryHandle('','original');",context);
  assert.equal(await vm.runInContext("dir.getFileHandle('saved.txt').then(h=>h.getFile()).then(f=>f.text())",context),'saved');
  assert.ok(requests.every(r=>r.taskId==='original'));
});

test('missing queue conversation blocks execution without changing the active task',async()=>{
 const c=uiContext({_sessionTotalOut:0});
 let executions=0,switches=0;
 c.switchConv=async()=>{switches++;}; c.agentLoop=async()=>{executions++;};
 const f=c.harnessFeatureState;f.workspace='no-workspace';f.prefs.queue=true;
 f.data.queue=[F.newQueueTask('Deleted task',{id:'lost',convId:'deleted',answer:'Private answer'}),F.newQueueTask('Dependent',{id:'next'})];
 const previous=JSON.stringify(c.state.messages);
 await c.startHarnessQueue();
 assert.equal(executions,0);assert.equal(switches,0);
 assert.equal(f.data.queue[0].status,'blocked');assert.match(f.data.queue[0].error,/source conversation/);
 assert.equal(f.data.queue[1].status,'pending');assert.equal(JSON.stringify(c.state.messages),previous);
});
test('queue verifies that switching to an existing conversation actually succeeded',async()=>{
 const c=uiContext({_sessionTotalOut:0});let executions=0;
 c.state.conversations.push({id:'wanted'});c.switchConv=async()=>{};c.agentLoop=async()=>{executions++;};
 const f=c.harnessFeatureState;f.workspace='no-workspace';f.prefs.queue=true;
 f.data.queue=[F.newQueueTask('Task',{convId:'wanted',answer:'answer'})];
 await c.startHarnessQueue();
 assert.equal(executions,0);assert.equal(f.data.queue[0].status,'blocked');assert.equal(c.state.messages.length,1);
});
test('normal runs with every feature disabled never touch feature storage',async()=>{
 const fail=async()=>{throw new Error('Storage unavailable');};
 const c=uiContext({dbGet:fail,dbSet:fail});
 const f=c.harnessFeatureState;
 for(const k of ['isolation','evidence','recipes','queue','knowledge','autoRetrieve'])f.prefs[k]=false;
 c.state.messages.push({role:'user',content:'Old project recipe',_harnessContext:true});
 assert.equal(await c.beforeHarnessRun(),true);await c.afterHarnessRun();
 assert.equal(f.currentEvidence,null);assert.equal(c.state.messages.some(m=>m._harnessContext),false);
});
test('shell mutations including failed commands require new verification',async()=>{
 for(const status of ['ok','error','cancelled']){
  const c=uiContext();await c.beforeHarnessRun();
  c.recordHarnessTool('run_tests',{command:'npm test'},{status:'ok',exitCode:0},'check1');
  c.recordHarnessTool('execute_command',{command:'rewrite-source'},{status,exitCode:status==='ok'?0:1},'shell');
  c.harnessModelFinished();await c.afterHarnessRun();
  assert.equal(c.harnessFeatureState.data.evidence[0].outcome,'needs_review',status);
  c.recordHarnessTool('run_tests',{command:'npm test'},{status:'ok',exitCode:0},'check2');
  await c.afterHarnessRun();
  assert.equal(c.harnessFeatureState.data.evidence[0].outcome,'verified');
 }
});
test('workspace handles scope data and Git paths across A, B, and back to A',async()=>{
 const records=new Map();
 const c=uiContext({dbGet:async(_,id)=>records.get(id)||null,dbSet:async(_,value)=>{
  records.set(value.id,value.id==='feature-workspaces'?{...value,records:value.records.map(r=>({...r}))}:structuredClone(value));return true;
 }});
 const folder=name=>({name,isSameEntry:async other=>other?.name===name,getDirectoryHandle:async()=>{throw new DOMException('missing','NotFoundError');}});
 const a=folder('A'),b=folder('B'),f=c.harnessFeatureState;
 c.state.dirHandle=a;c.state.dirName='A';await c.ensureFeatureWorkspace();
 const aId=f.workspace;f.prefs.projectRoot='C:/A';await c.saveFeatureProjectRoot();
 f.data.knowledge.push({workspace:aId,title:'A only',text:'A fact'});f.data.queue.push({id:'a',status:'pending'});f.data.recipes.push({id:'a-recipe'});await c.saveFeatureData();
 c.state.dirHandle=b;c.state.dirName='B';await c.ensureFeatureWorkspace();
 const bId=f.workspace;assert.notEqual(bId,aId);assert.equal(f.prefs.projectRoot,'');
 assert.equal(f.data.knowledge.length,0);assert.equal(f.data.queue.length,0);assert.equal(f.data.recipes.length,0);
 f.prefs.projectRoot='C:/B';await c.saveFeatureProjectRoot();
 c.state.dirHandle=a;c.state.dirName='A';await c.ensureFeatureWorkspace();
 assert.equal(f.workspace,aId);assert.equal(f.prefs.projectRoot,'C:/A');assert.equal(f.data.knowledge[0].title,'A only');assert.equal(f.data.queue[0].id,'a');
 c.state.dirHandle=b;await c.ensureFeatureWorkspace();assert.equal(f.prefs.projectRoot,'C:/B');assert.equal(f.workspace,bId);
});

test('Options can disable every feature even when feature storage is unavailable',async()=>{
 const saved=new Map(),elements=new Map();
 for(const k of ['isolation','evidence','recipes','queue','knowledge','autoRetrieve'])elements.set('hf-option-'+k,{checked:false});
 elements.set('hf-project-root',{value:''});
 const c=uiContext({dbGet:async()=>{throw new Error('Unavailable');},dbSet:async()=>false,
  localStorage:{setItem:(k,v)=>saved.set(k,v)},renderToolList:()=>{},document:{getElementById:id=>elements.get(id)||null}});
 await c.harnessFeatureAction('save-options','');
 assert.equal(JSON.parse(saved.get('SlopLobster_features')).evidence,false);
 assert.equal(await c.beforeHarnessRun(),true);
});
test('explicit folder path binding preserves legacy data without importing it into other folders',async()=>{
 const handle={name:'A',isSameEntry:async other=>other?.name==='A',getDirectoryHandle:async()=>{throw new Error('missing');}};
 const records=new Map([['features:C:/A',{id:'features:C:/A',data:{knowledge:[{workspace:'C:/A',title:'Retained'}],queue:[{id:'pending',status:'running'}]}}]]);
 const c=uiContext({structuredClone,dbGet:async(_,id)=>records.get(id)||null,dbSet:async(_,data)=>{records.set(data.id,data);return true;}});
 c.state.dirHandle=handle;
 await c.ensureFeatureWorkspace();
 assert.equal(c.harnessFeatureState.data.knowledge.length,0);
 c.harnessFeatureState.prefs.projectRoot='C:/A';
 await c.saveFeatureProjectRoot();
 assert.equal(c.harnessFeatureState.data.knowledge[0].title,'Retained');
 assert.equal(c.harnessFeatureState.data.knowledge[0].workspace,c.harnessFeatureState.workspace);
 assert.equal(c.harnessFeatureState.data.queue[0].status,'paused');
});
