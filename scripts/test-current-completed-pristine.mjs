import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {completedPristineCase,execute,formal,reviewInput} from './fixtures/current-completed-pristine.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish,normalize,resume,normalizeSuccessor} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {completedEvidenceContext} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {prepareCurrentLocalReview,finalizeCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {publishCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/current-local-review.mjs';
import {reseal,writeImage} from './fixtures/current-quiet-reader.mjs';
const run=promisify(execFile),sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');

test('P01 completed pristine with no B decision executes and receives its first formal',async t=>{
  const f=await completedPristineCase(t),before=f.image;
  assert.equal(before.inspection.normalHandoff?.operation,'EXECUTE_SLICE');
  const snapshot=JSON.parse(Buffer.from(before.files.get('approved-preparation.json')));
  assert.ok(!snapshot.globalReview.evidenceDecisions.some(x=>x.deliveryId===f.delivery.deliveryId));
  const operation=await execute(f);await publish(operation.start.handle);
  let after=await captureCurrentExecution(f.specPath);assert.equal(after.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  await formal(f);after=await captureCurrentExecution(f.specPath);
  assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');
  assert.deepEqual(after.inspection.deliveries[0].counters,{findings:0,findingsChecks:0,implementationChecks:1,validationAttempts:1});
  assert.deepEqual(after.inspection.completed,before.inspection.completed);
  assert.deepEqual(Buffer.from(after.files.get('approved-preparation.json')),Buffer.from(before.files.get('approved-preparation.json')));
});

test('P05 concrete private recipe review with completed revalidates twice without resetting counters',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f);await publish(operation.start.handle);await formal(f);
  const baseline=await captureCurrentExecution(f.specPath);
  for(const round of [1,2]) {
    const image=await captureCurrentExecution(f.specPath),input=reviewInput(image,round),proposal=prepareCurrentLocalReview(input);
    assert.throws(()=>finalizeCurrentLocalReview({proposal,review:null}),error=>error.code==='STALE_APPROVAL');
    const review={...proposal.reviewRequest,evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Changed private recipe requires independent revalidation; literal source proof is retained.'})),decision:'approved',summary:'Controlled independent approval of explicit TAP reporter and bounded verification concurrency.'};
    const candidate=finalizeCurrentLocalReview({proposal,review});
    const current=JSON.parse(candidate.files.get('continuity.json')).deliveries[0];
    assert.equal(current.localRevision,round+1);assert.deepEqual(current.counters,image.inspection.deliveries[0].counters);
    const result=await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
    assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');
    const reviewed=await captureCurrentExecution(f.specPath);assert.equal(reviewed.inspection.deliveries[0].formalStatus,null);assert.equal(reviewed.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
    await formal(f);
  }
  const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');assert.equal(final.inspection.deliveries[0].counters.validationAttempts,3);
  assert.equal(final.inspection.deliveries[0].counters.implementationChecks,1);
  assert.deepEqual(final.inspection.completed,baseline.inspection.completed);
});

test('P08 private review after EXECUTE preserves historical implementation and admits the first formal',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f);await publish(operation.start.handle);
  const before=await captureCurrentExecution(f.specPath),input=reviewInput(before,1),proposal=prepareCurrentLocalReview(input);
  const current=JSON.parse(Buffer.from(before.files.get('continuity.json'))).deliveries[0];
  assert.equal(current.counters.implementationChecks,1);assert.equal(current.counters.validationAttempts,0);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent private recipe review before the first formal.',
    evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'The implementation was tested under the earlier private recipe; the revised authority requires its first formal.'}))};
  const candidate=finalizeCurrentLocalReview({proposal,review}),oldBundle=JSON.parse(Buffer.from(before.files.get(current.evidence.path))),nextBundle=JSON.parse(candidate.files.get(current.evidence.path));
  assert.deepEqual(nextBundle.implementation,oldBundle.implementation);assert.deepEqual(nextBundle.objects,oldBundle.objects);
  const result=await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
    reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
  assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');
  const after=await captureCurrentExecution(f.specPath),next=JSON.parse(Buffer.from(after.files.get('continuity.json'))).deliveries[0];
  assert.equal(next.localRevision,current.localRevision+1);assert.deepEqual(next.counters,current.counters);
  assert.equal(after.inspection.deliveries[0].observedValidation,'revalidation-required');
  assert.equal(after.inspection.deliveries[0].formalStatus,null);assert.equal(after.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  assert.deepEqual(after.inspection.completed,before.inspection.completed);
  assert.deepEqual(JSON.parse(Buffer.from(after.files.get('approved-preparation.json'))).globalReview,
    JSON.parse(Buffer.from(before.files.get('approved-preparation.json'))).globalReview);
  await formal(f);const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(final.inspection.deliveries[0].counters.implementationChecks,1);assert.equal(final.inspection.deliveries[0].counters.validationAttempts,1);
  assert.deepEqual(final.files.get('approved-preparation.json'),after.files.get('approved-preparation.json'));
  assert.deepEqual(final.inspection.completed,before.inspection.completed);
});

test('P08 inconsistent local-review evidence carrier is refused before live promotion',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f);await publish(operation.start.handle);
  const before=await captureCurrentExecution(f.specPath),input=reviewInput(before,1);
  const text=Buffer.from(input.currentTaskBytes).toString('utf8'),changed=text.replace('- Status: TESTS_PASS','- Status: BLOCKED');
  assert.notEqual(changed,text);input.currentTaskBytes=Buffer.from(changed);
  const proposal=prepareCurrentLocalReview(input),review={...proposal.reviewRequest,decision:'approved',summary:'Controlled normative approval does not approve a contradictory operational carrier.',
    evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Changed private recipe requires a first formal under its new authority.'}))};
  let reachedBackup=false;
  await assert.rejects(()=>publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
    reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review,
    checkpoint:async phase=>{if(phase==='before-backup')reachedBackup=true;}}),
    error=>['INVALID_CURRENT_IMAGE','EVIDENCE_STALE'].includes(error.code));
  assert.equal(reachedBackup,false);
  const after=await captureCurrentExecution(f.specPath);assert.deepEqual(after.activationBytes,before.activationBytes);
  for(const [name,bytes]of before.files)assert.deepEqual(after.files.get(name),bytes,name);
});

test('P02 a first operational proof with no decision requires every native source and exact admission',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f);await publish(operation.start.handle);
  const image=await captureCurrentExecution(f.specPath),original=JSON.parse(Buffer.from(image.files.get('continuity.json'))),current=original.deliveries[0];
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path))),record=bundle.implementation[0];
  const checked=await completedEvidenceContext({context:image.context,snapshotBytes:Buffer.from(image.files.get('approved-preparation.json')),continuity:original,files:image.files});
  assert.ok(checked.fresh.has(current.deliveryId));assert.ok(!checked.retainedEvidence.some(item=>item.deliveryId===current.deliveryId));
  const reject=async changed=>{const bytes=Buffer.from(JSON.stringify(changed)+'\n'),continuity=structuredClone(original),files=new Map(image.files);continuity.deliveries[0].evidence.sha256=sha(bytes);files.set(current.evidence.path,bytes);await assert.rejects(()=>completedEvidenceContext({context:image.context,snapshotBytes:Buffer.from(image.files.get('approved-preparation.json')),continuity,files}),error=>['INVALID_CURRENT_IMAGE','EVIDENCE_INCOMPLETE','OWNER_MISMATCH','EVIDENCE_STALE'].includes(error.code));};
  for(const field of ['origin','agentBinding','concludedToolResult','verificationObservation'])await t.test('missing '+field,()=>reject({...structuredClone(bundle),objects:bundle.objects.filter(item=>item.id!==record.sources[field])}));
  for(const variant of ['no-admission','foreign-snapshot','foreign-owner','foreign-request'])await t.test(variant,async()=>{
    const id=record.sources.origin,capsule=JSON.parse(Buffer.from(bundle.objects.find(item=>item.id===id).bytesBase64,'base64')),origin=JSON.parse(capsule.originUtf8);
    if(variant==='no-admission')delete origin.admission;
    if(variant==='foreign-snapshot')origin.admission.baseActivation.approvedSnapshotSha256='sha256:'+'a'.repeat(64);
    if(variant==='foreign-owner')origin.admission.binding.owner.operationAttemptId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    if(variant==='foreign-request')origin.requestSha256='sha256:'+'b'.repeat(64);
    capsule.originUtf8=JSON.stringify(origin)+'\n';capsule.dispatchUtf8=capsule.originUtf8;
    const source=Buffer.from(JSON.stringify(capsule)+'\n'),digest=sha(source),changed=JSON.parse(JSON.stringify(bundle).replaceAll(id,digest));
    changed.objects.find(item=>item.id===digest).bytesBase64=source.toString('base64');changed.objects.sort((a,b)=>a.id<b.id?-1:1);await reject(changed);
  });
  await t.test('offline family',async()=>{const changed=structuredClone(bundle);changed.implementation[0].origin.transport='managed';await reject(changed);});
});

for(const statuses of [['TESTS_FAIL','TESTS_PASS'],['TESTS_FAIL','TESTS_FAIL','TESTS_FAIL']])test('P03 current implementation budget '+statuses.join('/'),async t=>{
  const f=await completedPristineCase(t),operation=await execute(f,{statuses});
  assert.equal((await resume(operation.start.handle)).nextAction,'publish');
  await assert.rejects(()=>reserveDispatch(operation.start.handle,{responseVariant:'stnl-current-native-judgment-v1'}),error=>error.code==='OWNER_UNCERTAIN');
  await publish(operation.start.handle);const image=await captureCurrentExecution(f.specPath);
  assert.equal(image.inspection.deliveries[0].counters.implementationChecks,statuses.length);assert.equal(image.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
});

test('P03 concluded implementation rejection publishes faithfully before its explicit bounded successor',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f,{invalid:true});await publish(operation.start.handle);
  const image=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.equal(image.inspection.normalHandoff?.operation,'EXECUTE_SLICE');assert.equal(current.normalization.consumedInvocations,1);assert.equal(current.counters.implementationChecks,0);
  assert.equal(current.normalization.status,'settled');
  await assert.rejects(()=>begin({specPath:f.specPath,slice:f.delivery.slice,operation:'EXECUTE_SLICE',expectedActivationId:image.inspection.activationId}));
  const successor=await normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:image.inspection.activationId});
  assert.notEqual(successor.owner.operationAttemptId,operation.start.owner.operationAttemptId);
});

test('P03 implementation BLOCKED persists and grants no handoff',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f,{statuses:['BLOCKED']});await publish(operation.start.handle);
  const image=await captureCurrentExecution(f.specPath);assert.equal(image.inspection.deliveries[0].auxiliaryStatus,'BLOCKED');assert.equal(image.inspection.normalHandoff,null);
});

test('P04 current implementation recovers identical capture bytes in new processes',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f),directory=path.dirname(operation.rounds[0].dispatch.originFile),handle=path.join(f.root,'current handle with spaces.json');
  await fs.writeFile(handle,JSON.stringify(operation.start.handle));
  const suffixes=['response','receipt','observation','origin','request','agent','claim','tool-result'];
  const captures=await Promise.all(suffixes.map(name=>fs.readFile(path.join(directory,'round-1.'+name+'.json'))));
  const a1=await fs.readFile(path.join(f.image.context.logicalExecutionRoot,'activation.json'));
  await assert.rejects(()=>publish(operation.start.handle,{checkpoint:async phase=>{if(phase==='after-candidate-file')throw Error('controlled current candidate interruption');}}),/controlled current candidate/u);
  assert.deepEqual(await fs.readFile(path.join(f.image.context.logicalExecutionRoot,'activation.json')),a1);
  const guard=path.join(f.root,'no-new-check.mjs');await fs.writeFile(guard,'import cp from "node:child_process";import{syncBuiltinESMExports}from"node:module";for(const method of ["execFile","execFileSync","spawn","spawnSync","exec","execSync","fork"]){const old=cp[method];cp[method]=function(command,...args){if(command!=="git")throw Error("new recipe or runner forbidden");return old.call(this,command,...args)}}syncBuiltinESMExports();');
  for(const command of ['resume','normalize'])await run(process.execPath,['--import',guard,cli,command,'--handle',handle]);
  await assert.rejects(()=>publish(operation.start.handle,{checkpoint:async phase=>{if(phase==='after-terminal-activation')throw Error('controlled current acknowledgment loss');}}),/controlled current acknowledgment/u);
  const result=JSON.parse((await run(process.execPath,['--import',guard,cli,'publish','--handle',handle])).stdout);assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');
  for(let i=0;i<suffixes.length;i++)assert.deepEqual(await fs.readFile(path.join(directory,'round-1.'+suffixes[i]+'.json')),captures[i]);
  await assert.rejects(fs.lstat(path.join(directory,'round-2.origin.json')),{code:'ENOENT'});
  const owner=JSON.parse(await fs.readFile(path.join(directory,'owner.json')));assert.equal(owner.cleanup.status,'complete');
});

test('P05 private review can precede EXECUTE; stale approval and shared-input impact refuse',async t=>{
  const f=await completedPristineCase(t),before=await captureCurrentExecution(f.specPath),input=reviewInput(before,1),proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent approval of deterministic private verification reporting before first execution.'};
  const changed=prepareCurrentLocalReview({...input,planBytes:Buffer.from(input.planBytes.toString().replace('--test-reporter=tap','--test-reporter=spec')),
    reviewedTaskBytes:Buffer.from(input.reviewedTaskBytes.toString().replace('--test-reporter=tap','--test-reporter=spec')),
    currentTaskBytes:Buffer.from(input.currentTaskBytes.toString().replace('--test-reporter=tap','--test-reporter=spec'))});
  assert.throws(()=>finalizeCurrentLocalReview({proposal:changed,review}),error=>error.code==='STALE_APPROVAL');
  const relative=path.relative(path.join(f.image.context.logicalExecutionRoot,'tasks'),path.join(f.root,'src/greeting.mjs')).split(path.sep).join('/');
  const shared=bytes=>Buffer.from(bytes.toString().replace('## Existing Inputs\n\n- none','## Existing Inputs\n\n- `'+relative+'`')
    .replace(/^- Recipe: (.+)$/mu,(_,raw)=>{const recipe=JSON.parse(raw);recipe.checks[0].inputs.push({kind:'input',path:relative});return '- Recipe: '+JSON.stringify(recipe);}));
  assert.throws(()=>prepareCurrentLocalReview({...input,planBytes:shared(input.planBytes),reviewedTaskBytes:shared(input.reviewedTaskBytes),currentTaskBytes:shared(input.currentTaskBytes)}),error=>error.code==='REPLAN_REQUIRED');
  await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
  const revised=await captureCurrentExecution(f.specPath);assert.equal(revised.inspection.normalHandoff?.operation,'EXECUTE_SLICE');
  assert.deepEqual(revised.inspection.deliveries[0].counters,before.inspection.deliveries[0].counters);
  const operation=await execute(f);await publish(operation.start.handle);await formal(f);
  const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
});

test('P04 captured implementation PASS cannot be published after drift; one episode rechecks within its budget',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f);
  await fs.writeFile(path.join(f.root,'other/greeting.mjs'),'export const greeting="hello"; // private drift after captured PASS\n');
  await assert.rejects(()=>publish(operation.start.handle),error=>error.code==='EVIDENCE_STALE');
  const normal=await normalize(operation.start.handle);assert.equal(normal.nextAction,'reserve-dispatch');
  const dispatch=await reserveDispatch(operation.start.handle,{responseVariant:'stnl-current-native-judgment-v1'});assert.equal(dispatch.round,2);
  const agentId='controlled-pristine-drift-second';await bindNative(operation.start.handle,agentId);const observation=await verifyNative(dispatch.originFile);
  const {payload}=await import('./fixtures/current-initial-evidence.mjs');const {head,...result}=payload(2);result.commands=observation.commands;result.priorRoundFailure='The prior captured PASS became stale after a private output change.';
  const file=path.join(f.root,'controlled-pristine-drift.json');await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result})}));
  await captureNative(operation.start.handle,file);await publish(operation.start.handle);const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.deliveries[0].counters.implementationChecks,2);
});

test('P03 uncertain metadata preserves A1 and cannot reserve a successor',async t=>{
  const f=await completedPristineCase(t),a0=await captureCurrentExecution(f.specPath);
  await assert.rejects(()=>execute(f,{headOverride:'f'.repeat(40)}),error=>error.code==='RUNNER_RESULT_REJECTED');
  const activation=JSON.parse(await fs.readFile(path.join(f.image.context.logicalExecutionRoot,'activation.json')));assert.ok(activation.activeAttempt);assert.equal(activation.previousActivationId,a0.inspection.activationId);
  const handle={format:'stnl-current-operation-handle-v1',specPath:f.specPath,operationId:activation.activeAttempt.operationRef.operationId,ownershipToken:activation.activeAttempt.ownershipToken};
  assert.equal((await resume(handle)).nextAction,'stop-and-diagnose');
  await assert.rejects(()=>reserveDispatch(handle,{responseVariant:'stnl-current-native-judgment-v1'}),error=>error.code==='OWNER_UNCERTAIN');
});

test('P03 first formal NEEDS_FIX connects to the already accepted corrective cycle',async t=>{
  const f=await completedPristineCase(t),operation=await execute(f,{statuses:['TESTS_FAIL','TESTS_FAIL','TESTS_FAIL']});await publish(operation.start.handle);
  const finding={id:'finding-01',severity:'blocking',originAttempt:'attempt-01',problem:'The current greeting equals broken instead of hello.',evidence:'other/greeting.mjs exports broken and the prepared strict assertion fails.',impact:'AC-001/obligation-01 is not met.',relatedAuthority:'AC-001; obligation-01',expectedCorrection:'Restore the greeting export in other/greeting.mjs to hello.'};
  await formal(f,{status:'NEEDS_FIX',newFindings:[finding],references:'finding-01',dispositions:'finding-01=active'});
  const before=await captureCurrentExecution(f.specPath);assert.equal(before.inspection.normalHandoff?.operation,'APPLY_FINDINGS');
  const start=await begin({specPath:f.specPath,slice:f.delivery.slice,operation:'APPLY_FINDINGS',expectedActivationId:before.inspection.activationId});
  await fs.writeFile(path.join(f.root,'other/greeting.mjs'),'export const greeting="hello";\n');
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'}),agentId='controlled-pristine-apply';await bindNative(start.handle,agentId);const observed=await verifyNative(dispatch.originFile);
  const {applyPayload}=await import('./fixtures/current-findings-evidence.mjs');const {head,...result}=applyPayload(1,'TESTS_PASS',0);result.commands=observed.commands;result.findingsVerified='finding-01';result.unsupportedActiveFindings='none';
  const file=path.join(f.root,'controlled-pristine-apply.json');await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result})}));
  await captureNative(start.handle,file);await publish(start.handle);await formal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
  const after=await captureCurrentExecution(f.specPath);assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');assert.deepEqual(after.inspection.deliveries[0].counters,{implementationChecks:3,validationAttempts:2,findingsChecks:1,findings:1});
});

test('P02 pristine excludes prior validation, diagnostic, normalization, consumption and active owner',async t=>{
  const f=await completedPristineCase(t),original=structuredClone(f.view.continuity);
  const cases={validation:current=>{current.validation='revalidation-required';},
    diagnostic:current=>{current.lastDiagnostic={code:'EVIDENCE_INCOMPLETE',operationAttemptId:null,reason:'A prior operation requires diagnosis.',affectedPaths:[],nextAction:'stop'};},
    consumption:current=>{current.counters.implementationChecks=1;},
    normalization:current=>{current.normalization={episodeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',operation:'EXECUTE_SLICE',causeSha256:'sha256:'+'a'.repeat(64),sourceOperationAttemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',used:1,consumedInvocations:1,round:1,status:'exhausted'};}};
  for(const [name,edit]of Object.entries(cases))await t.test(name,async()=>{
    f.view.continuity=structuredClone(original);edit(f.view.continuity.deliveries[0]);reseal(f.view);await writeImage(f.view);
    const before=await fs.readFile(path.join(f.view.execution,'activation.json'));
    await assert.rejects(()=>begin({specPath:f.specPath,slice:f.delivery.slice,operation:'EXECUTE_SLICE',expectedActivationId:f.view.activation.activationId}));
    assert.deepEqual(await fs.readFile(path.join(f.view.execution,'activation.json')),before);
  });
  f.view.continuity=original;reseal(f.view);await writeImage(f.view);
  const image=await captureCurrentExecution(f.specPath);await begin({specPath:f.specPath,slice:f.delivery.slice,operation:'EXECUTE_SLICE',expectedActivationId:image.inspection.activationId});
  await assert.rejects(()=>begin({specPath:f.specPath,slice:f.delivery.slice,operation:'EXECUTE_SLICE',expectedActivationId:image.inspection.activationId}),error=>['OWNER_ACTIVE','OWNER_UNCERTAIN'].includes(error.code));
});
