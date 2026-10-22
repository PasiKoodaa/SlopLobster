'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), vm=require('node:vm'), {webcrypto}=require('node:crypto');
const Backend=require('../src/backend-core.js'), Core=require('../src/harness-core.js');
const Mutations=require('../src/mutation-core.js'), Runtime=require('../src/harness-runtime.js');
const Runs=require('../src/run-state.js'), Streams=require('../src/model-stream.js');
const Features=require('../src/features-core.js');
const source=name=>fs.readFileSync(require.resolve('../src/'+name),'utf8');
const sse=(delta={content:'done'},usage={prompt_tokens:10,completion_tokens:5})=>new Response('data: '+JSON.stringify({choices:[{delta,finish_reason:'stop'}],usage})+'\n\ndata: [DONE]\n\n');
function client(fetch,extra={}) {
  const context={HarnessBackend:Backend,HarnessCore:Core,HarnessRuntime:Runtime,HarnessRunState:Runs,HarnessModelStream:Streams,
    AbortController,AbortSignal,DOMException,setTimeout,clearTimeout,crypto:webcrypto,console,
    state:{apiUrl:'http://localhost:1234/v1',backendType:'openai',runController:Runs.create(),maxTokens:100,model:'local'},
    _sessionTotalOut:0,estimateTokens:s=>Math.ceil(s.length/3.8),fetch,...extra};
  vm.createContext(context); vm.runInContext(source('model-client.js'),context);
  // Preserve abort semantics while keeping deterministic HTTP retry tests fast.
  context.modelRetryWait=async(_,signal)=>signal?.throwIfAborted();
  return context;
}

test('every local backend uses version-safe URLs and a portable request policy',()=>{
  for(const type of ['lmstudio','llamacpp','vllm','localai','jan','gpt4all','textgen','openai']) {
    const body=Backend.normalize({temperature:0.2,top_k:20,min_p:0.1,chat_template_kwargs:{enable_thinking:true},
      messages:[{role:'assistant',content:'hi',_artifactId:'private',tool_calls:[{id:'a',_operationId:'private',function:{name:'x',arguments:'{}'}}]}]}, {backendType:type});
    assert.equal(body.temperature,0.2);
    assert.equal('top_k' in body,['lmstudio','llamacpp'].includes(type));
    assert.equal(JSON.stringify(body).includes('private'),false);
    assert.equal('temperature' in Backend.normalize(body,{backendType:type,useServerSampling:true}),false);
  }
  for(const base of ['http://localhost:1234','http://localhost:1234/v1/']) {
    assert.equal(Backend.url(base,'/v1/chat/completions'),'http://localhost:1234/v1/chat/completions');
    assert.equal(Backend.url(base,'/tokenize'),'http://localhost:1234/tokenize');
  }
  assert.deepEqual(Backend.headers('secret',{'Content-Type':'application/json'}),{'Content-Type':'application/json',Authorization:'Bearer secret'});
});

test('summaries and isolated evaluations share transport policy and keep separate budgets',async()=>{
  const requests=[],context=client(async(url,options)=>{requests.push({url,...JSON.parse(options.body)}); return sse();});
  context.state.runTokenLimit=6;
  const evalLedger=Runs.create(); let saves=0;
  context.saveActiveAgentState=async()=>saves++;
  const result=await context.requestModel({model:'local',messages:[],temperature:0.4,top_k:50,stream:true,max_tokens:20},null,
    {ledger:evalLedger,tokenLimit:30});
  assert.equal(result.usage.out,5); assert.equal(evalLedger.snapshot().outputTokens,5);
  assert.equal(context.state.runController.snapshot().outputTokens,0); assert.equal(saves,0);
  await context.requestModelJSON({model:'local',top_k:50,messages:[],max_tokens:20});
  assert.equal(requests[0].url,'http://localhost:1234/v1/chat/completions');
  assert.equal(requests.every(r=>r.top_k===undefined && r.stream===true),true);
  assert.equal(requests[1].max_tokens,6); assert.equal(context.state.runController.snapshot().outputTokens,5);
});

test('explicit HTTP failures have bounded retries; auth and dropped streams are never replayed',async()=>{
  for(const [status,expected,code] of [[503,3,'server_busy'],[429,3,'server_busy'],[401,1,'authentication'],[404,1,'endpoint'],[400,1,'request_failed']]) {
    let calls=0; const context=client(async()=>{calls++;return new Response('rejected',{status});});
    await assert.rejects(context.requestModel({stream:true}),{code}); assert.equal(calls,expected);
    assert.equal(context.state.runController.snapshot().outputTokens,0);
  }
  let calls=0; const context=client(async()=>{calls++;return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');});
  await assert.rejects(context.requestModel({stream:true}),{code:'premature_eof'}); assert.equal(calls,1);
  assert.ok(context.state.runController.snapshot().outputTokens>0);
  assert.equal(Backend.retryDelay({status:429,retryAfterMs:100000},0),5000);
});

test('operation IDs distinguish repeated server tool IDs but never reach model messages',async()=>{
  const context=client(async()=>sse({tool_calls:[{index:0,id:'call_0',function:{name:'write_file',arguments:'{"path":"a","content":"b"}'}}]}));
  const first=await context.requestModel({stream:true}),second=await context.requestModel({stream:true});
  assert.notEqual(first.toolCalls[0]._operationId,second.toolCalls[0]._operationId);
  const wire=Backend.normalize({messages:[{role:'assistant',tool_calls:first.toolCalls}]});
  assert.equal(JSON.stringify(wire).includes('_operationId'),false);
});

test('progress detection compares full arguments, results and actual workspace progress',()=>{
  const record=(path,result='missing',revision=0)=>Core.progressRecord('read_file',JSON.stringify({path}),{status:'error',output:result},revision);
  const a='x'.repeat(200)+'a',b='x'.repeat(200)+'b';
  assert.equal(Core.stalled([record(a),record(a),record(b)]),false);
  assert.equal(Core.stalled([record(a),record(a),record(a)]),true);
  assert.equal(Core.stalled([record(a),record(a),record(a,'changed error')]),false);
  assert.equal(Core.stalled([record(a),record(a),record(a,'missing',1)]),false);
  assert.equal(Core.progressRecord('x','{"a":1,"b":2}').sig,Core.progressRecord('x','{"b":2,"a":1}').sig);
  const timed=n=>Core.progressRecord('execute_command','{}',{status:'ok',output:'finished in '+n+' ms'});
  assert.equal(Core.stalled([timed(1),timed(2),timed(3)]),true);
});

test('completion cannot claim verification from prose, stale checks or unresolved operations',()=>{
  const verification={mutations:2,latest:{revision:2,snapshot:{status:'passed'}}};
  assert.equal(Core.completion({mutated:true}).outcome,'completed_unverified');
  assert.equal(Core.completion({mutated:true,verification}).outcome,'verified');
  assert.equal(Core.completion({mutated:true,verification:{...verification,mutations:3}}).outcome,'completed_unverified');
  assert.equal(Core.completion({mutated:true,verification:{...verification,latest:{...verification.latest,stale:true}},evidence:{verified:true}}).outcome,'completed_unverified');
  assert.equal(Core.completion({verification,pending:[{id:'uncertain'}]}).outcome,'blocked');
  assert.equal(Core.completion({verification,criteria:['Review visual layout']}).outcome,'completed_unverified');
  assert.equal(Core.completion({verification:{mutations:2,latest:{revision:2,snapshot:{status:'failed'},comparison:{outcome:'regression'}}}}).outcome,'blocked');
  assert.equal(Core.completion({}).outcome,'completed');
  assert.equal(Features.evidenceSummary([{kind:'check',status:'ok',exitCode:0,workspaceRevision:1}],2).verified,false);
});

function mutationStore(files={a:'old'}) {
  const records=new Map(),data=new Map(Object.entries(files));
  const create=(extra={})=>Mutations.create({inspect:async path=>data.get(path)??null,load:async id=>records.get(id),
    save:async record=>{records.set(record.id,structuredClone(record));return true;},...extra});
  return {records,data,create};
}
const plan=(id='op')=>({id,kind:'write',entries:[{path:'a',before:'old',after:'new'}]});

test('durable receipts prevent duplicate mutations after a lost response',async()=>{
  const {data,create,records}=mutationStore(); let writes=0;
  await create().perform(plan(),async()=>{writes++;data.set('a','new');});
  const receipt=await create().perform(plan(),async()=>writes++);
  assert.equal(receipt.alreadyApplied,true);assert.equal(writes,1);assert.equal(records.get('op').status,'applied');
});

test('reload reconciles prepared writes both before and after effects without replay',async()=>{
  for(const changed of [false,true]) {
    const {data,create,records}=mutationStore();records.set('op',{...plan(),status:'prepared'});
    if(changed)data.set('a','new');
    const result=await create().reconcile(records.get('op'));
    assert.equal(result.status,changed?'applied':'not_applied');
    let repeated=0;
    if(changed)assert.equal((await create().perform(plan(),async()=>repeated++)).alreadyApplied,true);
    else await assert.rejects(create().perform(plan(),async()=>repeated++),{code:'mutation_reconciliation'});
    assert.equal(repeated,0);
  }
});

test('receipt storage failures and stale snapshots prevent unrecorded effects',async()=>{
  const {data,create}=mutationStore();let writes=0;
  await assert.rejects(create({save:async()=>false}).perform(plan(),async()=>writes++),{code:'mutation_storage'});
  assert.equal(writes,0);
  const store=create({save:async()=>{data.set('a','external');return true;}});
  await assert.rejects(store.perform(plan(),async()=>writes++),{code:'stale_file'});assert.equal(writes,0);
});

test('mixed move outcomes remain unknown and applied receipts cannot be replayed after external edits',async()=>{
  const {data,create}=mutationStore();
  const move={id:'move',entries:[{path:'a',before:'old',after:null},{path:'b',before:null,after:'old'}]};
  data.set('b','old');assert.equal((await create().reconcile(move)).status,'unknown');
  data.delete('b');await create().perform(plan(),async()=>data.set('a','new'));data.set('a','external');
  let writes=0;await assert.rejects(create().perform(plan(),async()=>writes++),{code:'mutation_reconciliation'});assert.equal(writes,0);
});

// A byte-preserving File System Access adapter; no mutation service is stubbed.
function memoryDirectory(initial) {
  const files=new Map(Object.entries(initial).map(([p,c])=>[p,typeof c==='string'?new TextEncoder().encode(c):new Uint8Array(c)]));
  const control={writes:0,failRemove:false};
  const missing=()=>new DOMException('Missing','NotFoundError');
  const directory=(prefix='')=>({kind:'directory',name:prefix||'project',
    async getDirectoryHandle(name,{create=false}={}) {const p=prefix+name+'/';if(!create && ![...files.keys()].some(k=>k.startsWith(p)))throw missing();return directory(p);},
    async getFileHandle(name,{create=false}={}) {
      const path=prefix+name;
      if(!files.has(path)) {if([...files.keys()].some(k=>k.startsWith(path+'/')))throw new DOMException('Directory','TypeMismatchError');if(!create)throw missing();files.set(path,new Uint8Array());}
      return {kind:'file',name,async getFile(){return new File([files.get(path)],name);},async createWritable(){let pending;return {
        async write(value){pending=new Uint8Array(await new Blob([value]).arrayBuffer());},async close(){files.set(path,pending);control.writes++;},async abort(){}};}};
    },
    async removeEntry(name,{recursive=false}={}){if(control.failRemove)throw new Error('Power lost before delete');const path=prefix+name;if(!files.delete(path)){if(!recursive)throw missing();for(const p of files.keys())if(p.startsWith(path+'/'))files.delete(p);}},
    async *entries(){const seen=new Set();for(const path of files.keys()){if(!path.startsWith(prefix))continue;const name=path.slice(prefix.length).split('/')[0];if(seen.has(name))continue;seen.add(name);yield [name,files.has(prefix+name)?await this.getFileHandle(name):directory(prefix+name+'/')];}}
  });
  return {root:directory(),files,control};
}
function services(workspace,records=new Map(),extra={}) {
  const artifacts=new Map();
  const context={HarnessMutations:Mutations,HarnessCore:Core,HarnessFeatures:Features,crypto:webcrypto,
    TextEncoder,Uint8Array,DOMException,console,
    state:{dirHandle:workspace.root,activeConvId:'conversation',messages:[],workspaceRevision:0,mutationPaths:[]},
    requireWorkspace:()=>{},sanitizePath:p=>p.split('/'),verificationScope:async()=>'project',
    dbGet:async(store,id)=>(store==='tool_artifacts'?artifacts:records).get(id),dbGetAll:async()=>[...records.values()],
    dbSet:async(store,record)=>{(store==='tool_artifacts'?artifacts:records).set(record.id,{...record});return true;},dbDelete:async(store,id)=>{(store==='tool_artifacts'?artifacts:records).delete(id);return true;},
    redactSecrets:s=>s.replaceAll('secret-key','[redacted]'),recordRunEvent:async()=>{},saveCurrentConv:()=>{},...extra};
  vm.createContext(context);vm.runInContext(source('harness-services.js'),context);return context;
}

test('real workspace adapter guards edits against external changes since a tool read',async()=>{
  const workspace=memoryDirectory({'a.txt':'old'}),context=services(workspace);
  const service=await context.workspaceServices();service.observed.set('a.txt',await service.inspect('a.txt'));
  workspace.files.set('a.txt',new TextEncoder().encode('external'));
  await assert.rejects(service.write('a.txt','new','external','stale'),{code:'stale_file'});
  assert.equal(workspace.control.writes,0);
  service.observed.set('a.txt',await service.inspect('a.txt'));
  await service.write('a.txt','new','external','fresh');assert.equal(workspace.control.writes,1);
  assert.equal(context.state.progressRevision,1);
});

test('binary moves preserve bytes and refuse existing destinations',async()=>{
  const bytes=Uint8Array.of(0,255,128,192,10),workspace=memoryDirectory({'a.bin':bytes,'existing.bin':'keep'});
  const context=services(workspace),service=await context.workspaceServices();
  await assert.rejects(service.move('a.bin','existing.bin','conflict'),{code:'file_conflict'});
  await service.move('a.bin','nested/b.bin','move');
  assert.deepEqual(workspace.files.get('nested/b.bin'),bytes);assert.equal(workspace.files.has('a.bin'),false);
});

test('reload discovers an applied write whose final receipt was lost without writing again',async()=>{
  const workspace=memoryDirectory({'a.txt':'old'}),records=new Map();
  const context=services(workspace,records,{dbSet:async(_,record)=>{if(record.status==='applied')return false;records.set(record.id,{...record});return true;}});
  await assert.rejects(context.commitWorkspaceWrite('a.txt','new','old','lost'),{code:'mutation_storage'});
  assert.equal([...records.values()][0].status,'prepared');assert.equal(workspace.control.writes,1);
  const reloaded=services(workspace,records);await reloaded.reconcileWorkspaceMutations();
  assert.equal([...records.values()][0].status,'applied');assert.equal(workspace.control.writes,1);
  assert.equal(reloaded.state.workspaceRevision,1);assert.match(reloaded.state.messages[0].content,/No operation was replayed/);
});

test('partial binary moves block further changes until their outcome is reconciled',async()=>{
  const workspace=memoryDirectory({'a.bin':Uint8Array.of(0,255),'other.txt':'old'}),records=new Map();workspace.control.failRemove=true;
  const context=services(workspace,records),service=await context.workspaceServices();
  await assert.rejects(service.move('a.bin','b.bin','partial'),{code:'mutation_unknown'});
  await assert.rejects(service.write('other.txt','new','old','later'),{code:'mutation_unknown'});
  await assert.rejects(services(workspace,records).reconcileWorkspaceMutations(),/Unresolved file mutation/);
  assert.equal(new TextDecoder().decode(workspace.files.get('other.txt')),'old');
});

test('tool output artifacts survive compaction and restrict retrieval to their conversation',async()=>{
  const records=new Map(),context=services(memoryDirectory({}),records);
  const output='head\n'+'noise\n'.repeat(1500)+'ERROR: preserve this cause secret-key\n'+'tail\n'.repeat(600);
  const result=await context.archiveToolOutput('run_tests',{status:'error',output},'check');
  assert.equal(result._artifactId,'artifact:check');
  const task=Runtime.captureTaskState(context.state);
  const compacted=Runtime.compactMessages(task,'summary');
  assert.match(JSON.stringify(compacted),/artifact:check/);
  const read=await context.readHarnessArtifact({artifact_id:'artifact:check',offset:9000,limit:20000});
  assert.match(read.output,/ERROR: preserve this cause \[redacted\]/);assert.match(read.output,/tail/);
  context.state.activeConvId='another';assert.equal((await context.readHarnessArtifact({artifact_id:'artifact:check'})).status,'error');
});

test('compaction selects errors and preserves durable task and recovery state',()=>{
  const output='start\n'+'noise\n'.repeat(900)+'FAILED: root cause\n'+'tail\n'.repeat(300);
  assert.match(Core.excerpt(output),/FAILED: root cause/);
  const task=Runtime.captureTaskState({originalTask:'fix',modelRecoveries:{context:1,truncation:2},workspaceRevision:3,
    mutationPaths:['a'],artifactRefs:[{id:'artifact:log'}],messages:[{role:'user',content:'Keep offline support'}]});
  const input=Core.compactionInput([{role:'tool',content:output,_status:'error',_artifactId:'artifact:log'}],task,{maxChars:6000});
  assert.match(input,/FAILED: root cause/);assert.match(input,/artifact:log/);assert.ok(input.length<=6000);
  const restored=JSON.parse(JSON.stringify(task));assert.equal(restored.modelRecoveries.truncation,2);assert.equal(restored.workspaceRevision,3);
});

test('completion checks invalidate successful verification after an external edit',async()=>{
  const workspace=memoryDirectory({'a.txt':'fixed'}),context=services(workspace);
  context.state.workspaceRevision=1;context.state.mutationPaths=['a.txt'];
  context.state.verificationState={mutations:1,latest:{revision:1,snapshot:{status:'passed'},workspaceStamp:await context.captureWorkspaceStamp()}};
  assert.equal((await context.assessHarnessCompletion()).outcome,'verified');
  workspace.files.set('a.txt',new TextEncoder().encode('external'));
  assert.equal((await context.assessHarnessCompletion()).outcome,'completed_unverified');
});

test('evaluation summaries count failed-token cost and explicit failure categories',()=>{
  const summary=Core.evaluationSummary([{status:'passed',outputTokens:10,elapsedSeconds:1},{status:'failed',task:'x',backend:'vllm',failureCategory:'stale_file',outputTokens:30,interventions:2}]);
  assert.equal(summary.tokensPerVerified,40);assert.equal(summary.verifiedRate,0.5);assert.equal(summary.interventions,2);
  assert.equal(summary.failures[0].reason,'stale_file');
});

test('a saved applied receipt repairs a missing tool result even when the server reused its tool ID',async()=>{
  const workspace=memoryDirectory({'a.txt':'old'}),records=new Map(),context=services(workspace,records);
  context.state.messages=[{role:'assistant',tool_calls:[{id:'call_0',_operationId:'first:call_0'}]},
    {role:'tool',tool_call_id:'call_0',content:'earlier result'},
    {role:'assistant',tool_calls:[{id:'call_0',_operationId:'second:call_0'}]}];
  await context.commitWorkspaceWrite('a.txt','new','old','second:call_0');
  const reloaded=services(workspace,records);reloaded.state.messages=context.state.messages;
  await reloaded.reconcileWorkspaceMutations();
  assert.equal(reloaded.state.messages[1].content,'earlier result');
  assert.equal(reloaded.state.messages[3].role,'tool');assert.equal(reloaded.state.messages[3].tool_call_id,'call_0');
  assert.match(reloaded.state.messages[3].content,/Recovered write/);assert.equal(workspace.control.writes,1);
  await reloaded.reconcileWorkspaceMutations();assert.equal(reloaded.state.messages.length,4);
});

test('artifact storage failure retains actual tool output and pauses further work',async()=>{
  const context=services(memoryDirectory({}),new Map(),{dbSet:async()=>false});context.state.running=true;
  const output='ERROR: diagnostic details\n'+'full data'.repeat(500);
  const result=await context.archiveToolOutput('run_tests',{status:'error',output},'lost-artifact');
  assert.equal(result._artifactError,true);assert.equal(context.state.running,false);
  assert.ok(result.output.startsWith(output));assert.match(result.output,/storage failed/);
});

test('manual mutation resolution records current hashes and invalidates verification without replay',async()=>{
  const workspace=memoryDirectory({'a.txt':'external'}),records=new Map();
  records.set('mutation:uncertain',{...plan('mutation:uncertain'),scope:'project',convId:'conversation',status:'unknown'});
  const context=services(workspace,records,{confirm:()=>true,saveActiveAgentState:async()=>{}});
  context.state.verificationState={mutations:1,latest:{snapshot:{status:'passed'}}};
  await context.resolveHarnessMutation('mutation:uncertain');
  assert.equal(records.get('mutation:uncertain').status,'resolved');
  assert.equal(context.state.verificationState.mutations,2);assert.equal(workspace.control.writes,0);
  assert.match(context.state.messages[0].content,/user reviewed and accepted/);
  const store=Mutations.create({inspect:async()=>{throw Error('Do not infer a resolved operation again');},load:async()=>records.get('mutation:uncertain'),save:async()=>true});
  await assert.rejects(store.perform(plan('mutation:uncertain'),async()=>{throw Error('Do not replay');}),{code:'mutation_reconciliation'});
});

test('conversation cleanup removes outputs but retains uncertain mutation receipts',async()=>{
  const records=new Map([
    ['artifact:old',{id:'artifact:old',convId:'conversation',kind:'tool-output'}],
    ['mutation:unknown',{id:'mutation:unknown',convId:'conversation',status:'unknown'}],
    ['mutation:applied',{id:'mutation:applied',convId:'conversation',status:'applied'}],
    ['artifact:other',{id:'artifact:other',convId:'other',kind:'tool-output'}]
  ]);
  const context=services(memoryDirectory({}),records);await context.deleteHarnessArtifacts('conversation');
  assert.equal(records.has('artifact:old'),false);assert.equal(records.has('mutation:applied'),false);
  assert.equal(records.has('mutation:unknown'),true);assert.equal(records.has('artifact:other'),true);
});

test('manual capability checks confirm protocol support and charge usage without executing tools',async()=>{
  let requests=0,saves=0,charged=0;
  const context=client(async(_,options)=>{requests++;assert.equal(JSON.parse(options.body).max_tokens,128);
    return sse({tool_calls:[{index:0,id:'probe',function:{name:'harness_probe',arguments:'{"ok":true}'}}]});});
  const fields={'s-api-url':{value:'http://localhost:1234/v1'},'s-api-key':{value:''},'s-backend-type':{value:'openai-compatible'},
    's-capability-probe':{disabled:false},'s-capability-result':{textContent:''}};
  Object.assign(context,{document:{getElementById:id=>fields[id]},harnessFeatureState:{},persistSettings:()=>saves++,showToast:()=>{},
    _updateSessionTok:n=>charged+=n,executeTool:()=>{throw Error('Capability probes must never execute a tool');}});
  vm.runInContext(source('harness-services.js'),context);
  assert.equal(requests,0);await context.probeBackendCapabilities();
  assert.equal(requests,1);assert.equal(saves,1);assert.equal(charged,5);
  assert.match(fields['s-capability-result'].textContent,/tool calling confirmed/);
  assert.equal(fields['s-capability-probe'].disabled,false);assert.equal(context.state.capabilityProbe,false);
});

test('explicit check evidence is invalidated when a touched file changes outside the harness',async()=>{
  const workspace=memoryDirectory({'a.txt':'fixed'}),context=services(workspace);
  context.state.workspaceRevision=1;context.state.mutationPaths=['a.txt'];
  const stamp=await context.captureWorkspaceStamp();
  const report={events:[{kind:'check',status:'ok',exitCode:0,workspaceRevision:1,workspaceStamp:{scope:stamp.scope,paths:stamp.paths}}]};
  context.activeEvidence=()=>report;
  assert.equal((await context.assessHarnessCompletion()).outcome,'verified');
  workspace.files.set('a.txt',new TextEncoder().encode('external'));
  assert.equal((await context.assessHarnessCompletion()).outcome,'completed_unverified');
});

test('executable benchmark fixtures fail before their intended fix and pass afterward',()=>{
  const os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
  const benchmark=JSON.parse(fs.readFileSync(require.resolve('./fixtures/coding-benchmark.json'),'utf8'));
  const fixtureEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('NODE_TEST_')));
  assert.equal(benchmark.tasks.length,8);
  for(const task of benchmark.tasks.filter(t=>t.checks?.length)) {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'sloplobster-benchmark-'));
    try {
      for(const [file,content] of Object.entries(task.files)) {const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);}
      const run=()=>task.checks.map(command=>{
        assert.match(command,/^node --test [\w.-]+\.cjs$/);
        return spawnSync(process.execPath,command.split(' ').slice(1),{cwd:root,env:fixtureEnv,encoding:'utf8',windowsHide:true,timeout:10000});
      });
      for(const result of run())assert.equal(result.status,1,task.name+' should have a failing baseline');
      for(const assertion of task.assertions.filter(a=>task.allowedWrites.includes(a.path)))fs.writeFileSync(path.join(root,assertion.path),assertion.equals);
      for(const result of run())assert.equal(result.status,0,task.name+': '+result.stdout+result.stderr);
    } finally {
      if(path.dirname(root)!==os.tmpdir() || !path.basename(root).startsWith('sloplobster-benchmark-'))throw Error('Invalid temporary fixture root');
      fs.rmSync(root,{recursive:true,force:true});
    }
  }
});

test('journal replay closes recovered and manually resolved file operations',()=>{
  const Journal=require('../src/journal-core.js');
  const events=[['tool.started','write'],['mutation.recovered','write'],['edit.started','move'],['mutation.resolved','move']]
    .map(([type,operationId],index)=>({runId:'run',seq:index+1,type,detail:{operationId}}));
  assert.equal(Journal.replay(events).incomplete.length,0);
});
