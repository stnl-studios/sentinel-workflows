import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {completedNativeCase,reopeningInput} from './fixtures/current-completed-native.mjs';
import {retireActive} from './fixtures/current-reader-campaign.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-execution-planner/runtime/execution-current-reader.mjs';
import {preflightExecutionOperation} from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {preparePlanCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs';
import {serializePlanPathClaims} from '../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs';
import {publishPreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {begin} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
const run=promisify(execFile),runtime=path.resolve('skills/workflows/stnl-execution-planner/runtime');
const decode=bytes=>JSON.parse(Buffer.from(bytes));
async function cli(name,args,root=runtime){return JSON.parse((await run(process.execPath,[path.join(root,name),...args],{cwd:'/tmp'})).stdout);}
async function writeArtifacts(root,artifacts){for(const [name,bytes] of artifacts){const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}}
function reviewFor(request){
 const approve=value=>({...structuredClone(value),decision:'approved',summary:'Mechanical test decision only; no independent live approval.',
  evidenceDecisions:value.evidenceDecisions.map(item=>({...item,reason:'Mechanical test binds the exact current retained or revalidated evidence.'}))});
 return {globalReview:approve(request.globalReview),deliveries:request.deliveries.map(item=>({deliveryId:item.deliveryId,review:approve(item.review)}))};
}
async function sourceFixture(t,{reopening=false}={}){
 // This predecessor is controlled authored setup. No B4 publication or native
 // acceptance is claimed by these API/CLI preparation checks.
 const f=await completedNativeCase(t,{drift:false,independent:true,retire:!reopening});
 if(reopening)await retireActive(f.view);
 const source=await captureCurrentExecution(f.specPath),continuity=decode(source.files.get('continuity.json'));
 const input=reopening?reopeningInput(source,f.delivery.deliveryId):{
  completedDeliveryIds:[...continuity.deliveries,...continuity.completed].map(item=>item.deliveryId),
  artifacts:new Map(['plan.md','tasks.md'].map(name=>[name,Buffer.from(Buffer.from(source.files.get(name)).toString('utf8')
   .split('\n').filter(line=>!continuity.deliveries.some(item=>line.includes(`| ${item.slice.slice(6)} - `))).join('\n'))]))};
 return {...f,source,input};
}
async function unchanged(f){
 const after=await captureCurrentExecution(f.specPath);
 assert.deepEqual(after.activationBytes,f.source.activationBytes);assert.deepEqual(after.files,f.source.files);
}
test('Public Q18 API prepares a complete owned proposal, stays awaiting review and is byte stable',async t=>{
 const f=await sourceFixture(t);
 assert.equal((await preflightExecutionOperation(f.specPath,'REPLAN')).operation,'REPLAN');
 await assert.rejects(preflightExecutionOperation(f.specPath,'REPLAN','slice-02'),{code:'OWNER_UNCERTAIN'});
 const draft=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:f.input.completedDeliveryIds});
 await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:f.input.completedDeliveryIds}),{code:'OWNER_ACTIVE'});
 const options={specPath:f.specPath,candidateExecutionRoot:draft.candidateExecutionRoot};
 await writeArtifacts(options.candidateExecutionRoot,f.input.artifacts);
 const before=await fs.readFile(path.join(f.root,f.productFile));
 const proposal=await publishPreparationCandidate(options);
 assert.equal(proposal.status,'AWAITING_REVIEW');assert.equal(proposal.publication,'not-started');assert.equal(proposal.reviewValidated,false);
 assert.equal(proposal.authority.deliveries.length,0);assert.equal(proposal.reviewRequest.deliveries.length,0);
 const serialized=await serializePlanPathClaims(options);
 for(const [name,bytes] of serialized.proposal.files)assert.deepEqual(await fs.readFile(path.join(options.candidateExecutionRoot,name)),bytes);
 for(const name of ['activation.json','approved-preparation.json','plans/slice-02.md','tasks/slice-02.md'])
  await assert.rejects(fs.readFile(path.join(options.candidateExecutionRoot,name)),{code:'ENOENT'});
 assert.deepEqual(await publishPreparationCandidate(options),proposal);
 assert.equal((await preparePreparationCandidate({...options,operation:'REVIEW_PLAN'})).expectedActivationId,f.source.inspection.activationId);
 const review=reviewFor(proposal.reviewRequest),reviewed=await publishPreparationCandidate({...options,reviewDecision:review});
 assert.equal(reviewed.reviewValidated,true);assert.equal(reviewed.publication,'not-started');
 await assert.rejects(publishPreparationCandidate({...options,reviewDecision:{decision:'approved'}}));
 const stale=structuredClone(review);stale.globalReview.examinedArtifactHashes[0].sha256='sha256:'+'0'.repeat(64);
 await assert.rejects(publishPreparationCandidate({...options,reviewDecision:stale}),{code:'STALE_APPROVAL'});
 await unchanged(f);assert.deepEqual(await fs.readFile(path.join(f.root,f.productFile)),before);
});

for(const reopening of [false,true])test(`Public ${reopening?'Q19':'Q18'} CLI uses the registered source and preserves live and product`,async t=>{
 const command=(name,args)=>cli(name,args,reopening?path.resolve('skills/workflows/stnl-plan-reviewer/runtime'):runtime);
 const f=await sourceFixture(t,{reopening}),source=decode(f.source.files.get('continuity.json'));
 const beforeProduct=await fs.readFile(path.join(f.root,f.productFile));
 const draft=await command('prepare-task-candidate.mjs',['--spec-path',f.specPath,'--operation','REPLAN','--completed-delivery-ids',JSON.stringify(f.input.completedDeliveryIds)]);
 const root=draft.candidateExecutionRoot,options={specPath:f.specPath,candidateExecutionRoot:root};
 const artifacts=new Map([...f.input.artifacts].map(([name,bytes])=>[name,Buffer.from(Buffer.from(bytes).toString('utf8')
  .replace(/^- Delivery ID: .+$/mu,'- Delivery ID: runtime').replace(/^- Local revision: .+$/mu,'- Local revision: runtime'))]));
 await writeArtifacts(root,artifacts);
 // This mutable convenience map cannot allocate a replacement identity.
 const markerFile=`${root}.owner.json`,marker=decode(await fs.readFile(markerFile));
 marker.deliveryIds={'slice-02.md':'33333333-3333-4333-8333-333333333333'};await fs.writeFile(markerFile,JSON.stringify(marker)+'\n');
 assert.equal((await command('prepare-plan-candidate.mjs',['--candidate-execution-root',root])).status,'DRAFT');
 const serialized=await command('serialize-plan-paths.mjs',['--spec-path',f.specPath,'--candidate-execution-root',root]);
 assert.equal(serialized.status,'PASS');
 const args=['--spec-path',f.specPath,'--candidate-execution-root',root],proposal=await command('publish-task-candidate.mjs',args);
 assert.equal(proposal.publication,'not-started');assert.equal(proposal.status,'AWAITING_REVIEW');
 assert.equal(proposal.authority.preparationRevision,f.source.inspection.preparationRevision+1);
 assert.deepEqual(await command('publish-task-candidate.mjs',args),proposal);
 assert.deepEqual(await publishPreparationCandidate(options),proposal);
 const prepared=await serializePlanPathClaims(options),after=decode(prepared.proposal.files.get('continuity.json'));
 assert.equal(after.nextSliceOrdinal,source.nextSliceOrdinal);
 for(const old of [...source.deliveries,...source.completed]){
  const member=[...after.deliveries,...after.completed].find(item=>item.deliveryId===old.deliveryId);
  assert.equal(member.slice,old.slice);assert.deepEqual(member.counters,old.counters);assert.deepEqual(member.baseline,old.baseline);
  assert.equal(member.localRevision,old.localRevision+(reopening&&old.deliveryId===f.delivery.deliveryId?1:0));
 }
 if(reopening){
  assert.equal(after.deliveries[0].deliveryId,f.delivery.deliveryId);assert.equal(after.deliveries[0].validation,'revalidation-required');
  const a=after.completed[0];assert.deepEqual(after.completed[0],source.completed.find(item=>item.deliveryId===a.deliveryId));
  assert.deepEqual(prepared.proposal.files.get(a.evidence.path),Buffer.from(f.source.files.get(a.evidence.path)));
  assert.equal(proposal.reviewRequest.deliveries[0].review.evidenceDecisions[0].disposition,'revalidate');
 }
 const review=reviewFor(proposal.reviewRequest),reviewFile=path.join(f.root,'tmp/review.json');await fs.writeFile(reviewFile,JSON.stringify(review));
 if(reopening)await assert.rejects(publishPreparationCandidate({...options,reviewDecision:{...review,deliveries:[]}}),{code:'STALE_APPROVAL'});
 assert.equal((await command('publish-task-candidate.mjs',[...args,'--review-decision-file',reviewFile])).reviewValidated,true);
 await fs.appendFile(path.join(root,'plan.md'),'\n');
 await assert.rejects(command('publish-task-candidate.mjs',[...args,'--review-decision-file',reviewFile]));
 await unchanged(f);assert.deepEqual(await fs.readFile(path.join(f.root,f.productFile)),beforeProduct);
});

test('Public set preparation refuses foreign identities, revisions, carriers, ownership and stale source',async t=>{
 const f=await sourceFixture(t,{reopening:true}),all=decode(f.source.files.get('continuity.json')).completed;
 for(const ids of [null,[],[all[0].deliveryId,all[0].deliveryId],['33333333-3333-4333-8333-333333333333']])
  await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:ids}));
 const draft=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:f.input.completedDeliveryIds});
 const root=draft.candidateExecutionRoot,options={specPath:f.specPath,candidateExecutionRoot:root};await writeArtifacts(root,f.input.artifacts);
 const task=path.join(root,'tasks/slice-02.md'),original=await fs.readFile(task,'utf8');
 for(const text of [original.replace(/^- Delivery ID: .+$/mu,'- Delivery ID: 33333333-3333-4333-8333-333333333333'),
  original.replace(/^- Local revision: .+$/mu,'- Local revision: 1')]){
  await fs.writeFile(task,text);await assert.rejects(preparePlanCandidate({candidateExecutionRoot:root}));await fs.writeFile(task,original);
 }
 const markerFile=`${root}.owner.json`,marker=await fs.readFile(markerFile),parsed=decode(marker);
 for(const mutate of [x=>{x.preparationRevision+=1;},x=>{x.expectedActivationId='33333333-3333-4333-8333-333333333333';},x=>{x.candidateIdentity.ino='0';},x=>{x.operation='PLAN';}]){
  const changed=structuredClone(parsed);mutate(changed);await fs.writeFile(markerFile,JSON.stringify(changed));
  await assert.rejects(publishPreparationCandidate(options));await fs.writeFile(markerFile,marker);
 }
 const continuity=path.join(root,'continuity.json'),bytes=await fs.readFile(continuity);
 await fs.writeFile(continuity,'{}\n');await assert.rejects(publishPreparationCandidate(options),{code:'EVIDENCE_INCOMPLETE'});await fs.writeFile(continuity,bytes);
 const foreign=path.join(root,'evidence/33333333-3333-4333-8333-333333333333.json');await fs.writeFile(foreign,'{}');
 await assert.rejects(publishPreparationCandidate(options));await fs.rm(foreign);
 const a=path.join(f.image.f.execution,'plan.md'),live=await fs.readFile(a);await fs.appendFile(a,'\n');
 await assert.rejects(publishPreparationCandidate(options));await fs.writeFile(a,live);
 const product=path.join(f.root,f.productFile),productBytes=await fs.readFile(product);await fs.appendFile(product,'// drift\n');
 await assert.rejects(publishPreparationCandidate(options),{code:'EVIDENCE_STALE'});await fs.writeFile(product,productBytes);
 const retained=path.join(f.root,'src/greeting.mjs'),aBytes=await fs.readFile(retained);await fs.appendFile(retained,'// A drift\n');
 await assert.rejects(publishPreparationCandidate(options),{code:'EVIDENCE_STALE'});await fs.writeFile(retained,aBytes);
 const requirements=await fs.readFile(f.specPath);await fs.appendFile(f.specPath,'\nAC-003: changed authority.\n');
 await assert.rejects(publishPreparationCandidate(options));await fs.writeFile(f.specPath,requirements);
 const unowned=path.join(f.root,'tmp/unowned');await fs.mkdir(unowned);await writeArtifacts(unowned,f.input.artifacts);
 await assert.rejects(publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:unowned}));
 await unchanged(f);
});

test('Public set entry refuses an official active owner without starting a dispatch',async t=>{
 const f=await sourceFixture(t),product=path.join(f.root,f.productFile);await fs.appendFile(product,'// private drift\n');
 const image=await captureCurrentExecution(f.specPath);
 await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:image.inspection.activationId});
 const activationFile=path.join(f.image.f.execution,'activation.json'),before=await fs.readFile(activationFile),productBefore=await fs.readFile(product);
 assert.ok(decode(before).activeAttempt);
 await assert.rejects(preflightExecutionOperation(f.specPath,'REPLAN'),{code:'OWNER_UNCERTAIN'});
 await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:f.input.completedDeliveryIds}),{code:'OWNER_UNCERTAIN'});
 assert.deepEqual(await fs.readFile(activationFile),before);assert.deepEqual(await fs.readFile(product),productBefore);
});
