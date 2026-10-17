/* Strict, bounded SSE reader shared by main agents, workers and sub-agents. */
(function(root) {
  'use strict';
  class StreamError extends Error {
    constructor(message, code) { super(message); this.name = 'ModelStreamError'; this.code = code; }
  }
  async function read(response, { signal, idleMs = 120000, onChunk = () => {}, maxEventChars = 4 * 1024 * 1024 } = {}) {
    if (!response.body) throw new StreamError('Model response has no stream body', 'missing_body');
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', data = [], doneEvent = false, terminal = false, failure;
    const dispatch = () => {
      if (!data.length) return;
      const payload = data.join('\n'); data = [];
      if (payload.length > maxEventChars) throw new StreamError('Model stream event exceeds size limit', 'event_limit');
      if (payload.trim() === '[DONE]') { doneEvent = true; return; }
      let chunk;
      try { chunk = JSON.parse(payload); }
      catch { throw new StreamError('Malformed model stream event; no tool calls were executed.', 'invalid_json'); }
      if (chunk.error) throw new StreamError(String(chunk.error.message || chunk.error), 'server_error');
      if (chunk.choices?.some(c => c.finish_reason != null)) terminal = true;
      onChunk(chunk);
    };
    const line = text => {
      if (!text) { dispatch(); return; }
      if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
    };
    const take = async () => {
      let timer, onAbort;
      try {
        return await Promise.race([reader.read(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new StreamError('Model stream stalled; resume explicitly to retry.', 'idle_timeout')), idleMs);
          onAbort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
          if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
        })]);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
    };
    try {
      while (!doneEvent) {
        const next = await take();
        buffer += decoder.decode(next.value || new Uint8Array(), { stream: !next.done });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const text = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
          line(text);
          if (doneEvent) break;
        }
        if (buffer.length + data.reduce((n, s) => n + s.length, 0) > maxEventChars) throw new StreamError('Model stream event exceeds size limit', 'event_limit');
        if (next.done) { if (buffer) line(buffer.replace(/\r$/, '')); dispatch(); break; }
      }
      if (!doneEvent && !terminal) throw new StreamError('Model stream ended before completion; partial tool calls were discarded.', 'premature_eof');
      return { status: 'completed' };
    } catch (error) { failure = error; throw error; }
    finally {
      // Do not await cancellation: a broken server must not hold the run open.
      if (failure || doneEvent) reader.cancel(failure).catch(() => {});
      reader.releaseLock();
    }
  }
  const api = { read, StreamError };
  root.HarnessModelStream = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
