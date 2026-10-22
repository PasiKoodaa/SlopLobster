/* Dependencies for isolated VM tests; end-to-end adapter tests load real services. */
const Backend=require('../src/backend-core.js'), Core=require('../src/harness-core.js'), Mutations=require('../src/mutation-core.js');
module.exports=function install(context) {
  context.HarnessBackend ||= Backend; context.HarnessCore ||= Core; context.HarnessMutations ||= Mutations;
  context.modelApiUrl ||= path=>Backend.url(context.state.apiUrl,path);
  context.modelApiHeaders ||= extra=>Backend.headers(context.state.apiKey,extra);
  context.captureWorkspaceStamp ||= async()=>({scope:await context.verificationScope(),revision:context.state.workspaceRevision || 0,paths:[]});
  context.archiveToolOutput ||= async(_name,result)=>result;
  context.commitWorkspaceWrite ||= async(path,content)=>{
    const parts=path.split('/'); let dir=context.state.dirHandle;
    for(const part of parts.slice(0,-1)) dir=await dir.getDirectoryHandle(part,{create:true});
    const handle=await dir.getFileHandle(parts.at(-1),{create:true}), writer=await handle.createWritable();
    await writer.write(content); await writer.close();
  };
  return context;
};
