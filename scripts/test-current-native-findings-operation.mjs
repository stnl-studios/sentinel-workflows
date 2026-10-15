import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {nativeOperationCase,reservedOperation} from './fixtures/current-native-operation.mjs';
import {blockingFormalCase,completedFindingsCycle,applyRoundsCase} from './fixtures/current-native-findings-operation.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {begin,bindNative,verifyNative,captureNative,resume,reserveDispatch,publish} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('EC-1/S2 refuses APPLY when no blocking formal exists',async t=>{
  const fixture=await nativeOperationCase(t);
  await assert.rejects(()=>begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:fixture.activationId,operation:'APPLY_FINDINGS'}),
  error=>error?.code==='UNSUPPORTED_FORMAT');
});

test('EC-1/S2 retains a native response whose HEAD belongs to another repository',async t=>{
  const fixture=await reservedOperation(t);
  const agentId='mechanical-wrong-product-head';
  await bindNative(fixture.start.handle,agentId);
  const observation=await verifyNative(fixture.dispatch.originFile);
  const request=await fs.readFile(fixture.dispatch.requestFile);
  const wrongHead=fixture.head==='0'.repeat(40)?'1'.repeat(40):'0'.repeat(40);
  const finalResponse=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:sha(request),result:{status:'PASS',head:wrongHead,
      commands:observation.commands,evidence:'Mechanical provenance case.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'none'},newFindings:[]});
  const toolFile=path.join(fixture.root,'wrong-head-tool.json');
  await fs.writeFile(toolFile,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
  await assert.rejects(()=>captureNative(fixture.start.handle,toolFile),
    error=>error?.code==='RUNNER_RESULT_REJECTED' && /product Git HEAD/u.test(error.message));
  const root=path.dirname(fixture.dispatch.originFile);
  assert.ok((await fs.readFile(path.join(root,'round-1.response.json')))
    .equals(Buffer.from(finalResponse)));
  const receipt=JSON.parse(await fs.readFile(path.join(root,'round-1.receipt.json')));
  assert.equal(receipt.status,'RUNNER_RESULT_BLOCKED');
  assert.equal((await resume(fixture.start.handle)).phase,'uncertain');
});

test('EC-1/S2 refuses a correction made before APPLY seals its baseline',async t=>{
  const {fixture}=await blockingFormalCase(t);
  await fs.appendFile(path.join(fixture.root,'src/greeting.mjs'),'// premature edit\n');
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  await assert.rejects(()=>begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'}),
  error=>error?.code==='EVIDENCE_STALE');
});

test('EC-1/S2 retains the original correction and supports later formal revalidation',async t=>{
  const cycle=await completedFindingsCycle(t);
  const before=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(before.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(before.inspection.deliveries[0].counters.validationAttempts,3);
  await fs.appendFile(path.join(cycle.fixture.root,'src/greeting.mjs'),'// equivalent drift\n');
  const drift=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(drift.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  const later=await cycle.operation(4,{status:'PASS'});
  assert.equal(later.published.publication,'confirmed');
  const after=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(after.inspection.deliveries[0].counters.validationAttempts,4);
  const continuity=JSON.parse(Buffer.from(after.files.get('continuity.json')));
  const bundle=JSON.parse(Buffer.from(after.files.get(continuity.deliveries[0].evidence.path)));
  assert.equal(bundle.support.find(item=>item.id==='attempt-02')?.id,'attempt-02');
  assert.equal(bundle.validation.id,'attempt-04');
});

test('EC-1/S2 keeps high-water and required origins through a second correction cycle',async t=>{
  const cycle=await completedFindingsCycle(t);
  await fs.writeFile(path.join(cycle.fixture.root,'src/greeting.mjs'),'export const greeting="broken";\n');
  const secondFinding={id:'finding-02',severity:'blocking',originAttempt:'attempt-04',
    problem:'The greeting export regressed to broken.',
    evidence:'The approved greeting test observes broken instead of hello.',
    impact:'AC-001 is unmet again.',relatedAuthority:'AC-001; obligation-01',
    expectedCorrection:'Set the greeting export to hello.'};
  await cycle.operation(4,{status:'NEEDS_FIX',references:'finding-02',
    dispositions:'finding-02=active',findings:[secondFinding]});
  await cycle.operation(5,{kind:'APPLY_FINDINGS',status:'TESTS_PASS',verified:'finding-02',
    edit:'export const greeting="hello";\n'});
  await cycle.operation(6,{status:'PASS',references:'finding-02',
    dispositions:'finding-02=resolved'});
  const after=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');
  assert.deepEqual(after.inspection.deliveries[0].counters,
    {findings:2,findingsChecks:2,implementationChecks:1,validationAttempts:5});
  const continuity=JSON.parse(Buffer.from(after.files.get('continuity.json')));
  const bundle=JSON.parse(Buffer.from(after.files.get(continuity.deliveries[0].evidence.path)));
  assert.equal(bundle.validation.id,'attempt-05');
  assert.deepEqual(bundle.support.map(item=>item.id),['attempt-04']);
});

test('EC-1/S2 resumes FAIL then publishes PASS on the second findings round',async t=>{
  const cycle=await applyRoundsCase(t,['TESTS_FAIL','TESTS_PASS']);
  assert.equal(cycle.rounds[0].measured.commands.some(item=>item.exit!==0),true);
  assert.equal(cycle.rounds[1].measured.commands.every(item=>item.exit===0),true);
  assert.equal(cycle.rounds[0].freshProcessResume.nextAction,'reserve-dispatch');
  assert.equal((await resume(cycle.start.handle)).phase,'captured');
  const result=await publish(cycle.start.handle);
  assert.equal(result.publication,'confirmed');
  const after=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(after.inspection.deliveries[0].auxiliaryStatus,'TESTS_PASS');
  assert.equal(after.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
});

test('EC-1/S2 publishes three failures and refuses a fourth dispatch',async t=>{
  const cycle=await applyRoundsCase(t,['TESTS_FAIL','TESTS_FAIL','TESTS_FAIL']);
  for(const round of cycle.rounds)
    assert.equal(round.measured.commands.some(item=>item.exit!==0),true);
  await assert.rejects(()=>reserveDispatch(cycle.start.handle),
    error=>error?.code==='OWNER_UNCERTAIN');
  const result=await publish(cycle.start.handle);
  assert.equal(result.publication,'confirmed');
  const after=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(after.inspection.deliveries[0].auxiliaryStatus,'TESTS_FAIL');
  assert.equal(after.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
});

test('EC-1/S2 preserves two failure rounds before third-round PASS',async t=>{
  const cycle=await applyRoundsCase(t,['TESTS_FAIL','TESTS_FAIL','TESTS_PASS']);
  assert.deepEqual(cycle.rounds.map(item=>item.measured.commands[0].exit),[1,1,0]);
  assert.equal(cycle.rounds[0].freshProcessResume.nextAction,'reserve-dispatch');
  const result=await publish(cycle.start.handle);
  assert.equal(result.publication,'confirmed');
  const after=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(after.inspection.deliveries[0].auxiliaryStatus,'TESTS_PASS');
  assert.equal(after.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
});
