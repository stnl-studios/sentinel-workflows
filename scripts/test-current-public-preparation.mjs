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
import {READY_FIXTURE,copyTree} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
const run=promisify(execFile);
async function fixture(t,{form='standalone'}={}){
 const root=await fs.mkdtemp(path.resolve('tmp/public current preparation '));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await run('git',['-C',root,'init','-q']);await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
 const specPath=path.join(root,form==='lifecycle'?'docs/spec/feature_spec.md':'specs/pay/requirements.md');
 if(form==='lifecycle')await copyTree(READY_FIXTURE,path.dirname(specPath));
 else{await fs.mkdir(path.dirname(specPath),{recursive:true});await fs.writeFile(specPath,'# Pay\n\nAC-001: Export pay.\n');}
 await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/pay.test.mjs'),'import assert from "node:assert/strict";assert.equal(2+2,4);\n');
 const draft=await preparePreparationCandidate({specPath,operation:'PLAN'}),candidateExecutionRoot=draft.candidateExecutionRoot;
 for(const [name,bytes] of initialArtifacts({form})){
  const target=path.join(candidateExecutionRoot,name);await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,bytes.toString().replaceAll(REQUIREMENTS,draft.requirementsAuthority).replace(/^- Delivery ID: .+$/gmu,'- Delivery ID: runtime'));
 }
 return {root,specPath,candidateExecutionRoot};
}
function reviewFor(authority){
 const hashes=new Map(authority.artifactHashes.map(x=>[x.path,x.sha256]));
 const decision=(scope,sha,names)=>({scope,decision:'approved',authoritySha256:sha,examinedArtifactHashes:names.sort().map(name=>({path:name,sha256:hashes.get(name)})),evidenceDecisions:[],summary:'Mechanical test review of these exact current artifacts.'});
 return {globalReview:decision('set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:authority.deliveries.map(d=>({deliveryId:d.deliveryId,review:decision('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};
}
test('Public Initial keeps draft isolated, requires current exact review and publishes readable EC-1',async t=>{
 const f=await fixture(t);assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 assert.equal((await preparePreparationCandidate({...f,operation:'REVIEW_PLAN'})).status,'AWAITING_REVIEW');
 const awaiting=await publishPreparationCandidate(f);assert.equal(awaiting.publication,'not-started');
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 const {authority}=await serializePlanPathClaims(f),review=reviewFor(authority);
 await assert.rejects(publishPreparationCandidate({...f,reviewDecision:{decision:'approved',summary:'old review shape'}}),e=>e.code==='INVALID_CURRENT_IMAGE');
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 await publishPreparationCandidate({...f,reviewDecision:review});
 const image=await inspectCurrentExecution(f.specPath);assert.equal(image.normalHandoff.operation,'EXECUTE_SLICE');assert.equal(image.normalHandoff.slice,'slice-01');assert.equal(image.normalHandoff.deliveryId,authority.deliveries[0].deliveryId);
 const execution=path.join(f.root,'specs/pay/requirements-execution'),activation=await fs.readFile(path.join(execution,'activation.json'));
 assert.equal(JSON.parse(activation).format,'stnl-execution-activation-v2');
 assert.equal(JSON.parse(await fs.readFile(path.join(execution,'approved-preparation.json'))).format,'stnl-preparation-v3');
 for(const operation of ['PLAN','REPLAN'])await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation}),e=>e.code==='REPLAN_REQUIRED');
 await assert.rejects(publishPreparationCandidate({...f,reviewDecision:review}));
 assert.deepEqual(await fs.readFile(path.join(execution,'activation.json')),activation);
});
test('Public Initial refuses stale review bytes before any activation',async t=>{
 const f=await fixture(t);await publishPreparationCandidate(f);const {authority}=await serializePlanPathClaims(f),review=reviewFor(authority);
 const target=path.join(f.candidateExecutionRoot,'tasks/slice-01.md');await fs.appendFile(target,'\n');
 await assert.rejects(publishPreparationCandidate({...f,reviewDecision:review}),e=>e.code==='STALE_APPROVAL');
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
});

async function editDetails(f,transform){
 for(const group of ['plans','tasks'])for(const name of ['slice-01.md','slice-02.md']){
  const file=path.join(f.candidateExecutionRoot,group,name);
  await fs.writeFile(file,transform(await fs.readFile(file,'utf8')));
 }
}
for(const form of ['lifecycle','standalone'])test(`Public ${form} refuses documentary authority as Existing Input before review or publication`,async t=>{
 const f=await fixture(t,{form}),authorityBefore=await fs.readFile(f.specPath);
 const input='../../'+path.basename(f.specPath);
 await fs.writeFile(path.join(f.root,'REQUIREMENTS_SOURCE.md'),'Original user context, separately preserved.\n');
 const catalogue=['../../../../REQUIREMENTS_SOURCE.md',input,
  ...(form==='lifecycle'?['../../shared/requirements.md','../../shared/acceptance-criteria.md','../../shared/constraints.md']:[])];
 await editDetails(f,text=>text.replace('## Existing Inputs\n\n- none','## Existing Inputs\n\n'+catalogue.map(name=>'- `'+name+'`').join('\n')));
 const refusal=error=>error.code==='UNSAFE_PATH'&&/operational claim overlaps authority or execution controls/u.test(error.message);
 await assert.rejects(publishPreparationCandidate(f),refusal);
 await assert.rejects(serializePlanPathClaims(f),refusal);
 const cli=path.resolve('skills/workflows/stnl-plan-reviewer/runtime/serialize-plan-paths.mjs');
 await assert.rejects(run(process.execPath,[cli,'--spec-path',f.specPath,'--candidate-execution-root',f.candidateExecutionRoot]),
  error=>error.code===1&&/operational claim overlaps authority or execution controls/u.test(error.stderr));
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 assert.deepEqual(await fs.readFile(f.specPath),authorityBefore);
 assert.ok(await fs.lstat(f.candidateExecutionRoot+'.owner.json'));
 assert.ok((await fs.readFile(path.join(f.candidateExecutionRoot,'tasks/slice-01.md'),'utf8')).includes('- `'+input+'`'),'refusal never filters the declared input');
});

for(const form of ['lifecycle','standalone'])test(`Public ${form} retains Requirements source, real inputs and future outputs through publication`,async t=>{
 const f=await fixture(t,{form}),authorityBefore=await fs.readFile(f.specPath);
 await fs.mkdir(path.join(f.root,'docs'),{recursive:true});
 await fs.mkdir(path.join(f.root,'support'));await fs.writeFile(path.join(f.root,'support/oracle.mjs'),'import "../src/pay.mjs";\n');
 const annex=path.join(path.dirname(f.specPath),'annex');await fs.mkdir(annex);await fs.writeFile(path.join(annex,'input.txt'),'observed input, not an execution control\n');
 await editDetails(f,text=>{
  text=text.replace('- directory: `../../../../src`','- directory: `../../../../src`\n- file: `../../../../docs/report.md`')
   .replace('## Existing Inputs\n\n- none','## Existing Inputs\n\n- `../../../../support/oracle.mjs`\n- `../../annex/input.txt`');
  return text.split('\n').map(line=>{
   if(!line.startsWith('- Recipe: '))return line;
   const recipe=JSON.parse(line.slice('- Recipe: '.length));
   recipe.checks[0].args[1].file={kind:'input',path:'../../../../support/oracle.mjs'};
   recipe.checks[0].inputs=[{kind:'product',path:'../../../../src/pay.mjs'},{kind:'product',path:'../../../../docs/report.md'}];
   recipe.dependencyReview='The real oracle imports the future pay output. Documentary authority remains Requirements source; the annex is a separate read-only observation input.';
   return '- Recipe: '+JSON.stringify(recipe);
  }).join('\n');
 });
 const global=path.join(f.candidateExecutionRoot,'plan.md');
 await fs.writeFile(global,(await fs.readFile(global,'utf8')).replaceAll('directory: `../../../src`','directory: `../../../src`; file: `../../../docs/report.md`'));
 await publishPreparationCandidate(f);
 const {authority}=await serializePlanPathClaims(f);
 const published=await publishPreparationCandidate({...f,reviewDecision:reviewFor(authority)});
 assert.equal(published.publication,'confirmed');assert.equal(published.cleanup,'complete');
 const image=await inspectCurrentExecution(f.specPath);assert.equal(image.normalHandoff.operation,'EXECUTE_SLICE');
 const execution=path.join(path.dirname(f.specPath),form==='lifecycle'?'execution':'requirements-execution');
 const continuity=JSON.parse(await fs.readFile(path.join(execution,'continuity.json')));
 for(const row of continuity.deliveries){
  assert.ok(row.baseline.entries.some(item=>item.path==='support/oracle.mjs'&&item.kind==='file'));
  assert.ok(row.baseline.entries.some(item=>item.path.endsWith('/annex/input.txt')&&item.kind==='file'),'an unreferenced observation input remains explicit');
  assert.ok(row.baseline.entries.some(item=>item.path==='src/pay.mjs'&&item.kind==='absent'));
  assert.ok(row.baseline.entries.some(item=>item.path==='docs/report.md'&&item.kind==='absent'));
 }
 assert.deepEqual(await fs.readFile(f.specPath),authorityBefore);
 const cli=path.resolve('skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs');
 const fresh=JSON.parse((await run(process.execPath,[cli,f.specPath])).stdout);assert.equal(fresh.normalHandoff.operation,'EXECUTE_SLICE');
 assert.equal(await fs.readFile(path.join(annex,'input.txt'),'utf8'),'observed input, not an execution control\n');
});

for(const form of ['lifecycle','standalone'])for(const variant of ['escape','symlink'])test(`Public ${form} preserves containment and authority for ${variant} input`,async t=>{
 const f=await fixture(t,{form}),authorityBefore=await fs.readFile(f.specPath);
 await fs.mkdir(path.join(f.root,'support'));
 const alias=path.join(f.root,'support/authority-alias');
 if(variant==='symlink')await fs.symlink(f.specPath,alias);
 const input=variant==='escape'?'../../../../../outside.mjs':'../../../../support/authority-alias';
 await editDetails(f,text=>text.replace('## Existing Inputs\n\n- none','## Existing Inputs\n\n- `'+input+'`'));
 if(variant==='escape')await assert.rejects(publishPreparationCandidate(f),error=>error.code==='UNSAFE_PATH'&&/escapes productRoot/u.test(error.message));
 else{
  await publishPreparationCandidate(f);
  const {authority}=await serializePlanPathClaims(f);
  await assert.rejects(publishPreparationCandidate({...f,reviewDecision:reviewFor(authority)}),error=>error.code==='UNSAFE_PATH'&&/symlink/u.test(error.message));
  assert.ok((await fs.lstat(alias)).isSymbolicLink());assert.equal(await fs.readlink(alias),f.specPath);
 }
 assert.deepEqual(await fs.readFile(f.specPath),authorityBefore);
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 assert.ok(await fs.lstat(f.candidateExecutionRoot+'.owner.json'));
});
