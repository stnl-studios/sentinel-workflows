import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {captureCurrentExecution,validateCurrentReviewCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentSetReplacementSource} from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
const decode=bytes=>JSON.parse(Buffer.from(bytes));

test('missing integral judgment admits fresh terminal proof without changing approved preparation',async t=>{
  const f=await completedNativeCase(t,{retire:false,drift:false});
  const before=await captureCurrentExecution(f.specPath);
  assert.ok(before.inspection.deliveries.every(x=>x.formalStatus==='PASS'&&x.observedValidation==='current'));
  assert.notEqual(before.inspection.state,'COMPLETE');
  const approved=decode(before.files.get('approved-preparation.json'));
  assert.equal(approved.normativeProjection.deliveries[0].obligations[0].contribution,'partial');
  assert.equal(approved.normativeProjection.deliveries[1].obligations[0].contribution,'complete');
  assert.match(before.inspection.diagnostics[0].reason,/local PASS has no terminal judgment/u);
  assert.deepEqual(before.inspection.normalHandoff,{operation:'VALIDATE_SLICE',slice:f.delivery.slice,deliveryId:f.delivery.deliveryId});
  assert.deepEqual((await captureCurrentSetReplacementSource(f.specPath)).activationBytes,before.activationBytes);
  // Rehash a forged local observation, while retaining every carrier identity.
  // Invalid proof must fail authentication, not be admitted as missing terminal.
  const files=new Map([...before.files].map(([name,bytes])=>[name,Buffer.from(bytes)]));
  const book=decode(files.get('continuity.json')),selected=book.deliveries.find(x=>x.deliveryId===f.delivery.deliveryId);
  const old=selected.evidence.sha256,bundle=decode(files.get(selected.evidence.path));
  const object=bundle.objects.find(x=>x.id===bundle.validation.sources.verificationObservation);
  const observation=decode(Buffer.from(object.bytesBase64,'base64'));
  observation.executionContext.invocation.binding.originSha256='sha256:'+'f'.repeat(64);
  const bytes=Buffer.from(JSON.stringify(observation)+'\n');
  const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
  object.id=sha(bytes);object.bytesBase64=bytes.toString('base64');
  bundle.validation.sources.verificationObservation=object.id;bundle.objects.sort((a,b)=>a.id.localeCompare(b.id));
  const changed=Buffer.from(JSON.stringify(bundle)+'\n');selected.evidence.sha256=sha(changed);
  files.set(selected.evidence.path,changed);files.set('continuity.json',Buffer.from(JSON.stringify(book)+'\n'));
  const task='tasks/'+selected.slice+'.md';files.set(task,Buffer.from(files.get(task).toString().replaceAll(old,selected.evidence.sha256)));
  await assert.rejects(()=>validateCurrentReviewCandidate({specPath:f.specPath,files}),
    e=>e.message==='native replay invocation identity: binding differs');
  const start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:before.inspection.activationId,operation:'VALIDATE_SLICE'});
  await assert.rejects(()=>captureCurrentSetReplacementSource(f.specPath),{code:'OWNER_UNCERTAIN'});
  await assert.rejects(()=>reserveDispatch(start.handle),e=>e.code==='EVIDENCE_INCOMPLETE'&&/explicit terminal dispatch/u.test(e.message));
  const dispatch=await reserveDispatch(start.handle,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const agentId='mechanical-first-integral';await bindNative(start.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  t.diagnostic('One fresh terminal operation, one verify-native call; measured commands: '+JSON.stringify(measured.commands));
  const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:measured.commands,
    evidence:'Synthetic independent integral review of the approved combination.',findingReferences:'none',findingDispositions:'none',blockers:'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'Publish a new integral judgment without modifying preparation.'},newFindings:[]});
  const tool=f.root+'/first-integral.json';await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse}));
  await captureNative(start.handle,tool);assert.equal((await publish(start.handle)).publication,'confirmed');
  const after=await captureCurrentExecution(f.specPath);
  assert.equal(after.inspection.state,'COMPLETE');assert.equal(after.inspection.normalHandoff,null);
  assert.deepEqual(after.files.get('approved-preparation.json'),before.files.get('approved-preparation.json'));
  const continuity=decode(before.files.get('continuity.json'));
  for(const sibling of continuity.deliveries.filter(x=>x.deliveryId!==f.delivery.deliveryId))
    assert.deepEqual(after.files.get(sibling.evidence.path),before.files.get(sibling.evidence.path));
  const owner=continuity.deliveries.find(x=>x.deliveryId===f.delivery.deliveryId);
  const prior=decode(before.files.get(owner.evidence.path)),next=decode(after.files.get(owner.evidence.path));
  assert.notEqual(next.validation.origin.runnerId,prior.validation.origin.runnerId);
  assert.equal(Number(next.validation.id.slice(8)),Number(prior.validation.id.slice(8))+1);
});

test('missing terminal selects last approved integral candidate without replan',async t=>{
  const f=await completedNativeCase(t,{retire:false,drift:false,independent:true});
  const current=await captureCurrentExecution(f.specPath);
  assert.equal(current.inspection.normalHandoff.operation,'VALIDATE_SLICE');
  assert.equal(current.inspection.normalHandoff.slice,'slice-02');
  assert.ok(current.inspection.deliveries.every(x=>x.formalStatus==='PASS'));
  assert.notEqual(current.inspection.state,'COMPLETE');
  assert.deepEqual((await captureCurrentSetReplacementSource(f.specPath)).inspection.normalHandoff,current.inspection.normalHandoff);
  const handoff=current.inspection.normalHandoff;
  const start=await begin({specPath:f.specPath,slice:handoff.slice,expectedActivationId:current.inspection.activationId,operation:'VALIDATE_SLICE'});
  const dispatch=await reserveDispatch(start.handle,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const agentId='mechanical-multiple-integral';await bindNative(start.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:measured.commands,
    evidence:'Synthetic independent integral review across both complete owners.',findingReferences:'none',findingDispositions:'none',blockers:'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'Record integral judgment without replan.'},newFindings:[]});
  const tool=f.root+'/multiple-integral.json';await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse}));
  await captureNative(start.handle,tool);assert.equal((await publish(start.handle)).publication,'confirmed');
  const after=await captureCurrentExecution(f.specPath);assert.equal(after.inspection.state,'COMPLETE');
  assert.deepEqual(after.files.get('approved-preparation.json'),current.files.get('approved-preparation.json'));

});

test('missing terminal cannot reopen a retired integral owner',async t=>{
  const {retireActive}=await import('./fixtures/current-reader-campaign.mjs');
  const f=await completedNativeCase(t,{retire:false,drift:false});
  await retireActive(f.view,['slice-01','slice-02']);
  const current=await captureCurrentExecution(f.specPath);
  assert.notEqual(current.inspection.state,'COMPLETE');
  assert.equal(current.inspection.normalHandoff,null);
});

test('missing terminal source gate refuses local drift and corrupt current carriers',async t=>{
  const f=await completedNativeCase(t,{retire:true,drift:false,independent:true});
  const before=await captureCurrentSetReplacementSource(f.specPath);
  const product=f.root+'/'+f.productFile,original=await fs.readFile(product);
  await fs.appendFile(product,'// unvalidated change\n');
  await assert.rejects(()=>captureCurrentSetReplacementSource(f.specPath),e=>['REPLAN_REQUIRED','EVIDENCE_STALE'].includes(e.code));
  await fs.writeFile(product,original);
  const continuity=decode(before.files.get('continuity.json'));
  const evidence=f.image.f.execution+'/'+continuity.deliveries[0].evidence.path;
  const bytes=await fs.readFile(evidence);await fs.writeFile(evidence,'{}\n');
  await assert.rejects(()=>captureCurrentSetReplacementSource(f.specPath));
  await fs.writeFile(evidence,bytes);
  assert.deepEqual((await captureCurrentSetReplacementSource(f.specPath)).activationBytes,before.activationBytes);
});
