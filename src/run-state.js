/* Durable run accounting, independent of rendering, storage and model transport. */
(function(root) {
  'use strict';
  const active = new Set(['running', 'recovering', 'awaiting_approval']);
  const transitions = {
    idle: ['recovering', 'running'], recovering: ['running', 'paused'],
    running: ['awaiting_approval', 'paused', 'finished'],
    awaiting_approval: ['running', 'paused'], paused: ['recovering', 'running'], finished: []
  };
  function create(saved = {}, clock = Date.now) {
    saved ||= {};
    const uncertainElapsed = active.has(saved.phase) && Number.isFinite(saved.savedAt) ? Math.max(0, clock() - saved.savedAt) : 0;
    const data = { id: saved.id || globalThis.crypto.randomUUID(), phase: 'idle',
      iterations: Math.max(0, Number(saved.iterations) || 0),
      outputTokens: Math.max(0, Number(saved.outputTokens) || 0) + Math.max(0, Number(saved.reservedTokens) || 0),
      elapsedMs: Math.max(0, Number(saved.elapsedMs) || 0) + uncertainElapsed,
      estimated: !!saved.estimated || saved.reservedTokens > 0, reason: saved.reason || '' };
    if (saved.id) data.phase = saved.phase === 'finished' ? 'finished' : 'paused';
    let since = clock(), reserved = 0;
    const elapsed = () => data.elapsedMs + (active.has(data.phase) ? Math.max(0, clock() - since) : 0);
    return {
      snapshot() { return { ...data, reservedTokens: reserved, elapsedMs: elapsed(), savedAt: clock() }; },
      transition(phase, reason = '') {
        if (phase === data.phase) return;
        if (!transitions[data.phase]?.includes(phase)) throw new Error('Invalid run transition: ' + data.phase + ' -> ' + phase);
        data.elapsedMs = elapsed(); since = clock(); data.phase = phase; data.reason = reason;
      },
      stopReason({ maxIterations = 0, tokenLimit = 0, maxElapsedMs = 0 } = {}) {
        if (maxIterations > 0 && data.iterations >= maxIterations) return 'iteration_limit';
        if (tokenLimit > 0 && data.outputTokens >= tokenLimit) return 'token_limit';
        if (maxElapsedMs > 0 && elapsed() >= maxElapsedMs) return 'time_limit';
        return null;
      },
      step(limits) {
        const reason = this.stopReason(limits);
        if (reason) throw Object.assign(new Error('Run limit reached: ' + reason), { name: 'BudgetError', reason });
        data.iterations++;
      },
      reserve(requested, { tokenLimit = 0, sessionRemaining = Infinity, contextRemaining = Infinity } = {}) {
        const remaining = tokenLimit > 0 ? tokenLimit - data.outputTokens : Infinity;
        const tokens = Math.floor(Math.min(requested, remaining - reserved, sessionRemaining - reserved, contextRemaining));
        if (!(tokens > 0)) throw Object.assign(new Error('No output tokens remain; raise the budget or compact context before resuming.'), { name: 'BudgetError' });
        reserved += tokens;
        let settled = false;
        return { tokens, settle(used = 0, estimated = false) {
          if (settled) return; settled = true; reserved -= tokens;
          data.outputTokens += Math.max(0, Math.ceil(Number(used) || 0)); data.estimated ||= estimated;
        } };
      }
    };
  }
  const api = { create };
  root.HarnessRunState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
