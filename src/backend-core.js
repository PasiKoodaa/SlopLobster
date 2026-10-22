/* OpenAI-compatible transport policy shared by every model pass. */
(function(root) {
  'use strict';
  const samplers = ['temperature','top_p','frequency_penalty','presence_penalty','seed','top_k','min_p','repeat_penalty',
    'repetition_penalty','chat_template_kwargs','dry_multiplier','dry_base','dry_allowed_length','dry_sequence_breakers',
    'xtc_probability','xtc_threshold','mirostat','mirostat_tau','mirostat_eta'];
  const portable = new Set(['temperature','top_p','frequency_penalty','presence_penalty','seed']);
  function url(base, path) {
    base = String(base || '').replace(/\/+$/, '');
    const suffix = '/' + String(path || '').replace(/^\/+/, '');
    if (/\/v1$/i.test(base)) return /^\/v1(?:\/|$)/i.test(suffix) ? base + suffix.slice(3) : base.slice(0,-3) + suffix;
    return base + suffix;
  }
  function headers(key, extra = {}) { return { ...extra, ...(key ? { Authorization: 'Bearer ' + key } : {}) }; }
  function normalize(body, { backendType = 'lmstudio', useServerSampling = false } = {}) {
    const next = { ...body };
    const native = backendType === 'lmstudio' || backendType === 'llamacpp';
    for (const key of samplers) if (useServerSampling || (!native && !portable.has(key))) delete next[key];
    if (Array.isArray(next.messages)) next.messages = next.messages.map(message => {
      // UI previews, artifact metadata and harness flags never belong on the wire.
      const clean = {};
      for (const key of ['role','content','name','tool_calls','tool_call_id','reasoning_content']) {
        if (message[key] !== undefined) clean[key] = message[key];
      }
      if (message._images?.length && !Array.isArray(clean.content)) clean.content = [
        ...(clean.content ? [{ type:'text', text:clean.content }] : []), ...message._images];
      if (clean.tool_calls) clean.tool_calls = clean.tool_calls.map(tc=>({id:tc.id,type:tc.type || 'function',function:{name:tc.function.name,arguments:tc.function.arguments}}));
      return clean;
    });
    return next;
  }
  function classify(error) {
    const status = Number(error?.status) || 0, message = String(error?.message || error || 'Unknown failure');
    if (error?.name === 'AbortError') return { code:'cancelled', retryable:false };
    if (error?.name === 'BudgetError') return { code:'budget', retryable:false };
    if ([401,403].includes(status)) return { code:'authentication', retryable:false };
    if (status === 404) return { code:'endpoint', retryable:false };
    if (/context.*(?:length|window|exceed|full)|too many tokens|maximum.*tokens/i.test(message)) return { code:'context_overflow', retryable:false };
    if ([408,429,500,502,503,504].includes(status)) return { code:'server_busy', retryable:true };
    if (error?.code) return { code:error.code, retryable:false };
    if (error?.name === 'TypeError' || /failed to fetch|networkerror/i.test(message)) return { code:'transport_unknown', retryable:false };
    return { code:'request_failed', retryable:false };
  }
  function retryDelay(error, attempt) {
    // Only explicit rejected HTTP requests are retried; a dropped stream may
    // already have consumed output and is never transparently replayed.
    if (attempt >= 2 || !classify(error).retryable) return null;
    return Math.min(5000, Math.max(250 * 2 ** attempt, Number(error.retryAfterMs) || 0));
  }
  function key(state) { return [state.apiUrl, state.backendType, state.model].join('|'); }
  function observe(previous = {}, result = {}) {
    return { ...previous, streaming:true, toolCalls:previous.toolCalls || !!result.toolCalls?.length,
      usage:previous.usage || (result.usage?.in >= 0 && result.usage?.estimated === false), checkedAt:Date.now() };
  }
  const api = { url, headers, normalize, classify, retryDelay, key, observe };
  root.HarnessBackend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
