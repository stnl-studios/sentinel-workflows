import{test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{fileURLToPath}from'node:url';import{sha256,digest}from'../core.mjs';import{REQUIRED_CHECKS,qualificationDigest}from'../qualification.mjs';import{harnessIdentityFromCampaign,verifyQualificationEvidence,createQualification}from'../qualification-store.mjs';
const temp=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../temp/qualification-store-tests');
function fixture(t){fs.mkdirSync(temp,{recursive:true});const base=fs.mkdtempSync(path.join(temp,'test-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));fs.mkdirSync(path.join(base,'evidence'));const proof=(name,value={status:'observed'})=>{const ref='evidence/'+name+'.json';fs.writeFileSync(path.join(base,ref),JSON.stringify(value));return{ref,sha256:sha256(fs.readFileSync(path.join(base,ref)))}};const identity={engine:'1'.repeat(64),fixture:'2'.repeat(64),scenarioOracle:'3'.repeat(64),source:'4'.repeat(64),profile:'5'.repeat(64),cliVersion:'0.163.0',sentinelRevision:'a'.repeat(40),contextPolicy:'stage',adapterProtocol:'public-v1'};return{base,proof,identity,harnessIdentity:harnessIdentityFromCampaign(identity)}}
function reference(f){const plannedCells=['rename','query','import'].flatMap(caseId=>[1,2].map(repetition=>({caseId,repetition})));const results=plannedCells.map(c=>{const r={...c,measurement:'diagnostic',harnessValid:true,status:c.repetition===1?'PASS':'FAIL',closed:c.repetition===1,oracle:c.repetition===1?'PASS':'FAIL'};return{...r,proof:f.proof(c.caseId+c.repetition,r)}});const campaign={id:'ref',mode:'diagnostic',scope:'live',identity:f.identity,plannedCells,results};campaign.proof=f.proof('campaign',campaign);const checks=REQUIRED_CHECKS.map(id=>{const c={id,harnessIdentity:f.harnessIdentity,dependencies:[f.proof(id+'-dependency')],pass:true,scope:['profile-observation','authority-byte-binding'].includes(id)?'live':'local'};return{...c,proof:f.proof(id,c)}});return{...f,campaigns:[campaign],checks,evidenceDir:'evidence/certificate'}}
test('factory hashes policy strings and keeps implementation/fixture/oracles separate',t=>{const f=fixture(t);assert.equal(f.harnessIdentity.contextPolicy,qualificationDigest('stage'));assert.equal(f.harnessIdentity.adapterProtocol,qualificationDigest('public-v1'));assert.equal(f.harnessIdentity.scenarioOracle,f.identity.scenarioOracle);assert.equal('profile'in f.harnessIdentity,false)});
test('creates only verified qualification, preserves diagnostic rows, never overwrites',t=>{const d=reference(fixture(t));const r=createQualification(d);assert.equal(r.status,'QUALIFIED');assert.equal(r.evidenceVerification.status,'PASS');assert.ok(r.qualification.campaigns[0].results.every(x=>x.measurement==='diagnostic'));assert.deepEqual(JSON.parse(fs.readFileSync(r.file)),r.qualification);assert.throws(()=>createQualification(d),/EEXIST/)});
test('actual bytes tampered after supplied hash block certificate',t=>{const d=reference(fixture(t));fs.appendFileSync(path.join(d.base,d.checks[0].proof.ref),' ');const r=createQualification(d);assert.equal(r.status,'BLOCKED');assert.equal(r.file,null);assert.ok(r.reasons.some(x=>x.includes('PROOF_BYTES_MISMATCH')))});
test('nested campaign/results/checks proof refs all read',t=>{const f=fixture(t);const good=f.proof('good'),bad=f.proof('bad');fs.unlinkSync(path.join(f.base,bad.ref));const r=verifyQualificationEvidence({base:f.base,qualification:{proof:good,campaigns:[{results:[{proof:bad}]}]}});assert.equal(r.status,'BLOCKED');assert.ok(r.reasons.some(x=>x.includes('results/0/proof')))});
test('path escapes and symlink proof file rejected even with correct bytes',t=>{const f=fixture(t),p=f.proof('good');for(const ref of ['../evidence/good.json','source/good.json','evidence/../evidence/good.json','/evidence/good.json'])assert.equal(verifyQualificationEvidence({base:f.base,qualification:{proof:{...p,ref}}}).status,'BLOCKED');fs.symlinkSync(path.join(f.base,p.ref),path.join(f.base,'evidence/link.json'));assert.equal(verifyQualificationEvidence({base:f.base,qualification:{proof:{...p,ref:'evidence/link.json'}}}).status,'BLOCKED')});
test('symlink ancestor rejected',t=>{const f=fixture(t),p=f.proof('good');fs.symlinkSync(path.join(f.base,'evidence'),path.join(f.base,'evidence/alias'));assert.equal(verifyQualificationEvidence({base:f.base,qualification:{proof:{...p,ref:'evidence/alias/good.json'}}}).status,'BLOCKED')});
test('SIMULATED target claimed REAL still rejected by artifact bytes',t=>{const f=fixture(t),p=f.proof('simulated',{scope:'SIMULATED',status:'VERIFIED'});const r=verifyQualificationEvidence({base:f.base,targetProof:{scope:'REAL',checks:{gitSnapshot:{status:'VERIFIED',proof:p}}}});assert.equal(r.status,'BLOCKED');assert.ok(r.reasons.some(x=>x.includes('TARGET_SIMULATED_NOT_ADMISSIBLE')))});
test('REAL scope alone cannot substitute target content bindings; simulated local check allowed',t=>{const f=fixture(t);assert.equal(verifyQualificationEvidence({base:f.base,targetProof:{scope:'REAL',checks:{profile:{proof:f.proof('real',{scope:'REAL'})}}}}).status,'BLOCKED');const check={id:'local-tests',harnessIdentity:f.harnessIdentity,dependencies:[f.proof('local-dependency')],pass:true,scope:'simulated'};assert.equal(verifyQualificationEvidence({base:f.base,qualification:{harnessIdentity:f.harnessIdentity,checks:[{...check,proof:f.proof('local',check)}]}}).status,'PASS')});
test('conflicting hashes same ref and missing input fail closed',t=>{const f=fixture(t),p=f.proof('good');assert.equal(verifyQualificationEvidence({base:f.base}).status,'BLOCKED');const r=verifyQualificationEvidence({base:f.base,qualification:{a:{proof:p},b:{proof:{...p,sha256:'b'.repeat(64)}}}});assert.ok(r.reasons.some(x=>x.includes('PROOF_HASH_CONFLICT')))});
test('reference live claim cannot use explicitly simulated artifact',t=>{const f=fixture(t),p=f.proof('fake-live',{scope:'SIMULATED'});const r=verifyQualificationEvidence({base:f.base,qualification:{campaigns:[{scope:'live',proof:p}]}});assert.equal(r.status,'BLOCKED');assert.ok(r.reasons.some(x=>x.includes('LIVE_PROOF_IS_SIMULATED')))});

test('correct hash of unrelated PASS document does not prove check',t=>{const f=fixture(t),p=f.proof('different',{id:'other',scope:'live',pass:true});const r=verifyQualificationEvidence({base:f.base,qualification:{checks:[{id:'profile-observation',scope:'live',pass:true,proof:p}]}});assert.ok(r.reasons.includes('CHECK_PROOF_BINDING:profile-observation'))});
test('reference rows cannot claim successful harness over failed artifact',t=>{const d=reference(fixture(t));const r=d.campaigns[0].results[0];r.status='FAIL';assert.equal(createQualification(d).status,'BLOCKED')});
test('synthetic real-shaped target documents bind content and advertised schema bytes',t=>{const f=fixture(t),roles=['coordinator','plan_approver','plan_review','execute_check','formal_validate'].map(role=>({role,model:'test',effort:'high'}));const profile={schemaVersion:1,id:'synthetic',cli:'/fake',cliVersion:'0.163.0',sentinelRevision:'a'.repeat(40),roles:Object.fromEntries(roles.map(r=>[r.role,{model:r.model,effort:r.effort}])),repetitions:1,concurrency:1,limits:{campaignMs:100,caseMs:100,turnMs:100,maxTurns:1,maxNoProgress:1,maxReportedTokens:1}},profileDigest=sha256(JSON.stringify(profile));const schema=f.proof('ClientRequest',{oneOf:[{properties:{method:{enum:['initialize']}}}]});const protocolDoc={scope:'REAL',cliVersion:'0.163.0',capabilities:['initialize'],runtime:{contractDigest:'a'.repeat(64)},schemaProof:[{file:schema.ref,sha256:schema.sha256}]};const checks={gitSnapshot:{revision:'a'.repeat(40),gitTree:'b'.repeat(40),treeDigest:'c'.repeat(64),proof:f.proof('git',{scope:'REAL',source:{revision:'a'.repeat(40),tree:'b'.repeat(40),sha256TreeDigest:'c'.repeat(64)}})},profile:{profileDigest,proof:f.proof('profile',{scope:'REAL',profile,profileDigest})},modelSupport:{roles,proof:f.proof('models',{scope:'REAL',roles,listing:[{model:'test',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]})},securityContext:{contextPolicyDigest:'d'.repeat(64),profileDigest,proof:f.proof('security',{scope:'REAL',contextPolicyDigest:'d'.repeat(64),profileDigest,observed:roles.map(r=>({roles:[r.role],model:r.model,reasoningEffort:r.effort,approvalPolicy:'never',sandbox:{type:r.role==='plan_approver'?'readOnly':'workspaceWrite',networkAccess:false,excludeSlashTmp:true}}))})},protocolCompatibility:{cliVersion:'0.163.0',requiredCapabilities:['initialize'],sentinelRuntimeContractDigest:'a'.repeat(64),proof:f.proof('protocol',protocolDoc)}};const targetProof={scope:'REAL',checks};assert.equal(verifyQualificationEvidence({base:f.base,targetProof}).status,'PASS');checks.profile.profileDigest='f'.repeat(64);assert.ok(verifyQualificationEvidence({base:f.base,targetProof}).reasons.includes('TARGET_PROFILE_CONTENT_BINDING'));checks.profile.profileDigest=profileDigest;fs.appendFileSync(path.join(f.base,schema.ref),' ');assert.ok(verifyQualificationEvidence({base:f.base,targetProof}).reasons.includes('TARGET_PROTOCOL_SCHEMA_BYTES'))});

test('case-qualified profile/security bindings include every selected override',t=>{const f=fixture(t),roles=['coordinator','plan_approver','plan_review','execute_check','formal_validate'].map(logicalRole=>({role:'import__'+logicalRole,logicalRole,caseId:'import',model:'test',effort:'high'}));const profile={schemaVersion:1,id:'synthetic',cli:'/fake',cliVersion:'0.163.0',sentinelRevision:'a'.repeat(40),suiteCases:['import'],roles:Object.fromEntries(roles.map(r=>[r.logicalRole,{model:'unused-global',effort:'medium'}])),caseOverrides:{import:{roles:Object.fromEntries(roles.map(r=>[r.logicalRole,{model:r.model,effort:r.effort}]))}},repetitions:1,concurrency:1,limits:{campaignMs:100,caseMs:100,turnMs:100,maxTurns:1,maxNoProgress:1,maxReportedTokens:1}},profileDigest=sha256(JSON.stringify(profile));const schema=f.proof('ClientRequest',{oneOf:[{properties:{method:{enum:['initialize']}}}]});const protocolDoc={scope:'REAL',cliVersion:'0.163.0',capabilities:['initialize'],runtime:{contractDigest:'a'.repeat(64)},schemaProof:[{file:schema.ref,sha256:schema.sha256}]};const checks={gitSnapshot:{revision:'a'.repeat(40),gitTree:'b'.repeat(40),treeDigest:'c'.repeat(64),proof:f.proof('git',{scope:'REAL',source:{revision:'a'.repeat(40),tree:'b'.repeat(40),sha256TreeDigest:'c'.repeat(64)}})},profile:{profileDigest,proof:f.proof('profile',{scope:'REAL',profile,profileDigest})},modelSupport:{roles,proof:f.proof('models',{scope:'REAL',roles,listing:[{model:'test',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]})},securityContext:{contextPolicyDigest:'d'.repeat(64),profileDigest,proof:f.proof('security',{scope:'REAL',contextPolicyDigest:'d'.repeat(64),profileDigest,observed:roles.map(r=>({roles:[r.role],model:r.model,reasoningEffort:r.effort,approvalPolicy:'never',sandbox:{type:r.logicalRole==='plan_approver'?'readOnly':'workspaceWrite',networkAccess:false,excludeSlashTmp:true}}))})},protocolCompatibility:{cliVersion:'0.163.0',requiredCapabilities:['initialize'],sentinelRuntimeContractDigest:'a'.repeat(64),proof:f.proof('protocol',protocolDoc)}};const targetProof={scope:'REAL',checks};assert.equal(verifyQualificationEvidence({base:f.base,targetProof}).status,'PASS');checks.profile.profileDigest='f'.repeat(64);assert.ok(verifyQualificationEvidence({base:f.base,targetProof}).reasons.includes('TARGET_PROFILE_CONTENT_BINDING'));checks.profile.profileDigest=profileDigest;fs.appendFileSync(path.join(f.base,schema.ref),' ');assert.ok(verifyQualificationEvidence({base:f.base,targetProof}).reasons.includes('TARGET_PROTOCOL_SCHEMA_BYTES'))});

test('check wrapper and descriptor bind exact identity and dependency list',t=>{
 for(const mutate of [
 c=>delete c.harnessIdentity,
 c=>c.harnessIdentity.engine='f'.repeat(64),
 c=>delete c.dependencies,
 c=>c.dependencies=[],
 (c,d)=>c.dependencies.push(d.proof('extra')),
 c=>c.dependencies[0].sha256='f'.repeat(64),
 c=>c.pass=false
 ]){
  const d=reference(fixture(t)),c=d.checks[0],saved=JSON.parse(fs.readFileSync(path.join(d.base,c.proof.ref)));
  mutate(saved,d);c.proof=d.proof(c.id,saved);
  const r=createQualification(d);assert.equal(r.status,'BLOCKED');assert.ok(r.reasons.includes('CHECK_PROOF_BINDING:'+c.id));
 }
});
test('declared check dependencies read actual bytes and reject missing, symlink, escape or tampering',t=>{
 for(const mode of ['missing','tampered','symlink','ancestor','escape']){
  const d=reference(fixture(t)),c=d.checks[0],dep=c.dependencies[0],file=path.join(d.base,dep.ref);
  if(mode==='missing')fs.unlinkSync(file);
  if(mode==='tampered')fs.appendFileSync(file,' ');
  if(mode==='symlink'){fs.renameSync(file,file+'.real');fs.symlinkSync(file+'.real',file)}
  if(mode==='ancestor'){fs.symlinkSync(path.join(d.base,'evidence'),path.join(d.base,'evidence/alias'));dep.ref=dep.ref.replace('evidence/','evidence/alias/')}
  if(mode==='escape')dep.ref='../'+dep.ref;
  const {proof,...saved}=c;c.proof=d.proof(c.id,saved);
  const r=createQualification(d);assert.equal(r.status,'BLOCKED',mode);assert.equal(r.file,null);
 }
});
test('matching duplicate, empty and self dependencies cannot authorize a certificate',t=>{
 for(const mode of ['duplicate','empty','self']){
  const d=reference(fixture(t)),c=d.checks[0];
  if(mode==='duplicate')c.dependencies.push({...c.dependencies[0]});
  if(mode==='empty')c.dependencies=[];
  if(mode==='self')c.dependencies=[{...c.proof}];
  const {proof,...saved}=c;c.proof=d.proof(c.id,saved);
  const r=createQualification(d);assert.equal(r.status,'BLOCKED');assert.ok(r.reasons.some(x=>x.startsWith('CHECK_DEPENDENC')));
 }
});
test('live check dependent artifact cannot be simulated even when wrapper claims live',t=>{
 const d=reference(fixture(t)),c=d.checks.find(c=>c.scope==='live');
 c.dependencies=[d.proof('fake-dependency',{scope:'SIMULATED',pass:true})];
 const {proof,...saved}=c;c.proof=d.proof(c.id,saved);
 const r=createQualification(d);assert.equal(r.status,'BLOCKED');assert.ok(r.reasons.some(x=>x.includes('LIVE_PROOF_IS_SIMULATED')));
});
test('matching failed check stays blocked; no boolean truth certification from verified bytes',t=>{
 const d=reference(fixture(t)),c=d.checks[0];c.pass=false;
 const {proof,...saved}=c;c.proof=d.proof(c.id,saved);
 const r=createQualification(d);assert.equal(r.status,'BLOCKED');assert.ok(r.reasons.includes('CHECK_NOT_PASS:'+c.id));
});

test('parallel byte evidence verifies actual completed provider overlap and FIFO, not just a C3 profile',t=>{
 const f=fixture(t),profile={concurrency:3},id={...f.identity,concurrency:3,profile:digest(profile)};
 const d=reference({...f,identity:id}),c=d.campaigns[0],caseIds=['rename','query','import'];
 const schedule=[0,1,2,0,1,2].map((slot,i)=>({caseId:caseIds[slot],repetition:i<3?1:2,slot:slot+1,queueIndex:i,startedAt:i<3?1:11,executionStartedAt:i<3?2:12,executionFinishedAt:i<3?9:19,finishedAt:i<3?10:20,providerWindows:[{index:1,threadId:'thread-'+i,turnId:'turn-'+i,startedAt:i<3?3:13,finishedAt:i<3?8:18}]}));
 c.turnProofs=Object.fromEntries(schedule.map(d=>{
  const cell=d.caseId+'-'+d.repetition,root='evidence/campaigns/ref/'+cell;
  fs.mkdirSync(path.join(f.base,root),{recursive:true});
  const w=d.providerWindows[0],at='campaigns/ref/'+cell+'/turn-'+w.index;
  return [cell,[{request:f.proof(at+'-request',{threadId:w.threadId}),result:f.proof(at+'-result',{threadId:w.threadId,turnId:w.turnId,status:'completed',providerWindow:w})}]];
 }));
 const summary={...c,profile,caseIds,repetitions:2,startedAt:0,finishedAt:20,dispatches:schedule};
 const verified=change=>{c.proof=f.proof('campaign',change);return verifyQualificationEvidence({base:f.base,qualification:d});};
 assert.equal(verified(summary).status,'PASS');
 for(const change of [
  x=>{x.dispatches[2].providerWindows=[];},
  x=>{x.dispatches[1].providerWindows=[{startedAt:8,finishedAt:9}];x.dispatches[4].providerWindows=[{startedAt:18,finishedAt:19}];},
  x=>{[x.dispatches[0],x.dispatches[1]]=[x.dispatches[1],x.dispatches[0]];},
  x=>{x.dispatches[1].slot=1;},
  x=>{delete x.dispatches;},
  x=>{x.dispatches[0].providerWindows[0].finishedAt--;}, // Still C3, but no exact receipt.
  x=>{x.dispatches[0].providerWindows[0].turnId='other';}
 ]){const altered=structuredClone(summary);change(altered);assert.ok(verified(altered).reasons.includes('PARALLEL_EXECUTION_UNPROVEN:ref'));}
 const original=c.turnProofs['rename-1'];c.turnProofs['rename-1']=c.turnProofs['query-1'];
 assert.ok(verified(summary).reasons.includes('PARALLEL_EXECUTION_UNPROVEN:ref'));
 c.turnProofs['rename-1']=original;delete c.turnProofs['rename-1'];
 assert.ok(verified(summary).reasons.includes('PARALLEL_EXECUTION_UNPROVEN:ref'));
});
test('legacy C2 campaigns without concurrency identity cannot be treated as serial',t=>{
 const f=fixture(t),profile={concurrency:2},d=reference({...f,identity:{...f.identity,profile:digest(profile)}}),c=d.campaigns[0];
 c.proof=f.proof('campaign',{...c,profile});
 assert.ok(verifyQualificationEvidence({base:d.base,qualification:d}).reasons.includes('CAMPAIGN_CONCURRENCY_PROFILE_BINDING:ref'));
});
