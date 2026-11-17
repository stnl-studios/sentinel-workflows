import {legacyQ20Proof} from './fixtures/legacy-q20-proof.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {completedNativeCase,reopeningInput} from './fixtures/current-completed-native.mjs';
import {retireActive} from './fixtures/current-reader-campaign.mjs';
import {prepareCurrentSetReplacement,finalizeCurrentSetReplacement} from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs';
import {captureCurrentExecution,validateCurrentReviewCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {retainedQ20TerminalReplacement,validateCurrentCandidate} from '../skills/workflows/stnl-slice-quality-manager/runtime/execution-current.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {currentImage} from './fixtures/current-native-seed.mjs';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';

import {begin} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const decode=bytes=>JSON.parse(Buffer.from(bytes));
const run=promisify(execFile);
const setSection=(text,name,body)=>text.replace(new RegExp(`(^## ${name}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu'),
  (_,heading)=>heading+body+'\n\n');
const approve=request=>({...structuredClone(request),decision:'approved',summary:'Controlled Q20 test review only.',
  evidenceDecisions:request.evidenceDecisions.map(item=>({...item,reason:'Retain the exact current local proof; only integral judgment is pending.'}))});
const reviewFor=proposal=>({globalReview:approve(proposal.reviewRequest.globalReview),
  deliveries:proposal.reviewRequest.deliveries.map(item=>({deliveryId:item.deliveryId,review:approve(item.review)}))});
async function emptyFixture(t,{terminal=false,single=false,independent=true}={}) {
  let f;
  if(single) {
    const image=await currentImage(t,{kind:'native-s1',behaviorCheck:true});
    f={image,root:image.f.root,specPath:image.f.specPath,
      head:(await run('git',['-C',image.f.root,'rev-parse','HEAD'])).stdout.trim(),
      delivery:decode((await captureCurrentExecution(image.f.specPath)).files.get('continuity.json')).deliveries[0]};
    await normalizedFormal(f);
  } else f=await completedNativeCase(t,{drift:terminal,independent,retire:false});
  if(terminal)await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const image=await captureCurrentExecution(f.specPath),snapshot=decode(image.files.get('approved-preparation.json'));
  const view={project:f.root,execution:f.image.f.execution,specPath:f.specPath,source:f.specPath,spec:path.dirname(f.specPath),
    authority:image.requirementsAuthority,activation:decode(image.activationBytes),snapshot,continuity:decode(image.files.get('continuity.json')),
    files:new Map([...image.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),
    artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8)]))};
  await retireActive(view);return {...f,source:await captureCurrentExecution(f.specPath)};
}

test('Q20 complete historical coverage refuses redundant reentry without allocation or commands',async t=>{
 const f=await emptyFixture(t),source=f.source;
 assert.equal(source.inspection.deliveries.length,0);assert.equal(source.inspection.state,'COMPLETE');
 const root=path.dirname(f.image.f.execution),before=await fs.readdir(root);
 await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',
  completedDeliveryIds:source.inspection.completed.filter(x=>x.deliveryId!==f.delivery.deliveryId).map(x=>x.deliveryId),terminalValidation:true}),{code:'REPLAN_REQUIRED'});
 assert.deepEqual(await fs.readdir(root),before);
 assert.deepEqual((await captureCurrentExecution(f.specPath)).files,source.files);
});

test('Q20 public admission refuses an already current integral certificate before allocation',async t=>{
  const f=await emptyFixture(t,{terminal:true});assert.equal(f.source.inspection.state,'COMPLETE');
  const ids=f.source.inspection.completed.filter(item=>item.deliveryId!==f.delivery.deliveryId).map(item=>item.deliveryId);
  await assert.rejects(()=>preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:ids,terminalValidation:true}),
    error=>error.code==='REPLAN_REQUIRED');
});

async function retainedImplementationCase(t) {
  const {specPath,predecessor}=await legacyQ20Proof(t);
  // Authenticate historical output using today's reader, not the producer copy.
  const complete=await captureCurrentExecution(specPath);
  assert.equal(predecessor.implementation.length,0);
  assert.equal(complete.inspection.state,'COMPLETE');
  assert.equal(complete.inspection.normalHandoff,null);
  const evidencePath=decode(complete.files.get('continuity.json')).deliveries[0].evidence.path;
  const snapshot=decode(complete.files.get('approved-preparation.json'));
  const currentFinal=decode(complete.files.get('continuity.json')).deliveries[0];
  const terminalBundle=decode(complete.files.get(evidencePath)),terminalRecord=terminalBundle.validation;
  const makeCase=()=>{
    const bundle=structuredClone(terminalBundle),record=bundle.validation;
    const implementation=structuredClone(record);
    implementation.kind='implementation-check';implementation.id='implementation-check-01';
    implementation.origin.operation='EXECUTE_SLICE';implementation.origin.preparationRevision=snapshot.preparationRevision-1;
    implementation.origin.operationAttemptId='1a111111-1111-4111-8111-111111111111';
    implementation.contract.terminal=null;bundle.implementation=[implementation];
    const current=structuredClone(currentFinal);current.counters.implementationChecks=1;
    const approved=structuredClone(snapshot),decision=approved.deliveries[0].review.evidenceDecisions[0];
    const predecessorBytes=Buffer.from(JSON.stringify({...predecessor,implementation:[implementation]})+'\n');
    const digest=`sha256:${createHash('sha256').update(predecessorBytes).digest('hex')}`;decision.evidenceSha256=digest;
    const originObject=bundle.objects.find(item=>item.id===record.sources.origin);
    const capsule=decode(Buffer.from(originObject.bytesBase64,'base64'));
    const origin=decode(Buffer.from(capsule.originUtf8,'utf8'));
    const request=decode(Buffer.from(capsule.validationRequestUtf8,'utf8'));
    request.format='stnl-current-validation-request-v1';
    request.base.evidenceSha256=digest;request.base.counters.implementationChecks=1;
    capsule.validationRequestUtf8=JSON.stringify(request);
    origin.terminalPreparationUtf8=JSON.stringify(approved)+'\n';capsule.originUtf8=JSON.stringify(origin);
    const capsuleBytes=Buffer.from(JSON.stringify(capsule));
    originObject.id=`sha256:${createHash('sha256').update(capsuleBytes).digest('hex')}`;
    originObject.bytesBase64=capsuleBytes.toString('base64');record.sources.origin=originObject.id;implementation.sources.origin=originObject.id;
    bundle.objects.sort((a,b)=>a.id.localeCompare(b.id));
    return {current,decision,bundle,record,approvedDelivery:approved.deliveries[0],leaf:approved.normativeProjection.deliveries[0],
      global:approved.normativeProjection.global,snapshot:approved,files:new Map([['approved-preparation.json',Buffer.from(JSON.stringify(approved)+'\n')]])};
  };
  return {makeCase,complete};
}

test('Q20 retained native v2 implementation binding accepts exact predecessor and rejects altered authority',async t=>{
  const {makeCase}=await retainedImplementationCase(t);
  const accepted=makeCase();assert.equal(retainedQ20TerminalReplacement(accepted),true);
  const rejected=mutate=>{const sample=makeCase();mutate(sample);assert.equal(retainedQ20TerminalReplacement(sample),false);};
  rejected(sample=>{sample.decision.evidenceSha256='sha256:'+'0'.repeat(64);});
  rejected(sample=>{const cap=decode(Buffer.from(sample.bundle.objects.find(x=>x.id===sample.record.sources.origin).bytesBase64,'base64'));
    const request=decode(Buffer.from(cap.validationRequestUtf8));request.base.counters.implementationChecks+=1;
    cap.validationRequestUtf8=JSON.stringify(request);const bytes=Buffer.from(JSON.stringify(cap));
    const object=sample.bundle.objects.find(x=>x.id===sample.record.sources.origin);object.id=`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    object.bytesBase64=bytes.toString('base64');sample.record.sources.origin=object.id;});
  rejected(sample=>{sample.current.deliveryId='00000000-0000-4000-8000-000000000000';});
  rejected(sample=>{sample.record.origin.preparationRevision-=1;});
  rejected(sample=>{sample.record.contract.delivery.taskResult='altered contract';});
  rejected(sample=>{sample.bundle.implementation[0].origin.operationAttemptId=sample.record.origin.operationAttemptId;});
  rejected(sample=>{sample.bundle.implementation[0].contract.recipe.dependencyReview='altered evidence contract';});
});

// Q18 re-prepares the delivery before the Q20 terminal reentry. A concluded native EXECUTE refusal of the
// earlier preparation stays in support and must not block the retained terminal replacement during CLOSE.
const withExecutionRefusal=(sample,mutate=()=>{})=>{
  const implementation=sample.bundle.implementation[0],origin=structuredClone(implementation.origin);
  origin.operationAttemptId=`2b222222-2222-4222-8222-${String(sample.bundle.support.length).padStart(12,'2')}`;
  const refusal={kind:'rejection',operationAttemptId:origin.operationAttemptId,origin,
    diagnostic:'Concluded malformed EXECUTE response retained before Q18.',consumedInvocations:1,round:1,
    sources:{...structuredClone(implementation.sources),verificationObservation:null}};
  mutate(refusal);sample.bundle.support.push(refusal);return sample;
};
test('Q20 retained replacement admits a superseded native EXECUTE refusal and nothing broader',async t=>{
  const {makeCase,complete}=await retainedImplementationCase(t);
  assert.equal(retainedQ20TerminalReplacement(withExecutionRefusal(makeCase())),true);
  const rejected=mutate=>assert.equal(retainedQ20TerminalReplacement(withExecutionRefusal(makeCase(),mutate)),false);
  rejected(item=>{item.origin.operation='VALIDATE_SLICE';});
  rejected(item=>{item.origin.transport='legacy';});
  rejected(item=>{item.origin.preparationRevision+=1;});
  rejected(item=>{item.origin.localRevision+=1;});
  rejected(item=>{item.origin.slice='slice-99';});
  rejected(item=>{item.origin.deliveryId='00000000-0000-4000-8000-000000000000';});
  const tooMany=withExecutionRefusal(makeCase());
  for(let index=2;index<=6;index+=1)withExecutionRefusal(tooMany);
  assert.equal(retainedQ20TerminalReplacement(tooMany),false);

  // The candidate reader reaches the same bundle through replacementFor: its support gate must agree.
  const candidate=sample=>{
    const files=new Map([...complete.files].map(([name,bytes])=>[name,Buffer.from(bytes)]));
    const continuity=decode(files.get('continuity.json'));
    const bundleBytes=Buffer.from(JSON.stringify(sample.bundle)+'\n');
    sample.current.evidence.sha256=`sha256:${createHash('sha256').update(bundleBytes).digest('hex')}`;
    continuity.deliveries[0]=sample.current;
    files.set(sample.current.evidence.path,bundleBytes);
    files.set('continuity.json',Buffer.from(JSON.stringify(continuity)+'\n'));
    files.set('approved-preparation.json',Buffer.from(JSON.stringify(sample.snapshot)+'\n'));
    return {files};
  };
  validateCurrentCandidate(candidate(makeCase()));
  validateCurrentCandidate(candidate(withExecutionRefusal(makeCase())));
  assert.throws(()=>validateCurrentCandidate(candidate(withExecutionRefusal(makeCase(),item=>{item.origin.localRevision+=1;}))));
});

for(const {single=false,independent=true}of [{},{single:true},{independent:false}])
 test(`Q20 ${single?'sole owner':independent?'independent siblings':'partial/full owners'} historical coverage needs no reopening`,async t=>{
  const f=await emptyFixture(t,{single,independent}),before=f.source;
  assert.equal(before.inspection.state,'COMPLETE');assert.equal(before.inspection.normalHandoff,null);
  const ids=before.inspection.completed.filter(x=>x.deliveryId!==f.delivery.deliveryId).map(x=>x.deliveryId);
  await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:ids,terminalValidation:true}),{code:'REPLAN_REQUIRED'});
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,before.files);
  // Current evidence corruption is still rejected despite historical approval.
  const current=decode(before.files.get('continuity.json')).completed.at(-1);
  const file=path.join(f.image.f.execution,current.evidence.path),bytes=await fs.readFile(file);
  await fs.writeFile(file,'{}\n');await assert.rejects(captureCurrentExecution(f.specPath));
  await fs.writeFile(file,bytes);
  assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,before.activationBytes);
 });

test('Q20 retains the whole local contract and exact final review, while ordinary Q19 still requires a real delta',async t=>{
  const f=await emptyFixture(t),base=reopeningInput(f.source,f.delivery.deliveryId,{terminalValidation:true});
  const task=`tasks/${f.delivery.slice}.md`,plan=`plans/${f.delivery.slice}.md`;
  const mutate=transform=>{const value=reopeningInput(f.source,f.delivery.deliveryId,{terminalValidation:true});transform(value);return value;};
  for(const field of ['Expected Tests','Existing Inputs','Protected Responsibilities']) {
    const value=mutate(value=>{for(const name of [plan,task])value.artifacts.set(name,Buffer.from(setSection(
      value.artifacts.get(name).toString(),field,field==='Existing Inputs'?'- `../../shared-config.json`':'Changed normative contract.')));});
    assert.throws(()=>prepareCurrentSetReplacement(value));
  }
  const changedRecipe=mutate(value=>{
    const snapshot=decode(f.source.files.get('approved-preparation.json'));
    const leaf=snapshot.normativeProjection.completed.find(item=>item.deliveryId===f.delivery.deliveryId);
    const recipe=structuredClone(leaf.verificationRecipe);recipe.checks[0].args.unshift({literal:'--test-reporter=tap'});
    for(const name of [plan,task])value.artifacts.set(name,Buffer.from(setSection(value.artifacts.get(name).toString(),
      'Verification Recipe','- Recipe: '+JSON.stringify(recipe))));
  });
  assert.throws(()=>prepareCurrentSetReplacement(changedRecipe),{code:'REPLAN_REQUIRED'});
  const q19=mutate(value=>{delete value.terminalValidation;for(const name of [plan,task])
    value.artifacts.set(name,Buffer.from(value.artifacts.get(name).toString().replace(/^- Local revision: (\d+)$/mu,
      (_,n)=>'- Local revision: '+(Number(n)+1))));});
  assert.throws(()=>prepareCurrentSetReplacement(q19),{code:'REPLAN_REQUIRED'});
  for(const flag of [null,'true',1])assert.throws(()=>prepareCurrentSetReplacement({...base,terminalValidation:flag}),{code:'INVALID_CURRENT_IMAGE'});
  const proposal=prepareCurrentSetReplacement(base),review=reviewFor(proposal),bad=structuredClone(review);
  bad.deliveries[0].review.examinedArtifactHashes[0].sha256='sha256:'+'0'.repeat(64);
  assert.throws(()=>finalizeCurrentSetReplacement({proposal,review:bad}),{code:'STALE_APPROVAL'});
  const final=finalizeCurrentSetReplacement({proposal,review});
  const altered=new Map(final.files);altered.set(task,Buffer.from(altered.get(task).toString().replace('Current action: VALIDATE_SLICE','Current action: none')));
  await assert.rejects(validateCurrentReviewCandidate({specPath:f.specPath,files:altered}));
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,f.source.files);
});

test('Q20 no dispatch is allocated when current historical coverage is complete',async t=>{
 const f=await emptyFixture(t),before=f.source;
 await assert.rejects(begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:before.inspection.activationId}),{code:'UNSUPPORTED_FORMAT'});
 assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,before.activationBytes);
});

test('Q20 public source gate refuses a partial owner, stale product/input and nonempty queue before allocation',async t=>{
  const f=await emptyFixture(t,{independent:false}),members=decode(f.source.files.get('continuity.json')).completed;
  const partial=members.find(item=>item.deliveryId!==f.delivery.deliveryId);
  const selected=members.filter(item=>item.deliveryId!==partial.deliveryId).map(item=>item.deliveryId);
  await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:selected,terminalValidation:true}),{code:'REPLAN_REQUIRED'});
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,f.source.files);
  const targetIds=members.filter(item=>item.deliveryId!==f.delivery.deliveryId).map(item=>item.deliveryId);
  for(const name of [f.productFile,f.testFile]) {
    const file=path.join(f.root,name),bytes=await fs.readFile(file);await fs.appendFile(file,'\n// changed after retained proof\n');
    await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:targetIds,terminalValidation:true}));
    await fs.writeFile(file,bytes);
  }
  const active=await completedNativeCase(t,{drift:false,independent:true,retire:false});
  const source=await captureCurrentExecution(active.specPath),continuity=decode(source.files.get('continuity.json'));
  await assert.rejects(preparePreparationCandidate({specPath:active.specPath,operation:'REPLAN',
    completedDeliveryIds:[continuity.deliveries[0].deliveryId],terminalValidation:true}),{code:'REPLAN_REQUIRED'});
  assert.deepEqual((await captureCurrentExecution(active.specPath)).files,source.files);
});
