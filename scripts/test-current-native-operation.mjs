import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {nativeOperationCase,reservedOperation} from './fixtures/current-native-operation.mjs';
import {captureCurrentExecution,captureCurrentActiveExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {captureCurrentExecution as captureQualityExecution} from '../skills/workflows/stnl-slice-quality-manager/runtime/execution-current-reader.mjs';
import {inspectPostConversionEvidence} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {begin,bindNative,verifyNative,captureNative,publish,cleanup,resume,reserveDispatch,prepareNativeContinuation} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=promisify(execFile);
const blocked=code=>error=>error?.code===code;
const result=(status,head,commands,extra={})=>({status,head,commands,
  evidence:'Mechanical fixture judgment only; the live native smoke is recorded separately.',
  findingReferences:status==='NEEDS_FIX'?'finding-01':'none',
  findingDispositions:status==='NEEDS_FIX'?'finding-01=active':'none',
  blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'none',...extra});
async function toolFile(fixture,agentId,response,name='tool-result.json') {
  const file=path.join(fixture.root,name);
  await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse:response})+'\n');
  return file;
}
async function capturedMechanical(test,status,newFindings=[]) {
  const fixture=await reservedOperation(test);
  const agentId=`mechanical-${status.toLowerCase()}`;
  await bindNative(fixture.start.handle,agentId);
  const measured=await verifyNative(fixture.dispatch.originFile);
  const request=await fs.readFile(fixture.dispatch.requestFile);
  const payload=result(status,fixture.head,measured.commands,
    status==='BLOCKED'?{blockers:'Mechanical case has an explicit review blocker.'}:{});
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:sha(request),result:payload,newFindings});
  const file=await toolFile(fixture,agentId,response);
  await captureNative(fixture.start.handle,file);
  return {...fixture,response};
}

test('EC-1 distributed runtime sources are byte-identical',async()=>{
  const workflows=['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor',
    'stnl-slice-quality-manager','stnl-spec-roadmap','stnl-spec-test-runbook',
    'stnl-spec-lifecycle-manager'];
  for(const module of ['execution-current.mjs','execution-publication.mjs']) {
    const copies=await Promise.all(workflows.map(async workflow=>fs.readFile(path.join(repo,
      'skills/workflows',workflow,workflow==='stnl-spec-lifecycle-manager'?'runtime/lib':'runtime',module))));
    for(const copy of copies.slice(1)) assert.ok(copy.equals(copies[0]),`${module} copy differs`);
  }
  for(const module of ['execution-current-reader.mjs','current-evidence-state.mjs',
    'execution-current-operation.mjs']) {
    const [executor,manager]=await Promise.all(['stnl-slice-executor','stnl-slice-quality-manager']
      .map(workflow=>fs.readFile(path.join(repo,'skills/workflows',workflow,'runtime',module))));
    assert.ok(executor.equals(manager),`${module} copy differs`);
  }
});

test('EC-1 mechanical: concurrent ingress admits one owner and one dispatch',async t=>{
  const fixture=await nativeOperationCase(t);
  const args={specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:fixture.activationId};
  const attempts=await Promise.allSettled([begin(args),begin(args)]);
  const won=attempts.filter(item=>item.status==='fulfilled');
  const lost=attempts.filter(item=>item.status==='rejected');
  assert.equal(won.length,1);assert.equal(lost.length,1);
  assert.ok(['OWNER_ACTIVE','STALE_BASE','OWNER_UNCERTAIN','EXECUTION_PUBLICATION_BLOCKED'].includes(lost[0].reason.code),
    `${lost[0].reason.code}: ${lost[0].reason.message}`);
  const handle=won[0].value.handle;
  const dispatch=await reserveDispatch(handle);
  assert.equal(dispatch.phase,'dispatch-reserved');
  await assert.rejects(()=>reserveDispatch(handle),blocked('OWNER_UNCERTAIN'));
  assert.equal((await resume(handle)).phase,'dispatch-reserved');
});

test('EC-1 mechanical: bound result bytes replay exactly, altered result is refused',async t=>{
  const fixture=await reservedOperation(t);
  const {handle}=fixture.start,agentId='mechanical-agent-one';
  await bindNative(handle,agentId);
  await assert.rejects(()=>bindNative(handle,agentId),blocked('OWNER_UNCERTAIN'));
  const measured=await verifyNative(fixture.dispatch.originFile);
  assert.equal(measured.status,'completed');
  const request=await fs.readFile(fixture.dispatch.requestFile);
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:sha(request),result:result('PASS',fixture.head,measured.commands),newFindings:[]});
  const file=await toolFile(fixture,agentId,response);
  const captured=await captureNative(handle,file);
  assert.equal(captured.status,'PASS');
  assert.equal(captured.rawResponseSha256,sha(Buffer.from(response)));
  assert.equal((await captureNative(handle,file)).replayed,true);
  const raw=await fs.readFile(path.join(path.dirname(fixture.dispatch.originFile),'round-1.response.json'));
  assert.ok(raw.equals(Buffer.from(response,'utf8')));
  const changed=await toolFile(fixture,agentId,response+' ', 'changed-tool-result.json');
  await assert.rejects(()=>captureNative(handle,changed),blocked('OWNER_MISMATCH'));
  const foreign=await toolFile(fixture,'mechanical-foreign',response,'foreign-tool-result.json');
  await assert.rejects(()=>captureNative(handle,foreign),blocked('OWNER_MISMATCH'));
  assert.equal((await resume(handle)).phase,'captured');
});

test('EC-1 native judgment variant is selected before agent and binds measured HEAD and request',async t=>{
  const fixture=await nativeOperationCase(t);
  const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:fixture.activationId});
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  assert.equal(dispatch.responseVariant,'stnl-current-native-judgment-v1');
  const origin=JSON.parse(await fs.readFile(dispatch.originFile));
  assert.equal(origin.responseVariant,dispatch.responseVariant);
  assert.equal(origin.requestSha256,dispatch.requestSha256);
  await bindNative(start.handle,'mechanical-bound-judgment');
  const measured=await verifyNative(dispatch.originFile);
  const observed=JSON.parse(await fs.readFile(measured.observationFile));
  assert.equal(observed.format,'stnl-runner-verification-v3');
  assert.equal(observed.binding.head,fixture.head);
  assert.equal(observed.binding.requestSha256,dispatch.requestSha256);
  const response=JSON.stringify({format:'stnl-current-native-judgment-v1',
    result:(({head,...rest})=>rest)(result('PASS',fixture.head,measured.commands)),newFindings:[]});
  const file=await toolFile(fixture,'mechanical-bound-judgment',response);
  const captured=await captureNative(start.handle,file);
  assert.equal(captured.status,'PASS');
  assert.equal(captured.rawResponseSha256,sha(Buffer.from(response)));
  assert.equal((await captureNative(start.handle,file)).replayed,true);
  const changed=await toolFile(fixture,'mechanical-bound-judgment',response+' ','changed-native-judgment.json');
  await assert.rejects(()=>captureNative(start.handle,changed),blocked('OWNER_MISMATCH'));
  const published=await publish(start.handle);
  assert.equal(published.publication,'confirmed');
  const image=await captureCurrentExecution(fixture.specPath);
  assert.equal(image.inspection.deliveries.find(item=>item.deliveryId===fixture.delivery.deliveryId).formalStatus,'PASS');
  const activation=JSON.parse(Buffer.from(image.activationBytes));
  const continuity=JSON.parse(Buffer.from(image.files.get('continuity.json')));
  const current=structuredClone(continuity.deliveries.find(item=>item.deliveryId===fixture.delivery.deliveryId));
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path)));
  const source=bundle.validation.sources.verificationObservation;
  const object=bundle.objects.find(item=>item.id===source);
  const tamperedObservation=JSON.parse(Buffer.from(object.bytesBase64,'base64'));
  tamperedObservation.binding.head='a'.repeat(40);
  const changedObservation=Buffer.from(JSON.stringify(tamperedObservation)+'\n');
  object.id=sha(changedObservation);object.bytesBase64=changedObservation.toString('base64');
  bundle.validation.sources.verificationObservation=object.id;
  bundle.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const bundleBytes=Buffer.from(JSON.stringify(bundle)+'\n');
  current.evidence.sha256=sha(bundleBytes);
  await assert.rejects(()=>inspectPostConversionEvidence({context:image.context,
    snapshotBytes:image.files.get('approved-preparation.json'),current,bundleBytes,
    observedWork:image.observedByDelivery.get(current.deliveryId).manifest,
    admissionRef:activation.lastAttempt.operationRef}),error=>
    ['EVIDENCE_STALE','EVIDENCE_INCOMPLETE','INVALID_CURRENT_IMAGE'].includes(error.code));
});

test('EC-1 native judgment preserves a legacy bare response as a rejected content result', async t=>{
  const fixture=await nativeOperationCase(t);
  const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:fixture.activationId});
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  await bindNative(start.handle,'mechanical-legacy-bare-response');
  const measured=await verifyNative(dispatch.originFile);
  const response=JSON.stringify(result('PASS',fixture.head,measured.commands));
  const file=await toolFile(fixture,'mechanical-legacy-bare-response',response);
  assert.equal((await captureNative(start.handle,file)).captureClass,'formal-rejection');
  assert.equal((await resume(start.handle)).nextAction,'publish');
  await assert.rejects(()=>reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'}),blocked('OWNER_UNCERTAIN'));
  const raw=await fs.readFile(path.join(path.dirname(dispatch.originFile),'round-1.response.json'),'utf8');
  assert.equal(raw,response,'the original refusal cannot be rewritten into a valid envelope');
});

test('EC-1 native judgment rejects foreign metadata, changed recipe and altered binding',async t=>{
  for(const kind of ['foreign-head','foreign-request','foreign-agent','wrong-round',
    'changed-request','wrong-format','changed-recipe','changed-observation']) await t.test(kind,async sub=>{
    const fixture=await nativeOperationCase(sub);
    const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
      expectedActivationId:fixture.activationId});
    const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
    await bindNative(start.handle,`mechanical-${kind}`);
    const measured=await verifyNative(dispatch.originFile);
    if(kind==='changed-request') await fs.appendFile(dispatch.requestFile,' ');
    if(kind==='wrong-round') {
      const observed=JSON.parse(await fs.readFile(measured.observationFile));
      observed.round=2;
      await fs.writeFile(measured.observationFile,JSON.stringify(observed)+'\n');
    }
    if(kind==='changed-recipe') await fs.appendFile(path.join(fixture.image.f.execution,'tasks',`${fixture.delivery.slice}.md`),'\nlate recipe edit\n');
    if(kind==='changed-observation') {
      const observed=JSON.parse(await fs.readFile(measured.observationFile));
      observed.binding.head='a'.repeat(40);
      await fs.writeFile(measured.observationFile,JSON.stringify(observed)+'\n');
    }
    const response={format:'stnl-current-native-judgment-v1',
      result:(({head,...rest})=>rest)(result('PASS',fixture.head,measured.commands)),newFindings:[]};
    if(kind==='foreign-head') response.result.head='a'.repeat(40);
    if(kind==='foreign-request') response.requestSha256='sha256:'+'a'.repeat(64);
    if(kind==='wrong-format') response.format='stnl-current-validation-response-v1';
    const file=await toolFile(fixture,kind==='foreign-agent'?'mechanical-other':`mechanical-${kind}`,
      JSON.stringify(response));
    if(['foreign-head','foreign-request','wrong-format'].includes(kind)) {
      assert.equal((await captureNative(start.handle,file)).captureClass,'formal-rejection');
      assert.equal((await resume(start.handle)).nextAction,'publish');
    } else {
    await assert.rejects(()=>captureNative(start.handle,file),error=>
      ['RUNNER_RESULT_REJECTED','EVIDENCE_STALE','OWNER_UNCERTAIN','OWNER_MISMATCH',
        'INVALID_CURRENT_IMAGE'].includes(error.code));
    assert.notEqual((await resume(start.handle)).nextAction,'publish');
    }
  });
});

test('EC-1 mechanical: product drift blocks verification or publication under the owner',async t=>{
  await t.test('before recipe',async sub=>{
    const fixture=await reservedOperation(sub);
    await bindNative(fixture.start.handle,'mechanical-drift-before');
    await fs.appendFile(path.join(fixture.root,'src/greeting.mjs'),'// changed before recipe\n');
    await assert.rejects(()=>verifyNative(fixture.dispatch.originFile),blocked('EVIDENCE_STALE'));
    assert.equal((await resume(fixture.start.handle)).phase,'running');
  });
  await t.test('after capture',async sub=>{
    const fixture=await capturedMechanical(sub,'PASS');
    await fs.appendFile(path.join(fixture.root,'src/greeting.mjs'),'// changed after capture\n');
    await assert.rejects(()=>publish(fixture.start.handle),blocked('EVIDENCE_STALE'));
    assert.equal((await resume(fixture.start.handle)).phase,'captured');
  });
});

test('EC-1 captured VALIDATE drift retains the owner and forbids stale publication',async t=>{
  const fixture=await capturedMechanical(t,'PASS');
  const ownerRoot=path.dirname(fixture.dispatch.originFile);
  const responseBefore=await fs.readFile(path.join(ownerRoot,'round-1.response.json'));
  const activationFile=path.join(fixture.image.f.execution,'activation.json');
  const continuityFile=path.join(fixture.image.f.execution,'continuity.json');
  const activationBefore=await fs.readFile(activationFile);
  const continuityBefore=await fs.readFile(continuityFile);
  await fs.appendFile(path.join(fixture.root,'src/greeting.mjs'),'// drift after capture\n');
  await assert.rejects(()=>publish(fixture.start.handle),blocked('EVIDENCE_STALE'));
  const retained=await resume(fixture.start.handle);
  assert.equal(retained.phase,'captured');
  assert.equal(retained.responseSha256,sha(responseBefore));
  const handleFile=path.join(fixture.root,'stale-validation-handle.json');
  await fs.writeFile(handleFile,JSON.stringify(fixture.start.handle)+'\n');
  const cli=path.join(repo,'skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
  const restarted=JSON.parse((await run(process.execPath,
    [cli,'resume','--handle',handleFile],{timeout:30000})).stdout);
  assert.equal(restarted.phase,'captured');
  assert.equal(restarted.responseSha256,sha(responseBefore));
  await assert.rejects(()=>begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:fixture.start.activationA1}),error=>
    ['OWNER_UNCERTAIN','UNSUPPORTED_FORMAT'].includes(error?.code));
  await assert.rejects(()=>reserveDispatch(fixture.start.handle),blocked('OWNER_UNCERTAIN'));
  assert.deepEqual(await fs.readFile(path.join(ownerRoot,'round-1.response.json')),responseBefore);
  assert.deepEqual(await fs.readFile(activationFile),activationBefore);
  assert.deepEqual(await fs.readFile(continuityFile),continuityBefore);
  await assert.rejects(fs.lstat(path.join(ownerRoot,'round-2.origin.json')),error=>error.code==='ENOENT');
});

test('EC-1 PASS then approved product drift completes a second VALIDATE with its own owner',async t=>{
  const fixture=await capturedMechanical(t,'PASS');
  const first=await publish(fixture.start.handle);
  assert.equal(first.publication,'confirmed');
  assert.equal(first.cleanup,'complete');
  const cleanA=await captureCurrentExecution(fixture.specPath);
  const cleanB=await captureQualityExecution(fixture.specPath);
  assert.deepEqual(cleanA.inspection,cleanB.inspection);
  const cleanDelivery=cleanA.inspection.deliveries.find(item=>item.deliveryId===fixture.delivery.deliveryId);
  assert.equal(cleanDelivery.formalStatus,'PASS');
  assert.equal(cleanA.inspection.normalHandoff,null);
  await assert.rejects(()=>begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:cleanA.inspection.activationId}),blocked('UNSUPPORTED_FORMAT'));
  const prior=JSON.parse(Buffer.from(cleanA.files.get('continuity.json'))).deliveries
    .find(item=>item.deliveryId===fixture.delivery.deliveryId);
  await fs.appendFile(path.join(fixture.root,'src/greeting.mjs'),'// equivalent approved output drift\n');
  const staleA=await captureCurrentExecution(fixture.specPath);
  const staleB=await captureQualityExecution(fixture.specPath);
  assert.deepEqual(staleA.inspection,staleB.inspection);
  assert.equal(staleA.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  assert.equal(staleA.inspection.normalHandoff?.deliveryId,fixture.delivery.deliveryId);
  const second=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:staleA.inspection.activationId});
  assert.notEqual(second.owner.operationAttemptId,fixture.start.owner.operationAttemptId);
  const dispatch=await reserveDispatch(second.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  const request=JSON.parse(await fs.readFile(dispatch.requestFile));
  assert.equal(request.format,'stnl-current-validation-request-v3');
  assert.equal(request.base.evidenceSha256,prior.evidence.sha256);
  assert.deepEqual(request.base.counters,prior.counters);
  const agentId='mechanical-second-drift-validation';
  await bindNative(second.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const {head,...semantic}=result('PASS',fixture.head,measured.commands);
  const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result:semantic,newFindings:[]});
  const tool=await toolFile(fixture,agentId,finalResponse,'second-drift-validation-tool.json');
  const captured=await captureNative(second.handle,tool);
  assert.equal(captured.status,'PASS');
  assert.equal(captured.rawResponseSha256,sha(Buffer.from(finalResponse)));
  assert.equal((await captureNative(second.handle,tool)).replayed,true);
  const different=await toolFile(fixture,agentId,finalResponse+' ','second-drift-changed-tool.json');
  await assert.rejects(()=>captureNative(second.handle,different),blocked('OWNER_MISMATCH'));
  const ownerRoot=path.dirname(dispatch.originFile);
  const responseBefore=await fs.readFile(path.join(ownerRoot,'round-1.response.json'));
  const observationBefore=await fs.readFile(path.join(ownerRoot,'round-1.observation.json'));
  await assert.rejects(()=>publish(second.handle,{checkpoint:async phase=>{
    if(phase==='after-candidate-file') throw new Error('controlled second VALIDATE candidate fault');
  }}),/controlled second VALIDATE candidate fault/u);
  const handleFile=path.join(fixture.root,'second-drift-validation-handle.json');
  await fs.writeFile(handleFile,JSON.stringify(second.handle)+'\n');
  const cli=path.join(repo,'skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
  const separate=async command=>JSON.parse((await run(process.execPath,
    [cli,command,'--handle',handleFile],{timeout:30000})).stdout);
  const resumed=await separate('resume');
  assert.equal(resumed.nextAction,'normalize');
  assert.equal(resumed.responseSha256,captured.rawResponseSha256);
  const normalized=await separate('normalize');
  assert.equal(normalized.rawResponseSha256,captured.rawResponseSha256);
  const published=await separate('publish');
  assert.equal(published.publication,'confirmed');
  assert.equal(published.cleanup,'complete');
  assert.equal(published.transition.outcome,'recorded');
  assert.deepEqual(await fs.readFile(path.join(ownerRoot,'round-1.response.json')),responseBefore);
  assert.deepEqual(await fs.readFile(path.join(ownerRoot,'round-1.observation.json')),observationBefore);
  await assert.rejects(fs.lstat(path.join(ownerRoot,'round-2.origin.json')),error=>error.code==='ENOENT');
  const finalA=await captureCurrentExecution(fixture.specPath);
  const finalB=await captureQualityExecution(fixture.specPath);
  assert.deepEqual(finalA.inspection,finalB.inspection);
  assert.equal(finalA.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(finalA.inspection.normalHandoff,null);
  assert.equal(finalA.inspection.deliveries[0].counters.validationAttempts,
    prior.counters.validationAttempts+1);
  assert.equal(JSON.parse(Buffer.from(finalA.activationBytes)).lastAttempt.operationAttemptId,
    second.owner.operationAttemptId);
});

test('EC-1 mechanical: malformed finding is retained as a concluded rejection',async t=>{
  const fixture=await reservedOperation(t);
  const {handle}=fixture.start,agentId='mechanical-agent-invalid';
  await bindNative(handle,agentId);
  const measured=await verifyNative(fixture.dispatch.originFile);
  const request=await fs.readFile(fixture.dispatch.requestFile);
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:sha(request),result:result('NEEDS_FIX',fixture.head,measured.commands),
    newFindings:[{id:'finding-01',severity:'medium',originAttempt:'attempt-02',
      problem:'Fixture misses direct coverage.',evidence:'The prepared assertion checks the wrong module.',
      impact:'AC-001 is unproven.',relatedAuthority:'AC-001; obligation-01',
      expectedCorrection:'Import the expected module.'}]});
  const file=await toolFile(fixture,agentId,response);
  const captured=await captureNative(handle,file);
  assert.equal(captured.captureClass,'formal-rejection');
  const operationRoot=path.dirname(fixture.dispatch.originFile);
  assert.ok((await fs.readFile(path.join(operationRoot,'round-1.response.json')))
    .equals(Buffer.from(response,'utf8')));
  const receipt=JSON.parse(await fs.readFile(path.join(operationRoot,'round-1.receipt.json')));
  assert.equal(receipt.status,'RUNNER_RESULT_BLOCKED');
  assert.match(receipt.captureFailure,/newFindings\[0\]\.severity/u);
  assert.equal((await resume(handle)).nextAction,'publish');
  const published=await publish(handle);
  assert.equal(published.transition.outcome,'rejected');
  assert.equal(published.activation.lastAttempt.outcome,'rejected');
  const readback=await captureCurrentExecution(fixture.specPath);
  assert.equal(readback.inspection.normalHandoff.operation,'VALIDATE_SLICE');
});

test('EC-1 mechanical: valid BLOCKED and NEEDS_FIX remain their own formal outcomes',async t=>{
  for(const status of ['BLOCKED','NEEDS_FIX']) await t.test(status,async sub=>{
    const findings=status==='NEEDS_FIX'?[{id:'finding-01',severity:'blocking',
      originAttempt:'attempt-02',problem:'Mechanical fixture finding for serializer coverage.',
      evidence:'Synthetic case exercises the finding persistence boundary.',
      impact:'AC-001 remains under mechanical review.',relatedAuthority:'AC-001; obligation-01',
      expectedCorrection:'Recheck the approved assertion in the test fixture.'}]:[];
    const fixture=await capturedMechanical(sub,status,findings);
    const published=await publish(fixture.start.handle);
    assert.equal(published.publication,'confirmed');
    const inspection=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'continuity.json')));
    const delivery=inspection.deliveries.find(item=>item.deliveryId===fixture.delivery.deliveryId);
    const bundle=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,delivery.evidence.path)));
    assert.ok(bundle.validation.recordUtf8.includes(`- Status: ${status}`));
    assert.equal(bundle.openFindings.length,status==='NEEDS_FIX'?1:0);
  });
});

test('EC-1 mechanical: terminal fault resumes same installed bytes and owned cleanup',async t=>{
  const fixture=await capturedMechanical(t,'PASS');
  const handle=fixture.start.handle;
  await assert.rejects(()=>publish(handle,{checkpoint:async phase=>{
    if(phase==='after-terminal-activation') throw new Error('mechanical terminal fault');
  }}),/mechanical terminal fault/u);
  assert.equal((await resume(handle)).phase,'activation_written');
  const recovered=await publish(handle);
  assert.equal(recovered.publication,'confirmed');
  assert.equal(recovered.cleanup,'complete');
  assert.equal((await resume(handle)).phase,'committed');
});

test('EC-1 mechanical: backup and intermediate faults retain one captured result',async t=>{
  for(const phase of ['after-backup','after-activation']) await t.test(phase,async sub=>{
    const fixture=await capturedMechanical(sub,'PASS');
    const handle=fixture.start.handle;
    await assert.rejects(()=>publish(handle,{checkpoint:async current=>{
      if(current===phase) throw new Error(`mechanical ${phase} fault`);
    }}),new RegExp(`mechanical ${phase} fault`,'u'));
    const state=await resume(handle);
    assert.equal(state.phase,phase==='after-backup'?'captured':'activation_written');
    const final=await publish(handle);
    assert.equal(final.publication,'confirmed');
    assert.equal((await resume(handle)).phase,'committed');
  });
});

test('EC-1 mechanical: registry cleanup failure remains pending and resumes without checks',async t=>{
  const fixture=await capturedMechanical(t,'PASS');
  const handle=fixture.start.handle;
  const published=await publish(handle,{checkpoint:async phase=>{
    if(phase==='before-registry-completion') throw new Error('mechanical registry fault');
  }});
  assert.equal(published.publication,'confirmed');
  assert.equal(published.cleanup,'pending');
  assert.equal((await resume(handle)).nextAction,'cleanup');
  const finished=await cleanup(handle);
  assert.equal(finished.cleanup,'complete');
  assert.equal((await resume(handle)).nextAction,'none');
});

test('EC-1 mechanical: quiet proof refuses a stripped admission witness',async t=>{
  const fixture=await capturedMechanical(t,'PASS');
  await publish(fixture.start.handle);
  const image=await captureCurrentExecution(fixture.specPath);
  const activation=JSON.parse(Buffer.from(image.activationBytes).toString('utf8'));
  assert.ok(activation.lastAttempt.operationRef);
  const continuity=JSON.parse(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
  const current=structuredClone(continuity.deliveries.find(item=>item.deliveryId===fixture.delivery.deliveryId));
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path)).toString('utf8'));
  const originId=bundle.validation.sources.origin;
  const object=bundle.objects.find(item=>item.id===originId);
  const packed=JSON.parse(Buffer.from(object.bytesBase64,'base64').toString('utf8'));
  const origin=JSON.parse(packed.originUtf8);
  assert.ok(origin.admission);
  delete origin.admission;
  packed.originUtf8=JSON.stringify(origin)+'\n';
  packed.dispatchUtf8=packed.originUtf8;
  const bytes=Buffer.from(JSON.stringify(packed)+'\n');
  object.id=sha(bytes);object.bytesBase64=bytes.toString('base64');
  bundle.validation.sources.origin=object.id;
  bundle.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const bundleBytes=Buffer.from(JSON.stringify(bundle)+'\n');
  current.evidence.sha256=sha(bundleBytes);
  await assert.rejects(()=>inspectPostConversionEvidence({context:image.context,
    snapshotBytes:image.files.get('approved-preparation.json'),current,bundleBytes,
    observedWork:image.observedByDelivery.get(current.deliveryId).manifest,
    admissionRef:activation.lastAttempt.operationRef}),/admission witness is absent/u);
});

test('EC-1 mechanical: A1 verifies prior lastAttempt before candidate supersession',async t=>{
  const fixture=await capturedMechanical(t,'PASS');
  await publish(fixture.start.handle);
  await fs.appendFile(path.join(fixture.root,'src/greeting.mjs'),'// equivalent drift\n');
  const quiet=await captureCurrentExecution(fixture.specPath);
  const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:quiet.inspection.activationId});
  const file=path.join(fixture.image.f.execution,'activation.json');
  const activation=JSON.parse(await fs.readFile(file,'utf8'));
  activation.lastAttempt.operationAttemptId='11111111-1111-4111-8111-111111111111';
  await fs.writeFile(file,JSON.stringify(activation)+'\n');
  await assert.rejects(()=>captureCurrentActiveExecution(fixture.specPath,activation.activeAttempt),
    blocked('EVIDENCE_INCOMPLETE'));
  assert.equal(start.activationA1,activation.activationId);
});


async function unstartedContinuation(test) {
  const f=await nativeOperationCase(test),start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:f.activationId});
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  const agentId='/root/mechanical-continuation';await bindNative(start.handle,agentId);
  const toolResultFile=await toolFile(f,agentId,'  arbitrary pre-verification response\r\nπ\n','initialization.json');
  const binding={parentThreadId:'parent',parentTurnId:'parent-turn',agentPath:agentId,agentThreadId:'child',model:'gpt-6-luna',effort:'medium'};
  return {...f,start,dispatch,agentId,input:{toolResultFile,binding,firstTurnId:'initial-turn'},operationRoot:path.dirname(dispatch.originFile)};
}
test('native pre-verification continuation preserves initialization, publishes one judgment and replays without work',async t=>{
  const f=await unstartedContinuation(t),first=await fs.readFile(f.input.toolResultFile);
  assert.deepEqual(await prepareNativeContinuation(f.start.handle,{...f.input,commit:false}),{eligible:true});
  const admitted=await prepareNativeContinuation(f.start.handle,f.input);assert.equal(admitted.replayed,false);
  assert.equal((await prepareNativeContinuation(f.start.handle,f.input)).replayed,true);
  await assert.rejects(prepareNativeContinuation(f.start.handle,{...f.input,firstTurnId:'other'}));
  const measured=await verifyNative(f.dispatch.originFile),producer=await fs.readFile(path.join(f.operationRoot,'round-1.verification.json'));
  const text=JSON.stringify({format:'stnl-current-native-judgment-v1',result:(({head,...rest})=>rest)(result('PASS',f.head,measured.commands)),newFindings:[]});
  const file=await toolFile(f,f.agentId,text,'continued.json');const envelope=JSON.parse(await fs.readFile(file));
  envelope.preVerificationContinuation=admitted.grant;await fs.writeFile(file,JSON.stringify(envelope)+'\n');
  const ownerBefore=await fs.readFile(path.join(f.operationRoot,'owner.json'));
  for(const fault of ['missing','changed-first','changed-binding','changed-round']) {
    const forged=structuredClone(envelope);
    if(fault==='missing')delete forged.preVerificationContinuation;
    if(fault==='changed-first')forged.preVerificationContinuation.firstToolResultUtf8+='changed';
    if(fault==='changed-binding')forged.preVerificationContinuation.binding.agentThreadId='foreign';
    if(fault==='changed-round')forged.preVerificationContinuation.round++;
    await fs.writeFile(file,JSON.stringify(forged)+'\n');
    await assert.rejects(captureNative(f.start.handle,file));
    assert.deepEqual(await fs.readFile(path.join(f.operationRoot,'owner.json')),ownerBefore);
  }
  await fs.writeFile(file,JSON.stringify(envelope)+'\n');
  assert.equal((await captureNative(f.start.handle,file)).status,'PASS');
  assert.equal((await captureNative(f.start.handle,file)).replayed,true);
  assert.equal((await prepareNativeContinuation(f.start.handle,f.input)).replayed,true,
    'captured but unpublished evidence may confirm its existing grant without admitting work');
  assert.equal((await publish(f.start.handle)).publication,'confirmed');
  const image=await captureCurrentExecution(f.specPath);assert.equal(image.inspection.deliveries.find(x=>x.deliveryId===f.delivery.deliveryId).formalStatus,'PASS');
  const sources=[...image.files].filter(([n])=>n.startsWith('evidence/')).map(([,b])=>JSON.parse(Buffer.from(b)));
  assert.ok(sources.some(b=>b.objects.some(o=>{try{return JSON.parse(Buffer.from(o.bytesBase64,'base64')).preVerificationContinuation?.firstToolResultUtf8===first.toString('utf8');}catch{return false;}})));
  assert.deepEqual(await fs.readFile(f.input.toolResultFile),first);
  assert.deepEqual(await fs.readFile(path.join(f.operationRoot,'round-1.verification.json')),producer);
});
test('formal continuation spends the same correction credit and cannot grant a successor after invalid judgment',async t=>{
  const f=await unstartedContinuation(t);
  const admission=await prepareNativeContinuation(f.start.handle,f.input);
  await verifyNative(f.dispatch.originFile);
  const file=await toolFile(f,f.agentId,'INVALID_AFTER_INITIALIZATION','failed-continuation.json');
  const tool=JSON.parse(await fs.readFile(file));tool.preVerificationContinuation=admission.grant;
  await fs.writeFile(file,JSON.stringify(tool)+'\n');
  const raw=await fs.readFile(file),observation=await fs.readFile(path.join(f.operationRoot,'round-1.verification.json'));
  assert.equal((await captureNative(f.start.handle,file)).captureClass,'formal-rejection');
  assert.equal((await captureNative(f.start.handle,file)).replayed,true);
  await publish(f.start.handle);
  const image=await captureCurrentExecution(f.specPath),continuity=JSON.parse(Buffer.from(image.files.get('continuity.json'))),current=continuity.deliveries.find(x=>x.slice===f.delivery.slice);
  assert.equal(current.normalization.consumedInvocations,2);assert.equal(current.normalization.status,'exhausted');
  assert.equal(image.inspection.normalHandoff,null);
  assert.deepEqual(await fs.readFile(file),raw);assert.deepEqual(await fs.readFile(path.join(f.operationRoot,'round-1.verification.json')),observation);
});
for(const fault of ['started','observed','foreign-control','changed-work','identity','first-bytes'])test(`native continuation refuses ${fault}`,async t=>{
  const f=await unstartedContinuation(t);let input=f.input;
  if(fault==='started')await fs.writeFile(path.join(f.operationRoot,'round-1.verification.json'),JSON.stringify({status:'started'}));
  if(fault==='observed')await verifyNative(f.dispatch.originFile);
  if(fault==='foreign-control')await fs.writeFile(path.join(f.operationRoot,'unknown.json'),'{}');
  if(fault==='changed-work')await fs.appendFile(path.join(f.root,'src/greeting.mjs'),'// drift\n');
  if(fault==='identity')input={...input,binding:{...input.binding,agentPath:'/root/foreign'}};
  if(fault==='first-bytes')await fs.writeFile(input.toolResultFile,JSON.stringify({agentId:f.agentId,status:'inProgress',finalResponse:'waiting'}));
  const before=await fs.readFile(path.join(f.operationRoot,'owner.json'));
  if(['started','observed'].includes(fault))assert.equal(await prepareNativeContinuation(f.start.handle,input),null);
  else await assert.rejects(prepareNativeContinuation(f.start.handle,input));
  assert.deepEqual(await fs.readFile(path.join(f.operationRoot,'owner.json')),before);
});
test('native continuation admission wins against a verifier not yet holding the shared start lease',async t=>{
  const f=await unstartedContinuation(t),lstat=fs.lstat,entered=Promise.withResolvers(),gate=Promise.withResolvers();
  const output=path.join(f.operationRoot,'round-1.verification.json');let paused=false;
  fs.lstat=async(file,...args)=>{if(file===output&&!paused){paused=true;entered.resolve();await gate.promise;}return lstat(file,...args);};
  const old=verifyNative(f.dispatch.originFile);const rejected=assert.rejects(old,/predates continuation/);
  try {await entered.promise;await prepareNativeContinuation(f.start.handle,f.input);}
  finally {gate.resolve();fs.lstat=lstat;}
  await rejected;await assert.rejects(fs.lstat(output),{code:'ENOENT'});
  assert.equal((await verifyNative(f.dispatch.originFile)).status,'completed');
});
test('native verification start wins the shared lease before continuation admission',async t=>{
  const f=await unstartedContinuation(t),open=fs.open,entered=Promise.withResolvers(),gate=Promise.withResolvers();
  const output=path.join(f.operationRoot,'round-1.verification.json');
  fs.open=async(file,...args)=>{if(file===output&&args[0]==='wx'){entered.resolve();await gate.promise;}return open(file,...args);};
  const verifying=verifyNative(f.dispatch.originFile);
  try {await entered.promise;await assert.rejects(prepareNativeContinuation(f.start.handle,f.input));}
  finally {gate.resolve();fs.open=open;}
  await verifying;assert.equal(await prepareNativeContinuation(f.start.handle,f.input),null);
});
test('continuation refuses work drift after admission before replay or verification start',async t=>{
  const f=await unstartedContinuation(t);await prepareNativeContinuation(f.start.handle,f.input);
  await fs.appendFile(path.join(f.root,'src/greeting.mjs'),'// authorized output, different bound work\n');
  await assert.rejects(prepareNativeContinuation(f.start.handle,f.input),/bound work changed/);
  await assert.rejects(verifyNative(f.dispatch.originFile),/bound work changed/);
  await assert.rejects(fs.lstat(path.join(f.operationRoot,'round-1.verification.json')),{code:'ENOENT'});
});
