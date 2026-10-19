import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {completedNativeCase,reopeningInput} from './fixtures/current-completed-native.mjs';
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
  const approve=request=>({...structuredClone(request),decision:'approved',
    summary:'Controlled mechanical set decision; not an official independent review.',
    evidenceDecisions:request.evidenceDecisions.map(item=>({...item,
      reason:'Controlled review binds the exact current digest and its required retention or revalidation.'}))});
  return {globalReview:approve(proposal.reviewRequest.globalReview),
    deliveries:proposal.reviewRequest.deliveries.map(item=>({deliveryId:item.deliveryId,review:approve(item.review)}))};
}

async function composeVerified(input,specPath) {
  const methods=['execFile','execFileSync','spawn','spawnSync','fork','exec','execSync'];
  const saved=methods.map(name=>[name,childProcess[name]]),spawn=childProcess.ChildProcess.prototype.spawn;
  const deny=()=>{throw new Error('Q18 must not start a recipe or runner');};
  for(const name of methods)childProcess[name]=deny;
  childProcess.ChildProcess.prototype.spawn=deny;syncBuiltinESMExports();
  try {
    await validateCurrentReviewCandidate({specPath,files:input.previous.files});
    const proposal=prepareCurrentSetReplacement(input);
    const result=finalizeCurrentSetReplacement({proposal,review:controlledReview(proposal)});
    // Existing semantic proof, historical ownership and live product checks;
    // no publisher and no new command, judgment, record or activation.
    const inspection=await validateCurrentReviewCandidate({specPath,files:result.files});
    return {proposal,result,inspection};
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

// The reader uses this same inert review view: retain the real capture identity,
// rebind only its proposed content, and never allocate/write an official marker.
function inertReviewSource(source,result) {
  const snapshot=decode(result.files.get('approved-preparation.json'));
  const activation={...decode(source.activationBytes),preparationRevision:snapshot.preparationRevision,
    requirementsAuthority:snapshot.requirementsAuthority,normativeSha256:snapshot.normativeSha256,
    approvedSnapshotSha256:sha(result.files.get('approved-preparation.json')),
    artifacts:[...result.files].map(([path,bytes])=>({path,sha256:sha(bytes)})).sort((a,b)=>a.path.localeCompare(b.path)),
    lastAttempt:null};
  return {...source,activationBytes:Buffer.from(canonical(activation)+'\n'),files:cloneFiles(result.files)};
}
const setSection=(text,name,body)=>text.replace(new RegExp(`(^## ${name}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu'),
  (_,heading)=>heading+body+'\n\n');

test('Q19 reopens private B from Q18 in memory, retaining independent A and literal proof without another PASS',async t=>{
  const fixture=await completedNativeCase(t,{drift:false,independent:true});
  const live=await captureCurrentExecution(fixture.specPath),before=decode(live.files.get('continuity.json'));
  assert.deepEqual(decode(live.files.get('approved-preparation.json')).normativeProjection.completed[0].dependencies,[]);
  const first=await composeVerified(inputFor(live),fixture.specPath);
  assert.equal(first.inspection.state,'VALIDATION_BLOCKED');assert.equal(first.inspection.normalHandoff,null);
  const q18=inertReviewSource(live,first.result),prior=decode(q18.files.get('continuity.json'));
  assert.equal(prior.deliveries.length,0);
  assert.equal(q18.files.has(`plans/${fixture.delivery.slice}.md`),false);
  assert.equal(q18.files.has(`tasks/${fixture.delivery.slice}.md`),false);
  const input=reopeningInput(q18,fixture.delivery.deliveryId);
  const second=await composeVerified(input,fixture.specPath),next=decode(second.result.files.get('continuity.json'));
  const a=prior.completed.find(item=>item.deliveryId!==fixture.delivery.deliveryId),b=prior.completed.find(item=>item.deliveryId===fixture.delivery.deliveryId);
  const expectedLeaf=structuredClone(first.result.snapshot.normativeProjection.completed.find(item=>item.deliveryId===b.deliveryId));
  expectedLeaf.obligations=expectedLeaf.obligations.map(item=>({...item,fullOwner:item.fullOwner==='delivery:'+b.deliveryId?b.slice:item.fullOwner}));
  expectedLeaf.verificationRecipe.checks[0].args.splice(1,0,{literal:'--test-reporter=tap'});
  expectedLeaf.expectedTests='- node --test --test-reporter=tap other/greeting.test.mjs';
  const expectedGlobal={...first.result.snapshot.normativeProjection.global,order:[b.deliveryId]};
  const expectedA=first.result.snapshot.normativeProjection.completed.filter(item=>item.deliveryId===a.deliveryId);
  assert.deepEqual(second.result.snapshot.normativeProjection.deliveries,[expectedLeaf]);
  assert.equal(second.result.snapshot.preparationRevision,first.result.snapshot.preparationRevision+1);
  assert.equal(second.result.snapshot.requirementsAuthority,first.result.snapshot.requirementsAuthority);
  assert.deepEqual(next.completed,[a]);
  assert.ok(Buffer.from(second.result.files.get(a.evidence.path)).equals(Buffer.from(q18.files.get(a.evidence.path))));
  assert.ok(Buffer.from(second.result.files.get(a.evidence.path)).equals(Buffer.from(live.files.get(before.completed[0].evidence.path))));
  assert.equal(next.deliveries[0].deliveryId,b.deliveryId);assert.equal(next.deliveries[0].slice,b.slice);
  assert.equal(next.deliveries[0].localRevision,b.localRevision+1);
  assert.equal(next.deliveries[0].validation,'revalidation-required');
  assert.deepEqual(next.deliveries[0].counters,b.counters);assert.deepEqual(next.deliveries[0].baseline,b.baseline);
  assert.equal(next.nextSliceOrdinal,prior.nextSliceOrdinal);
  const bundle=decode(second.result.files.get(b.evidence.path)),old=decode(q18.files.get(b.evidence.path));
  assert.deepEqual(bundle,{...old,currentAuthoritySha256:next.deliveries[0].authoritySha256});
  assert.deepEqual(second.result.snapshot.normativeProjection.global,expectedGlobal);
  assert.deepEqual(second.result.snapshot.normativeProjection.completed,expectedA);
  assert.deepEqual(second.proposal.reviewRequest,{globalReview:{scope:'set',
    authoritySha256:projected('global-review',{requirementsAuthority:q18.requirementsAuthority,
      global:expectedGlobal,deliveryIds:[b.deliveryId],completed:expectedA}),
    examinedArtifactHashes:['plan.md','tasks.md'].map(path=>({path,sha256:sha(second.result.files.get(path))})),
    evidenceDecisions:[{deliveryId:a.deliveryId,evidenceSha256:a.evidence.sha256,disposition:'retain-current',reason:''}]},
    deliveries:[{deliveryId:b.deliveryId,review:{scope:'slice',authoritySha256:projected('delivery',expectedLeaf),
      examinedArtifactHashes:[`plans/${b.slice}.md`,`tasks/${b.slice}.md`].map(path=>({path,sha256:sha(second.result.files.get(path))})),
      evidenceDecisions:[{deliveryId:b.deliveryId,evidenceSha256:sha(Buffer.from(canonical({...old,
        currentAuthoritySha256:projected('delivery',expectedLeaf)})+'\n')),disposition:'revalidate',reason:''}]}}]});
  assert.ok(!input.artifacts.get(`tasks/${b.slice}.md`).equals(second.result.files.get(`tasks/${b.slice}.md`)),
    'the exact reviewed Task includes the computed current carriers');
  assert.equal(second.inspection.deliveries[0].formalStatus,null);
  assert.equal(second.inspection.deliveries[0].persistedValidation,'revalidation-required');
  assert.deepEqual(second.inspection.normalHandoff,{operation:'VALIDATE_SLICE',slice:b.slice,deliveryId:b.deliveryId});
  assert.equal(second.result.files.has('activation.json'),false);
  await t.test('Q19 requires its exact global and local review plus revalidate digest',()=>{
    assert.throws(()=>finalizeCurrentSetReplacement({proposal:second.proposal,review:null}),{code:'STALE_APPROVAL'});
    assert.throws(()=>finalizeCurrentSetReplacement({proposal:second.proposal,review:controlledReview(first.proposal)}),{code:'STALE_APPROVAL'});
    for(const alter of [
      decision=>{decision.deliveries=[];},
      decision=>{decision.deliveries[0].deliveryId=a.deliveryId;},
      decision=>{decision.deliveries[0].review.evidenceDecisions[0].evidenceSha256=b.evidence.sha256;},
      decision=>{decision.deliveries[0].review.evidenceDecisions[0].disposition='retain-current';},
      decision=>{decision.globalReview.evidenceDecisions=[];},
    ]) {
      const decision=controlledReview(second.proposal);alter(decision);
      assert.throws(()=>finalizeCurrentSetReplacement({proposal:second.proposal,review:decision}),{code:'STALE_APPROVAL'});
    }
  });
  await t.test('Q19 refuses identity, revision, nonprivate delta and shared-input substitutions',()=>{
    const planName=`plans/${b.slice}.md`,taskName=`tasks/${b.slice}.md`;
    const edit=(candidate,name,change)=>candidate.artifacts.set(name,Buffer.from(change(candidate.artifacts.get(name).toString('utf8'))));
    const cases=[
      ['foreign identity',candidate=>{for(const name of [planName,taskName])edit(candidate,name,text=>text.replace(b.deliveryId,'33333333-3333-4333-8333-333333333333'));},'INVALID_CURRENT_IMAGE'],
      ['wrong local revision',candidate=>{for(const name of [planName,taskName])edit(candidate,name,text=>text.replace('- Local revision: 2','- Local revision: 3'));},'INVALID_CURRENT_IMAGE'],
      ['wrong owner',candidate=>edit(candidate,taskName,text=>text.replace('full owner: '+b.slice,'full owner: delivery:'+a.deliveryId)),'INVALID_CURRENT_IMAGE'],
      ['transverse objective',candidate=>edit(candidate,planName,text=>setSection(text,'Objective and Observable Result','A different observable result.')),'REPLAN_REQUIRED'],
      ['changed dependency',candidate=>{
        edit(candidate,planName,text=>setSection(text,'Dependencies','- '+a.slice));
        for(const name of ['plan.md','tasks.md'])edit(candidate,name,text=>text.split('\n').map(line=>
          line.includes(`| ${b.slice.slice(6)} - Verification |`)?line.replace('| - |','| '+a.slice+' |'):line).join('\n'));
      },'REPLAN_REQUIRED'],
      ['global context',candidate=>edit(candidate,'plan.md',text=>text.replace(/^- Strategy: .+$/mu,'- Strategy: A different global strategy.')),'UNSUPPORTED_FORMAT'],
      ['no private change',candidate=>{const original=first.result.snapshot.normativeProjection.completed.find(item=>item.deliveryId===b.deliveryId);
        for(const name of [planName,taskName])edit(candidate,name,text=>setSection(setSection(text,'Verification Recipe',
          '- Recipe: '+JSON.stringify(original.verificationRecipe)),'Expected Tests',original.expectedTests));},'REPLAN_REQUIRED'],
      ['input in independent A output area',candidate=>{for(const name of [planName,taskName])edit(candidate,name,text=>{
        const recipe=structuredClone(expectedLeaf.verificationRecipe);recipe.checks[0].inputs=[{kind:'input',path:'../../src/greeting.mjs'}];
        return setSection(setSection(text,'Existing Inputs','- `../../src/greeting.mjs`'),'Verification Recipe','- Recipe: '+JSON.stringify(recipe));});},'REPLAN_REQUIRED'],
    ];
    for(const [name,alter,code] of cases) {
      const candidate=reopeningInput(q18,b.deliveryId);alter(candidate);
      assert.throws(()=>prepareCurrentSetReplacement(candidate),{code},name);
    }
  });
  await t.test('Q19 preserves consumed high-water and does not reuse stale proposal bytes',()=>{
    for(const field of ['counter','high-water']) {
      const candidate=reopeningInput(q18,b.deliveryId),files=cloneFiles(candidate.previous.files),continuity=decode(files.get('continuity.json'));
      if(field==='counter')continuity.completed.find(item=>item.deliveryId===b.deliveryId).counters.validationAttempts=0;
      else continuity.nextSliceOrdinal=2;
      files.set('continuity.json',Buffer.from(canonical(continuity)+'\n'));
      const changed=inertReviewSource(q18,{files});candidate.previous={activationBytes:changed.activationBytes,files:changed.files};
      assert.throws(()=>prepareCurrentSetReplacement(candidate),{code:'INVALID_CURRENT_IMAGE'},field);
    }
    const stale=reopeningInput(q18,b.deliveryId),proposal=prepareCurrentSetReplacement(stale),review=controlledReview(proposal);
    stale.artifacts.set('plan.md',Buffer.concat([stale.artifacts.get('plan.md'),Buffer.from('\n')]));
    assert.throws(()=>finalizeCurrentSetReplacement({proposal,review}),{code:'STALE_APPROVAL'});
    assert.throws(()=>prepareCurrentSetReplacement({...input,completedDeliveryIds:[b.deliveryId]}),{code:'INVALID_CURRENT_IMAGE'});
  });
  await t.test('Q19 inspects the retained source before reopening and refuses product drift',async()=>{
    for(const relative of ['src/greeting.mjs',fixture.productFile]) {
      const product=path.join(fixture.root,relative),bytes=await fs.readFile(product);
      try {
        await fs.appendFile(product,'// drift after the retained current source\n');
        await assert.rejects(()=>composeVerified(reopeningInput(q18,b.deliveryId),fixture.specPath),{code:'EVIDENCE_STALE'});
      } finally {await fs.writeFile(product,bytes);}
    }
  });
  const untouched=await captureCurrentExecution(fixture.specPath);
  assert.deepEqual(untouched.activationBytes,live.activationBytes);assert.deepEqual(untouched.files,live.files);
});
