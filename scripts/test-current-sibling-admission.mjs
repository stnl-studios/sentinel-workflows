import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {finding} from './fixtures/current-validation-evidence.mjs';
import {composePostConversionValidation} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentExecution,captureCurrentActiveExecution,validateCurrentReviewCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {captureCurrentSetReplacementSource} from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
const decode=bytes=>JSON.parse(Buffer.from(bytes));
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');

test('VALIDATE live sibling revalidation recovers stale terminal basis through a fresh official terminal judgment',async t=>{
  const f=await completedNativeCase(t,{retire:false,independent:true});
  await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const before=await captureCurrentExecution(f.specPath);assert.equal(before.inspection.state,'COMPLETE');
  const continuity=decode(before.files.get('continuity.json')),sibling=continuity.deliveries[0];
  const terminal=continuity.deliveries.find(item=>item.deliveryId===f.delivery.deliveryId);
  await fs.appendFile(path.join(f.root,'src/greeting.mjs'),'// independently validated sibling delta\n');
  await normalizedFormal({...f,delivery:sibling});
  const after=await captureCurrentExecution(f.specPath);
  assert.ok(after.inspection.deliveries.every(item=>item.formalStatus==='PASS'&&item.observedValidation==='current'));
  assert.equal(after.inspection.state,'EVIDENCE_STALE');
  assert.deepEqual(after.inspection.normalHandoff,{operation:'VALIDATE_SLICE',slice:terminal.slice,deliveryId:terminal.deliveryId});
  assert.match(after.inspection.diagnostics[0].reason,/terminal judgment product basis differs/u);
  await assert.rejects(()=>captureCurrentSetReplacementSource(f.specPath),{code:'REPLAN_REQUIRED'});
  assert.deepEqual(after.files.get('approved-preparation.json'),before.files.get('approved-preparation.json'));
  assert.deepEqual(after.files.get(terminal.evidence.path),before.files.get(terminal.evidence.path));
  const proofBefore=decode(after.files.get(terminal.evidence.path));
  const start=await begin({specPath:f.specPath,slice:terminal.slice,
    expectedActivationId:after.inspection.activationId,operation:'VALIDATE_SLICE'});
  await assert.rejects(()=>reserveDispatch(start.handle),error=>error.code==='EVIDENCE_INCOMPLETE'
    && /explicit terminal dispatch/u.test(error.message));
  const dispatch=await reserveDispatch(start.handle,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const agentId='mechanical-refreshed-terminal';await bindNative(start.handle,agentId);
  const origin=decode(await fs.readFile(dispatch.originFile));
  assert.notEqual((await captureCurrentActiveExecution(f.specPath,origin.admission.reservedActivation.activeAttempt)).inspection.state,'COMPLETE');
  const measured=await verifyNative(dispatch.originFile);
  const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{
    status:'PASS',commands:measured.commands,evidence:'Fresh independent mechanical review of the current integral combination.',
    findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',
    persistenceSummary:'Retain the prior local evidence and publish a new terminal judgment.'},newFindings:[]});
  const tool=path.join(f.root,'fresh-terminal-result.json');await fs.writeFile(tool,json({agentId,status:'completed',finalResponse}));
  await captureNative(start.handle,tool);assert.equal((await publish(start.handle)).publication,'confirmed');
  const repaired=await captureCurrentExecution(f.specPath);
  assert.equal(repaired.inspection.state,'COMPLETE');assert.equal(repaired.inspection.normalHandoff,null);
  assert.deepEqual(repaired.files.get(sibling.evidence.path),after.files.get(sibling.evidence.path));
  assert.deepEqual(repaired.files.get('approved-preparation.json'),before.files.get('approved-preparation.json'));
  const proofAfter=decode(repaired.files.get(terminal.evidence.path));
  assert.notEqual(proofAfter.validation.origin.runnerId,proofBefore.validation.origin.runnerId);
  assert.equal(Number(proofAfter.validation.id.slice(8)),Number(proofBefore.validation.id.slice(8))+1);
});

async function completeApply(f) {
  const before=await captureCurrentExecution(f.specPath);
  const start=await begin({specPath:f.specPath,slice:f.delivery.slice,
    expectedActivationId:before.inspection.activationId,operation:'APPLY_FINDINGS'});
  await fs.appendFile(path.join(f.root,f.productFile),'// independently checked correction\n');
  const dispatch=await reserveDispatch(start.handle),agentId='mechanical-sibling-apply';
  await bindNative(start.handle,agentId);const measured=await verifyNative(dispatch.originFile);
  const requestBytes=await fs.readFile(dispatch.requestFile);
  const finalResponse=JSON.stringify({format:'stnl-current-findings-response-v1',requestSha256:sha(requestBytes),result:{
    status:'TESTS_PASS',automaticCheckRound:'1/3',head:f.head,commands:measured.commands,
    discoverySources:'Reviewed task, greeting module and prepared test.',discoveryActions:'Inspected the independent greeting contribution.',
    verificationTypesConsidered:'Prepared Node behavior test.',nonApplicabilityRationale:'none',
    noVerificationCommandConfirmation:'The applicable prepared check ran.',resultOfEachCommandAndExitCode:'The prepared test exited zero.',
    selectedChecks:'Prepared greeting test.',selectionRationale:'The approved acceptance obligation is exercised.',
    coverage:'The independent greeting export is exercised.',findingsVerified:'finding-01',
    correctionsCovered:'The approved greeting contribution was corrected.',regressionsSelected:'Greeting import assertion.',
    unsupportedActiveFindings:'none',failures:'none',evidenceOrFailureSummary:'The prepared check passed.',
    affectedFilesOrBehaviors:f.productFile,blockers:'none',unexpectedWorkspaceEffects:'none',
    persistenceSummary:'The original sibling proof is retained unchanged.'}});
  const tool=path.join(f.root,'sibling-apply-result.json');await fs.writeFile(tool,json({agentId,status:'completed',finalResponse}));
  const captured=await captureNative(start.handle,tool);
  assert.equal((await publish(start.handle)).publication,'confirmed');
  return {start,dispatch,captured};
}

test('APPLY after independent sibling validation binds its own formal predecessor',async t=>{
  const f=await completedNativeCase(t,{retire:false,independent:true});
  await normalizedFormal(f,{status:'NEEDS_FIX',references:'finding-01',dispositions:'finding-01=active',
    beforeCapture:async({dispatch,tool})=>{
      const request=decode(await fs.readFile(dispatch.requestFile)),result=decode(await fs.readFile(tool));
      const response=JSON.parse(result.finalResponse),item={...finding(request.base.counters.findings+1,Number(request.attemptId.slice(8))),
        relatedAuthority:request.authority.delivery.obligations[0].requirement};
      response.newFindings=[item];response.result.findingReferences=item.id;response.result.findingDispositions=item.id+'=active';
      result.finalResponse=JSON.stringify(response);await fs.writeFile(tool,json(result));
    }});
  const needsFix=await captureCurrentExecution(f.specPath),continuity=decode(needsFix.files.get('continuity.json'));
  const sibling=continuity.deliveries[0];
  assert.equal(needsFix.inspection.deliveries.find(item=>item.deliveryId===f.delivery.deliveryId).formalStatus,'NEEDS_FIX',JSON.stringify(needsFix.inspection));
  await fs.appendFile(path.join(f.root,'src/greeting.mjs'),'// independently validated before findings correction\n');
  await normalizedFormal({...f,delivery:sibling});
  const before=await captureCurrentExecution(f.specPath);
  assert.equal(decode(before.activationBytes).lastAttempt.deliveryId,sibling.deliveryId);
  assert.equal(before.inspection.normalHandoff.operation,'APPLY_FINDINGS');
  assert.equal(before.inspection.normalHandoff.deliveryId,f.delivery.deliveryId);
  const corrected=await completeApply(f);
  const origin=decode(await fs.readFile(corrected.dispatch.originFile));
  assert.equal(origin.admission.baseActivation.lastAttempt.deliveryId,sibling.deliveryId);
  assert.equal(origin.owner.deliveryId,f.delivery.deliveryId);
  const after=await captureCurrentExecution(f.specPath);
  const result=after.inspection.deliveries.find(item=>item.deliveryId===f.delivery.deliveryId);
  assert.equal(result.formalStatus,'NEEDS_FIX');assert.equal(result.auxiliaryStatus,'TESTS_PASS');
  assert.equal(after.inspection.normalHandoff.operation,'VALIDATE_SLICE');
  assert.deepEqual(after.files.get(sibling.evidence.path),before.files.get(sibling.evidence.path));
});

function changedOrigin(image,current,edit) {
  const files=new Map([...image.files].map(([name,bytes])=>[name,Buffer.from(bytes)]));
  const continuity=decode(files.get('continuity.json')),selected=continuity.deliveries.find(item=>item.deliveryId===current.deliveryId);
  const old=selected.evidence.sha256,bundle=decode(files.get(selected.evidence.path));
  const object=bundle.objects.find(item=>item.id===bundle.validation.sources.origin);
  const capsule=decode(Buffer.from(object.bytesBase64,'base64')),origin=JSON.parse(capsule.originUtf8);edit(origin);
  capsule.originUtf8=JSON.stringify(origin)+'\n';capsule.dispatchUtf8=capsule.originUtf8;
  const bytes=json(capsule);object.id=sha(bytes);object.bytesBase64=bytes.toString('base64');
  bundle.validation.sources.origin=object.id;bundle.objects.sort((a,b)=>a.id<b.id?-1:1);
  const next=json(bundle);selected.evidence.sha256=sha(next);files.set(selected.evidence.path,next);
  files.set('continuity.json',json(continuity));const task=`tasks/${selected.slice}.md`;
  files.set(task,Buffer.from(files.get(task).toString('utf8').replaceAll(old,selected.evidence.sha256)));
  return files;
}
async function rejectSameDeliveryTampering(t,f,operation) {
  const image=await captureCurrentExecution(f.specPath),activation=decode(image.activationBytes);
  assert.equal(activation.lastAttempt.deliveryId,f.delivery.deliveryId);
  assert.equal(image.inspection.normalHandoff?.operation,operation,JSON.stringify(image.inspection));
  const file=path.join(f.image.f.execution,'activation.json');
  for(const [name,edit]of Object.entries({
    'operation id':last=>{last.operationRef.operationId=randomUUID();},
    'allocation digest':last=>{last.operationRef.allocationSha256='sha256:'+'0'.repeat(64);},
  }))await t.test(`${operation} preserves same-delivery ${name} authentication`,async()=>{
    const changed=structuredClone(activation);edit(changed.lastAttempt);
    await fs.writeFile(file,json(changed));
    try {
      await assert.rejects(()=>begin({specPath:f.specPath,slice:f.delivery.slice,operation,
        expectedActivationId:activation.activationId}),error=>error.code==='OWNER_MISMATCH');
    } finally {await fs.writeFile(file,image.activationBytes);}
  });
  for(const [name,edit]of Object.entries({
    'owner':origin=>{origin.owner.ownershipToken=randomUUID();},
    'origin context':origin=>{origin.specPath=path.join(f.root,'foreign-requirements.md');},
  }))await t.test(`${operation} rejects foreign ${name} after outer rehashing`,async()=>{
    const files=changedOrigin(image,f.delivery,edit);
    await assert.rejects(()=>validateCurrentReviewCandidate({specPath:f.specPath,files}),
      error=>error.code==='OWNER_MISMATCH');
  });
  const after=await captureCurrentExecution(f.specPath);
  assert.deepEqual(after.activationBytes,image.activationBytes);assert.deepEqual(after.files,image.files);
}

test('selected delivery still requires its exact terminal reference, owner and origin',async t=>{
  const f=await completedNativeCase(t,{retire:false,independent:true});
  await rejectSameDeliveryTampering(t,f,'VALIDATE_SLICE');
  await normalizedFormal(f,{status:'NEEDS_FIX',references:'finding-01',dispositions:'finding-01=active',
    beforeCapture:async({dispatch,tool})=>{
      const request=decode(await fs.readFile(dispatch.requestFile)),result=decode(await fs.readFile(tool));
      const response=JSON.parse(result.finalResponse),item={...finding(request.base.counters.findings+1,Number(request.attemptId.slice(8))),
        relatedAuthority:request.authority.delivery.obligations[0].requirement};
      response.newFindings=[item];response.result.findingReferences=item.id;response.result.findingDispositions=item.id+'=active';
      result.finalResponse=JSON.stringify(response);await fs.writeFile(tool,json(result));
    }});
  await rejectSameDeliveryTampering(t,f,'APPLY_FINDINGS');
});

async function capturedSources(originFile) {
  const get=name=>fs.readFile(originFile.replace('.origin.json','.'+name+'.json'));
  return {transport:'native',origin:await get('origin'),dispatch:await get('origin'),
    rawResponse:await get('response'),receipt:await get('receipt'),baselineCapture:await get('baseline'),
    agentBinding:await get('agent'),agentClaim:await get('claim'),concludedToolResult:await get('tool-result'),
    verificationObservation:await get('observation'),validationRequest:await get('request'),removalProofs:[]};
}

test('sibling incorporation requires exact native A0/A1 and a verified recorded sibling reference',async t=>{
  const f=await completedNativeCase(t,{retire:false,independent:true,drift:false});
  const before=await captureCurrentExecution(f.specPath),sibling=decode(before.files.get('continuity.json')).deliveries[0];
  await fs.appendFile(path.join(f.root,'src/greeting.mjs'),'// next independently captured proof\n');
  const captured=await normalizedFormal({...f,delivery:sibling},{captureOnly:true});
  assert.equal(captured.captureError,undefined);
  const a0=decode(before.activationBytes),a1=decode(await fs.readFile(path.join(f.image.f.execution,'activation.json')));
  const capture=await capturedSources(captured.dispatch.originFile);
  const options={context:before.context,requirementsAuthority:before.requirementsAuthority,deliveryId:sibling.deliveryId,
    previous:{activationBytes:before.activationBytes,files:before.files},
    admission:{activationBytes:json(a1),files:before.files},capture};
  for(const [name,mutate,code,message]of [
    ['missing last operation',activation=>{activation.lastAttempt=null;},'EVIDENCE_INCOMPLETE',/predecessor formal is not incorporated/u],
    ['non-recorded sibling',activation=>{activation.lastAttempt.outcome='rejected';},'EVIDENCE_INCOMPLETE',/predecessor formal is not incorporated/u],
    ['missing sibling reference',activation=>{delete activation.lastAttempt.operationRef;},'EVIDENCE_INCOMPLETE',/predecessor formal is not incorporated/u],
    ['foreign sibling attempt',activation=>{activation.lastAttempt.operationAttemptId=randomUUID();},'OWNER_MISMATCH',/last sibling formal differs/u],
    ['foreign sibling allocation',activation=>{activation.lastAttempt.operationRef.allocationSha256='sha256:'+'0'.repeat(64);},'OWNER_MISMATCH',/terminal operationRef differs/u],
    ['foreign sibling terminal activation',activation=>{activation.lastAttempt.terminalActivationId=randomUUID();},'EVIDENCE_INCOMPLETE',/predecessor formal is not incorporated/u],
  ])await t.test(name,async()=>{
    // Adversarial in-memory input only. Even coherent edited A0/A1 documents
    // cannot replace the original sibling evidence or its operation reference.
    const base=structuredClone(a0);mutate(base);
    const reserved=structuredClone(a1);reserved.lastAttempt=base.lastAttempt;
    const source=decode(capture.origin);source.admission.baseActivation=base;source.admission.reservedActivation=reserved;
    const forged={...capture,origin:json(source),dispatch:json(source)};
    await assert.rejects(()=>composePostConversionValidation({...options,
      previous:{...options.previous,activationBytes:json(base)},
      admission:{...options.admission,activationBytes:json(reserved)},capture:forged}),
      error=>error.code===code&&message.test(error.message));
  });
  await t.test('unbound admission cannot invoke the sibling exception',async()=>{
    const wrong=structuredClone(a1);wrong.previousActivationId=randomUUID();
    await assert.rejects(()=>composePostConversionValidation({...options,
      admission:{...options.admission,activationBytes:json(wrong)}}),
      error=>error.code==='OWNER_MISMATCH'&&/reservation is not the admitted owner/u.test(error.message));
  });
  assert.equal((await publish(captured.start.handle)).publication,'confirmed');
  const after=await captureCurrentExecution(f.specPath);
  assert.ok(after.inspection.deliveries.every(item=>item.formalStatus==='PASS'&&item.observedValidation==='current'));
  assert.deepEqual(await capturedSources(captured.dispatch.originFile),capture);
});
