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
      const kind = w.kind || 'worker';
      if (!['worker', 'critic'].includes(kind)) throw new Error('Worker ' + name + ': kind must be worker or critic');
      if (kind === 'critic' && !w.reviews) throw new Error('Critic ' + name + ' must name the worker it reviews in "reviews"');
      const onFailure = w.on_failure || 'block';
      if (!['block', 'abort', 'continue'].includes(onFailure)) throw new Error('Worker ' + name + ': on_failure must be block, abort or continue');
      const tokenBudget = Number(w.token_budget) > 0 ? Math.max(256, Math.min(500000, Math.floor(Number(w.token_budget)))) : 0;
      const clamp = (v, lo, hi, d) => Number.isFinite(+v) && v !== '' && v != null ? Math.max(lo, Math.min(hi, Math.floor(+v))) : d;
      return { ...w, name, index: i, kind, reviews: kind === 'critic' ? String(w.reviews).trim() : '',
        max_revisions: clamp(w.max_revisions, 0, 2, 1), check_command: typeof w.check_command === 'string' ? w.check_command.trim() : '', check_retries: clamp(w.check_retries, 0, 3, 2), model: typeof w.model === 'string' ? w.model.trim() : '', tokenBudget, owns: Array.isArray(w.owns) ? w.owns.map(String) : [], on_failure: onFailure,
        retries: Math.max(0, Math.min(2, Number.isFinite(+w.retries) ? +w.retries : 1)),
        // Legacy behaviour: without explicit dependencies, workers run in listed order.
        depends_on: explicit ? (w.depends_on || []).map(String) : (i ? [String(defs[i - 1].name).trim()] : []) };
    });
    const byKind = new Map(workers.map(w => [w.name, w]));
    for (const w of workers) if (w.kind === 'critic') {
      const target = byKind.get(w.reviews);
      if (!target) throw new Error('Critic ' + w.name + ' reviews unknown worker: ' + w.reviews);
      if (target.name === w.name) throw new Error('Critic ' + w.name + ' cannot review itself');
      if (target.kind === 'critic') throw new Error('Critic ' + w.name + ' cannot review another critic');
      if (!w.depends_on.includes(target.name)) w.depends_on.push(target.name); // a critic always runs after its author
    }
    // Verify before accepting progress: anything built on a reviewed author's output waits for the critic's verdict,
    // so a revision can never leave already-finished dependents holding stale results.
    const reaches = (from, target, seen = new Set()) => from.depends_on.some(n => n === target || (!seen.has(n) && seen.add(n) && reaches(byKind.get(n), target, seen)));
    for (const critic of workers.filter(x => x.kind === 'critic')) {
      for (const x of workers) {
        if (x === critic || x.kind === 'critic' || !x.depends_on.includes(critic.reviews) || x.depends_on.includes(critic.name)) continue;
        if (!reaches(critic, x.name)) x.depends_on.push(critic.name); // skip if the critic already depends on x (would be a cycle)
      }
    }
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
        if ((options.signal?.aborted || options.shouldStop?.()) && !aborted) { aborted = true; workers.forEach(w => { if (st[w.name] === 'pending') st[w.name] = 'skipped'; }); }
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
    // Entries are hypotheses until a worker supplies evidence for them; verified facts must carry provenance.
    write(key, value, writer, { status = 'hypothesis', evidence = '' } = {}) {
      key = String(key || '').trim();
      if (!key || key.length > 80) throw new Error('Key must be 1-80 characters');
      value = String(value ?? '');
      if (value.length > MAX_MEMORY_VALUE) throw new Error('Value is ' + value.length + ' chars (max ' + MAX_MEMORY_VALUE + '). Write the detail to a file and store its path here.');
      if (!['hypothesis', 'verified'].includes(status)) throw new Error('status must be "hypothesis" or "verified"');
      evidence = String(evidence || '').trim().slice(0, 300);
      if (status === 'verified' && !evidence) throw new Error('A verified fact needs evidence (a file path and line, a command and its result, or a source). Otherwise store it as a hypothesis.');
      this._store.set(key, { value, writer, ts: Date.now(), status, evidence });
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
          (long ? ' [TRUNCATED - call swarm_memory_read("' + k + '") for the full value]' : '') + ' [' + (v.status === 'verified' ? 'VERIFIED: ' + v.evidence : 'hypothesis - confirm before relying on it') + '] [written by ' + v.writer + ']';
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

  // Critics end with a single "VERDICT: APPROVE" or "VERDICT: REVISE" line; everything before it is the evidence.
  function parseVerdict(text) {
    const str = String(text || '');
    const matches = [...str.matchAll(/^[\s*_>#-]*VERDICT\s*:\s*\**\s*(APPROVE|REVISE)\b.*$/gim)];
    if (!matches.length) return { verdict: 'unknown', issues: str.trim().slice(-1500) };
    const last = matches[matches.length - 1];
    return { verdict: last[1].toLowerCase() === 'approve' ? 'approve' : 'revise', issues: str.slice(0, last.index).trim().slice(-1500) };
  }

  /* A round budget that behaves like a sensible human timebox instead of a hard cutoff:
     - the requested rounds are a SOFT budget; while the agent keeps finding new things it is extended (twice, capped),
     - a warning precedes the end so the agent can converge,
     - an agent that repeats itself or only gets errors is stopped early ("stalled"),
     - callers always run a tool-free wrap-up afterwards so work is never discarded. */
  function createRoundBudget({ limit = 10, hardCap = 40, maxExtensions = 2, stallLimit = 4 } = {}) {
    const base = Math.max(2, Math.floor(limit) || 10);
    let cur = Math.min(base, hardCap), extensions = 0, stallRun = 0, warnedAt = -1;
    const seen = new Set();
    return {
      get limit() { return cur; },
      get extensions() { return extensions; },
      get stalled() { return stallRun >= stallLimit; },
      // signatures: "tool:args" for each call in the round; anyOk: whether at least one call succeeded.
      record(signatures, anyOk) {
        const fresh = signatures.some(s => !seen.has(s));
        signatures.forEach(s => seen.add(s));
        stallRun = fresh && anyOk ? 0 : stallRun + 1;
      },
      grant(n) { cur = Math.min(hardCap, cur + n); },
      // doneRounds = rounds already completed. Returns continue | warn | extended | limit | stalled.
      decide(doneRounds) {
        if (stallRun >= stallLimit) return 'stalled';
        if (doneRounds >= cur) {
          if (stallRun === 0 && extensions < maxExtensions && cur < hardCap) { cur = Math.min(hardCap, cur + Math.ceil(base / 2)); extensions++; return 'extended'; }
          return 'limit';
        }
        if (doneRounds === cur - 1 && cur > 2 && warnedAt !== cur) { warnedAt = cur; return 'warn'; }
        return 'continue';
      }
    };
  }


  /* ── Task contract: what "done" means, fixed before any worker starts ── */
  function normalizeContract(input) {
    const c = input || {};
    const raw = Array.isArray(c.acceptance_criteria) ? c.acceptance_criteria : [];
    if (raw.length > 12) throw new Error('A contract supports at most 12 acceptance criteria');
    const criteria = raw.map((x, i) => {
      const o = typeof x === 'string' ? { text: x } : (x || {});
      const text = String(o.text || '').trim();
      if (!text) throw new Error('Acceptance criterion ' + (i + 1) + ' is empty');
      return { id: 'AC' + (i + 1), text: text.slice(0, 400), owner: o.owner ? String(o.owner).trim() : '' };
    });
    const num = (v, lo, hi) => Number.isFinite(+v) && +v > 0 ? Math.max(lo, Math.min(hi, +v)) : 0;
    const token_budget = Math.floor(num(c.token_budget, 1000, 5e6));
    const deadline_minutes = num(c.deadline_minutes, 1, 480);
    const rr = c.repair_rounds;
    const repair_rounds = rr === undefined || rr === null || rr === '' || !Number.isFinite(+rr) ? 1 : Math.max(0, Math.min(2, Math.floor(+rr)));
    return { criteria, token_budget, deadline_minutes, repair_rounds,
      reserve: token_budget || deadline_minutes ? 0.2 : 0, // kept back for integration and verification
      verifier_model: typeof c.verifier_model === 'string' ? c.verifier_model.trim() : '' };
  }
  function checkContractOwners(contract, workers) {
    for (const crit of contract.criteria) if (crit.owner) {
      const o = workers.find(w => w.name === crit.owner);
      if (!o) throw new Error('Criterion ' + crit.id + ' names unknown owner: ' + crit.owner);
      if (o.kind === 'critic') throw new Error('Criterion ' + crit.id + ' owner cannot be a critic');
    }
  }
  // Even split of the working pool (total minus the verification reserve), respecting explicit per-worker budgets.
  function allocateBudgets(workers, contract) {
    if (!contract.token_budget) return {};
    const pool = Math.floor(contract.token_budget * (1 - contract.reserve));
    const explicit = workers.filter(w => w.tokenBudget > 0), open = workers.filter(w => !(w.tokenBudget > 0));
    const left = Math.max(0, pool - explicit.reduce((n, w) => n + w.tokenBudget, 0));
    const share = open.length ? Math.max(256, Math.floor(left / open.length)) : 0;
    return Object.fromEntries(open.map(w => [w.name, share]));
  }
  // Verifier output: one line per criterion, "AC1: PASS - evidence" / "AC2: FAIL - evidence (owner: dev)" / UNVERIFIABLE.
  function parseCriteriaVerdicts(text, criteria) {
    const str = String(text || '');
    const out = criteria.map(crit => {
      const re = new RegExp('^[\\s>*_#-]*\\**' + crit.id + '\\b\\**\\s*[:\\-\u2013\u2014]\\s*\\**\\s*(PASS|FAIL|UNVERIFIABLE)\\b\\**(.*)$', 'gim');
      const all = [...str.matchAll(re)], m = all[all.length - 1];
      if (!m) return { id: crit.id, text: crit.text, status: 'missing', evidence: 'The verifier gave no verdict for this criterion.', owner: crit.owner || '' };
      const evidence = m[2].replace(/^[\s\-\u2013\u2014:*]+/, '').trim();
      const parsedOwner = /owner\s*[:=]\s*([\w.-]+)/i.exec(m[2]);
      return { id: crit.id, text: crit.text, status: m[1].toLowerCase(), evidence: evidence.slice(0, 500), owner: crit.owner || (parsedOwner ? parsedOwner[1] : '') };
    });
    return { criteria: out, allPass: out.length > 0 && out.every(x => x.status === 'pass') };
  }

  /* ── Append-only event log: the audit trail and the raw material for metrics ── */
  function createEventLog(startMs = Date.now(), cap = 2000) {
    const events = [];
    return {
      emit(type, data = {}) { if (events.length < cap) events.push({ seq: events.length + 1, t: Date.now() - startMs, type, ...data }); },
      list() { return events.slice(); },
      count(type) { return events.filter(e => e.type === type).length; },
      toJSON() { return events.slice(-500); }
    };
  }

  /* ── Metrics: verified success, cost per accepted result, latency, repair frequency ── */
  function runMetrics({ outcome, durationMs, tokens, statuses, attempts, results, repairs, acceptance, config }) {
    const vals = Object.values(statuses || {});
    const revisions = Object.values(results || {}).reduce((n, r) => n + (r?.revisions || 0), 0);
    const retries = Object.values(attempts || {}).reduce((n, a) => n + Math.max(0, (a || 1) - 1), 0);
    return { outcome, verified: outcome === 'verified', durationMs: Math.round(durationMs || 0), tokens: tokens || 0,
      workers: vals.length, failedWorkers: vals.filter(s => ['error', 'incomplete', 'blocked'].includes(s)).length,
      revisions, retries, repairs: repairs || 0,
      criteriaPassed: acceptance ? acceptance.criteria.filter(x => x.status === 'pass').length : 0, criteriaTotal: acceptance ? acceptance.criteria.length : 0,
      config: config || {} };
  }
  function summarizeRuns(runs, groupBy) {
    const agg = list => {
      const n = list.length, verified = list.filter(r => r.verified).length;
      return { runs: n, verifiedRate: n ? +(verified / n).toFixed(3) : 0,
        tokensPerVerified: verified ? Math.round(list.reduce((s, r) => s + r.tokens, 0) / verified) : null, // total spend, including failed runs
        meanLatencyMs: n ? Math.round(list.reduce((s, r) => s + r.durationMs, 0) / n) : 0,
        repairFrequency: n ? +(list.filter(r => r.repairs + r.revisions > 0).length / n).toFixed(3) : 0,
        failedWorkerRate: n ? +(list.reduce((s, r) => s + r.failedWorkers, 0) / Math.max(1, list.reduce((s, r) => s + r.workers, 0))).toFixed(3) : 0 };
    };
    const out = { overall: agg(runs || []) };
    if (groupBy) { out.groups = {}; for (const r of runs || []) (out.groups[String(r.config?.[groupBy])] ||= []).push(r); for (const k of Object.keys(out.groups)) out.groups[k] = agg(out.groups[k]); }
    return out;
  }

  /* ── Adaptive team size: advise against structure that tends to lose to a single agent ── */
  function teamAdvice(workers, { hasVerification = false } = {}) {
    const core = workers.filter(w => w.kind !== 'critic'), byName = new Map(core.map(w => [w.name, w])), depth = new Map();
    const get = w => { if (!depth.has(w.name)) depth.set(w.name, 1 + Math.max(0, ...w.depends_on.filter(n => byName.has(n)).map(n => get(byName.get(n))))); return depth.get(w.name); };
    const longest = core.length ? Math.max(...core.map(get)) : 0, advice = [];
    if (core.length >= 2 && longest === core.length) advice.push('Every worker waits on the previous one, so nothing runs in parallel. Sequential work often does as well with a single agent (use check_command and a critic for quality) without the coordination overhead.');
    if (workers.length > 6) advice.push('Large team (' + workers.length + ' workers): fewer, larger tasks usually coordinate better than many small ones.');
    if (!hasVerification) advice.push('No independent verification is configured (critic, check_command, verify_command or acceptance criteria), so "done" is only what the workers claim.');
    return advice;
  }

  function swarmOutcome(statuses, verification) {
    const vals = Object.values(statuses);
    if (vals.some(s => s === 'error' || s === 'incomplete' || s === 'blocked')) return 'blocked';
    if (vals.some(s => s === 'skipped')) return 'needs_review';
    return verification ? (verification.verified ? 'verified' : 'needs_review') : 'needs_review';
  }

  const api = { WRITE_TOOLS, globToRegExp, pathAllowed, ownsOverlap, normalizeWorkers, concurrencyConflicts, runSchedule, workerStatusFromLoop, SwarmMemory, swarmOutcome, trimToolOutputs, parseVerdict, createRoundBudget,
    normalizeContract, checkContractOwners, allocateBudgets, parseCriteriaVerdicts, createEventLog, runMetrics, summarizeRuns, teamAdvice };
  root.SwarmCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
