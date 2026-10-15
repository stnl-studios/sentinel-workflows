import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {blockingFormalCase} from './fixtures/current-native-findings-operation.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {captureCurrentExecution as captureQualityExecution} from '../skills/workflows/stnl-slice-quality-manager/runtime/execution-current-reader.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish,inspect,normalizeSuccessor,resume} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

let nativeNumber=0;
const run=promisify(execFile);
const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function findingsRound(fixture,start,{status=null,invalid=false,edit=null,
  headOverride=null,requestShaOverride=null,beforeCapture=null,responseVariant=null,
  semanticInvalid=false}={}) {
  if(edit!==null) await fs.writeFile(path.join(fixture.root,'src/greeting.mjs'),edit);
  const dispatch=await reserveDispatch(start.handle,responseVariant?{responseVariant}:undefined);
  const request=JSON.parse(await fs.readFile(dispatch.requestFile));
  const agentId=`mechanical-recovery-agent-${++nativeNumber}`;
  await bindNative(start.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const result={status,automaticCheckRound:`${request.round}/3`,head:headOverride??fixture.head,
    discoverySources:'Approved task and source.',discoveryActions:'Inspected approved check.',
    verificationTypesConsidered:'Approved Node module test.',nonApplicabilityRationale:'none',
    noVerificationCommandConfirmation:'An applicable check ran.',commands:measured.commands,
    resultOfEachCommandAndExitCode:'The approved module test completed.',
    selectedChecks:'Approved Node module test.',selectionRationale:'AC-001 coverage.',
    coverage:'Greeting export checked.',findingsVerified:'finding-01',
    correctionsCovered:'Approved greeting export.',regressionsSelected:'Greeting assertion.',
    unsupportedActiveFindings:'none',failures:status==='TESTS_FAIL'?'Greeting differs.':'none',
    evidenceOrFailureSummary:'The official helper recorded the test.',
    affectedFilesOrBehaviors:'src/greeting.mjs',blockers:'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'No product edit by runner.'};
  const {head,...semantic}=result;
  if(semanticInvalid) semantic.coverage='none';
  const response=invalid?'{"invalid":':responseVariant
    ?JSON.stringify({format:'stnl-current-native-judgment-v1',result:semantic})
    :JSON.stringify({format:'stnl-current-findings-response-v1',
      requestSha256:requestShaOverride??digest(await fs.readFile(dispatch.requestFile)),result});
  const tool=path.join(fixture.root,`mechanical-recovery-tool-${nativeNumber}.json`);
  await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse:response})+'\n');
  if(beforeCapture) await beforeCapture(dispatch);
  const captured=await captureNative(start.handle,tool);
  return {dispatch,request,captured,tool,response};
}
async function rejectedFirst(test,{priorFailures=0}={}) {
  const {fixture}=await blockingFormalCase(test);
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  const first=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
  for(let index=0;index<priorFailures;index+=1) {
    const failed=await findingsRound(fixture,first,{status:'TESTS_FAIL'});
    assert.equal(failed.captured.status,'TESTS_FAIL');
  }
  const rejected=await findingsRound(fixture,first,{invalid:true,
    edit:'export const greeting="hello";\n'});
  assert.equal(rejected.captured.captureClass,'findings-rejection');
  const published=await publish(first.handle);
  assert.equal(published.transition.outcome,'rejected');
  const current=await captureCurrentExecution(fixture.specPath);
  assert.equal(current.inspection.deliveries[0].counters.findingsChecks,priorFailures);
  return {fixture,first,rejected,published,current};
}

test('EC-1 APPLY refusal resumes a partial publication in a new process with the original budget',async t=>{
  const {fixture}=await blockingFormalCase(t);
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  const first=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
  const rejected=await findingsRound(fixture,first,{invalid:true,
    edit:'export const greeting="hello";\n'});
  assert.equal(rejected.captured.captureClass,'findings-rejection');
  const ownerRoot=path.dirname(rejected.dispatch.originFile);
  const responseBefore=await fs.readFile(path.join(ownerRoot,'round-1.response.json'));
  const verificationBefore=await fs.readFile(path.join(ownerRoot,'round-1.verification.json'));
  assert.equal(responseBefore.toString('utf8'),rejected.response);
  await assert.rejects(()=>publish(first.handle,{checkpoint:async phase=>{
    if(phase==='after-candidate-file')
      throw Object.assign(new Error('controlled APPLY candidate failure'),{code:'CONTROLLED_APPLY_CANDIDATE_FAILURE'});
  }}),error=>error?.code==='CONTROLLED_APPLY_CANDIDATE_FAILURE');

  const handleFile=path.join(fixture.root,'apply-rejection-handle.json');
  await fs.writeFile(handleFile,JSON.stringify(first.handle)+'\n');
  const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
  const separate=async command=>JSON.parse((await run(process.execPath,
    [cli,command,'--handle',handleFile],{timeout:30000})).stdout);
  const interrupted=await separate('resume');
  assert.equal(interrupted.nextAction,'normalize');
  await assert.rejects(()=>publish(first.handle),error=>error?.code==='NORMALIZATION_NOT_ELIGIBLE');
  const repaired=await separate('normalize');
  assert.equal(repaired.phase,'prepared');
  assert.equal(repaired.rawResponseSha256,digest(responseBefore));
  const published=await separate('publish');
  assert.equal(published.publication,'confirmed');
  assert.equal(published.cleanup,'complete');
  assert.equal(published.transition.outcome,'rejected');
  assert.deepEqual(published.transition.counters,
    {implementationChecks:1,findingsChecks:0,validationAttempts:2,findings:1});
  assert.deepEqual(await fs.readFile(path.join(ownerRoot,'round-1.response.json')),responseBefore);
  assert.deepEqual(await fs.readFile(path.join(ownerRoot,'round-1.verification.json')),verificationBefore);
  assert.equal((await separate('resume')).phase,'committed');

  const readback=await captureCurrentExecution(fixture.specPath);
  assert.equal(readback.inspection.normalHandoff.operation,'APPLY_FINDINGS');
  assert.deepEqual(readback.inspection.deliveries[0].counters,published.transition.counters);
  const successor=await normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:readback.inspection.activationId});
  assert.notEqual(successor.owner.operationAttemptId,first.owner.operationAttemptId);
  const accepted=await findingsRound(fixture,successor,{status:'TESTS_PASS'});
  assert.equal(accepted.request.format,'stnl-current-findings-request-v2');
  assert.equal(accepted.request.round,2);
  assert.equal(accepted.request.invocation,1);
  assert.equal(accepted.request.checkId,'findings-check-01');
  const closed=await publish(successor.handle);
  assert.equal(closed.transition.counters.findingsChecks,1);
  assert.equal(closed.transition.counters.validationAttempts,2);
});

test('EC-1 APPLY concluded invalid response publishes a bounded refusal',async t=>{
  const {fixture}=await blockingFormalCase(t);
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  const started=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
  await fs.writeFile(path.join(fixture.root,'src/greeting.mjs'),'export const greeting="hello";\n');
  const dispatch=await reserveDispatch(started.handle);
  const agentId='mechanical-findings-rejection-agent';
  await bindNative(started.handle,agentId);
  await verifyNative(dispatch.originFile);
  const tool=path.join(fixture.root,'invalid-apply-tool.json');
  await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse:'{"invalid":'})+'\n');
  const capture=await captureNative(started.handle,tool);
  assert.equal(capture.captureClass,'findings-rejection');
  const replay=await captureNative(started.handle,tool);
  assert.equal(replay.replayed,true);
  assert.equal(replay.rawResponseSha256,capture.rawResponseSha256);
  const published=await publish(started.handle);
  assert.equal(published.publication,'confirmed');
  const readback=await inspect(fixture.specPath);
  assert.equal(readback.normalHandoff.operation,'APPLY_FINDINGS');
  const successor=await normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:readback.activationId});
  assert.notEqual(successor.owner.operationAttemptId,started.owner.operationAttemptId);
  const next=await reserveDispatch(successor.handle);
  const request=JSON.parse(await fs.readFile(next.requestFile));
  assert.equal(request.format,'stnl-current-findings-request-v2');
  assert.equal(request.round,2);
  assert.equal(request.invocation,1);
  const nextAgent='mechanical-findings-successor-agent';
  await bindNative(successor.handle,nextAgent);
  const measured=await verifyNative(next.originFile);
  const response={format:'stnl-current-findings-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(await fs.readFile(next.requestFile)).digest('hex')}`,
    result:{status:'TESTS_PASS',automaticCheckRound:'2/3',head:fixture.head,
      discoverySources:'Approved task, source and test.',discoveryActions:'Inspected approved source and test.',
      verificationTypesConsidered:'Approved Node module test.',nonApplicabilityRationale:'none',
      noVerificationCommandConfirmation:'An applicable check ran.',commands:measured.commands,
      resultOfEachCommandAndExitCode:'The approved module test completed.',
      selectedChecks:'Approved Node module test.',selectionRationale:'AC-001 coverage.',
      coverage:'The greeting export is exercised by the prepared test.',findingsVerified:'finding-01',
      correctionsCovered:'The greeting export now equals hello.',regressionsSelected:'Greeting import assertion.',
      unsupportedActiveFindings:'none',failures:'none',evidenceOrFailureSummary:'The approved test exited zero.',
      affectedFilesOrBehaviors:'src/greeting.mjs',blockers:'none',unexpectedWorkspaceEffects:'none',
      persistenceSummary:'The native helper retained the reviewed observation; the runner made no product changes.'}};
  const nextTool=path.join(fixture.root,'successor-apply-tool.json');
  await fs.writeFile(nextTool,JSON.stringify({agentId:nextAgent,status:'completed',finalResponse:JSON.stringify(response)})+'\n');
  const nextCapture=await captureNative(successor.handle,nextTool);
  assert.equal(nextCapture.status,'TESTS_PASS');
  const nextPublished=await publish(successor.handle);
  assert.equal(nextPublished.publication,'confirmed');
  const ready=await inspect(fixture.specPath);
  assert.equal(ready.normalHandoff.operation,'VALIDATE_SLICE');
  const formal=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:ready.activationId});
  const formalDispatch=await reserveDispatch(formal.handle);
  const formalAgent='mechanical-findings-formal-agent';
  await bindNative(formal.handle,formalAgent);
  const formalMeasured=await verifyNative(formalDispatch.originFile);
  const formalRequest=JSON.parse(await fs.readFile(formalDispatch.requestFile));
  assert.equal(formalRequest.format,'stnl-current-validation-request-v4');
  const formalResponse={format:'stnl-current-validation-response-v1',
    requestSha256:`sha256:${createHash('sha256').update(await fs.readFile(formalDispatch.requestFile)).digest('hex')}`,
    result:{status:'PASS',head:fixture.head,commands:formalMeasured.commands,
      evidence:'The approved test observed the corrected greeting export.',
      findingReferences:'finding-01',findingDispositions:'finding-01=resolved',blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'none'},newFindings:[]};
  const formalTool=path.join(fixture.root,'formal-after-successor-tool.json');
  await fs.writeFile(formalTool,JSON.stringify({agentId:formalAgent,status:'completed',
    finalResponse:JSON.stringify(formalResponse)})+'\n');
  await captureNative(formal.handle,formalTool);
  const final=await publish(formal.handle);
  assert.equal(final.publication,'confirmed');
});

test('EC-1 rejection at global 3 consumes the final call without a fourth or successor',async t=>{
  const {fixture,published,current}=await rejectedFirst(t,{priorFailures:2});
  assert.equal(published.transition.normalization.consumedInvocations,3);
  assert.equal(published.transition.normalization.status,'exhausted');
  assert.equal(current.inspection.normalHandoff,null);
  assert.equal(current.inspection.deliveries[0].counters.findingsChecks,2);
  await assert.rejects(()=>normalizeSuccessor({specPath:fixture.specPath,
    slice:fixture.delivery.slice,expectedActivationId:current.inspection.activationId}),
  error=>['UNSUPPORTED_FORMAT','NORMALIZATION_NOT_ELIGIBLE'].includes(error?.code));
});

test('EC-1 native judgment at APPLY 3/3 remains terminal across restart and denies new work',async t=>{
  const {fixture}=await blockingFormalCase(t);
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  const first=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
  const variant='stnl-current-native-judgment-v1';
  for(const round of [1,2]) {
    const failed=await findingsRound(fixture,first,{status:'TESTS_FAIL',responseVariant:variant});
    assert.equal(failed.dispatch.responseVariant,variant);
    assert.equal(failed.request.format,'stnl-current-findings-request-v1');
    assert.equal(failed.request.round,round);
    assert.equal(failed.captured.status,'TESTS_FAIL');
  }
  const rejected=await findingsRound(fixture,first,{status:'TESTS_PASS',semanticInvalid:true,
    responseVariant:variant,edit:'export const greeting="hello";\n'});
  assert.equal(rejected.request.round,3);
  assert.equal(rejected.captured.captureClass,'findings-rejection');
  assert.equal(rejected.captured.rawResponseSha256,digest(Buffer.from(rejected.response)));
  const replay=await captureNative(first.handle,rejected.tool);
  assert.equal(replay.replayed,true);
  assert.equal(replay.rawResponseSha256,rejected.captured.rawResponseSha256);
  const changedTool=path.join(fixture.root,'terminal-apply-changed-tool.json');
  const originalTool=JSON.parse(await fs.readFile(rejected.tool));
  await fs.writeFile(changedTool,JSON.stringify({...originalTool,
    finalResponse:originalTool.finalResponse+' '})+'\n');
  await assert.rejects(()=>captureNative(first.handle,changedTool),error=>error?.code==='OWNER_MISMATCH');
  const ownerRoot=path.dirname(rejected.dispatch.originFile);
  const responseBefore=await fs.readFile(path.join(ownerRoot,'round-3.response.json'));
  const observationBefore=await fs.readFile(path.join(ownerRoot,'round-3.verification.json'));
  await assert.rejects(()=>publish(first.handle,{checkpoint:async phase=>{
    if(phase==='after-candidate-file') throw new Error('controlled terminal candidate failure');
  }}),/controlled terminal candidate failure/u);
  const handleFile=path.join(fixture.root,'terminal-apply-handle.json');
  await fs.writeFile(handleFile,JSON.stringify(first.handle)+'\n');
  const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
  const separate=async command=>JSON.parse((await run(process.execPath,
    [cli,command,'--handle',handleFile],{timeout:30000})).stdout);
  const resumed=await separate('resume');
  assert.equal(resumed.nextAction,'normalize');
  assert.equal(resumed.responseSha256,digest(responseBefore));
  const normalized=await separate('normalize');
  assert.equal(normalized.rawResponseSha256,digest(responseBefore));
  const published=await separate('publish');
  assert.equal(published.publication,'confirmed');
  assert.equal(published.cleanup,'complete');
  assert.equal(published.transition.outcome,'rejected');
  assert.equal(published.transition.normalization.consumedInvocations,3);
  assert.equal(published.transition.normalization.status,'exhausted');
  assert.deepEqual(await fs.readFile(path.join(ownerRoot,'round-3.response.json')),responseBefore);
  assert.deepEqual(await fs.readFile(path.join(ownerRoot,'round-3.verification.json')),observationBefore);
  await assert.rejects(fs.lstat(path.join(ownerRoot,'round-4.origin.json')),error=>error.code==='ENOENT');
  assert.equal((await separate('resume')).phase,'committed');
  const a=await captureCurrentExecution(fixture.specPath);
  const b=await captureQualityExecution(fixture.specPath);
  assert.deepEqual(a.inspection,b.inspection);
  assert.equal(a.inspection.normalHandoff,null);
  assert.equal(a.inspection.deliveries[0].counters.findingsChecks,2);
  const imageBefore=await fs.readFile(path.join(fixture.image.f.execution,'activation.json'));
  const continuityBefore=await fs.readFile(path.join(fixture.image.f.execution,'continuity.json'));
  const productBefore=await fs.readFile(path.join(fixture.root,'src/greeting.mjs'));
  const expectedActivationId=a.inspection.activationId;
  await assert.rejects(()=>normalizeSuccessor({specPath:fixture.specPath,
    slice:fixture.delivery.slice,expectedActivationId}),error=>
    ['UNSUPPORTED_FORMAT','NORMALIZATION_NOT_ELIGIBLE','NORMALIZATION_EXHAUSTED'].includes(error?.code));
  await assert.rejects(()=>begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId,operation:'APPLY_FINDINGS'}),error=>
    ['UNSUPPORTED_FORMAT','NORMALIZATION_NOT_ELIGIBLE','NORMALIZATION_EXHAUSTED'].includes(error?.code));
  await assert.rejects(()=>reserveDispatch(first.handle),error=>error?.code==='OWNER_UNCERTAIN');
  assert.deepEqual(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')),imageBefore);
  assert.deepEqual(await fs.readFile(path.join(fixture.image.f.execution,'continuity.json')),continuityBefore);
  assert.deepEqual(await fs.readFile(path.join(fixture.root,'src/greeting.mjs')),productBefore);
});

test('EC-1 rejection at global 2 leaves exactly one successor invocation',async t=>{
  const {fixture,current,published}=await rejectedFirst(t,{priorFailures:1});
  assert.equal(published.transition.normalization.consumedInvocations,2);
  const successor=await normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:current.inspection.activationId});
  const passed=await findingsRound(fixture,successor,{status:'TESTS_PASS'});
  assert.equal(passed.request.round,3);
  assert.equal(passed.request.invocation,1);
  assert.equal(passed.request.checkId,'findings-check-02');
  await assert.rejects(()=>reserveDispatch(successor.handle),error=>error?.code==='OWNER_UNCERTAIN');
  const closed=await publish(successor.handle);
  assert.equal(closed.transition.counters.findingsChecks,2);
  await assert.rejects(()=>normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:closed.activation.activationId}),
  error=>['UNSUPPORTED_FORMAT','NORMALIZATION_NOT_ELIGIBLE'].includes(error?.code));
});

test('EC-1 inherited global round 3 TESTS_FAIL publishes Q13 without round 4',async t=>{
  const {fixture,current}=await rejectedFirst(t,{priorFailures:1});
  const successor=await normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:current.inspection.activationId});
  const failed=await findingsRound(fixture,successor,{status:'TESTS_FAIL',
    edit:'export const greeting="broken";\n'});
  assert.equal(failed.request.round,3);
  assert.equal(failed.request.invocation,1);
  assert.equal(failed.captured.nextAction,'publish');
  assert.equal((await resume(successor.handle)).nextAction,'publish');
  await assert.rejects(()=>reserveDispatch(successor.handle),error=>error?.code==='OWNER_UNCERTAIN');
  const closed=await publish(successor.handle);
  assert.equal(closed.transition.counters.findingsChecks,2);
  const quiet=await captureCurrentExecution(fixture.specPath);
  assert.equal(quiet.inspection.normalHandoff.operation,'VALIDATE_SLICE');
});

test('EC-1 second concluded APPLY rejection exhausts the inherited episode',async t=>{
  const {fixture,published,current}=await rejectedFirst(t);
  const successor=await normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:current.inspection.activationId});
  const second=await findingsRound(fixture,successor,{invalid:true});
  assert.equal(second.request.format,'stnl-current-findings-request-v2');
  assert.equal(second.request.round,2);
  assert.equal(second.request.invocation,1);
  const closed=await publish(successor.handle);
  assert.equal(closed.transition.normalization.status,'exhausted');
  assert.equal(closed.transition.normalization.episodeId,published.transition.normalization.episodeId);
  assert.equal(closed.transition.normalization.consumedInvocations,2);
  const quiet=await captureCurrentExecution(fixture.specPath);
  assert.equal(quiet.inspection.normalHandoff,null);
  assert.equal(quiet.inspection.deliveries[0].counters.findingsChecks,0);
  await assert.rejects(()=>normalizeSuccessor({specPath:fixture.specPath,
    slice:fixture.delivery.slice,expectedActivationId:quiet.inspection.activationId}),
  error=>['UNSUPPORTED_FORMAT','NORMALIZATION_NOT_ELIGIBLE'].includes(error?.code));
});

test('EC-1 successor rejection retains the predecessor valid FAIL check in the task carrier',async t=>{
  const {fixture,current}=await rejectedFirst(t,{priorFailures:1});
  const successor=await normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:current.inspection.activationId});
  await findingsRound(fixture,successor,{invalid:true});
  const closed=await publish(successor.handle);
  assert.equal(closed.transition.normalization.status,'exhausted');
  const left=await captureCurrentExecution(fixture.specPath);
  const right=await captureQualityExecution(fixture.specPath);
  assert.deepEqual(left.inspection,right.inspection);
  const task=Buffer.from(left.files.get('tasks/slice-01.md')).toString('utf8');
  assert.match(task,/### findings-check-01/u);
  assert.equal(left.inspection.deliveries[0].counters.findingsChecks,1);
});

test('EC-1 successor uses global rounds 2 and 3 while checks use local invocations',async t=>{
  const {fixture,current}=await rejectedFirst(t);
  const successor=await normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:current.inspection.activationId});
  const failed=await findingsRound(fixture,successor,{status:'TESTS_FAIL',
    edit:'export const greeting="broken";\n'});
  assert.equal(failed.request.round,2);
  assert.equal(failed.request.invocation,1);
  assert.equal(failed.request.checkId,'findings-check-01');
  const passed=await findingsRound(fixture,successor,{status:'TESTS_PASS',
    edit:'export const greeting="hello";\n'});
  assert.equal(passed.request.round,3);
  assert.equal(passed.request.invocation,2);
  assert.equal(passed.request.checkId,'findings-check-02');
  const closed=await publish(successor.handle);
  assert.equal(closed.transition.counters.findingsChecks,2);
  const left=await captureCurrentExecution(fixture.specPath);
  const right=await captureQualityExecution(fixture.specPath);
  assert.deepEqual(left.inspection,right.inspection);
  assert.equal(left.inspection.normalHandoff.operation,'VALIDATE_SLICE');
  assert.equal(left.inspection.deliveries[0].counters.validationAttempts,2);
});

test('EC-1 foreign HEAD and altered request binding cannot normalize an APPLY owner',async t=>{
  for(const kind of ['head','request']) await t.test(kind,async sub=>{
    const {fixture}=await blockingFormalCase(sub);
    const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
    const first=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
      expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
    const foreign='f'.repeat(40)===fixture.head?'e'.repeat(40):'f'.repeat(40);
    await assert.rejects(()=>findingsRound(fixture,first,{status:'TESTS_PASS',
      edit:'export const greeting="hello";\n',
      ...(kind==='head'?{headOverride:foreign}:{requestShaOverride:`sha256:${'f'.repeat(64)}`})}),
    error=>error?.code==='RUNNER_RESULT_REJECTED');
    assert.equal((await resume(first.handle)).nextAction,'stop-and-diagnose');
    await assert.rejects(()=>publish(first.handle),error=>error?.code==='OWNER_UNCERTAIN');
  });
});

test('EC-1 absent official observation never publishes a concluded refusal',async t=>{
  const {fixture}=await blockingFormalCase(t);
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  const first=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
  await assert.rejects(()=>findingsRound(fixture,first,{invalid:true,
    edit:'export const greeting="hello";\n',beforeCapture:async dispatch=>{
      await fs.rm(path.join(path.dirname(dispatch.originFile),'round-1.observation.json'));
    }}),error=>error?.code==='ENOENT');
  await assert.rejects(()=>publish(first.handle),error=>error?.code==='OWNER_UNCERTAIN');
});

test('EC-1 quiet readers use no historical auxiliary operation files',async t=>{
  const {fixture,current}=await rejectedFirst(t);
  const worker=path.resolve('scripts/fixtures/current-quiet-reader.mjs');
  const canary=path.join(fixture.root,'tmp','historic','receipt.json');
  await fs.mkdir(path.dirname(canary),{recursive:true});
  await fs.writeFile(canary,'historical canary\n');
  async function prove(stage,operation) {
    for(const name of ['stnl-slice-executor','stnl-slice-quality-manager']) {
      const reader=path.resolve('skills/workflows',name,'runtime/execution-current-reader.mjs');
      const log=path.join(fixture.root,'tmp',`q22-apply-${stage}-${name}.json`);
      await run(process.execPath,[worker,'--worker','canary-caught',
        reader,fixture.specPath,log,fixture.root],{timeout:20000});
      const caught=JSON.parse(await fs.readFile(log,'utf8'));
      assert.equal(caught.result.caught,true);
      assert.ok(caught.attempts.some(item=>item.path===canary));
      await run(process.execPath,[worker,'--worker','api',
        reader,fixture.specPath,log,fixture.root],{timeout:20000});
      const actual=JSON.parse(await fs.readFile(log,'utf8'));
      assert.deepEqual(actual.attempts,[]);
      assert.equal(actual.result.normalHandoff.operation,operation);
    }
  }
  await prove('rejection','APPLY_FINDINGS');
  const successor=await normalizeSuccessor({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:current.inspection.activationId});
  await findingsRound(fixture,successor,{status:'TESTS_PASS'});
  await publish(successor.handle);
  await prove('successor','VALIDATE_SLICE');
  assert.equal(current.inspection.deliveries[0].counters.findingsChecks,0);
});
