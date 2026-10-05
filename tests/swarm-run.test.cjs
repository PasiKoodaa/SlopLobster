'use strict';
// Drives the real runSwarm (extracted from the built HTML) against stubbed model, tools, DOM and storage.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../SlopLobster.html'), 'utf8').replace(/\r\n/g, '\n');
const a = html.indexOf('MULTI-AGENT SWARM'), start = html.lastIndexOf('/* ═', a), end = html.indexOf('/** Render a completed swarm data object');
assert.ok(a > 0 && end > a, 'swarm block markers not found');
const block = html.slice(start, end);

function harness(opts = {}) {
  const el = () => new Proxy(function () {}, { get: (t, k) => k === 'querySelectorAll' ? () => [] : k === 'classList' ? { add() {}, remove() {} } : k === 'style' ? {} : ['appendChild', 'addEventListener'].includes(k) ? () => {} : k === 'querySelector' ? () => null : undefined, set: () => true });
  const sse = chunks => new Response(new ReadableStream({ start(c) { for (const o of chunks) c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(o) + '\n\n')); c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close(); } }));
  const env = { db: new Map(), tools: [], models: [], req: [], tasks: new Map(), seen: [], conflictOn: opts.conflictOn || null, n: 0 };
  Object.defineProperty(env, 'saved', { get: () => env.db.get('swarm:c1') ?? null });
  const ctx = { console, setTimeout, AbortController, TextDecoder, TextEncoder, Response, ReadableStream, performance, DOMException,
    SwarmCore: require('../src/swarm-core.js'), HarnessRuntime: require('../src/harness-runtime.js'),
    document: { getElementById: () => null, createElement: () => el() }, $msg: () => el(), scrollBottom() {}, esc: s => String(s ?? ''), renderMd: String, hljs: { highlightElement() {} }, addCopyBtns() {},
    state: { modelInfoMap: new Map(opts.ctx ? [['main', { loadedContextLength: opts.ctx }]] : []), apiUrl: 'http://x', model: 'main', maxTokens: 4000, tokenBudget: 0, activeConvId: 'c1', dirName: 'p', dirHandle: 'REAL', fileCache: new Map([['real', 1]]), requireEditApproval: true, compConnected: opts.noCompanion ? false : true, compInfo: {}, projectMemoryText: '', invariants: [] },
    harnessFeatureState: { prefs: { projectRoot: opts.noRoot ? '' : '/repo' }, currentTask: null },
    featureTask() { return ctx.harnessFeatureState.currentTask; },
    ManagedDirectoryHandle: class { constructor(p, id) { this._managedTaskId = id; } },
    featureRequest: async (path, body) => {
      env.req.push([path, body]);
      if (path === 'tasks/create') { const id = 't' + (++env.n); const rec = { id, title: body.title, branch: 'slop/' + id, status: 'active' }; env.tasks.set(id, rec); return rec; }
      if (path === 'tasks/list') return { tasks: [...env.tasks.values()].filter(t => t.status === 'active') };
      if (path === 'tasks/absorb') { const src = env.tasks.get(body.fromTaskId); if (env.conflictOn && src.title === 'swarm:' + env.conflictOn && body.taskId === 't1') return { ok: false, status: 'conflict', files: ['shared.txt'] }; return { ok: true }; }
      if (path === 'tasks/diff') return { diff: opts.noChanges ? '' : 'diff --git a/a.txt b/a.txt\n+changed', changedFiles: opts.noChanges ? [] : ['a.txt'], reviewHash: 'h' };
      if (path === 'tasks/discard') { env.tasks.get(body.taskId).status = 'discarded'; return { ok: true }; }
      throw new Error('unexpected ' + path);
    },
    getToolDefs: () => ['read_file', 'edit_file', 'write_file', 'execute_command', 'think', 'run_tests'].map(n => ({ type: 'function', function: { name: n, parameters: {} } })),
    estimateTokens: t => Math.ceil(t.length / 4), _sessionTotalOut: 0, _updateSessionTok() {}, createCompressionStats: () => ({}), compressToolOutput: (n, t) => t, redactSecrets: s => s,
    applySSEDelta(chunk, acc) { const d = chunk.choices?.[0]?.delta; if (!d) return; if (d.content) acc.content += d.content; for (const tc of d.tool_calls || []) acc.toolCalls[tc.index ?? 0] = { id: tc.id || '', type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } }; },
    dbGet: async (_s, key) => env.db.get(key) ?? null, dbSet: async (_s, v) => { env.db.set(v.id, v); return true; }, dbDelete: async (_s, key) => { env.db.delete(key); }, dbGetAll: async () => [...env.db.values()],
    executeTool: async (name, args) => { env.tools.push([name, args]); env.seen.push({ dir: ctx.state.dirHandle?._managedTaskId || ctx.state.dirHandle, approve: ctx.state.requireEditApproval, task: ctx.harnessFeatureState.currentTask?.id, cache: ctx.state.fileCache }); return { status: 'ok', output: 'ok ' + name }; },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body); env.models.push(body.model);
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { content: 'SYNTH' } }] }));
      const who = /You are \*\*(\w+)\*\*/.exec(body.messages[0].content)?.[1] || (/INDEPENDENT VERIFIER/.test(body.messages[0].content) ? 'verifier' : undefined);
      opts.onFetch?.(who, body);
      if (who === 'bad') return new Response('no', { status: 500 });
      env.calls = env.calls || []; env.calls.push({ who, tools: (body.tools || []).map(t => t.function.name), first: body.messages[1]?.content || '', messages: body.messages });
      const said = opts.say?.(who, env.calls.filter(c => c.who === who).length, body);
      const sawTool = body.messages.some(m => m.role === 'tool');
      const call = opts.call?.(who, sawTool);
      if (call && body.tools) return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: call }] } }] }]);
      return sse([{ choices: [{ delta: { content: said ?? ('finished ' + who + (body.tools ? '' : ' STATUS: COMPLETE')) } }] }]);
    } };
  if (opts.clock) ctx.Date = class extends Date { static now() { return opts.clock.t; } };
  vm.createContext(ctx); vm.runInContext(block + '\nglobalThis.__run = runSwarm; globalThis.__trace = buildSwarmTrace; globalThis.__history = swarmHistory;', ctx);
  return { run: ctx.__run, trace: ctx.__trace, history: ctx.__history, env, ctx };
}
const W = (name, e = {}) => ({ name, role: 'r', task: 't', ...e });
const writeMem = who => ({ name: 'swarm_memory_write', arguments: JSON.stringify({ key: who + '_k', value: 'v' }) });

test('graph swarm completes, shares memory and clears its checkpoint', async () => {
  const h = harness({ call: (who, saw) => saw ? null : writeMem(who) });
  const r = await h.run('g', [W('a', { depends_on: [] }), W('b', { depends_on: [] }), W('c', { depends_on: ['a', 'b'] })], 5, undefined, null, { concurrency: 2 });
  assert.equal(r.outcome, 'needs_review'); assert.deepEqual(Object.keys(r.memory).sort(), ['a_k', 'b_k', 'c_k']);
  assert.equal(h.env.saved, null);
});
test('failed worker blocks dependents, retries once, keeps checkpoint for resume', async () => {
  const h = harness();
  const r = await h.run('g2', [W('a'), W('bad'), W('z')], 5, undefined, null, {});
  assert.equal(r.outcome, 'blocked'); assert.deepEqual(r.workerResults.map(x => x.status), ['done', 'error', 'blocked']);
  assert.equal(r.attempts.bad, 2); assert.ok(h.env.saved);
  const r2 = await h.run('g2', [W('a'), W('bad'), W('z')], 5, undefined, null, {});
  assert.equal(r2.attempts.a, undefined, 'completed worker must not re-run on resume');
});
test('ownership blocks out-of-lane writes before the tool runs', async () => {
  const h = harness({ call: (who, saw) => saw ? null : { name: 'write_file', arguments: JSON.stringify({ path: 'ui/x.js', content: 'x' }) } });
  const r = await h.run('g3', [W('api', { owns: ['api/**'], tools: ['write_file'] })], 5, undefined, null, {});
  assert.equal(h.env.tools.length, 0); assert.equal(r.workerResults[0].log[0].success, false);
});
test('round limit yields incomplete, not done; per-worker model and token budget apply', async () => {
  const loop = harness({ call: () => ({ name: 'read_file', arguments: '{"path":"a"}' }) });
  const r = await loop.run('g4', [W('spin', { max_iterations: 2 })], 2, undefined, null, {});
  assert.notEqual(r.workerResults[0].status, 'error');
  const budget = harness({ call: () => ({ name: 'swarm_memory_write', arguments: JSON.stringify({ key: 'k', value: 'v'.repeat(1900) }) }) });
  const r2 = await budget.run('g5', [W('cheap', { model: 'tiny', token_budget: 256 })], 9, undefined, null, {});
  assert.ok(budget.env.models.includes('tiny')); assert.ok(!budget.env.models.slice(0, 1).includes('main'));
  assert.match(r2.workerResults[0].reason || r2.workerResults[0].summary, /./);
});
test('invalid graph is rejected before any model call', async () => {
  const h = harness();
  await assert.rejects(h.run('g6', [W('a', { depends_on: ['b'] }), W('b', { depends_on: ['a'] })], 5, undefined, null, {}), /cycle/i);
  assert.equal(h.env.models.length, 0);
});

test('run trace is complete, serialisable and carries cost data', async () => {
  const h = harness({ call: (who, saw) => saw ? null : { name: 'swarm_memory_write', arguments: JSON.stringify({ key: 'k', value: 'v' }) } });
  const defs = [W('a', { model: 'small', owns: ['src/**'] }), W('b')];
  const r = await h.run('trace', defs, 5, undefined, null, { verifyCommand: '' });
  const t = JSON.parse(JSON.stringify(h.trace(r)));
  assert.equal(t.schema, 'sloplobster.swarm-trace/1'); assert.equal(t.workers.length, 2);
  assert.equal(t.workers[0].model, 'small'); assert.deepEqual(t.workers[0].spec.owns, ['src/**']);
  assert.ok(t.totalOutputTokensEstimate > 0); assert.equal(t.sharedMemory.k, 'v'); assert.equal(t.statuses.b, 'done');
});

const readCall = (who, saw) => saw ? null : { name: 'read_file', arguments: '{"path":"a.txt"}' };
test('isolated swarm: per-worker worktrees, lease swaps and restores the workspace, reviewable result, cleanup', async () => {
  const h = harness({ call: readCall });
  const r = await h.run('iso1', [W('a', { depends_on: [] }), W('b', { depends_on: ['a'] })], 5, undefined, null, { isolate: true });
  const creates = h.env.req.filter(q => q[0] === 'tasks/create').map(q => q[1].title);
  assert.deepEqual(creates, ['Swarm: iso1', 'swarm:a', 'swarm:b']);
  // each worker's tool call ran inside its own worktree, with edit approval off and a private cache
  assert.deepEqual(h.env.seen.map(x => x.task), ['t2', 't3']); assert.ok(h.env.seen.every(x => x.approve === false));
  assert.notEqual(h.env.seen[0].cache, h.env.seen[1].cache);
  // ...and the real workspace is restored afterwards
  assert.equal(h.ctx.state.dirHandle, 'REAL'); assert.equal(h.ctx.state.requireEditApproval, true); assert.equal(h.ctx.state.fileCache.get('real'), 1); assert.equal(h.ctx.harnessFeatureState.currentTask, null);
  // dependent absorbed upstream; both absorbed into integration in order
  const absorbs = h.env.req.filter(q => q[0] === 'tasks/absorb').map(q => q[1].taskId + '<-' + q[1].fromTaskId);
  assert.deepEqual(absorbs, ['t1<-t2', 't3<-t2', 't1<-t3']); // a is merged before its dependent b starts
  assert.equal(r.isolation.branch, 'slop/t1'); assert.deepEqual(r.isolation.changedFiles, ['a.txt']);
  assert.ok(r.notes.some(n => /NOT in your working tree/.test(n)));
  assert.deepEqual([...h.env.tasks.values()].filter(t => t.status === 'active').map(t => t.id), ['t1']); // only the integration branch remains
});
test('isolated swarm: merge conflict marks worker incomplete, blocks dependents, keeps worktrees', async () => {
  const h = harness({ call: readCall, conflictOn: 'b' });
  const r = await h.run('iso2', [W('a', { depends_on: [] }), W('b', { depends_on: ['a'] }), W('c', { depends_on: ['b'] })], 5, undefined, null, { isolate: true });
  assert.deepEqual(r.workerResults.map(x => x.status), ['done', 'incomplete', 'blocked']);
  assert.match(r.workerResults[1].reason, /shared\.txt/); assert.equal(r.outcome, 'blocked');
  assert.equal([...h.env.tasks.values()].filter(t => t.status === 'active').length, 3); // integration + a + b kept; blocked c never started
  assert.ok(r.isolation.keptWorktrees.some(k => k.worker === 'b'));
});
test('isolated swarm without changes discards everything; isolation falls back with a note when unavailable', async () => {
  const h = harness({ call: readCall, noChanges: true });
  const r = await h.run('iso3', [W('a')], 5, undefined, null, { isolate: true });
  assert.equal(r.isolation.integrationTaskId, null); assert.equal([...h.env.tasks.values()].filter(t => t.status === 'active').length, 0);
  for (const opt of [{ noCompanion: true }, { noRoot: true }]) {
    const f = harness({ call: readCall, ...opt });
    const x = await f.run('iso4', [W('a')], 5, undefined, null, { isolate: true });
    assert.equal(x.isolation, null); assert.ok(x.notes.some(n => /Isolation unavailable/.test(n))); assert.equal(f.env.req.length, 0);
    assert.equal(f.env.seen[0].dir, 'REAL');
  }
});
test('resume of an isolated swarm re-runs workers whose worktree vanished', async () => {
  const h = harness({ call: readCall, conflictOn: 'b' });
  await h.run('iso5', [W('a', { depends_on: [] }), W('b', { depends_on: ['a'] })], 5, undefined, null, { isolate: true });
  assert.ok(h.env.saved.isolation); h.env.tasks.get(h.env.saved.isolation.tasks.a).status = 'discarded';
  h.env.conflictOn = null; h.env.seen.length = 0;
  const r = await h.run('iso5', [W('a', { depends_on: [] }), W('b', { depends_on: ['a'] })], 5, undefined, null, { isolate: true });
  assert.deepEqual(r.workerResults.map(x => x.status), ['done', 'done']); assert.equal(h.env.seen.length, 2);
});

test('long worker conversations are trimmed to fit the context', async () => {
  const h = harness({ ctx: 12000, call: () => ({ name: 'read_file', arguments: JSON.stringify({ path: 'f' + Math.random() }) }) });
  h.ctx.executeTool = async () => ({ status: 'ok', output: 'y'.repeat(6000) });
  const r = await h.run('ctx', [W('reader', { max_iterations: 8 })], 8, undefined, null, {});
  const w = r.workerResults[0];
  assert.ok(w.trimmedOutputs > 0, 'old tool output should have been trimmed'); assert.notEqual(w.status, 'error');
});
test('a context window too small to act in ends incomplete instead of claiming success', async () => {
  const h = harness({ ctx: 800, call: () => ({ name: 'read_file', arguments: '{"path":"a"}' }) });
  const r = await h.run('ctx2', [W('tiny')], 5, undefined, null, {});
  assert.equal(r.workerResults[0].status, 'incomplete'); assert.match(r.workerResults[0].reason, /Context window/);
  assert.equal(h.env.tools.length, 0);
});

const dev = (extra = {}) => W('dev', { depends_on: [], ...extra });
const critic = (extra = {}) => W('rev', { kind: 'critic', reviews: 'dev', ...extra });
const verdictSay = (...verdicts) => (who, n) => who === 'rev' ? 'Issue 1: a.js:3 returns undefined (ran the tests, 1 failing).\nVERDICT: ' + verdicts[Math.min(n, verdicts.length) - 1] : undefined;

test('critic approves: author runs once, critic is read-only and approves', async () => {
  const h = harness({ say: verdictSay('APPROVE') });
  const r = await h.run('c1', [dev(), critic()], 5, undefined, null, {});
  assert.deepEqual(r.workerResults.map(x => x.status), ['done', 'done']);
  assert.equal(r.workerResults[1].verdict, 'approve'); assert.equal(h.env.calls.filter(c => c.who === 'dev').length, 1);
  const criticTools = h.env.calls.find(c => c.who === 'rev').tools;
  assert.ok(!criticTools.some(t => ['write_file', 'edit_file', 'execute_command'].includes(t))); assert.ok(criticTools.includes('read_file'));
});
test('critic requests revision: author is sent back with the evidence, then approved', async () => {
  const h = harness({ say: verdictSay('REVISE', 'APPROVE') });
  const r = await h.run('c2', [dev(), critic()], 5, undefined, null, {});
  assert.deepEqual(r.workerResults.map(x => x.status), ['done', 'done']);
  assert.equal(r.workerResults[0].revisions, 1); assert.equal(r.workerResults[1].verdict, 'approve');
  const devRuns = h.env.calls.filter(c => c.who === 'dev');
  assert.equal(devRuns.length, 2); assert.match(devRuns[1].first, /Critic feedback you must address/); assert.match(devRuns[1].first, /a\.js:3/);
  assert.match(devRuns[1].first, /Your previous summary/);
});
test('critic that never approves ends incomplete, blocks dependents, and cannot loop forever', async () => {
  const h = harness({ say: verdictSay('REVISE') });
  const r = await h.run('c3', [dev(), critic({ max_revisions: 1 }), W('ship', { depends_on: ['rev'] })], 5, undefined, null, {});
  assert.deepEqual(r.workerResults.map(x => x.status), ['done', 'incomplete', 'blocked']);
  assert.match(r.workerResults[1].reason, /still requests changes/); assert.equal(h.env.calls.filter(c => c.who === 'dev').length, 2);
  assert.equal(r.outcome, 'blocked');
});
test('critic without a verdict line is not trusted', async () => {
  const h = harness({ say: who => who === 'rev' ? 'seems fine to me' : undefined });
  const r = await h.run('c4', [dev(), critic()], 5, undefined, null, {});
  assert.equal(r.workerResults[1].status, 'incomplete'); assert.match(r.workerResults[1].reason, /VERDICT/);
});
test('isolated critic reviews inside the author worktree with the diff, and revisions are re-merged', async () => {
  const h = harness({ say: verdictSay('REVISE', 'APPROVE'), call: (who, saw) => who === 'dev' && !saw ? { name: 'read_file', arguments: '{"path":"a"}' } : null });
  const r = await h.run('c5', [dev(), critic()], 5, undefined, null, { isolate: true });
  assert.equal(r.outcome, 'needs_review');
  assert.ok(h.env.req.some(q => q[0] === 'tasks/diff' && q[1].taskId === 't2'));
  const criticFirst = h.env.calls.find(c => c.who === 'rev').first;
  assert.match(criticFirst, /Changes to review/); assert.match(criticFirst, /diff --git a\/a\.txt/); assert.match(criticFirst, /author's own summary/);
  const absorbs = h.env.req.filter(q => q[0] === 'tasks/absorb').map(q => q[1].taskId + '<-' + q[1].fromTaskId);
  assert.equal(absorbs.filter(a => a === 't1<-t2').length, 2); // original run and the revision
  assert.equal(h.env.tasks.get('t2').status, 'discarded'); assert.equal(h.ctx.state.dirHandle, 'REAL');
});
test('check_command: failure is fed back and the worker gets extra rounds to fix it', async () => {
  let n = 0;
  const h = harness({ call: (who, saw) => saw ? null : { name: 'read_file', arguments: '{"path":"a"}' } });
  const base = h.ctx.executeTool; h.ctx.executeTool = async (name, args) => name === 'run_tests' ? (++n === 1 ? { status: 'ok', output: 'FAIL: 1 test', exitCode: 1 } : { status: 'ok', output: 'ok', exitCode: 0 }) : base(name, args);
  const r = await h.run('k1', [W('dev', { check_command: 'npm test' })], 5, undefined, null, {});
  const w = r.workerResults[0];
  assert.equal(w.status, 'done'); assert.equal(w.check.passed, true); assert.equal(w.check.attempts, 1);
  const lastCall = h.env.calls.at(-1); assert.ok(lastCall.messages.some(m => m.role === 'user' && /\[CHECK FAILED\]/.test(m.content) && /FAIL: 1 test/.test(m.content)));
});
test('check_command that keeps failing leaves the worker incomplete with the evidence', async () => {
  const h = harness({ call: (who, saw) => saw ? null : { name: 'read_file', arguments: '{"path":"a"}' } });
  const base = h.ctx.executeTool; h.ctx.executeTool = async (name, args) => name === 'run_tests' ? { status: 'ok', output: 'still failing', exitCode: 1 } : base(name, args);
  const r = await h.run('k2', [W('dev', { check_command: 'npm test', check_retries: 1 }), W('next', { depends_on: ['dev'] })], 5, undefined, null, {});
  assert.deepEqual(r.workerResults.map(x => x.status), ['incomplete', 'blocked']);
  assert.match(r.workerResults[0].reason, /Completion check still failing/); assert.equal(r.workerResults[0].check.attempts, 2);
});

test('swarm worker: budget extends while making progress instead of cutting the worker off', async () => {
  let n = 0;
  const h = harness({ call: () => ++n <= 5 ? { name: 'read_file', arguments: JSON.stringify({ path: 'f' + n }) } : null });
  const r = await h.run('ext', [W('reader', { max_iterations: 3 })], 3, undefined, null, {});
  assert.equal(r.workerResults[0].status, 'done'); assert.ok(r.workerResults[0].iterations > 3);
});
test('swarm worker that only repeats itself is stopped early, reports, and is incomplete', async () => {
  const h = harness({ call: () => ({ name: 'read_file', arguments: '{"path":"same"}' }), say: who => 'I kept re-reading same. STATUS: INCOMPLETE - nothing new' });
  const r = await h.run('spin', [W('looper', { max_iterations: 20 })], 20, undefined, null, {});
  const w = r.workerResults[0];
  assert.equal(w.status, 'incomplete'); assert.ok(w.iterations <= 6); assert.match(w.summary, /re-reading same/);
});

// ── Contract, independent verification, targeted repair, budgets, memory status, metrics ──
const verifierSay = (...rounds) => (who, n) => who === 'verifier' ? rounds[Math.min(n, rounds.length) - 1] : undefined;
const PASS = 'AC1: PASS - ran npm test, 12 passed\nAC2: PASS - GET /health returns 200 in src/api.js:9';
const FAIL = 'AC1: PASS - ran npm test, 12 passed\nAC2: FAIL - /health returns 500 in src/api.js:9 (owner: dev)';
const crit2 = { acceptance_criteria: ['tests pass', 'GET /health returns 200'] };

test('contract: an independent verifier confirms every criterion and the swarm is reported verified', async () => {
  const h = harness({ say: verifierSay(PASS) });
  const r = await h.run('v1', [dev()], 5, undefined, null, { contract: crit2 });
  assert.equal(r.outcome, 'verified'); assert.ok(r.acceptance.allPass); assert.deepEqual(r.acceptance.criteria.map(c => c.status), ['pass', 'pass']);
  const v = h.env.calls.find(c => c.who === 'verifier');
  assert.ok(!v.tools.some(t => ['write_file', 'edit_file', 'execute_command'].includes(t)) && v.tools.includes('run_tests'));
  assert.match(v.first, /AC1: tests pass/); assert.match(v.messages[0].content, /did not do the work/);
  assert.doesNotMatch(v.first + v.messages[0].content, /finished dev/, 'the verifier must not see the workers\' own accounts');
  assert.equal(r.metrics.verified, true); assert.equal(r.metrics.criteriaPassed, 2);
});
test('contract: a failing criterion sends only its owner back with the evidence, then re-verifies', async () => {
  const h = harness({ say: verifierSay(FAIL, PASS) });
  const r = await h.run('v2', [dev(), W('docs', { depends_on: [] })], 5, undefined, null, { contract: crit2 });
  assert.equal(r.outcome, 'verified'); assert.equal(r.metrics.repairs, 1);
  const devRuns = h.env.calls.filter(c => c.who === 'dev'), docsRuns = h.env.calls.filter(c => c.who === 'docs');
  assert.equal(devRuns.length, 2); assert.equal(docsRuns.length, 1, 'accepted work is left alone');
  assert.match(devRuns[1].first, /independent verifier checked/); assert.match(devRuns[1].first, /\/health returns 500 in src\/api\.js:9/);
  assert.equal(h.env.calls.filter(c => c.who === 'verifier').length, 2);
  assert.ok(r.events.some(e => e.type === 'repair' && e.worker === 'dev'));
});
test('contract: criteria still failing after the repair rounds leave the swarm unverified, with the evidence', async () => {
  const h = harness({ say: verifierSay(FAIL) });
  const r = await h.run('v3', [dev()], 5, undefined, null, { contract: { ...crit2, repair_rounds: 1 } });
  assert.equal(r.outcome, 'needs_review'); assert.equal(r.acceptance.allPass, false);
  assert.equal(r.acceptance.criteria[1].status, 'fail'); assert.equal(h.env.calls.filter(c => c.who === 'dev').length, 2); // one repair, no more
  assert.equal(r.metrics.verified, false);
});
test('contract: criteria without an owner are not guessed at when several workers could be responsible', async () => {
  const h = harness({ say: verifierSay('AC1: FAIL - broken\nAC2: PASS - fine') });
  const r = await h.run('v4', [dev(), W('other', { depends_on: [] })], 5, undefined, null, { contract: crit2 });
  assert.equal(h.env.calls.filter(c => c.who === 'dev').length, 1); assert.ok(r.notes.some(n => /Could not route failing criteria \(AC1\)/.test(n)));
});
test('contract: a verdict-less verifier is a failure, not a pass', async () => {
  const h = harness({ say: verifierSay('looks good to me') });
  const r = await h.run('v5', [dev()], 5, undefined, null, { contract: { acceptance_criteria: ['x'], repair_rounds: 0 } });
  assert.equal(r.acceptance.criteria[0].status, 'missing'); assert.notEqual(r.outcome, 'verified');
});
test('contract: verify_command and criteria must BOTH pass for "verified"', async () => {
  const h = harness({ say: verifierSay('AC1: PASS - fine') });
  const base = h.ctx.executeTool; h.ctx.executeTool = async (n, a) => n === 'run_tests' ? { status: 'ok', output: 'FAIL', exitCode: 1 } : base(n, a);
  const r = await h.run('v6', [dev()], 5, undefined, null, { verifyCommand: 'npm test', contract: { acceptance_criteria: ['x'] } });
  assert.equal(r.acceptance.allPass, true); assert.equal(r.verification.verified, false); assert.equal(r.outcome, 'needs_review');
});
test('contract: invalid owner is rejected before any model call', async () => {
  const h = harness();
  await assert.rejects(h.run('v7', [dev()], 5, undefined, null, { contract: { acceptance_criteria: [{ text: 'x', owner: 'ghost' }] } }), /unknown owner/);
  assert.equal(h.env.models.length, 0);
});
test('contract: the token budget stops new workers, keeps a reserve, and verification is skipped honestly', async () => {
  const h = harness({ say: who => who === 'a' ? 'x'.repeat(4000) + ' STATUS: COMPLETE' : undefined });
  const r = await h.run('b1', [W('a'), W('b')], 5, undefined, null, { contract: { token_budget: 1000, acceptance_criteria: ['x'] } });
  assert.deepEqual(r.workerResults.map(x => x.status), ['done', 'skipped']);
  assert.match(r.workerResults[1].reason, /deadline or token budget/); assert.equal(h.env.calls.filter(c => c.who === 'verifier').length, 0);
  assert.ok(r.notes.some(n => /Verification was skipped/.test(n))); assert.notEqual(r.outcome, 'verified');
  assert.equal(r.workers[0].tokenBudget, 400); // 800 working pool split across two workers
});
test('contract: the deadline stops new workers while the verifier keeps the reserved time', async () => {
  const clock = { t: 1e12 };
  const h = harness({ clock, onFetch: who => { if (who === 'a') clock.t += 55 * 1000; }, say: verifierSay('AC1: PASS - ok') });
  const r = await h.run('d1', [W('a'), W('b')], 5, undefined, null, { contract: { deadline_minutes: 1, acceptance_criteria: ['x'] } });
  assert.equal(r.workerResults[1].status, 'skipped'); assert.ok(r.events.some(e => e.type === 'worker_finished' && e.worker === 'a'));
  assert.equal(h.env.calls.filter(c => c.who === 'verifier').length, 0); // not everyone finished
});
test('memory: unverified claims stay hypotheses; verified facts need evidence', async () => {
  const bad = harness({ call: (who, saw) => saw ? null : { name: 'swarm_memory_write', arguments: JSON.stringify({ key: 'port', value: '8080', status: 'verified' }) } });
  const r1 = await bad.run('m1', [W('a')], 5, undefined, null, {});
  assert.equal(r1.workerResults[0].log[0].success, false); assert.equal(r1.memory.port, undefined);
  const good = harness({ call: (who, saw) => saw ? null : { name: 'swarm_memory_write', arguments: JSON.stringify({ key: 'port', value: '8080', status: 'verified', evidence: 'src/config.js:4' }) } });
  const r2 = await good.run('m2', [W('a')], 5, undefined, null, {});
  assert.deepEqual(r2.memoryDetail.map(e => [e.key, e.status, e.evidence]), [['port', 'verified', 'src/config.js:4']]);
});
test('a critic gates its author\'s dependents: they never run on unreviewed or stale output', async () => {
  const h = harness({ say: verdictSay('REVISE', 'APPROVE') });
  const r = await h.run('g1', [dev(), critic(), W('ship', { depends_on: ['dev'] })], 5, undefined, null, {});
  assert.deepEqual(r.workerResults.map(x => x.status), ['done', 'done', 'done']);
  const order = r.events.filter(e => e.type === 'worker_started' || e.type === 'revision' || e.type === 'critic_verdict').map(e => e.type + ':' + (e.worker || e.critic));
  assert.ok(order.indexOf('worker_started:ship') > order.lastIndexOf('critic_verdict:rev'), order.join(' '));
});
test('events and metrics are recorded; run history aggregates across runs and persists in storage', async () => {
  const h = harness({ say: verifierSay(PASS) });
  const r = await h.run('h1', [dev()], 5, undefined, null, { contract: crit2 });
  const types = r.events.map(e => e.type); assert.deepEqual(types.slice(0, 3), ['contract', 'worker_started', 'worker_finished']); assert.ok(types.includes('acceptance')); assert.equal(types.at(-1), 'outcome');
  assert.ok(r.events.every((e, i) => e.seq === i + 1));
  const bad = harness({});
  h.env.db.forEach((v, k) => bad.env.db.set(k, v));            // share one store between the two runs
  await bad.run('h2', [W('a'), W('bad')], 5, undefined, null, {});
  const hist = await bad.history(10, 'criteria');
  assert.equal(hist.stats.overall.runs, 2); assert.equal(hist.stats.overall.verifiedRate, 0.5);
  assert.ok(hist.stats.overall.tokensPerVerified > 0); assert.equal(hist.stats.groups.true.verifiedRate, 1); assert.equal(hist.stats.groups.false.verifiedRate, 0);
  assert.equal(hist.recent.length, 2); assert.equal(hist.recent.find(x => x.goal === 'h1').criteria, '2/2');
  assert.equal(JSON.parse(JSON.stringify(h.trace(r))).metrics.verified, true);
});
test('advice about the team shape appears in the notes', async () => {
  const h = harness();
  const r = await h.run('adv', [W('a'), W('b'), W('c')], 5, undefined, null, {});
  assert.ok(r.notes.some(n => /nothing runs in parallel/.test(n))); assert.ok(r.notes.some(n => /No independent verification/.test(n)));
});
