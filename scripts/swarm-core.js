/* Pure swarm primitives: worker graph, scheduling, ownership, shared memory. Embedded into the HTML by build. */
(function (root) {
  'use strict';
  const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'write_file_chunked', 'delete_file', 'move_file']);
  const MAX_MEMORY_VALUE = 2000, CONTEXT_PREVIEW = 500;

  function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; } else re += '[^/]*'; }
      else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
  }
  function normPath(p) { return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/'); }
  function pathAllowed(path, owns) {
    if (!owns || !owns.length) return true;
    const p = normPath(path);
    return owns.some(g => globToRegExp(normPath(g)).test(p));
  }
  function staticPrefix(glob) { const g = normPath(glob), i = g.search(/[*?]/); return i < 0 ? g : g.slice(0, i); }
  // Conservative: two ownership sets may overlap unless their static prefixes diverge.
  function ownsOverlap(a, b) {
    if (!a?.length || !b?.length) return true;
    return a.some(x => b.some(y => { const px = staticPrefix(x), py = staticPrefix(y); return px.startsWith(py) || py.startsWith(px); }));
  }

  function normalizeWorkers(defs) {
    if (!Array.isArray(defs) || !defs.length) throw new Error('workers must be a non-empty array');
    if (defs.length > 12) throw new Error('A swarm supports at most 12 workers');
    const names = new Set();
    const explicit = defs.some(w => Array.isArray(w.depends_on));
    const workers = defs.map((w, i) => {
      const name = String(w.name || '').trim();
      if (!name) throw new Error('Worker ' + (i + 1) + ' needs a name');
      if (names.has(name)) throw new Error('Duplicate worker name: ' + name);
      names.add(name);
      if (!w.role || !w.task) throw new Error('Worker ' + name + ' needs role and task');
      const onFailure = w.on_failure || 'block';
      if (!['block', 'abort', 'continue'].includes(onFailure)) throw new Error('Worker ' + name + ': on_failure must be block, abort or continue');
      const tokenBudget = Number(w.token_budget) > 0 ? Math.max(256, Math.min(500000, Math.floor(Number(w.token_budget)))) : 0;
      return { ...w, name, index: i, model: typeof w.model === 'string' ? w.model.trim() : '', tokenBudget, owns: Array.isArray(w.owns) ? w.owns.map(String) : [], on_failure: onFailure,
        retries: Math.max(0, Math.min(2, Number.isFinite(+w.retries) ? +w.retries : 1)),
        // Legacy behaviour: without explicit dependencies, workers run in listed order.
        depends_on: explicit ? (w.depends_on || []).map(String) : (i ? [String(defs[i - 1].name).trim()] : []) };
    });
    for (const w of workers) for (const d of w.depends_on) {
      if (!names.has(d)) throw new Error('Worker ' + w.name + ' depends on unknown worker: ' + d);
      if (d === w.name) throw new Error('Worker ' + w.name + ' cannot depend on itself');
    }
    const state = new Map();
    const byName = new Map(workers.map(w => [w.name, w]));
    const visit = (w, trail) => {
      if (state.get(w.name) === 2) return;
      if (state.get(w.name) === 1) throw new Error('Dependency cycle: ' + [...trail, w.name].join(' -> '));
      state.set(w.name, 1);
      w.depends_on.forEach(d => visit(byName.get(d), [...trail, w.name]));
      state.set(w.name, 2);
    };
    workers.forEach(w => visit(w, []));
    return workers;
  }

  // Writers that may run at the same time must declare disjoint ownership.
  function concurrencyConflicts(workers, writeCapable) {
    const conflicts = [];
    const closure = new Map();
    const deps = w => { if (!closure.has(w.name)) { const s = new Set(); w.depends_on.forEach(d => { s.add(d); deps(workers.find(x => x.name === d)).forEach(x => s.add(x)); }); closure.set(w.name, s); } return closure.get(w.name); };
    for (let i = 0; i < workers.length; i++) for (let j = i + 1; j < workers.length; j++) {
      const a = workers[i], b = workers[j];
      if (deps(a).has(b.name) || deps(b).has(a.name)) continue; // ordered, never concurrent
      if (writeCapable(a) && writeCapable(b) && ownsOverlap(a.owns, b.owns)) conflicts.push([a.name, b.name]);
    }
    return conflicts;
  }

  /* statuses: pending running done incomplete error blocked skipped */
  const satisfied = (w, st) => st[w.name] === 'done' || (w.on_failure === 'continue' && ['incomplete', 'error'].includes(st[w.name]));
  async function runSchedule(workers, run, options = {}) {
    const concurrency = Math.max(1, Math.min(8, options.concurrency || 1));
    const st = Object.fromEntries(workers.map(w => [w.name, options.initial?.[w.name] || 'pending']));
    const results = {}, attempts = {};
    let aborted = false, running = 0;
    const settle = () => {
      for (const w of workers) if (st[w.name] === 'pending') {
        const failed = w.depends_on.some(d => ['incomplete', 'error', 'blocked', 'skipped'].includes(st[d]) && !satisfied(workers.find(x => x.name === d), st));
        if (failed) st[w.name] = 'blocked';
      }
    };
    await new Promise(resolve => {
      const pump = () => {
        settle();
        if (options.signal?.aborted && !aborted) { aborted = true; workers.forEach(w => { if (st[w.name] === 'pending') st[w.name] = 'skipped'; }); }
        const ready = workers.filter(w => st[w.name] === 'pending' && w.depends_on.every(d => satisfied(workers.find(x => x.name === d), st)));
        for (const w of ready) {
          if (running >= concurrency) break;
          st[w.name] = 'running'; running++; attempts[w.name] = (attempts[w.name] || 0) + 1;
          options.onStatus?.(w, 'running', st);
          Promise.resolve().then(() => run(w, attempts[w.name], results)).catch(e => ({ status: 'error', error: e.message })).then(res => {
            running--; results[w.name] = res;
            const ok = res.status === 'done';
            if (!ok && !options.signal?.aborted && attempts[w.name] <= w.retries && res.retryable !== false) st[w.name] = 'pending';
            else st[w.name] = ok ? 'done' : (options.signal?.aborted ? 'skipped' : res.status === 'incomplete' ? 'incomplete' : 'error');
            if (!ok && st[w.name] !== 'pending' && w.on_failure === 'abort') workers.forEach(x => { if (st[x.name] === 'pending') st[x.name] = 'skipped'; });
            options.onStatus?.(w, st[w.name], st);
            pump();
          });
        }
        if (!running && !workers.some(w => st[w.name] === 'pending' && w.depends_on.every(d => satisfied(workers.find(x => x.name === d), st)))) { settle(); resolve(); }
      };
      pump();
    });
    return { statuses: st, results, attempts, aborted };
  }

  function workerStatusFromLoop({ aborted, apiError, finishedNaturally, summary }) {
    if (aborted) return 'skipped';
    if (apiError) return 'error';
    if (!finishedNaturally) return 'incomplete';
    return summary && String(summary).trim() ? 'done' : 'incomplete';
  }

  class SwarmMemory {
    constructor(workerNames = []) { this._store = new Map(); this._bus = []; this._names = new Set(workerNames); }
    write(key, value, writer) {
      key = String(key || '').trim();
      if (!key || key.length > 80) throw new Error('Key must be 1-80 characters');
      value = String(value ?? '');
      if (value.length > MAX_MEMORY_VALUE) throw new Error('Value is ' + value.length + ' chars (max ' + MAX_MEMORY_VALUE + '). Write the detail to a file and store its path here.');
      this._store.set(key, { value, writer, ts: Date.now() });
    }
    read(key) { const e = this._store.get(key); return e ? e.value : undefined; }
    keys() { return [...this._store.keys()]; }
    readAll() { return Object.fromEntries([...this._store].map(([k, v]) => [k, v.value])); }
    entries() { return [...this._store].map(([key, v]) => ({ key, ...v })); }
    size() { return this._store.size; }
    postMessage(from, to, content) {
      if (to !== '*' && !this._names.has(to)) throw new Error('Unknown recipient "' + to + '". Workers: ' + [...this._names].join(', '));
      this._bus.push({ from, to, content: String(content).slice(0, 500), ts: Date.now() });
    }
    // Returns messages for a worker after a cursor so inboxes can be polled mid-run.
    inbox(name, since = 0) {
      const messages = this._bus.slice(since).filter(m => (m.to === name || m.to === '*') && m.from !== name);
      return { messages, next: this._bus.length };
    }
    getMessages(name) { return this.inbox(name, 0).messages; }
    get bus() { return this._bus; }
    toContextString() {
      if (!this._store.size) return '(empty - no data written yet)';
      return [...this._store].map(([k, v]) => {
        const long = v.value.length > CONTEXT_PREVIEW;
        return '  ' + k + ': ' + JSON.stringify(long ? v.value.slice(0, CONTEXT_PREVIEW) : v.value) +
          (long ? ' [TRUNCATED - call swarm_memory_read("' + k + '") for the full value]' : '') + ' [written by ' + v.writer + ']';
      }).join('\n');
    }
    toJSON() { return { store: [...this._store], bus: this._bus }; }
    static fromJSON(data, names) { const m = new SwarmMemory(names); m._store = new Map(data?.store || []); m._bus = data?.bus || []; return m; }
  }

  // Observation masking: shrink the OLDEST large tool outputs in place until the conversation fits.
  // The model keeps its own reasoning and the shape of every call, and can re-read anything it still needs.
  function trimToolOutputs(messages, { budgetTokens, reserveTokens = 0, keepRecent = 6, maxChars = 300, estimate = t => Math.ceil(t.length / 4) } = {}) {
    const size = m => estimate(String(m.content || '')) + (m.tool_calls ? estimate(JSON.stringify(m.tool_calls)) : 0) + 4;
    let total = reserveTokens + messages.reduce((n, m) => n + size(m), 0);
    const initial = total; let trimmed = 0;
    if (!budgetTokens) return { trimmed, tokens: total, over: false, saved: 0 };
    for (let keep = keepRecent; keep >= 2 && total > budgetTokens; keep = keep > 2 ? Math.max(2, keep - 2) : 1) {
      const toolIdx = messages.map((m, i) => m.role === 'tool' ? i : -1).filter(i => i >= 0);
      for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keep))) {
        if (total <= budgetTokens) break;
        const m = messages[i], text = String(m.content || '');
        if (text.length <= maxChars || m._trimmed) continue;
        const before = size(m);
        m.content = text.slice(0, maxChars) + '\n[…' + (text.length - maxChars) + ' chars trimmed to save context; call the tool again if you still need this]';
        m._trimmed = true; trimmed++; total -= before - size(m);
      }
    }
    return { trimmed, tokens: total, over: total > budgetTokens, saved: initial - total };
  }

  function swarmOutcome(statuses, verification) {
    const vals = Object.values(statuses);
    if (vals.some(s => s === 'error' || s === 'incomplete' || s === 'blocked')) return 'blocked';
    if (vals.some(s => s === 'skipped')) return 'needs_review';
    return verification ? (verification.verified ? 'verified' : 'needs_review') : 'needs_review';
  }

  const api = { WRITE_TOOLS, globToRegExp, pathAllowed, ownsOverlap, normalizeWorkers, concurrencyConflicts, runSchedule, workerStatusFromLoop, SwarmMemory, swarmOutcome, trimToolOutputs };
  root.SwarmCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
