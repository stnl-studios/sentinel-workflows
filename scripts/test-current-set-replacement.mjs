import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {reviewInput} from './fixtures/current-completed-pristine.mjs';
import {publishCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/current-local-review.mjs';
import {prepareCurrentLocalReview,prepareCurrentSetReplacement,finalizeCurrentSetReplacement} from
  '../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs';
import {captureCurrentExecution,validateCurrentReviewCandidate} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {validateCurrentCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-current.mjs';
import {inspectPostConversionEvidence} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';

const decode=bytes=>JSON.parse(Buffer.from(bytes));
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)
  ?`[${value.map(canonical).join(',')}]`
  :`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`;
const projected=(tag,value)=>sha(Buffer.concat([Buffer.from(`stnl-ec1/${tag}/v1\0`),Buffer.from(canonical(value))]));
const cloneFiles=files=>new Map([...files].map(([name,bytes])=>[name,Buffer.from(bytes)]));

// Negative candidates only: reseal current metadata so source-chain checks,
// rather than a stale outer digest, must reject the adulterated proof.
function replaceCandidateBundle(files,id,bundle) {
  const name=`evidence/${id}.json`,bytes=Buffer.from(canonical(bundle)+'\n'),digest=sha(bytes);
  files.set(name,bytes);
  const continuity=decode(files.get('continuity.json'));
  continuity.completed.find(item=>item.deliveryId===id).evidence.sha256=digest;
  files.set('continuity.json',Buffer.from(canonical(continuity)+'\n'));
  const snapshot=decode(files.get('approved-preparation.json'));
  snapshot.completed.find(item=>item.deliveryId===id).evidenceSha256=digest;
  snapshot.globalReview.evidenceDecisions.find(item=>item.deliveryId===id).evidenceSha256=digest;
  files.set('approved-preparation.json',Buffer.from(canonical(snapshot)+'\n'));
  validateCurrentCandidate({files});
}
function alterCapturedOrigin(bundle,record,edit) {
  const previous=record.sources.origin,object=bundle.objects.find(item=>item.id===previous);
  const capsule=decode(Buffer.from(object.bytesBase64,'base64'));edit(capsule);
  const bytes=Buffer.from(canonical(capsule)+'\n'),id=sha(bytes);record.sources.origin=id;
  bundle.objects=bundle.objects.filter(item=>item.id!==previous)
    .concat({id,bytesBase64:bytes.toString('base64')}).sort((a,b)=>a.id.localeCompare(b.id));
}

function inputFor(image) {
  const snapshot=decode(image.files.get('approved-preparation.json'));
  const continuity=decode(image.files.get('continuity.json'));
  const active=continuity.deliveries.map(item=>item.slice.slice(6));
  // The proposed human indexes remove active rows; no leaf, evidence or source
  // object is authored here. Only the current envelope/index may be recomposed.
  const artifacts=new Map(['plan.md','tasks.md'].map(name=>[name,Buffer.from(
    Buffer.from(image.files.get(name)).toString('utf8').split('\n')
      .filter(line=>!active.some(selector=>line.includes(`| ${selector} - `))).join('\n'))]));
  return {context:image.context,requirementsAuthority:image.requirementsAuthority,
    previous:{activationBytes:Buffer.from(image.activationBytes),files:cloneFiles(image.files)},artifacts,
    completedDeliveryIds:[...snapshot.completed,...snapshot.deliveries].map(item=>item.deliveryId)};
}
function controlledReview(proposal) {
  return {globalReview:{...structuredClone(proposal.reviewRequest.globalReview),decision:'approved',
    summary:'Controlled mechanical Q18 decision; not an official independent review.',
    evidenceDecisions:proposal.reviewRequest.globalReview.evidenceDecisions.map(item=>({...item,
      reason:'Controlled review retains literal sources and equivalent ownership for these exact final bytes.'}))},deliveries:[]};
}

async function composeVerified(input,specPath) {
  const methods=['execFile','execFileSync','spawn','spawnSync','fork','exec','execSync'];
  const saved=methods.map(name=>[name,childProcess[name]]),spawn=childProcess.ChildProcess.prototype.spawn;
  const deny=()=>{throw new Error('Q18 must not start a recipe or runner');};
  for(const name of methods)childProcess[name]=deny;
  childProcess.ChildProcess.prototype.spawn=deny;syncBuiltinESMExports();
  try {
    const proposal=prepareCurrentSetReplacement(input);
    const result=finalizeCurrentSetReplacement({proposal,review:controlledReview(proposal)});
    // Existing semantic proof, historical ownership and live product checks;
    // no publisher and no new command, judgment, record or activation.
    await validateCurrentReviewCandidate({specPath,files:result.files});
    return {proposal,result};
  } finally {
    for(const [name,fn] of saved)childProcess[name]=fn;
    childProcess.ChildProcess.prototype.spawn=spawn;syncBuiltinESMExports();
  }
}

test('Q18 composes A completed and B current PASS in memory with exact retained proofs',async t=>{
  // This helper authors only the predecessor. No authored retirement, reseal,
  // installation or synthesized native judgment is used as the Q18 output.
  const fixture=await completedNativeCase(t,{drift:false});
  const image=await captureCurrentExecution(fixture.specPath),input=inputFor(image);
  const before=decode(image.files.get('continuity.json'));
  assert.equal(before.completed.length,1);assert.equal(before.deliveries.length,1);
  assert.equal(image.inspection.deliveries[0].formalStatus,'PASS');
  const oldSnapshot=decode(image.files.get('approved-preparation.json'));
  const {proposal,result}=await composeVerified(input,fixture.specPath);
  const bySlice=new Map([...before.completed,...before.deliveries].map(item=>[item.slice,item.deliveryId]));
  const expectedLeaves=[...oldSnapshot.normativeProjection.completed,...oldSnapshot.normativeProjection.deliveries]
    .map(leaf=>({...leaf,obligations:leaf.obligations.map(item=>({...item,
      fullOwner:item.fullOwner.startsWith('delivery:')?item.fullOwner:'delivery:'+bySlice.get(item.fullOwner)}))}))
    .sort((a,b)=>a.deliveryId.localeCompare(b.deliveryId));
  const expectedGlobal={...oldSnapshot.normativeProjection.global,order:[]};
  const expectedCompleted=[...before.completed,...before.deliveries].map(current=>{
    const authoritySha256=projected('delivery',expectedLeaves.find(leaf=>leaf.deliveryId===current.deliveryId));
    const original=image.files.get(current.evidence.path),bundle=decode(original);
    const bytes=authoritySha256===current.authoritySha256?Buffer.from(original)
      :Buffer.from(canonical({...bundle,currentAuthoritySha256:authoritySha256})+'\n');
    return {...structuredClone(current),authoritySha256,evidence:{...current.evidence,sha256:sha(bytes)}};
  }).sort((a,b)=>a.deliveryId.localeCompare(b.deliveryId));
  assert.deepEqual(proposal.reviewRequest,{globalReview:{scope:'set',
    authoritySha256:projected('global-review',{requirementsAuthority:image.requirementsAuthority,
      global:expectedGlobal,deliveryIds:[],completed:expectedLeaves}),
    examinedArtifactHashes:['plan.md','tasks.md'].map(name=>({path:name,sha256:sha(input.artifacts.get(name))})),
    evidenceDecisions:expectedCompleted
      .map(item=>({deliveryId:item.deliveryId,evidenceSha256:item.evidence.sha256,disposition:'retain-current',reason:''}))},deliveries:[]});
  const after=decode(result.files.get('continuity.json'));
  assert.deepEqual(after,{...before,deliveries:[],completed:expectedCompleted});
  assert.equal(after.nextSliceOrdinal,before.nextSliceOrdinal);
  assert.equal(result.snapshot.preparationRevision,oldSnapshot.preparationRevision+1);
  assert.equal(result.snapshot.requirementsAuthority,oldSnapshot.requirementsAuthority);
  assert.deepEqual(result.snapshot.normativeProjection.completed,expectedLeaves);
  assert.deepEqual(result.snapshot.normativeProjection.deliveries,[]);
  assert.deepEqual(result.snapshot.normativeProjection.global,expectedGlobal);
  for(const current of after.completed) {
    const old=decode(image.files.get(current.evidence.path)),next=decode(result.files.get(current.evidence.path));
    assert.deepEqual(next,{...old,currentAuthoritySha256:current.authoritySha256});
    assert.deepEqual(next.objects,old.objects,'all original captured bytes and object IDs remain literal');
    assert.deepEqual(next.validation,old.validation,'the existing PASS record is not reauthored');
    assert.equal(sha(result.files.get(current.evidence.path)),current.evidence.sha256);
    for(const group of ['plans','tasks'])assert.equal(result.files.has(`${group}/${current.slice}.md`),false);
  }
  assert.equal(result.files.has('activation.json'),false);
  const untouched=await captureCurrentExecution(fixture.specPath);
  assert.deepEqual(untouched.activationBytes,image.activationBytes);
  assert.deepEqual(untouched.files,image.files);

  await t.test('missing and altered approval decisions cannot finalize',()=>{
    assert.throws(()=>finalizeCurrentSetReplacement({proposal,review:null}),{code:'STALE_APPROVAL'});
    const variants=[
      review=>{review.globalReview.decision='denied';},
      review=>{review.globalReview.scope='slice';},
      review=>{review.globalReview.authoritySha256='sha256:'+'0'.repeat(64);},
      review=>{review.globalReview.examinedArtifactHashes[0].sha256='sha256:'+'0'.repeat(64);},
      review=>{review.globalReview.evidenceDecisions.pop();},
      review=>{review.globalReview.evidenceDecisions[0].deliveryId='33333333-3333-4333-8333-333333333333';},
      review=>{review.globalReview.evidenceDecisions[0].evidenceSha256='sha256:'+'0'.repeat(64);},
      review=>{const id=review.globalReview.evidenceDecisions[0].deliveryId;
        review.globalReview.evidenceDecisions[0].evidenceSha256=[...before.completed,...before.deliveries]
          .find(item=>item.deliveryId===id).evidence.sha256;},
      review=>{review.globalReview.evidenceDecisions[0].disposition='revalidate';},
      review=>{review.globalReview.evidenceDecisions[0].reason='';},
      review=>{review.deliveries=[{}];},
    ];
    for(const change of variants) {
      const review=controlledReview(proposal);change(review);
      assert.throws(()=>finalizeCurrentSetReplacement({proposal,review}),error=>
        ['STALE_APPROVAL','INVALID_CURRENT_IMAGE'].includes(error?.code));
    }
  });
  await t.test('selection cannot duplicate, invent, lose or reopen an identity',()=>{
    const ids=input.completedDeliveryIds;
    for(const selected of [[...ids,ids[0]],['33333333-3333-4333-8333-333333333333'],[ids[0]],[]])
      assert.throws(()=>prepareCurrentSetReplacement({...input,completedDeliveryIds:selected}),error=>
        ['INVALID_CURRENT_IMAGE','UNSUPPORTED_FORMAT'].includes(error?.code));
    assert.deepEqual(prepareCurrentSetReplacement({...input,completedDeliveryIds:[...ids].reverse()})
      .reviewRequest,proposal.reviewRequest,'selection order does not change membership');
    assert.throws(()=>prepareCurrentSetReplacement({...input,artifacts:new Map([...input.artifacts,
      ['tasks/slice-02.md',image.files.get('tasks/slice-02.md')]])}),{code:'INVALID_CURRENT_IMAGE'});
  });
  await t.test('approval binds content after proposal, independent of mutated output buffers',()=>{
    const candidate=prepareCurrentSetReplacement(input),review=controlledReview(candidate);
    candidate.files.get('plan.md').fill(0);
    assert.deepEqual(finalizeCurrentSetReplacement({proposal:candidate,review}).files.get('plan.md'),input.artifacts.get('plan.md'));
    const altered=inputFor(image),stale=prepareCurrentSetReplacement(altered);
    altered.artifacts.set('plan.md',Buffer.concat([altered.artifacts.get('plan.md'),Buffer.from('\n')]));
    assert.throws(()=>finalizeCurrentSetReplacement({proposal:stale,review:controlledReview(stale)}),{code:'STALE_APPROVAL'});
    const source=inputFor(image),old=prepareCurrentSetReplacement(source);
    source.previous.files.get(before.deliveries[0].evidence.path)[0]=0;
    assert.throws(()=>finalizeCurrentSetReplacement({proposal:old,review:controlledReview(old)}));
    const base=inputFor(image),prior=prepareCurrentSetReplacement(base),activation=decode(base.previous.activationBytes);
    activation.previousActivationId=activation.activationId;
    activation.activationId='33333333-3333-4333-8333-333333333333';activation.sequence+=1;activation.lastAttempt=null;
    base.previous.activationBytes=Buffer.from(canonical(activation)+'\n');
    assert.throws(()=>finalizeCurrentSetReplacement({proposal:prior,review:controlledReview(prior)}),{code:'STALE_APPROVAL'});
  });
  await t.test('review does not dispense with retained proof or product equivalence',async()=>{
    const corrupted=cloneFiles(result.files),current=after.completed[0];
    const bundle=decode(corrupted.get(current.evidence.path));
    bundle.objects[0].bytesBase64=Buffer.from('changed captured bytes').toString('base64');
    corrupted.set(current.evidence.path,Buffer.from(canonical(bundle)+'\n'));
    await assert.rejects(()=>validateCurrentReviewCandidate({specPath:fixture.specPath,files:corrupted}),
      {code:'EVIDENCE_INCOMPLETE'});
    const product=path.join(fixture.root,fixture.productFile),bytes=await fs.readFile(product);
    try {
      await fs.appendFile(product,'// changed after the approved proof\n');
      await assert.rejects(()=>validateCurrentReviewCandidate({specPath:fixture.specPath,files:result.files}),
        {code:'EVIDENCE_STALE'});
    } finally {await fs.writeFile(product,bytes);}
  });
});

test('Q18 preserves noninitial local revision and consumed counters from a reviewed current PASS',async t=>{
  const fixture=await completedNativeCase(t,{drift:false});
  // Existing local-review publication and controlled formal are predecessor
  // setup only. No Q19 or Q18 publication is implemented or executed here.
  const original=await captureCurrentExecution(fixture.specPath),local=reviewInput(original,1,fixture.delivery.slice);
  const localProposal=prepareCurrentLocalReview(local);
  const review={...localProposal.reviewRequest,decision:'approved',
    summary:'Controlled predecessor setup; not an official independent judgment.',
    evidenceDecisions:localProposal.reviewRequest.evidenceDecisions.map(item=>({...item,
      reason:'The predecessor private recipe requires revalidation before Q18 setup.'}))};
  assert.equal((await publishCurrentLocalReview({specPath:fixture.specPath,slice:fixture.delivery.slice,
    planBytes:local.planBytes,reviewedTaskBytes:local.reviewedTaskBytes,
    currentTaskBytes:local.currentTaskBytes,review})).publication,'confirmed');
  const awaiting=await captureCurrentExecution(fixture.specPath);
  assert.equal(awaiting.inspection.deliveries[0].formalStatus,null);
  assert.equal(awaiting.inspection.deliveries[0].persistedValidation,'revalidation-required');
  assert.equal(awaiting.inspection.normalHandoff.operation,'VALIDATE_SLICE');
  assert.deepEqual(awaiting.inspection.deliveries[0].counters,original.inspection.deliveries[0].counters);
  await normalizedFormal(fixture,{responseVariant:'stnl-current-native-judgment-v1'});
  const source=await captureCurrentExecution(fixture.specPath),before=decode(source.files.get('continuity.json'));
  assert.equal(before.deliveries[0].localRevision,2);
  assert.equal(source.inspection.deliveries[0].formalStatus,'PASS');
  const {result}=await composeVerified(inputFor(source),fixture.specPath),after=decode(result.files.get('continuity.json'));
  for(const old of [...before.completed,...before.deliveries]) {
    const current=after.completed.find(item=>item.deliveryId===old.deliveryId);
    assert.equal(current.slice,old.slice);assert.equal(current.localRevision,old.localRevision);
    assert.deepEqual(current.counters,old.counters);assert.deepEqual(current.baseline,old.baseline);
    const prior=decode(source.files.get(old.evidence.path)),next=decode(result.files.get(current.evidence.path));
    assert.deepEqual(next,{...prior,currentAuthoritySha256:current.authoritySha256});
  }
  assert.equal(after.nextSliceOrdinal,before.nextSliceOrdinal);
  const id=fixture.delivery.deliveryId;
  for(const [name,edit,code,message] of [
    ['predecessor digest',capsule=>{const request=JSON.parse(capsule.validationRequestUtf8);
      request.base.evidenceSha256='sha256:'+'0'.repeat(64);capsule.validationRequestUtf8=canonical(request)+'\n';},
      'EVIDENCE_STALE',/retained historical predecessor bytes differ/u],
    ['captured reviewed authority',capsule=>{const request=JSON.parse(capsule.validationRequestUtf8);
      request.authority.delivery.verificationRecipe.dependencyReview+=' adulterated';
      capsule.validationRequestUtf8=canonical(request)+'\n';},'INVALID_CURRENT_IMAGE',/predecessor binding/u],
    ['captured admission',capsule=>{const origin=JSON.parse(capsule.originUtf8);
      origin.admission.baseActivation.approvedSnapshotSha256='sha256:'+'0'.repeat(64);
      capsule.originUtf8=canonical(origin)+'\n';},'OWNER_MISMATCH',/admission witness/u],
  ])await t.test(`Q18 refuses adulterated ${name} after outer metadata is resealed`,async()=>{
    const files=cloneFiles(result.files),bundle=decode(files.get(`evidence/${id}.json`));
    alterCapturedOrigin(bundle,bundle.validation,edit);replaceCandidateBundle(files,id,bundle);
    await assert.rejects(()=>validateCurrentReviewCandidate({specPath:fixture.specPath,files}),
      error=>error?.code===code&&message.test(error.message));
  });
  await t.test('captured historical A0 lastAttempt cannot be invented coherently in A0/A1',async()=>{
    const invent=(bundle,capsule)=>{
      const origin=JSON.parse(capsule.originUtf8),old=bundle.support.find(item=>item.kind==='validation');
      assert.equal(origin.admission.baseActivation.lastAttempt,null);
      assert.equal(origin.admission.reservedActivation.lastAttempt,null);
      const last={operationAttemptId:old.origin.operationAttemptId,deliveryId:id,slice:fixture.delivery.slice,
        operation:'VALIDATE_SLICE',terminalActivationId:origin.admission.baseActivation.activationId,outcome:'recorded'};
      origin.admission.baseActivation.lastAttempt=last;origin.admission.reservedActivation.lastAttempt=last;
      capsule.originUtf8=canonical(origin)+'\n';
    };
    const files=cloneFiles(result.files),bundle=decode(files.get(`evidence/${id}.json`));
    alterCapturedOrigin(bundle,bundle.validation,capsule=>invent(bundle,capsule));
    replaceCandidateBundle(files,id,bundle);
    await assert.rejects(()=>validateCurrentReviewCandidate({specPath:fixture.specPath,files}),
      error=>error?.code==='INVALID_CURRENT_IMAGE'&&/historical formal binding differs/u.test(error.message));
    const activeBundle=decode(source.files.get(`evidence/${id}.json`));
    alterCapturedOrigin(activeBundle,activeBundle.validation,capsule=>invent(activeBundle,capsule));
    const bytes=Buffer.from(canonical(activeBundle)+'\n'),current=structuredClone(before.deliveries[0]);
    current.evidence.sha256=sha(bytes);
    // Null current lastAttempt cannot conceal the non-null captured A0 value.
    await assert.rejects(()=>inspectPostConversionEvidence({context:source.context,
      snapshotBytes:source.files.get('approved-preparation.json'),current,bundleBytes:bytes,
      observedWork:current.baseline,lastAttempt:null}),
      error=>error?.code==='INVALID_CURRENT_IMAGE'&&/historical formal binding differs/u.test(error.message));
  });
  await t.test('Q18 refuses adulterated older admission in the exact predecessor chain',async()=>{
    const files=cloneFiles(result.files),bundle=decode(files.get(`evidence/${id}.json`));
    const old=bundle.support.find(item=>item.kind==='validation'&&item.origin.localRevision<2);
    assert.ok(old);
    alterCapturedOrigin(bundle,old,capsule=>{const origin=JSON.parse(capsule.originUtf8);
      origin.admission.baseActivation.approvedSnapshotSha256='sha256:'+'0'.repeat(64);
      capsule.originUtf8=canonical(origin)+'\n';});
    replaceCandidateBundle(files,id,bundle);
    await assert.rejects(()=>validateCurrentReviewCandidate({specPath:fixture.specPath,files}),
      error=>error?.code==='EVIDENCE_STALE'&&/retained historical predecessor bytes differ/u.test(error.message));
  });
  await t.test('valid literal source does not authorize an incompatible current owner',async()=>{
    const files=cloneFiles(result.files),snapshot=decode(files.get('approved-preparation.json'));
    const projection=snapshot.normativeProjection,leaf=projection.completed.find(item=>item.deliveryId===id);
    leaf.obligations[0].fullOwner='delivery:'+before.completed[0].deliveryId;
    snapshot.normativeSha256=projected('preparation',projection);
    snapshot.globalReview.authoritySha256=projected('global-review',{
      requirementsAuthority:snapshot.requirementsAuthority,global:projection.global,deliveryIds:[],completed:projection.completed});
    files.set('approved-preparation.json',Buffer.from(canonical(snapshot)+'\n'));
    const continuity=decode(files.get('continuity.json')),current=continuity.completed.find(item=>item.deliveryId===id);
    current.authoritySha256=projected('delivery',leaf);
    files.set('continuity.json',Buffer.from(canonical(continuity)+'\n'));
    const bundle=decode(files.get(current.evidence.path));bundle.currentAuthoritySha256=current.authoritySha256;
    replaceCandidateBundle(files,id,bundle);
    await assert.rejects(()=>validateCurrentReviewCandidate({specPath:fixture.specPath,files}),{code:'INVALID_CURRENT_IMAGE'});
  });
  await t.test('valid literal source does not dispense with the current retention decision',async()=>{
    const files=cloneFiles(result.files),snapshot=decode(files.get('approved-preparation.json'));
    snapshot.globalReview.evidenceDecisions.find(item=>item.deliveryId===id).disposition='revalidate';
    files.set('approved-preparation.json',Buffer.from(canonical(snapshot)+'\n'));validateCurrentCandidate({files});
    await assert.rejects(()=>validateCurrentReviewCandidate({specPath:fixture.specPath,files}),
      error=>error?.code==='EVIDENCE_STALE'&&/reviewed revalidation is still required/u.test(error.message));
  });
  await t.test('valid literal source does not dispense with current product equivalence',async()=>{
    const product=path.join(fixture.root,fixture.productFile),bytes=await fs.readFile(product);
    try {
      await fs.appendFile(product,'// different from the literal local2 proof\n');
      await assert.rejects(()=>validateCurrentReviewCandidate({specPath:fixture.specPath,files:result.files}),{code:'EVIDENCE_STALE'});
    } finally {await fs.writeFile(product,bytes);}
  });
  const untouched=await captureCurrentExecution(fixture.specPath);
  assert.deepEqual(untouched.activationBytes,source.activationBytes);assert.deepEqual(untouched.files,source.files);
});
