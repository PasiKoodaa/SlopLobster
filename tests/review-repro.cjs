
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const F=require('../src/features-core.js'),H=require('../src/harness-runtime.js');
const source=fs.readFileSync(require.resolve('./features.test.cjs'),'utf8');
const from=source.indexOf('function uiContext('),to=source.indexOf("\ntest(",from);
const uiContext=eval('('+source.slice(from,to).trim()+')');
(async()=>{
 const c=uiContext({_sessionTotalOut:0});let launched;
 const html=fs.readFileSync(require.resolve('../SlopLobster.html'),'utf8').replace(/\r\n/g,'\n');
 const start=html.indexOf('    async function switchConv('),end=html.indexOf('    function ',start+10);
 // Use the real early missing-conversation path and stub the preceding workspace flush.
 c.saveConvToWorkspace=async()=>true;c.clearTimeout=()=>{};c._convSaveTimer=null;
 const body=html.slice(start,html.indexOf('      // If conversation was loaded',start))+'    }';
 vm.runInContext(body,c);
 c.agentLoop=async()=>{launched={convId:c.state.activeConvId,messages:JSON.stringify(c.state.messages)};};
 vm.runInContext("harnessFeatureState.workspace='no-workspace';harnessFeatureState.prefs.queue=true;harnessFeatureState.data.queue=[{id:'queued',convId:'deleted-conversation',status:'pending',text:'Original queued goal',criteria:[],maxIters:3,tokenBudget:500,answer:'Answer intended for deleted task'}]",c);
 await c.startHarnessQueue();
 assert.equal(launched,undefined);assert.equal(c.harnessFeatureState.data.queue[0].status,'blocked');assert.equal(c.state.messages.length,1);
 console.log('PASS: missing queued conversation is blocked without launching or changing the active conversation.');

 const evidence=uiContext();
 await evidence.beforeHarnessRun();
 evidence.recordHarnessTool('run_tests',{command:'npm test'},{status:'ok',exitCode:0,output:'passed'},'check');
 evidence.recordHarnessTool('execute_command',{command:'python rewrite_source.py'},{status:'ok',exitCode:0,output:'source rewritten'},'mutation');
 evidence.harnessModelFinished();await evidence.afterHarnessRun();
 assert.equal(evidence.harnessFeatureState.data.evidence[0].outcome,'needs_review');
 console.log('PASS: shell mutation invalidates the preceding verification.');

 const storage=uiContext({dbSet:async()=>false});
 Object.assign(storage.harnessFeatureState.prefs,{isolation:false,evidence:false,recipes:false,queue:false,knowledge:false,autoRetrieve:false});
 assert.equal(await storage.beforeHarnessRun(),true);
 console.log('PASS: a normal run with all features disabled does not require feature storage.');

 const scope=uiContext();
 scope.state.dirHandle={name:'B',isSameEntry:async()=>false};
 scope.harnessFeatureState.prefs.projectRoot='C:/project-A';
 scope.harnessFeatureState.workspace='C:/project-A';
 scope.harnessFeatureState.data.knowledge=[{workspace:'C:/project-A',title:'A secret project decision',text:'A decision'}];
 await scope.ensureFeatureWorkspace();
 assert.notEqual(scope.harnessFeatureState.workspace,'C:/project-A');
 assert.equal(scope.harnessFeatureState.data.knowledge.length,0);
 assert.equal(scope.harnessFeatureState.prefs.projectRoot,'');
 console.log('PASS: opening project B stops using project A feature data and path.');
})().catch(error=>{console.error(error);process.exitCode=1;});
