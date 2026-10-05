const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const H = require('../src/harness-runtime.js');
const call = name => ({ function: { name } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('fake model batch: edits and approvals finish before dependent tests', async () => {
  let contents = 'old', approved = false, activeReads = 0, maxReads = 0;
  const calls = [call('read_file'), call('grep'), call('edit_file'), call('run_tests')];
  const results = await H.runToolBatch(calls, async (tool, index) => {
    if (H.isReadOnly(tool.function.name)) {
      maxReads = Math.max(maxReads, ++activeReads);
      await sleep(10); activeReads--;
    } else if (tool.function.name === 'edit_file') {
      assert.equal(activeReads, 0);
      await sleep(10); approved = true; contents = 'new';
    } else { assert.equal(approved, true); assert.equal(contents, 'new'); }
    return index;
  });
  assert.equal(maxReads, 2);
  assert.deepEqual(results, [0, 1, 2, 3]);
});

test('shared lock prevents simultaneous writes from different workers', async () => {
  let writing = 0;
  await Promise.all(Array.from({ length: 4 }, () => H.withToolLock('edit_file', async () => {
    assert.equal(writing++, 0); await sleep(5); writing--;
  })));
  // A failed tool releases its lease.
  await assert.rejects(H.withToolLock('execute_command', () => { throw new Error('failure'); }));
  await H.withToolLock('write_file', () => assert.equal(writing, 0));
});

test('nested agent orchestration does not hold a write lock', async () => {
  await H.withToolLock('spawn_sub_agent', () => H.withToolLock('read_file', async () => 'ok'));
});

test('schema validation checks nested types, enums, ranges and empty replacement text', () => {
  const schema = { type: 'object', required: ['edits'], properties: { edits: { type: 'array', minItems: 1,
    items: { type: 'object', required: ['old_text', 'new_text'], properties: { old_text: { type: 'string' }, new_text: { type: 'string' } } } } } };
  assert.equal(H.validateSchema({ edits: [{ old_text: 'x', new_text: '' }] }, schema), null);
  assert.match(H.validateSchema({ edits: [{ old_text: 42, new_text: '' }] }, schema), /string/);
  assert.match(H.validateSchema([], { type: 'object' }), /object/);
  assert.match(H.validateSchema(5.5, { type: 'integer' }), /integer/);
  assert.match(H.validateSchema('DELETE', { enum: ['GET'] }), /unsupported/);
  assert.match(H.validateSchema(601, { type: 'number', maximum: 600 }), /maximum/);
});

test('structured status wins over ERROR text in a successful log', () => {
  assert.equal(H.normalizeResult({ status: 'ok', output: 'ERROR case tested', exitCode: 0 }).status, 'ok');
  assert.equal(H.normalizeResult({ output: 'normal output', exitCode: 1 }).status, 'error');
});

test('successful compaction retains objective, steering, checklist and invariants', async () => {
  const messages = [{ role: 'user', content: 'Build the app' }, { role: 'user', content: 'Keep offline support' },
    { role: 'assistant', tool_calls: [{ id: '1' }] }, { role: 'tool', tool_call_id: '1', content: 'ok' }];
  const task = H.captureTaskState({ originalTask: 'Build the app', messages, invariants: ['No network'], planItems: [{ step: 'test', status: 'pending' }] });
  const compacted = await H.compactTransaction(messages, task, async () => 'Implemented UI', 'progress.md');
  assert.match(compacted[0].content, /Keep offline support/);
  assert.match(compacted[0].content, /No network/);
  assert.ok(compacted.every(m => m.role === 'user')); // no orphan tool messages
  assert.deepEqual(messages[3], { role: 'tool', tool_call_id: '1', content: 'ok' });
});

test('failed or empty compaction does not mutate the checkpoint', async () => {
  const messages = [{ role: 'user', content: 'constraints' }], original = JSON.stringify(messages);
  await assert.rejects(H.compactTransaction(messages, {}, async () => { throw new Error('offline'); }));
  await assert.rejects(H.compactTransaction(messages, {}, async () => ''));
  assert.equal(JSON.stringify(messages), original);
});

test('client uses seconds, resumes output by cursor, and never relaunches after transport loss', async () => {
  const records = new Map(), paths = [], timeouts = [];
  const context = { URL, Headers, DOMException, crypto: { randomUUID: () => 'job-1' }, setTimeout, clearTimeout,
    AbortController, AbortSignal: { any: AbortSignal.any.bind(AbortSignal), timeout: ms => { timeouts.push(ms); return AbortSignal.timeout(ms); } },
    state: { compUrl: 'http://127.0.0.1:8765', compToken: 'paired', activeConvId: 'c', running: false },
    dbSet: async (_, job) => records.set(job.id, { ...job }), dbDelete: async (_, key) => records.delete(key),
    redactSecrets: s => s, fetch: async (url, options) => {
      assert.equal(options.headers.get('Authorization'), 'Bearer paired');
      paths.push(new URL(url).pathname);
      if (url.endsWith('/commands/start')) return { ok: true, json: async () => ({ id: 'job-1' }) };
      throw new Error('connection lost');
    } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../src/companion-client.js'), 'utf8'), context);
  const result = await vm.runInContext("executeCompanionJob('echo hi', 300)", context);
  assert.equal(result.status, 'unknown');
  assert.ok(timeouts.includes(315000));
  assert.deepEqual(paths, ['/commands/start', '/commands/status']);
  assert.equal(records.get('command:job-1').cursor, 0);
  paths.length = 0;
  context.fetch = async (url, options) => {
    paths.push(new URL(url).pathname);
    assert.equal(JSON.parse(options.body).cursor, 0);
    return { ok: true, json: async () => ({ status: 'ok', exitCode: 0, events: [{ t: 'o', d: 'hi' }], cursor: 1 }) };
  };
  context.job = records.get('command:job-1');
  const recovered = await vm.runInContext('followCommandJob(job)', context);
  assert.equal(recovered.output, 'hi');
  assert.deepEqual(paths, ['/commands/status']);
});


test('actual approval handlers reject stale empty files and newly created paths', async () => {
  const html = fs.readFileSync(require.resolve('../SlopLobster.html'), 'utf8');
  const start = html.indexOf('async function applyPendingEdit(');
  const end = html.indexOf('async function autoRouteFileError(', start);
  let current = 'external change', writes = 0;
  const handle = { getFile: async () => ({ text: async () => current }), createWritable: async () => ({
    write: async content => { writes++; current = content; }, close: async () => {} }) };
  const context = { requireWorkspace: () => {}, sanitizePath: () => ['file.txt'],
    state: { dirHandle: { getFileHandle: async () => handle }, fileCache: new Map(), verifyWrites: false },
    modifiedFiles: new Set(), newFiles: new Set() };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  context.preview = { _pendingPath: 'file.txt', _originalContent: '', _pendingNewContent: 'model change' };
  const edit = await vm.runInContext('applyPendingEdit(preview)', context);
  assert.equal(edit.status, 'error');
  assert.equal(writes, 0);
  context.preview._originalContent = null;
  const create = await vm.runInContext('applyPendingWrite(preview)', context);
  assert.equal(create.status, 'error');
  assert.equal(writes, 0);
  context.preview._originalContent = current;
  await vm.runInContext('applyPendingWrite(preview)', context);
  assert.equal(writes, 1);
  assert.equal(current, 'model change');
});


test('LM Studio browser connection errors explain CORS and separate tokens', () => {
  const hint = H.connectionErrorHint(new TypeError('Failed to fetch'), 'lmstudio');
  assert.match(hint, /Enable CORS/);
  assert.match(hint, /only authenticates the companion/);
  assert.equal(H.connectionErrorHint(new Error('HTTP 401'), 'lmstudio'), 'HTTP 401');
  assert.equal(H.connectionErrorHint(new TypeError('Failed to fetch'), 'llamacpp'), 'Failed to fetch');
});
