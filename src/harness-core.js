/* Pure decisions for progress, completion, context selection and evaluation. */
(function(root) {
  'use strict';
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
    return JSON.stringify(value) ?? 'null';
  }
  function fingerprint(value) {
    const text = typeof value === 'string' ? value : canonical(value);
    let a=2166136261, b=2246822519;
    for(let i=0;i<text.length;i++) { a=Math.imul(a^text.charCodeAt(i),16777619); b=Math.imul(b^text.charCodeAt(i),3266489917); }
    return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
  }
  function progressRecord(name, args, result = {}, revision = 0) {
    if(typeof args === 'string') { try { args=JSON.parse(args); } catch { /* preserve malformed input */ } }
    const output=String(result.output || '');
    const comparable=output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi,'[operation]')
      .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g,'[time]').replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds)\b/g,'[duration]');
    return { sig:name+':'+canonical(args), name, args, success:result.status==='ok', revision,
      resultFingerprint:fingerprint({status:result.status,error:result.error,output:comparable}), outText:output.slice(0,500) };
  }
  function stalled(history, count = 3) {
    const recent=history.slice(-count);
    return recent.length===count && recent[0].name!=='think' && recent.every(r => r.sig===recent[0].sig &&
      r.resultFingerprint===recent[0].resultFingerprint && r.revision===recent[0].revision);
  }
  function completion({ mutated = false, verification, evidence, pending = [], checklist = [], criteria = [] } = {}) {
    const reasons=[];
    if(pending.length) reasons.push('Unresolved operations: '+pending.map(p => p.id || p.commandId || p).join(', '));
    const latest=verification?.latest;
    if(latest?.comparison?.outcome==='regression' || latest?.snapshot?.status==='failed' && latest?.comparison?.outcome!=='pre_existing') reasons.push('The latest configured verification did not pass.');
    if(evidence?.issues?.length) reasons.push('A tool operation remains blocked or has an unknown outcome.');
    if(reasons.length) return { outcome:'blocked', reasons };
    const unfinished=checklist.filter(i => i.status!=='done');
    if(unfinished.length) reasons.push('Unfinished checklist: '+unfinished.map(i=>i.text).join('; '));
    if(criteria.some(c => typeof c==='string' || !c.verified)) reasons.push('Acceptance criteria still require review.');
    const current=latest && latest.revision === verification.mutations && !latest.stale;
    const verified=(current && latest.snapshot.status==='passed') || (!latest?.stale && evidence?.verified);
    if(verified && !reasons.length) return {outcome:'verified',reasons:[]};
    if(mutated || reasons.length) return {outcome:'completed_unverified',reasons:reasons.length?reasons:['No current successful verification covers the changes.']};
    return {outcome:'completed',reasons:[]};
  }
  function excerpt(text, limit=2400) {
    text=String(text || '');
    if(text.length<=limit) return text;
    const head=Math.floor(limit*0.25), tail=Math.floor(limit*0.5);
    const errors=text.split('\n').filter(l=>/error|failed|exception|traceback|assert|warning/i.test(l)).join('\n').slice(0,Math.floor(limit*0.25));
    return text.slice(0,head)+'\n[... omitted; see full tool output ...]\n'+errors+'\n'+text.slice(-tail);
  }
  function compactionInput(messages, task, { maxChars=30000, recentTurns=12 } = {}) {
    const recent=messages.slice(-recentTurns), older=messages.slice(0,-recentTurns);
    const important=older.filter(m => m.role==='user' && !m._harnessContext || m._status && m._status!=='ok').slice(-8);
    const parts=['TASK STATE\n'+canonical(task)];
    for(const m of [...important,...recent]) {
      const tools=m.tool_calls?.map(tc=>({name:tc.function.name,args:excerpt(tc.function.arguments,1000)}));
      parts.push('['+m.role+(m._status?':'+m._status:'')+'] '+excerpt(m.content,m.role==='tool'?3500:4500)+
        (tools?'\nTools: '+canonical(tools):'')+(m._artifactId?'\nFull output artifact: '+m._artifactId:''));
    }
    let text=parts.join('\n\n');
    if(text.length>maxChars) {
      const state=parts[0].slice(0,Math.floor(maxChars/2));
      text=state+'\n[Earlier conversation omitted; retrieve referenced artifacts as needed.]\n'+parts.slice(1).join('\n\n').slice(-(maxChars-state.length-90));
    }
    return text;
  }
  function evaluationSummary(rows) {
    const passed=rows.filter(r=>r.status==='passed'), tokens=rows.reduce((n,r)=>n+(r.outputTokens||0),0);
    return { tasks:rows.length, passed:passed.length, verifiedRate:rows.length?passed.length/rows.length:0,
      tokensPerVerified:passed.length?tokens/passed.length:null, interventions:rows.reduce((n,r)=>n+(r.interventions||0)+(r.humanInterventions||0),0),
      elapsedSeconds:rows.reduce((n,r)=>n+(r.elapsedSeconds||0),0), failures:rows.filter(r=>r.status!=='passed').map(r=>({task:r.task,backend:r.backend,reason:r.failureCategory||r.stopReason||r.error||r.status})) };
  }
  const api={canonical,fingerprint,progressRecord,stalled,completion,excerpt,compactionInput,evaluationSummary};
  root.HarnessCore=api;
  if(typeof module!=='undefined' && module.exports) module.exports=api;
})(globalThis);
