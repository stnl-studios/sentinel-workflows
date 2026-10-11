import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture,approveFixture,reviewDecision,verificationBody} from './test-p1b-preparation.mjs';
import {implementedFixture,formal,native,evidence,setSection} from './test-p1b-continuity.mjs';
import {resolveExecutionWorkspace,inspectExecutionState,readExecutionActivation,beginPreparedExecutionOperation,resumeOwnedExecutionOperation,readDeliveryContinuity,readContinuationWorkCapture} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {classifyOwnedAllocation,cleanupOwnedExecutionAllocation,captureExecutionTree,parseStrictJson} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {prepareExecutionCopy,publishExecutionCopy} from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {publishPreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {readPreparationArtifacts,updateOperationalChecklist} from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import {renderOfflineArtifacts} from './fixtures/offline-workflow-artifacts.mjs';
import {READY_FIXTURE} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
export async function ancestorFixture() {
  const rootPath=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-u2-ancestor-')));
  await fs.mkdir(path.join(rootPath,'.git'));await fs.mkdir(path.join(rootPath,'specs'));
  const specPath=path.join(rootPath,'specs/item');await fs.cp(READY_FIXTURE,specPath,{recursive:true});
  const workspace=await resolveExecutionWorkspace(specPath);
  await fs.writeFile(path.join(rootPath,'specs/product.mjs'),'export const baseline="preexisting dirt";\n');
  await fs.writeFile(path.join(rootPath,'.gitignore'),'specs/ignored-product.mjs\n');
  await fs.writeFile(path.join(rootPath,'specs/ignored-product.mjs'),'ignored product before admission\n');
  await fs.writeFile(path.join(rootPath,'specs/.stnl-execution-backup-product.mjs'),'legitimate unowned product\n');
  const prepared=await preparePreparationCandidate({specPath,operation:'PLAN'});
  await renderOfflineArtifacts({snapshot:root,workspace:rootPath,specPath,candidateExecutionRoot:prepared.candidateExecutionRoot,targetPaths:['specs/product.mjs']});
  for(const file of ['plan.md','plans/slice-01.md','tasks/slice-01.md']) {
    const target=path.join(prepared.candidateExecutionRoot,file);let text=await fs.readFile(target,'utf8');
    if(file==='plan.md') text=text.replace(/file: `[^`]+`/u,'directory: `specs`');
    else {text=setSection(text,'Authorized Areas','- directory: `specs`');text=setSection(text,'Verification Recipe',verificationBody({file:'specs/greeting.test.mjs'}));}
    await fs.writeFile(target,text);
  }
  const f={root:rootPath,specPath,workspace,candidate:prepared.candidateExecutionRoot};
  await publishPreparationCandidate({specPath,candidateExecutionRoot:f.candidate});
  const review=await preparePreparationCandidate({specPath,operation:'REVIEW_PLAN'});
  for(const [file,text] of await readPreparationArtifacts(review.candidateExecutionRoot)) await fs.writeFile(path.join(review.candidateExecutionRoot,file),text.replace('status: draft','status: ready').replace('Review state: pending','Review state: approved'));
  await publishPreparationCandidate({specPath,candidateExecutionRoot:review.candidateExecutionRoot,reviewDecision:{...reviewDecision,summary:'Offline semantic fixture explicitly approves ancestral specs product scope with a nested lifecycle SPEC; authority files remain controlled by the resolver. No LLM review is claimed.'}});
  return f;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
test('U2-A05 ancestor capture excludes verified controls and preserves unrecorded ignored/prefixed product',async()=>{
  const f=await ancestorFixture();const approved=await readExecutionActivation(f.specPath);
  const index=await readDeliveryContinuity(f.workspace);const delivery=index.deliveries[0];
  const baselineRef={path:path.resolve(f.workspace.executionRoot,delivery.baseline.manifestRef.path),sha256:delivery.baseline.manifestRef.sha256};
  const baseline=await readContinuationWorkCapture(f.workspace,baselineRef,delivery);
  assert.ok(baseline.entries.some(e=>e.path==='specs/ignored-product.mjs'));assert.ok(baseline.entries.some(e=>e.path==='specs/.stnl-execution-backup-product.mjs'));
  assert.ok(!baseline.entries.some(e=>e.path.includes('/execution/') || e.path.endsWith('/feature_spec.md')));
  assert.equal((await inspectExecutionState(f.specPath)).state,'MATERIALIZED_PRISTINE');
  const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
  await updateOperationalChecklist({candidateExecutionRoot:copy.candidateExecutionRoot,slice:'slice-01',reason:'Use the already approved product scope and proof',checklist:'- [ ] 1.1 Inspect the product and prepared proof | obligations: obligation-01'});
  await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:copy.candidateRoot,terminal:false});
  const clean=await resumeOwnedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',admitted.owner);assert.deepEqual(clean.changedPaths,[]);
  await fs.writeFile(path.join(f.root,'specs/product.mjs'),'export const baseline="unrecorded implementation";\n');
  await fs.unlink(path.join(f.root,'specs/ignored-product.mjs'));await fs.writeFile(path.join(f.root,'specs/.stnl-new-product.mjs'),'new legitimate product\n');
  const resumed=await resumeOwnedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',admitted.owner);
  assert.equal(resumed.owner.operationAttemptId,admitted.owner.operationAttemptId);assert.ok(resumed.changedPaths.includes('specs/product.mjs'));assert.ok(resumed.changedPaths.includes('specs/ignored-product.mjs'));
  assert.ok(resumed.changedPaths.includes('specs/.stnl-new-product.mjs'));assert.ok(resumed.preservedWork);assert.equal(resumed.runner,null);
  const preserved=JSON.parse(await fs.readFile(resumed.preservedWork.path,'utf8'));const product=preserved.entries.find(e=>e.path==='specs/product.mjs');
  assert.equal(await fs.readFile(product.storedPath,'utf8'),await fs.readFile(path.join(f.root,'specs/product.mjs'),'utf8'));assert.equal(preserved.entries.find(e=>e.path==='specs/ignored-product.mjs').kind,'absent');
  assert.ok(!preserved.entries.some(e=>e.path.includes('.stnl-execution-backup-') && e.path!=='specs/.stnl-execution-backup-product.mjs'));
  await assert.rejects(beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',(await readExecutionActivation(f.specPath)).activation.activationId),/active|owns/);
  await evidence(f,'A05',{baselineEntries:baseline.entries.map(e=>e.path),clean,resumed});
});

test('U2-A06 resume preserves the pending runner and never reserves a second native invocation',async()=>{
  const f=await fixture();const approved=await approveFixture(f);const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const start=await native(f,admitted.owner);const current=await readExecutionActivation(f.specPath);
  const resumed=await resumeOwnedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',admitted.owner);
  assert.equal(resumed.owner.operationAttemptId,admitted.owner.operationAttemptId);assert.deepEqual(resumed.runner,current.activation.activeAttempt.runner);
  const {startNativeRunnerCapture}=await import('../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs');
  await assert.rejects(startNativeRunnerCapture({specPath:f.specPath,owner:admitted.owner,workspace:f.root,captureParent:f.root}),/ENOENT|receipt|dispatch|round/);
  await assert.rejects(resumeOwnedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',{...admitted.owner,ownershipToken:'foreign'}),/owner|differs/);
  assert.equal(f.invocations,1);assert.equal((await readExecutionActivation(f.specPath)).activation.activationId,current.activation.activationId);
  await evidence(f,'A06',{start,resumed});
});

test('U2-A09 owned producer candidates and retained publication are never official SPEC roots',async()=>{
  const f=await fixture();const approved=await approveFixture(f);const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
  const active=await classifyOwnedAllocation({workspace:f.workspace,marker:`${copy.candidateRoot}.copy.json`,activation:(await readExecutionActivation(f.specPath)).activation});assert.equal(active.classification,'active');
  await fs.writeFile(path.join(copy.candidateRoot,'feature_spec.md'),'looks like a SPEC but belongs to an operational copy\n');
  await assert.rejects(resolveExecutionWorkspace(copy.candidateRoot),/operational|official/);
  const sibling=path.join(f.root,'.stnl-legitimate-spec');await fs.mkdir(sibling);await fs.copyFile(f.specPath,path.join(sibling,'feature_spec.md'));
  assert.equal((await resolveExecutionWorkspace(sibling)).authorityPath,path.join(sibling,'feature_spec.md'));
  const official=await resolveExecutionWorkspace(f.specPath);assert.equal(official.executionRoot,f.workspace.executionRoot);
  const officialClass=await classifyOwnedAllocation({workspace:f.workspace,readActivated:()=>readExecutionActivation(f.specPath)});assert.equal(officialClass.classification,'official');
  const separate=await implementedFixture();
  const markerFile=`${separate.implementation.copy.candidateRoot}.copy.json`;
  const disposable=await classifyOwnedAllocation({workspace:separate.workspace,marker:markerFile,activation:(await readExecutionActivation(separate.specPath)).activation});assert.equal(disposable.classification,'disposable');
  const beforeImage=(await readExecutionActivation(separate.specPath)).activation;const productBefore=await fs.readFile(path.join(separate.root,'src/unpredicted.mjs'));
  const cleaned=await cleanupOwnedExecutionAllocation({workspace:separate.workspace,marker:markerFile,readActivated:()=>readExecutionActivation(separate.specPath)});
  assert.equal(cleaned.cleanup,'complete');await assert.rejects(fs.stat(separate.implementation.copy.candidateRoot),{code:'ENOENT'});
  assert.deepEqual((await readExecutionActivation(separate.specPath)).activation,beforeImage);assert.deepEqual(await fs.readFile(path.join(separate.root,'src/unpredicted.mjs')),productBefore);assert.equal(separate.invocations,1);
  assert.ok(await fs.stat(separate.publication.retainedBackup));
  const retained=await classifyOwnedAllocation({workspace:separate.workspace,marker:separate.publication.allocation,activation:beforeImage});assert.equal(retained.classification,'diagnostic');
  await evidence(separate,'A09-disposal',{disposable:disposable.classification,retained:retained.classification,cleaned,beforeImage});
  const lookalike=path.join(f.root,'legitimate-marker-sibling');await fs.mkdir(lookalike);await fs.writeFile(path.join(lookalike,'feature_spec.md'),'# Legitimate sibling authority\n');
  await fs.writeFile(`${lookalike}.owner.json`,JSON.stringify({executionRoot:f.workspace.executionRoot,candidate:lookalike}));
  assert.equal((await resolveExecutionWorkspace(lookalike)).specRoot,lookalike,'Unproven marker cannot deny a legitimate SPEC');
  await evidence(f,'A09',{active:active.classification,official,sibling,retainedCandidate:copy.candidateRoot});
});

test('U2-A10 confirmed publication persists pending cleanup, and cleanup-only keeps image and IDs',async()=>{
  const f=await fixture();const approved=await approveFixture(f);const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const {implementOffline}=await import('./test-p1b-publication.mjs');const implementation=await implementOffline(f,admitted);f.invocations=1;
  const result=await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot,
    checkpoint:async phase=>{if(phase==='cleanup')throw new Error('U2 cleanup-only fault');}});
  assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'pending');
  const marker=JSON.parse(await fs.readFile(result.allocation,'utf8'));assert.equal(marker.confirmation.activationId,result.expectedActivationId);assert.equal(marker.cleanup.status,'pending');
  const current=await readExecutionActivation(f.specPath);assert.equal(current.activation.activeAttempt,null);
  const cleaned=await cleanupOwnedExecutionAllocation({workspace:f.workspace,marker:result.allocation,readActivated:()=>readExecutionActivation(f.specPath)});
  assert.equal(cleaned.cleanup,'complete');assert.deepEqual((await readExecutionActivation(f.specPath)).activation,current.activation);
  assert.ok(await fs.stat(result.retainedBackup));assert.ok(await fs.stat(implementation.copy.candidateRoot));assert.equal(f.invocations,1);
  const copyMarker=`${implementation.copy.candidateRoot}.copy.json`;
  await fs.writeFile(path.join(implementation.copy.candidateRoot,'unknown-product.mjs'),'foreign material must survive');
  await assert.rejects(cleanupOwnedExecutionAllocation({workspace:f.workspace,marker:copyMarker,readActivated:()=>readExecutionActivation(f.specPath)}),/disposable|changed/);
  assert.equal(await fs.readFile(path.join(implementation.copy.candidateRoot,'unknown-product.mjs'),'utf8'),'foreign material must survive');
  const acknowledgment=await implementedFixture();
  // Simulate the finite acknowledgment being lost after verified installation.
  const allocation=JSON.parse(await fs.readFile(acknowledgment.publication.allocation,'utf8'));delete allocation.confirmation;delete allocation.cleanup;
  await fs.writeFile(acknowledgment.publication.allocation,JSON.stringify(allocation));
  const exact=(await readExecutionActivation(acknowledgment.specPath)).activation;
  const recognized=await cleanupOwnedExecutionAllocation({workspace:acknowledgment.workspace,marker:acknowledgment.publication.allocation,readActivated:()=>readExecutionActivation(acknowledgment.specPath)});
  assert.equal(recognized.publication,'confirmed');assert.deepEqual((await readExecutionActivation(acknowledgment.specPath)).activation,exact);assert.equal(acknowledgment.invocations,1);
  await evidence(acknowledgment,'A10-acknowledgment',{recognized,exact});
  const failedAck=await implementedFixture();const ackMarker=`${failedAck.implementation.copy.candidateRoot}.copy.json`;
  const ackImage=(await readExecutionActivation(failedAck.specPath)).activation;
  const pending=await cleanupOwnedExecutionAllocation({workspace:failedAck.workspace,marker:ackMarker,readActivated:()=>readExecutionActivation(failedAck.specPath),checkpoint:async phase=>{if(phase==='before-cleanup-acknowledgment')throw new Error('Injected cleanup acknowledgment I/O fault');}});
  assert.equal(pending.publication,'confirmed');assert.equal(pending.cleanup,'pending');
  await assert.rejects(fs.stat(failedAck.implementation.copy.candidateRoot),{code:'ENOENT'});
  assert.equal(JSON.parse(await fs.readFile(ackMarker,'utf8')).cleanup.status,'pending');
  const retry=await cleanupOwnedExecutionAllocation({workspace:failedAck.workspace,marker:ackMarker,readActivated:()=>readExecutionActivation(failedAck.specPath)});assert.equal(retry.cleanup,'complete');
  assert.deepEqual((await readExecutionActivation(failedAck.specPath)).activation,ackImage);assert.equal(failedAck.invocations,1);
  await evidence(failedAck,'A10-cleanup-acknowledgment',{pending,retry,ackImage});
  await evidence(f,'A10',{result,cleaned,confirmation:marker.confirmation});
});

test('U2-A11 separate publishers in ancestor scope have one CAS winner and preserve loser/product bytes',async()=>{
  const f=await ancestorFixture();const approved=await readExecutionActivation(f.specPath);const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const copies=[];
  for(let n=0;n<2;n++) {
    const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});copies.push(copy);
    await updateOperationalChecklist({candidateExecutionRoot:copy.candidateExecutionRoot,slice:'slice-01',reason:'Approved technical checklist refinement',checklist:'- [ ] 1.1 Inspect approved product and proof | obligations: obligation-01'});
  }
  const url=new URL('../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs',import.meta.url).href;
  const childCode=`import {publishExecutionCopy} from ${JSON.stringify(url)};try {const result=await publishExecutionCopy({specPath:process.argv[1],slice:'slice-01',candidateRoot:process.argv[2],terminal:false,checkpoint:async phase=>{if(phase==='before-backup'){process.send({locked:true});await new Promise(resolve=>process.once('message',resolve));}}});process.send({result});}catch(e){process.send({error:e.message});process.exitCode=1;}process.disconnect();`;
  function launch(copy) {
    const child=spawn(process.execPath,['--input-type=module','-e',childCode,f.specPath,copy.candidateRoot],{env:environment,stdio:['ignore','pipe','pipe','ipc']});
    const messages=[];const exit=new Promise(resolve=>child.once('exit',resolve));child.on('message',message=>messages.push(message));return {child,messages,exit};
  }
  const first=launch(copies[0]);assert.deepEqual(await new Promise(resolve=>first.child.once('message',resolve)),{locked:true});
  const second=launch(copies[1]);const rejected=await new Promise(resolve=>second.child.once('message',resolve));assert.match(rejected.error,/lock|CAS|changed/);assert.equal(await second.exit,1);
  const committed=new Promise(resolve=>first.child.once('message',resolve));first.child.send('release');const winner=await committed;assert.equal(winner.result.publication,'confirmed');assert.equal(await first.exit,0);
  const resumed=await resumeOwnedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',admitted.owner);assert.deepEqual(resumed.changedPaths,[]);assert.ok(await fs.stat(copies[1].candidateRoot));
  // A real product mutation at the same barrier must be caught before the swap.
  const third=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});await updateOperationalChecklist({candidateExecutionRoot:third.candidateExecutionRoot,slice:'slice-01',reason:'One further bounded step wording',checklist:'- [ ] 1.1 Inspect product and exact prepared proof | obligations: obligation-01'});
  const before=await captureExecutionTree(f.workspace.executionRoot);let phases=[];
  await assert.rejects(publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:third.candidateRoot,terminal:false,checkpoint:async phase=>{phases.push(phase);if(phase==='before-backup')await fs.writeFile(path.join(f.root,'specs/product.mjs'),'concurrent real product effect\n');}}),/product changed/);
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);assert.ok(!phases.includes('after-backup'));assert.equal(await fs.readFile(path.join(f.root,'specs/product.mjs'),'utf8'),'concurrent real product effect\n');
  await evidence(f,'A11',{winner:winner.result,loser:rejected,firstMessages:first.messages,secondMessages:second.messages,phases,resumed});
});

test('U2-A12 isolated copied bundle reads the same continuity while source imports are denied',async()=>{
  const f=await implementedFixture();await formal(f);const info=await inspectExecutionState(f.specPath);
  const bundle=path.join(f.root,'isolated-executor');await fs.cp(path.join(root,'skills/workflows/stnl-slice-executor'),bundle,{recursive:true});
  const loader=path.join(f.root,'deny-source-loader.mjs');await fs.writeFile(loader,`export async function resolve(s,c,next){const r=await next(s,c);if(r.url.startsWith(${JSON.stringify(new URL('../',import.meta.url).href)}))throw new Error('SOURCE_IMPORT_DENIED');return r;}\n`);
  const cli=path.join(bundle,'runtime/validate-execution-state.mjs');
  const result=spawnSync(process.execPath,['--experimental-loader',loader,cli,f.specPath,'--inspect-continuity','1'],{cwd:bundle,env:environment,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const copied=JSON.parse(result.stdout);assert.equal(copied.deliveryId,info.preparation.deliveries[0].deliveryId);assert.equal(copied.currentValidation,'current');
  const file=path.join(f.workspace.executionRoot,'continuity.json');const before=await fs.readFile(file);const altered=JSON.parse(before);altered.unknownPermission=true;await fs.writeFile(file,JSON.stringify(altered));
  await assert.rejects(readDeliveryContinuity(f.workspace),/unknown|missing/);await fs.writeFile(file,before);
  await evidence(f,'A12',{copied,bundle,sourceDenied:true});
});

}
