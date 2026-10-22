/* Durable mutation receipts; recovery observes effects and never repeats them. */
(function(root) {
  'use strict';
  function create({ inspect, load, save, clock=Date.now }) {
    const equal=(a,b)=>a===b;
    const check=async(record,phase)=>{
      for(const entry of record.entries) if(!equal(await inspect(entry.path),entry[phase])) return false;
      return true;
    };
    async function persist(record) {
      if(!(await save(record))) throw Object.assign(new Error('Mutation receipt could not be saved; inspect the operation before resuming.'),{code:'mutation_storage'});
    }
    async function reconcile(record, recovered = true) {
      if(record.status==='resolved') return record;
      if(await check(record,'after')) record={...record,status:'applied',recovered,settledAt:clock()};
      else if(record.status!=='applied' && await check(record,'before')) record={...record,status:'not_applied',recovered,settledAt:clock()};
      else record={...record,status:'unknown',recovered};
      await persist(record); return record;
    }
    return { reconcile, async perform(plan, apply) {
      const previous=await load(plan.id);
      if(previous) {
        const result=await reconcile(previous);
        if(result.status==='applied') return {...result,alreadyApplied:true};
        throw Object.assign(new Error('Operation '+plan.id+' already exists ('+result.status+'). Re-read the workspace and issue a new operation; it was not replayed.'),{code:'mutation_reconciliation'});
      }
      let record={...plan,status:'prepared',created:clock()};
      if(!(await check(record,'before'))) throw Object.assign(new Error('File changed since it was read or approved. Read it again before editing.'),{code:'stale_file'});
      await persist(record);
      // Check again after the durable write to close the preview/storage window.
      if(!(await check(record,'before'))) {
        record={...record,status:'not_applied',error:'stale_file'}; await persist(record);
        throw Object.assign(new Error('File changed before the mutation could be applied.'),{code:'stale_file'});
      }
      try { await apply(); }
      catch(error) {
        const outcome=await reconcile({...record,error:String(error.message || error)});
        if(outcome.status==='applied') return outcome;
        throw Object.assign(error,{code:outcome.status==='unknown'?'mutation_unknown':error.code || 'mutation_failed'});
      }
      const outcome=await reconcile(record,false);
      if(outcome.status!=='applied') throw Object.assign(new Error('Mutation outcome could not be verified. Inspect '+plan.id+' before continuing.'),{code:'mutation_unknown'});
      return outcome;
    } };
  }
  const api={create}; root.HarnessMutations=api;
  if(typeof module!=='undefined' && module.exports) module.exports=api;
})(globalThis);
