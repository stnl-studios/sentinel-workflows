import {publishPreparationCandidate} from './fixtures/synthetic-preparation-approval.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initialArtifacts,REQUIREMENTS} from './fixtures/current-initial-preparation.mjs';
import {projectInitialPreparation} from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs';
import {preflightCurrentPreparationPaths,inspectCurrentExecution} from '../skills/workflows/stnl-execution-planner/runtime/execution-current-reader.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';

import {serializePlanPathClaims} from '../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs';
const run=promisify(execFile);
async function fixture(t,{input=false,broad=false,nested=false}={}) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'future output ')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const spec=path.join(root,'specs/pay');await fs.mkdir(spec,{recursive:true});
 const context={logicalSpecRoot:null,logicalAuthorityPath:path.join(spec,'requirements.md'),
  logicalExecutionRoot:path.join(spec,'requirements-execution'),physicalExecutionRoot:path.join(spec,'requirements-execution'),productRoot:root};
 await fs.writeFile(context.logicalAuthorityPath,'# Pay\n\nAC-001: Export pay.\n');
 let artifacts=new Map([...initialArtifacts({form:'standalone'})].map(([name,bytes])=>[name,Buffer.from(bytes.toString()
  .replaceAll('../../../../src','../../verificacao/future').replaceAll('../../../src','../verificacao/future'))]));
 if(input)artifacts=new Map([...artifacts].map(([name,bytes])=>[name,Buffer.from(bytes.toString()
  .replace('## Existing Inputs\n\n- none','## Existing Inputs\n\n- `../../verificacao/input.json`'))]));
 if(!broad)artifacts=new Map([...artifacts].map(([name,bytes])=>[name,Buffer.from(bytes.toString()
  .replaceAll('- directory: `../../verificacao/future`','- file: `../../verificacao/future/pay.mjs`\n- file: `../../verificacao/future/pay.test.mjs`')
  .replaceAll('directory: `../verificacao/future`','file: `../verificacao/future/pay.mjs`; file: `../verificacao/future/pay.test.mjs`'))]));
 if(nested)artifacts=new Map([...artifacts].map(([name,bytes])=>[name,Buffer.from(bytes.toString()
  .replaceAll('future/pay','future/new/pay'))]));
 const authority=projectInitialPreparation({context,requirementsAuthority:REQUIREMENTS,artifacts});
 return {root,spec,context,artifacts,authority};
}
function reviewFor(authority) {
 const hashes=new Map(authority.artifactHashes.map(row=>[row.path,row.sha256]));
 const decision=(scope,sha,names)=>({scope,decision:'approved',authoritySha256:sha,
  examinedArtifactHashes:names.sort().map(name=>({path:name,sha256:hashes.get(name)})),evidenceDecisions:[],summary:'Independent mechanical review of exact fixture bytes.'});
 return {globalReview:decision('set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md']),
  deliveries:authority.deliveries.map(d=>({deliveryId:d.deliveryId,review:decision('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};
}
test('exact future output files beneath SPEC are proven absent without creating directories',async t=>{
 const f=await fixture(t),result=await preflightCurrentPreparationPaths(f);
 assert.equal(result.status,'PASS');
 for(const observation of result.observations) {
  assert.ok(observation.manifest.entries.some(entry=>entry.path==='specs/pay/verificacao'&&entry.kind==='absent'));
  assert.ok(!observation.manifest.entries.some(entry=>entry.path==='specs/pay/verificacao/future'));
 }
 assert.equal(await fs.stat(path.join(f.spec,'verificacao')).catch(()=>null),null);
 assert.equal(await fs.stat(f.context.logicalExecutionRoot).catch(()=>null),null);
});
test('missing Existing Input fails before review without creating output or execution',async t=>{
 const f=await fixture(t,{input:true});
 await assert.rejects(preflightCurrentPreparationPaths(f),e=>e.code==='EVIDENCE_STALE'&&/Existing Input/u.test(e.message));
 assert.equal(await fs.stat(path.join(f.spec,'verificacao')).catch(()=>null),null);
 assert.equal(await fs.stat(f.context.logicalExecutionRoot).catch(()=>null),null);
});
for(const kind of ['file-ancestor','symlink-ancestor'])test(`future output rejects ${kind} without following or changing it`,async t=>{
 const f=await fixture(t),target=path.join(f.spec,'verificacao');
 if(kind==='file-ancestor')await fs.writeFile(target,'preserve');
 else await fs.symlink(f.root,target);
 await assert.rejects(preflightCurrentPreparationPaths(f),e=>['EVIDENCE_STALE','UNSAFE_PATH','EVIDENCE_INCOMPLETE'].includes(e.code));
 assert.equal(kind==='file-ancestor'?await fs.readFile(target,'utf8'):await fs.readlink(target),kind==='file-ancestor'?'preserve':f.root);
 assert.equal(await fs.stat(f.context.logicalExecutionRoot).catch(()=>null),null);
});
test('future output passes full reviewed Initial publication without mkdir workaround',async t=>{
 const f=await fixture(t);await run('git',['init','-q',f.root]);await fs.writeFile(path.join(f.root,'.gitignore'),'/tmp/\n');
 const specPath=f.context.logicalAuthorityPath,start=await preparePreparationCandidate({specPath,operation:'PLAN'}),candidateExecutionRoot=start.candidateExecutionRoot;
 for(const [name,bytes] of f.artifacts) {
  const target=path.join(candidateExecutionRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,bytes.toString().replaceAll(REQUIREMENTS,start.requirementsAuthority).replace(/^- Delivery ID: .+$/gmu,'- Delivery ID: runtime'));
 }
 assert.equal((await publishPreparationCandidate({specPath,candidateExecutionRoot})).publication,'not-started');
 const {authority}=await serializePlanPathClaims({specPath,candidateExecutionRoot});
 const result=await publishPreparationCandidate({specPath,candidateExecutionRoot,reviewDecision:reviewFor(authority)});
 assert.equal(result.publication,'confirmed');
 assert.equal((await inspectCurrentExecution(specPath)).state,'MATERIALIZED_PRISTINE');
 assert.equal(await fs.stat(path.join(f.spec,'verificacao')).catch(()=>null),null);
});

const unsupported=e=>e.code==='UNSUPPORTED_FORMAT'&&/exact file:/.test(e.message)&&/slice-01/.test(e.message);
test('absent broad directory fails preflight with actionable diagnostic',async t=>{
 const f=await fixture(t,{broad:true});await assert.rejects(preflightCurrentPreparationPaths(f),unsupported);
 assert.equal(await fs.stat(path.join(f.spec,'verificacao')).catch(()=>null),null);
});
test('existing broad directory remains supported',async t=>{
 const f=await fixture(t,{broad:true});await fs.mkdir(path.join(f.spec,'verificacao/future'),{recursive:true});
 assert.equal((await preflightCurrentPreparationPaths(f)).status,'PASS');
});
test('predicted files beneath absent child of existing broad directory require exact areas',async t=>{
 const f=await fixture(t,{broad:true,nested:true});await fs.mkdir(path.join(f.spec,'verificacao/future'),{recursive:true});
 await assert.rejects(preflightCurrentPreparationPaths(f),unsupported);
 assert.equal(await fs.stat(path.join(f.spec,'verificacao/future/new')).catch(()=>null),null);
});
test('broad future directory capture fails before snapshot and approval',async t=>{
 const f=await fixture(t,{broad:true});await run('git',['init','-q',f.root]);await fs.writeFile(path.join(f.root,'.gitignore'),'/tmp/\n');
 const specPath=f.context.logicalAuthorityPath,start=await preparePreparationCandidate({specPath,operation:'PLAN'});
 const options={specPath,candidateExecutionRoot:start.candidateExecutionRoot};
 const {createPreparationDraft,capturePreparationDraft,preparationDraftPaths}=await import('../skills/workflows/stnl-execution-planner/runtime/preparation-draft.mjs');
 const draft=await createPreparationDraft(options);
 for(const [name,bytes] of f.artifacts){
  const target=path.join(draft.draftRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,bytes.toString().replaceAll(REQUIREMENTS,start.requirementsAuthority).replace(/^- Delivery ID: .+$/gmu,'- Delivery ID: runtime'));
 }
 await assert.rejects(capturePreparationDraft(options),unsupported);
 const paths=await preparationDraftPaths(options);
 for(const target of [paths.capture,paths.approval,path.join(f.spec,'verificacao'),f.context.logicalExecutionRoot])
  assert.equal(await fs.stat(target).catch(()=>null),null);
 assert.ok((await fs.readFile(path.join(draft.draftRoot,'plan.md'),'utf8')).includes('directory:'));
});
test('all seven current readers stay byte-identical',async()=>{
 const names=['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor','stnl-slice-quality-manager','stnl-spec-roadmap','stnl-spec-test-runbook','stnl-spec-lifecycle-manager'];
 const readers=await Promise.all(names.map(name=>fs.readFile(new URL(`../skills/workflows/${name}/runtime/${name==='stnl-spec-lifecycle-manager'?'lib/':''}execution-current-reader.mjs`,import.meta.url))));
 for(const bytes of readers)assert.deepEqual(bytes,readers[0]);
});

test('recipe product under absent child requires exact area even without Expected Files',async t=>{
 const f=await fixture(t,{broad:true,nested:true});await fs.mkdir(path.join(f.spec,'verificacao/future'),{recursive:true});
 f.artifacts=new Map([...f.artifacts].map(([name,bytes])=>[name,Buffer.from(bytes.toString()
  .replace(/(## Expected Files\n\n)[\s\S]*?(?=\n## )/u,'$1- none\n'))]));
 f.authority=projectInitialPreparation({context:f.context,requirementsAuthority:REQUIREMENTS,artifacts:f.artifacts});
 await assert.rejects(preflightCurrentPreparationPaths(f),unsupported);
});
test('exact future leaves under an absent child remain supported',async t=>{
 const f=await fixture(t,{nested:true});await fs.mkdir(path.join(f.spec,'verificacao/future'),{recursive:true});
 assert.equal((await preflightCurrentPreparationPaths(f)).status,'PASS');
 assert.equal(await fs.stat(path.join(f.spec,'verificacao/future/new')).catch(()=>null),null);
});
