/* Companion transport and resumable command jobs; embedded in the single HTML. */
async function companionFetch(url, options = {}) {
  const target = new URL(url);
  const base = new URL(state.compUrl);
  if (target.origin !== base.origin) throw new Error('Companion token may only be sent to the configured companion');
  const headers = new Headers(options.headers);
  if (state.compToken) headers.set('Authorization', 'Bearer ' + state.compToken);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    if(response.status===401 && typeof updateCompanionPairing==='function') updateCompanionPairing('unauthorized');
    let error, errorName;
    try { const body=await response.json(); error=body.error; errorName=body.errorName; } catch { }
    const failure = new Error(error || 'Companion HTTP ' + response.status);
    failure.status = response.status; failure.errorName = errorName;
    throw failure;
  }
  return response;
}

async function commandRequest(path, body, signal) {
  const response = await companionFetch(state.compUrl + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
  });
  return response.json();
}

// Cancel must not be fire-and-forget: a lost cancel leaves a process running on the user's machine.
async function cancelCommandReliably(commandId) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await commandRequest('/commands/cancel', { id: commandId }); return true; }
    catch (error) { if ([400, 401, 403, 404].includes(error.status)) return false; await new Promise(r => setTimeout(r, 300 * 2 ** attempt)); }
  }
  console.warn('[companion] could not confirm cancellation of ' + commandId);
  return false;
}

function commandDelay(signal, ms = 250) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function followCommandJob(job, signal, onLine) {
  const key = 'command:' + job.commandId;
  if(job.result) return job.result;
  let polls = 0;
  try {
    while (true) {
      const data = await commandRequest('/commands/status', { id: job.commandId, cursor: job.cursor || 0 }, signal);
      for (const event of data.events) {
        job.output = (job.output || '') + event.d;
        try { onLine?.(redactSecrets(event.d), event.t === 'e'); } catch { }
      }
      job.cursor = data.cursor;
      job.output = redactSecrets(job.output || '');
      if (data.status !== 'running' && data.status !== 'cancelling') {
        let output = job.output;
        if (data.truncated) output += '\n[Output truncated at companion limit]';
        if (data.exitCode !== 0) output += '\n[exit code: ' + data.exitCode + ']';
        const result = { output, status: data.status, exitCode: data.exitCode, truncated: data.truncated,
          commandId: job.commandId, error: data.status === 'ok' ? null : data.status, retryable: false };
        Object.assign(job,{status:'completed',result});
        if(!(await dbSet('agent_states',{...job,id:key}))) throw new Error('Completed command could not be checkpointed; its result must be recovered.');
        return result;
      }
      await dbSet('agent_states', { ...job, id: key });
      // Fast at first for short commands, then back off so long builds do not hammer the companion.
      await commandDelay(signal, Math.min(2000, 250 * 1.5 ** Math.min(polls++, 8)));
    }
  } catch (error) {
    // A transport failure is an unknown outcome, never permission to repeat a command.
    await dbSet('agent_states', { ...job, id: key });
    throw error;
  }
}

async function executeCompanionJob(command, timeout, externalSignal, onLine, toolCallId, cwd, argv) {
  const commandId = crypto.randomUUID();
  const job = { id: 'command:' + commandId, commandId, convId: state.activeConvId, toolCallId,
    operationId:state.messages?.flatMap(m=>m.tool_calls || []).findLast(tc=>tc.id===toolCallId)?._operationId,
    companionUrl: state.compUrl, cwd, command: redactSecrets(command), cursor: 0, output: '', timestamp: Date.now() };
  if (typeof recordRunEvent === 'function') await recordRunEvent('command.started', { operationId: commandId, toolCallId, command, timeout, cwd });
  // Save the ID before launching so a lost start response can be reconciled after reload.
  if(!(await dbSet('agent_states', job))) throw new Error('Command could not be checkpointed; it was not launched.');
  const signals = [AbortSignal.timeout(timeout * 1000 + 15000)];
  if (externalSignal) signals.push(externalSignal);
  if (state.running && state.abortCtrl?.signal) signals.push(state.abortCtrl.signal);
  const signal = AbortSignal.any(signals);
  const cancel = () => { cancelCommandReliably(commandId); };
  signal.addEventListener('abort', cancel, { once: true });
  let started = false;
  try {
    if (signal.aborted) throw signal.reason;
    await commandRequest('/commands/start', { id: commandId, command, timeout, cwd, ...(argv?{argv}:{}), taskId: typeof featureTask==='function'?featureTask()?.id:undefined }, signal);
    started = true;
    const result = await followCommandJob(job, signal, onLine);
    if (typeof recordRunEvent === 'function') await recordRunEvent('command.completed', { operationId: commandId, status: result.status, exitCode: result.exitCode, output: result.output });
    return result;
  } catch (error) {
    if (!started && [400, 401, 403, 404].includes(error.status)) {
      if (typeof recordRunEvent === 'function') await recordRunEvent('command.failed', { operationId: commandId, error: error.message });
      await dbDelete('agent_states', job.id);
      return { status: 'error', error: error.message, retryable: false, commandId,
        output: 'Error: companion rejected the command before execution: ' + error.message };
    }
    if (signal.aborted) cancel();
    if (typeof recordRunEvent === 'function') await recordRunEvent('command.unknown', { operationId: commandId, error: error.message });
    return { status: signal.aborted ? 'cancelled' : 'unknown', error: error.message, retryable: false,
      commandId, output: 'Command outcome requires reconciliation (' + commandId + '): ' + error.message +
        '\nThe command may have run. Reconnect and resume this task to collect its status; do not repeat it.' };
  } finally { signal.removeEventListener('abort', cancel); }
}

async function collectCompletedCommandJobs() { return reconcileCommandJobs(true); }
async function reconcileCommandJobs(completedOnly=false) {
  const jobs = (await dbGetAll('agent_states')).filter(job => job.commandId && job.convId === state.activeConvId && (!completedOnly || job.result));
  const unresolved = [];
  // Completed receipts are normal durable-result cleanup, not interrupted jobs.
  // Report actual recovery once per batch instead of flooding the conversation.
  const unfinished = jobs.filter(job => !job.result);
  if (unfinished.length) appendMsg('system', 'Recovering ' + unfinished.length + ' unfinished command' + (unfinished.length === 1 ? '' : 's') + ' from saved state. Commands will not be repeated.');
  for (const job of jobs) {
    // Collect sibling outcomes before pausing. Unknown commands are never silently forgotten.
    if (!job.result && job.companionUrl !== state.compUrl) {
      appendMsg('system', 'Skipped unfinished command ' + job.commandId + ': it belongs to another companion (' + job.companionUrl + '). Reconnect there to recover it.');
      unresolved.push(job.commandId + ': reconnect to its original companion');
      continue;
    }
    let result;
    try { result = await followCommandJob(job, state.abortCtrl?.signal); }
    catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error.status === 404) {
        appendMsg('system', 'Command ' + job.commandId + ' is no longer known to the companion; its outcome is unknown. Inspect the workspace before continuing.');
        const acknowledged = typeof showActionConfirm === 'function' && await new Promise(resolve =>
          showActionConfirm('Unknown command outcome', job.command + '\nInspect the workspace before acknowledging. This command will not be replayed.',
            value => resolve(value !== false), { yesLabel: 'Acknowledge outcome' }));
        if (acknowledged) {
          if (typeof recordRunEvent === 'function') await recordRunEvent('command.acknowledged', { operationId: job.commandId, status: 'unknown' });
          if(typeof noteVerificationMutation==='function') noteVerificationMutation('execute_command',{status:'unknown'});
          if(typeof resolveHarnessEvidence==='function') resolveHarnessEvidence(job.toolCallId,{status:'resolved',output:'User acknowledged the unknown command outcome; inspect the current workspace.'});
          const index=state.messages.findLastIndex(m=>m.tool_calls?.some(tc=>job.operationId?tc._operationId===job.operationId:tc.id===job.toolCallId));
          if(index>=0) {
            let insert=index+1,previous;
            while(insert<state.messages.length && state.messages[insert].role==='tool') {if(state.messages[insert].tool_call_id===job.toolCallId) previous=state.messages[insert];insert++;}
            const content='Command outcome is unknown. The user acknowledged it; it was not replayed. Inspect current files before continuing.';
            if(previous) previous.content=content;
            else state.messages.splice(insert,0,{role:'tool',tool_call_id:job.toolCallId,content,_commandId:job.commandId,_status:'resolved'});
          }
          state.messages.push({ role: 'user', content: '[Command recovery] The user acknowledged the unknown outcome of command ' + job.commandId + '. Do not repeat it; inspect current workspace state before acting.' });
          if(typeof persistCommandConversation==='function') await persistCommandConversation(job,{status:'unknown',acknowledged:true});
          else await saveCurrentConv();
          if(await dbDelete('agent_states',job.id || 'command:'+job.commandId)===false) throw new Error('Command acknowledgment could not be saved.');
          continue;
        }
      } else appendMsg('system', 'Could not recover command ' + job.commandId + ': ' + error.message);
      unresolved.push(job.commandId + ': ' + error.message);
      continue;
    }
    const content = result.output || 'Command completed with exit code ' + result.exitCode;
    const callIndex=state.messages.findLastIndex(m=>m.tool_calls?.some(tc=>job.operationId?tc._operationId===job.operationId:tc.id===job.toolCallId));
    let previous,insert=callIndex+1;
    if(callIndex>=0) while(insert<state.messages.length && state.messages[insert].role==='tool') {
      if(state.messages[insert].tool_call_id===job.toolCallId) previous=state.messages[insert]; insert++;
    }
    const recovering=!completedOnly || !previous && !!job.toolCallId;
    if(recovering && typeof noteVerificationMutation==='function') noteVerificationMutation('execute_command',result);
    if(recovering && typeof resolveHarnessEvidence==='function') resolveHarnessEvidence(job.toolCallId,result,job.operationId);
    if (typeof recordRunEvent === 'function') await recordRunEvent('command.completed', { operationId: job.commandId, recovered: true, status: result.status, exitCode: result.exitCode, output: content });
    if(previous) {if(recovering) previous.content=content;previous._commandId=job.commandId;previous._status=result.status;}
    else if(callIndex>=0) state.messages.splice(insert,0,{role:'tool',tool_call_id:job.toolCallId,content,_commandId:job.commandId,_status:result.status});
    else if(!completedOnly) state.messages.push({role:'user',content:'[Recovered command result]\n'+content,_commandId:job.commandId});
    if(typeof persistCommandConversation==='function') await persistCommandConversation(job,result);
    else await saveCurrentConv();
    if(await dbDelete('agent_states',job.id || 'command:'+job.commandId)===false) throw new Error('Command result saved, but recovery receipt could not be acknowledged.');
  }
  if (unresolved.length) throw new Error('Unresolved command outcomes: ' + unresolved.join('; '));
}
