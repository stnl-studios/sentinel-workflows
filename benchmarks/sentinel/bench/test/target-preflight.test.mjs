import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{fileURLToPath}from'node:url';import{digest,sha256}from'../core.mjs';import{REQUIRED_TARGET_CAPABILITIES,qualificationDigest}from'../qualification.mjs';import{targetPreflight}from'../target-preflight.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../temp/target-preflight-tests');
function setup(t,change={}){fs.mkdirSync(root,{recursive:true});const base=fs.mkdtempSync(path.join(root,'test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const sourceRoot=path.join(base,'source');fs.mkdirSync(sourceRoot);const profile={schemaVersion:1,id:'test',cli:'/fake/codex',cliVersion:'0.163.0',sentinelRevision:'a'.repeat(40),roles:Object.fromEntries(['coordinator','plan_approver','plan_review','execute_check','formal_validate'].map(role=>[role,{model:'test-model',effort:'high'}])),repetitions:1,concurrency:1,limits:{campaignMs:100,caseMs:100,turnMs:100,maxTurns:1,maxNoProgress:1,maxReportedTokens:100}};const identity={profile:digest(profile),source:'1'.repeat(64),engine:'2'.repeat(64),fixture:'3'.repeat(64),cliVersion:profile.cliVersion,sentinelRevision:profile.sentinelRevision,scenarioOracle:'4'.repeat(64),contextPolicy:'stage',adapterProtocol:'app-server-v1'},harnessIdentity={engine:identity.engine,fixture:identity.fixture,cliVersion:identity.cliVersion,scenarioOracle:identity.scenarioOracle,contextPolicy:qualificationDigest(identity.contextPolicy),adapterProtocol:qualificationDigest(identity.adapterProtocol)};const calls=[],acks=new Map();let n=0;const services={verifySource:async()=>({revision:profile.sentinelRevision,tree:'b'.repeat(40),sha256TreeDigest:identity.source}),runCommand:async()=> 'codex-cli 0.163.0\n',inspectRuntime:async()=>({files:[],contractDigest:'7'.repeat(64)}),schemaCapabilities:async()=>({capabilities:REQUIRED_TARGET_CAPABILITIES,files:[]}),createServer:({cwd,tmpDir})=>({start:async()=>calls.push('initialize'),request:async (method,params)=>{calls.push(method);if(method==='thread/read'){assert.equal(params.includeTurns,false);if(change.empty)throw Error('thread not materialized');return{thread:{id:params.threadId}}}return{data:change.models??[{model:'test-model',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}},startThread:async p=>{calls.push('thread/start');const id='thread-'+(++n),ack={thread:{id},model:p.model,reasoningEffort:p.config.model_reasoning_effort,approvalPolicy:'never',cwd,sandbox:p.sandbox==='read-only'?{type:'readOnly',networkAccess:false}:{type:'workspaceWrite',networkAccess:false,excludeSlashTmp:true,writableRoots:[cwd,tmpDir]}};change.ack?.(ack);acks.set(id,ack);return ack},readThread:async id=>{calls.push('thread/read');if(change.empty)throw Error('thread not materialized');return{thread:{id}}},resumeThread:async p=>{calls.push('thread/resume');if(change.resumeError)throw change.resumeError(p.threadId);return acks.get(p.threadId)},stop:async()=>calls.push('stop')}),...change.services};return{base,evidenceDir:path.join(base,'evidence'),sourceRoot,repository:base,profile,identity,harnessIdentity,services,calls}}
test('fake zero-turn preflight emits only SIMULATED proofs with verifiable refs',async t=>{const f=setup(t),r=await targetPreflight(f);assert.equal(r.scope,'SIMULATED');assert.equal(r.modelTurnsStarted,0);assert.equal(f.calls.filter(x=>x==='thread/start').length,2);assert.ok(!f.calls.includes('turn/start'));for(const c of Object.values(r.targetProof.checks)){assert.equal(c.status,'SIMULATED');assert.equal(sha256(fs.readFileSync(path.join(f.base,c.proof.ref))),c.proof.sha256)}assert.equal(fs.existsSync(path.join(f.evidenceDir,'preflight-temp/home/auth.json')),false)});
test('actual network access or model drift fails closed',async t=>{for(const ack of [x=>x.sandbox.networkAccess=true,x=>x.model='other']){const f=setup(t,{ack});await assert.rejects(targetPreflight(f),/MISMATCH/);assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidenceDir,'failure.json'))).status,'BLOCKED')}});
test('system tmp writable or unbounded extra root rejects',async t=>{for(const ack of [x=>{if(x.sandbox.type==='workspaceWrite')x.sandbox.excludeSlashTmp=false},x=>{if(x.sandbox.type==='workspaceWrite')x.sandbox.writableRoots=['/tmp']}])await assert.rejects(targetPreflight(setup(t,{ack})),/TMP|ROOT/)});
test('missing advertised protocol or model effort blocks before thread',async t=>{const f=setup(t,{services:{schemaCapabilities:async()=>({capabilities:['initialize']})}});await assert.rejects(targetPreflight(f),/PROTOCOL/);assert.equal(f.calls.length,0)});
test('unmaterialized empty thread explicitly limited without a model turn',async t=>{const f=setup(t,{empty:true}),r=await targetPreflight(f);assert.equal(r.modelTurnsStarted,0);const p=JSON.parse(fs.readFileSync(path.join(f.evidenceDir,'protocolCompatibility.json')));assert.ok(p.history.every(h=>h.read==='empty-thread-not-materialized'));assert.ok(!f.calls.includes('thread/resume'))});
test('preflight never overwrites prior evidence namespace',async t=>{const f=setup(t);await targetPreflight(f);await assert.rejects(targetPreflight(f),/ALREADY_EXISTS/)});
test('mismatched identity refuses before allocating own home',async t=>{const f=setup(t);f.identity.profile='0'.repeat(64);await assert.rejects(targetPreflight(f),/IDENTITY/);assert.equal(fs.existsSync(f.evidenceDir),false)});

test('zero-turn thread metadata explicitly omits list_turns includeTurns',async t=>{const f=setup(t);await targetPreflight(f);assert.ok(f.calls.includes('thread/read'));assert.ok(f.calls.includes('thread/resume'))});

test('exact empty-rollout resume records confirmed metadata separately',async t=>{
 const f=setup(t,{resumeError:id=>Object.assign(Error('no rollout found for thread id '+id),{code:-32600})});
 await targetPreflight(f);
 const p=JSON.parse(fs.readFileSync(path.join(f.evidenceDir,'protocolCompatibility.json')));
 assert.ok(p.history.every(h=>h.read==='confirmed'&&h.resume==='unavailable-empty-thread'&&h.resumeError.code===-32600));
 const security=JSON.parse(fs.readFileSync(path.join(f.evidenceDir,'securityContext.json')));
 assert.ok(security.observed.every(o=>o.phase==='thread/start'));
 assert.ok(!f.calls.includes('turn/start'));
});
test('other resume codes, identities, and messages remain blocking',async t=>{
 for(const resumeError of [
 id=>Object.assign(Error('no rollout found for thread id '+id),{code:-32601}),
 ()=>Object.assign(Error('no rollout found for thread id other-thread'),{code:-32600}),
 id=>Object.assign(Error('no rollout found for thread id '+id+' unexpected'),{code:-32600}),
 ()=>Object.assign(Error('thread not found'),{code:-32600})
 ]){
  const f=setup(t,{resumeError});
  await assert.rejects(targetPreflight(f));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.evidenceDir,'failure.json'))).status,'BLOCKED');
 }
});

test('measured harness policy/oracle bindings reject drift or missing fields before I/O',async t=>{
 for(const key of ['scenarioOracle','contextPolicy','adapterProtocol']){
  for(const missing of [false,true]){
   const f=setup(t);if(missing)delete f.identity[key];else f.identity[key]='changed';
   await assert.rejects(targetPreflight(f),/IDENTITY/);assert.equal(fs.existsSync(f.evidenceDir),false);assert.equal(f.calls.length,0);
  }
 }
});
test('legitimate changed profile with supported extra role keeps harness binding',async t=>{
 const f=setup(t);f.profile.id='new-target';f.profile.roles.planner_special={model:'test-model',effort:'high'};f.identity.profile=digest(f.profile);
 const r=await targetPreflight(f);assert.equal(r.targetProof.checks.modelSupport.roles.length,6);assert.equal(r.scope,'SIMULATED');
});

test('selected case overrides validate effective models and readOnly logical approver',async t=>{
 const f=setup(t,{models:[{model:'case-model',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}]});
 f.profile.suiteCases=['import'];
 f.profile.caseOverrides={import:{roles:Object.fromEntries(Object.keys(f.profile.roles).map(role=>[role,{model:'case-model',effort:'medium'}]))}};
 f.identity.profile=digest(f.profile);
 const r=await targetPreflight(f),roles=r.targetProof.checks.modelSupport.roles;
 assert.equal(roles.length,5);assert.ok(roles.every(r=>r.role==='import__'+r.logicalRole&&r.caseId==='import'&&r.model==='case-model'));
 const security=JSON.parse(fs.readFileSync(path.join(f.evidenceDir,'securityContext.json')));
 const a=security.observed.find(o=>o.roles.includes('import__plan_approver'));assert.equal(a.sandbox.type,'readOnly');
});
test('unsupported override cannot hide behind supported globals',async t=>{
 const f=setup(t);f.profile.suiteCases=['rename','import'];f.profile.caseOverrides={import:{roles:{coordinator:{model:'missing',effort:'medium'}}}};f.identity.profile=digest(f.profile);
 await assert.rejects(targetPreflight(f),/MODEL_OR_EFFORT_UNAVAILABLE: import__coordinator/);
 assert.ok(!f.calls.includes('thread/start'));
});
