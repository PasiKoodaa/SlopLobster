'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/harness-runtime.js'), S = require('../src/swarm-core.js'), F = require('../src/features-core.js');
const W = (name, extra = {}) => ({ name, role: 'r', task: 't', ...extra });

test('read tool output containing "Error:" is not a failure; shell output is', () => {
  assert.equal(H.normalizeResult({ output: 'Error: in file body' }, 'read_file').status, 'ok');
  assert.equal(H.normalizeResult({ output: 'Error: boom' }, 'execute_command').status, 'error');
  assert.equal(H.normalizeResult({ output: 'x', exitCode: 2 }, 'read_file').status, 'error');
});
test('runToolBatch keeps sibling results when one read rejects, rethrows aborts', async () => {
  const calls = ['read_file', 'grep'].map((n, i) => ({ id: 'c' + i, function: { name: n } }));
  const out = await H.runToolBatch(calls, async (c, i) => { if (i === 0) throw new Error('disk'); return { ok: i }; });
  assert.equal(out[0].status, 'error'); assert.equal(out[1].ok, 1);
  await assert.rejects(H.runToolBatch(calls, async () => { throw new DOMException('x', 'AbortError'); }), { name: 'AbortError' });
});
test('captureTaskState caps and clips directives, keeping the first', () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: 'do ' + i + (i === 5 ? 'x'.repeat(9000) : '') }));
  const t = H.captureTaskState({ messages });
  assert.equal(t.directives.length, 40); assert.equal(t.directives[0], 'do 0'); assert.ok(t.directives.every(d => d.length < 4100));
});

test('normalizeWorkers: legacy chain, explicit graph, cycles, unknowns, duplicates', () => {
  const chain = S.normalizeWorkers([W('a'), W('b'), W('c')]);
  assert.deepEqual(chain.map(w => w.depends_on), [[], ['a'], ['b']]);
  const graph = S.normalizeWorkers([W('a', { depends_on: [] }), W('b', { depends_on: [] }), W('c', { depends_on: ['a', 'b'] })]);
  assert.deepEqual(graph[2].depends_on, ['a', 'b']);
  assert.throws(() => S.normalizeWorkers([W('a', { depends_on: ['b'] }), W('b', { depends_on: ['a'] })]), /cycle/i);
  assert.throws(() => S.normalizeWorkers([W('a', { depends_on: ['zz'] })]), /unknown/);
  assert.throws(() => S.normalizeWorkers([W('a'), W('a')]), /Duplicate/);
  assert.throws(() => S.normalizeWorkers([W('a', { on_failure: 'nope' })]), /on_failure/);
});
test('ownership globs and overlap detection', () => {
  assert.ok(S.pathAllowed('src/api/x/y.js', ['src/api/**'])); assert.ok(!S.pathAllowed('src/ui/a.js', ['src/api/**']));
  assert.ok(S.pathAllowed('a.txt', [])); assert.ok(!S.pathAllowed('src/a/b.js', ['src/*.js']));
  assert.ok(!S.ownsOverlap(['src/api/**'], ['src/ui/**'])); assert.ok(S.ownsOverlap(['src/**'], ['src/ui/**'])); assert.ok(S.ownsOverlap([], ['x/**']));
  const ws = S.normalizeWorkers([W('a', { depends_on: [], owns: ['api/**'] }), W('b', { depends_on: [], owns: ['ui/**'] }), W('c', { depends_on: [] })]);
  assert.deepEqual(S.concurrencyConflicts(ws, () => true).map(p => p.join()), ['a,c', 'b,c']);
});

test('scheduler runs independent workers concurrently, respecting the limit', async () => {
  const ws = S.normalizeWorkers([W('a', { depends_on: [] }), W('b', { depends_on: [] }), W('c', { depends_on: ['a', 'b'] })]);
  let live = 0, peak = 0; const order = [];
  const r = await S.runSchedule(ws, async w => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 15)); live--; order.push(w.name); return { status: 'done' }; }, { concurrency: 2 });
  assert.equal(peak, 2); assert.equal(order.at(-1), 'c'); assert.deepEqual(Object.values(r.statuses), ['done', 'done', 'done']);
  const seq = await S.runSchedule(ws, async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 5)); live--; return { status: 'done' }; }, { concurrency: 1 });
  assert.ok(seq.statuses.c === 'done');
});
test('failure policy: block dependents, continue, abort, retry', async () => {
  const mk = extra => S.normalizeWorkers([W('a', { depends_on: [], ...extra }), W('b', { depends_on: ['a'] }), W('x', { depends_on: [] })]);
  const run = async w => w.name === 'a' ? { status: 'incomplete', retryable: false } : { status: 'done' };
  let r = await S.runSchedule(mk(), run); assert.deepEqual(r.statuses, { a: 'incomplete', b: 'blocked', x: 'done' });
  r = await S.runSchedule(mk({ on_failure: 'continue' }), run); assert.equal(r.statuses.b, 'done');
  r = await S.runSchedule(S.normalizeWorkers([W('a', { on_failure: 'abort' }), W('b'), W('c')]), async w => w.name === 'a' ? { status: 'error', retryable: false } : { status: 'done' });
  assert.deepEqual(Object.values(r.statuses), ['error', 'skipped', 'skipped']);
  let n = 0; r = await S.runSchedule(mk({ retries: 1 }), async w => w.name === 'a' ? (++n < 2 ? { status: 'error' } : { status: 'done' }) : { status: 'done' });
  assert.equal(r.statuses.a, 'done'); assert.equal(r.attempts.a, 2);
});
test('abort skips pending work and resume honours prior done statuses', async () => {
  const ctl = new AbortController(); const ws = S.normalizeWorkers([W('a'), W('b'), W('c')]);
  const r = await S.runSchedule(ws, async () => { ctl.abort(); return { status: 'done' }; }, { signal: ctl.signal });
  assert.deepEqual(Object.values(r.statuses), ['done', 'skipped', 'skipped']);
  const ran = []; const r2 = await S.runSchedule(ws, async w => { ran.push(w.name); return { status: 'done' }; }, { initial: { a: 'done' } });
  assert.deepEqual(ran, ['b', 'c']); assert.equal(r2.statuses.c, 'done');
});

test('SwarmMemory caps values, validates recipients, polls inboxes, round-trips JSON', () => {
  const m = new S.SwarmMemory(['a', 'b']);
  assert.throws(() => m.write('k', 'x'.repeat(2001), 'a'), /max 2000/);
  m.write('schema', 'y'.repeat(900), 'a');
  assert.match(m.toContextString(), /swarm_memory_read\("schema"\)/); assert.equal(m.read('schema').length, 900);
  assert.throws(() => m.postMessage('a', 'ghost', 'hi'), /Unknown recipient/);
  m.postMessage('a', 'b', 'one'); m.postMessage('a', '*', 'all');
  const first = m.inbox('b', 0); assert.equal(first.messages.length, 2);
  m.postMessage('a', 'b', 'two'); assert.deepEqual(m.inbox('b', first.next).messages.map(x => x.content), ['two']);
  assert.equal(m.inbox('a', 0).messages.length, 0);
  assert.equal(S.SwarmMemory.fromJSON(JSON.parse(JSON.stringify(m)), ['a', 'b']).read('schema').length, 900);
});
test('status and outcome helpers are honest', () => {
  assert.equal(S.workerStatusFromLoop({ finishedNaturally: false, summary: 'partial' }), 'incomplete');
  assert.equal(S.workerStatusFromLoop({ finishedNaturally: true, summary: '  ' }), 'incomplete');
  assert.equal(S.workerStatusFromLoop({ finishedNaturally: true, summary: 'ok' }), 'done');
  assert.equal(S.workerStatusFromLoop({ apiError: 'API 500', finishedNaturally: false }), 'error');
  assert.equal(S.swarmOutcome({ a: 'done', b: 'blocked' }), 'blocked');
  assert.equal(S.swarmOutcome({ a: 'done' }), 'needs_review');
  assert.equal(S.swarmOutcome({ a: 'done' }, { verified: true }), 'verified');
});

test('features: queue failure handling, bad package.json, hybrid search', () => {
  const t = (id, status, independent = false) => ({ id, status, independent });
  assert.equal(F.nextQueueTask([t(1, 'failed'), t(2, 'pending')]), null);
  assert.equal(F.nextQueueTask([t(1, 'failed'), t(2, 'pending', true)]).id, 2);
  assert.equal(F.nextQueueTask([t(1, 'skipped'), t(2, 'pending')]).id, 2);
  assert.deepEqual(F.blockedQueueTasks([t(1, 'failed'), t(2, 'pending')]).map(x => x.id), [2]);
  assert.deepEqual(F.recipeCandidates({ 'package.json': '{oops' }), []);
  const rec = [{ id: 'a', workspace: 'w', title: 'cache', text: 'redis ttl', created: 1 }, { id: 'b', workspace: 'w', title: 'auth', text: 'jwt tokens', created: 2 }];
  assert.equal(F.searchKnowledge(rec, 'session expiry', 'w').length, 0);
  assert.equal(F.searchKnowledge(rec, 'session expiry', 'w', 5, { a: 0.9 })[0].id, 'a');
});

test('worker model and token budget are normalised', () => {
  const [a, b] = S.normalizeWorkers([W('a', { model: ' small ', token_budget: 10 }), W('b', { token_budget: 'x' })]);
  assert.equal(a.model, 'small'); assert.equal(a.tokenBudget, 256); assert.equal(b.tokenBudget, 0); assert.equal(b.model, '');
});
test('weak semantic matches are ignored, strong ones rank', () => {
  const rec = [{ id: 'a', workspace: 'w', title: 'x', text: 'y', created: 1 }, { id: 'b', workspace: 'w', title: 'p', text: 'q', created: 2 }];
  assert.deepEqual(F.searchKnowledge(rec, 'zzz', 'w', 5, { a: 0.2, b: 0.6 }).map(r => r.id), ['b']);
});

test('trimToolOutputs shrinks oldest large tool output first, keeps recent ones, reports when it cannot fit', () => {
  const big = 'x'.repeat(4000);
  const mk = () => [{ role: 'user', content: 'task' }, ...Array.from({ length: 10 }, (_, i) => [{ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, function: { name: 'read_file', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c' + i, content: big + i }]).flat()];
  const msgs = mk(); const full = S.trimToolOutputs(msgs, { budgetTokens: 1e9 });
  assert.equal(full.trimmed, 0); assert.equal(full.over, false);
  const r = S.trimToolOutputs(msgs, { budgetTokens: 6000, keepRecent: 4 });
  assert.ok(r.trimmed > 0 && r.saved > 0 && !r.over);
  const tools = msgs.filter(m => m.role === 'tool');
  assert.ok(tools[0].content.length < 500 && /trimmed/.test(tools[0].content)); assert.equal(tools.at(-1).content.length, 4001);
  assert.equal(msgs[0].content, 'task'); assert.ok(msgs.filter(m => m.role === 'assistant').every(m => m.tool_calls));
  const hopeless = S.trimToolOutputs(mk(), { budgetTokens: 100 });
  assert.equal(hopeless.over, true);
  assert.equal(S.trimToolOutputs(mk(), { budgetTokens: 0 }).trimmed, 0);
});

test('critics: validation, automatic dependency on the author, verdict parsing, check settings', () => {
  const ws = S.normalizeWorkers([W('dev'), W('rev', { kind: 'critic', reviews: 'dev', max_revisions: 9 })]);
  assert.deepEqual(ws[1].depends_on, ['dev']); assert.equal(ws[1].max_revisions, 2);
  const g = S.normalizeWorkers([W('dev', { depends_on: [] }), W('rev', { kind: 'critic', reviews: 'dev', depends_on: [] })]);
  assert.deepEqual(g[1].depends_on, ['dev']);
  assert.throws(() => S.normalizeWorkers([W('c', { kind: 'critic' })]), /must name/);
  assert.throws(() => S.normalizeWorkers([W('c', { kind: 'critic', reviews: 'ghost' })]), /unknown worker/);
  assert.throws(() => S.normalizeWorkers([W('c', { kind: 'critic', reviews: 'c' })]), /itself/);
  assert.throws(() => S.normalizeWorkers([W('a'), W('c1', { kind: 'critic', reviews: 'a' }), W('c2', { kind: 'critic', reviews: 'c1' })]), /another critic/);
  assert.throws(() => S.normalizeWorkers([W('a', { kind: 'judge' })]), /kind must be/);
  const [d] = S.normalizeWorkers([W('d', { check_command: ' npm test ', check_retries: 99 })]);
  assert.equal(d.check_command, 'npm test'); assert.equal(d.check_retries, 3); assert.equal(S.normalizeWorkers([W('e')])[0].check_retries, 2);
});
test('parseVerdict reads the last verdict line and keeps the evidence before it', () => {
  assert.equal(S.parseVerdict('1. bug in a.js:3\nVERDICT: REVISE').verdict, 'revise');
  assert.match(S.parseVerdict('1. bug in a.js:3\nVERDICT: REVISE').issues, /a\.js:3/);
  assert.equal(S.parseVerdict('looks fine\n**VERDICT: APPROVE**').verdict, 'approve');
  assert.equal(S.parseVerdict('VERDICT: REVISE\n...then I changed my mind\nVERDICT: APPROVE').verdict, 'approve');
  assert.equal(S.parseVerdict('I would not say either way').verdict, 'unknown');
  assert.equal(S.parseVerdict('').verdict, 'unknown');
});

test('round budget: extends while progressing, warns once, stops spinners, caps extensions', () => {
  const b = S.createRoundBudget({ limit: 4 });
  const seen = []; let done = 0;
  for (let i = 0; i < 20; i++) {
    const d = b.decide(done); seen.push(d);
    if (d === 'limit' || d === 'stalled') break;
    done++; b.record(['read:' + i], true);       // always new, always ok
  }
  assert.equal(seen.filter(d => d === 'extended').length, 2); assert.equal(seen.at(-1), 'limit'); assert.equal(done, 8); // 4 + 2 + 2
  assert.equal(seen.filter(d => d === 'warn').length, 3);                                           // once per budget value
  const s = S.createRoundBudget({ limit: 10, stallLimit: 3 }); let r = 0, last;
  for (; r < 10; r++) { last = s.decide(r); if (last === 'stalled') break; s.record(['same:{}'], true); }
  assert.equal(last, 'stalled'); assert.ok(r <= 4);                                                  // repeats: 1 fresh + 3 stale
  const e = S.createRoundBudget({ limit: 10, stallLimit: 2 }); e.record(['a'], false); e.record(['b'], false);
  assert.equal(e.decide(2), 'stalled');                                                              // all-error rounds are not progress
  const g = S.createRoundBudget({ limit: 4, hardCap: 5 }); g.grant(10); assert.equal(g.limit, 5);
  const t = S.createRoundBudget({ limit: 1 }); assert.equal(t.limit, 2);
});

test('contract: criteria get stable ids, numbers are clamped, owners are validated', () => {
  const k = S.normalizeContract({ acceptance_criteria: ['API returns 200', { text: 'tests pass', owner: 'dev' }], token_budget: 10, deadline_minutes: 9999, repair_rounds: 9 });
  assert.deepEqual(k.criteria.map(x => x.id), ['AC1', 'AC2']); assert.equal(k.token_budget, 1000); assert.equal(k.deadline_minutes, 480);
  assert.equal(k.repair_rounds, 2); assert.equal(k.reserve, 0.2);
  const none = S.normalizeContract(undefined); assert.equal(none.reserve, 0); assert.equal(none.repair_rounds, 1); assert.equal(none.criteria.length, 0);
  assert.throws(() => S.normalizeContract({ acceptance_criteria: ['ok', '  '] }), /empty/);
  assert.throws(() => S.normalizeContract({ acceptance_criteria: Array(13).fill('x') }), /at most 12/);
  const ws = S.normalizeWorkers([W('dev'), W('rev', { kind: 'critic', reviews: 'dev' })]);
  assert.throws(() => S.checkContractOwners(k, S.normalizeWorkers([W('other')])), /unknown owner/);
  assert.throws(() => S.checkContractOwners(S.normalizeContract({ acceptance_criteria: [{ text: 'x', owner: 'rev' }] }), ws), /critic/);
  S.checkContractOwners(k, S.normalizeWorkers([W('dev')]));
});
test('budget allocation keeps a verification reserve and respects explicit budgets', () => {
  const k = S.normalizeContract({ token_budget: 10000 });
  const ws = S.normalizeWorkers([W('a', { token_budget: 2000 }), W('b'), W('c')]);
  assert.deepEqual(S.allocateBudgets(ws, k), { b: 3000, c: 3000 }); // 8000 pool - 2000 explicit, split two ways
  assert.deepEqual(S.allocateBudgets(ws, S.normalizeContract({})), {});
});
test('criteria verdicts: per-criterion status, evidence and owner, missing is not a pass', () => {
  const crit = S.normalizeContract({ acceptance_criteria: ['a', 'b', 'c', 'd'] }).criteria;
  const text = 'Checked.\nAC1: PASS - ran npm test, 12 passed\n**AC2: FAIL** - /health returns 500 (owner: backend)\n- AC3: UNVERIFIABLE - no browser available';
  const r = S.parseCriteriaVerdicts(text, crit);
  assert.deepEqual(r.criteria.map(x => x.status), ['pass', 'fail', 'unverifiable', 'missing']);
  assert.match(r.criteria[0].evidence, /12 passed/); assert.equal(r.criteria[1].owner, 'backend'); assert.equal(r.allPass, false);
  assert.equal(S.parseCriteriaVerdicts('AC1: PASS - ok', crit.slice(0, 1)).allPass, true);
  const ten = S.normalizeContract({ acceptance_criteria: Array(10).fill('x') }).criteria; // AC1 must not match AC10
  assert.equal(S.parseCriteriaVerdicts('AC10: PASS - ok', ten).criteria[0].status, 'missing');
  assert.equal(S.parseCriteriaVerdicts('', []).allPass, false);
});
test('memory separates hypotheses from verified facts, and verified needs provenance', () => {
  const m = new S.SwarmMemory(['a']);
  m.write('guess', 'uses redis', 'a'); m.write('fact', 'port 8080', 'a', { status: 'verified', evidence: 'src/config.js:4' });
  assert.throws(() => m.write('bad', 'x', 'a', { status: 'verified' }), /needs evidence/); assert.throws(() => m.write('bad', 'x', 'a', { status: 'sure' }), /status must be/);
  const ctx = m.toContextString(); assert.match(ctx, /hypothesis - confirm/); assert.match(ctx, /VERIFIED: src\/config\.js:4/);
  const back = S.SwarmMemory.fromJSON(JSON.parse(JSON.stringify(m)), ['a']); assert.match(back.toContextString(), /VERIFIED/);
});
test('dependents of a reviewed author wait for the critic; no cycle is created', () => {
  const ws = S.normalizeWorkers([W('dev', { depends_on: [] }), W('rev', { kind: 'critic', reviews: 'dev', depends_on: [] }), W('ship', { depends_on: ['dev'] })]);
  assert.deepEqual(ws[2].depends_on.sort(), ['dev', 'rev']);
  // listed-order chain: the critic already depends on w2, so w2 must not be made to wait on the critic
  const chain = S.normalizeWorkers([W('dev'), W('w2'), W('rev', { kind: 'critic', reviews: 'dev' })]);
  assert.deepEqual(chain[1].depends_on, ['dev']);
});
test('scheduler stops launching new work when told to, without disturbing finished work', async () => {
  const ws = S.normalizeWorkers([W('a'), W('b'), W('c')]); let stop = false;
  const r = await S.runSchedule(ws, async w => { if (w.name === 'a') stop = true; return { status: 'done' }; }, { shouldStop: () => stop });
  assert.deepEqual(Object.values(r.statuses), ['done', 'skipped', 'skipped']);
});
test('event log is ordered and capped; metrics and run summaries compute the headline numbers', () => {
  const log = S.createEventLog(Date.now() - 50, 3); ['a', 'b', 'c', 'd'].forEach(t => log.emit(t, { x: 1 }));
  assert.deepEqual(log.list().map(e => e.seq), [1, 2, 3]); assert.ok(log.list()[0].t >= 50); assert.equal(log.count('b'), 1);
  const m = S.runMetrics({ outcome: 'verified', durationMs: 4000, tokens: 900, statuses: { a: 'done', b: 'done' }, attempts: { a: 1, b: 2 }, results: { a: { revisions: 1 } }, repairs: 1, acceptance: { criteria: [{ status: 'pass' }, { status: 'fail' }] }, config: { critic: true } });
  assert.equal(m.verified, true); assert.equal(m.retries, 1); assert.equal(m.revisions, 1); assert.equal(m.criteriaPassed, 1); assert.equal(m.criteriaTotal, 2);
  const runs = [m, S.runMetrics({ outcome: 'blocked', durationMs: 2000, tokens: 300, statuses: { a: 'error' }, attempts: {}, results: {}, config: { critic: false } })];
  const s = S.summarizeRuns(runs, 'critic');
  assert.equal(s.overall.runs, 2); assert.equal(s.overall.verifiedRate, 0.5); assert.equal(s.overall.tokensPerVerified, 1200); assert.equal(s.overall.meanLatencyMs, 3000);
  assert.equal(s.groups.true.verifiedRate, 1); assert.equal(s.groups.false.tokensPerVerified, null);
});
test('team advice flags sequential chains, oversized teams and missing verification', () => {
  const seq = S.normalizeWorkers([W('a'), W('b'), W('c')]);
  assert.equal(S.teamAdvice(seq, { hasVerification: true }).length, 1);
  assert.equal(S.teamAdvice(seq, { hasVerification: false }).length, 2);
  const par = S.normalizeWorkers([W('a', { depends_on: [] }), W('b', { depends_on: [] })]);
  assert.deepEqual(S.teamAdvice(par, { hasVerification: true }), []);
  const crit = S.normalizeWorkers([W('a'), W('r', { kind: 'critic', reviews: 'a' })]);
  assert.deepEqual(S.teamAdvice(crit, { hasVerification: true }), []); // a critic is not "another sequential worker"
  assert.ok(S.teamAdvice(S.normalizeWorkers(Array.from({ length: 8 }, (_, i) => W('w' + i, { depends_on: [] }))), { hasVerification: true })[0].includes('Large team'));
});

test('swarm_history is a read-only tool (no write lock, parallel with other reads)', () => { assert.equal(H.isReadOnly('swarm_history'), true); });
