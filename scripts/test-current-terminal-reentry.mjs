import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ChildProcess} from 'node:child_process';
import {completedNativeCase,reopeningInput} from './fixtures/current-completed-native.mjs';
import {retireActive} from './fixtures/current-reader-campaign.mjs';
import {prepareCurrentSetReplacement,finalizeCurrentSetReplacement} from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs';
import {captureCurrentExecution,validateCurrentReviewCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {currentImage} from './fixtures/current-native-seed.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {publishPreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {preparePlanCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs';
import {serializePlanPathClaims} from '../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs';
import {begin,reserveDispatch} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

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

test('Q20 pure review reopens the same integral owner with current local PASS and no command',async t=>{
  const f=await emptyFixture(t),source=f.source,input=reopeningInput(source,f.delivery.deliveryId,{terminalValidation:true});
  assert.equal(source.inspection.deliveries.length,0);assert.equal(source.inspection.state,'VALIDATION_BLOCKED');
  const spawn=ChildProcess.prototype.spawn;let commands=0;
  ChildProcess.prototype.spawn=function(){commands+=1;throw new Error('Q20 preparation must not execute a recipe');};
  let result,proposal,inspection;
  try {
    proposal=prepareCurrentSetReplacement(input);result=finalizeCurrentSetReplacement({proposal,review:reviewFor(proposal)});
    inspection=await validateCurrentReviewCandidate({specPath:f.specPath,files:result.files});
  } finally {ChildProcess.prototype.spawn=spawn;}
  assert.equal(commands,0);
  const old=decode(source.files.get('continuity.json')),next=decode(result.files.get('continuity.json'));
  const prior=old.completed.find(item=>item.deliveryId===f.delivery.deliveryId),current=next.deliveries[0];
  assert.equal(current.deliveryId,prior.deliveryId);assert.equal(current.slice,prior.slice);assert.equal(current.localRevision,prior.localRevision);
  assert.deepEqual(current.counters,prior.counters);assert.deepEqual(current.baseline,prior.baseline);
  assert.equal(current.validation,'current');assert.equal(current.lastDiagnostic,null);assert.equal(next.nextSliceOrdinal,old.nextSliceOrdinal);
  assert.equal(result.snapshot.preparationRevision,decode(source.files.get('approved-preparation.json')).preparationRevision+1);
  for(const member of [...next.deliveries,...next.completed]) {
    const before=decode(source.files.get(member.evidence.path)),after=decode(result.files.get(member.evidence.path));
    const {currentAuthoritySha256:ignored,...rest}=before;assert.deepEqual(after,{...rest,currentAuthoritySha256:member.authoritySha256});
  }
  assert.equal(inspection.deliveries[0].formalStatus,'PASS');assert.equal(inspection.deliveries[0].observedValidation,'current');
  assert.deepEqual(inspection.normalHandoff,{operation:'VALIDATE_SLICE',slice:prior.slice,deliveryId:prior.deliveryId});
  assert.equal(proposal.reviewRequest.deliveries[0].review.evidenceDecisions[0].disposition,'retain-current');
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,source.files);
});

test('Q20 public admission refuses an already current integral certificate before allocation',async t=>{
  const f=await emptyFixture(t,{terminal:true});assert.equal(f.source.inspection.state,'COMPLETE');
  const ids=f.source.inspection.completed.filter(item=>item.deliveryId!==f.delivery.deliveryId).map(item=>item.deliveryId);
  await assert.rejects(()=>preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:ids,terminalValidation:true}),
    error=>error.code==='REPLAN_REQUIRED');
});

for(const {single=false,independent=true}of [{},{single:true},{independent:false}])
  test(`Q20 public ${single?'sole owner':independent?'independent siblings':'dependent partial/full owners'} publishes reviewed bytes and mechanically reaches integral COMPLETE`,async t=>{
  const f=await emptyFixture(t,{single,independent}),input=reopeningInput(f.source,f.delivery.deliveryId,{terminalValidation:true});
  const old=decode(f.source.files.get('continuity.json'));
  const draft=single?JSON.parse((await run(process.execPath,[path.resolve('skills/workflows/stnl-plan-reviewer/runtime/prepare-task-candidate.mjs'),
    '--spec-path',f.specPath,'--operation','REPLAN','--completed-delivery-ids',JSON.stringify(input.completedDeliveryIds),
    '--terminal-validation','true'],{cwd:'/tmp'})).stdout):await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',
    completedDeliveryIds:input.completedDeliveryIds,terminalValidation:true});
  const options={specPath:f.specPath,candidateExecutionRoot:draft.candidateExecutionRoot};
  for(const [name,bytes]of input.artifacts) {
    const target=path.join(draft.candidateExecutionRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);
  }
  await preparePlanCandidate(options);
  const proposal=await publishPreparationCandidate(options);
  assert.equal(proposal.status,'AWAITING_REVIEW');assert.equal(proposal.publication,'not-started');
  const serialized=await serializePlanPathClaims(options);
  for(const [name,bytes]of serialized.proposal.files)
    assert.deepEqual(await fs.readFile(path.join(draft.candidateExecutionRoot,name)),bytes);
  const review=reviewFor({reviewRequest:proposal.reviewRequest}),bad=structuredClone(review);
  bad.deliveries[0].review.evidenceDecisions[0].evidenceSha256='sha256:'+'0'.repeat(64);
  await assert.rejects(publishPreparationCandidate({...options,reviewDecision:bad}),{code:'STALE_APPROVAL'});
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,f.source.files);
  const installed=await publishPreparationCandidate({...options,reviewDecision:review});
  assert.equal(installed.publication,'confirmed');assert.equal(installed.cleanup,'complete');
  const reopened=await captureCurrentExecution(f.specPath),current=decode(reopened.files.get('continuity.json')).deliveries[0];
  for(const [name,bytes]of serialized.proposal.files)assert.deepEqual(Buffer.from(reopened.files.get(name)),bytes);
  assert.equal(current.validation,'current');assert.equal(current.localRevision,f.delivery.localRevision);
  assert.deepEqual(current.counters,old.completed.find(item=>item.deliveryId===current.deliveryId).counters);
  assert.equal(reopened.inspection.state,'IMPLEMENTED_AWAITING_VALIDATION');assert.equal(reopened.inspection.deliveries[0].formalStatus,'PASS');
  assert.ok(reopened.inspection.diagnostics.some(item=>item.field==='terminal'));
  assert.equal(reopened.inspection.normalHandoff.operation,'VALIDATE_SLICE');
  // Controlled response below is a mechanical protocol proof, never live model acceptance.
  await normalizedFormal({...f,delivery:current},{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const complete=await captureCurrentExecution(f.specPath),after=decode(complete.files.get('continuity.json')).deliveries[0];
  assert.equal(complete.inspection.state,'COMPLETE');assert.equal(complete.inspection.normalHandoff,null);
  assert.equal(after.localRevision,current.localRevision);assert.equal(after.counters.validationAttempts,current.counters.validationAttempts+1);
  assert.equal(after.counters.implementationChecks,current.counters.implementationChecks);
  assert.deepEqual(after.baseline,current.baseline);
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

test('Q20 terminal pending refuses a local-only dispatch without creating origin or request',async t=>{
  const f=await emptyFixture(t),input=reopeningInput(f.source,f.delivery.deliveryId,{terminalValidation:true});
  const proposal=prepareCurrentSetReplacement(input),final=finalizeCurrentSetReplacement({proposal,review:reviewFor(proposal)});
  // Install only through the public producer, using a second exact review of its final bytes.
  const draft=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:input.completedDeliveryIds,terminalValidation:true});
  for(const [name,bytes]of input.artifacts) {const target=path.join(draft.candidateExecutionRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
  const options={specPath:f.specPath,candidateExecutionRoot:draft.candidateExecutionRoot},pending=await publishPreparationCandidate(options);
  await publishPreparationCandidate({...options,reviewDecision:reviewFor({reviewRequest:pending.reviewRequest})});
  const before=await captureCurrentExecution(f.specPath),start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:before.inspection.activationId});
  const namespaces=await fs.readdir(path.join(f.root,'tmp/sentinel'));
  assert.equal(namespaces.length,1);
  const operationRoot=path.join(f.root,'tmp/sentinel',namespaces[0],start.handle.operationId);
  const tree=async root=>{
    const files=[];
    for(const entry of await fs.readdir(root,{withFileTypes:true})) {
      const target=path.join(root,entry.name);
      if(entry.isDirectory())for(const [name,bytes]of await tree(target))files.push([entry.name+'/'+name,bytes]);
      else files.push([entry.name,await fs.readFile(target)]);
    }
    return files.sort(([a],[b])=>a.localeCompare(b));
  };
  const beforeRefusal=await tree(operationRoot);
  await assert.rejects(reserveDispatch(start.handle),{code:'EVIDENCE_INCOMPLETE'});
  assert.deepEqual(await tree(operationRoot),beforeRefusal);
  const terminal=await reserveDispatch(start.handle,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const request=decode(await fs.readFile(terminal.requestFile));assert.ok(request.terminal);
  assert.equal(request.owner.localRevision,decode(final.files.get('continuity.json')).deliveries[0].localRevision);
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
