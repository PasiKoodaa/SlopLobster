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

function commandDelay(signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, 250);
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function followCommandJob(job, signal, onLine) {
  const key = 'command:' + job.commandId;
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
        await dbDelete('agent_states', key);
        let output = job.output;
        if (data.truncated) output += '\n[Output truncated at companion limit]';
        if (data.exitCode !== 0) output += '\n[exit code: ' + data.exitCode + ']';
        return { output, status: data.status, exitCode: data.exitCode, truncated: data.truncated,
          commandId: job.commandId, error: data.status === 'ok' ? null : data.status, retryable: false };
      }
      await dbSet('agent_states', { ...job, id: key });
      await commandDelay(signal);
    }
  } catch (error) {
    // A transport failure is an unknown outcome, never permission to repeat a command.
    await dbSet('agent_states', { ...job, id: key });
    throw error;
  }
}

async function executeCompanionJob(command, timeout, externalSignal, onLine, toolCallId, cwd) {
  const commandId = crypto.randomUUID();
  const job = { id: 'command:' + commandId, commandId, convId: state.activeConvId, toolCallId,
    companionUrl: state.compUrl, command: redactSecrets(command), cursor: 0, output: '', timestamp: Date.now() };
  // Save the ID before launching so a lost start response can be reconciled after reload.
  await dbSet('agent_states', job);
  const signals = [AbortSignal.timeout(timeout * 1000 + 15000)];
  if (externalSignal) signals.push(externalSignal);
  if (state.running && state.abortCtrl?.signal) signals.push(state.abortCtrl.signal);
  const signal = AbortSignal.any(signals);
  const cancel = () => { commandRequest('/commands/cancel', { id: commandId }).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let started = false;
  try {
    if (signal.aborted) throw signal.reason;
    await commandRequest('/commands/start', { id: commandId, command, timeout, cwd, taskId: typeof featureTask==='function'?featureTask()?.id:undefined }, signal);
    started = true;
    return await followCommandJob(job, signal, onLine);
  } catch (error) {
    if (!started && [400, 401, 403, 404].includes(error.status)) {
      await dbDelete('agent_states', job.id);
      return { status: 'error', error: error.message, retryable: false, commandId,
        output: 'Error: companion rejected the command before execution: ' + error.message };
    }
    if (signal.aborted) cancel();
    return { status: signal.aborted ? 'cancelled' : 'unknown', error: error.message, retryable: false,
      commandId, output: 'Command outcome requires reconciliation (' + commandId + '): ' + error.message +
        '\nThe command may have run. Reconnect and resume this task to collect its status; do not repeat it.' };
  } finally { signal.removeEventListener('abort', cancel); }
}

async function reconcileCommandJobs() {
  const jobs = (await dbGetAll('agent_states')).filter(job => job.commandId && job.convId === state.activeConvId);
  for (const job of jobs) {
    if (job.companionUrl !== state.compUrl) throw new Error('An unfinished command belongs to another companion URL');
    appendMsg('system', 'Recovering command ' + job.commandId + '…');
    const result = await followCommandJob(job, state.abortCtrl?.signal);
    const content = result.output || 'Command completed with exit code ' + result.exitCode;
    const previous = job.toolCallId && state.messages.find(m => m.role === 'tool' && m.tool_call_id === job.toolCallId);
    const pending = job.toolCallId && state.messages.some(m => m.tool_calls?.some(tc => tc.id === job.toolCallId));
    if (previous) previous.content = content;
    else if (pending) state.messages.push({ role: 'tool', tool_call_id: job.toolCallId, content });
    else state.messages.push({ role: 'user', content: '[Recovered command result]\n' + content });
    saveCurrentConv();
  }
}
