/* Pure harness primitives. Embedded into the distributable HTML by scripts/build.mjs. */
(function (root) {
  'use strict';
  const readTools = new Set(['read_file', 'read_file_lines', 'read_file_summary', 'view_image',
    'list_directory', 'search_files', 'grep', 'semantic_search', 'get_tool_schema', 'web_search', 'fetch_url']);
  function isReadOnly(name) { return readTools.has(name); }
  const coordinators = new Set(['spawn_sub_agent', 'spawn_swarm', 'deep_research', 'ask_user', 'think']);
  let readers = 0, writer = false;
  const waiting = [];
  function drainLocks() {
    if (writer || !waiting.length) return;
    if (!waiting[0].read) {
      if (readers) return;
      writer = true;
      waiting.shift().resolve(() => { writer = false; drainLocks(); });
    } else {
      while (waiting.length && waiting[0].read && !writer) {
        readers++;
        waiting.shift().resolve(() => { readers--; drainLocks(); });
      }
    }
  }
  async function withToolLock(name, execute) {
    // Coordinators can recursively invoke tools; acquiring a write lease would deadlock.
    if (coordinators.has(name)) return execute();
    const release = await new Promise(resolve => { waiting.push({ read: isReadOnly(name), resolve }); drainLocks(); });
    try { return await execute(); } finally { release(); }
  }

  // Read groups may overlap; every other call is a barrier, including approvals.
  async function runToolBatch(calls, execute) {
    const results = [];
    for (let i = 0; i < calls.length;) {
      if (!isReadOnly(calls[i].function.name)) {
        results.push(await execute(calls[i], i++));
      } else {
        const start = i;
        while (i < calls.length && isReadOnly(calls[i].function.name)) i++;
        const settled = await Promise.allSettled(calls.slice(start, i).map((call, j) => execute(call, start + j)));
        const failure = settled.find(r => r.status === 'rejected');
        if (failure) throw failure.reason; // all reads have finished before releasing the barrier
        results.push(...settled.map(r => r.value));
      }
    }
    return results;
  }

  function validateSchema(value, schema = {}, path = 'arguments') {
    if (schema.anyOf && !schema.anyOf.some(s => !validateSchema(value, s, path))) return path + ' does not match any allowed schema';
    if (schema.oneOf && schema.oneOf.filter(s => !validateSchema(value, s, path)).length !== 1) return path + ' must match exactly one schema';
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const allowed = schema.type ? [].concat(schema.type) : [];
    if (allowed.length && !allowed.some(t => t === type || (t === 'integer' && type === 'number' && Number.isInteger(value)))) return path + ' must be ' + allowed.join(' or ');
    if (schema.enum && !schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) return path + ' has an unsupported value';
    if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return path + ' has an unsupported value';
    if (type === 'number') {
      if (!Number.isFinite(value)) return path + ' must be finite';
      if (schema.minimum !== undefined && value < schema.minimum) return path + ' is below minimum';
      if (schema.maximum !== undefined && value > schema.maximum) return path + ' is above maximum';
    }
    if (type === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) return path + ' is too short';
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return path + ' is too long';
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return path + ' does not match the required pattern';
    }
    if (type === 'array') {
      if (schema.minItems !== undefined && value.length < schema.minItems) return path + ' has too few items';
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return path + ' has too many items';
      for (let i = 0; schema.items && i < value.length; i++) { const err = validateSchema(value[i], schema.items, path + '[' + i + ']'); if (err) return err; }
    }
    if (type === 'object') {
      for (const key of schema.required || []) if (!Object.hasOwn(value, key)) return path + '.' + key + ' is required';
      for (const [key, item] of Object.entries(value)) {
        const child = schema.properties?.[key];
        if (!child && schema.additionalProperties === false) return path + '.' + key + ' is not allowed';
        const rule = child || (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : null);
        if (rule) { const err = validateSchema(item, rule, path + '.' + key); if (err) return err; }
      }
    }
    return null;
  }

  function normalizeResult(result) {
    if (!result || typeof result !== 'object') return { status: 'error', output: 'Error: tool returned an invalid result', error: 'invalid_result', retryable: false };
    const output = String(result.output ?? '');
    // Legacy handlers remain supported while structured handlers provide explicit status.
    const failed = result.status ? result.status !== 'ok' : result.isError || result.error || (result.exitCode != null && result.exitCode !== 0) || /^(?:ERROR\b|Error:|\[(?:Error|.* Error)\])/im.test(output);
    return { ...result, output, status: result.status || (failed ? 'error' : 'ok'),
      error: result.error || (failed ? 'tool_failed' : null), retryable: result.retryable ?? false };
  }

  function captureTaskState(state) {
    const previous = state.taskState || {};
    const directives = [...(previous.directives || [])];
    for (const m of state.messages || []) {
      if (m._harnessContext || m.role !== 'user' || typeof m.content !== 'string' || /^\[(?:SYSTEM|ORIGINAL TASK|Previous conversation|HARNESS TASK STATE)/i.test(m.content) || /^A detailed progress file was saved/.test(m.content)) continue;
      if (!directives.includes(m.content)) directives.push(m.content);
    }
    return { objective: state.originalTask || previous.objective || '', directives,
      plan: state.currentPlan || null, checklist: state.planItems || [], invariants: state.invariants || [],
      beliefs: state.beliefs || [], pendingSteering: (state.pendingSteerMessages || []).map(m => m.text) };
  }

  function compactMessages(task, summary, progressFile) {
    if (typeof summary !== 'string' || !summary.trim()) throw new Error('Memory agent returned an empty summary');
    const messages = [{ role: 'user', content: '[HARNESS TASK STATE — preserve these user instructions]\n' + JSON.stringify(task) },
      { role: 'user', content: '[Previous conversation summary]\n' + summary }];
    if (progressFile) messages.push({ role: 'user', content: 'A detailed progress file was saved to `' + progressFile + '`. Read it for additional evidence, then continue the task.' });
    return messages;
  }

  async function compactTransaction(messages, task, summarize, progressFile) {
    // The caller commits only after a nonempty, successful summary.
    const summary = await summarize();
    return compactMessages(task, summary, progressFile);
  }

  function connectionErrorHint(error, backend) {
    const message = String(error?.message || 'Connection failed');
    if (backend === 'lmstudio' && (error?.name === 'TypeError' || /failed to fetch|networkerror/i.test(message))) {
      return 'Cannot access LM Studio from the browser. Check that its server is running and Enable CORS is on in LM Studio server settings. The companion session token only authenticates the companion.';
    }
    return message;
  }

  const api = { isReadOnly, runToolBatch, withToolLock, validateSchema, normalizeResult, captureTaskState, compactMessages, compactTransaction, connectionErrorHint };
  root.HarnessRuntime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
