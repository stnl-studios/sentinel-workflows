import test from 'node:test';import assert from 'node:assert/strict';
import {buildQualification,admitOfficial,REQUIRED_CHECKS,qualificationDigest,REQUIRED_TARGET_CAPABILITIES}from'../qualification.mjs';
const proof=ref=>({ref:`evidence/${ref}.json`,sha256:'a'.repeat(64)});
function data(){const identity={engine:'1'.repeat(64),fixture:'2'.repeat(64),source:'3'.repeat(64),profile:'4'.repeat(64),cliVersion:'0.163.0',sentinelRevision:'b'.repeat(40),scenarioOracle:'5'.repeat(64),contextPolicy:'stage',adapterProtocol:'app-server-v1'};const harnessIdentity={engine:identity.engine,fixture:identity.fixture,cliVersion:identity.cliVersion,scenarioOracle:identity.scenarioOracle,contextPolicy:qualificationDigest(identity.contextPolicy),adapterProtocol:qualificationDigest(identity.adapterProtocol)};return{identity,harnessIdentity,campaigns:[{id:'qualification-run',mode:'diagnostic',scope:'live',identity:{...identity},proof:proof('campaign'),plannedCells:['rename','query','import'].flatMap(caseId=>[1,2].map(repetition=>({caseId,repetition}))),results:['rename','query','import'].flatMap(caseId=>[1,2].map(repetition=>({caseId,repetition,measurement:'diagnostic',harnessValid:true,status:repetition===1?'PASS':'FAIL',closed:repetition===1,oracle:repetition===1?'PASS':'FAIL',proof:proof(`${caseId}-${repetition}`)})))}],checks:REQUIRED_CHECKS.map(id=>({id,harnessIdentity,dependencies:[proof(id+'-dependency')],pass:true,scope:['profile-observation','authority-byte-binding'].includes(id)?'live':'simulated',proof:proof(id)}))};}
test('qualifies six valid diagnostics including failures; admits only future runs',()=>{const input=data(),before=JSON.stringify(input);const q=buildQualification(input);assert.equal(q.status,'QUALIFIED');assert.equal(admitOfficial({qualification:q,identity:input.identity}).allowed,true);assert.equal(JSON.stringify(input),before);assert.ok(q.campaigns[0].results.every(r=>r.measurement==='diagnostic'));});
test('missing repetition or no demonstrated CLOSE path blocks qualification',()=>{const d=data();d.campaigns[0].results.pop();assert.ok(buildQualification(d).reasons.includes('TWO_REPETITIONS_REQUIRED:import'));d.campaigns[0].results[0].closed=false;assert.ok(buildQualification(d).reasons.includes('CLOSE_ORACLE_PATH_REQUIRED:rename'));});
test('rejects simulated campaign, unqualified measurements and duplicate cells',()=>{const d=data();d.campaigns[0].scope='simulated';d.campaigns[0].results[0].harnessValid=false;d.campaigns[0].results.push(d.campaigns[0].results[1]);const q=buildQualification(d);assert.equal(q.status,'BLOCKED');assert.ok(q.reasons.some(r=>r.startsWith('LIVE_CAMPAIGN_REQUIRED')));assert.ok(q.reasons.some(r=>r.startsWith('RESULT_ID_INVALID_OR_DUPLICATE')));});
test('identity drift and altered proof evidence reject future admission',()=>{const d=data(),q=buildQualification(d);assert.equal(admitOfficial({qualification:q,identity:{...d.identity,source:'f'.repeat(64)}}).allowed,false);q.checks[0].proof.sha256='c'.repeat(64);assert.ok(admitOfficial({qualification:q,identity:d.identity}).reasons.includes('QUALIFICATION_INTEGRITY_MISMATCH'));});
test('failed checks, fake role observation, reused refs and invalid hashes reject',()=>{const d=data();d.checks[0].pass=false;d.checks.find(c=>c.id==='profile-observation').scope='simulated';d.campaigns[0].results[1].proof=d.campaigns[0].results[0].proof;d.checks[1].proof={ref:'../escape',sha256:'bad'};const q=buildQualification(d);assert.equal(q.status,'BLOCKED');assert.ok(q.reasons.includes('REUSED_RESULT_EVIDENCE:rename'));assert.ok(q.reasons.includes('LIVE_CHECK_REQUIRED:profile-observation'));});
test('canonical object order does not invalidate equivalent identity',()=>{const d=data(),q=buildQualification(d);assert.equal(admitOfficial({qualification:q,identity:Object.fromEntries(Object.entries(d.identity).reverse())}).allowed,true);});
test('missing qualification and conflicting hash per ref fail closed',()=>{assert.equal(admitOfficial({identity:data().identity}).allowed,false);const d=data();d.checks[1].proof={...d.checks[0].proof,sha256:'c'.repeat(64)};assert.ok(buildQualification(d).reasons.some(r=>r.startsWith('PROOF_HASH_CONFLICT')));});

function target(d){const identity={...d.identity,source:'8'.repeat(64),profile:'9'.repeat(64),sentinelRevision:'c'.repeat(40)},harnessIdentity={...d.harnessIdentity};const targetProof={schemaVersion:1,targetIdentityDigest:qualificationDigest(identity),harnessIdentityDigest:qualificationDigest(harnessIdentity),checks:{gitSnapshot:{status:'VERIFIED',revision:identity.sentinelRevision,treeDigest:identity.source,gitTree:'d'.repeat(40),proof:proof('target-git')},profile:{status:'VERIFIED',profileDigest:identity.profile,proof:proof('target-profile')},modelSupport:{status:'SUPPORTED',profileDigest:identity.profile,roles:['coordinator','plan_approver','plan_review','execute_check','formal_validate'].map(role=>({role,model:'new-model',effort:'high'})),proof:proof('target-models')},securityContext:{status:'MATCH',contextPolicyDigest:harnessIdentity.contextPolicy,profileDigest:identity.profile,proof:proof('target-security')},protocolCompatibility:{status:'SUPPORTED',sourceDigest:identity.source,cliVersion:identity.cliVersion,adapterProtocolDigest:harnessIdentity.adapterProtocol,sentinelRuntimeContractDigest:'e'.repeat(64),requiredCapabilities:[...REQUIRED_TARGET_CAPABILITIES],proof:proof('target-protocol')}}};return{identity,harnessIdentity,targetProof}}
test('new target source/profile admits without outcome PASS and keeps reference separate',()=>{const d=data(),q=buildQualification(d),t=target(d);const a=admitOfficial({qualification:q,...t});assert.equal(a.allowed,true,JSON.stringify(a.reasons));assert.equal(a.targetOutcomeRequired,false);assert.deepEqual(a.referenceIdentity,d.identity);assert.deepEqual(a.targetIdentity,t.identity);assert.notEqual(a.referenceIdentity.profile,a.targetIdentity.profile);for(const outcome of ['FAIL','TIMEOUT','BLOCKED'])assert.equal(admitOfficial({qualification:q,...t,outcome}).allowed,true)});
test('changed target without proof and cross-target reused binding fail',()=>{const d=data(),q=buildQualification(d),t=target(d);assert.ok(admitOfficial({qualification:q,identity:t.identity,harnessIdentity:t.harnessIdentity}).reasons.includes('TARGET_PROOF_REQUIRED'));t.identity.profile='f'.repeat(64);assert.ok(admitOfficial({qualification:q,...t}).reasons.includes('TARGET_PROOF_BINDING_MISMATCH'))});
test('new CLI or harness security/scenarios requires requalification',()=>{const d=data(),q=buildQualification(d);for(const key of ['engine','fixture','scenarioOracle','contextPolicy','adapterProtocol','cliVersion']){const t=target(d);t.harnessIdentity[key]=key==='cliVersion'?'0.164.0':'f'.repeat(64);if(['engine','fixture','cliVersion'].includes(key))t.identity[key]=t.harnessIdentity[key];const a=admitOfficial({qualification:q,...t});assert.equal(a.allowed,false);assert.ok(a.reasons.includes('HARNESS_REQUALIFICATION_REQUIRED'))}});
test('target proof status, support, refs and hashes all fail closed',()=>{const d=data(),q=buildQualification(d);for(const modify of [t=>t.targetProof.checks.gitSnapshot.revision='f'.repeat(40),t=>t.targetProof.checks.modelSupport.roles.pop(),t=>t.targetProof.checks.securityContext.status='UNKNOWN',t=>t.targetProof.checks.protocolCompatibility.requiredCapabilities=[],t=>t.targetProof.checks.profile.proof={ref:'../bad',sha256:'x'},t=>t.targetProof.checks.profile.proof=t.targetProof.checks.gitSnapshot.proof]){const t=target(d);modify(t);assert.equal(admitOfficial({qualification:q,...t}).allowed,false)}});
test('reference cannot omit declared losing cells',()=>{const d=data();d.campaigns[0].results=d.campaigns[0].results.filter(r=>r.status==='PASS');const q=buildQualification(d);assert.ok(q.reasons.includes('DECLARED_RESULTS_INCOMPLETE:qualification-run'));assert.equal(q.status,'BLOCKED')});
test('reference requires explicit harness identity',()=>{const d=data();delete d.harnessIdentity;assert.ok(buildQualification(d).reasons.includes('HARNESS_IDENTITY_INVALID'))});
test('malformed target identity and role observations return refusal, not exception',()=>{const d=data(),q=buildQualification(d),t=target(d);assert.equal(admitOfficial({qualification:q,identity:null,harnessIdentity:t.harnessIdentity,targetProof:t.targetProof}).allowed,false);t.targetProof.checks.modelSupport.roles[0]=null;assert.equal(admitOfficial({qualification:q,...t}).allowed,false)});
test('target supports extra stage role and newly advertised effort without stale pure enum',()=>{const d=data(),q=buildQualification(d),t=target(d);t.targetProof.checks.modelSupport.roles.push({role:'planner_special',model:'new-model',effort:'ultra'});assert.equal(admitOfficial({qualification:q,...t}).allowed,true);t.targetProof.checks.modelSupport.roles.push({role:'planner_special',model:'new-model',effort:'ultra'});assert.ok(admitOfficial({qualification:q,...t}).reasons.includes('TARGET_MODELS_UNPROVEN'))});

test('reference and target require all measured harness bindings, no legacy omissions',()=>{
 for(const key of ['scenarioOracle','contextPolicy','adapterProtocol']){
  for(const missing of [false,true]){
   const d=data();if(missing)delete d.identity[key];else d.identity[key]='tampered';
   assert.ok(buildQualification(d).reasons.includes('HARNESS_IDENTITY_INVALID'));
   const good=data(),q=buildQualification(good),t=target(good);
   if(missing)delete t.identity[key];else t.identity[key]='tampered';
   assert.ok(admitOfficial({qualification:q,...t}).reasons.includes('TARGET_HARNESS_IDENTITY_INVALID'));
  }
 }
});

test('case-qualified roles require mandatory logical roles for each case and exact key binding',()=>{
 const d=data(),q=buildQualification(d),t=target(d);
 const original=t.targetProof.checks.modelSupport.roles;
 t.targetProof.checks.modelSupport.roles=['rename','import'].flatMap(caseId=>original.map(r=>({...r,caseId,logicalRole:r.role,role:caseId+'__'+r.role})));
 assert.equal(admitOfficial({qualification:q,...t}).allowed,true);
 t.targetProof.checks.modelSupport.roles.pop();assert.equal(admitOfficial({qualification:q,...t}).allowed,false);
 t.targetProof.checks.modelSupport.roles=['rename','import'].flatMap(caseId=>original.map(r=>({...r,caseId,logicalRole:r.role,role:caseId+'__'+r.role})));
 t.targetProof.checks.modelSupport.roles[0].caseId='query';assert.equal(admitOfficial({qualification:q,...t}).allowed,false);
});

test('check identity and nonempty dependencies are mandatory, without legacy fallback',()=>{
 for(const change of [
 c=>delete c.harnessIdentity,c=>c.harnessIdentity.engine='f'.repeat(64),
 c=>delete c.dependencies,c=>c.dependencies=[],
 c=>c.dependencies.push({...c.dependencies[0]}),
 c=>c.dependencies=[c.proof],c=>c.dependencies=[{ref:'../bad',sha256:'a'.repeat(64)}],
 c=>c.dependencies=[{...c.dependencies[0],unverified:{ref:'extra'}}]
 ]){const d=structuredClone(data());change(d.checks[0]);assert.equal(buildQualification(d).status,'BLOCKED')}
 const d=data();d.checks[1].dependencies=[{...d.checks[0].dependencies[0],sha256:'f'.repeat(64)}];
 assert.ok(buildQualification(d).reasons.some(r=>r.startsWith('PROOF_HASH_CONFLICT')));
});

test('literal concurrency binding refuses serial-to-parallel and parallel-to-serial',()=>{
 const serial=data(),q=buildQualification(serial),changed=target(serial);changed.identity.concurrency=3;changed.targetProof.targetIdentityDigest=qualificationDigest(changed.identity);
 assert.ok(admitOfficial({qualification:q,...changed}).reasons.includes('CONCURRENCY_REQUALIFICATION_REQUIRED'));
 const parallel=data();parallel.identity.concurrency=3;parallel.campaigns[0].identity=structuredClone(parallel.identity);
 const pq=buildQualification(parallel),back=target(parallel);back.identity.concurrency=1;back.targetProof.targetIdentityDigest=qualificationDigest(back.identity);
 assert.equal(pq.status,'QUALIFIED');assert.ok(admitOfficial({qualification:pq,...back}).reasons.includes('CONCURRENCY_REQUALIFICATION_REQUIRED'));
});
