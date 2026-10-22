/* Command authorization and explicit routing to the selected filesystem. */
async function approveShellCommand(command, signal, label='Confirm command') {
  if(signal?.aborted) throw signal.reason || new DOMException('Aborted','AbortError');
  const dangerous=isDangerous(command);
  if(state.shellAutoApprove && (!dangerous || state.shellAutoApproveDangerous)) return command;
  return new Promise(resolve=>showShellConfirm(command,resolve,dangerous?'Dangerous':label,signal));
}
async function resolveCommandWorkspace(signal) {
  const task=typeof featureTask==='function' && featureTask();
  if(task) return task.path;
  if(!state.dirHandle) throw new Error('Open a workspace before running companion commands.');
  let candidate='';
  const records=(await dbGet('agent_states','feature-workspaces'))?.records || [];
  for(const record of records) {
    try {if(await state.dirHandle.isSameEntry(record.handle)) {candidate=record.projectRoot || '';break;}} catch { }
  }
  candidate ||= state.compInfo?.cwd || '';
  if(!candidate) throw new Error('Connect the companion and set the workspace path in Harness > Options.');
  const root=state.dirHandle, marker='.sloplobster-workspace-'+crypto.randomUUID()+'.tmp', nonce=crypto.randomUUID();
  let created=false;
  try {
    const file=await root.getFileHandle(marker,{create:true}); created=true;
    const writable=await file.createWritable();
    try {await writable.write(nonce);await writable.close();} catch(error) {await writable.abort?.();throw error;}
    const response=await companionFetch(state.compUrl+'/workspace/check',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({cwd:candidate,marker,nonce}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
    const data=await response.json();
    if(state.dirHandle!==root) throw new Error('Workspace changed while resolving the command directory.');
    return data.cwd;
  } catch(error) {
    if(signal?.aborted) throw signal.reason || error;
    throw new Error('The selected folder could not be matched to the companion workspace. Set its absolute path in Harness > Options. '+error.message);
  } finally {if(created) await root.removeEntry(marker);}
}
async function execArgvViaCompanion(argv, timeout=30, signal, structured=false) {
  if(!Array.isArray(argv) || !argv.length || argv.some(a=>typeof a!=='string' || a.includes('\0'))) throw new Error('Invalid command arguments');
  const cwd=await resolveCommandWorkspace(signal);
  const result=await executeCompanionJob(argv.map(a=>JSON.stringify(a)).join(' '),timeout,signal,null,null,cwd,argv);
  if(result.status==='unknown' || result.status==='cancelled' && result.exitCode==null) state.running=false;
  return structured?result:result.output;
}
async function checkPythonFile(path,signal) {
  const file=sanitizePath(path).join('/');
  return execArgvViaCompanion([state.compInfo?.python_executable || 'python','-c',
    "import sys; compile(open(sys.argv[1], 'rb').read(), sys.argv[1], 'exec')",file],15,signal);
}
