/* Browser adapters for durable mutations, output artifacts and completion. */
const harnessWorkspaceServices = new WeakMap();
let harnessMutationContext = null;
async function workspaceServices() {
  requireWorkspace();
  const root = state.dirHandle;
  if (harnessWorkspaceServices.has(root)) return harnessWorkspaceServices.get(root);
  const scope = await verificationScope();
  const observed = new Map();
  async function entry(path, create = false) {
    const parts = sanitizePath(path); let dir = root;
    for (const part of parts.slice(0,-1)) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name:parts.at(-1) };
  }
  async function hashBytes(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function inspect(path) {
    let count=0, total=0;
    async function walk(handle) {
      if(++count>10000) throw new Error('Mutation snapshot exceeds 10,000 entries; narrow the requested operation.');
      if(handle.kind==='file') {
        const file=await handle.getFile(); total+=file.size;
        if(total>200*1024*1024) throw new Error('Mutation snapshot exceeds 200 MB; narrow the requested operation.');
        return 'file:'+await hashBytes(await file.arrayBuffer());
      }
      const children=[];
      for await(const [name,child] of handle.entries()) children.push([name,await walk(child)]);
      children.sort((a,b)=>a[0].localeCompare(b[0]));
      return 'directory:'+await hashBytes(new TextEncoder().encode(JSON.stringify(children)));
    }
    try {
      const {dir,name}=await entry(path);
      let handle;
      try { handle=await dir.getFileHandle(name); }
      catch(error) { if(error.name!=='TypeMismatchError') throw error; handle=await dir.getDirectoryHandle(name); }
      return await walk(handle);
    } catch(error) { if(error.name==='NotFoundError') return null; throw error; }
  }
  const store=HarnessMutations.create({ inspect, load:id=>dbGet('agent_states',id), save:record=>dbSet('agent_states',record) });
  function operationId(kind, paths, explicit) {
    return 'mutation:'+(explicit || harnessMutationContext?.id || crypto.randomUUID())+':'+kind+':'+HarnessCore.fingerprint(paths);
  }
  async function perform(kind, entries, apply, explicit) {
    const id=operationId(kind,entries.map(e=>e.path),explicit);
    const unresolved=[];
    for(const record of await dbGetAll('agent_states')) {
      if(record.id===id || !record.id?.startsWith('mutation:') || !['prepared','unknown'].includes(record.status)) continue;
      let same=record.scope===scope;
      if(!same && record.workspaceHandle?.isSameEntry) same=await record.workspaceHandle.isSameEntry(root);
      if(same) unresolved.push(record);
    }
    if(unresolved.length) throw Object.assign(new Error('Unresolved mutation '+unresolved[0].id+' must be reconciled before another file change.'),{code:'mutation_unknown'});
    const callKey=explicit || harnessMutationContext?.id;
    const call=state.messages.flatMap(m=>m.tool_calls || []).find(tc=>tc._operationId===callKey);
    const plan={id,kind,entries,scope,workspaceHandle:root,convId:state.activeConvId,operationId:callKey,
      runId:state.runController?.snapshot().id,toolCallId:harnessMutationContext?.toolCallId || call?.id};
    const receipt=await store.perform(plan,apply);
    if (!receipt.alreadyApplied && entries.some(e=>e.before!==e.after)) state.progressRevision=(state.progressRevision || 0)+1;
    state.mutationPaths ||= [];
    for(const item of entries) { observed.set(item.path,item.after); if(!state.mutationPaths.includes(item.path)) state.mutationPaths.push(item.path); }
    return receipt;
  }
  async function write(path, content, original, explicit) {
    const before=await inspect(path);
    if (original === null && before !== null) throw Object.assign(new Error('A file appeared at the destination since preview.'),{code:'stale_file'});
    if (original !== null) {
      const {dir,name}=await entry(path), handle=await dir.getFileHandle(name);
      if (await (await handle.getFile()).text() !== original) throw Object.assign(new Error('File changed since preview. Read it again.'),{code:'stale_file'});
    }
    const after='file:'+await hashBytes(new TextEncoder().encode(content));
    if(observed.has(path) && observed.get(path)!==before) throw Object.assign(new Error('File changed since the last tool read. Read '+path+' again.'),{code:'stale_file'});
    return perform('write',[{path,before,after}],async()=>{
      const {dir,name}=await entry(path,true), handle=await dir.getFileHandle(name,{create:true});
      const stream=await handle.createWritable();
      try { await stream.write(content); await stream.close(); }
      catch(error) { await stream.abort?.().catch(()=>{}); throw error; }
    },explicit);
  }
  async function remove(path, recursive, explicit) {
    const before=await inspect(path);
    if(before===null) throw new DOMException('File not found','NotFoundError');
    if(observed.has(path) && observed.get(path)!==before) throw Object.assign(new Error('File changed since it was read. Read it again before deleting.'),{code:'stale_file'});
    return perform('delete',[{path,before,after:null}],async()=>{ const {dir,name}=await entry(path); await dir.removeEntry(name,{recursive:!!recursive}); },explicit);
  }
  async function move(source,destination,explicit) {
    const before=await inspect(source), destinationBefore=await inspect(destination);
    if(!before?.startsWith('file:')) throw new Error('move_file requires a source file.');
    if(destinationBefore!==null) throw Object.assign(new Error('Destination already exists. Choose a new path instead of overwriting it.'),{code:'file_conflict'});
    if(observed.has(source) && observed.get(source)!==before) throw Object.assign(new Error('Source changed since it was read. Read it again before moving.'),{code:'stale_file'});
    return perform('move',[{path:source,before,after:null},{path:destination,before:null,after:before}],async()=>{
      const src=await entry(source), srcHandle=await src.dir.getFileHandle(src.name), blob=await srcHandle.getFile();
      const dst=await entry(destination,true), handle=await dst.dir.getFileHandle(dst.name,{create:true}), stream=await handle.createWritable();
      try { await stream.write(blob); await stream.close(); }
      catch(error) { await stream.abort?.().catch(()=>{}); throw error; }
      // Never delete the source unless the destination contains identical bytes.
      if(await inspect(destination)!==before || await inspect(source)!==before) throw Object.assign(new Error('Move interrupted by a concurrent file change.'),{code:'stale_file'});
      await src.dir.removeEntry(src.name);
    },explicit);
  }
  const service={scope,root,observed,inspect,write,remove,move,reconcile:store.reconcile};
  harnessWorkspaceServices.set(root,service); return service;
}
async function commitWorkspaceWrite(path,content,original,operationId) {
  return (await workspaceServices()).write(path,content,original,operationId);
}
async function captureWorkspaceStamp() {
  const scope=await verificationScope(), revision=state.workspaceRevision || 0;
  const paths=[];
  if(state.dirHandle && state.mutationPaths?.length) {
    const service=await workspaceServices();
    for(const path of [...new Set(state.mutationPaths)].sort()) paths.push([path,await service.inspect(path)]);
  }
  return {scope,revision,paths};
}
async function pendingHarnessOperations() {
  return (await dbGetAll('agent_states')).filter(record=>record.convId===state.activeConvId &&
    (record.commandId || record.id?.startsWith('mutation:') && ['prepared','unknown'].includes(record.status)));
}
async function reconcileWorkspaceMutations() {
  if(!state.dirHandle) return;
  const service=await workspaceServices(), unresolved=[];
  function missingResult(record) {
    if(record.convId!==state.activeConvId || !record.operationId) return false;
    const index=state.messages.findIndex(m=>m.tool_calls?.some(tc=>tc._operationId===record.operationId));
    if(index<0) return false;
    const call=state.messages[index].tool_calls.find(tc=>tc._operationId===record.operationId);
    for(let i=index+1;i<state.messages.length && state.messages[i].role==='tool';i++) if(state.messages[i].tool_call_id===call.id) return false;
    return true;
  }
  const records=(await dbGetAll('agent_states')).filter(r=>r.id?.startsWith('mutation:') && (['prepared','unknown'].includes(r.status) || missingResult(r)));
  for(const record of records) {
    let same=record.scope===service.scope;
    if(record.workspaceHandle?.isSameEntry) same=await record.workspaceHandle.isSameEntry(state.dirHandle);
    if(!same) continue;
    const outcome=await service.reconcile(record);
    if(outcome.status==='unknown') { unresolved.push(record.id); continue; }
    const text='Recovered '+record.kind+' operation '+record.id+': '+outcome.status.replace('_',' ')+'. No operation was replayed. Re-read affected files before continuing.';
    const callIndex=state.messages.findIndex(m=>m.tool_calls?.some(tc=>record.operationId?tc._operationId===record.operationId:tc.id===record.toolCallId));
    let insert=callIndex+1,existing;
    if(callIndex>=0) while(insert<state.messages.length && state.messages[insert].role==='tool') {
      if(state.messages[insert].tool_call_id===record.toolCallId) existing=state.messages[insert]; insert++;
    }
    if(existing) existing.content=text;
    else if(record.toolCallId && callIndex>=0) state.messages.splice(insert,0,{role:'tool',tool_call_id:record.toolCallId,content:text,_operationId:record.operationId});
    else state.messages.push({role:'user',content:'[Mutation recovery]\n'+text,_harnessContext:true});
    if(outcome.status==='applied') {
      state.workspaceRevision=(state.workspaceRevision || 0)+1;
      state.mutationPaths=[...new Set([...(state.mutationPaths || []),...record.entries.map(e=>e.path)])];
      if(state.verificationState) state.verificationState.mutations++;
    }
    if(typeof resolveHarnessEvidence==='function') resolveHarnessEvidence(record.toolCallId,{status:outcome.status==='applied'?'ok':'resolved',output:text},record.operationId);
    await recordRunEvent('mutation.recovered',{operationId:record.operationId || record.id,receiptId:record.id,status:outcome.status,paths:record.entries.map(e=>e.path)});
  }
  saveCurrentConv();
  if(unresolved.length) throw new Error('Unresolved file mutation outcomes: '+unresolved.join(', ')+'. Inspect these files before resuming.');
}
async function archiveToolOutput(name,result,operationId) {
  if(!result || typeof result.output!=='string' || result._pendingApproval || name==='read_artifact') return result;
  const content=redactSecrets(result.output);
  if(content.length<2000 && result.status!=='error' && result.status!=='unknown') return result;
  const id='artifact:'+(operationId || crypto.randomUUID());
  const record={id,kind:'tool-output',convId:state.activeConvId,runId:state.runController?.snapshot().id,
    tool:name,status:result.status,created:Date.now(),content:content.slice(0,4*1024*1024),originalChars:content.length,truncated:content.length>4*1024*1024};
  // Keep large content out of command/mutation recovery scans.
  if(!(await dbSet('tool_artifacts',record)) || !(await dbSet('agent_states',{...record,content:undefined}))) {
    state.running=false;
    return {...result,_artifactError:true,output:result.output+'\n[Task paused: output artifact storage failed. The tool result is retained here; inspect storage before resuming.]'};
  }
  const ref={id,tool:name,status:result.status,characters:record.content.length,truncated:record.truncated};
  state.artifactRefs=[...(state.artifactRefs || []).filter(r=>r.id!==id),ref].slice(-64);
  const artifacts=(await dbGetAll('agent_states')).filter(r=>r.kind==='tool-output' && r.convId===state.activeConvId).sort((a,b)=>a.created-b.created);
  const protectedIds=new Set([...(state.artifactRefs || []),...(state.taskState?.artifacts || [])].map(r=>r.id));
  let excess=artifacts.length-128;
  for(const old of artifacts) {
    if(excess<=0) break;
    if(protectedIds.has(old.id) || state.messages.some(m=>m._artifactId===old.id || String(m.content || '').includes(old.id))) continue;
    await dbDelete('tool_artifacts',old.id); await dbDelete('agent_states',old.id); excess--;
  }
  return {...result,_artifactId:id};
}
async function readHarnessArtifact(args) {
  const id=String(args.artifact_id || '');
  const record=await dbGet('tool_artifacts',id) || await dbGet('agent_states',id);
  if(!record || record.kind!=='tool-output' || record.convId!==state.activeConvId) return {status:'error',output:'Error: output artifact is unavailable in this conversation.'};
  const offset=Math.max(0,Math.floor(Number(args.offset)||0)),limit=Math.max(1,Math.min(20000,Number(args.limit)||6000));
  return {status:'ok',output:record.content.slice(offset,offset+limit)+'\n[Artifact '+record.id+'; '+offset+'-'+Math.min(record.content.length,offset+limit)+' of '+record.content.length+' characters'+(record.truncated?'; original output exceeded artifact limit':'')+']'};
}
async function deleteHarnessArtifacts(convId) {
  for(const record of await dbGetAll('agent_states')) {
    if(record.convId!==convId || record.commandId || ['prepared','unknown'].includes(record.status)) continue;
    if(record.kind==='tool-output' || record.id?.startsWith('mutation:')) {
      if(record.kind==='tool-output' && !(await dbDelete('tool_artifacts',record.id))) throw new Error('Could not remove output content.');
      if(!(await dbDelete('agent_states',record.id))) throw new Error('Could not remove conversation artifacts.');
    }
  }
  if(!(await dbDelete('agent_states','task:'+convId))) throw new Error('Could not remove conversation checkpoint.');
}
async function resolveHarnessMutation(id) {
  const record=await dbGet('agent_states',id),service=await workspaceServices();
  const same=record && (record.scope===service.scope || record.workspaceHandle?.isSameEntry && await record.workspaceHandle.isSameEntry(state.dirHandle));
  if(!same || !['prepared','unknown'].includes(record.status)) throw new Error('No unresolved mutation belongs to this workspace.');
  const current=[];
  for(const entry of record.entries) current.push({path:entry.path,before:entry.before,expected:entry.after,current:await service.inspect(entry.path)});
  if(!confirm('Review these files before accepting their current state:\n\n'+JSON.stringify(current,null,2)+'\n\nAccept the current files and clear this recovery block? This does not repeat or undo the operation.')) return;
  for(const entry of current) if(await service.inspect(entry.path)!==entry.current) throw new Error('Files changed during review. Refresh and inspect them again.');
  if(!(await dbSet('agent_states',{...record,status:'resolved',resolution:'user_accepted_current',current,resolvedAt:Date.now()}))) throw new Error('Could not save mutation resolution.');
  state.workspaceRevision=(state.workspaceRevision || 0)+1;
  if(state.verificationState) state.verificationState.mutations++;
  state.mutationPaths=[...new Set([...(state.mutationPaths || []),...current.map(e=>e.path)])];
  for(const entry of current) service.observed.set(entry.path,entry.current);
  state.messages.push({role:'user',content:'[Mutation recovery] The user reviewed and accepted the current state for '+id+'. Re-read affected files and verify before claiming completion.',_harnessContext:true});
  if(typeof resolveHarnessEvidence==='function') resolveHarnessEvidence(record.toolCallId,{status:'resolved',output:'User accepted the current files; the original outcome remains uncertain.'},record.operationId);
  await recordRunEvent('mutation.resolved',{operationId:record.operationId || id,receiptId:id,current});
  saveCurrentConv(); await saveActiveAgentState();
}
async function assessHarnessCompletion() {
  if(typeof collectCompletedCommandJobs==='function') await collectCompletedCommandJobs();
  const verification=state.verificationState;
  if(verification?.latest?.workspaceStamp) {
    const current=await captureWorkspaceStamp();
    verification.latest.stale=HarnessCore.canonical(current)!==HarnessCore.canonical(verification.latest.workspaceStamp);
  }
  if(state.autoVerifyCommand && state.compConnected && !state.disabledTools?.has('run_tests') && verification?.mutations &&
    (!verification.latest || verification.latest.revision!==verification.mutations || verification.latest.stale)) await verifyAfterChanges();
  const report=typeof activeEvidence==='function'?activeEvidence():null;
  const evidence=report?HarnessFeatures.evidenceSummary(report.events,state.workspaceRevision || 0):null;
  if(evidence?.verified && !state.verificationState?.latest) {
    const check=report.events.filter(e=>e.kind==='check').at(-1),current=await captureWorkspaceStamp();
    evidence.verified=!!check?.workspaceStamp && !check.stale && HarnessCore.canonical(check.workspaceStamp)===HarnessCore.canonical({scope:current.scope,paths:current.paths});
  }
  const completion=HarnessCore.completion({mutated:(state.workspaceRevision || 0)>0,verification:state.verificationState,
    evidence,pending:await pendingHarnessOperations(),checklist:state.planItems || [],criteria:report?.criteria || []});
  state.completion={...completion,revision:state.workspaceRevision || 0,created:Date.now()};
  await recordRunEvent('completion.assessed',state.completion);
  return state.completion;
}

async function probeBackendCapabilities() {
  if(state.running || state.capabilityProbe || harnessFeatureState.evaluationAbort) { showToast('Wait for the current task to finish.','warn'); return; }
  const target=document.getElementById('s-capability-result'), button=document.getElementById('s-capability-probe');
  const base=document.getElementById('s-api-url').value.replace(/\/+$/,''), apiKey=document.getElementById('s-api-key').value.trim();
  const backendType=document.getElementById('s-backend-type').value, model=state.model;
  if(!model) { if(target) target.textContent='Connect and select a model first.'; return; }
  if(state.tokenBudget>0 && _sessionTotalOut+128>state.tokenBudget) { if(target) target.textContent='Not enough session token budget for the capability check.'; return; }
  if(button) button.disabled=true;
  state.capabilityProbe=true;
  if(target) target.textContent='Checking streaming and a harmless tool call…';
  const acc={content:'',reasoning:'',toolCalls:[]};
  let probeUsage;
  try {
    const body=HarnessBackend.normalize({model,stream:true,max_tokens:128,temperature:0,
      messages:[{role:'user',content:'Call harness_probe once with {"ok":true}. This checks API compatibility; the tool will not be executed.'}],
      tools:[{type:'function',function:{name:'harness_probe',description:'Harmless protocol check.',parameters:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}}}],
      tool_choice:{type:'function',function:{name:'harness_probe'}}},{backendType});
    const signal=AbortSignal.timeout(30000);
    const response=await fetch(HarnessBackend.url(base,'/v1/chat/completions'),{method:'POST',headers:HarnessBackend.headers(apiKey,{'Content-Type':'application/json'}),body:JSON.stringify(body),signal});
    if(!response.ok) throw Object.assign(new Error('HTTP '+response.status+': '+(await response.text()).slice(0,200)),{status:response.status});
    await HarnessModelStream.read(response,{signal,idleMs:30000,onChunk(chunk){ if(chunk.usage) probeUsage=chunk.usage; applySSEDelta(chunk,acc); }});
    const toolCalls=acc.finishReason!=='length' && acc.toolCalls.some(t=>t?.function?.name==='harness_probe' && (()=>{try{return JSON.parse(t.function.arguments).ok===true;}catch{return false;}})());
    const result={streaming:true,toolCalls,usage:!!probeUsage,checkedAt:Date.now(),probe:true};
    state.backendCapabilities ||= {};
    state.backendCapabilities[HarnessBackend.key({apiUrl:base,backendType,model})]=result;
    persistSettings();
    if(target) target.textContent='Streaming confirmed; tool calling '+(toolCalls?'confirmed':'not confirmed')+'; usage reporting '+(probeUsage?'available':'not observed')+'. No tool was executed.';
  } catch(error) {
    if(target) target.textContent='Capability check failed ('+HarnessBackend.classify(error).code+'): '+error.message;
  } finally {
    const used=Number.isFinite(probeUsage?.completion_tokens)?probeUsage.completion_tokens:estimateTokens(acc.content+acc.reasoning+JSON.stringify(acc.toolCalls));
    if(used) _updateSessionTok(used);
    if(button) button.disabled=false;
    state.capabilityProbe=false;
  }
}
