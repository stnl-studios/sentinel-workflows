import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {completedNativeCase,reopeningInput} from './fixtures/current-completed-native.mjs';
import {retireActive} from './fixtures/current-reader-campaign.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-execution-planner/runtime/execution-current-reader.mjs';
import {resolveCurrentExecutionContext} from '../skills/workflows/stnl-execution-planner/runtime/execution-workspace.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {publishPreparationCandidate,recoverPreparationPublication} from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {preparationRegistryPath,captureExecutionTree,executionLockIdentity} from '../skills/workflows/stnl-execution-planner/runtime/execution-publication.mjs';
const decode=bytes=>JSON.parse(Buffer.from(bytes));
const approve=request=>({...structuredClone(request),decision:'approved',summary:'Controlled B4 implementation test only; not B5 independent approval.',
 evidenceDecisions:request.evidenceDecisions.map(item=>({...item,reason:'Controlled exact retention or revalidation of these captured bytes.'}))});
async function fixture(t,{reopening=false,sharedInput=false}={}) {
 const f=await completedNativeCase(t,{drift:false,independent:true,retire:!reopening,sharedInput});if(reopening)await retireActive(f.view);
 const source=await captureCurrentExecution(f.specPath),continuity=decode(source.files.get('continuity.json'));
 const input=reopening?reopeningInput(source,f.delivery.deliveryId):{completedDeliveryIds:[...continuity.deliveries,...continuity.completed].map(item=>item.deliveryId),
  artifacts:new Map(['plan.md','tasks.md'].map(name=>[name,Buffer.from(Buffer.from(source.files.get(name)).toString('utf8').split('\n')
   .filter(line=>!continuity.deliveries.some(item=>line.includes(`| ${item.slice.slice(6)} - `))).join('\n'))]))};
 const draft=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:input.completedDeliveryIds});
 const root=draft.candidateExecutionRoot;
 for(const [name,bytes] of input.artifacts){const target=path.join(root,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes);}
 const options={specPath:f.specPath,candidateExecutionRoot:root},proposal=await publishPreparationCandidate(options);
 const review={globalReview:approve(proposal.reviewRequest.globalReview),deliveries:proposal.reviewRequest.deliveries.map(item=>({deliveryId:item.deliveryId,review:approve(item.review)}))};
 const {workspace}=await resolveCurrentExecutionContext(f.specPath),registry=await preparationRegistryPath(workspace);
 return {...f,source,root,options,proposal,review,workspace,registry,publish:checkpoint=>publishPreparationCandidate({...options,reviewDecision:review,checkpoint})};
}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
async function retired(f,allocation){
 await absent(`${f.root}.owner.json`);await absent(f.root);await absent(allocation);
 assert.equal(decode(await fs.readFile(f.registry)).allocations.some(item=>item.candidate===f.root),false);
}
test('B4 Q18 controlled publication uses registered candidate, readback and terminal retirement',async t=>{
 const f=await fixture(t),product=await fs.readFile(path.join(f.image.f.root,f.productFile));
 const result=await f.publish();assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');assert.equal(result.preparationDisposition,'retired');
 const after=await captureCurrentExecution(f.specPath),continuity=decode(after.files.get('continuity.json'));
 assert.equal(continuity.deliveries.length,0);assert.equal(continuity.completed.length,2);assert.equal(after.inspection.state,'VALIDATION_BLOCKED');
 assert.equal(after.inspection.preparationRevision,f.source.inspection.preparationRevision+1);
 assert.equal(decode(after.activationBytes).previousActivationId,f.source.inspection.activationId);
 await retired(f,result.allocation);assert.deepEqual(await fs.readFile(path.join(f.image.f.root,f.productFile)),product);
});

test('B4 Q19 controlled publication reopens the same identity with literal A and no new formal',async t=>{
 const f=await fixture(t,{reopening:true}),prior=decode(f.source.files.get('continuity.json'));
 const result=await f.publish();assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');
 const image=await captureCurrentExecution(f.specPath),next=decode(image.files.get('continuity.json'));
 assert.equal(next.deliveries[0].deliveryId,f.delivery.deliveryId);assert.equal(next.deliveries[0].localRevision,2);
 assert.equal(next.deliveries[0].validation,'revalidation-required');assert.deepEqual(next.completed,prior.completed.filter(item=>item.deliveryId!==f.delivery.deliveryId));
 const a=next.completed[0];assert.deepEqual(image.files.get(a.evidence.path),f.source.files.get(a.evidence.path));
 assert.equal(image.inspection.normalHandoff.operation,'VALIDATE_SLICE');assert.equal(image.inspection.deliveries[0].formalStatus,null);
 for(const member of [...next.deliveries,...next.completed])assert.deepEqual(member.counters,prior.completed.find(item=>item.deliveryId===member.deliveryId).counters);
 await retired(f,result.allocation);
});

for(const phase of ['before-backup','after-backup','after-install','before-activation','after-activation-intent','after-activation'])
 test(`B4 recovers the same registered publication after ${phase}`,async t=>{
  const f=await fixture(t);let injected=0,error;
  try{await f.publish(async current=>{if(current===phase){injected++;throw Error('controlled '+phase);}});}catch(caught){error=caught;}
  assert.equal(injected,1);assert.ok(error?.allocation);assert.equal(error.candidateRoot,f.root);
  const result=await recoverPreparationPublication({specPath:f.specPath,allocation:error.allocation});
  assert.equal(result.publication,phase==='after-activation'?'confirmed':'aborted');assert.equal(result.cleanup,'complete');
  const image=await captureCurrentExecution(f.specPath);
  if(result.publication==='aborted'){assert.deepEqual(image.activationBytes,f.source.activationBytes);assert.deepEqual(image.files,f.source.files);}
  else assert.equal(image.inspection.preparationRevision,f.source.inspection.preparationRevision+1);
  await retired(f,error.allocation);
 });

for(const phase of ['after-backup-removal','after-retention-removal','after-preparation-owner-removal','after-preparation-entry-removal','before-publisher-removal','after-publisher-removal'])
 test(`B4 terminal retirement resumes its own roles after ${phase}`,async t=>{
  const f=await fixture(t);let injected=0;
  const result=await f.publish(async current=>{if(current===phase){injected++;throw Object.assign(Error('controlled '+phase),{code:'EIO'});}});
  assert.equal(injected,1);assert.equal(result.publication,'confirmed');
  if(phase==='after-publisher-removal'){
   assert.equal(result.cleanup,'complete');await retired(f,result.allocation);
  } else {
   assert.equal(result.cleanup,'pending');await fs.access(result.allocation);
   assert.equal(decode(await fs.readFile(f.registry)).allocations.some(item=>item.candidate===f.root),true,'same publisher keeps or compensates its exact reservation');
   const recovered=await recoverPreparationPublication({specPath:f.specPath,allocation:result.allocation});
   assert.equal(recovered.cleanup,'complete');await retired(f,result.allocation);
  }
 });

test('B4 aborted cleanup resumes after its candidate role is already removed',async t=>{
 const f=await fixture(t);let error;
 try{await f.publish(async phase=>{if(phase==='before-backup')throw Error('controlled unswapped');});}catch(caught){error=caught;}
 let injected=0;
 await assert.rejects(recoverPreparationPublication({specPath:f.specPath,allocation:error.allocation,
  checkpoint:async phase=>{if(phase==='after-candidate-removal'){injected++;throw Error('controlled removed candidate');}}}),/controlled removed candidate/);
 assert.equal(injected,1);await absent(f.root);await fs.access(error.allocation);
 assert.equal((await recoverPreparationPublication({specPath:f.specPath,allocation:error.allocation})).publication,'aborted');
 await retired(f,error.allocation);assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,f.source.activationBytes);
});

test('B4 marker creation failure retains the registered draft and reuses its exact reviewed bytes',async t=>{
 const f=await fixture(t),open=fs.open;let injected=0,error;
 fs.open=async(file,...args)=>{if(typeof file==='string'&&/\.stnl-execution-publication-[a-f0-9-]+\.json$/u.test(file)){injected++;throw Object.assign(Error('controlled marker creation'),{code:'EIO'});}return open(file,...args);};
 try{await f.publish();}catch(caught){error=caught;}finally{fs.open=open;}
 assert.equal(injected,1);assert.ok(error);assert.equal(error.candidateRoot,f.root);
 await fs.access(`${f.root}.owner.json`);const before=await captureExecutionTree(f.root);
 assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,f.source.activationBytes);
 const result=await f.publish(async phase=>{if(phase==='before-backup')assert.deepEqual(await captureExecutionTree(f.root),before);});
 assert.equal(result.cleanup,'complete');await retired(f,result.allocation);
});

test('B4 recovery checks the compound association before restoring or deleting material',async t=>{
 const f=await fixture(t);let error;
 try{await f.publish(async phase=>{if(phase==='after-backup')throw Error('controlled backed up');});}catch(caught){error=caught;}
 // The normal pre-intent handler restores the source. The independent
 // publisher binding must still refuse coherently altered preparation data.
 const before=await captureExecutionTree(f.workspace.executionRoot),registry=await fs.readFile(f.registry),owner=await fs.readFile(`${f.root}.owner.json`);
 const altered=decode(registry),alteredOwner=decode(owner),foreign=randomUUID();altered.allocations.find(item=>item.candidate===f.root).expectedActivationId=foreign;alteredOwner.expectedActivationId=foreign;
 await fs.writeFile(f.registry,JSON.stringify(altered));await fs.writeFile(`${f.root}.owner.json`,JSON.stringify(alteredOwner));
 await assert.rejects(recoverPreparationPublication({specPath:f.specPath,allocation:error.allocation}),/compound binding/);
 assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);await fs.access(f.root);await fs.access(error.allocation);
 await fs.writeFile(f.registry,registry);await fs.writeFile(`${f.root}.owner.json`,owner);
 await recoverPreparationPublication({specPath:f.specPath,allocation:error.allocation});await retired(f,error.allocation);
});

test('B4 retirement preserves unrelated registry bindings and foreign retention bytes',async t=>{
 const f=await fixture(t),registry=decode(await fs.readFile(f.registry)),foreignRoot=path.join(f.image.f.root,'tmp/foreign preparation');
 await fs.mkdir(foreignRoot);await fs.writeFile(path.join(foreignRoot,'keep.txt'),'foreign material');
 const metadata=await fs.lstat(foreignRoot),foreign={...structuredClone(registry.allocations[0]),allocationId:randomUUID(),candidate:foreignRoot,
  candidateIdentity:{dev:String(metadata.dev),ino:String(metadata.ino)},operation:'PLAN'};
 registry.allocations.push(foreign);await fs.writeFile(f.registry,JSON.stringify(registry));
 let foreignFile;
 const result=await f.publish(async(phase,paths)=>{if(phase==='before-publisher-removal')return;
  if(phase==='after-backup-removal'){const marker=decode(await fs.readFile(paths.marker));foreignFile=path.join(marker.retentionRoot,'foreign.txt');await fs.writeFile(foreignFile,'preserve foreign retention');}});
 assert.equal(result.cleanup,'pending');assert.equal(await fs.readFile(foreignFile,'utf8'),'preserve foreign retention');
 assert.deepEqual(decode(await fs.readFile(f.registry)).allocations.find(item=>item.candidate===foreignRoot),foreign);
 await fs.unlink(foreignFile);await recoverPreparationPublication({specPath:f.specPath,allocation:result.allocation});await retired(f,result.allocation);
 assert.deepEqual(decode(await fs.readFile(f.registry)).allocations,[foreign]);assert.equal(await fs.readFile(path.join(foreignRoot,'keep.txt'),'utf8'),'foreign material');
});

for(const removed of [false,true])test(`B4 unlink error ${removed?'after removal does not resurrect':'before removal compensates the same publisher'}`,async t=>{
 const f=await fixture(t),unlink=fs.unlink;let injected=0;
 fs.unlink=async(file,...args)=>{if(typeof file==='string'&&/\.stnl-execution-publication-[a-f0-9-]+\.json$/u.test(file)){
  injected++;if(removed)await unlink(file,...args);throw Object.assign(Error('controlled unlink acknowledgment'),{code:'EIO'});}return unlink(file,...args);};
 let result;try{result=await f.publish();}finally{fs.unlink=unlink;}
 assert.equal(injected,1);assert.equal(result.cleanup,removed?'complete':'pending');
 if(removed)await retired(f,result.allocation);
 else{await fs.access(result.allocation);assert.equal(decode(await fs.readFile(f.registry)).allocations.some(item=>item.candidate===f.root),true);
  await recoverPreparationPublication({specPath:f.specPath,allocation:result.allocation});await retired(f,result.allocation);}
});

test('B4 uncertain sync after final unlink retains the common lease without reinserting the association',async t=>{
 const f=await fixture(t),open=fs.open;let armed=false,injected=0,error,marker;
 fs.open=async(file,...args)=>{if(armed&&file===path.dirname(marker)){injected++;throw Object.assign(Error('controlled directory sync uncertainty'),{code:'EIO'});}return open(file,...args);};
 try{await f.publish(async(phase,paths)=>{if(phase==='before-publisher-removal'){marker=paths.marker;armed=true;}});}catch(caught){error=caught;}finally{fs.open=open;}
 assert.equal(injected,1);assert.equal(error?.retainExecutionLock,true);assert.equal(error.allocation,marker);
 await absent(marker);assert.equal(decode(await fs.readFile(f.registry)).allocations.some(item=>item.candidate===f.root),false);
 await fs.access((await executionLockIdentity(f.workspace)).lockPath);
});

test('B4 uncertain registry readback retains the common lease and publisher',async t=>{
 const f=await fixture(t),open=fs.open,rename=fs.rename;let armed=false,injected=0,error;
 fs.rename=async(from,to)=>{const result=await rename(from,to);if(to===f.registry)armed=true;return result;};
 fs.open=async(file,...args)=>{if(armed&&file===f.registry){injected++;throw Object.assign(Error('controlled registry readback uncertainty'),{code:'EIO'});}return open(file,...args);};
 try{await f.publish();}catch(caught){error=caught;}finally{fs.open=open;fs.rename=rename;}
 assert.equal(injected,1);assert.equal(error?.retainExecutionLock,true);await fs.access(error.allocation);
 await fs.access((await executionLockIdentity(f.workspace)).lockPath);
});

test('B4 a foreign publisher after unlink is preserved and cannot authorize compensation',async t=>{
 const f=await fixture(t),unlink=fs.unlink;let injected=0,error;
 fs.unlink=async(file,...args)=>{if(typeof file==='string'&&/\.stnl-execution-publication-[a-f0-9-]+\.json$/u.test(file)){
  injected++;await unlink(file,...args);await fs.writeFile(file,'foreign publisher bytes\n');throw Object.assign(Error('controlled replaced publisher'),{code:'EIO'});}return unlink(file,...args);};
 try{await f.publish();}catch(caught){error=caught;}finally{fs.unlink=unlink;}
 assert.equal(injected,1);assert.equal(error?.retainExecutionLock,true);assert.equal(await fs.readFile(error.allocation,'utf8'),'foreign publisher bytes\n');
 assert.equal(decode(await fs.readFile(f.registry)).allocations.some(item=>item.candidate===f.root),false);
 await fs.access((await executionLockIdentity(f.workspace)).lockPath);
});

test('B4 crash under the common lease has no automatic takeover or second publication',async t=>{
 const f=await fixture(t),harness=path.join(f.image.f.root,'tmp/crash-publication.mjs'),locator=path.join(f.image.f.root,'tmp/crash-locator.json');
 const moduleURL=pathToFileURL(path.resolve('skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs')).href;
 await fs.writeFile(harness,`import fs from 'node:fs/promises';\nimport {publishPreparationCandidate} from ${JSON.stringify(moduleURL)};\nawait publishPreparationCandidate({...${JSON.stringify({...f.options,reviewDecision:f.review})},checkpoint:async(phase,paths)=>{if(phase==='after-backup'){await fs.writeFile(${JSON.stringify(locator)},JSON.stringify(paths));process.exit(77);}}});\n`);
 await assert.rejects(promisify(execFile)(process.execPath,[harness]),error=>error.code===77);
 const paths=decode(await fs.readFile(locator)),lock=(await executionLockIdentity(f.workspace)).lockPath,before=await fs.readFile(lock),registry=await fs.readFile(f.registry);
 await assert.rejects(recoverPreparationPublication({specPath:f.specPath,allocation:paths.marker}),{code:'EXECUTION_PUBLICATION_BLOCKED'});
 assert.deepEqual(await fs.readFile(lock),before);assert.deepEqual(await fs.readFile(f.registry),registry);await fs.access(paths.marker);await fs.access(`${f.root}.owner.json`);
 assert.deepEqual(await captureExecutionTree(paths.backup),decode(await fs.readFile(paths.marker)).expectedTree);
});

test('B4 failed compensation retains the publisher and lease instead of releasing a lost reservation',async t=>{
 const f=await fixture(t),rename=fs.rename;let armed=false,injected=0,error;
 fs.rename=async(from,to)=>{if(armed&&to===f.registry){injected++;throw Object.assign(Error('controlled compensation failure'),{code:'EIO'});}return rename(from,to);};
 try{await f.publish(async phase=>{if(phase==='before-publisher-removal'){armed=true;throw Error('controlled tail failure');}});}catch(caught){error=caught;}finally{fs.rename=rename;}
 assert.equal(injected,1);assert.equal(error?.retainExecutionLock,true);await fs.access(error.allocation);
 assert.equal(decode(await fs.readFile(f.registry)).allocations.some(item=>item.candidate===f.root),false);
 await fs.access((await executionLockIdentity(f.workspace)).lockPath);
});

test('B4 recovers an activation whose confirmation persistence did not finish',async t=>{
 const f=await fixture(t);let injected=0;
 const result=await f.publish(async phase=>{if(phase==='before-confirmation-persistence'){injected++;throw Error('controlled confirmation loss');}});
 assert.equal(injected,1);assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'pending');
 assert.equal((await recoverPreparationPublication({specPath:f.specPath,allocation:result.allocation})).publication,'confirmed');
 await retired(f,result.allocation);
});

test('B4 absent publisher with pending preparation controls is preserved and blocks a second REPLAN',async t=>{
 const f=await fixture(t),result=await f.publish(async phase=>{if(phase==='after-backup-removal')throw Error('controlled pending cleanup');});
 assert.equal(result.cleanup,'pending');await fs.unlink(result.allocation);
 const source=await captureCurrentExecution(f.specPath),registry=await fs.readFile(f.registry),owner=await fs.readFile(`${f.root}.owner.json`);
 await assert.rejects(recoverPreparationPublication({specPath:f.specPath,allocation:result.allocation}),{code:'ENOENT'});
 const ids=decode(source.files.get('continuity.json')).completed.slice(0,1).map(item=>item.deliveryId);
 await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:ids}),{code:'OWNER_ACTIVE'});
 assert.deepEqual(await fs.readFile(f.registry),registry);assert.deepEqual(await fs.readFile(`${f.root}.owner.json`),owner);
 assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,source.activationBytes);
});

test('B4 identical publisher bytes in a different inode do not authorize compensation',async t=>{
 const f=await fixture(t),unlink=fs.unlink;let injected=0,error;
 fs.unlink=async(file,...args)=>{if(typeof file==='string'&&/\.stnl-execution-publication-[a-f0-9-]+\.json$/u.test(file)){
  injected++;const bytes=await fs.readFile(file),replacement=file+'.foreign';await fs.writeFile(replacement,bytes);
  assert.notEqual((await fs.lstat(replacement)).ino,(await fs.lstat(file)).ino);
  await unlink(file,...args);await fs.rename(replacement,file);throw Object.assign(Error('controlled identical foreign publisher'),{code:'EIO'});}return unlink(file,...args);};
 try{await f.publish();}catch(caught){error=caught;}finally{fs.unlink=unlink;}
 assert.equal(injected,1);assert.equal(error?.retainExecutionLock,true);await fs.access(error.allocation);
 assert.equal(decode(await fs.readFile(f.registry)).allocations.some(item=>item.candidate===f.root),false);
 await fs.access((await executionLockIdentity(f.workspace)).lockPath);
});

for(const variant of ['rename','sync'])test(`B4 uncertain ${variant} at backup retains its lease and exact roles`,async t=>{
 const f=await fixture(t),rename=fs.rename,open=fs.open;let directory=null,injected=0,error;
 fs.rename=async(from,to)=>{const result=await rename(from,to);if(from===f.workspace.executionRoot&&path.basename(to)==='previous'){
  directory=path.dirname(to);if(variant==='rename'){injected++;throw Object.assign(Error('controlled rename acknowledgment'),{code:'EIO'});}}return result;};
 fs.open=async(file,...args)=>{if(variant==='sync'&&directory&&file===directory){injected++;throw Object.assign(Error('controlled backup sync uncertainty'),{code:'EIO'});}return open(file,...args);};
 try{await f.publish();}catch(caught){error=caught;}finally{fs.rename=rename;fs.open=open;}
 assert.equal(injected,1);assert.equal(error?.retainExecutionLock,true);await fs.access(error.allocation);await fs.access(`${f.root}.owner.json`);
 assert.deepEqual(await captureExecutionTree(decode(await fs.readFile(error.allocation)).backup),decode(await fs.readFile(error.allocation)).expectedTree);
 await fs.access((await executionLockIdentity(f.workspace)).lockPath);
});

for(const boundary of ['after-activation','after-backup-removal'])test(`B4 uncertain readback at ${boundary} keeps the publication controls and common lease`,async t=>{
 const f=await fixture(t);let injected=0,error;
 try{await f.publish(async phase=>{if(phase===boundary){injected++;await fs.appendFile(path.join(f.image.f.root,f.productFile),'// drift before installed readback\n');}});}catch(caught){error=caught;}
 assert.equal(injected,1);assert.equal(error?.retainExecutionLock,true);await fs.access(error.allocation);await fs.access(`${f.root}.owner.json`);
 await fs.access((await executionLockIdentity(f.workspace)).lockPath);
});

for(const reopening of [false,true])for(const boundary of ['before-backup','after-backup'])for(const domain of ['product','input'])
 test(`B4 P2 ${reopening?'Q19':'Q18'} refuses ${domain} drift at ${boundary} before any activation`,async t=>{
  const f=await fixture(t,{reopening,sharedInput:domain==='input'}),before=await captureExecutionTree(f.workspace.executionRoot);
  const target=path.join(f.image.f.root,domain==='input'?'shared-config.json':f.productFile),prior=await fs.readFile(target);
  let injected=0,activationAttempts=0,error;
  try{await f.publish(async phase=>{
   if(phase===boundary){injected++;await fs.appendFile(target,'// controlled P2 drift\n');}
   if(phase==='before-activation')activationAttempts++;
  });}catch(caught){error=caught;}
  assert.equal(injected,1);assert.equal(error?.code,'EVIDENCE_STALE');assert.equal(activationAttempts,0);
  assert.notEqual(error?.retainExecutionLock,true,'known preactivation drift preserves/restores the source');
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
  assert.deepEqual(await fs.readFile(path.join(f.workspace.executionRoot,'activation.json')),Buffer.from(f.source.activationBytes));
  assert.deepEqual(await fs.readFile(target),Buffer.concat([prior,Buffer.from('// controlled P2 drift\n')]));
  await fs.access(error.allocation);await fs.access(f.root);await fs.access(`${f.root}.owner.json`);
  assert.equal(decode(await fs.readFile(f.registry)).allocations.some(item=>item.candidate===f.root),true);
  await absent((await executionLockIdentity(f.workspace)).lockPath);
 });
