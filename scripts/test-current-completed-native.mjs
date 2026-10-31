import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {finding} from './fixtures/current-validation-evidence.mjs';
import {canonical} from './fixtures/current-quiet-reader.mjs';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {overlappingPostImage} from './fixtures/current-reader-campaign.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {begin,publish,resume,normalizeSuccessor,normalize,reserveDispatch,bindNative,verifyNative,captureNative} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {completedEvidenceContext} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
const run=promisify(execFile),sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(canonical(value)+'\n');
const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
const separate=async(specPath)=>JSON.parse((await run(process.execPath,[cli,'inspect','--spec-path',specPath])).stdout);

test('C01 completed A stays literal while two legal B native validations publish',async t=>{
  const f=await completedNativeCase(t),before=await captureCurrentExecution(f.specPath);
  assert.equal(before.inspection.completed[0].observedValidation,'current');
  assert.equal(before.inspection.normalHandoff.slice,'slice-02');
  const snapshot=Buffer.from(before.files.get('approved-preparation.json'));
  const a=JSON.parse(Buffer.from(before.files.get('continuity.json'))).completed[0];
  const first=await normalizedFormal(f,{partial:true,terminalFault:true});
  assert.equal(first.published.publication,'confirmed');
  const after=await captureCurrentExecution(f.specPath);
  assert.deepEqual(Buffer.from(after.files.get('approved-preparation.json')),snapshot);
  assert.deepEqual(Buffer.from(after.files.get(a.evidence.path)),Buffer.from(before.files.get(a.evidence.path)));
  assert.equal(after.inspection.deliveries[0].counters.validationAttempts,3);
  assert.equal(after.inspection.normalHandoff,null);
  // Retire all transient allocations. Fresh reads and the next operation must
  // rely on the proof's self-contained sources, not a previous namespace.
  await fs.rename(path.join(f.root,'tmp/sentinel'),path.join(f.root,'tmp/retired-controls'));
  assert.deepEqual(await separate(f.specPath),after.inspection);
  await fs.writeFile(path.join(f.root,'other/greeting.mjs'),'export const greeting="hello"; // B second drift\n');
  await normalizedFormal(f);
  const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].counters.validationAttempts,4);
  assert.equal(final.inspection.completed[0].observedValidation,'current');
  assert.equal(final.inspection.state,'VALIDATION_BLOCKED');
});

for(const status of ['NEEDS_FIX','BLOCKED'])test(`C03 valid ${status} publishes literally and exposes only the legal handoff`,async t=>{
  const f=await completedNativeCase(t);
  const result=await normalizedFormal(f,{beforeCapture:async({tool,dispatch})=>{
    const doc=JSON.parse(await fs.readFile(tool)),response=JSON.parse(doc.finalResponse);
    response.result.status=status;
    if(status==='NEEDS_FIX') {
      const request=JSON.parse(await fs.readFile(dispatch.requestFile));
      response.newFindings=[finding(1,Number(request.attemptId.slice(8)))];
      response.result.findingReferences='finding-01';response.result.findingDispositions='finding-01=active';
    } else response.result.blockers='Controlled dependency prevents a formal conclusion.';
    doc.finalResponse=JSON.stringify(response);await fs.writeFile(tool,JSON.stringify(doc)+'\n');
  }});
  assert.equal(result.published.publication,'confirmed');
  const image=await captureCurrentExecution(f.specPath),item=image.inspection.deliveries[0];
  assert.equal(item.formalStatus,status);assert.equal(image.inspection.normalHandoff?.operation??null,status==='NEEDS_FIX'?'APPLY_FINDINGS':null);
  assert.match(Buffer.from(image.files.get('tasks/slice-02.md')).toString('utf8'),status==='NEEDS_FIX'?/Current action: APPLY_FINDINGS/u:/Current action: blocked/u);
  for(const operation of status==='NEEDS_FIX'?['VALIDATE_SLICE']:['VALIDATE_SLICE','APPLY_FINDINGS'])await assert.rejects(()=>begin({specPath:f.specPath,
    slice:'slice-02',operation,expectedActivationId:image.inspection.activationId}));
  await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:'slice-02',expectedActivationId:image.inspection.activationId}));
  assert.deepEqual(await separate(f.specPath),image.inspection);
});

test('C04 completed drift and snapshot substitution refuse before recipe and promotion',async t=>{
  const f=await completedNativeCase(t,{sharedInput:true}),before=await captureCurrentExecution(f.specPath);
  const start=await begin({specPath:f.specPath,slice:'slice-02',expectedActivationId:before.inspection.activationId});
  const dispatch=await reserveDispatch(start.handle);await bindNative(start.handle,'controlled-completed-drift');
  const aFile=path.join(f.root,'src/greeting.mjs'),aBytes=await fs.readFile(aFile);
  const snapshotFile=path.join(f.image.f.execution,'approved-preparation.json'),snapshotBytes=await fs.readFile(snapshotFile);
  const sharedFile=path.join(f.root,'shared-config.json'),sharedBytes=await fs.readFile(sharedFile);
  const guardedFiles=[[aFile,aBytes],[sharedFile,sharedBytes],[snapshotFile,snapshotBytes]];
  for(const [file,bytes]of guardedFiles) {
    await fs.writeFile(file,Buffer.concat([bytes,Buffer.from('\n')]));
    await assert.rejects(()=>verifyNative(dispatch.originFile));
    await fs.writeFile(file,bytes);
  }
  const measured=await verifyNative(dispatch.originFile),request=await fs.readFile(dispatch.requestFile);
  const finalResponse=JSON.stringify({format:'stnl-current-validation-response-v1',requestSha256:sha(request),
    result:{status:'PASS',head:f.head,commands:measured.commands,evidence:'Controlled recipe observation.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',
      persistenceSummary:'No changes during validation.'},newFindings:[]});
  const tool=path.join(f.root,'controlled-tool.json');await fs.writeFile(tool,JSON.stringify({agentId:'controlled-completed-drift',status:'completed',finalResponse}));
  await captureNative(start.handle,tool);
  const activation=await fs.readFile(path.join(f.image.f.execution,'activation.json'));
  for(const [file,bytes]of guardedFiles) {
    await fs.writeFile(file,Buffer.concat([bytes,Buffer.from('\n')]));
    await assert.rejects(()=>publish(start.handle));
    assert.deepEqual(await fs.readFile(path.join(f.image.f.execution,'activation.json')),activation);
    await fs.writeFile(file,bytes);
  }
  assert.equal((await resume(start.handle)).nextAction,'publish');
  assert.equal((await publish(start.handle)).publication,'confirmed');
});

test('C05 fresh evidence requires current snapshot, owner, native admission and complete sources',async t=>{
  const f=await completedNativeCase(t);await normalizedFormal(f);
  const image=await captureCurrentExecution(f.specPath),snapshotBytes=Buffer.from(image.files.get('approved-preparation.json'));
  const original=JSON.parse(Buffer.from(image.files.get('continuity.json'))),selected=original.deliveries[0];
  const bundle=JSON.parse(Buffer.from(image.files.get(selected.evidence.path)));
  const inspect=async mutate=>{
    const continuity=structuredClone(original),files=new Map(image.files),changed=structuredClone(bundle);
    mutate(changed);const bytes=json(changed);files.set(selected.evidence.path,bytes);continuity.deliveries[0].evidence.sha256=sha(bytes);
    return completedEvidenceContext({context:image.context,snapshotBytes,continuity,files});
  };
  const replace=(b,field,mutate)=>{
    const id=b.validation.sources[field==='validationRequest'?'origin':field],object=b.objects.find(value=>value.id===id);
    const source=JSON.parse(Buffer.from(object.bytesBase64,'base64'));
    if(field==='origin'||field==='validationRequest') {
      const key=field==='origin'?'originUtf8':'validationRequestUtf8',inner=JSON.parse(source[key]);
      mutate(inner);source[key]=JSON.stringify(inner)+'\n';
      if(field==='origin')source.dispatchUtf8=source[key];
    } else mutate(source);
    const bytes=json(source),next=sha(bytes);
    const updated=JSON.parse(JSON.stringify(b).replaceAll(id,next));
    const target=updated.objects.find(value=>value.id===next);target.bytesBase64=bytes.toString('base64');
    updated.objects.sort((a,b)=>a.id<b.id?-1:1);Object.assign(b,updated);
  };
  for(const field of ['origin','concludedToolResult'])assert.ok(bundle.objects.some(value=>value.id===bundle.validation.sources[field]));
  const capsule=JSON.parse(Buffer.from(bundle.objects.find(value=>value.id===bundle.validation.sources.origin).bytesBase64,'base64'));
  assert.equal(typeof capsule.originUtf8,'string');assert.equal(typeof capsule.validationRequestUtf8,'string');
  const cases={
    'digest alone':b=>{b.validation.recordUtf8+='\n';},
    'offline origin':b=>replace(b,'origin',o=>{delete o.admission;}),
    'old snapshot':b=>replace(b,'validationRequest',r=>{r.base.approvedSnapshotSha256='sha256:'+'0'.repeat(64);}),
    'reassigned owner':b=>replace(b,'origin',o=>{o.owner.deliveryId=original.completed[0].deliveryId;}),
    'broken A1':b=>replace(b,'origin',o=>{o.admission.reservedActivation.previousActivationId=o.admission.reservedActivation.activationId;}),
    'missing source':b=>{b.objects=b.objects.filter(o=>o.id!==b.validation.sources.concludedToolResult);},
    'foreign result':b=>replace(b,'concludedToolResult',o=>{o.agentId='other-runner';}),
  };
  for(const [name,mutate]of Object.entries(cases))await t.test(name,()=>assert.rejects(()=>inspect(mutate),
    error=>['INVALID_CURRENT_IMAGE','EVIDENCE_INCOMPLETE','OWNER_MISMATCH','EVIDENCE_STALE','UNSUPPORTED_FORMAT'].includes(error.code)));
  const context=await completedEvidenceContext({context:image.context,snapshotBytes,continuity:original,files:image.files});
  assert.deepEqual([...context.fresh],[selected.deliveryId]);
  assert.notEqual(context.retainedEvidence.find(value=>value.deliveryId===selected.deliveryId).evidenceSha256,selected.evidence.sha256);
});

test('C06 concluded NEEDS_FIX without its required blocker publishes a bounded semantic refusal',async t=>{
  const f=await completedNativeCase(t),attempt=await normalizedFormal(f,{captureOnly:true,beforeCapture:async({tool})=>{
    const doc=JSON.parse(await fs.readFile(tool)),response=JSON.parse(doc.finalResponse);
    response.result.status='NEEDS_FIX';doc.finalResponse=JSON.stringify(response);await fs.writeFile(tool,JSON.stringify(doc));
  }});
  assert.equal(attempt.captureError,undefined);assert.equal(attempt.captured.phase,'captured');
  assert.equal((await resume(attempt.start.handle)).nextAction,'publish');
  await assert.rejects(()=>normalize(attempt.start.handle));await assert.rejects(()=>reserveDispatch(attempt.start.handle));
  assert.equal((await publish(attempt.start.handle)).transition.outcome,'rejected');
  const image=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.match(current.lastDiagnostic.reason,/NEEDS_FIX requires active blocker/u);
  assert.equal(current.normalization.status,'settled');assert.equal(current.counters.validationAttempts,2);
  assert.equal(image.inspection.deliveries[0].formalStatus,null);
  const source=await fs.readFile(path.join(path.dirname(attempt.dispatch.originFile),'round-1.response.json'),'utf8');
  assert.equal(JSON.parse(source).result.status,'NEEDS_FIX');
});

test('C07 offline native-looking retained base cannot reserve an official completed operation',async t=>{
  const f=await overlappingPostImage(t);
  await fs.writeFile(path.join(f.project,'fourth/state.mjs'),'export const state=1;\n');
  await fs.writeFile(path.join(f.project,'third/later.mjs'),'export const greeting="private B drift";\n');
  const before=await captureCurrentExecution(f.specPath);
  assert.equal(before.inspection.normalHandoff?.slice,'slice-02');
  await assert.rejects(()=>begin({specPath:f.specPath,slice:'slice-02',expectedActivationId:before.inspection.activationId}),
    error=>error.code==='UNSUPPORTED_FORMAT'&&/official A0\/A1 admission/u.test(error.message));
  assert.deepEqual(await fs.readFile(path.join(f.execution,'activation.json')),Buffer.from(before.activationBytes));
});

test('C02 concluded invalid literal response consumes one call and requires publication before its successor',async t=>{
  const f=await completedNativeCase(t),before=await captureCurrentExecution(f.specPath);
  const attempt=await normalizedFormal(f,{invalid:true,captureOnly:true});
  assert.equal(attempt.captureError,undefined);
  const status=await resume(attempt.start.handle);
  assert.equal(status.nextAction,'publish');
  const active=JSON.parse(await fs.readFile(path.join(f.image.f.execution,'activation.json')));
  assert.equal(active.activeAttempt.operationAttemptId,attempt.start.owner.operationAttemptId);
  assert.deepEqual(await fs.readFile(path.join(f.image.f.execution,'continuity.json')),Buffer.from(before.files.get('continuity.json')));
  await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:'slice-02',expectedActivationId:active.activationId}));
  await assert.rejects(()=>begin({specPath:f.specPath,slice:'slice-02',expectedActivationId:active.activationId}));
  assert.equal((await publish(attempt.start.handle)).transition.outcome,'rejected');
  const image=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.equal(current.normalization.status,'settled');assert.equal(current.normalization.consumedInvocations,1);
  assert.deepEqual(current.counters,before.inspection.deliveries[0].counters);
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path))),ref=bundle.support.find(item=>item.kind==='rejection');
  assert.equal(Buffer.from(bundle.objects.find(item=>item.id===ref.sources.rawResponse).bytesBase64,'base64').toString('utf8'),attempt.finalResponse);
  const successor=await normalizeSuccessor({specPath:f.specPath,slice:'slice-02',expectedActivationId:image.inspection.activationId});
  assert.notEqual(successor.owner.operationAttemptId,attempt.start.owner.operationAttemptId);
});
