'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const crypto=require('node:crypto').webcrypto;
const app=fs.readFileSync(require.resolve('../src/app.js'),'utf8');
const read=name=>fs.readFileSync(require.resolve('../src/'+name),'utf8');
function context(extra={}) {
  const ctx={AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,crypto,console,...extra};
  vm.createContext(ctx);return ctx;
}
function functions(ctx,start,end) {vm.runInContext(app.slice(app.indexOf(start),app.indexOf(end,app.indexOf(start))),ctx);}
function handler(ctx,name,next) {const start=app.indexOf("      '"+name+"': async"),end=app.indexOf("      '"+next+"':",start);vm.runInContext('globalThis.handlers={'+app.slice(start,end)+'}',ctx);return ctx.handlers[name];}

test('run_tests honors shell approvals and never dispatches a declined command',async()=>{
  let approvals=0,dispatches=0,answer=false;
  const ctx=context({state:{compConnected:true,shellAutoApprove:false,shellAutoApproveDangerous:false},isDangerous:()=>true,
    showShellConfirm:(_,cb)=>{approvals++;cb(answer);},execViaCompanion:async()=>{dispatches++;return {status:'ok',exitCode:0,output:'ok'};},parseTestOutput:()=>null});
  vm.runInContext(read('shell-services.js'),ctx);
  const run=handler(ctx,'run_tests','git_status');
  assert.equal((await run({command:'fixture command'})).status,'blocked');assert.equal(dispatches,0);assert.equal(approvals,1);
  ctx.state.shellAutoApprove=true;await run({command:'fixture command'});assert.equal(dispatches,0);assert.equal(approvals,2);
  answer='approved command';await run({command:'fixture command'});assert.equal(dispatches,1);
  ctx.state.shellAutoApproveDangerous=true;await run({command:'fixture command'});assert.equal(approvals,3);assert.equal(dispatches,2);
});

test('test-command cancellation releases the approval promise without execution',async()=>{
  let dispatches=0;const controller=new AbortController();
  const ctx=context({state:{compConnected:true},isDangerous:()=>false,
    showShellConfirm:(_,cb,__,signal)=>signal.addEventListener('abort',()=>cb(false)),execViaCompanion:async()=>dispatches++,parseTestOutput:()=>null});
  vm.runInContext(read('shell-services.js'),ctx);const run=handler(ctx,'run_tests','git_status');
  const pending=run({command:'fixture'},controller.signal);controller.abort();await pending;assert.equal(dispatches,0);
});

test('declining a dev-server command prevents network dispatch',async()=>{
  const ctx=context({state:{compConnected:true},approveShellCommand:async()=>false,companionFetch:()=>{throw Error('must not dispatch');}});
  const start=handler(ctx,'start_dev_server','execute_command');
  assert.equal((await start({command:'fixture'})).status,'blocked');
});

test('Python syntax checks send literal filenames in argv without shell interpolation',async()=>{
  const calls=[];const ctx=context({state:{compInfo:{python_cmd:'python'}},sanitizePath:p=>[p],
    dbGet:async()=>null});vm.runInContext(read('shell-services.js'),ctx);
  ctx.resolveCommandWorkspace=async()=>'/selected';ctx.executeCompanionJob=async(...args)=>{calls.push(args);return {status:'ok',output:''};};
  const path='review$(echo probe).py';await ctx.checkPythonFile(path);
  assert.equal(calls[0][5],'/selected');assert.deepEqual(Array.from(calls[0][6]).slice(-1),[path]);
  assert.equal(calls[0][6][1],'-c');assert.match(calls[0][6][2],/compile/);
  assert.equal(app.includes('python3 -m py_compile'),false);
  assert.equal(read('agent-loop.js').includes('python3 -m py_compile'),false);
});

test('virtual touch preserves existing content and requests approval for new files',async()=>{
  const files=new Map([['important.txt','valuable']]);let approvals=0,allow=false;
  const ctx=context({state:{dirHandle:{},dirName:'Project',requireEditApproval:true},requireWorkspace(){},
    resolvePath:async p=>{if(files.has(p))return {kind:'file'};throw new DOMException('Missing','NotFoundError');},
    writeFileSafe:async(p,text,dry)=>dry?{_pendingApproval:true,_pendingPath:p}:{output:files.set(p,text)},
    showActionConfirm:(_,p,cb)=>{approvals++;cb(allow?p:false);},applyPendingWrite:async pr=>files.set(pr._pendingPath,'')});
  functions(ctx,'    async function execVirtual(','    const DANGEROUS');
  await ctx.execVirtual('touch important.txt');assert.equal(files.get('important.txt'),'valuable');assert.equal(approvals,0);
  assert.equal((await ctx.execVirtual('touch new.txt')).status,'blocked');assert.equal(files.has('new.txt'),false);
  allow=true;await ctx.execVirtual('touch new.txt');assert.equal(files.get('new.txt'),'');assert.equal(approvals,2);
});

test('Git add treats strings as single paths and accepts arrays for multiple paths',async()=>{
  const calls=[];const ctx=context({execArgvViaCompanion:async argv=>calls.push(Array.from(argv))});
  functions(ctx,'    async function gitAdd(','    async function gitCommit(');
  await ctx.gitAdd('release notes.txt');await ctx.gitAdd(['a.txt',"John's notes.txt"]);
  await ctx.gitAdd('"release notes.txt"');
  assert.deepEqual(calls,[['git','add','--','release notes.txt'],['git','add','--','a.txt',"John's notes.txt"],['git','add','--','"release notes.txt"']]);
});

function workspaceContext({match=true,mapped=false}={}) {
  const files=new Map(),calls=[];
  const root={isSameEntry:async h=>h===root,getFileHandle:async name=>({createWritable:async()=>({write:async text=>files.set(name,text),close:async()=>{}})}),
    removeEntry:async name=>files.delete(name)};
  const ctx=context({state:{dirHandle:root,compInfo:{cwd:'/launch'},compUrl:'http://fixture',cmdTimeout:30},featureTask:()=>null,
    dbGet:async()=>mapped?{records:[{handle:root,projectRoot:'/selected'}]}:null,
    companionFetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);assert.equal(files.get(body.marker),body.nonce);if(!match)throw Error('marker absent in launch folder');return {json:async()=>({cwd:body.cwd})};}});
  vm.runInContext(read('shell-services.js'),ctx);return {ctx,files,calls};
}
test('commands reject mismatched folders before dispatch and clean up workspace challenges',async()=>{
  const {ctx,files}=workspaceContext({match:false});let dispatches=0;ctx.executeCompanionJob=async()=>dispatches++;
  functions(ctx,'    async function execViaCompanion(','    async function readNdjsonStream(');
  await assert.rejects(ctx.execViaCompanion('pwd'),/selected folder could not be matched/);
  assert.equal(dispatches,0);assert.equal(files.size,0);
});
test('commands use the verified per-folder path instead of the companion launch directory',async()=>{
  const {ctx,files,calls}=workspaceContext({mapped:true});let cwd;
  ctx.executeCompanionJob=async(...args)=>{cwd=args[5];return {status:'ok',output:'ok'};};
  functions(ctx,'    async function execViaCompanion(','    async function readNdjsonStream(');
  await ctx.execViaCompanion('pwd');assert.equal(cwd,'/selected');assert.equal(calls[0].cwd,'/selected');assert.equal(files.size,0);
});

for(const phase of ['blocked','paused','finished'])test('plan execution handles '+phase+' without inventing completion',async()=>{
  const steps=[{description:'one',status:'pending'},{description:'two',status:'pending'}];let turns=0;
  const ctx=context({state:{currentPlan:{steps},messages:[],autoCompactPct:80,runController:{snapshot:()=>({phase:phase==='finished'?'finished':'paused'})}},
    document:{getElementById:()=>null},updateSendBtn(){},updateContextMeter(){},updatePlanProgress(){},saveCurrentConv(){},getContextPct:()=>0,
    slimStepMessages(){},appendMsg(){},updatePlanStep:(i,status)=>steps[i].status=status,
    agentLoop:async()=>{turns++;ctx.state.completion=phase==='blocked'?{outcome:'blocked'}:phase==='finished'?{outcome:'completed'}:null;}});
  functions(ctx,'    function planStepCompleted()','    function toggleSidebar()');await ctx.executeAllPlanSteps();
  assert.equal(turns,phase==='finished'?2:1);assert.equal(steps[0].status,phase==='finished'?'done':phase==='blocked'?'failed':'pending');
  assert.equal(steps[1].status,phase==='finished'?'done':'pending');
});

test('plan startup failure cannot reuse a prior successful completion',async()=>{
  const steps=[{description:'new step',status:'pending'}];
  const ctx=context({state:{currentPlan:{steps},messages:[],completion:{outcome:'verified'},runController:{snapshot:()=>({phase:'finished'})}},
    document:{getElementById:()=>null},updateSendBtn(){},updateContextMeter(){},saveCurrentConv(){},
    updatePlanStep:(i,status)=>steps[i].status=status,appendMsg(){},agentLoop:async()=>{}});
  functions(ctx,'    function planStepCompleted()','    function toggleSidebar()');await ctx.executeAllPlanSteps();assert.equal(steps[0].status,'pending');
});

function commandContext(extra={}) {
  const records=new Map();const ctx=context({state:{activeConvId:'c',messages:[],compUrl:'http://fixture'},
    dbSet:async(_,r)=>{records.set(r.id,structuredClone(r));return true;},dbGetAll:async()=>[...records.values()],
    dbDelete:async(_,id)=>{records.delete(id);return true;},redactSecrets:String,appendMsg(){},saveCurrentConv(){},...extra});
  vm.runInContext(read('companion-client.js'),ctx);return {ctx,records};
}
test('completed command results survive companion loss until a durable conversation commit',async()=>{
  const {ctx,records}=commandContext();const job={id:'command:job',commandId:'job',convId:'c',companionUrl:'http://fixture',toolCallId:'call',operationId:'op:call'};
  ctx.state.messages=[{role:'assistant',tool_calls:[{id:'call',_operationId:'op:call'}]}];records.set(job.id,job);
  ctx.commandRequest=async()=>({status:'ok',exitCode:0,cursor:1,events:[{t:'o',d:'completed'}]});
  await ctx.followCommandJob(job);assert.equal(records.get(job.id).result.output,'completed');
  ctx.commandRequest=async()=>{throw Error('Companion restarted; cached results must be used');};
  ctx.persistCommandConversation=async()=>{throw Error('quota');};
  await assert.rejects(ctx.reconcileCommandJobs(),/quota/);assert.equal(records.has(job.id),true);
  ctx.persistCommandConversation=async()=>{};await ctx.reconcileCommandJobs();
  assert.equal(records.size,0);assert.equal(ctx.state.messages.filter(m=>m.role==='tool').length,1);
});
test('failure to persist a command ID prevents launching its process',async()=>{
  const {ctx}=commandContext({dbSet:async()=>false});let launches=0;ctx.commandRequest=async()=>launches++;
  await assert.rejects(ctx.executeCompanionJob('probe',5),/not launched/);assert.equal(launches,0);
});

test('acknowledging an unknown command supplies its missing tool result before user context',async()=>{
  const {ctx,records}=commandContext();records.set('command:lost',{id:'command:lost',commandId:'lost',convId:'c',toolCallId:'call',companionUrl:'http://fixture'});
  ctx.state.messages=[{role:'assistant',tool_calls:[{id:'call'}]}];
  ctx.followCommandJob=async()=>{throw Object.assign(Error('lost'),{status:404});};ctx.showActionConfirm=(_,__,cb)=>cb(true);
  await ctx.reconcileCommandJobs();assert.equal(ctx.state.messages[1].role,'tool');assert.equal(ctx.state.messages[1].tool_call_id,'call');assert.equal(records.size,0);
});

test('a batch of entirely unavailable tools receives matching error results',async()=>{
  const Runs=require('../src/run-state.js'),Runtime=require('../src/harness-runtime.js');
  const ctx=context({HarnessRunState:Runs,HarnessRuntime:Runtime,performance,console:{log(){}},
    state:{maxIters:1,memoryAgentEnabled:false,activeConvId:'c',messages:[],pendingSteerMessages:[]},_sessionTotalOut:0,
    toolCallHistory:[],textLoopBuffer:[],modifiedFiles:new Set(),newFiles:new Set(),allModified:new Set(),
    tokenTracker:{lastPromptTokens:-1,totalOutputTokens:0,reset(){},commit(){}},agentStopwatch:null,streamEl:null,
    beforeHarnessRun:async()=>true,reconcileCommandJobs:async()=>{},saveActiveAgentState:async()=>{},clearActiveAgentState:async()=>{},
    appendMsg(){},createCompressionStats:()=>({}),getContextPct:()=>0,saveProgressToWorkspace:async()=>true,showThinking:()=>null,
    streamChat:async()=>({content:'',toolCalls:[{id:'bad',function:{name:'disabled',arguments:'{}'}}],usage:{out:0}}),
    stripThinkingBlocks:s=>s,updateSendBtn(){},updateContextMeter(){},saveCurrentConv(){},getToolDefs:()=>[],
    showCompletionSummary(){},afterHarnessRun:async()=>{},saveCheckpoint(){},renderSteerQueue(){},notifyUser(){},finalizeLiveThinkBlock(){}});
  vm.runInContext(read('agent-loop.js'),ctx);await ctx.agentLoop();
  const result=ctx.state.messages.find(m=>m.role==='tool');assert.equal(result.tool_call_id,'bad');assert.match(result.content,/unavailable/);
});
