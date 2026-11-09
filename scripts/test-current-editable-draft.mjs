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
import {createPreparationDraft,capturePreparationDraft,approvePreparationDraft,assertPreparationDraftApproval,preparationDraftPaths} from '../skills/workflows/stnl-execution-planner/runtime/preparation-draft.mjs';
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
 assert.equal(path.dirname(draft.draftRoot),path.dirname(f.specPath));
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
test('a later registered preparation gets a distinct editable directory',async t=>{
 const f=await fixture(t),first=await createPreparationDraft(f);
 const second=await preparePreparationCandidate({specPath:f.specPath,operation:'PLAN'});
 const next=await createPreparationDraft({specPath:f.specPath,candidateExecutionRoot:second.candidateExecutionRoot});
 assert.notEqual(first.draftRoot,next.draftRoot);assert.equal((await fs.stat(first.draftRoot)).isDirectory(),true);
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
