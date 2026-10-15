import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {nativeOperationCase,reservedOperation} from './fixtures/current-native-operation.mjs';
import {captureCurrentExecution,captureCurrentActiveExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {inspectPostConversionEvidence} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {begin,bindNative,verifyNative,captureNative,publish,cleanup,resume,reserveDispatch} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
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
    await assert.rejects(()=>captureNative(start.handle,file),error=>
      ['RUNNER_RESULT_REJECTED','EVIDENCE_STALE','OWNER_UNCERTAIN','OWNER_MISMATCH',
        'INVALID_CURRENT_IMAGE'].includes(error.code));
    assert.notEqual((await resume(start.handle)).nextAction,'publish');
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
