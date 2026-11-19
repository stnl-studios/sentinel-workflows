import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {initialArtifacts,REQUIREMENTS} from './fixtures/current-initial-preparation.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {createPreparationDraft,capturePreparationDraft,revisePreparationDraft,approvePreparationDraft,preparationDraftPaths} from '../skills/workflows/stnl-execution-planner/runtime/preparation-draft.mjs';
import {inspectCurrentExecution} from '../skills/workflows/stnl-execution-planner/runtime/execution-current-reader.mjs';
import {serializePlanPathClaims} from '../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs';
import {READY_FIXTURE,copyTree} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
import {capturePlan,recoverUncapturedDraft} from '../benchmarks/sentinel/bench/workflow.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(t,{lifecycle=false}={}){
 const root=await fs.mkdtemp(path.join(repo,'benchmark-temp/draft-input-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 execFileSync('git',['-C',root,'init','-q']);await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
 const specPath=path.join(root,lifecycle?'specs/pay/feature_spec.md':'specs/pay/requirements.md');await fs.mkdir(path.dirname(specPath),{recursive:true});if(lifecycle)await copyTree(READY_FIXTURE,path.dirname(specPath));else await fs.writeFile(specPath,'# Pay\n\nAC-001: Export pay.\n');
 await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/pay.test.mjs'),'import assert from "node:assert/strict";import {pay} from "./pay.mjs";assert.equal(pay(),"paid");\n');
 const allocated=await preparePreparationCandidate({specPath,operation:'PLAN'}),candidateExecutionRoot=allocated.candidateExecutionRoot;
 for(const [name,bytes] of initialArtifacts({form:lifecycle?'lifecycle':'standalone'})){
  const file=path.join(candidateExecutionRoot,name);await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,bytes.toString().replaceAll(REQUIREMENTS,allocated.requirementsAuthority).replace(/^- Delivery ID: .+$/gmu,'- Delivery ID: runtime'));
 }
 const f={root,specPath,candidateExecutionRoot};f.draft=await createPreparationDraft(f);return f;
}
async function input(f,value){for(const name of ['plans/slice-02.md','tasks/slice-02.md']){const file=path.join(f.draft.draftRoot,name);const s=await fs.readFile(file,'utf8');await fs.writeFile(file,s.replace(/(## Existing Inputs\n\n)[\s\S]*?(?=\n## )/,`$1${value}\n`));}}
async function absentControls(f){const p=await preparationDraftPaths(f);for(const file of [p.capture,p.approval])await assert.rejects(fs.lstat(file),e=>e.code==='ENOENT');}
for(const kind of ['absent','directory'])test(`initial draft ${kind} input is typed; official revise and corrected category recover without precreating product`,async t=>{
 const f=await fixture(t);if(kind==='directory')await fs.mkdir(path.join(f.root,'src/future.mjs'));
 await input(f,kind==='absent'?'- `../../../../src/pay.mjs`':'- `../../../../src/future.mjs`');
 await assert.rejects(capturePreparationDraft(f),e=>e.code==='INVALID_CURRENT_IMAGE'&&e.reasonCode==='DRAFT_EXISTING_INPUT_UNAVAILABLE'&&e.inputReasonCode===(kind==='absent'?'EXISTING_INPUT_ABSENT':'EXISTING_INPUT_NOT_FILE'));
 await absentControls(f);assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 // Same official preflight outside uncaptured initial capture retains stale classification.
 await assert.rejects(serializePlanPathClaims(f),e=>e.code==='EVIDENCE_STALE'&&e.reasonCode===(kind==='absent'?'EXISTING_INPUT_ABSENT':'EXISTING_INPUT_NOT_FILE'));
 assert.equal((await revisePreparationDraft(f)).status,'EDITABLE_DRAFT');
 await input(f,'- none');const captured=await capturePreparationDraft(f);assert.equal(captured.status,'AWAITING_USER_APPROVAL');
 await assert.rejects(fs.lstat(path.join(f.root,'src/pay.mjs')),e=>e.code==='ENOENT');
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});await input(f,'- `../../../../src/future.mjs`');
 await assert.rejects(capturePreparationDraft(f),e=>e.code==='STALE_APPROVAL'&&e.reasonCode!=='DRAFT_EXISTING_INPUT_UNAVAILABLE');
});
test('legitimate existing input captures; orphan approval and installation markers never become editable input failures',async t=>{
 const f=await fixture(t);await input(f,'- `../../../../src/pay.test.mjs`');const captured=await capturePreparationDraft(f);assert.equal(captured.status,'AWAITING_USER_APPROVAL');
 await approvePreparationDraft({...f,approvedCaptureSha256:captured.captureSha256});await fs.unlink(path.join(f.root,'src/pay.test.mjs'));
 await assert.rejects(serializePlanPathClaims(f),e=>e.code==='EVIDENCE_STALE'&&e.reasonCode==='EXISTING_INPUT_ABSENT');
 await assert.rejects(capturePreparationDraft(f),e=>e.code==='STALE_APPROVAL');
 for(const marker of ['approval','approved-preparation.json','continuity.json']){
  const bad=await fixture(t);await input(bad,'- `../../../../src/future.mjs`');const p=await preparationDraftPaths(bad);
  await fs.writeFile(marker==='approval'?p.approval:path.join(bad.candidateExecutionRoot,marker),'{}');
  await assert.rejects(capturePreparationDraft(bad),e=>['STALE_APPROVAL','PREPARATION_INSTALL_PENDING'].includes(e.code)&&e.reasonCode!=='DRAFT_EXISTING_INPUT_UNAVAILABLE');
 }
});

test('real adapter preserves typed draft rejection and uses official revision on same allocation',async t=>{
 const f=await fixture(t,{lifecycle:true}),home=path.join(f.root,'isolated-home'),codexHome=path.join(home,'.codex');
 for(const skill of ['stnl-execution-planner','stnl-slice-executor','stnl-spec-lifecycle-manager'])await fs.cp(path.join(repo,'skills/workflows',skill),path.join(codexHome,'skills',skill),{recursive:true});
 const spec=path.dirname(f.specPath);const m={home,codexHome,workspace:f.root,tmpDir:path.join(f.root,'tmp'),caseId:'pay',engineRoot:path.join(repo,'benchmarks/sentinel/bench')};
 await input(f,'- `../../../../src/pay.mjs`');let error;
 try{capturePlan(m,spec,f.candidateExecutionRoot);assert.fail('must reject unapproved input');}catch(e){error=e;}
 assert.equal(error.code,'INVALID_CURRENT_IMAGE');assert.equal(error.reasonCode,'DRAFT_EXISTING_INPUT_UNAVAILABLE');assert.equal(error.operation,'capturePreparationDraft');
 await absentControls(f);const recovered=recoverUncapturedDraft(m,spec,f.candidateExecutionRoot,error,{providerTurnCompleted:true,transportIdle:true});
 assert.equal(recovered.status,'EDITABLE_DRAFT');assert.equal(recovered.draftRoot,f.draft.draftRoot);assert.equal(recovered.executionAuthority,false);
 await input(f,'- none');assert.equal(capturePlan(m,spec,f.candidateExecutionRoot).status,'AWAITING_USER_APPROVAL');
 await assert.rejects(fs.lstat(path.join(f.root,'src/pay.mjs')),e=>e.code==='ENOENT');
 assert.throws(()=>recoverUncapturedDraft(m,spec,f.candidateExecutionRoot,error,{providerTurnCompleted:true,transportIdle:true}),e=>e.code==='RECOVERY_CONTROL_PRESENT');
});
