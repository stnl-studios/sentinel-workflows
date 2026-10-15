import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeOperationCase} from './fixtures/current-native-operation.mjs';
import {completedFindingsCycle} from './fixtures/current-native-findings-operation.mjs';
import {normalizedFormal,reviewedDecisionCase} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {captureCurrentExecution as captureQualityExecution} from '../skills/workflows/stnl-slice-quality-manager/runtime/execution-current-reader.mjs';
import {begin,normalizeSuccessor,publish,resume} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const run=promisify(execFile);
const operationRoot=dispatch=>path.dirname(dispatch.originFile);
async function changeJson(file,change) {
  const value=JSON.parse(await fs.readFile(file,'utf8'));
  change(value);
  await fs.writeFile(file,JSON.stringify(value)+'\n');
}

test('EC-1 normalization: identified partial candidate completes with retained capture',async t=>{
  const fixture=await nativeOperationCase(t);
  const result=await normalizedFormal(fixture,{partial:true});
  assert.equal(result.repaired.phase,'prepared');
  assert.equal(result.repaired.rawResponseSha256,result.captured.rawResponseSha256);
  assert.equal(result.published.transition.outcome,'recorded');
  const after=await captureCurrentExecution(fixture.specPath);
  assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');
});

test('EC-1 normalization: foreign or ambiguous candidate bytes block completion',async t=>{
  for(const kind of ['foreign','ambiguous']) await t.test(kind,async sub=>{
    const fixture=await nativeOperationCase(sub);
    await assert.rejects(()=>normalizedFormal(fixture,{partial:true,
      candidateMutation:async candidate=>{
        if(kind==='foreign') await fs.writeFile(path.join(candidate,'foreign.txt'),'foreign\n');
        else await fs.writeFile(path.join(candidate,'continuity.json'),'truncated\n');
      }}),error=>error?.code==='EVIDENCE_STALE');
    await assert.rejects(()=>captureCurrentExecution(fixture.specPath),
      error=>error?.code==='OWNER_UNCERTAIN');
  });
});

test('EC-1 normalization: first rejected formal admits exactly one explicit successor',async t=>{
  const fixture=await nativeOperationCase(t);
  const first=await normalizedFormal(fixture,{invalid:true});
  assert.equal(first.captured.captureClass,'formal-rejection');
  assert.equal(first.published.activation.lastAttempt.outcome,'rejected');
  const rejected=await captureCurrentExecution(fixture.specPath);
  assert.equal(rejected.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  assert.equal(rejected.inspection.deliveries[0].counters.validationAttempts,1);
  await assert.rejects(()=>begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:rejected.inspection.activationId}),
  error=>error?.code==='UNSUPPORTED_FORMAT');
  const second=await normalizedFormal(fixture,{successor:true});
  assert.notEqual(first.start.owner.operationAttemptId,second.start.owner.operationAttemptId);
  assert.equal(second.published.activation.lastAttempt.outcome,'recorded');
  const final=await captureCurrentExecution(fixture.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(final.inspection.deliveries[0].counters.validationAttempts,2);
});

test('EC-1 normalization: terminal recovery retains rejected outcome',async t=>{
  const fixture=await nativeOperationCase(t);
  const first=await normalizedFormal(fixture,{invalid:true,terminalFault:true});
  assert.equal(first.published.activation.lastAttempt.outcome,'rejected');
  const current=await captureCurrentExecution(fixture.specPath);
  assert.equal(current.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  assert.equal(current.inspection.deliveries[0].counters.validationAttempts,1);
});

test('EC-1 normalization: quiet rejection and successor read without temporary allocation',async t=>{
  for(const successor of [false,true]) await t.test(successor?'successor':'rejection',async sub=>{
    const fixture=await nativeOperationCase(sub);
    await normalizedFormal(fixture,{invalid:true});
    if(successor) await normalizedFormal(fixture,{successor:true});
    await fs.rename(path.join(fixture.root,'tmp','sentinel'),
      path.join(fixture.root,'tmp','sentinel-hidden'));
    const first=await captureCurrentExecution(fixture.specPath);
    const second=await captureQualityExecution(fixture.specPath);
    assert.deepEqual(first.inspection,second.inspection);
    assert.equal(first.inspection.deliveries[0].formalStatus,successor?'PASS':null);
    assert.equal(first.inspection.normalHandoff?.operation,successor?undefined:'VALIDATE_SLICE');
  });
});

test('EC-1 normalization: reviewed imported evidence survives rejection and valid successor',async t=>{
  const fixture=await reviewedDecisionCase(t);
  const first=await normalizedFormal(fixture,{invalid:true});
  assert.equal(first.published.transition.outcome,'rejected');
  const rejected=await captureCurrentExecution(fixture.specPath);
  assert.equal(rejected.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  const second=await normalizedFormal(fixture,{successor:true});
  assert.equal(second.published.transition.outcome,'recorded');
  const final=await captureCurrentExecution(fixture.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
});

test('EC-1 normalization: second rejected formal exhausts inherited episode',async t=>{
  const fixture=await nativeOperationCase(t);
  const first=await normalizedFormal(fixture,{invalid:true,
    invalidText:'INVALID_FORMAL_RESPONSE: first description'});
  const second=await normalizedFormal(fixture,{successor:true,invalid:true,
    invalidText:'INVALID_FORMAL_RESPONSE: rewritten description'});
  assert.notEqual(first.captured.rawResponseSha256,second.captured.rawResponseSha256);
  assert.equal(first.published.transition.normalization.round,1);
  assert.equal(second.published.transition.normalization.round,2);
  assert.equal(second.published.transition.normalization.status,'exhausted');
  assert.equal(second.published.transition.normalization.episodeId,
    first.published.transition.normalization.episodeId);
  const final=await captureCurrentExecution(fixture.specPath);
  assert.equal(final.inspection.normalHandoff,null);
  assert.equal(final.inspection.deliveries[0].counters.validationAttempts,1);
  await assert.rejects(()=>normalizeSuccessor({specPath:fixture.specPath,
    slice:fixture.delivery.slice,expectedActivationId:final.inspection.activationId}),
  error=>['UNSUPPORTED_FORMAT','NORMALIZATION_NOT_ELIGIBLE'].includes(error?.code));
});

test('EC-1 normalization: foreign activation and successor replay cannot reserve another owner',async t=>{
  const firstFixture=await nativeOperationCase(t);
  const foreignFixture=await nativeOperationCase(t);
  await normalizedFormal(firstFixture,{invalid:true});
  const rejection=await captureCurrentExecution(firstFixture.specPath);
  await assert.rejects(()=>normalizeSuccessor({specPath:firstFixture.specPath,
    slice:firstFixture.delivery.slice,expectedActivationId:foreignFixture.activationId}),
  error=>error?.code==='STALE_BASE');
  const successor=await normalizedFormal(firstFixture,{successor:true});
  await assert.rejects(()=>normalizeSuccessor({specPath:firstFixture.specPath,
    slice:firstFixture.delivery.slice,expectedActivationId:rejection.inspection.activationId}),
  error=>['UNSUPPORTED_FORMAT','STALE_BASE'].includes(error?.code));
  const final=await captureCurrentExecution(firstFixture.specPath);
  await assert.rejects(()=>normalizeSuccessor({specPath:firstFixture.specPath,
    slice:firstFixture.delivery.slice,expectedActivationId:final.inspection.activationId}),
  error=>['UNSUPPORTED_FORMAT','NORMALIZATION_NOT_ELIGIBLE'].includes(error?.code));
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(successor.published.transition.outcome,'recorded');
});

test('EC-1 normalization: reassigned successor receipt blocks publication',async t=>{
  const fixture=await nativeOperationCase(t);
  await normalizedFormal(fixture,{invalid:true});
  await assert.rejects(()=>normalizedFormal(fixture,{successor:true,
    beforePublish:async({dispatch})=>{
      await changeJson(path.join(operationRoot(dispatch),'round-1.receipt.json'),receipt=>{
        receipt.threadId='mechanical-foreign-agent';
      });
    }}),error=>Boolean(error?.code) && /receipt|agent|thread/u.test(error.message));
  const rejected=await captureCurrentExecution(fixture.specPath).catch(error=>error);
  assert.equal(rejected.code,'OWNER_UNCERTAIN');
});

test('EC-1 normalization: formal HEAD and proof failures cannot become a rejection successor',async t=>{
  await t.test('foreign HEAD remains uncertain',async sub=>{
    const fixture=await nativeOperationCase(sub);
    const foreign='f'.repeat(40)===fixture.head?'e'.repeat(40):'f'.repeat(40);
    const first=await normalizedFormal(fixture,{headOverride:foreign,captureOnly:true});
    assert.equal(first.captureError?.code,'RUNNER_RESULT_REJECTED');
    assert.equal((await resume(first.start.handle)).nextAction,'stop-and-diagnose');
    await assert.rejects(()=>publish(first.start.handle),error=>error?.code==='OWNER_UNCERTAIN');
    await assert.rejects(()=>normalizeSuccessor({specPath:fixture.specPath,
      slice:fixture.delivery.slice,expectedActivationId:fixture.activationId}),
    error=>['OWNER_ACTIVE','UNSUPPORTED_FORMAT','OWNER_UNCERTAIN'].includes(error?.code));
  });
  await t.test('verification proof mismatch blocks capture',async sub=>{
    const fixture=await nativeOperationCase(sub);
    await assert.rejects(()=>normalizedFormal(fixture,{beforeCapture:async({dispatch})=>{
      await changeJson(path.join(operationRoot(dispatch),'round-1.observation.json'),observation=>{
        observation.status='not-completed';
      });
    }}),error=>error?.code==='OWNER_UNCERTAIN');
    await assert.rejects(()=>normalizeSuccessor({specPath:fixture.specPath,
      slice:fixture.delivery.slice,expectedActivationId:fixture.activationId}),
    error=>['OWNER_ACTIVE','UNSUPPORTED_FORMAT','OWNER_UNCERTAIN'].includes(error?.code));
  });
});

test('EC-1 normalization: Q22 rejection and successor readers trap caught historical access',async t=>{
  const worker=path.resolve('scripts/fixtures/current-quiet-reader.mjs');
  const readers=['stnl-slice-executor','stnl-slice-quality-manager'].map(name=>
    path.resolve('skills/workflows',name,'runtime/execution-current-reader.mjs'));
  for(const successor of [false,true]) await t.test(successor?'successor':'rejection',async sub=>{
    const fixture=await nativeOperationCase(sub);
    await normalizedFormal(fixture,{invalid:true});
    if(successor) await normalizedFormal(fixture,{successor:true});
    const canary=path.join(fixture.root,'tmp','historic','receipt.json');
    await fs.mkdir(path.dirname(canary),{recursive:true});
    await fs.writeFile(canary,'historical canary\n');
    for(const reader of readers) {
      const log=path.join(fixture.root,'tmp',`q22-${path.basename(path.dirname(reader))}-${successor}.json`);
      const command=mode=>run(process.execPath,[worker,'--worker',mode,reader,
        fixture.specPath,log,fixture.root],{timeout:20000});
      await command('canary-caught');
      const caught=JSON.parse(await fs.readFile(log,'utf8'));
      assert.equal(caught.result.caught,true);
      assert.ok(caught.attempts.some(item=>item.path===canary),
        'caught historical read was recorded by the guard');
      await command('api');
      const actual=JSON.parse(await fs.readFile(log,'utf8'));
      assert.deepEqual(actual.attempts,[],'quiet reader attempted forbidden I/O');
      assert.equal(actual.result.deliveries[0].formalStatus,successor?'PASS':null);
    }
  });
});

test('EC-1 normalization: v4 rejection retains findings and high-water after APPLY',async t=>{
  const cycle=await completedFindingsCycle(t);
  await fs.writeFile(path.join(cycle.fixture.root,'src/greeting.mjs'),
    'export const greeting="broken";\n');
  const finding={id:'finding-02',severity:'blocking',originAttempt:'attempt-04',
    problem:'The greeting export regressed to broken.',
    evidence:'The approved test observes broken instead of hello.',
    impact:'AC-001 is unmet again.',relatedAuthority:'AC-001; obligation-01',
    expectedCorrection:'Set the greeting export to hello.'};
  await cycle.operation(4,{status:'NEEDS_FIX',references:'finding-02',
    dispositions:'finding-02=active',findings:[finding]});
  await cycle.operation(5,{kind:'APPLY_FINDINGS',status:'TESTS_PASS',
    verified:'finding-02',edit:'export const greeting="hello";\n'});
  const before=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(before.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  const first=await normalizedFormal(cycle.fixture,{invalid:true});
  assert.equal(first.published.transition.outcome,'rejected');
  const after=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(after.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  assert.deepEqual(after.inspection.deliveries[0].counters,
    before.inspection.deliveries[0].counters);
  const continuity=JSON.parse(Buffer.from(after.files.get('continuity.json')));
  const bundle=JSON.parse(Buffer.from(after.files.get(continuity.deliveries[0].evidence.path)));
  assert.equal(bundle.openFindings[0]?.id,'finding-02');
  assert.equal(bundle.findingsChecks.length,1);
  assert.equal(after.inspection.deliveries[0].counters.findingsChecks,2);
  const second=await normalizedFormal(cycle.fixture,{successor:true,
    references:'finding-02',dispositions:'finding-02=resolved'});
  assert.equal(second.published.transition.outcome,'recorded');
  const final=await captureCurrentExecution(cycle.fixture.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(final.inspection.deliveries[0].counters.findingsChecks,2);
  const closed=JSON.parse(Buffer.from(final.files.get('continuity.json')));
  const retained=JSON.parse(Buffer.from(final.files.get(closed.deliveries[0].evidence.path)));
  assert.equal(retained.support.filter(item=>item.kind==='rejection').length,1);
  assert.equal(retained.support.find(item=>item.kind==='rejection')?.operationAttemptId,
    first.start.owner.operationAttemptId);
});
