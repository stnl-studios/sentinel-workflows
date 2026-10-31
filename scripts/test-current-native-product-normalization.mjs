import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {productNormalizationCase} from './fixtures/current-native-product-normalization.mjs';
import {applyRoundsCase} from './fixtures/current-native-findings-operation.mjs';
import {normalize,reserveDispatch,resume,publish,captureNative,verifyNative,bindNative} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

const run=promisify(execFile);
const controller=fileURLToPath(new URL('../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs',import.meta.url));

test('EC-1 private drift reserves one same-owner recheck and retains both PASS checks',async t=>{
  const c=await productNormalizationCase(t);
  const first=await c.round(1);
  await fs.appendFile(c.source,'// semantically equivalent private output\n');
  await assert.rejects(()=>publish(c.start.handle),error=>error?.code==='EVIDENCE_STALE');
  const reserved=await normalize(c.start.handle);
  assert.equal(reserved.nextAction,'reserve-dispatch');
  await assert.rejects(()=>normalize(c.start.handle),error=>error?.code==='NORMALIZATION_EXHAUSTED');
  const handleFile=path.join(c.fixture.root,'product-drift-handle.json');
  await fs.writeFile(handleFile,JSON.stringify(c.start.handle)+'\n');
  const fresh=JSON.parse((await run(process.execPath,[controller,'resume','--handle',handleFile])).stdout);
  assert.equal(fresh.nextAction,'reserve-dispatch');
  const second=await c.round(2);
  const origin=JSON.parse(await fs.readFile(second.dispatch.originFile));
  assert.equal(origin.productDrift.sourceRound,1);
  assert.equal(origin.productDrift.used,1);
  assert.equal(origin.owner.operationAttemptId,c.start.owner.operationAttemptId);
  assert.notEqual(second.dispatch.requestSha256,first.dispatch.requestSha256);
  assert.equal((await captureNative(c.start.handle,second.toolFile)).replayed,true);
  await assert.rejects(()=>normalize(c.start.handle),error=>error?.code==='NORMALIZATION_EXHAUSTED');
  const published=await publish(c.start.handle);
  assert.equal(published.publication,'confirmed');
  const image=await captureCurrentExecution(c.fixture.specPath);
  const current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path)));
  assert.equal(current.counters.findingsChecks,2);
  assert.deepEqual(bundle.findingsChecks.map(item=>item.id),['findings-check-01','findings-check-02']);
  assert.notDeepEqual(bundle.findingsChecks[0].testedWork,bundle.findingsChecks[1].testedWork);
  assert.equal(image.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  const worker=path.resolve('scripts/fixtures/current-quiet-reader.mjs');
  for(const skill of ['stnl-slice-executor','stnl-slice-quality-manager']) {
    const reader=path.resolve('skills/workflows',skill,'runtime/execution-current-reader.mjs');
    const log=path.join(c.fixture.root,'tmp',`product-drift-q22-${skill}.json`);
    const command=mode=>run(process.execPath,[worker,'--worker',mode,reader,
      c.fixture.specPath,log,c.fixture.root],{timeout:20000});
    await command('canary-caught');
    assert.equal(JSON.parse(await fs.readFile(log,'utf8')).result.caught,true);
    await command('api');
    const readback=JSON.parse(await fs.readFile(log,'utf8'));
    assert.deepEqual(readback.attempts,[]);
    assert.equal(readback.result.deliveries[0].auxiliaryStatus,'TESTS_PASS');
    assert.equal(readback.result.deliveries[0].counters.findingsChecks,2);
  }
});

test('EC-1 refuses a second call after PASS without the durable witness',async t=>{
  const c=await productNormalizationCase(t);
  await c.round(1);
  await assert.rejects(()=>reserveDispatch(c.start.handle),error=>error?.code==='OWNER_UNCERTAIN');
});

test('EC-1 refuses missing drift, input edits and exhausted continuation',async t=>{
  const c=await productNormalizationCase(t,{sharedInput:true});
  await c.round(1);
  await assert.rejects(()=>normalize(c.start.handle),error=>error?.code==='NORMALIZATION_NOT_ELIGIBLE');
  await fs.appendFile(path.join(c.fixture.root,'shared-config.json'),'// exclusive input drift\n');
  await assert.rejects(()=>normalize(c.start.handle),error=>
    ['EVIDENCE_STALE','NORMALIZATION_NOT_ELIGIBLE'].includes(error?.code));
});

test('EC-1 checks the reserved work before the recheck recipe',async t=>{
  const c=await productNormalizationCase(t);
  await c.round(1);
  await fs.appendFile(c.source,'// first drift\n');
  await normalize(c.start.handle);
  const dispatch=await reserveDispatch(c.start.handle);
  await bindNative(c.start.handle,'mechanical-extra-drift-agent');
  await fs.appendFile(c.source,'// unreserved extra drift\n');
  await assert.rejects(()=>verifyNative(dispatch.originFile),error=>error?.code==='EVIDENCE_STALE');
});

test('EC-1 keeps one product episode through PASS, recheck FAIL and a third PASS',async t=>{
  const c=await productNormalizationCase(t);
  await c.round(1);
  await fs.writeFile(c.source,'export const greeting="broken";\n');
  await normalize(c.start.handle);
  const second=await c.round(2,{status:'TESTS_FAIL'});
  assert.equal(second.measured.commands[0].exit,1);
  assert.equal((await resume(c.start.handle)).nextAction,'reserve-dispatch');
  await fs.writeFile(c.source,'export const greeting="hello";\n');
  await c.round(3);
  await assert.rejects(()=>reserveDispatch(c.start.handle),error=>error?.code==='OWNER_UNCERTAIN');
  const published=await publish(c.start.handle);
  assert.equal(published.publication,'confirmed');
  const image=await captureCurrentExecution(c.fixture.specPath);
  const current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.equal(current.counters.findingsChecks,3);
  assert.equal(image.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
});

test('EC-1 refuses drift normalization when the fifth call is consumed',async t=>{
  const c=await applyRoundsCase(t,['TESTS_FAIL','TESTS_FAIL','TESTS_FAIL','TESTS_FAIL','TESTS_PASS'],{progressing:true});
  await fs.appendFile(path.join(c.fixture.root,'src/greeting.mjs'),'// late drift\n');
  await assert.rejects(()=>normalize(c.start.handle),error=>error?.code==='NORMALIZATION_EXHAUSTED');
});

test('EC-1 refuses removed and symlinked product outputs',async t=>{
  const c=await productNormalizationCase(t);
  await c.round(1);
  await fs.rm(c.source);
  await assert.rejects(()=>normalize(c.start.handle),error=>
    ['EVIDENCE_STALE','UNSAFE_PATH'].includes(error?.code));
  await fs.symlink('greeting.test.mjs',c.source);
  await assert.rejects(()=>normalize(c.start.handle),error=>
    ['EVIDENCE_STALE','UNSAFE_PATH','INVALID_CURRENT_IMAGE'].includes(error?.code));
});

test('EC-1 rejects an altered witness before the reserved recipe',async t=>{
  const c=await productNormalizationCase(t);
  await c.round(1);
  await fs.appendFile(c.source,'// private drift\n');
  await normalize(c.start.handle);
  const dispatch=await reserveDispatch(c.start.handle);
  await bindNative(c.start.handle,'mechanical-tampered-witness-agent');
  const origin=JSON.parse(await fs.readFile(dispatch.originFile));
  origin.productDrift.expectedWorkSha256='sha256:'+'0'.repeat(64);
  await fs.writeFile(dispatch.originFile,JSON.stringify(origin)+'\n');
  await assert.rejects(()=>verifyNative(dispatch.originFile),error=>
    ['EVIDENCE_STALE','OWNER_MISMATCH'].includes(error?.code));
});

test('EC-1 refuses a requirements change alongside private output drift',async t=>{
  const c=await productNormalizationCase(t);
  await c.round(1);
  await fs.appendFile(c.source,'// private drift\n');
  await fs.appendFile(c.fixture.specPath,'\nUnapproved authority change.\n');
  await assert.rejects(()=>normalize(c.start.handle),error=>Boolean(error?.code));
});
