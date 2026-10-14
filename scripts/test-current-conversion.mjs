import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fixture,approveFixture,captureLegacy,disjointDomainS0,revisedS0,retiredSelectorS0,nativeFilePass,nativeAbsentForecast,nativeHistoricalHighWater,nativeFindingCycle,managedFilePass,managedFilelessPass,managedBlockedAfterNativeFile,
  managedMalformedOwnerActive,observeWork,reviewProposal,sha} from './fixtures/current-conversion.mjs';
import {prepareCurrentConversion,finalizeCurrentConversion,validateCurrentConversion} from '../skills/workflows/stnl-execution-planner/runtime/execution-conversion-current.mjs';
import {validateCurrentCandidate,validateCurrentImage} from '../skills/workflows/stnl-execution-planner/runtime/execution-current.mjs';
import {inspectConvertedExecution,verifyImportedEvidence} from '../skills/workflows/stnl-execution-planner/runtime/execution-evidence-proof.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const fixtureWorker=path.join(repo,'scripts/fixtures/current-quiet-reader.mjs');
const proof=path.join(repo,'skills/workflows/stnl-execution-planner/runtime/execution-evidence-proof.mjs');
const converter=path.join(repo,'skills/workflows/stnl-execution-planner/runtime/execution-conversion-current.mjs');
const err=code=>error=>error?.code===code;
const idFrom=source=>JSON.parse(source.files.get('approved-preparation.json')).deliveries[0].deliveryId;
const seals=source=>new Map([...source.files].map(([name,bytes])=>[name,sha(bytes)]));
// Negative captures may corrupt official bytes. Keep the enclosing activation
// manifest and physical tree consistent so the intended decoder sees the fault.
function corruptOfficial(input,name,bytes) {
  const files=new Map(input.source.files);
  files.set(name,bytes);
  if(name!=='activation.json') {
    const activation=JSON.parse(files.get('activation.json'));
    activation.artifacts=activation.artifacts.map(item=>item.path===name
      ?{...item,sha256:sha(bytes)}:item);
    files.set('activation.json',Buffer.from(JSON.stringify(activation)+'\n'));
  }
  const tree={...input.source.tree,files:input.source.tree.files.map(item=>
    item.path===name || item.path==='activation.json'
      ?{...item,sha256:sha(files.get(item.path))}:item)};
  return {...input,source:{...input.source,files,tree}};
}

// Rebind capture/predecessor hashes for semantic mutants. The provenance
// mutant preserves the predecessor so its internal contradiction is visible.
function corruptHistoryTask(input,history,mutate,{rebindPredecessor=true}={}) {
  const controls=new Map(input.source.controls),root=input.context.physicalExecutionRoot;
  const taskPath=path.resolve(root,history.taskRef.path),markerPath=path.resolve(root,history.allocationRef.path);
  const before=controls.get(taskPath).toString('utf8'),after=mutate(before);
  assert.notEqual(after,before,'historical stimulus applied');
  const taskBytes=Buffer.from(after),marker=JSON.parse(controls.get(markerPath));
  controls.set(taskPath,taskBytes);
  if(rebindPredecessor) {
    const selected=marker.expectedTree.files.find(item=>item.path===history.taskRef.logicalTaskPath);
    assert.ok(selected,'producer predecessor Task exists');selected.sha256=sha(taskBytes);
  }
  marker.retention.retainedPaths=marker.retention.retainedPaths.map(item=>
    item.path===taskPath?{...item,sha256:sha(taskBytes)}:item);
  controls.set(markerPath,Buffer.from(JSON.stringify(marker)+'\n'));
  const markerHash=sha(Buffer.from(JSON.stringify(marker.retention)));
  const bind=ref=>ref && path.resolve(root,ref.path)===markerPath?{...ref,sha256:markerHash}:ref;
  const continuity=JSON.parse(input.source.files.get('continuity.json'));
  for(const delivery of continuity.deliveries) {
    if(delivery.baseline) delivery.baseline.allocationRef=bind(delivery.baseline.allocationRef);
    for(const entry of delivery.history) {
      entry.allocationRef=bind(entry.allocationRef);
      if(path.resolve(root,entry.taskRef.path)===taskPath) entry.taskRef.sha256=sha(taskBytes);
    }
  }
  return corruptOfficial({...input,source:{...input.source,controls,
    selectorHistory:input.source.selectorHistory.map(item=>({...item,allocationRef:bind(item.allocationRef)}))}},
  'continuity.json',Buffer.from(JSON.stringify(continuity)+'\n'));
}

async function s0(t,{form='standalone'}={}) {
  const f=await fixture({test:t,form});
  await approveFixture(f);
  const input=await captureLegacy(f);
  const before=seals(input.source);
  const proposal=await prepareCurrentConversion(input);
  assert.equal(proposal.phase,'reviewable');
  assert.deepEqual(seals(input.source),before,'pure prepare did not mutate captured legacy bytes');
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,requirementsAuthority:input.requirementsAuthority,
    observedWork:input.observedWork,proposal,review});
  assert.deepEqual(seals(input.source),before,'finalize did not mutate captured legacy bytes');
  return {f,input,proposal,review,candidate};
}

function assertS0({input,proposal,candidate}) {
  const old=JSON.parse(input.source.files.get('approved-preparation.json'));
  const snapshot=JSON.parse(candidate.files.get('approved-preparation.json'));
  const current=JSON.parse(candidate.files.get('continuity.json'));
  const originalId=old.deliveries[0].deliveryId;
  assert.equal(snapshot.preparationRevision,old.preparationRevision+1);
  assert.equal(snapshot.deliveries[0].deliveryId,originalId);
  assert.equal(current.deliveries[0].deliveryId,originalId);
  assert.equal(current.nextSliceOrdinal,2);
  assert.deepEqual(current.deliveries[0].counters,
    {implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0});
  assert.equal(current.deliveries[0].validation,'unvalidated');
  assert.equal(current.deliveries[0].evidence,null);
  assert.equal(proposal.files.has('approved-preparation.json'),false);
  assert.equal(candidate.files.has('activation.json'),false);
  assert.deepEqual([...candidate.files].filter(([name])=>!proposal.files.has(name)).map(([name])=>name),
    ['approved-preparation.json']);
  for(const [name,bytes] of proposal.files) assert.deepEqual(candidate.files.get(name),bytes,
    `${name}: reviewed bytes survived finalize`);
  assert.deepEqual(candidate.inspection.admissibleOperations,[]);
  assert.deepEqual(candidate.inspection.deliveries[0].consumption,
    {kind:'none-observed',consumedInvocations:0,remainingInvocations:null,resumable:false});
}

function consumerWire({input,candidate}) {
  return {context:input.context,requirementsAuthority:input.requirementsAuthority,
    observedWork:input.observedWork,files:[...candidate.files].map(([name,bytes])=>[name,bytes.toString('base64')])};
}

function prepareWire({input}) {
  const pairs=map=>[...map].map(([name,bytes])=>[name,bytes.toString('base64')]);
  return {...input,source:{...input.source,requirementsFiles:pairs(input.source.requirementsFiles),
    files:pairs(input.source.files),controls:pairs(input.source.controls),managedContexts:pairs(input.source.managedContexts),
    imports:input.source.imports.map(item=>({...item,objects:pairs(item.objects)}))}};
}

function worker(f,mode,selected,wire) {
  const log=path.join(f.root,`conversion-${mode.replace(':','-')}.json`);
  const env={...process.env,STNL_CONVERSION_PAYLOAD:Buffer.from(JSON.stringify(wire)).toString('base64')};
  delete env.NODE_TEST_CONTEXT;
  const run=spawnSync(process.execPath,[fixtureWorker,'--worker',mode,selected,f.specPath,log,f.root],
    {env,encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stderr);
  return fs.readFile(log,'utf8').then(JSON.parse);
}

test('M01 fonte oficial v1 aprovada: S0 preserva ID, revisão, contadores e bytes',async t=>{
  const result=await s0(t);
  assertS0(result);
  const originalActivation=JSON.parse(result.input.source.files.get('activation.json'));
  for (const mutate of [
    items=>items.push({...items[0]}),
    items=>items.pop(),
    items=>items.push({path:'unexpected.json',sha256:items[0].sha256}),
    items=>{items[0].sha256=`sha256:${'0'.repeat(64)}`;},
  ]) {
    const activation=structuredClone(originalActivation);
    mutate(activation.artifacts);
    const changed=corruptOfficial(result.input,'activation.json',Buffer.from(JSON.stringify(activation)+'\n'));
    await assert.rejects(prepareCurrentConversion(changed),error=>
      error?.code==='EVIDENCE_INCOMPLETE' && /legacy A\/B manifest differs/u.test(error.message));
  }
  const baseline=JSON.parse(result.input.source.files.get('continuity.json')).deliveries[0].baseline;
  assert.ok(baseline,'real preparation already retained a baseline before execution');
  const controls=new Map(result.input.source.controls);
  controls.delete(path.resolve(result.input.context.physicalExecutionRoot,baseline.manifestRef.path));
  await assert.rejects(prepareCurrentConversion({...result.input,source:{...result.input.source,controls}}),
    error=>error?.code==='EVIDENCE_INCOMPLETE' && /baseline/u.test(error.message));
  assert.equal(idFrom(result.input.source),result.candidate.inspection.deliveries[0].deliveryId);
  const compared=await validateCurrentConversion({context:result.input.context,
    requirementsAuthority:result.input.requirementsAuthority,source:result.input.source,
    observedWork:result.input.observedWork,candidate:result.candidate,review:result.review});
  assert.equal(compared.sourceCompared,true);
  assert.equal(result.candidate.inspection.deliveries[0].requiresFormalRevalidation,false);
  await fs.writeFile(path.join(result.f.root,'src/observed-after-conversion.txt'),'changed after conversion\n');
  const drift=await inspectConvertedExecution({context:result.input.context,
    requirementsAuthority:result.input.requirementsAuthority,files:result.candidate.files,
    observedWork:await observeWork(result.f.root)});
  assert.equal(drift.deliveries[0].persistedValidation,'unvalidated');
  assert.equal(drift.deliveries[0].observedValidation,'revalidation-required');
  assert.equal(drift.deliveries[0].requiresFormalRevalidation,true);
});

test('M01 lifecycle ready produz candidata S0 autocontida com a mesma autoridade documental',async t=>{
  const result=await s0(t,{form:'lifecycle-directory'});
  assertS0(result);
  assert.equal(result.input.context.logicalSpecRoot,result.f.specPath);
  assert.equal(result.input.source.requirementsFiles.has(path.join(result.f.specPath,'feature_spec.md')),true);
});

test('M01 revisão legada 2 real conserva ID e testemunha do seletor anterior',async t=>{
  const {input}=await revisedS0(t);
  const previous=JSON.parse(input.source.files.get('approved-preparation.json'));
  assert.equal(previous.preparationRevision,2);
  assert.equal(input.source.selectorHistory.length,1);
  const proposal=await prepareCurrentConversion(input);
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  assert.equal(JSON.parse(candidate.files.get('approved-preparation.json')).preparationRevision,3);
  assert.equal(JSON.parse(candidate.files.get('continuity.json')).nextSliceOrdinal,2);
  assert.equal(candidate.inspection.deliveries[0].deliveryId,previous.deliveries[0].deliveryId);
  const broken={...input,source:{...input.source,selectorHistory:[]}};
  await assert.rejects(prepareCurrentConversion(broken),err('EVIDENCE_INCOMPLETE'));
});

test('M04 testemunha histórica duplicada, lacuna e hash trocado não viram seletor novo',async t=>{
  const {input}=await revisedS0(t);
  const witness=input.source.selectorHistory[0];
  const changed=selectorHistory=>({...input,source:{...input.source,selectorHistory}});
  await assert.rejects(prepareCurrentConversion(changed([witness,witness])),err('EVIDENCE_INCOMPLETE'));
  await assert.rejects(prepareCurrentConversion(changed([{...witness,revision:2}])),err('EVIDENCE_INCOMPLETE'));
  await assert.rejects(prepareCurrentConversion(changed([{...witness,snapshotRef:{...witness.snapshotRef,
    sha256:`sha256:${'0'.repeat(64)}`}}])),err('EVIDENCE_INCOMPLETE'));
  const proposal=await prepareCurrentConversion(input);
  assert.equal(proposal.base.sourceSelectorHighWater,1);
});

test('M04 check podado por REPLAN real mantém high-water histórico em S2 terminal',async t=>{
  const {f,input,history,formal,witness}=await nativeHistoricalHighWater(t);
  const archived=input.source.controls.get(path.resolve(f.execution,history.taskRef.path)).toString('utf8');
  const current=input.source.files.get('tasks/slice-01.md').toString('utf8');
  assert.match(archived,/### implementation-check-01\n/u);
  assert.doesNotMatch(current,/### implementation-check-/u);
  assert.match(current,/### attempt-01\n/u);
  assert.equal(JSON.parse(input.source.files.get('activation.json')).lastAttempt.operationAttemptId,
    formal.owner.operationAttemptId);
  assert.equal(witness.revision,1);
  const before=seals(input.source);
  const proposal=await prepareCurrentConversion(input);
  assert.equal(proposal.base.sourceSelectorHighWater,1);
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  const state=JSON.parse(candidate.files.get('continuity.json')).deliveries[0];
  assert.deepEqual(state.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:0});
  assert.equal(state.validation,'revalidation-required');
  assert.equal(state.evidence,null);
  assert.deepEqual(seals(input.source),before);
  const controls=new Map(input.source.controls);
  controls.delete(path.resolve(f.execution,history.taskRef.path));
  await assert.rejects(prepareCurrentConversion({...input,source:{...input.source,controls}}),error=>
    error?.code==='EVIDENCE_INCOMPLETE' && /history task not retained/u.test(error.message));
  const firstRecord=archived.match(/### implementation-check-01\n[\s\S]*?(?=\n## )/u)?.[0];
  assert.ok(firstRecord,'producer-retained historical check');
  const appendRecord=record=>text=>text.replace('\n## Findings Test Evidence',
    `\n\n${record.trimEnd()}\n## Findings Test Evidence`);
  const gap=corruptHistoryTask(input,history,appendRecord(firstRecord.replace(
    '### implementation-check-01','### implementation-check-03')));
  await assert.rejects(prepareCurrentConversion(gap),error=>
    error?.code==='EVIDENCE_INCOMPLETE' && /missing historical ordinal 2/u.test(error.message));
  for(const [replacement,reason] of [
    ['implementation-check-9007199254740992',/safe integer/u],
    ['implementation-check-002',/noncanonical historical ID/u],
  ]) await assert.rejects(prepareCurrentConversion(corruptHistoryTask(input,history,text=>text.replace(
    '### implementation-check-01',`### ${replacement}`))),error=>
    error?.code==='INVALID_CURRENT_IMAGE' && reason.test(error.message));
  const duplicate=corruptHistoryTask(input,history,appendRecord(firstRecord.replace(
    '- Status: TESTS_PASS','- Status: TESTS_FAIL')));
  // A second sealed record cannot reuse the pruned historical ordinal.
  await assert.rejects(prepareCurrentConversion(duplicate),error=>
    error?.code==='EVIDENCE_INCOMPLETE' && /duplicate|conflict/u.test(error.message));
  const forgedOwner=corruptHistoryTask(input,history,text=>text.replace(/^- Operation attempt ID: .+$/mu,
    '- Operation attempt ID: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),{rebindPredecessor:false});
  await assert.rejects(prepareCurrentConversion(forgedOwner),error=>error?.code==='EVIDENCE_INCOMPLETE'
    && /retained bytes differ from producer predecessor tree/u.test(error.message));
  for(const [before,after] of [['- Status: TESTS_PASS','- Status: UNKNOWN'],['- Automatic check round: 1/3','- Automatic check round: 99/3']])
    await assert.rejects(prepareCurrentConversion(corruptHistoryTask(input,history,text=>text.replace(before,after))),error=>
      error?.code==='EVIDENCE_INCOMPLETE' && /historical auxiliary status\/round/u.test(error.message));
  for(const mutate of [
    text=>text.replaceAll(/^- Delivery ID: (.+)$/mu.exec(text)[1],
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    text=>text.replace('- Plan revision: 1','- Plan revision: 2'),
    text=>text.replace(/^- Requirements authority: .+$/mu,`- Requirements authority: sha256:${'0'.repeat(64)}`),
    text=>text.replace('## Result\n\n','## Result\n\nContradict the retained approved result. '),
  ]) await assert.rejects(prepareCurrentConversion(corruptHistoryTask(input,history,mutate)),
    error=>error?.code==='EVIDENCE_INCOMPLETE' && /history Task identity or normative content/u.test(error.message));
});

test('M04 seletor 02 retirado por REPLAN real reserva ordinal 03 no S0',async t=>{
  const {input}=await retiredSelectorS0(t);
  const old=JSON.parse(input.source.controls.get(path.resolve(input.context.physicalExecutionRoot,
    input.source.selectorHistory[0].snapshotRef.path)));
  assert.deepEqual(old.normativeProjection.order.map(item=>item.slice),['slice-01','slice-02']);
  const now=JSON.parse(input.source.files.get('approved-preparation.json'));
  assert.deepEqual(now.normativeProjection.order.map(item=>item.slice),['slice-01']);
  const proposal=await prepareCurrentConversion(input);
  assert.equal(proposal.base.sourceSelectorHighWater,2);
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  const continuity=JSON.parse(candidate.files.get('continuity.json'));
  assert.equal(continuity.nextSliceOrdinal,3);
  assert.deepEqual(continuity.deliveries[0].counters,
    {implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0});
});

test('M02 native real com arquivo e modo histórico ausente conserva S2 e owner terminal',async t=>{
  const produced=await nativeFilePass(t);
  const {input,formal,formalPublication}=produced;
  assert.equal(formalPublication.publication,'confirmed');
  const activation=JSON.parse(input.source.files.get('activation.json'));
  assert.equal(activation.activeAttempt,null);
  assert.equal(activation.lastAttempt.operationAttemptId,formal.owner.operationAttemptId);
  assert.ok(input.observedWork.entries.some(item=>item.kind==='file'));
  const before=seals(input.source);
  const proposal=await prepareCurrentConversion(input);
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,requirementsAuthority:input.requirementsAuthority,
    observedWork:input.observedWork,proposal,review});
  const continuity=JSON.parse(candidate.files.get('continuity.json'));
  const delivery=continuity.deliveries[0];
  assert.equal(delivery.deliveryId,idFrom(input.source));
  assert.deepEqual(delivery.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:0});
  assert.equal(delivery.validation,'revalidation-required');
  assert.equal(delivery.evidence,null);
  assert.equal(delivery.lastDiagnostic.code,'EVIDENCE_INCOMPLETE');
  assert.ok(delivery.lastDiagnostic.affectedPaths.some(name=>name==='src/greeting.test.mjs'));
  assert.equal(candidate.inspection.deliveries[0].requiresFormalRevalidation,true);
  assert.deepEqual(candidate.inspection.deliveries[0].consumption,
    {kind:'closed-boundary-not-resumable',consumedInvocations:null,remainingInvocations:null,resumable:false});
  const noFormalFiles=new Map(candidate.files),noFormal=JSON.parse(noFormalFiles.get('continuity.json'));
  noFormal.deliveries[0].counters.validationAttempts=0;
  noFormalFiles.set('continuity.json',Buffer.from(JSON.stringify(noFormal)+'\n'));
  await assert.rejects(inspectConvertedExecution({context:input.context,
    requirementsAuthority:input.requirementsAuthority,files:noFormalFiles,observedWork:input.observedWork}),
    error=>error?.code==='EVIDENCE_INCOMPLETE' && /unsupported evidence-free conversion state/u.test(error.message));
  for(const name of [input.source.imports[0].boundary.receiptPath,
    input.source.imports[0].boundary.publicationPath]) {
    const incomplete={...input,source:{...input.source,controls:new Map(input.source.controls)}};
    incomplete.source.controls.delete(name);
    await assert.rejects(prepareCurrentConversion(incomplete),err('EVIDENCE_INCOMPLETE'));
  }
  const file=path.join(produced.f.root,'src/greeting.test.mjs');
  const priorMode=(await fs.stat(file)).mode & 0o777;
  await fs.chmod(file,priorMode===0o600?0o644:0o600);
  const chmodObserved=await observeWork(produced.f.root);
  assert.notDeepEqual(chmodObserved,input.observedWork);
  const afterChmod=await prepareCurrentConversion({...input,observedWork:chmodObserved});
  assert.equal(JSON.parse(afterChmod.files.get('continuity.json')).deliveries[0].validation,'revalidation-required');
  assert.deepEqual(seals(input.source),before);
});

test('M02 native real sem arquivos preserva PASS importado e domínio vazio S1',async t=>{
  const {input,formal}=await nativeFilePass(t,{fileless:true});
  assert.deepEqual(input.observedWork.entries,[{path:'src',kind:'directory',children:[]}]);
  assert.equal(JSON.parse(input.source.files.get('activation.json')).lastAttempt.operationAttemptId,
    formal.owner.operationAttemptId);
  assert.equal(input.source.imports[0].implementation.length,1);
  assert.equal(input.source.imports[0].validation.kind,'validation');
  const raws=new Map([...input.source.imports[0].objects].map(([id,bytes])=>[id,sha(bytes)]));
  for(const [id,digest] of raws) assert.equal(id,digest);
  const proposal=await prepareCurrentConversion(input);
  assert.equal(proposal.proposedDecisions.length,1);
  assert.equal(proposal.proposedDecisions[0].disposition,'retain-current');
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  const state=JSON.parse(candidate.files.get('continuity.json')).deliveries[0];
  assert.deepEqual(state.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:0});
  assert.equal(state.validation,'current');
  assert.ok(state.evidence);
  assert.equal(candidate.inspection.deliveries[0].counterAuthority,'persisted-continuity');
  const retested=await validateCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,source:input.source,
    observedWork:input.observedWork,candidate,review});
  assert.equal(retested.sourceCompared,true);
});

test('M03 managed real com arquivo, contexto de ambiente e broker fechado conserva S2',async t=>{
  const {input,produced}=await managedFilePass(t);
  const owner=produced.context.owner.operationAttemptId;
  assert.equal(input.source.managedContexts.size,1);
  assert.deepEqual(input.source.managedContexts.get(owner),produced.contextBytes);
  const activation=JSON.parse(input.source.files.get('activation.json'));
  assert.equal(activation.activeAttempt,null);
  assert.equal(activation.lastAttempt.operationAttemptId,owner);
  const boundary=input.source.imports[0].boundary;
  assert.equal(Object.hasOwn(boundary,'originPath'),false);
  assert.equal(boundary.managedContextId,owner);
  assert.equal(JSON.parse(input.source.controls.get(boundary.closure.supervisorPath)).pending,false);
  const proposal=await prepareCurrentConversion(input);
  assert.deepEqual(proposal.base.managedContextManifest,
    [{operationAttemptId:owner,sha256:sha(produced.contextBytes)}]);
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  const state=JSON.parse(candidate.files.get('continuity.json')).deliveries[0];
  assert.equal(state.deliveryId,idFrom(input.source));
  assert.deepEqual(state.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:0});
  assert.equal(state.validation,'revalidation-required');
  assert.equal(state.evidence,null);
  assert.equal(state.lastDiagnostic.code,'EVIDENCE_INCOMPLETE');
  assert.equal(candidate.inspection.deliveries[0].requiresFormalRevalidation,true);
  assert.equal(candidate.inspection.deliveries[0].consumption.resumable,false);
  const missing={...input,source:{...input.source,managedContexts:new Map()}};
  await assert.rejects(prepareCurrentConversion(missing),err('EVIDENCE_INCOMPLETE'));
  const orphan={...input,source:{...input.source,managedContexts:new Map(input.source.managedContexts)}};
  orphan.source.managedContexts.set('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    Buffer.from(JSON.stringify({...JSON.parse(produced.contextBytes),owner:{...produced.context.owner,
      operationAttemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}})));
  await assert.rejects(prepareCurrentConversion(orphan),err('EVIDENCE_INCOMPLETE'));
  const swapped={...input,source:{...input.source,managedContexts:new Map(input.source.managedContexts)}};
  swapped.source.managedContexts.set(owner,Buffer.from(JSON.stringify(JSON.parse(produced.contextBytes))+'\n'));
  const changed=await prepareCurrentConversion(swapped);
  assert.notEqual(changed.proposalSha256,proposal.proposalSha256);
  await assert.rejects(validateCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,source:swapped.source,
    observedWork:input.observedWork,candidate,review}),err('STALE_APPROVAL'));
});

test('M03 managed real sem arquivos transporta dois contextos e PASS S1',async t=>{
  const {input,first,formal}=await managedFilelessPass(t);
  assert.deepEqual(input.observedWork.entries,[{path:'src',kind:'directory',children:[]}]);
  assert.equal(input.source.managedContexts.size,2);
  assert.deepEqual(input.source.managedContexts.get(first.context.owner.operationAttemptId),first.contextBytes);
  assert.deepEqual(input.source.managedContexts.get(formal.context.owner.operationAttemptId),formal.contextBytes);
  assert.equal(JSON.parse(input.source.files.get('activation.json')).lastAttempt.operationAttemptId,
    formal.context.owner.operationAttemptId);
  const proposal=await prepareCurrentConversion(input);
  assert.equal(proposal.base.managedContextManifest.length,2);
  assert.equal(proposal.proposedDecisions[0].disposition,'retain-current');
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  const state=JSON.parse(candidate.files.get('continuity.json')).deliveries[0];
  assert.deepEqual(state.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:0});
  assert.equal(state.validation,'current');
  assert.ok(state.evidence);
  assert.equal(candidate.inspection.deliveries[0].counterAuthority,'persisted-continuity');
  const missing={...input,source:{...input.source,managedContexts:new Map(input.source.managedContexts)}};
  missing.source.managedContexts.delete(first.context.owner.operationAttemptId);
  await assert.rejects(prepareCurrentConversion(missing),err('EVIDENCE_INCOMPLETE'));
});

test('M06 S2 não precisa de raw auxiliar para manter contagem, mas precisa da fronteira formal',async t=>{
  const {input}=await nativeFilePass(t);
  assert.equal(input.source.imports[0].implementation.length,0);
  assert.equal(input.source.imports[0].objects.size,0);
  const proposal=await prepareCurrentConversion(input);
  const review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  const wire=consumerWire({input,candidate});
  const consumed=await worker({root:input.context.productRoot,specPath:input.context.logicalAuthorityPath},
    'conversion:consume',proof,wire);
  assert.deepEqual(consumed.attempts,[]);
  assert.deepEqual(consumed.result.deliveries[0].counters,
    {implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:0});
  assert.equal(consumed.result.deliveries[0].consumption.resumable,false);
  const altered={...input,source:{...input.source,controls:new Map(input.source.controls)}};
  altered.source.controls.delete(input.source.imports[0].boundary.manifestPath);
  await assert.rejects(prepareCurrentConversion(altered),err('EVIDENCE_INCOMPLETE'));
});

test('M07 arquivo novo quebra atualidade S1; chmod pós PASS não fabrica modo histórico S2',async t=>{
  const native=await nativeFilePass(t,{fileless:true});
  const first=await prepareCurrentConversion(native.input);
  assert.equal(first.proposedDecisions[0].disposition,'retain-current');
  const file=path.join(native.f.root,'src/new-after-pass.mjs');
  await fs.writeFile(file,'export const later = true;\n');
  const changed=await prepareCurrentConversion({...native.input,observedWork:await observeWork(native.f.root)});
  assert.equal(changed.proposedDecisions[0].disposition,'revalidate');
  const withFiles=await nativeFilePass(t);
  const oldSource=seals(withFiles.input.source);
  const recorded=await prepareCurrentConversion(withFiles.input);
  const original=path.join(withFiles.f.root,'src/greeting.test.mjs');
  await fs.chmod(original,0o600);
  const another=await prepareCurrentConversion({...withFiles.input,observedWork:await observeWork(withFiles.f.root)});
  assert.equal(JSON.parse(recorded.files.get('continuity.json')).deliveries[0].validation,'revalidation-required');
  assert.equal(JSON.parse(another.files.get('continuity.json')).deliveries[0].validation,'revalidation-required');
  assert.deepEqual(seals(withFiles.input.source),oldSource);
});

test('M07 remoção pós PASS com bytes retidos continua S2; hash de preimage inventado falha',async t=>{
  const produced=await nativeFilePass(t);
  const input=produced.input,boundary=input.source.imports[0].boundary;
  const saved=seals(input.source);
  await fs.rm(path.join(produced.f.root,'src/greeting.test.mjs'));
  const removed=await prepareCurrentConversion({...input,observedWork:await observeWork(produced.f.root)});
  const state=JSON.parse(removed.files.get('continuity.json')).deliveries[0];
  assert.equal(state.validation,'revalidation-required');
  assert.equal(state.evidence,null);
  assert.deepEqual(seals(input.source),saved);
  const altered={...input,source:{...input.source,controls:new Map(input.source.controls)}};
  const manifest=JSON.parse(altered.source.controls.get(boundary.manifestPath));
  const entry=manifest.entries.find(item=>item.kind==='file');assert.ok(entry);
  entry.sha256=`sha256:${'f'.repeat(64)}`;
  altered.source.controls.set(boundary.manifestPath,Buffer.from(JSON.stringify(manifest)));
  await assert.rejects(prepareCurrentConversion(altered),err('EVIDENCE_INCOMPLETE'));
});

test('M08 NEEDS_FIX e APPLY reais conservam finding ativo; só PASS resolutivo admite S2',async t=>{
  const {afterNeedsFix,afterApply,final,last}=await nativeFindingCycle(t);
  for(const source of [afterNeedsFix,afterApply]) {
    assert.match(source.source.files.get('tasks/slice-01.md').toString('utf8'),/- State: active/u);
    const before=seals(source.source);
    await assert.rejects(prepareCurrentConversion(source),err('EVIDENCE_INCOMPLETE'));
    assert.deepEqual(seals(source.source),before);
  }
  assert.equal(JSON.parse(final.source.files.get('activation.json')).activeAttempt,null);
  assert.equal(JSON.parse(final.source.files.get('activation.json')).lastAttempt.operationAttemptId,
    last.admission.owner.operationAttemptId);
  const proposal=await prepareCurrentConversion(final);
  const review=reviewProposal(proposal,final);
  const candidate=await finalizeCurrentConversion({context:final.context,
    requirementsAuthority:final.requirementsAuthority,observedWork:final.observedWork,proposal,review});
  const state=JSON.parse(candidate.files.get('continuity.json')).deliveries[0];
  assert.deepEqual(state.counters,{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1});
  assert.equal(state.validation,'revalidation-required');
  assert.equal(state.evidence,null);
  assert.equal(candidate.inspection.deliveries[0].consumption.resumable,false);
});

test('M08 cadeia native fileless real só transporta S1 após PASS que resolve finding',async t=>{
  const {afterNeedsFix,afterApply,final,last}=await nativeFindingCycle(t,{fileless:true});
  for(const source of [afterNeedsFix,afterApply]) {
    assert.match(source.source.files.get('tasks/slice-01.md').toString('utf8'),/- State: active/u);
    await assert.rejects(prepareCurrentConversion(source),err('EVIDENCE_INCOMPLETE'));
  }
  assert.deepEqual(final.observedWork.entries,[{path:'src',kind:'directory',children:[]}]);
  assert.equal(JSON.parse(final.source.files.get('activation.json')).lastAttempt.operationAttemptId,
    last.admission.owner.operationAttemptId);
  const proposal=await prepareCurrentConversion(final);
  assert.equal(proposal.proposedDecisions[0].disposition,'retain-current');
  const review=reviewProposal(proposal,final);
  const candidate=await finalizeCurrentConversion({context:final.context,
    requirementsAuthority:final.requirementsAuthority,observedWork:final.observedWork,proposal,review});
  const state=JSON.parse(candidate.files.get('continuity.json')).deliveries[0];
  assert.deepEqual(state.counters,{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1});
  assert.equal(state.validation,'current');
  assert.ok(state.evidence);
  const understated=new Map(candidate.files),continuity=JSON.parse(understated.get('continuity.json'));
  continuity.deliveries[0].counters.findings=0;
  understated.set('continuity.json',Buffer.from(JSON.stringify(continuity)+'\n'));
  await assert.rejects(inspectConvertedExecution({context:final.context,requirementsAuthority:final.requirementsAuthority,
    files:understated,observedWork:final.observedWork}),error=>error?.code==='INVALID_CURRENT_IMAGE' && /record exceeds findings/u.test(error.message));
});

test('M08 PASS native terminal com advisory ativo permanece inelegível a S1',async t=>{
  const {final,last}=await nativeFindingCycle(t,{fileless:true,activeAdvisoryAfterPass:true});
  const task=final.source.files.get('tasks/slice-01.md').toString('utf8');
  assert.match(task,/## Final Result\n\n- PASS/u);
  assert.match(task,/### finding-02\n\n- Severity: advisory\n- State: active/u);
  assert.match(task,/### attempt-02[\s\S]*?- Finding dispositions: finding-01=resolved, finding-02=active/u);
  const activation=JSON.parse(final.source.files.get('activation.json'));
  assert.equal(activation.activeAttempt,null);
  assert.equal(activation.lastAttempt.operationAttemptId,last.admission.owner.operationAttemptId);
  assert.deepEqual(final.observedWork.entries,[{path:'src',kind:'directory',children:[]}]);
  const before=seals(final.source);
  await assert.rejects(prepareCurrentConversion(final),error=>error?.code==='EVIDENCE_INCOMPLETE'
    && /active Validation Findings/u.test(error.message));
  assert.deepEqual(seals(final.source),before);
});

test('M05 runner managed concluído com recusa malformada mantém owner ativo',async t=>{
  const produced=await managedMalformedOwnerActive(t);
  assert.equal(produced.produced.receipt.status,'RUNNER_RESULT_BLOCKED');
  const activation=JSON.parse(produced.input.source.files.get('activation.json'));
  assert.equal(activation.activeAttempt.operationAttemptId,produced.produced.context.owner.operationAttemptId);
  const before=seals(produced.input.source);
  await assert.rejects(prepareCurrentConversion(produced.input),err('OWNER_ACTIVE'));
  assert.deepEqual(seals(produced.input.source),before);
});

test('M09 review sela bytes finais e disposição antes da snapshot',async t=>{
  const {input,proposal,review,candidate}=await s0(t);
  const changed={...proposal,files:new Map(proposal.files)};
  changed.files.set('plan.md',Buffer.concat([changed.files.get('plan.md'),Buffer.from('\n')]));
  await assert.rejects(finalizeCurrentConversion({context:input.context,requirementsAuthority:input.requirementsAuthority,
    observedWork:input.observedWork,proposal:changed,review}),err('STALE_APPROVAL'));
  const wrong={...review,proposalSha256:`sha256:${'0'.repeat(64)}`};
  await assert.rejects(finalizeCurrentConversion({context:input.context,requirementsAuthority:input.requirementsAuthority,
    observedWork:input.observedWork,proposal,review:wrong}),err('STALE_APPROVAL'));
  for(const [name,bytes] of proposal.files) assert.deepEqual(candidate.files.get(name),bytes);
});

test('M09 disposição S1 alterada depois da revisão exige nova proposta e nova decisão',async t=>{
  const {input}=await nativeFilePass(t,{fileless:true});
  const proposal=await prepareCurrentConversion(input);
  assert.equal(proposal.proposedDecisions[0].disposition,'retain-current');
  const review=reviewProposal(proposal,input);
  const switched={...proposal,proposedDecisions:proposal.proposedDecisions.map(item=>
    ({...item,disposition:'revalidate'}))};
  await assert.rejects(finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,
    proposal:switched,review}),err('STALE_APPROVAL'));
  const bytes={...proposal,files:new Map(proposal.files)};
  bytes.files.set('continuity.json',Buffer.concat([bytes.files.get('continuity.json'),Buffer.from('\n')]));
  await assert.rejects(finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,
    proposal:bytes,review}),err('STALE_APPROVAL'));
});

test('M09 decisão de revisão não aprovada não sela candidata',async t=>{
  const {input,proposal,review}=await s0(t);
  const draft={...review,globalReview:{...review.globalReview,decision:'pending'}};
  await assert.rejects(finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,
    proposal,review:draft}));
});

test('M10 formato desconhecido e inputs exóticos recusam antes de compor candidata',async t=>{
  const {input}=await s0(t);
  await assert.rejects(prepareCurrentConversion({...input,source:{...input.source,format:'stnl-unknown-v9'}}),
    err('UNSUPPORTED_FORMAT'));
  const accessor={...input};Object.defineProperty(accessor,'context',{enumerable:true,get(){throw Error('getter invoked');}});
  await assert.rejects(prepareCurrentConversion(accessor),error=>error?.message!=='getter invoked');
  let calls=0;
  const source={...input.source};
  Object.defineProperty(source,'managedContexts',{enumerable:true,get(){calls+=1;return new Map();}});
  await assert.rejects(prepareCurrentConversion({...input,source}),err('INVALID_CURRENT_IMAGE'));
  assert.equal(calls,0,'nested source accessor must never execute');
  const sparse={...input,source:{...input.source,selectorHistory:new Array(1)}};
  await assert.rejects(prepareCurrentConversion(sparse),err('INVALID_CURRENT_IMAGE'));
});

test('M10 carrier managed recusa chave, owner e objeto de ambiente em vez de bytes',async t=>{
  const {input,produced}=await managedFilePass(t);
  const owner=produced.context.owner.operationAttemptId;
  const malformed={...input,source:{...input.source,managedContexts:new Map([[owner,{...produced.context}]])}};
  await assert.rejects(prepareCurrentConversion(malformed),err('INVALID_CURRENT_IMAGE'));
  const keyed={...input,source:{...input.source,managedContexts:new Map([
    ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',produced.contextBytes]])}};
  await assert.rejects(prepareCurrentConversion(keyed),err('EVIDENCE_INCOMPLETE'));
  const pathAlias={...input,source:{...input.source,imports:[{...input.source.imports[0],
    boundary:{...input.source.imports[0].boundary,originPath:path.join(input.context.productRoot,'context.json')}}]}};
  await assert.rejects(prepareCurrentConversion(pathAlias),err('INVALID_CURRENT_IMAGE'));
});

test('M10 captura v1 rejeita JSON duplicado e campos EC-1 sem os converter em defaults',async t=>{
  const {input}=await s0(t);
  const pristine=seals(input.source);
  const activation=input.source.files.get('activation.json').toString('utf8');
  const duplicate=corruptOfficial(input,'activation.json',Buffer.from(activation.replace(
    '"format":','"format":"stnl-execution-activation-v1","format":')));
  await assert.rejects(prepareCurrentConversion(duplicate),error=>
    error?.code==='INVALID_CURRENT_IMAGE' && /duplicate JSON key format/u.test(error.message));
  for(const field of ['normalization','recovery','completed']) {
    const continuity=JSON.parse(input.source.files.get('continuity.json'));
    continuity[field]=field==='completed'?[]:null;
    const mixed=corruptOfficial(input,'continuity.json',Buffer.from(JSON.stringify(continuity)+'\n'));
    await assert.rejects(prepareCurrentConversion(mixed),error=>
      error?.code==='INVALID_CURRENT_IMAGE' && /legacy continuity.*fields differ/u.test(error.message));
  }
  // This probes the private capture discriminator, not an official EC-1 tree.
  const wrongCapture={...input,source:{...input.source,format:'stnl-preparation-v3'}};
  await assert.rejects(prepareCurrentConversion(wrongCapture),error=>
    error?.code==='UNSUPPORTED_FORMAT' && /legacy capture format/u.test(error.message));
  assert.deepEqual(seals(input.source),pristine);
});

test('M10 recipe importada ausente e formatRepair managed tentado recusam capacidade',async t=>{
  const native=await nativeFilePass(t,{fileless:true});
  const entry=native.input.source.imports[0];
  const formal={...entry.validation,contract:{...entry.validation.contract}};
  delete formal.contract.recipe;
  const noRecipe={...native.input,source:{...native.input.source,imports:[{...entry,validation:formal}]}};
  await assert.rejects(prepareCurrentConversion(noRecipe),error=>
    ['INVALID_CURRENT_IMAGE','EVIDENCE_STALE'].includes(error?.code) && /recipe|canonical/u.test(error.message));
  const managed=await managedFilePass(t);
  const pristine=seals(managed.input.source);
  const boundary=managed.input.source.imports[0].boundary;
  const receipt=JSON.parse(managed.input.source.controls.get(boundary.receiptPath));
  receipt.formatRepair={attempted:true};
  const controls=new Map(managed.input.source.controls);
  controls.set(boundary.receiptPath,Buffer.from(JSON.stringify(receipt)+'\n'));
  const repaired={...managed.input,source:{...managed.input.source,controls}};
  await assert.rejects(prepareCurrentConversion(repaired),error=>
    error?.code==='EVIDENCE_INCOMPLETE' && /managed runner closure differs/u.test(error.message));
  assert.deepEqual(seals(managed.input.source),pristine);
});

test('M11 consumer em processo novo usa só candidata, autoridade e observação',async t=>{
  const result=await s0(t);
  const wire=consumerWire(result);
  assert.deepEqual(Object.keys(wire).sort(),['context','files','observedWork','requirementsAuthority']);
  const observed=await worker(result.f,'conversion:consume',proof,wire);
  assert.deepEqual(observed.attempts,[]);
  assert.equal(observed.result.error,undefined);
  assert.equal(observed.result.deliveries[0].counterAuthority,'persisted-continuity');
  assert.deepEqual(observed.result.admissibleOperations,[]);
});

test('M11 consumer novo S1/S2 usa somente candidata e não lê história externa',async t=>{
  for(const produced of [await nativeFilePass(t,{fileless:true}),await managedFilePass(t),
    await managedFilelessPass(t)]) {
    const input=produced.input,proposal=await prepareCurrentConversion(input);
    const review=reviewProposal(proposal,input);
    const candidate=await finalizeCurrentConversion({context:input.context,
      requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
    const wire=consumerWire({input,candidate});
    assert.deepEqual(Object.keys(wire).sort(),['context','files','observedWork','requirementsAuthority']);
    const result=await worker(produced.f,'conversion:consume',proof,wire);
    assert.deepEqual(result.attempts,[]);
    assert.equal(result.result.error,undefined);
    assert.deepEqual(result.result.deliveries[0].counters,
      {implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:0});
  }
});

test('M12 fronteira de conteúdo não fabrica activation oficial',async t=>{
  const {candidate,input}=await s0(t);
  assert.equal(validateCurrentCandidate({files:candidate.files}).snapshot.format,'stnl-preparation-v3');
  assert.throws(()=>validateCurrentImage({files:candidate.files}),err('INVALID_CURRENT_IMAGE'));
  const shadow=new Map(candidate.files);
  shadow.set('activation.json',input.source.files.get('activation.json'));
  assert.throws(()=>validateCurrentCandidate({files:shadow}),err('INVALID_CURRENT_IMAGE'));
  const semantic=new Map(candidate.files);
  semantic.set('plan.md',Buffer.from(semantic.get('plan.md').toString('utf8').replace(
    'Deliver a deterministic greeting.','Declare an unreviewed different result.')));
  assert.notDeepEqual(semantic.get('plan.md'),candidate.files.get('plan.md'));
  await assert.rejects(inspectConvertedExecution({context:input.context,
    requirementsAuthority:input.requirementsAuthority,files:semantic,
    observedWork:input.observedWork}));
});

test('M13 comparação com source detecta CAS e counter adulterados',async t=>{
  const {input,candidate,review}=await s0(t);
  const changed={...input,source:{...input.source,tree:{...input.source.tree,
    identity:{...input.source.tree.identity,ino:String(BigInt(input.source.tree.identity.ino)+1n)}}}};
  await assert.rejects(validateCurrentConversion({...changed,candidate,review}),err('STALE_APPROVAL'));
  const other={...candidate,files:new Map(candidate.files)};
  const continuity=JSON.parse(other.files.get('continuity.json'));
  continuity.deliveries[0].counters.implementationChecks=1;
  other.files.set('continuity.json',Buffer.from(JSON.stringify(continuity)+'\n'));
  await assert.rejects(validateCurrentConversion({...input,candidate:other,review}),
    error=>['STALE_APPROVAL','INVALID_CURRENT_IMAGE','EVIDENCE_INCOMPLETE'].includes(error?.code));
});

test('M13 record S1 impõe counter mínimo intrínseco; authority documental é CAS',async t=>{
  const {input}=await nativeFilePass(t,{fileless:true});
  const proposal=await prepareCurrentConversion(input),review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,proposal,review});
  const files=new Map(candidate.files),continuity=JSON.parse(files.get('continuity.json'));
  continuity.deliveries[0].counters.implementationChecks=0;
  files.set('continuity.json',Buffer.from(JSON.stringify(continuity)+'\n'));
  await assert.rejects(inspectConvertedExecution({context:input.context,
    requirementsAuthority:input.requirementsAuthority,files,observedWork:input.observedWork}),
    error=>['INVALID_CURRENT_IMAGE','EVIDENCE_INCOMPLETE'].includes(error?.code));
  const changed={...input,source:{...input.source,requirementsFiles:new Map(input.source.requirementsFiles)}};
  const name=[...changed.source.requirementsFiles.keys()][0];
  changed.source.requirementsFiles.set(name,Buffer.concat([changed.source.requirementsFiles.get(name),Buffer.from('\n')]));
  await assert.rejects(validateCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,source:changed.source,
    observedWork:input.observedWork,candidate,review}),err('STALE_APPROVAL'));
});

test('M14 BLOCKED managed terminal real não vira S2 sem finding',async t=>{
  const produced=await managedBlockedAfterNativeFile(t);
  const {input}=produced;
  const activation=JSON.parse(input.source.files.get('activation.json'));
  assert.equal(activation.activeAttempt,null);
  assert.equal(activation.lastAttempt.operationAttemptId,produced.produced.context.owner.operationAttemptId);
  const task=input.source.files.get('tasks/slice-01.md').toString('utf8');
  assert.match(task,/## Validation Findings\n\n- none/u);
  assert.match(task,/## Validation Attempts\n\n### attempt-01[\s\S]*?- Status: BLOCKED/u);
  const before=seals(input.source);
  await assert.rejects(prepareCurrentConversion(input),err('EVIDENCE_INCOMPLETE'));
  assert.deepEqual(seals(input.source),before);
});

test('M14 PASS managed exige active capturado, supervisor fechado e contexto vinculado',async t=>{
  const {input}=await managedFilePass(t);
  const boundary=input.source.imports[0].boundary;
  const remove=key=>{const controls=new Map(input.source.controls);controls.delete(boundary.closure[key]);
    return {...input,source:{...input.source,controls}};};
  for(const key of ['activePath','supervisorPath','eventsPath'])
    await assert.rejects(prepareCurrentConversion(remove(key)),err('EVIDENCE_INCOMPLETE'));
  const preclosed={...input,source:{...input.source,controls:new Map(input.source.controls)}};
  const summary=JSON.parse(preclosed.source.controls.get(boundary.closure.supervisorPath));
  summary.closedAt=null;
  preclosed.source.controls.set(boundary.closure.supervisorPath,Buffer.from(JSON.stringify(summary)));
  await assert.rejects(prepareCurrentConversion(preclosed),err('EVIDENCE_INCOMPLETE'));
  const wrongKey={...input,source:{...input.source,imports:[{...input.source.imports[0],
    boundary:{...boundary,managedContextId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}}]}};
  await assert.rejects(prepareCurrentConversion(wrongKey),err('EVIDENCE_INCOMPLETE'));
});

test('M14 S1 recusa objeto importado órfão e raw de cápsula ausente',async t=>{
  const {input}=await nativeFilePass(t,{fileless:true});
  const entry=input.source.imports[0];
  const orphan=Buffer.from(JSON.stringify({format:'stnl-unbound-bundle-v1'})+'\n');
  const objects=new Map(entry.objects);objects.set(sha(orphan),orphan);
  const changed={...input,source:{...input.source,imports:[{...entry,objects}]}};
  await assert.rejects(prepareCurrentConversion(changed),
    error=>['INVALID_CURRENT_IMAGE','EVIDENCE_INCOMPLETE'].includes(error?.code));
  const missing=new Map(entry.objects);
  missing.delete(entry.validation.sources.origin);
  const absent={...input,source:{...input.source,imports:[{...entry,objects:missing}]}};
  await assert.rejects(prepareCurrentConversion(absent),
    error=>['INVALID_CURRENT_IMAGE','EVIDENCE_INCOMPLETE'].includes(error?.code));
});

test('M15 entrada pura rejeita getter e fonte transplantada',async t=>{
  const first=await s0(t);
  const second=await s0(t);
  const transplant={...first.input,source:second.input.source};
  await assert.rejects(prepareCurrentConversion(transplant),
    error=>['STALE_APPROVAL','EVIDENCE_INCOMPLETE','INVALID_CURRENT_IMAGE'].includes(error?.code));
  const files=new Map(first.candidate.files);
  const examined=await inspectConvertedExecution({context:first.input.context,
    requirementsAuthority:first.input.requirementsAuthority,files,observedWork:first.input.observedWork});
  assert.deepEqual(examined.admissibleOperations,[]);
});

test('M15 consumer S0 dispensa parser legado; consumer S1 e conversor exigem siblings locais',async t=>{
  const s0Result=await s0(t);
  const native=await nativeFilePass(t,{fileless:true});
  const proposal=await prepareCurrentConversion(native.input);
  const review=reviewProposal(proposal,native.input);
  const s1=await finalizeCurrentConversion({context:native.input.context,
    requirementsAuthority:native.input.requirementsAuthority,observedWork:native.input.observedWork,
    proposal,review});
  const runtime=path.join(repo,'skills/workflows/stnl-execution-planner/runtime');
  const oldTree=path.join(s0Result.f.root,'isolated-current');
  const newTree=path.join(s0Result.f.root,'isolated-conversion');
  await fs.mkdir(oldTree);
  for(const name of ['execution-current.mjs','execution-evidence-proof.mjs','execution-preparation-current.mjs'])
    await fs.copyFile(path.join(runtime,name),path.join(oldTree,name));
  assert.equal((await fs.readdir(oldTree)).includes('execution-preparation.mjs'),false);
  assert.equal((await fs.readdir(oldTree)).includes('execution-conversion-current.mjs'),false);
  const oldProof=await import(pathToFileURL(path.join(oldTree,'execution-evidence-proof.mjs')).href);
  const oldS0=await oldProof.inspectConvertedExecution({context:s0Result.input.context,
    requirementsAuthority:s0Result.input.requirementsAuthority,files:s0Result.candidate.files,
    observedWork:s0Result.input.observedWork});
  assert.equal(oldS0.deliveries[0].persistedValidation,'unvalidated');
  assert.equal(oldS0.deliveries[0].observedValidation,'unvalidated');
  await assert.rejects(oldProof.inspectConvertedExecution({context:native.input.context,
    requirementsAuthority:native.input.requirementsAuthority,files:s1.files,
    observedWork:native.input.observedWork}),error=>
      error?.code==='ERR_MODULE_NOT_FOUND' && /execution-preparation\.mjs/u.test(error.message));
  await fs.cp(runtime,newTree,{recursive:true});
  await fs.rm(path.join(newTree,'execution-preparation-current.mjs'));
  await assert.rejects(import(pathToFileURL(path.join(newTree,'execution-conversion-current.mjs')).href),error=>
    error?.code==='ERR_MODULE_NOT_FOUND' && /execution-preparation-current\.mjs/u.test(error.message));
  for(const name of ['execution-current.mjs','execution-preparation-current.mjs','execution-evidence-proof.mjs']) {
    const source=await fs.readFile(path.join(runtime,name),'utf8');
    assert.doesNotMatch(source,/from ['"]\.\/execution-conversion-current\.mjs['"]/u,
      `${name}: current import graph must not acquire conversion`);
  }
});

test('M16 guarda existente registra tentativa capturada e positivo sem I/O histórico',async t=>{
  const result=await s0(t);
  const sourceBefore=seals(result.input.source);
  const workBefore=await observeWork(result.f.root);
  const caught=await worker(result.f,'conversion:canary-caught',proof,consumerWire(result));
  assert.equal(caught.result.caught,true);
  for(const target of [result.input.context.logicalAuthorityPath,result.f.execution,
    ...['approved-preparation.json','activation.json','continuity.json','tasks/slice-01.md']
      .map(name=>path.join(result.f.execution,name)),path.join(result.f.root,'src'),
    path.join(result.f.root,'tmp/historic/receipt.json')])
    for(const method of ['promises.readFile','promises.lstat','fs.statSync'])
      assert.ok(caught.attempts.some(item=>item.path===target && item.method===method),
        `${method} must deny legacy data/metadata: ${target}`);
  const prepared=await worker(result.f,'conversion:prepare',converter,prepareWire(result));
  assert.deepEqual(prepared.attempts,[]);
  assert.equal(prepared.result.phase,'reviewable');
  const positive=await worker(result.f,'conversion:consume',proof,consumerWire(result));
  assert.deepEqual(positive.attempts,[]);
  assert.equal(positive.result.deliveries[0].persistedValidation,'unvalidated');
  assert.deepEqual(seals(result.input.source),sourceBefore);
  assert.deepEqual(await observeWork(result.f.root),workBefore);
});


test('M17 domínios por delivery preservam raízes aninhadas e isolam deriva; input compartilhado afeta ambas',async t=>{
  const {f,input}=await disjointDomainS0(t);
  assert.deepEqual(input.observedWork.entries.map(item=>item.path),['shared/config.json','src/first','src/second']);
  const proposal=await prepareCurrentConversion(input),review=reviewProposal(proposal,input);
  const candidate=await finalizeCurrentConversion({context:input.context,requirementsAuthority:input.requirementsAuthority,
    observedWork:input.observedWork,proposal,review});
  const states=JSON.parse(candidate.files.get('continuity.json')).deliveries;
  assert.deepEqual(states.map(item=>item.baseline.entries.map(entry=>entry.path)),
    [['shared/config.json','src/first'],['shared/config.json','src/second']]);
  await fs.writeFile(path.join(f.root,'src/first/new.mjs'),'export const value=1;\n');
  let observedWork=await observeWork(f.root,f.observedRoots);
  const inspected=await inspectConvertedExecution({context:input.context,requirementsAuthority:input.requirementsAuthority,files:candidate.files,observedWork});
  assert.deepEqual(inspected.deliveries.map(item=>item.observationMatches),[false,true]);
  assert.deepEqual(inspected.deliveries.map(item=>item.requiresFormalRevalidation),[true,false]);
  await fs.writeFile(path.join(f.root,'shared/config.json'),'{} \n');
  observedWork=await observeWork(f.root,f.observedRoots);
  const shared=await inspectConvertedExecution({context:input.context,requirementsAuthority:input.requirementsAuthority,files:candidate.files,observedWork});
  assert.deepEqual(shared.deliveries.map(item=>item.observationMatches),[false,false]);
  for(const missing of ['src/first','shared/config.json']) {
    const omitted={...input.observedWork,entries:input.observedWork.entries.filter(item=>item.path!==missing)};
    await assert.rejects(prepareCurrentConversion({...input,observedWork:omitted}),error=>
      error?.code==='EVIDENCE_INCOMPLETE' && /missing declared/u.test(error.message));
    await assert.rejects(inspectConvertedExecution({context:input.context,requirementsAuthority:input.requirementsAuthority,
      files:candidate.files,observedWork:omitted}),error=>error?.code==='EVIDENCE_INCOMPLETE' && /missing declared/u.test(error.message));
  }
  const alien={...input.observedWork,entries:[{path:'alien',kind:'directory',children:[]},...input.observedWork.entries]};
  await assert.rejects(prepareCurrentConversion({...input,observedWork:alien}),error=>
    error?.code==='EVIDENCE_INCOMPLETE' && /unexpected domain member/u.test(error.message));
});

test('M18 native/managed reais preservam a forma directory do lifecycle em S1/S2',async t=>{
  const proofModules=['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor',
    'stnl-slice-quality-manager'].map(skill=>path.join(repo,'skills/workflows',skill,'runtime/execution-evidence-proof.mjs'));
  const proofBytes=await fs.readFile(proofModules[0]);
  for(const modulePath of proofModules.slice(1))
    assert.deepEqual(await fs.readFile(modulePath),proofBytes,`${modulePath}: distributed proof differs`);
  const producedCases=[await nativeFilePass(t,{fileless:true,form:'lifecycle-directory'}),
    await managedFilelessPass(t,{form:'lifecycle-directory'}),await managedFilePass(t,{form:'lifecycle-directory'})];
  for(const [index,produced] of producedCases.entries()) {
    const {input}=produced;
    assert.ok(input.context.logicalSpecRoot);
    assert.notEqual(input.context.logicalSpecRoot,input.context.logicalAuthorityPath);
    const proposal=await prepareCurrentConversion(input),review=reviewProposal(proposal,input);
    const candidate=await finalizeCurrentConversion({context:input.context,requirementsAuthority:input.requirementsAuthority,
      observedWork:input.observedWork,proposal,review});
    assert.equal(candidate.inspection.deliveries[0].consumption.resumable,false);
    assert.equal(candidate.inspection.deliveries[0].observedValidation,index<2?'current':'revalidation-required');
    const before=seals({files:candidate.files});
    for(const modulePath of proofModules) {
      const consumer=await import(pathToFileURL(modulePath).href);
      const inspected=await consumer.inspectConvertedExecution({context:input.context,
        requirementsAuthority:input.requirementsAuthority,files:candidate.files,observedWork:input.observedWork});
      assert.deepEqual(inspected,candidate.inspection,`${modulePath}: lifecycle candidate consumption differs`);
    }
    assert.deepEqual(seals({files:candidate.files}),before,'consumers preserve candidate bytes');
  }
});

// Corrupt a real S2 capture while retaining the outer source and complete raw
// set. Each assertion targets the newly shared relation, not a missing blob.
test('M19 S2 confere claim, request, stdout e vínculo terminal da Task',async t=>{
  const {input}=await nativeFilePass(t),boundary=input.source.imports[0].boundary;
  const mutation=(apply)=>{const controls=new Map(input.source.controls);apply(controls);return {...input,source:{...input.source,controls}};};
  const write=(controls,name,doc)=>controls.set(name,Buffer.from(JSON.stringify(doc)+'\n'));
  const foreignOrigin=mutation(controls=>{
    const agent=JSON.parse(controls.get(boundary.closure.agentPath));agent.originFile+='.foreign';write(controls,boundary.closure.agentPath,agent);
  });
  await assert.rejects(prepareCurrentConversion(foreignOrigin),error=>error?.code==='OWNER_MISMATCH' && /origin\/dispatch\/claim/u.test(error.message));
  for(const mutate of [doc=>{doc.checks[0].request={...doc.checks[0].request,args:['--different']};},
    doc=>{doc.checks[0].stdout+='tampered output';}]) {
    const altered=mutation(controls=>{
      const observation=JSON.parse(controls.get(boundary.observationPath));mutate(observation);write(controls,boundary.observationPath,observation);
      const receipt=JSON.parse(controls.get(boundary.receiptPath));receipt.verification=observation;write(controls,boundary.receiptPath,receipt);
    });
    await assert.rejects(prepareCurrentConversion(altered),error=>error?.code==='EVIDENCE_INCOMPLETE' && /legacy check differs/u.test(error.message));
  }
  const unbound=mutation(controls=>{
    const publication=JSON.parse(controls.get(boundary.publicationPath));
    publication.expectedInstalledActivation.artifacts.find(item=>item.path==='tasks/slice-01.md').sha256=`sha256:${'0'.repeat(64)}`;
    publication.confirmation.artifactManifestSha256=sha(Buffer.from(JSON.stringify(publication.expectedInstalledActivation.artifacts)));
    write(controls,boundary.publicationPath,publication);
  });
  await assert.rejects(prepareCurrentConversion(unbound),error=>error?.code==='EVIDENCE_INCOMPLETE' && /does not bind source Task/u.test(error.message));
});

test('M20 apagar finding ou duplicar declaração não encerra a história',async t=>{
  const {final}=await nativeFindingCycle(t,{fileless:true,activeAdvisoryAfterPass:true});
  const original=final.source.files.get('tasks/slice-01.md').toString('utf8');
  const heading='## Validation Findings\n\n',start=original.indexOf(heading)+heading.length,end=original.indexOf('\n## ',start);
  const erased=Buffer.from(original.slice(0,start)+'- none\n'+original.slice(end));
  await assert.rejects(prepareCurrentConversion(corruptOfficial(final,'tasks/slice-01.md',erased)),error=>
    error?.code==='EVIDENCE_INCOMPLETE' && /finding timeline or declaration/u.test(error.message));
  const resolved=await nativeFindingCycle(t,{fileless:true});
  const text=resolved.final.source.files.get('tasks/slice-01.md').toString('utf8');
  const at=text.indexOf(heading)+heading.length,until=text.indexOf('\n## ',at),declaration=text.slice(at,until).trim();
  const duplicated=Buffer.from(text.slice(0,at)+declaration+'\n\n'+declaration+'\n'+text.slice(until));
  await assert.rejects(prepareCurrentConversion(corruptOfficial(resolved.final,'tasks/slice-01.md',duplicated)),error=>
    error?.code==='EVIDENCE_INCOMPLETE' && /duplicate declaration/u.test(error.message));
});


test('M21 consumer S1 reconcilia checks e latest a partir dos raws sem fonte externa',async t=>{
  for(const produced of [await nativeFilePass(t,{fileless:true}),await managedFilelessPass(t)]) {
    const {input}=produced,entry=input.source.imports[0],record=entry.validation;
    const proposal=await prepareCurrentConversion(input),review=reviewProposal(proposal,input);
    const candidate=await finalizeCurrentConversion({context:input.context,requirementsAuthority:input.requirementsAuthority,
      observedWork:input.observedWork,proposal,review});
    const snapshot=JSON.parse(candidate.files.get('approved-preparation.json'));
    const approvedAuthority={snapshot,delivery:snapshot.normativeProjection.deliveries[0]};
    const objects=new Map(entry.objects),altered=structuredClone(record);
    const observation=JSON.parse(objects.get(record.sources.verificationObservation));
    observation.checks[0].stdout+='changed output';
    const put=value=>{const bytes=Buffer.from(JSON.stringify(value)+'\n'),id=sha(bytes);objects.set(id,bytes);return id;};
    altered.sources.verificationObservation=put(observation);
    const receipt=JSON.parse(objects.get(record.sources.receipt));receipt.verification=observation;
    altered.sources.receipt=put(receipt);
    if(record.sources.transport==='managed') {
      const capsule=JSON.parse(objects.get(record.sources.closedSupervisor));
      const latest=JSON.parse(capsule.latestUtf8);latest.receipt=receipt;
      capsule.latestUtf8=JSON.stringify(latest)+'\n';altered.sources.closedSupervisor=put(capsule);
    }
    await assert.rejects(verifyImportedEvidence({context:input.context,record:altered,objects,approvedAuthority,observedWork:input.observedWork}),
      error=>error?.code==='EVIDENCE_INCOMPLETE' && /legacy check differs/u.test(error.message));
  }
});


test('M22 ausência transitiva real no v1 conserva bytes e projeta S1 canônico; S2 prova a mesma fronteira',async t=>{
  const produced=await nativeAbsentForecast(t),{input,boundaryInput}=produced;
  const boundary=boundaryInput.source.imports[0].boundary;
  const manifestBytes=boundaryInput.source.controls.get(boundary.manifestPath),manifest=JSON.parse(manifestBytes);
  assert.deepEqual(manifest.entries.map(({path,kind})=>({path,kind})),
    [{path:'src',kind:'absent'},{path:'src/optional.mjs',kind:'absent'}]);
  assert.deepEqual(input.source.imports[0].validation.testedWork.entries,[{path:'src',kind:'absent'}]);
  assert.deepEqual(input.observedWork.entries,[{path:'src',kind:'absent'}]);
  for(const selected of [input,boundaryInput]) {
    const proposal=await prepareCurrentConversion(selected),review=reviewProposal(proposal,selected);
    const candidate=await finalizeCurrentConversion({context:selected.context,requirementsAuthority:selected.requirementsAuthority,
      observedWork:selected.observedWork,proposal,review});
    assert.equal(candidate.inspection.deliveries[0].persistedValidation,selected===input?'current':'revalidation-required');
  }
  assert.deepEqual(boundaryInput.source.controls.get(boundary.manifestPath),manifestBytes);
  const controls=new Map(boundaryInput.source.controls),contradiction=structuredClone(manifest);
  contradiction.entries[1].kind='directory';
  const bytes=Buffer.from(JSON.stringify(contradiction)+'\n');controls.set(boundary.manifestPath,bytes);
  const publication=JSON.parse(controls.get(boundary.publicationPath));
  publication.retention.retainedPaths.find(item=>item.path===boundary.manifestPath).sha256=sha(bytes);
  controls.set(boundary.publicationPath,Buffer.from(JSON.stringify(publication)+'\n'));
  const observation=JSON.parse(controls.get(boundary.observationPath));
  observation.workStateSha256=sha(Buffer.from(JSON.stringify(contradiction.entries.map(({path,kind,sha256})=>({path,kind,sha256})))));
  controls.set(boundary.observationPath,Buffer.from(JSON.stringify(observation)+'\n'));
  const receipt=JSON.parse(controls.get(boundary.receiptPath));receipt.verification=observation;
  controls.set(boundary.receiptPath,Buffer.from(JSON.stringify(receipt)+'\n'));
  await assert.rejects(prepareCurrentConversion({...boundaryInput,source:{...boundaryInput.source,controls}}),error=>
    error?.code==='EVIDENCE_INCOMPLETE' && /missing parent\/child closure/u.test(error.message));
});

test('M23 roots sobrepostas conservam ausência comprovada por delivery sem deriva por representação',async t=>{
  for(const absentParent of [false,true]) {
    const produced=await disjointDomainS0(t,{roots:['src','src/nested']}),{f}=produced;
    await fs.rmdir(path.join(f.root,'src/nested'));
    if(absentParent) await fs.rmdir(path.join(f.root,'src'));
    const observedWork=await observeWork(f.root,f.observedRoots),input={...produced.input,observedWork};
    const sourceBefore=seals(input.source);
    assert.deepEqual(observedWork.entries.filter(item=>item.path.startsWith('src')),
      [absentParent?{path:'src',kind:'absent'}:{path:'src',kind:'directory',children:[]},
        {path:'src/nested',kind:'absent'}]);
    const proposal=await prepareCurrentConversion(input),review=reviewProposal(proposal,input);
    const candidate=await finalizeCurrentConversion({context:input.context,requirementsAuthority:input.requirementsAuthority,
      observedWork,proposal,review});
    const states=JSON.parse(candidate.files.get('continuity.json')).deliveries;
    assert.deepEqual(states.map(item=>item.baseline.entries.filter(entry=>entry.path.startsWith('src'))),
      [[observedWork.entries.find(item=>item.path==='src')],[{path:'src/nested',kind:'absent'}]]);
    const minimal={...observedWork,entries:observedWork.entries.filter(item=>item.path!=='src/nested')};
    for(const observed of [observedWork,minimal]) {
      const result=await inspectConvertedExecution({context:input.context,requirementsAuthority:input.requirementsAuthority,
        files:candidate.files,observedWork:observed});
      assert.deepEqual(result.deliveries.map(item=>item.observationMatches),[true,true]);
      assert.deepEqual(result.deliveries.map(item=>item.requiresFormalRevalidation),[false,false]);
    }
    const contradictory={...observedWork,entries:observedWork.entries.map(item=>item.path==='src/nested'
      ?{path:item.path,kind:'directory',children:[]}:item)};
    await assert.rejects(prepareCurrentConversion({...input,observedWork:contradictory}),error=>
      error?.code==='EVIDENCE_INCOMPLETE' && /missing parent\/child closure/u.test(error.message));
    assert.deepEqual(seals(input.source),sourceBefore);
  }
});
