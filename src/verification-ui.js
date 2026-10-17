/* Automatic checks use the same command and workspace as their persisted baseline. */
var verificationWorkspaceIds = new WeakMap();
async function verificationScope() {
  const task = typeof featureTask === 'function' && featureTask();
  let folder = task?.id;
  if (!folder && state.dirHandle) {
    const handle = state.dirHandle;
    folder = verificationWorkspaceIds.get(handle);
    if (!folder) {
      const saved = typeof dbGet === 'function' ? await dbGet('agent_states', 'verification-workspaces') : null;
      const records = saved?.records || [];
      for (const record of records) {
        try { if (await handle.isSameEntry(record.handle)) { folder = record.id; break; } } catch { }
      }
      if (!folder) {
        folder = 'verification-workspace:' + crypto.randomUUID();
        records.push({ id: folder, handle });
        if (typeof dbSet === 'function') await dbSet('agent_states', { id: 'verification-workspaces', records });
      }
      verificationWorkspaceIds.set(handle, folder);
    }
  }
  folder ||= (typeof harnessFeatureState !== 'undefined' && harnessFeatureState.workspace) || state.dirName || 'no-workspace';
  return [folder, state.compUrl || '', task?.path || state.compInfo?.cwd || ''].join('|');
}
function verificationMessage(text) {
  state.messages.push({ role: 'user', content: text, _harnessContext: true, _verificationContext: true });
  updateContextMeter();
}
function noteVerificationMutation(name, result) {
  if (state.verificationState && HarnessVerification.requiresRecheck(name, result)) {
    state.verificationState.mutations++;
    saveCurrentConv();
  }
}
async function executeVerificationCommand(command, signal) {
  let actual = command;
  if (isDangerous(command) && !(state.shellAutoApprove && state.shellAutoApproveDangerous)) {
    actual = await new Promise(resolve => showShellConfirm(command, resolve, 'Verification command', signal));
    if (!actual) return { command, status: 'blocked', output: 'Verification command was declined.' };
  }
  rpTermStart(actual);
  try {
    const result = await execViaCompanion(actual, Math.max(state.cmdTimeout || 60, 120), signal,
      text => rpTermAppend(text), true);
    rpTermEnd(result.output || '');
    return { ...result, command: actual };
  } catch (error) {
    rpTermEnd(error.message);
    if (signal?.aborted || error.name === 'AbortError') throw error;
    return { command: actual, status: 'error', output: 'Verification could not run: ' + error.message };
  }
}
async function ensureVerificationBaseline() {
  const command = String(state.autoVerifyCommand || '').trim();
  if (!command || !state.runController) return null;
  const runId = state.runController.snapshot().id, scope = await verificationScope();
  let v = state.verificationState;
  if (!v || v.runId !== runId) {
    const saved = state.taskState?.verification;
    v = saved?.runId === runId ? structuredClone(saved) : { runId, scope, command, mutations: 0, baseline: null, latest: null };
    state.verificationState = v;
    state._autoVerifyRetries = v.retries || 0;
  }
  if (v.scope !== scope || v.command !== command) {
    // A changed environment is not an untouched baseline for the already edited task.
    v.baseline = { command, status: 'unavailable', output: 'Verification command or workspace changed during this task.' };
    v.command = command; v.scope = scope;
  }
  if (v.capturing && !v.baseline) v.baseline = { command, status: 'unavailable', output: 'Baseline capture was interrupted. Its command outcome must be reconciled before resuming.' };
  if (!v.baseline) {
    if (!state.compConnected || v.mutations || state.disabledTools?.has('run_tests')) {
      v.baseline = { command, status: 'unavailable', output: state.disabledTools?.has('run_tests') ? 'Test execution is disabled in tool settings.' : !state.compConnected ? 'Companion unavailable before editing.' : 'Changes already started; no untouched baseline is available.' };
    } else {
      v.capturing = true;
      saveCurrentConv(); await saveActiveAgentState();
      appendMsg('system', 'Recording verification baseline: ' + command);
      const result = await executeVerificationCommand(command, state.abortCtrl?.signal);
      v.baseline = HarnessVerification.snapshot(result.command || command, { ...result, output: redactSecrets(String(result.output || '')) });
      v.capturing = false;
    }
    await recordRunEvent('verification.baseline', { command, scope, baseline: v.baseline });
    recordHarnessTool('run_tests', { command }, { status: v.baseline.status === 'passed' ? 'ok' : 'error',
      exitCode: v.baseline.exitCode, output: v.baseline.output, _verification: { phase: 'baseline', snapshot: v.baseline } }, 'baseline:' + runId);
    saveCurrentConv(); await saveActiveAgentState();
  }
  if (!state.messages.some(m => m._verificationContext && m._baselineRunId === runId)) {
    verificationMessage('[VERIFICATION BASELINE] ' + command + ': ' + v.baseline.status + '. ' +
      (v.baseline.status === 'failed' ? 'These failures existed before this task; preserve this distinction and avoid unrelated repairs.\n' + (v.baseline.failureIds?.join('\n') || v.baseline.output?.slice(-1500))
        : v.baseline.status === 'passed' ? 'The configured check passed before edits.' : v.baseline.output || '') );
    state.messages.at(-1)._baselineRunId = runId;
  }
  return v;
}
async function verifyAfterChanges() {
  const v = await ensureVerificationBaseline();
  if (!v || !state.running || !state.compConnected || state.disabledTools?.has('run_tests')) return null;
  const command = String(state.autoVerifyCommand).trim();
  const result = await executeVerificationCommand(command, state.abortCtrl?.signal);
  if (!state.running) return null;
  const current = HarnessVerification.snapshot(result.command || command, { ...result, output: redactSecrets(String(result.output || '')) });
  const comparison = HarnessVerification.compare(v.baseline, current);
  v.latest = { snapshot: current, comparison };
  await recordRunEvent('verification.result', { command, scope: v.scope, snapshot: current, comparison });
  recordHarnessTool('run_tests', { command }, { ...result, status: current.status === 'passed' ? 'ok' : current.status === 'failed' ? 'error' : current.status, output: current.output,
    _verification: { phase: 'after_changes', snapshot: current, comparison } }, 'verification:' + crypto.randomUUID());
  const label = { passed: 'Verification passed', resolved: 'Baseline failures resolved', regression: 'New failures relative to baseline',
    pre_existing: 'Only pre-existing failures remain', unclassified_failure: 'Verification failed; comparison is inconclusive', inconclusive: 'Verification could not establish a result' }[comparison.outcome];
  appendMsg('system', label + ': ' + command);
  if (comparison.outcome === 'regression') {
    if ((v.retries || 0) < state.autoVerifyMaxRetries) {
      v.retries = (v.retries || 0) + 1;
      verificationMessage('[AUTO-VERIFY REGRESSION, repair ' + v.retries + '/' + state.autoVerifyMaxRetries + '] New failures were observed relative to the pre-edit baseline. Causality is not established. Investigate the changes and repair relevant regressions; do not broaden the task to unrelated baseline failures.\nNew failure identities: ' + (comparison.newFailures.join(', ') || 'The previously passing command now fails.') + '\nCommand: ' + command + '\n' + current.output.slice(-4000));
    } else verificationMessage('[AUTO-VERIFY] The regression repair limit was reached. Report the remaining failures and evidence; do not claim verification passed.\n' + current.output.slice(-4000));
  } else {
    if (current.status === 'passed') v.retries = 0;
    verificationMessage('[AUTO-VERIFY] ' + label + '. ' +
      (comparison.outcome === 'pre_existing' ? 'Do not automatically repair unrelated existing failures.' : 'Report this result honestly.') +
      '\nCommand: ' + command + '\n' + current.output.slice(-2500));
  }
  state._autoVerifyRetries = v.retries || 0;
  saveCurrentConv(); await saveActiveAgentState();
  return comparison;
}
