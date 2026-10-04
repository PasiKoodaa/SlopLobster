/* Feature state and evaluation primitives, independent of the UI. */
(function(root) {
  'use strict';
  const defaults = Object.freeze({ isolation:false, evidence:true, recipes:true, queue:false, knowledge:true, autoRetrieve:false, projectRoot:'' });
  function preferences(value={}) { return {...defaults, ...Object.fromEntries(Object.keys(defaults).filter(k => k in value).map(k => [k,value[k]]))}; }
  function newQueueTask(text, options={}) {
    if (!String(text).trim()) throw new Error('A task needs a prompt');
    return {...options, id:options.id || crypto.randomUUID(), text:String(text).trim(), criteria:options.criteria || [], independent:!!options.independent,
      maxIters:Math.max(1,Math.min(200,Number(options.maxIters)||32)), tokenBudget:Math.max(256,Math.min(100000,Number(options.tokenBudget)||8000)),
      status:'pending', created:Date.now()};
  }
  function nextQueueTask(tasks) {
    for (let i=0;i<tasks.length;i++) {
      const task=tasks[i];
      if (task.status!=='pending') continue;
      if (task.independent || tasks.slice(0,i).every(t => t.status==='done' || t.status==='discarded')) return task;
    }
    return null;
  }
  function evidenceSummary(events) {
    const writes=new Set(), checks=[], issues=[], screenshots=[];
    let lastWrite=-1;
    events.forEach((event,index) => {
      if (event.kind==='change' && event.status==='ok') { writes.add(event.path); lastWrite=index; }
      if (event.kind==='mutation' && event.status!=='pending') lastWrite=index;
      if (event.kind==='check') checks.push({...event,index});
      if (event.status==='blocked' || event.status==='unknown') issues.push(event);
      if (event.kind==='screenshot') screenshots.push(event);
    });
    const latest=new Map();
    checks.forEach(check => latest.set(check.command||check.tool,check));
    const verification=[...latest.values()];
    const verified=verification.length>0 && verification.every(c => c.status==='ok' && c.exitCode===0 && c.index>lastWrite);
    return {files:[...writes], checks:verification, issues, screenshots, verified, outcome:issues.length?'blocked':verified?'verified':'needs_review'};
  }
  function searchKnowledge(records, query, workspace, limit=5) {
    const words=[...new Set(String(query).toLowerCase().match(/[a-z0-9_]{2,}/g)||[])];
    return records.filter(r => r.workspace===workspace).map(record => {
      const text=(record.title+' '+record.text).toLowerCase();
      const score=words.reduce((sum,w) => sum+(text.includes(w)?1:0),0)+(record.verified?0.2:0);
      return {...record, score};
    }).filter(r => r.score>0.2).sort((a,b)=>b.score-a.score || b.created-a.created).slice(0,limit);
  }
  function recipeCandidates(files) {
    const candidates=[];
    if (files['package.json']) {
      const p=JSON.parse(files['package.json']);
      const runner=Object.hasOwn(files,'pnpm-lock.yaml')?'pnpm':Object.hasOwn(files,'yarn.lock')?'yarn':Object.hasOwn(files,'bun.lock')?'bun':'npm';
      const recipe={name:p.name||'Node project', setup:runner+' install', build:'', lint:'', test:'', preview:''};
      for (const name of ['build','lint','test']) if (p.scripts?.[name]) recipe[name]=runner+' run '+name;
      if (p.scripts?.dev) recipe.preview=runner+' run dev'; else if (p.scripts?.start) recipe.preview=runner+' run start';
      candidates.push(recipe);
    }
    if (files['pyproject.toml'] || files['pytest.ini'] || files['requirements.txt']) candidates.push({name:'Python project',setup:files['requirements.txt']?'python -m pip install -r requirements.txt':'',build:'',lint:'',test:'python -m pytest',preview:''});
    if (files['Cargo.toml']) candidates.push({name:'Rust project',setup:'',build:'cargo build',lint:'cargo clippy',test:'cargo test',preview:''});
    if (files['go.mod']) candidates.push({name:'Go project',setup:'go mod download',build:'go build ./...',lint:'go vet ./...',test:'go test ./...',preview:''});
    return candidates;
  }
  function validateBenchmark(spec) {
    if (!spec || !Array.isArray(spec.tasks) || !spec.tasks.length || spec.tasks.length>20) throw new Error('Benchmark needs 1-20 tasks');
    for (const task of spec.tasks) {
      if (!task.prompt || !task.files || !Array.isArray(task.allowedWrites)) throw new Error('Each task needs prompt, files and allowedWrites');
      for (const path of [...Object.keys(task.files),...task.allowedWrites]) if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..') || /^[A-Za-z]:/.test(path)) throw new Error('Unsafe fixture path');
      if (!Array.isArray(task.assertions) || !task.assertions.length) throw new Error('Each task needs file assertions');
    }
    return spec;
  }
  const api={defaults,preferences,newQueueTask,nextQueueTask,evidenceSummary,searchKnowledge,recipeCandidates,validateBenchmark};
  root.HarnessFeatures=api;
  if (typeof module!=='undefined' && module.exports) module.exports=api;
})(globalThis);
