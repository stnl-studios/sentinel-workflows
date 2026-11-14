import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initialArtifacts,REQUIREMENTS} from './fixtures/current-initial-preparation.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {publishPreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {serializePlanPathClaims} from '../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs';
import {inspectCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {createPreparationDraft,capturePreparationDraft,revisePreparationDraft,approvePreparationDraft,assertPreparationDraftApproval,preparationDraftPaths} from '../skills/workflows/stnl-execution-planner/runtime/preparation-draft.mjs';
import {READY_FIXTURE,copyTree} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
const run=promisify(execFile);
async function fixture(t,{form='standalone',single=false}={}){
 const root=await fs.mkdtemp(path.resolve('tmp/public current preparation '));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await run('git',['-C',root,'init','-q']);await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
 const specPath=path.join(root,form==='lifecycle'?'docs/spec/feature_spec.md':'specs/pay/requirements.md');
 if(form==='lifecycle')await copyTree(READY_FIXTURE,path.dirname(specPath));
 else{await fs.mkdir(path.dirname(specPath),{recursive:true});await fs.writeFile(specPath,'# Pay\n\nAC-001: Export pay.\n');}
 await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/pay.test.mjs'),'import assert from "node:assert/strict";import {pay} from "./pay.mjs";assert.equal(pay(),"paid");\n');
 const draft=await preparePreparationCandidate({specPath,operation:'PLAN'}),candidateExecutionRoot=draft.candidateExecutionRoot;
 for(const [name,bytes] of initialArtifacts({form})){
  if(single&&name.includes('slice-02'))continue;
  const target=path.join(candidateExecutionRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});
  let text=bytes.toString().replaceAll(REQUIREMENTS,draft.requirementsAuthority).replace(/^- Delivery ID: .+$/gmu,'- Delivery ID: runtime');
  if(single)text=text.split('\n').filter(line=>!line.includes('| 02 - Verification |')).join('\n')
    .replaceAll('contribution: partial | full owner: slice-02','contribution: complete | full owner: slice-01');
  await fs.writeFile(target,text);
 }
 return {root,specPath,candidateExecutionRoot};
}
function reviewFor(authority){
 const hashes=new Map(authority.artifactHashes.map(x=>[x.path,x.sha256]));
 const decision=(scope,sha,names)=>({scope,decision:'approved',authoritySha256:sha,examinedArtifactHashes:names.sort().map(name=>({path:name,sha256:hashes.get(name)})),evidenceDecisions:[],summary:'Mechanical test review of these exact current artifacts.'});
 return {globalReview:decision('set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:authority.deliveries.map(d=>({deliveryId:d.deliveryId,review:decision('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};
}

test('editable Plan and Tasks beside SPEC stay non-authoritative through approval and independent review consumes exact snapshot',async t=>{
 const f=await fixture(t),draft=await createPreparationDraft(f);
 assert.equal(path.dirname(path.dirname(draft.draftRoot)),path.dirname(f.specPath));
 const controls=await preparationDraftPaths(f);
 for(const file of Object.values(controls))assert.equal(path.dirname(file),path.dirname(f.candidateExecutionRoot)+'-drafts');
 assert.deepEqual((await fs.readdir(path.dirname(f.specPath))).sort(),[path.basename(f.specPath),path.parse(f.specPath).name+'-planning'].sort());
 const plan=path.join(draft.draftRoot,'plan.md');await fs.appendFile(plan,'\n');
 const captured=await capturePreparationDraft(f);
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 const {authority}=await serializePlanPathClaims(f);
 await assert.rejects(publishPreparationCandidate({...f,reviewDecision:reviewFor(authority)}),e=>e.code==='STALE_APPROVAL');
 await assert.rejects(approvePreparationDraft({...f,approvedCaptureSha256:'sha256:'+'0'.repeat(64)}),e=>e.code==='STALE_APPROVAL');
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 const reviewed=await assertPreparationDraftApproval(f,{required:true});
 for(const artifact of reviewed.artifacts)assert.equal(await fs.readFile(path.join(f.candidateExecutionRoot,artifact.path),'utf8'),artifact.utf8);
 // A separate reviewer closure consumes the same fixed snapshot, not a paraphrase.
 const reviewer=await import('../skills/workflows/stnl-plan-reviewer/runtime/preparation-draft.mjs');
 assert.deepEqual(await reviewer.assertPreparationDraftApproval(f,{required:true}),reviewed);
 const result=await publishPreparationCandidate({...f,reviewDecision:reviewFor(authority)});
 assert.equal(result.publication,'confirmed');
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'MATERIALIZED_PRISTINE');
 assert.equal(await fs.readFile(plan,'utf8'),reviewed.artifacts.find(item=>item.path==='plan.md').utf8);
});
for(const target of ['draft','snapshot'])test('changes to '+target+' after capture reject review and activation',async t=>{
 const f=await fixture(t),draft=await createPreparationDraft(f),captured=await capturePreparationDraft(f);
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});
 const {authority}=await serializePlanPathClaims(f);
 await fs.appendFile(path.join(target==='draft'?draft.draftRoot:f.candidateExecutionRoot,'plan.md'),'\n');
 await assert.rejects(assertPreparationDraftApproval(f),e=>e.code==='STALE_APPROVAL');
 await assert.rejects(publishPreparationCandidate({...f,reviewDecision:reviewFor(authority)}),e=>e.code==='STALE_APPROVAL');
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
});
test('capture is immutable and approval cannot be silently refreshed',async t=>{
 const f=await fixture(t);await createPreparationDraft(f);const captured=await capturePreparationDraft(f);
 await assert.rejects(capturePreparationDraft(f),e=>e.code==='STALE_APPROVAL');
 await assert.rejects(preparePreparationCandidate({...f,operation:'REVIEW_PLAN'}),e=>e.code==='STALE_APPROVAL');
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});
 await assert.rejects(approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256}));
});

test('public APIs reject absent user approval even without a draft association',async t=>{
 const f=await fixture(t);await publishPreparationCandidate(f);const {authority}=await serializePlanPathClaims(f),review=reviewFor(authority);
 await assert.rejects(publishPreparationCandidate({...f,reviewDecision:review}),e=>e.code==='STALE_APPROVAL');
 const {installCurrentInitial}=await import('../skills/workflows/stnl-execution-planner/runtime/install-current-initial.mjs');
 await assert.rejects(installCurrentInitial({specPath:f.specPath,preparationRoot:f.candidateExecutionRoot,review}),e=>e.code==='STALE_APPROVAL');
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
});
test('repeated PLAN reuses its registered draft without creating extra directories',async t=>{
 const f=await fixture(t),first=await createPreparationDraft(f);
 const second=await preparePreparationCandidate({specPath:f.specPath,operation:'PLAN'});
 const next=await createPreparationDraft({specPath:f.specPath,candidateExecutionRoot:second.candidateExecutionRoot});
 assert.equal(second.reused,true);assert.equal(next.reused,true);assert.equal(first.draftRoot,next.draftRoot);
 assert.equal((await fs.readdir(path.dirname(first.draftRoot))).length,1);assert.equal((await fs.stat(first.draftRoot)).isDirectory(),true);
});
test('mutable association cannot redirect draft capture to an unrelated directory',async t=>{
 const f=await fixture(t),draft=await createPreparationDraft(f),outside=path.join(f.root,'unrelated');
 await fs.cp(draft.draftRoot,outside,{recursive:true});const original=await fs.readFile(path.join(outside,'plan.md'));
 const file=(await preparationDraftPaths(f)).binding,binding=JSON.parse(await fs.readFile(file));binding.draftRoot=outside;
 await fs.writeFile(file,JSON.stringify(binding));
 await assert.rejects(capturePreparationDraft(f),e=>e.code==='STALE_APPROVAL');
 assert.deepEqual(await fs.readFile(path.join(outside,'plan.md')),original);
});
test('draft symlink targets are rejected without modifying the referent',async t=>{
 const f=await fixture(t),draft=await createPreparationDraft(f),outside=path.join(f.root,'unrelated.md');
 await fs.writeFile(outside,'foreign bytes');const target=path.join(draft.draftRoot,'plan.md');await fs.unlink(target);await fs.symlink(outside,target);
 await assert.rejects(capturePreparationDraft(f));assert.equal(await fs.readFile(outside,'utf8'),'foreign bytes');
});


test('legacy draft controls remain readable without moving or renewing approval',async t=>{
 const f=await fixture(t),draft=await createPreparationDraft(f);
 const modern=await preparationDraftPaths(f);
 const legacyRoot=path.join(path.dirname(f.specPath),path.parse(f.specPath).name+'-planning-draft-'+path.basename(f.candidateExecutionRoot));
 await fs.rename(draft.draftRoot,legacyRoot);
 const binding=JSON.parse(await fs.readFile(modern.binding));binding.draftRoot=legacyRoot;
 await fs.writeFile(legacyRoot+'.owner.json',JSON.stringify(binding)+'\n');await fs.unlink(modern.binding);
 const captured=await capturePreparationDraft(f);
 assert.equal(captured.draftRoot,legacyRoot);
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});
 assert.equal((await assertPreparationDraftApproval(f,{required:true})).captureSha256,captured.captureSha256);
 assert.equal((await preparationDraftPaths(f)).capture,legacyRoot+'.capture.json');
});

test('planning container cannot redirect draft writes through a symlink',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'outside');await fs.mkdir(outside);
 await fs.symlink(outside,path.join(path.dirname(f.specPath),path.parse(f.specPath).name+'-planning'));
 await assert.rejects(createPreparationDraft(f));assert.deepEqual(await fs.readdir(outside),[]);
});


test('explicit revision archives capture and approval and reuses the editable workspace',async t=>{
 const f=await fixture(t),draft=await createPreparationDraft(f),first=await capturePreparationDraft(f);
 await approvePreparationDraft({...f,approvedCaptureSha256:first.captureSha256});
 const controls=await preparationDraftPaths(f),oldCapture=await fs.readFile(controls.capture),oldApproval=await fs.readFile(controls.approval);
 await fs.appendFile(path.join(draft.draftRoot,'plan.md'),'\n');
 const revised=await revisePreparationDraft(f);assert.equal(revised.draftRoot,draft.draftRoot);
 assert.deepEqual(await fs.readFile(path.join(revised.archivedCapture,'capture.json')),oldCapture);
 assert.deepEqual(await fs.readFile(path.join(revised.archivedCapture,'approval.json')),oldApproval);
 await assert.rejects(fs.stat(controls.approval),{code:'ENOENT'});
 const second=await capturePreparationDraft(f);assert.notEqual(second.captureSha256,first.captureSha256);
 await assert.rejects(assertPreparationDraftApproval(f,{required:true}));
 await assert.rejects(approvePreparationDraft({...f,approvedCaptureSha256:first.captureSha256}));
 await approvePreparationDraft({...f,approvedCaptureSha256:second.captureSha256});
 assert.equal((await assertPreparationDraftApproval(f,{required:true})).captureSha256,second.captureSha256);
 assert.equal((await fs.readdir(path.dirname(draft.draftRoot))).length,1);
});

test('revision retry is harmless after capture invalidation',async t=>{
 const f=await fixture(t);await createPreparationDraft(f);await capturePreparationDraft(f);
 await revisePreparationDraft(f);const again=await revisePreparationDraft(f);assert.equal(again.status,'EDITABLE_DRAFT');
 await capturePreparationDraft(f);await assert.rejects(assertPreparationDraftApproval(f,{required:true}));
});

test('revision cannot archive controls through a foreign symlink',async t=>{
 const f=await fixture(t);await createPreparationDraft(f);await capturePreparationDraft(f);
 const controls=await preparationDraftPaths(f),outside=path.join(f.root,'foreign-history');await fs.mkdir(outside);
 await fs.symlink(outside,controls.capture+'.history');
 const original=await fs.readFile(controls.capture);await assert.rejects(revisePreparationDraft(f));
 assert.deepEqual(await fs.readFile(controls.capture),original);assert.deepEqual(await fs.readdir(outside),[]);
});


test('revision can reduce slices without stale technical copies or a new draft',async t=>{
 const f=await fixture(t),draft=await createPreparationDraft(f);await capturePreparationDraft(f);await revisePreparationDraft(f);
 for(const dir of ['plans','tasks'])await fs.unlink(path.join(draft.draftRoot,dir,'slice-02.md'));
 for(const name of ['plan.md','tasks.md','plans/slice-01.md','tasks/slice-01.md']){
  const file=path.join(draft.draftRoot,name);let text=await fs.readFile(file,'utf8');
  text=text.split('\n').filter(line=>!line.includes('| 02 - Verification |')).join('\n')
   .replaceAll('contribution: partial | full owner: slice-02','contribution: complete | full owner: slice-01');
  await fs.writeFile(file,text);
 }
 const captured=await capturePreparationDraft(f);assert.equal(captured.draftRoot,draft.draftRoot);
 for(const dir of ['plans','tasks'])assert.deepEqual(await fs.readdir(path.join(f.candidateExecutionRoot,dir)),['slice-01.md']);
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});
 assert.ok(await assertPreparationDraftApproval(f,{required:true}));
});

// Pause the write only after the producer has acquired its lock and checked
// authority. A competing revise must fail before it can invalidate these bytes.
for(const operation of ['approve','capture'])test(`concurrent ${operation} and revise cannot leave orphan approval or lose capture`,async t=>{
 const f=await fixture(t);await createPreparationDraft(f);
 const first=operation==='approve'?await capturePreparationDraft(f):null;
 const controls=await preparationDraftPaths(f),target=operation==='approve'?controls.approval:controls.capture;
 let signalEntered,releaseWrite;
 const entered=new Promise(resolve=>{signalEntered=resolve;}),gate=new Promise(resolve=>{releaseWrite=resolve;});
 const originalOpen=fs.open;
 let pending;
 fs.open=async function(file,...args){
  if(file===target){signalEntered();await gate;}
  return originalOpen.call(this,file,...args);
 };
 try{
  pending=operation==='approve'
   ?approvePreparationDraft({...f,approvedCaptureSha256:first.captureSha256})
   :capturePreparationDraft(f);
  // Race against failure so an admission regression cannot hang this test.
  await Promise.race([entered,pending.then(()=>{throw new Error('Expected paused control write');})]);
  const capturedBefore=operation==='approve'?await fs.readFile(controls.capture):null;
  await assert.rejects(revisePreparationDraft(f),/lock|owned|publication/iu);
  if(capturedBefore)assert.deepEqual(await fs.readFile(controls.capture),capturedBefore);
  releaseWrite();await pending;
 }finally{
  releaseWrite();fs.open=originalOpen;
  if(pending)await pending.catch(()=>{});
 }
 const captured=await fs.readFile(controls.capture);
 if(operation==='approve')assert.equal((await assertPreparationDraftApproval(f,{required:true})).captureSha256,first.captureSha256);
 else await assert.rejects(assertPreparationDraftApproval(f,{required:true}));
 // Once the first producer is settled, revision remains available and archives
 // exactly that capture. It cannot retain approval from the invalidated image.
 const revised=await revisePreparationDraft(f);
 assert.deepEqual(await fs.readFile(path.join(revised.archivedCapture,'capture.json')),captured);
 await assert.rejects(fs.stat(controls.capture),{code:'ENOENT'});
 await assert.rejects(fs.stat(controls.approval),{code:'ENOENT'});
 const replacement=await capturePreparationDraft(f);
 await assert.rejects(assertPreparationDraftApproval(f,{required:true}));
 await approvePreparationDraft({...f,approvedCaptureSha256:replacement.captureSha256});
 assert.equal((await assertPreparationDraftApproval(f,{required:true})).captureSha256,replacement.captureSha256);
});

test('interrupted Initial installation preserves approval and resumes without recapture or repeated approval',async t=>{
 const f=await fixture(t);await createPreparationDraft(f);const captured=await capturePreparationDraft(f);
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});
 const controls=await preparationDraftPaths(f),beforeCapture=await fs.readFile(controls.capture),beforeApproval=await fs.readFile(controls.approval);
 const {authority}=await serializePlanPathClaims(f),review=reviewFor(authority);
 const {installCurrentInitial}=await import('../skills/workflows/stnl-execution-planner/runtime/install-current-initial.mjs');
 const options={specPath:f.specPath,preparationRoot:f.candidateExecutionRoot,review};
 // Interrupt at publication lock acquisition, after Initial generated its exact
 // approved snapshot and continuity, before publication owns a transaction.
 const originalOpen=fs.open;
 let injected=false;
 fs.open=async function(file,...args){
  if(String(file).startsWith(f.root+path.sep)&&String(file).endsWith('.lock')&&(args[0]&fs.constants.O_EXCL)!==0
    &&await fs.lstat(path.join(f.candidateExecutionRoot,'continuity.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;})){
   injected=true;throw Object.assign(new Error('Controlled Initial publication lock failure'),{code:'EACCES'});
  }
  return originalOpen.call(this,file,...args);
 };
 try{await assert.rejects(installCurrentInitial(options),error=>error.code==='EACCES');}
 finally{fs.open=originalOpen;}
 assert.equal(injected,true);
 const generated=new Map();
 for(const name of ['approved-preparation.json','continuity.json'])generated.set(name,await fs.readFile(path.join(f.candidateExecutionRoot,name)));
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 await assert.rejects(revisePreparationDraft(f),error=>error.code==='PREPARATION_INSTALL_PENDING');
 assert.deepEqual(await fs.readFile(controls.capture),beforeCapture);
 assert.deepEqual(await fs.readFile(controls.approval),beforeApproval);
 await assert.rejects(fs.stat(controls.capture+'.history'),{code:'ENOENT'});
 for(const [name,bytes] of generated)assert.deepEqual(await fs.readFile(path.join(f.candidateExecutionRoot,name)),bytes);
 assert.equal((await assertPreparationDraftApproval(f,{required:true})).captureSha256,captured.captureSha256);
 // The original exact review and user approval suffice. No new candidate,
 // capture or approve call is needed after the transient I/O failure ends.
 const resumed=await installCurrentInitial(options);
 assert.equal(resumed.publication,'confirmed');
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'MATERIALIZED_PRISTINE');
});

test('repeated PLAN and create preserve captured bytes and explicit approval',async t=>{
 const f=await fixture(t),draft=await createPreparationDraft(f),captured=await capturePreparationDraft(f);
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});
 const files=await preparationDraftPaths(f),before=await Promise.all(Object.values(files).map(file=>fs.readFile(file)));
 const again=await preparePreparationCandidate({specPath:f.specPath,operation:'PLAN'});
 assert.equal(again.candidateExecutionRoot,f.candidateExecutionRoot);assert.equal(again.reused,true);
 assert.equal((await createPreparationDraft({...f,candidateExecutionRoot:again.candidateExecutionRoot})).draftRoot,draft.draftRoot);
 assert.deepEqual(await Promise.all(Object.values(files).map(file=>fs.readFile(file))),before);
 assert.equal((await assertPreparationDraftApproval(f,{required:true})).captureSha256,captured.captureSha256);
});

for(const changed of [false,true])test(`interrupted draft create cannot authorize partial capture; changed partial=${changed}`,async t=>{
 const f=await fixture(t),originalOpen=fs.open;
 const source=new Map();
 for(const name of ['plan.md','tasks.md','plans/slice-01.md','plans/slice-02.md','tasks/slice-01.md','tasks/slice-02.md'])source.set(name,await fs.readFile(path.join(f.candidateExecutionRoot,name)));
 let injected=false;
 fs.open=async function(file,...args){
  if(String(file).includes('-planning'+path.sep)&&String(file).endsWith(path.sep+'tasks.md')){
   injected=true;throw Object.assign(new Error('Controlled incomplete draft copy'),{code:'EACCES'});
  }
  return originalOpen.call(this,file,...args);
 };
 try{await assert.rejects(createPreparationDraft(f),{code:'EACCES'});}finally{fs.open=originalOpen;}
 assert.equal(injected,true);
 const controls=await preparationDraftPaths(f),pending=JSON.parse(await fs.readFile(controls.binding));
 assert.equal(pending.initializing,true);
 await assert.rejects(capturePreparationDraft(f),/initialization is incomplete/);
 for(const [name,bytes] of source)assert.deepEqual(await fs.readFile(path.join(f.candidateExecutionRoot,name)),bytes);
 if(changed){
  const plan=path.join(pending.draftRoot,'plan.md');await fs.appendFile(plan,'\nUser edit during interruption\n');
  const edited=await fs.readFile(plan);
  await assert.rejects(createPreparationDraft(f),/changed content/);
  assert.deepEqual(await fs.readFile(plan),edited);
  for(const [name,bytes] of source)assert.deepEqual(await fs.readFile(path.join(f.candidateExecutionRoot,name)),bytes);
 }else{
  const resumed=await createPreparationDraft(f);assert.equal(resumed.reused,true);
  assert.equal(JSON.parse(await fs.readFile(controls.binding)).initializing,undefined);
  for(const [name,bytes] of source)assert.deepEqual(await fs.readFile(path.join(resumed.draftRoot,name)),bytes);
  assert.equal((await capturePreparationDraft(f)).status,'AWAITING_USER_APPROVAL');
 }
});
