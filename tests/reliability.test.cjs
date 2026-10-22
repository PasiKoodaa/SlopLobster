'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const Runs = require('../src/run-state.js'), Streams = require('../src/model-stream.js');
const Runtime = require('../src/harness-runtime.js');
const encode = s => new TextEncoder().encode(s);
const event = chunk => 'data: ' + JSON.stringify(chunk) + '\n\n';
const content = text => ({ choices: [{ delta: { content: text } }] });
const tool = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'write', function: { name: 'write_file', arguments: '{"path":"a","content":"changed"}' } }] } }] };
function response(chunks, close = true, onCancel = () => {}) {
  return new Response(new ReadableStream({ start(c) { chunks.forEach(s => c.enqueue(typeof s === 'string' ? encode(s) : s)); if (close) c.close(); }, cancel: onCancel }));
}
function client(fetch, saved) {
  const ctx = { HarnessRunState: Runs, HarnessModelStream: Streams, HarnessRuntime: Runtime, AbortController, AbortSignal, DOMException,
    setTimeout, clearTimeout, console, state: { apiUrl: 'http://fixture', maxTokens: 500, tokenBudget: 0, runController: Runs.create(saved) },
    _sessionTotalOut: 0, _updateSessionTok(n) { ctx._sessionTotalOut += n; },
    estimateTokens: s => Math.ceil(s.length / 3.8), fetch };
  vm.createContext(require('./runtime-modules.cjs')(ctx)); vm.runInContext(fs.readFileSync(require.resolve('../src/model-client.js'), 'utf8'), ctx);
  return ctx;
}
test('SSE preserves UTF-8 across every byte boundary and accepts CRLF and trailing terminal events', async () => {
  const bytes = encode(event(content('h\u00e9llo \ud83e\udd9e')).replace(/\n/g, '\r\n') + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}');
  const seen = [];
  await Streams.read(response([...bytes].map(b => Uint8Array.of(b))), { onChunk: c => seen.push(c) });
  assert.equal(seen[0].choices[0].delta.content, 'h\u00e9llo \ud83e\udd9e'); assert.equal(seen.length, 2);
});
test('DONE completes without waiting for an indefinitely open socket', async () => {
  let cancelled = false;
  await Streams.read(response(['data: [DONE]\n\n'], false, () => { cancelled = true; }), { idleMs: 30 });
  assert.equal(cancelled, true);
});
test('malformed events, event limits and server error events fail explicitly', async () => {
  await assert.rejects(Streams.read(response(['data: {broken}\n\n'])), { code: 'invalid_json' });
  await assert.rejects(Streams.read(response(['data: ' + 'x'.repeat(100)]), { maxEventChars: 20 }), { code: 'event_limit' });
  await assert.rejects(Streams.read(response([event({ error: { message: 'overloaded' } })])), /overloaded/);
});
test('valid-looking mutation arguments at premature EOF never escape the model transport', async () => {
  const ctx = client(async () => response([event(tool)])); let writes = 0;
  await assert.rejects(async () => { const result = await ctx.requestModel({ max_tokens: 500, stream: true }); writes += result.toolCalls.length; }, { code: 'premature_eof' });
  assert.equal(writes, 0); assert.ok(ctx.state.runController.snapshot().outputTokens > 0, 'partial output is charged');
});
test('cancellation and inactivity discard partial calls and cancel the reader', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const pending = Streams.read(response([event(tool)], false, () => { cancelled = true; }), { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled, true);
  await assert.rejects(Streams.read(response([], false), { idleMs: 15 }), { code: 'idle_timeout' });
});
test('run accounting survives compaction and reload, excludes paused time, and permits raised limits', () => {
  let now = 0; const run = Runs.create({}, () => now); run.transition('running');
  run.step({ maxIterations: 2 }); now = 100; run.transition('paused'); now = 5000;
  const compacted = Runtime.captureTaskState({ originalTask: 'fix', messages: [{ role: 'user', content: 'Preserve offline support' }], runController: run });
  const restored = Runs.create(JSON.parse(JSON.stringify(compacted.run)), () => now);
  restored.transition('recovering'); restored.transition('running'); restored.step({ maxIterations: 2 });
  assert.equal(restored.stopReason({ maxIterations: 2 }), 'iteration_limit');
  assert.throws(() => restored.step({ maxIterations: 2 }), { name: 'BudgetError' });
  restored.step({ maxIterations: 3 }); assert.equal(restored.snapshot().elapsedMs, 100);
  now += 150; assert.equal(restored.stopReason({ maxElapsedMs: 200 }), 'time_limit');
});
test('concurrent requests reserve a shared budget and charge exact usage once', async () => {
  const requests = []; let release;
  const wait = new Promise(resolve => { release = resolve; });
  const ctx = client(async (_, options) => {
    requests.push(JSON.parse(options.body)); await wait;
    return response([event(content('ok')), event({ usage: { prompt_tokens: 20, completion_tokens: 30 }, choices: [] }), 'data: [DONE]\n\n']);
  });
  ctx.state.runTokenLimit = 80;
  const first = ctx.requestModel({ max_tokens: 50, stream: true });
  const second = ctx.requestModel({ max_tokens: 50, stream: true });
  await assert.rejects(ctx.requestModel({ max_tokens: 50, stream: true }), { name: 'BudgetError' });
  assert.deepEqual(requests.map(r => r.max_tokens), [50, 30]);
  release(); await Promise.all([first, second]);
  assert.equal(ctx.state.runController.snapshot().outputTokens, 60); assert.equal(ctx._sessionTotalOut, 60);
  const summary = await ctx.requestModelJSON({ max_tokens: 50 });
  assert.equal(summary.choices[0].message.content, 'ok'); assert.equal(requests[2].max_tokens, 20);
});
test('tool-free passes and failed HTTP calls release reservations without free successful generations', async () => {
  let fail = true;
  const ctx = client(async () => fail ? new Response('busy', { status: 503 }) : response([event(content('summary')), 'data: [DONE]\n\n']));
  ctx.state.runTokenLimit = 30;
  await assert.rejects(ctx.requestModelJSON({ max_tokens: 30 }), /503/); assert.equal(ctx._sessionTotalOut, 0);
  fail = false; await ctx.requestModelJSON({ max_tokens: 30 }); assert.ok(ctx._sessionTotalOut > 0);
});
test('context allowance accounts for schemas and images without tokenizing base64 as source text', async () => {
  const image = { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'a'.repeat(500000) } }] };
  assert.ok(Runtime.estimateRequestTokens([image], []) < 1100);
  let requests = 0;
  const ctx = client(async () => { requests++; return response(['data: [DONE]\n\n']); });
  ctx.state.ctxWindow = 280;
  await assert.rejects(ctx.requestModel({ messages: [{ role: 'user', content: 'x'.repeat(200) }], max_tokens: 500 }), { code: 'context_overflow' });
  assert.equal(requests, 0);
});
test('even valid JSON tool calls are withheld when generation hits the output limit', async () => {
  const ctx = client(async () => response([event(tool), event({ choices: [{ delta: {}, finish_reason: 'length' }] }), 'data: [DONE]\n\n']));
  await assert.rejects(ctx.requestModel({ max_tokens: 500 }), { code: 'truncated_tool_call' });
});
test('resumed output budgets include tokens spent before the reload', async () => {
  const run = Runs.create(); run.reserve(100, { tokenLimit: 100 }).settle(75);
  let allowance;
  const ctx = client(async (_, options) => { allowance = JSON.parse(options.body).max_tokens; return response([event(content('done')), 'data: [DONE]\n\n']); }, run.snapshot());
  ctx.state.runTokenLimit = 100; await ctx.requestModel({ max_tokens: 500 }); assert.equal(allowance, 25);
});
test('reload during generation conservatively charges its persisted reservation', async () => {
  let now = 0;
  const run = Runs.create({}, () => now); run.transition('running');
  const reservation = run.reserve(80, { tokenLimit: 100 });
  const saved = JSON.parse(JSON.stringify(run.snapshot())); now = 500;
  const restored = Runs.create(saved, () => now);
  assert.equal(restored.snapshot().outputTokens, 80); assert.equal(restored.snapshot().estimated, true);
  assert.equal(restored.stopReason({ maxElapsedMs: 400 }), 'time_limit');
  assert.equal(restored.reserve(100, { tokenLimit: 100 }).tokens, 20);
  reservation.settle(12);
  assert.equal(Runs.create(run.snapshot()).snapshot().outputTokens, 12, 'a completed request releases the unused reservation');
});
test('reconciliation collects sibling results but retains and blocks unknown command outcomes', async () => {
  const jobs = new Map([['lost', { commandId: 'lost', convId: 'c', companionUrl: 'http://fixture', command: 'mutate' }],
    ['done', { commandId: 'done', convId: 'c', companionUrl: 'http://fixture', command: 'check' }]]);
  const ctx = { state: { activeConvId: 'c', compUrl: 'http://fixture', messages: [] }, appendMsg() {}, saveCurrentConv() {},
    dbGetAll: async () => [...jobs.values()], dbDelete: async (_, id) => jobs.delete(id.replace('command:', '')) };
  vm.createContext(require('./runtime-modules.cjs')(ctx)); vm.runInContext(fs.readFileSync(require.resolve('../src/companion-client.js'), 'utf8'), ctx);
  const recovered = [];
  ctx.followCommandJob = async job => {
    recovered.push(job.commandId);
    if (job.commandId === 'lost') throw Object.assign(new Error('not found'), { status: 404 });
    return { output: 'verified sibling', exitCode: 0 };
  };
  await assert.rejects(ctx.reconcileCommandJobs(), /Unresolved command outcomes/);
  assert.deepEqual(recovered, ['lost', 'done']); assert.equal(jobs.has('lost'), true);
  assert.ok(ctx.state.messages.some(m => m.content.includes('verified sibling')));
  ctx.showActionConfirm = (_, detail, callback) => { assert.match(detail, /not be replayed/); callback(detail); };
  await ctx.reconcileCommandJobs(); assert.equal(jobs.size, 0);
  assert.ok(ctx.state.messages.some(m => m.content.includes('Do not repeat it')));
});
test('the live-model benchmark fixtures satisfy the evaluation contract', () => {
  const spec = JSON.parse(fs.readFileSync(require.resolve('./fixtures/coding-benchmark.json'), 'utf8'));
  require('../src/features-core.js').validateBenchmark(spec);
  for (const task of spec.tasks) for (const assertion of task.assertions) assert.ok(Object.hasOwn(task.files, assertion.path));
});

function loop(saved) {
  const events = [], ctx = { HarnessRunState: Runs, HarnessRuntime: Runtime, AbortController, DOMException, performance, console: { log() {} },
    setTimeout, clearTimeout, state: { maxIters: 3, memoryAgentEnabled: true, activeConvId: 'c', messages: [], pendingSteerMessages: [], taskState: saved ? { run: saved } : null },
    _sessionTotalOut: 0, toolCallHistory: [], textLoopBuffer: [], modifiedFiles: new Set(), newFiles: new Set(), allModified: new Set(),
    tokenTracker: { lastPromptTokens: -1, totalOutputTokens: 0, reset() { this.lastPromptTokens = -1; }, commit() {} },
    agentStopwatch: null, streamEl: null, beforeHarnessRun: async () => true, reconcileCommandJobs: async () => {},
    saveActiveAgentState: async () => { events.push('save'); }, clearActiveAgentState: async () => {},
    appendMsg: (_, message) => events.push(message), createCompressionStats: () => ({}), getContextPct: () => 0,
    saveProgressToWorkspace: async () => true, progressCompact: async () => { events.push('compact'); }, showThinking: () => null,
    streamChat: async () => { events.push('model'); return { content: '', toolCalls: [], usage: { out: 0 } }; },
    stripThinkingBlocks: s => s, updateSendBtn() {}, updateContextMeter() {}, saveCurrentConv() {},
    showCompletionSummary() {}, afterHarnessRun: async () => {}, saveCheckpoint() {}, renderSteerQueue() {},
    notifyUser() {}, finalizeLiveThinkBlock() {}, updatePauseBtn() {}, appendPauseMsg() {},
  };
  vm.createContext(require('./runtime-modules.cjs')(ctx)); vm.runInContext(fs.readFileSync(require.resolve('../src/agent-loop.js'), 'utf8'), ctx);
  return { ctx, events };
}
test('real agent loop stops at the total limit despite repeated compaction and cannot reset it on reload', async () => {
  const h = loop(); await h.ctx.agentLoop();
  assert.equal(h.events.filter(e => e === 'model').length, 3); assert.equal(h.events.filter(e => e === 'compact').length, 2);
  const saved = JSON.parse(JSON.stringify(h.ctx.state.runController.snapshot()));
  const resumed = loop(saved); await resumed.ctx.agentLoop();
  assert.equal(resumed.events.filter(e => e === 'model').length, 0); assert.equal(resumed.ctx.state.running, false);
});
test('real agent loop cleans up and preserves the budget when command recovery fails', async () => {
  const h = loop(); h.ctx.reconcileCommandJobs = async () => { throw new Error('unknown command'); };
  await h.ctx.agentLoop();
  assert.equal(h.ctx.state.running, false); assert.equal(h.ctx.state.abortCtrl, null);
  assert.equal(h.ctx.state.runController.snapshot().phase, 'paused'); assert.equal(h.ctx.state.runController.snapshot().iterations, 0);
});
test('an explicit retry after completed work receives a new allowance', async () => {
  const h = loop({ id: 'completed', phase: 'finished', iterations: 3, outputTokens: 200 });
  await h.ctx.agentLoop();
  assert.equal(h.events.filter(e => e === 'model').length, 3);
  assert.notEqual(h.ctx.state.runController.snapshot().id, 'completed');
});
