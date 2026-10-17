/* Append-only event preparation and offline reconstruction. No tool execution. */
(function(root) {
  'use strict';
  function create({ append, redact = String, clock = Date.now, uuid = () => globalThis.crypto.randomUUID() }) {
    let tail = Promise.resolve();
    function clean(value, depth = 0) {
      if (typeof value === 'string') {
        if (depth < 4 && /^[\s]*[\[{]/.test(value)) {
          try { return clean(JSON.parse(value), depth + 1); } catch { }
        }
        const text = redact(value.replace(/data:image\/[^\s"']+/g, '[image omitted]'));
        return text.length > 6000 ? text.slice(0, 6000) + '\n[truncated]' : text;
      }
      if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
      if (depth >= 5) return '[nested detail omitted]';
      if (Array.isArray(value)) return value.slice(0, 80).map(v => clean(v, depth + 1));
      const out = Object.create(null);
      for (const [key, item] of Object.entries(value).slice(0, 80)) {
        if (/^(?:authorization|cookie|password|api[_-]?key|token|secret)$/i.test(key)) out[key] = '[REDACTED]';
        else if (typeof item !== 'function' && item !== undefined) out[key] = clean(item, depth + 1);
      }
      return out;
    }
    return { record(context, type, detail = {}) {
      const event = { version: 1, id: uuid(), runId: context.runId, convId: context.convId,
        objective: redact(String(context.objective || '')).slice(0, 1000), type, created: clock(), detail: clean(detail) };
      const encoded = JSON.stringify(event.detail);
      if (encoded.length > 24000) event.detail = { operationId: event.detail.operationId, truncated: true, excerpt: encoded.slice(0, 24000) };
      const work = tail.then(async () => {
        const saved = await append(event);
        if (!saved) throw new Error('Run journal could not be saved. Inspect unfinished operations before resuming. Enable browser storage or disable run journaling in Settings.');
        return typeof saved === 'object' ? saved : event;
      });
      tail = work.catch(() => {});
      return work;
    }, flush() { return tail; } };
  }
  function replay(events = []) {
    const ordered = [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const pending = new Map(), timeline = [], verification = [];
    const integrityIssues = [];
    if (new Set(ordered.map(e => e.runId)).size > 1) integrityIssues.push('The export mixes multiple runs.');
    if (ordered.some((e, i) => !Number.isInteger(e.seq) || e.seq !== i + 1)) integrityIssues.push('The event sequence has gaps, duplicate numbers or invalid sequence values.');
    let phase = 'unknown';
    for (const event of ordered) {
      const d = event.detail || {}, id = d.operationId;
      if (/\.(?:started|requested)$/.test(event.type) && id) pending.set(id, event);
      if (/\.(?:completed|failed|decided|applied|rejected|cancelled|acknowledged)$/.test(event.type) && id) pending.delete(id);
      if (event.type === 'run.started' || event.type === 'run.resumed') phase = 'running';
      if (event.type === 'run.paused') phase = 'paused';
      if (event.type === 'run.finished') phase = 'finished';
      if (event.type === 'verification.result' || event.type === 'verification.baseline') verification.push(event);
      timeline.push({ seq: event.seq, type: event.type, created: event.created, ...d });
    }
    return { runId: ordered[0]?.runId || null, phase, eventCount: ordered.length, integrityIssues,
      incomplete: [...pending.values()].map(e => ({ type: e.type, operationId: e.detail.operationId, detail: e.detail })), verification, timeline };
  }
  const api = { create, replay };
  root.HarnessJournal = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
