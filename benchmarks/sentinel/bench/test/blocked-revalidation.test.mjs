import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {collectBlockedRevalidationProof,decideBlockedRevalidation,blockedRevalidationPrompt} from '../blocked-revalidation.mjs';
import {sha256} from '../core.mjs';import {qualificationDigest as digest} from '../qualification.mjs';
function fixture(t){
 const temp=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../temp/blocked-revalidation-tests');fs.mkdirSync(temp,{recursive:true});
 const workspace=fs.mkdtempSync(path.join(temp,'test-'));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
 const specPath=path.join(workspace,'specs/test'),execution=path.join(specPath,'execution'),op=path.join(workspace,'tmp/sentinel/op');
 fs.mkdirSync(execution,{recursive:true});fs.mkdirSync(op,{recursive:true});
 const write=(file,data)=>{fs.writeFileSync(file,JSON.stringify(data));return sha256(fs.readFileSync(file))};
 const owner={operationAttemptId:'attempt',deliveryId:'delivery',slice:'slice-01',operation:'VALIDATE_SLICE'};
 write(path.join(workspace,'product.txt'),{value:1});
 const bundle={validation:{origin:owner,testedWork:{entries:[{kind:'file',path:'product.txt',mode:fs.statSync(path.join(workspace,'product.txt')).mode&0o777,sha256:sha256(fs.readFileSync(path.join(workspace,'product.txt')))}]}},support:[]};const evidenceHash=write(path.join(execution,'bundle.json'),bundle);
 const continuity={deliveries:[{slice:'slice-01',deliveryId:'delivery',normalization:null,evidence:{path:'bundle.json',sha256:evidenceHash}}]};
 const artifacts=[{path:'continuity.json',sha256:write(path.join(execution,'continuity.json'),continuity)},{path:'approved-preparation.json',sha256:write(path.join(execution,'approved-preparation.json'),{})},{path:'bundle.json',sha256:evidenceHash}];
 write(path.join(execution,'activation.json'),{activationId:'activation',activeAttempt:null,lastAttempt:{outcome:'recorded',operationAttemptId:'attempt'},artifacts});
 const receiptPath=path.join(op,'receipt.json'),requestPath=path.join(op,'request.json');
 write(receiptPath,{owner,operation:'VALIDATE_SLICE',status:'RUNNER_RESPONSE_CAPTURED',semanticResponseStatus:'BLOCKED',captureFailure:null,error:null,verification:{status:'completed'}});
 write(requestPath,{owner,terminal:{objective:'same terminal target'}});
 const authority={specPath,current:{exitCode:0,output:{state:'VALIDATION_BLOCKED',normalHandoff:null,activationId:'activation',deliveries:[{slice:'slice-01',deliveryId:'delivery',formalStatus:'BLOCKED',auxiliaryStatus:'TESTS_PASS',observedValidation:'revalidation-required',evidenceSha256:evidenceHash}]}}};
 const identity={engine:'e',fixture:'f'};
 const checkpoint={identity,caseId:'test',pending:null,pendingEffect:null,blockedRevalidationAttempts:0,originalCaseDeadline:200,originalCampaignDeadline:300,lastCompletedAttempt:{...owner,stage:'VALIDATE_SLICE',status:'completed',threadId:'thread',turnId:'turn'}};
 const args={manifest:{workspace,specPath},authority,slice:'slice-01',receiptPath,requestPath};
 const proof=collectBlockedRevalidationProof(args);
 return{args,write,execution,decision:{policy:{enabled:true,maxAttempts:1,allowedPrerequisites:['stable-verification-launcher']},identity,authority,checkpoint,proof,now:100,budget:{caseDeadline:200,campaignDeadline:300,turns:1,unchanged:0,reportedTokens:1,limits:{maxTurns:5,maxNoProgress:2,maxReportedTokens:100}},delegation:{kind:'explicit-user-delegation',action:'revalidate-concluded-formal-blocked',instructionRef:'user:explicit',caseId:'test',identityDigest:digest(identity)},prerequisite:{kind:'stable-verification-launcher'}}};
}
test('SIMULATED local collector reads bound controls without changing bytes; causal gap prevents dispatch',t=>{
 const f=fixture(t),before=fs.readFileSync(f.args.receiptPath);
 assert.equal(f.decision.proof.status,'OBSERVED');assert.equal(f.decision.proof.observation.terminal,true);
 const d=decideBlockedRevalidation(f.decision);assert.deepEqual(d.reasons,['STABLE_LAUNCHER_PROOF_REQUIRED']);assert.equal(d.dispatchAllowed,false);
 assert.match(blockedRevalidationPrompt({decision:d}),/Não inventar normalHandoff/);
 assert.deepEqual(fs.readFileSync(f.args.receiptPath),before);
});
test('default disabled and model claims never authorize',t=>{
 const f=fixture(t);delete f.decision.policy;f.decision.prerequisite.resolved=true;f.decision.prerequisite.modelSays='fixed';
 assert.ok(decideBlockedRevalidation(f.decision).reasons.includes('POLICY_DISABLED'));
 assert.equal(decideBlockedRevalidation(f.decision).dispatchAllowed,false);
 assert.throws(()=>blockedRevalidationPrompt({decision:{dispatchAllowed:true}}));
});
test('SIMULATED gates reject pending effects, missing delegation, exhausted credit and deadline reset',t=>{
 const f=fixture(t);
 for(const [mutate,reason] of [
 [d=>d.checkpoint.pending={},'UNSETTLED_EFFECT'],
 [d=>d.checkpoint.pendingEffect={},'UNSETTLED_EFFECT'],
 [d=>d.delegation=null,'DELEGATED_AUTHORIZATION_REQUIRED'],
 [d=>d.checkpoint.blockedRevalidationAttempts=1,'RETRY_CREDIT_UNAVAILABLE'],
 [d=>d.budget.caseDeadline=250,'ORIGINAL_DEADLINE_BINDING'],
 [d=>d.now=200,'BUDGET_DEADLINE'],
 [d=>d.checkpoint.lastCompletedAttempt.status='interrupted','COMPLETED_VALIDATION_REQUIRED'],
 [d=>d.identity={...d.identity,engine:'changed'},'IDENTITY_BINDING'],
 [d=>d.proof.observation.slice='other','COLLECTED_PROOF_REQUIRED']
 ]){const d=structuredClone(f.decision);mutate(d);assert.ok(decideBlockedRevalidation(d).reasons.includes(reason),reason)}
});
test('SIMULATED collector rejects hash drift, symlink and outside operation paths',t=>{
 for(const mode of ['hash','symlink','outside']){
  const f=fixture(t);
  if(mode==='hash')fs.appendFileSync(path.join(f.execution,'bundle.json'),' ');
  if(mode==='symlink'){fs.renameSync(f.args.receiptPath,f.args.receiptPath+'.real');fs.symlinkSync(f.args.receiptPath+'.real',f.args.receiptPath)}
  if(mode==='outside'){f.args.receiptPath=path.join(f.execution,'bundle.json');f.args.requestPath=f.args.receiptPath}
  assert.equal(collectBlockedRevalidationProof(f.args).status,'BLOCKED',mode);
 }
});
test('SIMULATED published refusal, active owner and wrong predecessor remain blocked',t=>{
 const f=fixture(t);
 for(const change of [o=>o.activeAttempt={},o=>o.supportKinds=['rejection'],o=>o.error='uncertain',o=>o.lastAttempt.outcome='aborted']){
  const d=structuredClone(f.decision);change(d.proof.observation);const {digest:old,...body}=d.proof;d.proof.digest=digest(body);
  assert.ok(decideBlockedRevalidation(d).reasons.includes('CONCLUDED_PUBLISHED_BLOCKED_REQUIRED'));
 }
});

test('SIMULATED stable launcher allows only conditional new request, never proves cause or PASS',t=>{
 const f=fixture(t),evidence=path.join(f.args.manifest.workspace,'evidence');fs.mkdirSync(evidence);
 f.args.manifest.evidence=evidence;f.args.launcherProofPath=path.join(evidence,'launcher.json');
 const p={kind:'stable-verification-launcher-probe',scope:'LOCAL_NO_RECIPE',predecessorEvidenceSha256:f.decision.proof.observation.evidenceSha256,authorityDigest:digest(f.decision.authority),launcher:'direct-node-no-shell-tail',observations:[1,2].map(()=>({exitCode:0,environmentSha256:'a'.repeat(64),argv:['/node','/safe-observer.mjs']}))};
 f.write(f.args.launcherProofPath,p);f.decision.proof=collectBlockedRevalidationProof(f.args);
 const d=decideBlockedRevalidation(f.decision);assert.equal(d.status,'CONDITIONAL_REVALIDATION_REQUEST');assert.equal(d.dispatchAllowed,false);assert.match(blockedRevalidationPrompt({decision:d}),/begin --retry-blocked/);
 p.observations[1].environmentSha256='b'.repeat(64);f.write(f.args.launcherProofPath,p);
 f.decision.proof=collectBlockedRevalidationProof(f.args);assert.ok(decideBlockedRevalidation(f.decision).reasons.includes('STABLE_LAUNCHER_PROOF_REQUIRED'));
 fs.appendFileSync(path.join(f.args.manifest.workspace,'product.txt'),' ');f.decision.proof=collectBlockedRevalidationProof(f.args);
 assert.ok(decideBlockedRevalidation(f.decision).reasons.includes('UNCHANGED_PRODUCT_PROOF_REQUIRED'));
});
