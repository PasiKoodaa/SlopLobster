'use strict';
// Drives the real runSubAgent (extracted from the built HTML) with a scripted model.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../SlopLobster.html'), 'utf8').replace(/\r\n/g, '\n');
const a = html.indexOf('async function runSubAgent('), b = html.indexOf('function showSubAgentPanel(');
assert.ok(a > 0 && b > a, 'runSubAgent not found');
const block = html.slice(a, b);

function agent(script, over = {}) {
  const env = { chats: [], tools: [] };
  const ctx = { console, performance, AbortController, Promise, JSON, Math, Number, String, Array, Object, Set, Map,
    SwarmCore: require('../src/swarm-core.js'), HarnessRuntime: require('../src/harness-runtime.js'),
    state: { dirName: 'p' }, getToolDefs: () => ['read_file', 'grep', 'edit_file'].map(n => ({ type: 'function', function: { name: n } })),
    createCompressionStats: () => ({}), compressToolOutput: (n, t) => t, redactSecrets: s => s,
    executeTool: async (name, args) => { env.tools.push(name + args); return over.tool ? over.tool(name, args) : { status: 'ok', output: 'ok ' + args }; },
    subAgentChat: async (messages, tools) => { env.chats.push({ tools: tools.map(t => t.function.name), messages: messages.map(m => ({ ...m })) }); return script(env.chats.length, tools, messages); } };
  vm.createContext(ctx); vm.runInContext(block + '\nglobalThis.__run = runSubAgent;', ctx);
  return { run: (task, tools, max) => ctx.__run(task, tools, max, undefined, null), env };
}
const call = (id, path) => ({ content: '', toolCalls: [{ id: 'c' + id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] });

test('the reported case: limit reached with only tool calls still returns the findings', async () => {
  // The model asks for 5 rounds and keeps calling tools; the final report is only possible through the wrap-up turn.
  const h = agent((n, tools) => tools.length ? call(n, 'f' + n) : { content: 'Found the bug in src/a.js:12.\nSTATUS: COMPLETE', toolCalls: [] });
  const r = await h.run('investigate', ['read_file'], 5);
  assert.match(r.summary, /src\/a\.js:12/); assert.doesNotMatch(r.summary, /without producing a summary/);
  assert.equal(h.env.chats.at(-1).tools.length, 0, 'wrap-up must be tool-free');
});
test('soft budget extends while the agent keeps finding new things, then reports', async () => {
  const h = agent((n, tools) => tools.length ? call(n, 'f' + n) : { content: 'done STATUS: COMPLETE', toolCalls: [] });
  const r = await h.run('t', ['read_file'], 4);
  assert.equal(r.extended, 2); assert.equal(r.iterations, 8); assert.equal(r.hitLimit, true);
  assert.ok(h.env.chats.some(c => c.messages.some(m => /budget was extended/.test(m.content || ''))));
  assert.ok(h.env.chats.some(c => c.messages.some(m => /one round left/.test(m.content || ''))));
});
test('a spinning agent is stopped early and still reports', async () => {
  const h = agent((n, tools) => tools.length ? call(n, 'same.txt') : { content: 'I kept reading same.txt; nothing new. STATUS: INCOMPLETE - could not locate the config', toolCalls: [] });
  const r = await h.run('t', ['read_file'], 20);
  assert.equal(r.stalled, true); assert.ok(r.iterations <= 6, 'stopped long before the budget'); assert.equal(r.incomplete, true);
  assert.match(r.summary, /could not locate/);
});
test('an agent whose calls only fail is not treated as progressing', async () => {
  const h = agent((n, tools) => tools.length ? call(n, 'f' + n) : { content: 'nothing worked STATUS: INCOMPLETE - tool errors', toolCalls: [] }, { tool: () => ({ status: 'error', output: 'Error: nope' }) });
  const r = await h.run('t', ['read_file'], 20);
  assert.equal(r.stalled, true); assert.ok(r.iterations <= 6);
});
test('if the wrap-up fails, the activity digest is returned instead of an empty summary', async () => {
  const h = agent((n, tools) => { if (!tools.length) throw new Error('model unavailable'); return call(n, 'f' + n); });
  const r = await h.run('t', ['read_file'], 4);
  assert.match(r.summary, /raw activity/); assert.match(r.summary, /read_file/); assert.equal(r.incomplete, true);
});
test('a normal early finish is untouched: no wrap-up call, summary is the answer', async () => {
  const h = agent((n, tools) => n === 1 ? call(n, 'a.txt') : { content: 'All good, answer is 42.', toolCalls: [] });
  const r = await h.run('t', ['read_file'], 10);
  assert.equal(r.summary, 'All good, answer is 42.'); assert.equal(h.env.chats.length, 2); assert.equal(r.incomplete, false); assert.equal(r.hitLimit, false);
});
