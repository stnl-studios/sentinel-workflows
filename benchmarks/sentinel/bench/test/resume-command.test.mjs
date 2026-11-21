import{resolveCaseProfile}from'../case-profile.mjs';
import{spawnSync}from'node:child_process';import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{fileURLToPath}from'node:url';import{digest,sha256,treeHashes}from'../core.mjs';import{resumeCampaignCase}from'../resume-command.mjs';import{CASES}from'../scenarios.mjs';
const temp=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../temp/resume-command-tests');const save=(p,v)=>fs.writeFileSync(p,JSON.stringify(v));
function setup(t){fs.mkdirSync(temp,{recursive:true});const base=fs.mkdtempSync(path.join(temp,'test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));const dir=path.join(base,'evidence/campaigns/test'),ev=path.join(dir,'rename-1'),work=path.join(base,'work/campaigns/test/rename-1'),home=path.join(work,'home'),codexHome=path.join(home,'.codex'),workspace=path.join(work,'workspace');for(const d of [ev,workspace,path.join(work,'temp'),path.join(codexHome,'skills'),path.join(codexHome,'agents'),path.join(base,'source'),path.join(base,'fixtures/todo'),path.join(base,'bench'),path.join(base,'bench/cases')])fs.mkdirSync(d,{recursive:true});const cli=path.join(base,'fake-cli');fs.writeFileSync(cli,'#!/bin/sh\nprintf "codex-cli 0.163.0\\n"\n',{mode:0o755});const profile={stageRoles:{},schemaVersion:1,id:'test',cli,cliVersion:'0.163.0',sentinelRevision:'a'.repeat(40),roles:Object.fromEntries(['coordinator','plan_approver','plan_review','execute_check','formal_validate'].map(r=>[r,{model:'test',effort:'high'}])),limits:{campaignMs:600000,caseMs:600000,turnMs:60000,maxTurns:20,maxNoProgress:2,maxReportedTokens:100000},repetitions:1,concurrency:1};const contractPath=path.join(base,'source/agents/codex/.codex/agents/stnl_validation_runner.toml');fs.mkdirSync(path.dirname(contractPath),{recursive:true});fs.writeFileSync(contractPath,'Synthetic runner contract');const runnerContract={path:contractPath,sha256:sha256(fs.readFileSync(contractPath)),sourceRevision:profile.sentinelRevision,selection:'immutable-candidate-distribution-not-personal-installation'};const installed={skills:treeHashes(path.join(codexHome,'skills')),agents:treeHashes(path.join(codexHome,'agents'))};fs.writeFileSync(path.join(base,'bench/scenarios.mjs'),'export const CASES='+JSON.stringify(CASES));fs.cpSync(path.join(base,'bench'),path.join(dir,'engine-snapshot'),{recursive:true});const identity={scenarioOracle:digest({cases:CASES,oracles:treeHashes(path.join(base,'bench/cases'))}),source:digest(treeHashes(path.join(base,'source'))),fixture:digest(treeHashes(path.join(base,'fixtures/todo'))),profile:digest(profile),engine:digest(treeHashes(path.join(base,'bench')))};const deadline=Date.now()+600000,campaign={id:'test',profile,identity,deadline,planned:1,results:[]};const manifest={trajectory:structuredClone(CASES.find(c=>c.id==='rename').trajectory),runnerContract,sourceRoot:path.join(base,'source'),engineRoot:path.join(dir,'engine-snapshot'),campaignId:'test',caseId:'rename',repetition:1,workspace,home,codexHome,tmpDir:path.join(work,'temp'),evidence:ev,profile,profileDigest:digest(profile),sourceProof:{revision:profile.sentinelRevision,proof:'git-tree-and-blob-verification',sha256TreeDigest:identity.source},fixtureDigest:identity.fixture,installed,installedDigest:digest(installed),cliVersion:'codex-cli 0.163.0'};const state={status:'BLOCKED',startedAt:Date.now(),deadline,campaignDeadline:deadline,turns:1,completedTurns:1,unchanged:0,pending:null,pendingEffect:null,threadId:'p',roots:[{threadId:'p',role:'coordinator'}],plan:{phase:'REVIEWED'}};save(path.join(dir,'campaign.json'),campaign);save(path.join(dir,'summary.json'),campaign);save(path.join(ev,'manifest.json'),manifest);save(path.join(ev,'checkpoint.json'),state);save(path.join(ev,'result.json'),{status:'BLOCKED'});fs.writeFileSync(path.join(workspace,'OS.md'),'Synthetic OS');return{base,dir,ev,manifest,state,writeState:()=>save(path.join(ev,'checkpoint.json'),state)}}
const noPending=async()=>({decision:{outcome:'NO_PENDING',nextStage:'EXECUTE_SLICE'}});
test('NO_PENDING safe next operation resumes preserving original result and denominator',async t=>{const f=setup(t);let args;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async x=>(args=x,{status:'PASS',caseId:'rename',repetition:1})});assert.equal(r.outcome,'RESUMED');assert.equal(args.resumeState.deadline,f.state.deadline);assert.equal(JSON.parse(fs.readFileSync(path.join(f.ev,'result.json'))).status,'BLOCKED');const s=JSON.parse(fs.readFileSync(path.join(f.dir,'summary.json')));assert.equal(s.planned,1);assert.equal(s.results.length,0);assert.equal(s.recoveries.length,1)});
test('active lock never touched',async t=>{const f=setup(t),p=path.join(f.dir,'.lock'),owner={pid:process.pid,id:'active'};save(p,owner);const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1'});assert.equal(r.reason,'CAMPAIGN_LOCK_ACTIVE');assert.deepEqual(JSON.parse(fs.readFileSync(p)),owner)});
test('pending effect and AUTHOR block without executing',async t=>{for(const kind of ['effect','author']){const f=setup(t);if(kind==='effect')f.state.pendingEffect={index:1};else f.state.plan.phase='AUTHOR';f.writeState();let calls=0;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async()=>calls++});assert.equal(r.outcome,'BLOCKED');assert.equal(calls,0)}});
test('profile/source/installed drift fail closed',async t=>{for(const where of ['source','skills']){const f=setup(t);fs.writeFileSync(where==='source'?path.join(f.base,'source/changed'):path.join(f.manifest.codexHome,'skills/changed'),'drift');const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending});assert.match(r.reason,/DRIFT/)}});
test('engine drift only diagnostic',async t=>{const f=setup(t);fs.writeFileSync(path.join(f.base,'bench/changed'),'new');const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async()=>({status:'PASS'})});assert.equal(r.engineDrift,true);assert.equal(r.measurement,'diagnostic')});
test('SETTLE needs exact proof, records receipt before clearing',async t=>{const f=setup(t),before={specPath:'spec',status:'before'},after={specPath:'spec',status:'after'};f.state.pending={index:1,stage:'EXECUTE_SLICE',threadId:'p',turnId:'turn',before:'a'.repeat(64),authorityBefore:before};f.state.completedTurns=0;f.writeState();const providerTurn={threadId:'p',id:'turn',status:'completed'},proof={attempt:1,stage:'EXECUTE_SLICE',threadId:'p',turnId:'turn',beforeFingerprint:'a'.repeat(64),authorityDigest:digest(after),providerTurnDigest:digest(providerTurn),beforeAuthorityDigest:digest(before),deadline:f.state.deadline,nextStage:'VALIDATE_SLICE'};const inspect=async()=>({authority:after,providerTurn,decision:{outcome:'SETTLE',nextStage:'VALIDATE_SLICE',proof,proofDigest:digest(proof)}});let state;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect,execute:async x=>(state=x.resumeState,{status:'PASS'})});assert.equal(r.outcome,'RESUMED');assert.equal(state.pending,null);assert.equal(state.settledAttempts.length,1);assert.ok(fs.existsSync(state.settledAttempts[0].receipt));assert.equal(state.trajectorySnapshots[0].productBefore,null);assert.equal(state.trajectorySnapshots[0].trajectoryRecovery.status,'INCOMPLETE')});
test('invalid settlement proof preserves pending',async t=>{const f=setup(t);f.state.pending={index:1,stage:'EXECUTE_SLICE'};f.writeState();const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>({decision:{outcome:'SETTLE',nextStage:'VALIDATE_SLICE',proof:{},proofDigest:'bad'}})});assert.equal(r.reason,'SETTLEMENT_PROOF_MISMATCH');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.ev,'checkpoint.json'))).pending,f.state.pending)});

test('proved-dead lock is archived, not discarded',async t=>{const f=setup(t),child=spawnSync(process.execPath,['-e','process.exit(0)']);assert.ok(child.pid);save(path.join(f.dir,'.lock'),{pid:child.pid,id:'dead'});const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async()=>({status:'PASS'})});assert.equal(r.outcome,'RESUMED');assert.equal(JSON.parse(fs.readFileSync(r.staleLockArchive)).id,'dead');assert.equal(fs.existsSync(path.join(f.dir,'.lock')),false)});
function addRunner(f){const official='name = "runner"\nmodel = "original"\nmodel_reasoning_effort = "medium"\ndeveloper_instructions = "Keep exact contract"\n';const src=path.join(f.base,'source/agents/codex/.codex/agents');fs.mkdirSync(src,{recursive:true});fs.writeFileSync(path.join(src,'stnl_validation_runner.toml'),official);f.manifest.runnerContract.sha256=sha256(Buffer.from(official));f.manifest.profile.roles.execute_check={model:'execute-model',effort:'medium'};f.manifest.profile.roles.formal_validate={model:'validate-model',effort:'high'};const render=role=>official.replace(/^model = .*$/m,'model = '+JSON.stringify(f.manifest.profile.roles[role].model)).replace(/^model_reasoning_effort = .*$/m,'model_reasoning_effort = '+JSON.stringify(f.manifest.profile.roles[role].effort));const installed=path.join(f.manifest.codexHome,'agents/stnl_validation_runner.toml');fs.writeFileSync(installed,render('execute_check'));f.manifest.installed={skills:treeHashes(path.join(f.manifest.codexHome,'skills')),agents:treeHashes(path.join(f.manifest.codexHome,'agents'))};f.manifest.installedDigest=digest(f.manifest.installed);f.manifest.profileDigest=digest(f.manifest.profile);f.manifest.sourceProof.sha256TreeDigest=digest(treeHashes(path.join(f.base,'source')));save(path.join(f.ev,'manifest.json'),f.manifest);for(const name of ['campaign.json','summary.json']){const c=JSON.parse(fs.readFileSync(path.join(f.dir,name)));c.profile=f.manifest.profile;c.identity.profile=f.manifest.profileDigest;c.identity.source=f.manifest.sourceProof.sha256TreeDigest;save(path.join(f.dir,name),c)}return{installed,render};}
test('authorized execute to formal runner profile transition accepted byte-exact',async t=>{const f=setup(t),runner=addRunner(f);fs.writeFileSync(runner.installed,runner.render('formal_validate'));const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async()=>({status:'PASS'})});assert.equal(r.outcome,'RESUMED')});
test('runner developer instructions tampering rejected even with authorized model',async t=>{const f=setup(t),runner=addRunner(f);fs.writeFileSync(runner.installed,runner.render('formal_validate').replace('Keep exact contract','Bypass contract'));const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async()=>({status:'PASS'})});assert.equal(r.reason,'INSTALLED_RUNNER_UNAUTHORIZED_BYTES')});
test('mixing authorized role model with other role effort is not authorized',async t=>{const f=setup(t),runner=addRunner(f);fs.writeFileSync(runner.installed,runner.render('execute_check').replace('"medium"','"high"'));const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending});assert.equal(r.reason,'INSTALLED_RUNNER_UNAUTHORIZED_BYTES')});

test('scenario oracle file drift blocks before inspection or any resumed execution',async t=>{const f=setup(t);fs.writeFileSync(path.join(f.dir,'engine-snapshot/cases/changed-oracle.mjs'),'changed');let inspections=0,executions=0;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>{inspections++;return noPending();},execute:async()=>{executions++;return{status:'PASS'};}});assert.equal(r.reason,'SCENARIO_ORACLE_DRIFT');assert.equal(inspections,0);assert.equal(executions,0);});
test('missing scenario oracle identity is not silently grandfathered into resume',async t=>{const f=setup(t),file=path.join(f.dir,'campaign.json'),campaign=JSON.parse(fs.readFileSync(file));delete campaign.identity.scenarioOracle;save(file,campaign);const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async()=>{throw Error('must not execute');}});assert.equal(r.reason,'SCENARIO_ORACLE_IDENTITY_MISSING');});
test('resume refuses foreign or modified engine snapshots before inspecting',async t=>{
 for(const mode of ['path','bytes']){
 const f=setup(t);
 if(mode==='path'){f.manifest.engineRoot=path.join(f.base,'bench');save(path.join(f.ev,'manifest.json'),f.manifest);}
 else fs.writeFileSync(path.join(f.dir,'engine-snapshot/scenarios.mjs'),'throw Error("must not import changed code")');
 let calls=0;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>{calls++;return noPending();}});
 assert.equal(r.reason,mode==='path'?'ENGINE_SNAPSHOT_PATH_MISMATCH':'ENGINE_SNAPSHOT_DRIFT');assert.equal(calls,0);
 }
});

test('runner contract descriptor fails closed before inspector for missing, path, hash, revision and selection',async t=>{
 for(const mode of ['missing','path','alias','hash','revision','selection']){
 const f=setup(t),contract=f.manifest.runnerContract;
 if(mode==='missing')delete f.manifest.runnerContract;
 if(mode==='path')contract.path=path.join(f.base,'unselected-contract.toml');
 if(mode==='alias')contract.path=path.dirname(contract.path)+'/./'+path.basename(contract.path);
 if(mode==='hash')contract.sha256='b'.repeat(64);
 if(mode==='revision')contract.sourceRevision='b'.repeat(40);
 if(mode==='selection')contract.selection='personal-installation';
 save(path.join(f.ev,'manifest.json'),f.manifest);
 let calls=0;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>{calls++;return noPending();},execute:async()=>{calls++;return{status:'PASS'};}});
 const reason={missing:'DESCRIPTOR_MISSING',path:'PATH_MISMATCH',alias:'PATH_MISMATCH',hash:'HASH_MISMATCH',revision:'REVISION_MISMATCH',selection:'SELECTION_MISMATCH'}[mode];
 assert.equal(r.reason,'RUNNER_CONTRACT_'+reason);assert.equal(calls,0);
 }
});
test('actual candidate runner bytes cannot be changed while retaining original contract descriptor',async t=>{
 const f=setup(t);fs.appendFileSync(f.manifest.runnerContract.path,' changed');
 // Even a rewritten aggregate source claim must not bypass the independent contract binding.
 const source=digest(treeHashes(f.manifest.sourceRoot));f.manifest.sourceProof.sha256TreeDigest=source;save(path.join(f.ev,'manifest.json'),f.manifest);
 const file=path.join(f.dir,'campaign.json'),c=JSON.parse(fs.readFileSync(file));c.identity.source=source;save(file,c);
 let calls=0;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>{calls++;return noPending();}});
 assert.equal(r.reason,'RUNNER_CONTRACT_HASH_MISMATCH');assert.equal(calls,0);
});


test('resume binds exact trajectory from immutable scenario snapshot without legacy fallback',async t=>{
 for(const mode of ['missing','reduced','added-field','description']){
 const f=setup(t);
 if(mode==='missing')delete f.manifest.trajectory;
 if(mode==='reduced')f.manifest.trajectory.minSlices=0;
 if(mode==='added-field')f.manifest.trajectory.optional=true;
 if(mode==='description')f.manifest.trajectory.description='Different approved operational scope';
 save(path.join(f.ev,'manifest.json'),f.manifest);
 let calls=0;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>{calls++;return noPending();},execute:async()=>{calls++;return {status:'PASS'};}});
 assert.equal(r.reason,'TRAJECTORY_CONTRACT_MISMATCH',mode);assert.equal(calls,0);
 }
});

test('SETTLE restores persisted trajectory and handles snapshot crash gap without duplication',async t=>{
 for(const mode of ['new','file-exists','state-exists','conflict']){
 const f=setup(t),before={current:{exitCode:0,output:{normalHandoff:{slice:'slice-01'}}}},after={current:{exitCode:0,output:{state:'IMPLEMENTED_AWAITING_VALIDATION'}}};
 const pending={index:1,stage:'EXECUTE_SLICE',threadId:'p',turnId:'turn',before:'a'.repeat(64),authorityBefore:before,trajectoryBefore:{slice:'slice-01',productBefore:{'src/example.mjs':'c'.repeat(64)}}};
 f.state.pending=pending;f.state.completedTurns=0;
 const snapshot={index:1,stage:pending.stage,slice:'slice-01',threadId:'p',turnId:'turn',beforeAuthority:before,afterAuthority:after,productBefore:pending.trajectoryBefore.productBefore,productAfter:{}};
 const snapshotFile=path.join(f.ev,'turn-1-authority-after.json');
 if(mode!=='new')save(snapshotFile,mode==='conflict'?{...snapshot,turnId:'different'}:snapshot);
 if(mode==='state-exists')f.state.trajectorySnapshots=[snapshot];
 f.writeState();
 const providerTurn={threadId:'p',id:'turn',status:'completed'},proof={attempt:1,stage:pending.stage,threadId:'p',turnId:'turn',beforeFingerprint:pending.before,authorityDigest:digest(after),providerTurnDigest:digest(providerTurn),beforeAuthorityDigest:digest(before),deadline:f.state.deadline,nextStage:'VALIDATE_SLICE'};
 let resumed;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>({authority:after,providerTurn,decision:{outcome:'SETTLE',nextStage:'VALIDATE_SLICE',proof,proofDigest:digest(proof)}}),execute:async x=>{resumed=x.resumeState;return{status:'PASS'};}});
 if(mode==='conflict'){assert.equal(r.reason,'RECOVERY_TRAJECTORY_SNAPSHOT_MISMATCH');assert.ok(JSON.parse(fs.readFileSync(path.join(f.ev,'checkpoint.json'))).pending);assert.equal(resumed,undefined);}
 else{assert.equal(r.outcome,'RESUMED');assert.deepEqual(resumed.trajectorySnapshots,[snapshot]);assert.deepEqual(JSON.parse(fs.readFileSync(snapshotFile)),snapshot);assert.equal(resumed.pending,null);}
 }
});

test('case-specific effective profile resumes, but an override drift cannot silently replace it',async t=>{
 const f=setup(t);const campaign=JSON.parse(fs.readFileSync(path.join(f.dir,'campaign.json')));
 campaign.profile.caseOverrides={rename:{roles:{routine:{model:'test-routine',effort:'medium'}},stageRoles:{EXECUTE_SLICE:'routine'}}};
 campaign.identity.profile=digest(campaign.profile);const effective=resolveCaseProfile(campaign.profile,'rename');campaign.caseProfiles={rename:{profile:effective,profileDigest:digest(effective)}};
 Object.assign(f.manifest,{profile:effective,profileDigest:digest(effective),requestedProfile:campaign.profile,requestedProfileDigest:campaign.identity.profile});
 for(const name of ['campaign.json','summary.json'])save(path.join(f.dir,name),campaign);save(path.join(f.ev,'manifest.json'),f.manifest);
 let seen;const result=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async x=>(seen=x.manifest.profile,{status:'PASS'})});
 assert.equal(result.outcome,'RESUMED');assert.equal(seen.roles.routine.model,'test-routine');assert.equal(seen.stageRoles.EXECUTE_SLICE,'routine');
 f.manifest.profile.roles.routine.effort='high';f.manifest.profileDigest=digest(f.manifest.profile);save(path.join(f.ev,'manifest.json'),f.manifest);
 let called=false;const blocked=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>{called=true;return noPending()},execute:async()=>({status:'PASS'})});assert.equal(blocked.reason,'PROFILE_DRIFT');assert.equal(called,false);
});

test('SIMULATED v5 resume preserves deadline and original result above former campaign token cap',async t=>{
 for(const observe of [false,true]){
  const f=setup(t),campaign=JSON.parse(fs.readFileSync(path.join(f.dir,'campaign.json')));campaign.results=[{caseId:'rename',repetition:1,status:'BLOCKED',observedTokens:60000001}];
  if(observe){campaign.caseIds=['rename'];campaign.repetitions=1;delete campaign.profile.limits.maxReportedTokens;delete campaign.profile.limits.maxCampaignReportedTokens;campaign.profile.limits.tokenPolicy='observe-only';}
  campaign.identity.profile=digest(campaign.profile);f.manifest.profile=resolveCaseProfile(campaign.profile,'rename');f.manifest.profileDigest=digest(f.manifest.profile);
  for(const name of ['campaign.json','summary.json'])save(path.join(f.dir,name),campaign);save(path.join(f.ev,'manifest.json'),f.manifest);
  let calls=0;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async x=>{calls++;assert.equal(x.resumeState.deadline,f.state.deadline);assert.equal(x.campaignBudget.snapshot().knownReportedTokens,60000001);assert.equal(x.campaignBudget.snapshot().limit,null);return {status:'PASS'};}});
  assert.equal(r.outcome,observe?'RESUMED':'BLOCKED');assert.equal(calls,observe?1:0);if(!observe)assert.equal(r.reason,'CAMPAIGN_OBSERVED_TOKEN_LIMIT');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.ev,'result.json'))).status,'BLOCKED');
 }
});

function observeFixture(f,update){
 const c=JSON.parse(fs.readFileSync(path.join(f.dir,'campaign.json')));
 c.caseIds=['rename','query','import'];c.repetitions=2;c.planned=6;
 delete c.profile.limits.maxReportedTokens;delete c.profile.limits.maxCampaignReportedTokens;c.profile.limits.tokenPolicy='observe-only';
 c.identity.profile=digest(c.profile);f.manifest.profile=resolveCaseProfile(c.profile,'rename');f.manifest.profileDigest=digest(f.manifest.profile);
 update(c);
 for(const name of ['campaign.json','summary.json'])save(path.join(f.dir,name),c);
 save(path.join(f.ev,'manifest.json'),f.manifest);
}
test('SIMULATED observe-only resume restores latest cumulative samples across all original cells',async t=>{
 const f=setup(t),sample=(caseId,repetition,value,usageScope='reported-responses-only')=>({caseId,repetition,usageScope,observedTokens:value,tokenMetrics:{totalTokens:{value,complete:value!==null}}});
 observeFixture(f,c=>{
  c.results=[sample('rename',1,10),sample('query',1,20),sample('import',1,7),sample('rename',2,50)];
  c.tokenBudget={cells:{'rename-1':{latest:null,lastKnown:10,complete:false},'query-1':{latest:20,lastKnown:20,complete:true},'import-1':{latest:7,lastKnown:7,complete:true},'rename-2':{latest:50,lastKnown:50,complete:true}}};
  c.recoveries=[{cell:'query-1',result:sample('query',1,30)},{cell:'query-1',result:sample('query',1,33)},{cell:'query-1',result:sample('query',1,null)},{cell:'import-1',result:sample('import',1,0)},{cell:'rename-2',result:sample('rename',2,100,'scope-unproven')},{cell:'query-2',result:sample('query',2,900)}];
  for(const r of c.recoveries)r.result.effectiveProfileDigest=digest(resolveCaseProfile(c.profile,r.result.caseId));
  c.recoveries.push({cell:'rename-1',result:{...sample('rename',1,999),effectiveProfileDigest:'drift'}});
 });
 let seed;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async x=>(seed=x.campaignBudget.snapshot(),{status:'PASS'})});
 assert.equal(r.outcome,'RESUMED');assert.equal(seed.limit,null);assert.equal(seed.knownReportedTokens,93);
 assert.deepEqual(seed.cells,{'rename-1':{latest:null,lastKnown:10,complete:false},'query-1':{latest:null,lastKnown:33,complete:false},'import-1':{latest:0,lastKnown:0,complete:true},'rename-2':{latest:null,lastKnown:50,complete:false}});
 assert.deepEqual(seed.missingReports,['rename-1','query-1','rename-2']);assert.equal(seed.stopReason,null);
});
test('SIMULATED v4 stored identity cannot resume with v5 token policy',async t=>{
 const f=setup(t),c=JSON.parse(fs.readFileSync(path.join(f.dir,'campaign.json')));
 delete c.profile.limits.maxReportedTokens;delete c.profile.limits.maxCampaignReportedTokens;c.profile.limits.tokenPolicy='observe-only';
 save(path.join(f.dir,'campaign.json'),c);
 let called=false;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:async()=>{called=true;return noPending()},execute:async()=>{called=true;return {status:'PASS'}}});
 assert.equal(r.reason,'PROFILE_DRIFT');assert.equal(called,false);
});

test('SIMULATED malformed summary telemetry degrades to unknown before valid SETTLE',async t=>{
 const f=setup(t),sample=(caseId,repetition,n)=>({caseId,repetition,observedTokens:n});
 observeFixture(f,c=>{
  c.caseIds=['rename','query'];c.repetitions=1;c.planned=2;
  c.results=[null,sample('rename',1,17),sample('query',1,11),sample('query',1,12),sample('import',1,900),sample('rename',2,700)];
  c.tokenBudget={cells:{'rename-1':null,'query-1':{latest:12,lastKnown:12,complete:true},'import-1':{latest:900,lastKnown:900,complete:true}}};
  c.recoveries=[null,{cell:'rename-1',result:null},{cell:'query-1',result:{...sample('query',1,500),usageScope:'reported-responses-only',effectiveProfileDigest:digest(resolveCaseProfile(c.profile,'query'))}}];
 });
 const before={specPath:'spec',status:'before'},after={specPath:'spec',status:'after'};
 f.state.pending={index:1,stage:'EXECUTE_SLICE',threadId:'p',turnId:'turn',before:'a'.repeat(64),authorityBefore:before};f.state.completedTurns=0;f.writeState();
 const providerTurn={threadId:'p',id:'turn',status:'completed'},proof={attempt:1,stage:'EXECUTE_SLICE',threadId:'p',turnId:'turn',beforeFingerprint:'a'.repeat(64),authorityDigest:digest(after),providerTurnDigest:digest(providerTurn),beforeAuthorityDigest:digest(before),deadline:f.state.deadline,nextStage:'VALIDATE_SLICE'};
 const inspect=async()=>({authority:after,providerTurn,decision:{outcome:'SETTLE',nextStage:'VALIDATE_SLICE',proof,proofDigest:digest(proof)}});
 let seeded;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect,execute:async x=>{seeded=x.campaignBudget.snapshot();assert.equal(x.resumeState.pending,null);return{status:'PASS'};}});
 assert.equal(r.outcome,'RESUMED');assert.equal(seeded.restoreProvenance,'structural-summary-observations-not-authenticated');
 assert.deepEqual(seeded.cells,{'rename-1':{latest:null,lastKnown:null,complete:false},'query-1':{latest:null,lastKnown:null,complete:false}});
 assert.deepEqual([...new Set(seeded.restoreGaps.map(g=>g.code))].sort(),['DUPLICATE_ORIGINAL_ROW','INVALID_SAVED_CELL','ORIGINAL_ROW_UNSCOPED','RECOVERY_ROW_UNSCOPED','RECOVERY_SCOPE_UNPROVEN']);
 assert.equal(JSON.parse(fs.readFileSync(path.join(f.ev,'checkpoint.json'))).pending,null);
});
test('SIMULATED observe-only seed does not adopt summary rows without original plan identity',async t=>{
 const f=setup(t);observeFixture(f,c=>{delete c.caseIds;c.results=[{caseId:'rename',repetition:1,observedTokens:900}];});
 let seeded;const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',inspect:noPending,execute:async x=>(seeded=x.campaignBudget.snapshot(),{status:'PASS'})});
 assert.equal(r.outcome,'RESUMED');assert.deepEqual(seeded.cells,{});assert.deepEqual(seeded.restoreGaps,[{code:'ORIGINAL_PLAN_UNAVAILABLE'}]);
});

test('public recovery cannot reopen a legacy serial campaign, even with a dead-looking lock',async t=>{
 const f=setup(t),lock=path.join(f.dir,'.lock'),owner={pid:123456,id:'historical'};save(lock,owner);
 let calls=0;
 const r=await resumeCampaignCase({base:f.base,id:'test',cell:'rename-1',requireParallel:true,inspect:async()=>calls++,execute:async()=>calls++});
 assert.equal(r.reason,'HISTORICAL_NON_C3_CAMPAIGN_READ_ONLY');assert.equal(calls,0);
 assert.deepEqual(JSON.parse(fs.readFileSync(lock)),owner);
});
