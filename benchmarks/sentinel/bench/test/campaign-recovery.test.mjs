import {after as cleanupAfterSuite} from 'node:test';
// Only fresh roots allocated by THIS test-file execution are disposable.
// Never glob temp, adopt a preexisting path, or delete a replaced root.
const ownedTestRoots = new Map();
function ownTestRoot(root) {
 const stat=fs.lstatSync(root);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('test root must be a new real directory');
 ownedTestRoots.set(root,{dev:stat.dev,ino:stat.ino});
 return root;
}
cleanupAfterSuite(()=>{
 for(const [root,identity]of ownedTestRoots){
  let stat;try{stat=fs.lstatSync(root);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(stat.isSymbolicLink()||stat.dev!==identity.dev||stat.ino!==identity.ino)throw Error('refusing cleanup of replaced test root: '+root);
  fs.rmSync(root,{recursive:true,force:false});
 }
});
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';
import {executeCase}from'../campaign.mjs';import {sha256}from'../core.mjs';
const base=fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'));
// Entire provider/lifecycle in these tests is SIMULATED, never live qualification.
function setup(options={}){
 const d=ownTestRoot(fs.mkdtempSync(path.join(base,'temp/campaign-fake-'))),w=d+'/workspace',e=d+'/evidence';fs.mkdirSync(w+'/src',{recursive:true});fs.mkdirSync(e);fs.writeFileSync(w+'/src/a.mjs','export const a=1');fs.writeFileSync(w+'/package.json','{}');const profile=JSON.parse(fs.readFileSync(path.join(base,'bench/profiles/default.json')));profile.contextPolicy='persistent';let op='PLAN',calls=[],turns=0,captures=[],attempts=0,approvals=0;
 const authority=()=>({specPath:w+'/specs/rename',lifecycle:{exitCode:0,output:op==='CLOSED'?{lifecycle_status:'closed',execution_state:'NOT_APPLICABLE',normal_handoff:null}:{lifecycle_status:'ready',execution_state:op==='PLAN'?'EMPTY':'ACTIVE',legal_execution_operations:['PLAN']}},current:{exitCode:0,output:{state:op==='PLAN'?'NO_EXECUTION':op==='CLOSE'?'COMPLETE':op==='CLOSED'?'SPEC_CLOSED':'ACTIVE',normalHandoff:['PLAN','CLOSE','CLOSED'].includes(op)?null:{operation:op,slice:'slice-01'}}}});
 const srv={active:null,async start(){calls.push('start')},async stop(){calls.push('stop')},async modelList(){return{data:Object.values(profile.roles).map(r=>({model:r.model}))}},async startThread(o){calls.push('startThread');return{thread:{id:o.sandbox==='read-only'?'review-'+(approvals+1):'root'},model:o.model,reasoningEffort:o.config.model_reasoning_effort,cwd:w,approvalPolicy:'never',sandbox:{type:o.sandbox==='read-only'?'readOnly':'workspaceWrite',networkAccess:false,excludeSlashTmp:true,writableRoots:[]}}},async resumeThread(o){calls.push('resumeThread');assert.equal(o.threadId,'root');return{thread:{id:'root'},model:o.model,reasoningEffort:o.config.model_reasoning_effort,cwd:w,approvalPolicy:'never',sandbox:{type:'workspaceWrite',networkAccess:false,excludeSlashTmp:true,writableRoots:[]}}},async runTurn(o){let name;if(o.threadId.startsWith('review')){name='APPROVE';approvals++;}else if(op==='PLAN')name=o.input[0].text.includes('REVIEW_PLAN')?'REVIEW':'AUTHOR';else name=op;calls.push(name);const id='turn-'+(++turns);o.onAccepted({threadId:o.threadId,turnId:id});if(name==='AUTHOR'&&options.busyAfterAuthor)srv.active={turnId:id};if(name==='AUTHOR'&&options.incompleteAuthor)return{status:'interrupted',threadId:o.threadId,turnId:id};if(name==='REVIEW')op='EXECUTE_SLICE';else if(op==='EXECUTE_SLICE')op='VALIDATE_SLICE';else if(op==='VALIDATE_SLICE')op='CLOSE';else if(op==='CLOSE')op='CLOSED';return{status:'completed',threadId:o.threadId,turnId:id}},async readThread(id){const reject=options.rejectFirst&&approvals===1;const digest=options.staleApproval&&approvals>1?captures[0].captureSha256:captures.at(-1).captureSha256;return{thread:{id,turns:[{id:'turn-'+turns,items:[{type:'agentMessage',text:JSON.stringify({decision:reject?'REJECT':'APPROVE',captureSha256:digest,reasons:['simulation'],missingCriteria:reject?['missing criterion']:[]})}]}]}}}};
 // SIMULATED source contract fixture: real bytes/path/hash, never a real model invocation.
 const runnerPath=path.join(d,'source/agents/codex/.codex/agents/stnl_validation_runner.toml');
 fs.mkdirSync(path.dirname(runnerPath),{recursive:true});
 fs.writeFileSync(runnerPath,'name = "simulated_runner"\nmodel = "simulation"\nmodel_reasoning_effort = "high"\ndeveloper_instructions = "SIMULATED test contract only"\n');
 const runnerContract={path:runnerPath,sha256:sha256(fs.readFileSync(runnerPath))};
 const m={caseId:'rename',repetition:1,workspace:w,evidence:e,home:d+'/home',codexHome:d+'/home/.codex',tmpDir:d,profile,runnerContract};
 const services={serverFactory:()=>srv,collectUsage:async()=>({observedTotals:{totalTokens:{value:1,complete:true}}}),inspectAuthority:authority,verifyCase:async()=>({status:'PASS'}),configureRunner:()=>{},allocatePlan:()=>{calls.push('allocate');return{candidateExecutionRoot:w+'/candidate'}},capturePlan:()=>{calls.push('capture');attempts++;if(attempts<=(options.captureFailures??0)){const error=Error('invalid draft simulation');if(!options.missingCode){error.code='INVALID_CURRENT_IMAGE';error.operation='capturePreparationDraft';}throw error;}const snapshot={simulation:true,attempt:attempts},bytes=JSON.stringify(snapshot),snapshotPath=w+'/capture-'+attempts+'.json';fs.writeFileSync(snapshotPath,bytes);const capture={snapshot,snapshotPath,captureSha256:'sha256:'+sha256(bytes)};captures.push(capture);return capture;},recoverUncapturedDraft:(_m,_spec,_root,_error,proof)=>{calls.push({recover:proof});if(!proof.providerTurnCompleted||!proof.transportIdle||options.helperReject)throw Error('RECOVERY_PROOF_REJECTED');return{status:'EDITABLE_DRAFT',draftRoot:w+'/draft'};},reviseRejectedPlan:(_m,_spec,_root,capture,decision,proof)=>{calls.push({revise:proof,digest:capture.captureSha256});assert.equal(decision.decision,'REJECT');if(!proof.providerTurnCompleted||!proof.transportIdle)throw Error('REVISION_PROOF_REJECTED');return{draftRoot:w+'/draft'};},approvePlan:(_m,_spec,_root,capture,decision)=>{calls.push({approve:capture.captureSha256,decision:decision.captureSha256});if(decision.captureSha256!==capture.captureSha256)throw Error('STALE_CAPTURE_APPROVAL');return{status:'APPROVED'}}};
 return{m,services,calls,srv,captures,authority,run:(extra={})=>executeCase({manifest:m,campaignDeadline:Date.now()+60000,requirements:'simulation',services,...extra}),checkpoint:()=>JSON.parse(fs.readFileSync(e+'/checkpoint.json'))};
}

test('SIMULATED invalid capture recovers exact completed idle author without duplicated allocation',async()=>{const f=setup({captureFailures:1}),r=await f.run();assert.equal(r.status,'PASS',r.error);assert.equal(f.calls.filter(c=>c==='allocate').length,1);assert.equal(f.calls.filter(c=>c==='AUTHOR').length,2);assert.equal(f.calls.filter(c=>c==='capture').length,2);assert.deepEqual(f.calls.find(c=>c.recover).recover,{providerTurnCompleted:true,transportIdle:true});const s=f.checkpoint();assert.equal(s.resolvedEffects.length,1);assert.equal(s.pendingEffect,null);assert.equal(s.plan.corrections,1);});
test('SIMULATED capture correction is bounded at two; third failure remains pending',async()=>{const f=setup({captureFailures:99}),r=await f.run();assert.equal(r.status,'BLOCKED');assert.equal(f.calls.filter(c=>c==='AUTHOR').length,3);assert.equal(f.calls.filter(c=>c.recover).length,2);assert.equal(f.checkpoint().pendingEffect.name,'capture-plan');});
test('SIMULATED missing error code cannot invoke capture recovery',async()=>{const f=setup({captureFailures:1,missingCode:true}),r=await f.run();assert.equal(r.status,'BLOCKED');assert.equal(f.calls.filter(c=>c.recover).length,0);assert.equal(f.checkpoint().pendingEffect.name,'capture-plan');});
test('SIMULATED failed proof or busy provider retains pending capture effect',async()=>{for(const option of [{helperReject:true},{busyAfterAuthor:true}]){const f=setup({captureFailures:1,...option}),r=await f.run();assert.equal(r.error,'RECOVERY_PROOF_REJECTED');assert.equal(f.checkpoint().pendingEffect.name,'capture-plan');assert.equal(f.calls.filter(c=>c==='AUTHOR').length,1);}});
test('SIMULATED interrupted author never captures or clears pending turn',async()=>{const f=setup({incompleteAuthor:true}),r=await f.run();assert.equal(r.status,'BLOCKED');assert.equal(f.calls.filter(c=>c==='capture').length,0);assert.equal(f.calls.filter(c=>c.recover).length,0);assert.ok(f.checkpoint().pending);});
test('SIMULATED external rejection revises and requires approval of new capture digest',async()=>{const f=setup({rejectFirst:true}),r=await f.run();assert.equal(r.status,'PASS',r.error);assert.equal(f.calls.filter(c=>c==='AUTHOR').length,2);assert.equal(f.calls.filter(c=>c.revise).length,1);assert.equal(f.captures.length,2);assert.notEqual(f.captures[0].captureSha256,f.captures[1].captureSha256);const approvals=f.calls.filter(c=>c.approve);assert.equal(approvals.length,1);assert.equal(approvals[0].approve,f.captures[1].captureSha256);assert.equal(f.checkpoint().planHistory[0].delegatedApproval.decision.decision,'REJECT');});
test('SIMULATED stale approval cannot approve newly captured revised draft',async()=>{const f=setup({rejectFirst:true,staleApproval:true}),r=await f.run();assert.equal(r.status,'BLOCKED');assert.equal(r.error,'STALE_CAPTURE_APPROVAL');assert.equal(f.checkpoint().pendingEffect.name,'approve-plan');assert.ok(!f.calls.includes('REVIEW'));});

// Feedback broadens the author inspection within the same draft, never the recovery authority.
test('SIMULATED capture feedback asks class-wide correction only after typed quiet recovery',async()=>{
 const f=setup({captureFailures:1}),r=await f.run();assert.equal(r.status,'PASS',r.error);
 const request=JSON.parse(fs.readFileSync(path.join(f.m.evidence,'turn-2-request.json')));
 const text=JSON.stringify(request);
 assert.match(text,/todos os artefatos de Plan\/Tasks globais e detalhados/);
 assert.match(text,/não somente a primeira ocorrência/);
 assert.match(text,/mesma alocação existente/);
 assert.match(text,/não amplie o escopo nem crie outra alocação/);
 assert.match(text,/Não substitua a validação oficial por parser próprio/);
 assert.match(text,/duas correções/);
 assert.match(text,/invalid draft simulation/);
 assert.equal(f.calls.filter(c=>c==='allocate').length,1);
 assert.equal(f.calls.filter(c=>c==='capture').length,2);
 const blocked=setup({captureFailures:1,missingCode:true});await blocked.run();
 assert.equal(blocked.checkpoint().plan.feedback,undefined);
 assert.equal(blocked.calls.filter(c=>c==='AUTHOR').length,1);
});
