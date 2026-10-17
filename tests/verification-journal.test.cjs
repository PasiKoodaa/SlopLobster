'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const V = require('../src/verification-core.js'), J = require('../src/journal-core.js');
const H = require('../src/harness-runtime.js'), Runs = require('../src/run-state.js');
const result = (output = '', exitCode = 0, status = exitCode ? 'error' : 'ok') => ({ status, exitCode, output });
const failed = (id, count = 1) => result('FAILED tests/math.py::' + id + ' - AssertionError\n' + count + ' failed in 0.2s', 1);

test('verification uses explicit exit status; missing exit codes and timeouts cannot pass', () => {
  assert.equal(V.snapshot('test', { status: 'error', output: 'Error running verification: disconnected' }).status, 'inconclusive');
  assert.equal(V.snapshot('test', { status: 'timeout', exitCode: 0, output: 'passed' }).status, 'inconclusive');
  assert.equal(V.snapshot('test', result('success text', 1)).status, 'failed');
  assert.equal(V.snapshot('test', result('command not found', 127)).status, 'unavailable');
  assert.equal(V.snapshot('test', result('ERROR case tested successfully')).status, 'passed');
});
test('baseline comparison distinguishes old failures, changed identities and resolved failures', () => {
  const baseline = V.snapshot('pytest', failed('old'));
  assert.equal(V.compare(baseline, V.snapshot('pytest', failed('old'))).outcome, 'pre_existing');
  const changed = V.compare(baseline, V.snapshot('pytest', failed('new')));
  assert.equal(changed.outcome, 'regression'); assert.deepEqual(changed.newFailures, ['pytest:tests/math.py::new']);
  assert.deepEqual(changed.resolvedFailures, ['pytest:tests/math.py::old']);
  assert.equal(V.compare(baseline, V.snapshot('pytest', result('2 passed'))).outcome, 'resolved');
  assert.equal(V.compare(V.snapshot('pytest', result('passed')), V.snapshot('pytest', failed('new'))).outcome, 'regression');
});
test('partial failure identities and changed commands never receive a confident comparison', () => {
  const baseline = V.snapshot('pytest', failed('old', 2));
  assert.equal(baseline.identitiesComplete, false);
  assert.equal(V.compare(baseline, V.snapshot('pytest', failed('old', 2))).outcome, 'unclassified_failure');
  assert.equal(V.compare(null, V.snapshot('pytest', failed('new'))).outcome, 'unclassified_failure');
  assert.equal(V.compare(V.snapshot('old command', result('passed')), V.snapshot('new command', failed('new'))).outcome, 'unclassified_failure');
  const missingError = V.snapshot('pytest', result('FAILED tests/a.py::one\n1 failed, 1 error in 0.2s', 1));
  assert.equal(missingError.failureCount, 2); assert.equal(missingError.identitiesComplete, false);
  assert.equal(V.snapshot('pytest', result('FAILED tests/a.py::one', 1)).identitiesComplete, false);
});
test('common test identities survive Node, unittest, Jest and Go formatting', () => {
  for (const [output, expected] of [
    ['not ok 3 - preserves data\n# fail 1', 'node:preserves data'],
    ['FAIL: test_math (tests.Math)\nFAILED (failures=1)', 'unittest:test_math (tests.Math)'],
    ['  ● math › adds\nTests: 1 failed, 2 passed, 3 total', 'jest:math › adds'],
    ['--- FAIL: TestAdd (0.00s)\nFAIL package', 'go:TestAdd']
  ]) assert.deepEqual(V.snapshot('check', result(output, 1)).failureIds, [expected]);
});
test('a baseline pass is evidence of the initial state, never post-edit verification', () => {
  const F = require('../src/features-core.js');
  const summary = F.evidenceSummary([{ kind: 'baseline', status: 'ok', exitCode: 0, command: 'pytest' }]);
  assert.equal(summary.verified, false); assert.equal(summary.baselines.length, 1); assert.equal(summary.checks.length, 0);
});

function verification(responses, saved) {
  const commands = [], events = [], messages = [], records = [];
  const run = Runs.create(saved?.run); run.transition('running');
  const ctx = { HarnessVerification: V, HarnessRuntime: H, crypto, structuredClone,
    state: { running: true, runController: run, autoVerifyCommand: 'pytest', autoVerifyMaxRetries: 2, compConnected: true,
      messages, taskState: saved, dirName: 'project', abortCtrl: new AbortController() },
    harnessFeatureState: { workspace: 'workspace:A' }, featureTask: () => null,
    updateContextMeter() {}, saveCurrentConv() {}, saveActiveAgentState: async () => {},
    appendMsg() {}, isDangerous: () => false, rpTermStart() {}, rpTermAppend() {}, rpTermEnd() {}, redactSecrets: String,
    execViaCompanion: async command => { commands.push(command); return responses.shift() || result('passed'); },
    recordRunEvent: async (type, detail) => { events.push({ type, detail }); },
    recordHarnessTool: (...args) => records.push(args) };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(require.resolve('../src/verification-ui.js'), 'utf8'), ctx);
  return { ctx, commands, events, messages, records };
}
test('baseline is captured once, survives resume, and never auto-repairs pre-existing failures', async () => {
  const h = verification([failed('old'), failed('old')]);
  await h.ctx.ensureVerificationBaseline(); await h.ctx.ensureVerificationBaseline();
  assert.equal(h.commands.length, 1);
  h.ctx.noteVerificationMutation('write_file', { status: 'ok' });
  const comparison = await h.ctx.verifyAfterChanges(); assert.equal(comparison.outcome, 'pre_existing');
  assert.equal(h.messages.some(m => /AUTO-VERIFY REGRESSION/.test(m.content)), false);
  const saved = H.captureTaskState(h.ctx.state);
  const resumed = verification([], JSON.parse(JSON.stringify(saved))); await resumed.ctx.ensureVerificationBaseline();
  assert.equal(resumed.commands.length, 0); assert.equal(resumed.ctx.state.verificationState.mutations, 1);
});
test('automatic repair is reserved for new failures and respects its persisted retry limit', async () => {
  const h = verification([result('passed'), failed('new'), failed('new'), failed('new')]);
  await h.ctx.ensureVerificationBaseline(); h.ctx.noteVerificationMutation('write_file', { status: 'ok' });
  for (let i = 0; i < 3; i++) await h.ctx.verifyAfterChanges();
  assert.equal(h.messages.filter(m => /AUTO-VERIFY REGRESSION/.test(m.content)).length, 2);
  assert.match(h.messages.at(-1).content, /repair limit/);
  assert.equal(h.ctx.state.verificationState.retries, 2);
});
test('failed checks without an untouched baseline are reported without blame or auto-repair', async () => {
  const h = verification([failed('new')]); h.ctx.state.compConnected = false;
  await h.ctx.ensureVerificationBaseline(); h.ctx.state.compConnected = true;
  assert.equal((await h.ctx.verifyAfterChanges()).outcome, 'unclassified_failure');
  assert.equal(h.messages.some(m => /AUTO-VERIFY REGRESSION|broke the test/.test(m.content)), false);
});
test('a changed workspace or command invalidates the old baseline instead of recapturing after edits', async () => {
  const h = verification([result('passed'), failed('new')]); await h.ctx.ensureVerificationBaseline();
  h.ctx.noteVerificationMutation('edit_file', { status: 'ok' }); h.ctx.state.autoVerifyCommand = 'different test';
  assert.equal((await h.ctx.verifyAfterChanges()).outcome, 'unclassified_failure'); assert.equal(h.commands.length, 2);
});
test('a captured baseline interrupted by reload is not rerun or invented', async () => {
  const h = verification([]); const id = h.ctx.state.runController.snapshot().id;
  h.ctx.state.verificationState = { runId: id, scope: await h.ctx.verificationScope(), command: 'pytest', mutations: 0, capturing: true };
  await h.ctx.ensureVerificationBaseline(); assert.equal(h.commands.length, 0);
  assert.equal(h.ctx.state.verificationState.baseline.status, 'unavailable');
});
test('review-only tool settings prevent automatic test execution', async () => {
  const h = verification([]); h.ctx.state.disabledTools = new Set(['run_tests', 'execute_command']);
  await h.ctx.ensureVerificationBaseline(); await h.ctx.verifyAfterChanges();
  assert.equal(h.commands.length, 0); assert.equal(h.ctx.state.verificationState.baseline.status, 'unavailable');
});
test('same-name folders and companion working-directory changes invalidate a baseline', async () => {
  const h = verification([result('passed')]);
  h.ctx.state.dirHandle = { name: 'project' }; await h.ctx.ensureVerificationBaseline();
  const first = h.ctx.state.verificationState.scope;
  h.ctx.state.dirHandle = { name: 'project' }; await h.ctx.ensureVerificationBaseline();
  assert.notEqual(h.ctx.state.verificationState.scope, first); assert.equal(h.ctx.state.verificationState.baseline.status, 'unavailable');
  const second = h.ctx.state.verificationState.scope;
  h.ctx.state.compInfo = { cwd: '/another/path' }; await h.ctx.ensureVerificationBaseline();
  assert.notEqual(h.ctx.state.verificationState.scope, second); assert.equal(h.commands.length, 1);
});
test('the real tool wrapper waits for journal commit before calling its handler', async () => {
  const source = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
  const start = source.indexOf('    async function executeTool('), end = source.indexOf('    async function executeToolImpl(', start);
  let release, mutations = 0, fail = false;
  const committed = new Promise(resolve => { release = resolve; });
  const ctx = { crypto, HarnessRuntime: H, recordRunEvent: async type => { if (fail) throw new Error('storage unavailable'); if (type === 'tool.started') await committed; },
    noteVerificationMutation() {}, executeToolImpl: async () => { mutations++; return { status: 'ok', output: 'changed' }; } };
  vm.createContext(ctx); vm.runInContext(source.slice(start, end), ctx);
  const operation = ctx.executeTool('write_file', '{"path":"a","content":"b"}');
  await Promise.resolve(); assert.equal(mutations, 0); release(); await operation; assert.equal(mutations, 1);
  fail = true; await assert.rejects(ctx.executeTool('write_file', '{}'), /storage unavailable/); assert.equal(mutations, 1);
});
test('approval completion waits for a durable decision before allowing a mutation', async () => {
  const source = fs.readFileSync(require.resolve('../src/app.js'), 'utf8');
  const start = source.indexOf('    function beginRunApproval('), end = source.indexOf('    async function resumeAgent(', start);
  const run = Runs.create(); run.transition('running'); let release, allowed = false;
  const requested = new Promise(resolve => { release = resolve; });
  const events = [], ctx = { crypto, state: { running: true, runController: run }, recordRunEvent: async type => { events.push(type); if (type === 'approval.requested') await requested; } };
  vm.createContext(ctx); vm.runInContext(source.slice(start, end), ctx);
  const finish = ctx.beginRunApproval({ path: 'a' });
  const decision = finish(true).then(() => { allowed = true; });
  await Promise.resolve(); assert.equal(allowed, false); assert.equal(run.snapshot().phase, 'awaiting_approval');
  release(); await decision; assert.equal(run.snapshot().phase, 'running'); assert.deepEqual(events, ['approval.requested', 'approval.decided']);
});

test('journal events commit in order, sanitize before storage and reconstruct unfinished operations', async () => {
  const events = []; let seq = 0;
  const journal = J.create({ append: async event => { const stored = { ...event, seq: ++seq }; events.push(stored); return stored; },
    redact: s => String(s).replaceAll('sensitive-value', '[REDACTED]') });
  const context = { runId: 'r', convId: 'c', objective: 'fixture' };
  await Promise.all([
    journal.record(context, 'run.started'),
    journal.record(context, 'model.started', { operationId: 'model' }),
    journal.record(context, 'model.completed', { operationId: 'model', content: 'sensitive-value', arguments: '{"password":"hidden"}' }),
    journal.record(context, 'tool.started', { operationId: 'write', arguments: { token: 'private' } })
  ]);
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4]);
  assert.equal(JSON.stringify(events).includes('sensitive-value'), false); assert.equal(JSON.stringify(events).includes('hidden'), false);
  const replay = J.replay(JSON.parse(JSON.stringify(events)));
  assert.equal(replay.phase, 'running'); assert.equal(replay.incomplete.length, 1); assert.equal(replay.incomplete[0].operationId, 'write');
  await journal.record(context, 'tool.completed', { operationId: 'write' });
  assert.equal(J.replay(events).incomplete.length, 0);
});
test('journal payloads are bounded while operation correlation survives truncation', async () => {
  let saved;
  const journal = J.create({ append: async event => { saved = event; return true; } });
  await journal.record({ runId: 'r' }, 'tool.started', { operationId: 'op', values: Array(80).fill('x'.repeat(10000)) });
  assert.ok(JSON.stringify(saved.detail).length < 26000); assert.equal(saved.detail.operationId, 'op'); assert.equal(saved.detail.truncated, true);
});
test('storage failure prevents a journaled side effect; later appends can report recovery', async () => {
  let works = false, mutations = 0;
  const journal = J.create({ append: async () => works });
  await assert.rejects(async () => { await journal.record({ runId: 'r' }, 'tool.started'); mutations++; }, /could not be saved/);
  assert.equal(mutations, 0); works = true; await journal.record({ runId: 'r' }, 'run.resumed');
});
test('actual model transport journals completion and failure without executing a model reply', async () => {
  const events = [], ctx = { HarnessRunState: Runs, HarnessRuntime: H, HarnessModelStream: require('../src/model-stream.js'),
    AbortController, AbortSignal, setTimeout, clearTimeout, console, state: { maxTokens: 100, apiUrl: 'fixture' },
    estimateTokens: s => Math.ceil(s.length / 4), recordRunEvent: async (type, detail) => events.push({ type, detail }),
    fetch: async () => new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n') };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(require.resolve('../src/model-client.js'), 'utf8'), ctx);
  await ctx.requestModel({ model: 'fixture', stream: true, max_tokens: 50 });
  assert.deepEqual(events.map(e => e.type), ['model.started', 'model.completed']);
  ctx.fetch = async () => new Response('data: malformed\n\n');
  await assert.rejects(ctx.requestModel({ max_tokens: 50 })); assert.equal(events.at(-1).type, 'model.failed');
});
test('command dispatch waits for its journal record and uses the same stable ID in the outcome', async () => {
  const events = [], paths = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const ctx = { crypto, AbortController, AbortSignal, DOMException, state: { activeConvId: 'c', compUrl: 'fixture' },
    dbSet: async () => true, dbDelete: async () => true, redactSecrets: String,
    recordRunEvent: async (type, detail) => { events.push({ type, detail }); if (type === 'command.started') await gate; } };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(require.resolve('../src/companion-client.js'), 'utf8'), ctx);
  ctx.commandRequest = async (path, body) => { paths.push(path); return path === '/commands/start' ? { id: body.id } : { status: 'ok', exitCode: 0, events: [], cursor: 0 }; };
  const job = ctx.executeCompanionJob('fixture command', 5);
  await Promise.resolve(); assert.equal(paths.length, 0); release(); assert.equal((await job).exitCode, 0);
  assert.deepEqual(events.map(e => e.type), ['command.started', 'command.completed']);
  assert.equal(events[0].detail.operationId, events[1].detail.operationId);
});
test('offline replay reports sequence damage and runs without an inference backend', () => {
  const os = require('node:os'), path = require('node:path'), { spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-journal-replay-')), file = path.join(directory, 'journal.json');
  const events = [{ runId: 'fixture', seq: 1, type: 'run.started', detail: {} }, { runId: 'fixture', seq: 3, type: 'tool.started', detail: { operationId: 'unfinished' } }];
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, events }));
    const replay = spawnSync(process.execPath, [require.resolve('../scripts/replay-journal.mjs'), file], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.equal(replay.status, 0, replay.stderr);
    const parsed = JSON.parse(replay.stdout); assert.equal(parsed.incomplete.length, 1); assert.equal(parsed.integrityIssues.length, 1);
  } finally { fs.unlinkSync(file); fs.rmdirSync(directory); }
});
