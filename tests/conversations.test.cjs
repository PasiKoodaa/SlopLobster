
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require.resolve('../SlopLobster.html'),'utf8').replace(/\r\n/g,'\n');
function between(start,end){const from=html.indexOf(start);assert.ok(from>=0,start);const to=html.indexOf(end,from);assert.ok(to>from,end);return html.slice(from,to);}
function setup(root=null){
 const records=new Map(),local=new Map(),notices=[];
 const context={console:{warn:()=>{},error:()=>{},info:()=>{}},setTimeout,clearTimeout,DOMException,
  state:{conversations:[{id:'old',title:'Old',messages:[]},{id:'keep',messages:[]}],activeConvId:'keep',messages:[],dirHandle:root},
  localStorage:{getItem:k=>local.get(k)??null,setItem:(k,v)=>local.set(k,String(v)),removeItem:k=>local.delete(k)},
  dbGetAll:async()=>[...records.values()],dbSet:async(_,c)=>{records.set(c.id,structuredClone(c));return true;},
  dbDelete:async(_,id)=>{records.delete(id);return true;},hfBusy:()=>false,showToast:(text,kind)=>notices.push({text,kind}),
  renderConvList:()=>{},restoreHarnessConversation:async()=>{},switchToChat:()=>{},replayMessages:()=>{},updateContextMeter:()=>{},scheduleRealTokenSync:()=>{},
  switchConv:async id=>{context.state.activeConvId=id;},doNewConversation:async()=>{context.state.activeConvId='new';context.state.conversations.push({id:'new',messages:[]});}};
 vm.createContext(context);
 vm.runInContext(between("    const STORAGE_KEY =", "    function saveCurrentConv()")+
  between("    async function deleteConv(","    function filterConversations")+
  between("    const CONV_DIR =", "    /** Get storage status"),context);
 context.scheduleConvIndexSave=()=>{};
 return {context,records,local,notices,run:code=>vm.runInContext(code,context)};
}
function workspace(files){
 const missing=()=>new DOMException('Missing','NotFoundError');
 const directory={getDirectoryHandle:async()=>directory,
  removeEntry:async name=>{if(!files.delete(name))throw missing();},
  getFileHandle:async(name,options={})=>{
   if(!files.has(name)&&!options.create)throw missing();
   return {getFile:async()=>({text:async()=>files.get(name)}),createWritable:async()=>({write:async s=>files.set(name,s),close:async()=>{}})};
  },async *entries(){for(const name of files.keys())yield [name,await directory.getFileHandle(name)];}};
 return directory;
}
test('delete removes IndexedDB and caches and stays deleted after reload',async()=>{
 const {context,records,local,run}=setup();
 await run('saveConversations()');
 local.set('SlopLobster_conversations',JSON.stringify(context.state.conversations));
 await run("deleteConv('old',{stopPropagation(){}})");
 assert.equal(records.has('old'),false);
 assert.equal(JSON.parse(local.get('SlopLobster_convCache')).titles.some(c=>c.id==='old'),false);
 assert.equal(JSON.parse(local.get('SlopLobster_conversations')).some(c=>c.id==='old'),false);
 context.state.conversations=[];
 await run('loadConversations()');
 assert.equal(context.state.conversations.some(c=>c.id==='old'),false);
});
test('workspace deletion failure is visible and keeps the conversation',async()=>{
 const root={getDirectoryHandle:async()=>{throw new DOMException('Permission denied','NotAllowedError');}};
 const {context,records,notices,run}=setup(root);
 await run('saveConversations()');await run("deleteConv('old')");
 assert.equal(records.has('old'),true);
 assert.equal(context.state.conversations.some(c=>c.id==='old'),true);
 assert.match(notices.at(-1).text,/Delete failed.*Workspace file/);
 assert.equal(notices.at(-1).kind,'err');
});
test('deleted workspace files and stale index entries cannot restore a conversation',async()=>{
 const files=new Map([['old.json',JSON.stringify({id:'old',messages:[]})],['keep.json',JSON.stringify({id:'keep',messages:[]})],
  ['index.json',JSON.stringify({activeId:'old',conversations:[{id:'old'},{id:'keep'}]})]]);
 const {context,run}=setup(workspace(files));await run('saveConversations()');await run("deleteConv('old')");
 assert.equal(files.has('old.json'),false);
 assert.equal(await run('loadConversationsFromWorkspace()'),true);
 assert.deepEqual(Array.from(context.state.conversations,c=>c.id),['keep']);
 // An obsolete index on another browser also cannot create a ghost for a missing file.
 await run('deletedConvIds.clear();loadConversationsFromWorkspace()');
 assert.deepEqual(Array.from(context.state.conversations,c=>c.id),['keep']);
});
test('a queued database save completes before permanent deletion',async()=>{
 const {context,records,run}=setup();let release,entered;
 const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 context.dbSet=async(_,c)=>{if(c.id==='old'){entered();await gate;}records.set(c.id,structuredClone(c));return true;};
 const saving=run('saveConversations()');await started;
 const deleting=run("deleteConv('old')");release();await Promise.all([saving,deleting]);
 assert.equal(records.has('old'),false);
 await run('saveConversations()');assert.equal(records.has('old'),false);
});
