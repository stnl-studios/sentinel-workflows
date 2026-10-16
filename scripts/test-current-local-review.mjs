import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {convertedImage} from './fixtures/current-operational-consumption.mjs';
import {nativeOperationCase} from './fixtures/current-native-operation.mjs';
import {prepareCurrentLocalReview,finalizeCurrentLocalReview} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {inspectPostConversionEvidence} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {publishCurrentLocalReview,recoverCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/current-local-review.mjs';

const string=bytes=>Buffer.from(bytes).toString('utf8');
const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const editRevision=text=>text.replace('- Local revision: 1','- Local revision: 2');
const privateStrategy=text=>text.replace(/(## Risks and Strategy\n\n)([\s\S]*?)(?=\n## )/u,
  (_,head,body)=>`${head}${body.trim()}\n\n- Verify the private greeting recipe after the local review.\n`);
function proposalInput(image,{slice='slice-02'}={}) {
  const files=new Map([...(image.candidate?.files??image.files)].map(([name,bytes])=>[name,Buffer.from(bytes)]));
  const snapshot=JSON.parse(files.get('approved-preparation.json'));
  const planName=`plans/${slice}.md`,taskName=`tasks/${slice}.md`;
  const reviewedTask=snapshot.reviewedArtifacts.find(item=>item.path===taskName).utf8;
  const plan=privateStrategy(editRevision(string(files.get(planName))));
  assert.notEqual(plan,string(files.get(planName)));
  return {context:image.input?.context??image.context,
    requirementsAuthority:image.input?.requirementsAuthority??image.requirementsAuthority,
    previous:{activationBytes:image.activationBytes??Buffer.from(JSON.stringify(image.activation)+'\n'),files},slice,
    planBytes:Buffer.from(plan),reviewedTaskBytes:Buffer.from(editRevision(reviewedTask)),
    currentTaskBytes:Buffer.from(editRevision(string(files.get(taskName))))};
}
async function localPublicationCase(t) {
  const fixture=await nativeOperationCase(t);
  const image=await captureCurrentExecution(fixture.specPath);
  const input=proposalInput(image,{slice:fixture.delivery.slice});
  const proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Independent private strategy review.'};
  const publish=checkpoint=>publishCurrentLocalReview({specPath:fixture.specPath,slice:fixture.delivery.slice,
    planBytes:input.planBytes,reviewedTaskBytes:input.reviewedTaskBytes,
    currentTaskBytes:input.currentTaskBytes,review,checkpoint});
  return {fixture,image,publish};
}

test('local S2 review changes one leaf, keeps other reviewed bytes and consumption',async t=>{
  const image=await convertedImage(t,{kind:'two-s2'});
  const input=proposalInput(image);
  const before=JSON.parse(input.previous.files.get('approved-preparation.json'));
  const continuity=JSON.parse(input.previous.files.get('continuity.json'));
  const proposal=prepareCurrentLocalReview(input);
  assert.equal(proposal.reviewRequest.scope,'slice');
  assert.equal(proposal.reviewRequest.evidenceDecisions.length,0);
  await assert.rejects(async()=>finalizeCurrentLocalReview({proposal,review:null}),
    error=>error?.code==='STALE_APPROVAL');
  const review={...proposal.reviewRequest,decision:'approved',summary:'Independent review of the private strategy and unchanged sibling.'};
  const candidate=finalizeCurrentLocalReview({proposal,review});
  const next=JSON.parse(candidate.files.get('approved-preparation.json'));
  const current=JSON.parse(candidate.files.get('continuity.json'));
  assert.equal(next.preparationRevision,before.preparationRevision+1);
  assert.equal(next.globalReview.authoritySha256,before.globalReview.authoritySha256);
  assert.deepEqual(next.globalReview,before.globalReview);
  assert.deepEqual(next.normativeProjection.global,before.normativeProjection.global);
  assert.deepEqual(next.deliveries[0],before.deliveries[0]);
  assert.deepEqual(next.normativeProjection.deliveries[0],before.normativeProjection.deliveries[0]);
  assert.equal(next.deliveries[1].localRevision,2);
  assert.equal(current.deliveries[1].localRevision,2);
  assert.deepEqual(current.deliveries[1].counters,continuity.deliveries[1].counters);
  assert.deepEqual(current.deliveries[0],continuity.deliveries[0]);
  for(const name of ['plan.md','tasks.md','plans/slice-01.md','tasks/slice-01.md'])
    assert.deepEqual(candidate.files.get(name),input.previous.files.get(name),`${name} changed`);
});

test('local S2 review keeps old formal record literal and makes it historical',async t=>{
  const fixture=await nativeOperationCase(t);
  const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:fixture.activationId});
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  const agentId='controlled-local-review-formal';
  await bindNative(start.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const response=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{status:'PASS',
    commands:measured.commands,evidence:'Controlled old formal proof.',findingReferences:'none',
    findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'none'},
    newFindings:[]});
  const resultPath=path.join(fixture.root,'local-review-controlled-result.json');
  await fs.writeFile(resultPath,JSON.stringify({agentId,status:'completed',finalResponse:response})+'\n');
  await captureNative(start.handle,resultPath);
  assert.equal((await publish(start.handle)).publication,'confirmed');
  const old=await captureCurrentExecution(fixture.specPath);
  const input=proposalInput(old,{slice:fixture.delivery.slice});
  const before=JSON.parse(Buffer.from(old.files.get(`evidence/${fixture.delivery.deliveryId}.json`)));
  const proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',
    evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,
      reason:'The private strategy changed, so this exact historical formal must be revalidated.'})),
    summary:'Independent local strategy and noninterference review.'};
  const candidate=finalizeCurrentLocalReview({proposal,review});
  const after=JSON.parse(candidate.files.get(`evidence/${fixture.delivery.deliveryId}.json`));
  assert.equal(after.validation.recordUtf8,before.validation.recordUtf8);
  assert.deepEqual(after.validation.origin,before.validation.origin);
  assert.equal(after.currentAuthoritySha256,proposal.reviewRequest.authoritySha256);
  const continuity=JSON.parse(candidate.files.get('continuity.json'));
  const current=continuity.deliveries.find(item=>item.deliveryId===fixture.delivery.deliveryId);
  assert.equal(current.validation,'revalidation-required');
  assert.deepEqual(current.counters,JSON.parse(Buffer.from(old.files.get('continuity.json'))).deliveries[0].counters);
  const inspected=await inspectPostConversionEvidence({context:old.context,
    snapshotBytes:candidate.files.get('approved-preparation.json'),current,
    bundleBytes:candidate.files.get(current.evidence.path),observedWork:current.baseline});
  assert.equal(inspected.requiresFormalRevalidation,true);
  assert.notEqual(inspected.formalStatus,'PASS');
  const changed=structuredClone(after);
  changed.validation.recordUtf8=changed.validation.recordUtf8.replace('- Status: PASS','- Status: BLOCKED');
  assert.notEqual(changed.validation.recordUtf8,after.validation.recordUtf8);
  const changedBytes=Buffer.from(JSON.stringify(changed)+'\n');
  const changedSnapshot=JSON.parse(candidate.files.get('approved-preparation.json'));
  changedSnapshot.deliveries.find(item=>item.deliveryId===current.deliveryId)
    .review.evidenceDecisions[0].evidenceSha256=sha(changedBytes);
  const changedCurrent={...current,evidence:{...current.evidence,sha256:sha(changedBytes)}};
  await assert.rejects(async()=>inspectPostConversionEvidence({context:old.context,
    snapshotBytes:Buffer.from(JSON.stringify(changedSnapshot)+'\n'),current:changedCurrent,
    bundleBytes:changedBytes,observedWork:changedCurrent.baseline}),
  error=>['INVALID_CURRENT_IMAGE','OWNER_MISMATCH','EVIDENCE_STALE','RUNNER_RESULT_REJECTED'].includes(error?.code));
  const published=await publishCurrentLocalReview({specPath:fixture.specPath,slice:fixture.delivery.slice,
    planBytes:input.planBytes,reviewedTaskBytes:input.reviewedTaskBytes,
    currentTaskBytes:input.currentTaskBytes,review});
  assert.equal(published.publication,'confirmed');
  assert.equal(published.cleanup,'complete');
  await assert.rejects(fs.access(published.allocation),{code:'ENOENT'});
  await assert.rejects(fs.access(published.retainedBackup),{code:'ENOENT'});
  const official=await captureCurrentExecution(fixture.specPath);
  assert.equal(official.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  assert.equal(JSON.parse(Buffer.from(official.files.get('continuity.json'))).deliveries[0].localRevision,2);
  const reviewActivation=JSON.parse(Buffer.from(official.activationBytes));
  const nextStart=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:reviewActivation.activationId});
  const nextDispatch=await reserveDispatch(nextStart.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  await bindNative(nextStart.handle,'controlled-reviewed-formal');
  const nextMeasured=await verifyNative(nextDispatch.originFile);
  const nextResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{status:'PASS',
    commands:nextMeasured.commands,evidence:'Controlled reviewed formal proof.',findingReferences:'none',
    findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'none'},
    newFindings:[]});
  const nextPath=path.join(fixture.root,'reviewed-formal-result.json');
  await fs.writeFile(nextPath,JSON.stringify({agentId:'controlled-reviewed-formal',status:'completed',
    finalResponse:nextResponse})+'\n');
  await captureNative(nextStart.handle,nextPath);
  assert.equal((await publish(nextStart.handle)).publication,'confirmed');
  const final=await captureCurrentExecution(fixture.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  const formal=JSON.parse(Buffer.from(final.files.get(`evidence/${fixture.delivery.deliveryId}.json`)));
  assert.equal(formal.validation.origin.localRevision,2);
  assert.equal(formal.support[0].recordUtf8,before.validation.recordUtf8);
  assert.equal(formal.support[0].origin.localRevision,1);
  assert.equal(JSON.parse(Buffer.from(final.files.get('continuity.json'))).deliveries[0].counters.validationAttempts,
    current.counters.validationAttempts+1);
});

test('local S2 review refuses transverse changes and stale leaf approval',async t=>{
  const image=await convertedImage(t,{kind:'two-s2'});
  const input=proposalInput(image);
  await assert.rejects(async()=>prepareCurrentLocalReview({...input,
    planBytes:Buffer.from(string(input.planBytes).replace('Export observed by node --test.',
      'A different observable result.'))}),error=>error?.code==='REPLAN_REQUIRED');
  const proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Independent local decision.'};
  await assert.rejects(async()=>finalizeCurrentLocalReview({proposal,review:{...review,
    authoritySha256:image.activation.normativeSha256}}),error=>error?.code==='STALE_APPROVAL');
});

test('local replacement keeps another delivery native formal proof current and byte-identical',async t=>{
  const converted=await convertedImage(t,{kind:'two-s2'});
  await fs.writeFile(path.join(converted.f.root,'src/greeting.mjs'),'export const greeting="hello";\n');
  const first=await captureCurrentExecution(converted.f.specPath);
  const selected=JSON.parse(Buffer.from(first.files.get('continuity.json'))).deliveries[0];
  const start=await begin({specPath:converted.f.specPath,slice:selected.slice,
    expectedActivationId:JSON.parse(Buffer.from(first.activationBytes)).activationId});
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  await bindNative(start.handle,'controlled-sibling-proof');
  const measured=await verifyNative(dispatch.originFile);
  const response=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{status:'PASS',
    commands:measured.commands,evidence:'Sibling formal proof before independent local review.',
    findingReferences:'none',findingDispositions:'none',blockers:'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'No product edit.'},newFindings:[]});
  const resultPath=path.join(converted.f.root,'sibling-formal-tool-result.json');
  await fs.writeFile(resultPath,JSON.stringify({agentId:'controlled-sibling-proof',status:'completed',
    finalResponse:response})+'\n');
  await captureNative(start.handle,resultPath);
  assert.equal((await publish(start.handle)).publication,'confirmed');
  const before=await captureCurrentExecution(converted.f.specPath);
  const siblingBytes=Buffer.from(before.files.get(`evidence/${selected.deliveryId}.json`));
  const siblingReview=JSON.parse(Buffer.from(before.files.get('approved-preparation.json'))).deliveries[0].review;
  const input=proposalInput(before,{slice:'slice-02'});
  const proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Independent selected private strategy review.'};
  const published=await publishCurrentLocalReview({specPath:converted.f.specPath,slice:'slice-02',
    planBytes:input.planBytes,reviewedTaskBytes:input.reviewedTaskBytes,
    currentTaskBytes:input.currentTaskBytes,review});
  assert.equal(published.cleanup,'complete');
  const after=await captureCurrentExecution(converted.f.specPath);
  assert.deepEqual(Buffer.from(after.files.get(`evidence/${selected.deliveryId}.json`)),siblingBytes);
  assert.deepEqual(JSON.parse(Buffer.from(after.files.get('approved-preparation.json'))).deliveries[0].review,
    siblingReview);
  assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');
});

for(const phase of ['before-activation','after-activation-intent','after-activation']) {
  test(`local replacement recovers owned publication at ${phase} without a second candidate`,async t=>{
    const {fixture,image,publish}=await localPublicationCase(t);
    const former=JSON.parse(Buffer.from(image.activationBytes)).activationId;
    let seen=0;
    let error;
    try {await publish(async(current,paths)=>{
      if(current===phase) {seen++;throw new Error(`controlled ${phase}`);}
      if(current==='before-backup') {
        const marker=JSON.parse(await fs.readFile(paths.marker));
        assert.ok(marker.candidate.startsWith(path.join(fixture.root,'tmp','sentinel')+path.sep));
        assert.equal(paths.stage,marker.candidate);
        assert.equal(await fs.stat(path.join(path.dirname(paths.marker),`.stnl-execution-stage-${marker.allocationId}`)).then(()=>true,()=>false),false);
      }
    });} catch(caught) {error=caught;}
    assert.equal(seen,1);
    assert.ok(error?.allocation,'failure must return its existing publication marker');
    assert.ok(error?.candidateRoot,'failure must identify the owned candidate');
    const recovered=await recoverCurrentLocalReview({specPath:fixture.specPath,allocation:error.allocation});
    assert.equal(recovered.cleanup,'complete');
    await assert.rejects(fs.access(error.allocation),{code:'ENOENT'});
    await assert.rejects(fs.access(error.candidateRoot),{code:'ENOENT'});
    const final=await captureCurrentExecution(fixture.specPath);
    assert.equal(JSON.parse(Buffer.from(final.activationBytes)).activationId===former,
      phase!=='after-activation');
  });
}

for(const phase of ['before-backup','after-backup']) {
  test(`local replacement rejects documentary drift at ${phase} and cleans its allocation`,async t=>{
    const {fixture,image,publish}=await localPublicationCase(t);
    const former=JSON.parse(Buffer.from(image.activationBytes)).activationId;
    const source=await fs.readFile(fixture.specPath);
    let changed=false,error;
    try {await publish(async current=>{
      if(current===phase) {await fs.appendFile(fixture.specPath,'\n<!-- controlled drift -->\n');changed=true;}
    });} catch(caught) {error=caught;}
    assert.equal(changed,true);
    assert.equal(error?.code,'REQUIREMENTS_CHANGED');
    assert.ok(error?.allocation);
    await fs.writeFile(fixture.specPath,source);
    const recovered=await recoverCurrentLocalReview({specPath:fixture.specPath,allocation:error.allocation});
    assert.equal(recovered.cleanup,'complete');
    const final=await captureCurrentExecution(fixture.specPath);
    assert.equal(JSON.parse(Buffer.from(final.activationBytes)).activationId,former);
  });
}

test('local replacement returns owner marker after post-publication readback failure',async t=>{
  const {fixture,publish}=await localPublicationCase(t);
  const source=await fs.readFile(fixture.specPath);
  let error;
  try {await publish(async phase=>{
    if(phase==='cleanup') await fs.appendFile(fixture.specPath,'\n<!-- controlled late drift -->\n');
  });} catch(caught) {error=caught;}
  assert.ok(error?.allocation,'confirmed publication must return its marker on readback failure');
  await fs.writeFile(fixture.specPath,source);
  const recovered=await recoverCurrentLocalReview({specPath:fixture.specPath,allocation:error.allocation});
  assert.equal(recovered.cleanup,'complete');
});

test('local replacement removes only its proven candidate when marker creation fails',async t=>{
  const {fixture,image,publish}=await localPublicationCase(t);
  const before=Buffer.from(image.activationBytes);
  const foreign=path.join(fixture.root,'tmp','foreign-control.txt');
  await fs.mkdir(path.dirname(foreign),{recursive:true});
  await fs.writeFile(foreign,'keep foreign bytes');
  const open=fs.open;
  let injected=0,error;
  fs.open=async(file,...args)=>{
    if(typeof file==='string' && /\.stnl-execution-publication-[a-f0-9-]+\.json$/u.test(file)) {
      injected++;
      throw Object.assign(new Error('controlled marker creation failure'),{code:'EIO'});
    }
    return open(file,...args);
  };
  try {await publish();} catch(caught) {error=caught;}
  finally {fs.open=open;}
  assert.equal(injected,1);
  assert.ok(error?.candidateRoot);
  await assert.rejects(fs.access(error.candidateRoot),{code:'ENOENT'});
  assert.deepEqual(Buffer.from((await captureCurrentExecution(fixture.specPath)).activationBytes),before);
  assert.equal(await fs.readFile(foreign,'utf8'),'keep foreign bytes');
});

test('local replacement recovers with its marker when retention mkdir fails',async t=>{
  const {fixture,image,publish}=await localPublicationCase(t);
  const before=Buffer.from(image.activationBytes);
  const foreign=path.join(fixture.root,'tmp','foreign-control.txt');
  await fs.mkdir(path.dirname(foreign),{recursive:true});
  await fs.writeFile(foreign,'keep foreign bytes');
  const mkdir=fs.mkdir;
  let injected=0,error;
  fs.mkdir=async(directory,...args)=>{
    if(typeof directory==='string' && /\.stnl-execution-backup-[a-f0-9-]+$/u.test(directory)) {
      injected++;
      throw Object.assign(new Error('controlled retention mkdir failure'),{code:'EIO'});
    }
    return mkdir(directory,...args);
  };
  try {await publish();} catch(caught) {error=caught;}
  finally {fs.mkdir=mkdir;}
  assert.equal(injected,1);
  assert.ok(error?.allocation);
  assert.ok(error?.candidateRoot);
  const owner=JSON.parse(await fs.readFile(error.allocation,'utf8'));
  await assert.rejects(fs.access(owner.retentionRoot),{code:'ENOENT'});
  const recovered=await recoverCurrentLocalReview({specPath:fixture.specPath,
    allocation:error.allocation});
  assert.equal(recovered.publication,'aborted');
  assert.equal(recovered.cleanup,'complete');
  await assert.rejects(fs.access(error.allocation),{code:'ENOENT'});
  await assert.rejects(fs.access(error.candidateRoot),{code:'ENOENT'});
  assert.deepEqual(Buffer.from((await captureCurrentExecution(fixture.specPath)).activationBytes),before);
  assert.equal(await fs.readFile(foreign,'utf8'),'keep foreign bytes');
});

test('local replacement preserves foreign retention bytes across repeated recovery',async t=>{
  const {fixture,publish}=await localPublicationCase(t);
  const mkdir=fs.mkdir;
  let error;
  fs.mkdir=async(directory,...args)=>{
    if(typeof directory==='string' && /\.stnl-execution-backup-[a-f0-9-]+$/u.test(directory))
      throw Object.assign(new Error('controlled retention mkdir failure'),{code:'EIO'});
    return mkdir(directory,...args);
  };
  try {await publish();} catch(caught) {error=caught;}
  finally {fs.mkdir=mkdir;}
  assert.ok(error?.allocation);
  const owner=JSON.parse(await fs.readFile(error.allocation,'utf8'));
  await fs.mkdir(owner.retentionRoot);
  const foreign=path.join(owner.retentionRoot,'foreign.txt');
  await fs.writeFile(foreign,'keep foreign retention bytes');
  for(let attempt=0;attempt<2;attempt++) {
    await assert.rejects(recoverCurrentLocalReview({specPath:fixture.specPath,
      allocation:error.allocation}),error=>error?.code==='ENOTEMPTY');
    assert.equal(await fs.readFile(foreign,'utf8'),'keep foreign retention bytes');
    await fs.access(error.allocation);
  }
  await fs.unlink(foreign);
  const recovered=await recoverCurrentLocalReview({specPath:fixture.specPath,
    allocation:error.allocation});
  assert.equal(recovered.cleanup,'complete');
  await assert.rejects(fs.access(error.allocation),{code:'ENOENT'});
});
