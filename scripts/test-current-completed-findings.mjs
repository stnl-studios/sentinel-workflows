import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {completedBlockingCase,completedFormal,startCompletedApply,completedApplyRound,publishCompletedApply} from './fixtures/current-completed-findings.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {begin,resume,publish,reserveDispatch,verifyNative,normalize,normalizeSuccessor} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {completedEvidenceContext} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
const run=promisify(execFile),sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
const HELLO='export const greeting="hello";\n';
const captureFiles=async root=>new Map(await Promise.all(['response','receipt','observation','origin','request','agent','claim','tool-result']
  .map(async suffix=>[suffix,await fs.readFile(path.join(root,`round-1.${suffix}.json`))])));

test('F01 completed A remains literal through NEEDS_FIX, APPLY and independent formal PASS',async t=>{
  const f=await completedBlockingCase(t),before=await captureCurrentExecution(f.specPath);
  assert.equal(before.inspection.normalHandoff?.operation,'APPLY_FINDINGS');
  const start=await startCompletedApply(f);
  await completedApplyRound(f,start,{edit:'export const greeting="hello";\n'});
  assert.equal((await publishCompletedApply(start)).publication,'confirmed');
  const auxiliary=await captureCurrentExecution(f.specPath);
  assert.equal(auxiliary.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  assert.equal(auxiliary.inspection.deliveries[0].formalStatus,'NEEDS_FIX');
  await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
  const after=await captureCurrentExecution(f.specPath);
  const beforeC=JSON.parse(Buffer.from(before.files.get('continuity.json'))),afterC=JSON.parse(Buffer.from(after.files.get('continuity.json')));
  assert.deepEqual(afterC.completed,beforeC.completed);
  assert.deepEqual(Buffer.from(after.files.get('approved-preparation.json')),Buffer.from(before.files.get('approved-preparation.json')));
  const a=beforeC.completed[0];assert.deepEqual(Buffer.from(after.files.get(a.evidence.path)),Buffer.from(before.files.get(a.evidence.path)));
  assert.deepEqual(after.inspection.deliveries[0].counters,{findings:1,findingsChecks:1,implementationChecks:1,validationAttempts:4});
  assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');assert.equal(after.inspection.normalHandoff,null);
  assert.equal(after.inspection.state,'VALIDATION_BLOCKED');
});

for(const statuses of [['TESTS_FAIL','TESTS_PASS'],['TESTS_FAIL','TESTS_FAIL','TESTS_PASS'],['TESTS_FAIL','TESTS_FAIL','TESTS_FAIL']])
test(`F02 completed findings preserves rounds and budget ${statuses.join('/')}`,async t=>{
  const f=await completedBlockingCase(t),start=await startCompletedApply(f);
  for(const status of statuses) {
    const round=await completedApplyRound(f,start,{status,edit:status==='TESTS_PASS'?HELLO:null});
    assert.equal(round.measured.commands[0].exit,status==='TESTS_PASS'?0:1);
    assert.equal((await resume(start.handle)).nextAction,status==='TESTS_FAIL'&&round.dispatch.round<3?'reserve-dispatch':'publish');
  }
  await assert.rejects(()=>reserveDispatch(start.handle));
  await publish(start.handle);const image=await captureCurrentExecution(f.specPath);
  assert.equal(image.inspection.deliveries[0].counters.findingsChecks,statuses.length);
  assert.equal(image.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  const passed=statuses.at(-1)==='TESTS_PASS';
  await completedFormal(f,{status:passed?'PASS':'NEEDS_FIX',references:'finding-01',dispositions:`finding-01=${passed?'resolved':'active'}`});
  if(!passed) {
    const next=await startCompletedApply(f);await completedApplyRound(f,next,{edit:HELLO});await publish(next.handle);
    await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
    const final=await captureCurrentExecution(f.specPath);
    assert.equal(final.inspection.deliveries[0].counters.findingsChecks,4);
    assert.equal(final.inspection.deliveries[0].counters.validationAttempts,5);
    assert.equal(final.inspection.deliveries[0].counters.findings,1);
  }
});

test('F03 completed APPLY recovers exact bytes in new processes through partial candidate and lost acknowledgment',async t=>{
  const f=await completedBlockingCase(t),start=await startCompletedApply(f),round=await completedApplyRound(f,start,{edit:HELLO});
  const root=path.dirname(round.dispatch.originFile),sources=await captureFiles(root),a1=await fs.readFile(path.join(f.image.f.execution,'activation.json'));
  await assert.rejects(()=>publish(start.handle,{checkpoint:async phase=>{if(phase==='after-candidate-file')throw Error('injected completed partial');}}),/injected completed partial/u);
  assert.deepEqual(await fs.readFile(path.join(f.image.f.execution,'activation.json')),a1);
  const handle=path.join(f.root,'handle.json');await fs.writeFile(handle,JSON.stringify(start.handle));
  const guard=path.join(f.root,'deny-new-runner.mjs');await fs.writeFile(guard,`import cp from 'node:child_process';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
for(const name of ['execFile','execFileSync','spawn','spawnSync','fork','exec','execSync']){const old=cp[name];cp[name]=function(command,...args){if(path.basename(String(command))!=='git')throw Error('new runner/recipe forbidden');return old.call(this,command,...args);};}syncBuiltinESMExports();\n`);
  const separate=async command=>JSON.parse((await run(process.execPath,['--import',guard,cli,command,'--handle',handle])).stdout);
  assert.equal((await separate('resume')).nextAction,'normalize');
  assert.equal((await separate('normalize')).rawResponseSha256,sha(sources.get('response')));
  await assert.rejects(()=>publish(start.handle,{checkpoint:async phase=>{if(phase==='after-terminal-activation')throw Error('injected completed ack');}}),/injected completed ack/u);
  assert.equal((await separate('resume')).phase,'activation_written');
  assert.equal((await separate('publish')).publication,'confirmed');
  for(const [suffix,bytes]of sources)assert.deepEqual(await fs.readFile(path.join(root,`round-1.${suffix}.json`)),bytes);
  await assert.rejects(fs.lstat(path.join(root,'round-2.origin.json')),error=>error.code==='ENOENT');
  await fs.rename(path.join(f.root,'tmp/sentinel'),path.join(f.root,'tmp/retired-controls'));
  for(const skill of ['stnl-slice-executor','stnl-slice-quality-manager']) {
    const result=JSON.parse((await run(process.execPath,['--import',guard,
      path.resolve(`skills/workflows/${skill}/runtime/execution-current-operation.mjs`),'inspect','--spec-path',f.specPath])).stdout);
    assert.equal(result.completed[0].observedValidation,'current');assert.equal(result.normalHandoff.operation,'VALIDATE_SLICE');
  }
  await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
});

test('F04 completed/input/snapshot drift refuses before recipe and promotion; private drift uses remaining invocation once',async t=>{
  const f=await completedBlockingCase(t,{sharedInput:true});
  const product=path.join(f.root,'other/greeting.mjs');await fs.appendFile(product,'// too early\n');
  const premature=await captureCurrentExecution(f.specPath);
  assert.equal(premature.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  for(const operation of ['APPLY_FINDINGS','VALIDATE_SLICE'])await assert.rejects(()=>begin({specPath:f.specPath,
    slice:f.delivery.slice,operation,expectedActivationId:premature.inspection.activationId}),error=>error.code==='UNSUPPORTED_FORMAT');
  assert.deepEqual(await fs.readFile(path.join(f.image.f.execution,'activation.json')),Buffer.from(premature.activationBytes));
  await fs.writeFile(product,'export const greeting="broken";\n');
  const start=await startCompletedApply(f),guarded=await Promise.all(['src/greeting.mjs','shared-config.json'].map(async name=>[path.join(f.root,name),await fs.readFile(path.join(f.root,name))]));
  const snapshot=path.join(f.image.f.execution,'approved-preparation.json');guarded.push([snapshot,await fs.readFile(snapshot)]);
  await completedApplyRound(f,start,{edit:HELLO,beforeVerify:async({dispatch})=>{
    for(const [file,bytes]of guarded) {
      await fs.writeFile(file,Buffer.concat([bytes,Buffer.from('\n')]));await assert.rejects(()=>verifyNative(dispatch.originFile));await fs.writeFile(file,bytes);
    }
  }});
  for(const [file,bytes]of guarded) {
    await fs.writeFile(file,Buffer.concat([bytes,Buffer.from('\n')]));await assert.rejects(()=>publish(start.handle));await fs.writeFile(file,bytes);
  }
  await fs.appendFile(product,'// private drift after PASS\n');await assert.rejects(()=>publish(start.handle),error=>error.code==='EVIDENCE_STALE');
  assert.equal((await normalize(start.handle)).nextAction,'reserve-dispatch');
  const next=await completedApplyRound(f,start);assert.equal(next.dispatch.round,2);
  const measured=await fs.readFile(product);await fs.appendFile(product,'// another drift\n');
  await assert.rejects(()=>normalize(start.handle),error=>error.code==='NORMALIZATION_EXHAUSTED');await fs.writeFile(product,measured);
  await publish(start.handle);await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
});

for(const secondInvalid of [false,true])test(`F05 completed auxiliary rejection inherits consumed calls; second rejection=${secondInvalid}`,async t=>{
  const f=await completedBlockingCase(t),start=await startCompletedApply(f);
  const first=await completedApplyRound(f,start,{invalid:true});assert.equal(first.captured.captureClass,'findings-rejection');
  const root=path.dirname(first.dispatch.originFile),sources=await captureFiles(root);
  await publish(start.handle);let image=await captureCurrentExecution(f.specPath);
  assert.equal(image.inspection.deliveries[0].counters.findingsChecks,0);
  await assert.rejects(()=>startCompletedApply(f));
  const next=await startCompletedApply(f,{successor:true});assert.notEqual(next.owner.operationAttemptId,start.owner.operationAttemptId);
  const round=await completedApplyRound(f,next,{invalid:secondInvalid,edit:secondInvalid?null:HELLO});
  assert.equal(JSON.parse(await fs.readFile(round.dispatch.requestFile)).round,2);
  await publish(next.handle);image=await captureCurrentExecution(f.specPath);
  for(const [suffix,bytes]of sources)assert.deepEqual(await fs.readFile(path.join(root,`round-1.${suffix}.json`)),bytes);
  if(secondInvalid) {
    assert.equal(image.inspection.normalHandoff,null);
    await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:image.inspection.activationId}));
  } else {
    assert.equal(image.inspection.deliveries[0].counters.findingsChecks,1);
    await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
  }
});

test('F06 completed APPLY foreign HEAD preserves literal result and blocks normalization',async t=>{
  const f=await completedBlockingCase(t),start=await startCompletedApply(f);
  await assert.rejects(()=>completedApplyRound(f,start,{edit:HELLO,head:'0'.repeat(40)}),error=>error.code==='RUNNER_RESULT_REJECTED');
  assert.equal((await resume(start.handle)).nextAction,'stop-and-diagnose');
  await assert.rejects(()=>normalize(start.handle));await assert.rejects(()=>reserveDispatch(start.handle));await assert.rejects(()=>publish(start.handle));
});

test('F05 completed auxiliary BLOCKED publishes faithfully and grants no correction or successor',async t=>{
  const f=await completedBlockingCase(t),start=await startCompletedApply(f);
  await completedApplyRound(f,start,{status:'BLOCKED'});await publish(start.handle);
  const image=await captureCurrentExecution(f.specPath);
  assert.equal(image.inspection.deliveries[0].auxiliaryStatus,'BLOCKED');assert.equal(image.inspection.normalHandoff,null);
  assert.equal(image.inspection.completed[0].observedValidation,'current');
  await assert.rejects(()=>startCompletedApply(f));await assert.rejects(()=>startCompletedApply(f,{successor:true}));
});

test('F06 completed evidence checks every findings source and current snapshot, not just latest formal',async t=>{
  const f=await completedBlockingCase(t),start=await startCompletedApply(f);await completedApplyRound(f,start,{edit:HELLO});await publish(start.handle);
  await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
  const image=await captureCurrentExecution(f.specPath),original=JSON.parse(Buffer.from(image.files.get('continuity.json'))),current=original.deliveries[0];
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path))),record=bundle.findingsChecks[0];assert.ok(record);
  for(const field of ['origin','agentBinding','concludedToolResult','verificationObservation'])await t.test(field,async()=>{
    const changed=structuredClone(bundle),continuity=structuredClone(original),files=new Map(image.files);
    changed.objects=changed.objects.filter(item=>item.id!==record.sources[field]);const bytes=Buffer.from(JSON.stringify(changed)+'\n');
    continuity.deliveries[0].evidence.sha256=sha(bytes);files.set(current.evidence.path,bytes);
    await assert.rejects(()=>completedEvidenceContext({context:image.context,snapshotBytes:Buffer.from(image.files.get('approved-preparation.json')),continuity,files}),
      error=>['INVALID_CURRENT_IMAGE','EVIDENCE_INCOMPLETE','OWNER_MISMATCH','EVIDENCE_STALE'].includes(error.code));
  });
  await t.test('complete auxiliary sources without A0/A1 witness cannot masquerade as current evidence',async()=>{
    const id=record.sources.origin,object=bundle.objects.find(item=>item.id===id);
    const capsule=JSON.parse(Buffer.from(object.bytesBase64,'base64')),origin=JSON.parse(capsule.originUtf8);
    delete origin.admission;capsule.originUtf8=JSON.stringify(origin)+'\n';capsule.dispatchUtf8=capsule.originUtf8;
    const sourceBytes=Buffer.from(JSON.stringify(capsule)+'\n'),replacement=sha(sourceBytes);
    const changed=JSON.parse(JSON.stringify(bundle).replaceAll(id,replacement));
    changed.objects.find(item=>item.id===replacement).bytesBase64=sourceBytes.toString('base64');
    changed.objects.sort((a,b)=>a.id<b.id?-1:1);
    const bytes=Buffer.from(JSON.stringify(changed)+'\n'),continuity=structuredClone(original),files=new Map(image.files);
    continuity.deliveries[0].evidence.sha256=sha(bytes);files.set(current.evidence.path,bytes);
    await assert.rejects(()=>completedEvidenceContext({context:image.context,
      snapshotBytes:Buffer.from(image.files.get('approved-preparation.json')),continuity,files}),
      error=>error.code==='OWNER_MISMATCH'&&/lacks current native A0\/A1 admission/u.test(error.message));
  });
});
