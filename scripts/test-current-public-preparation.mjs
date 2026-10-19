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
const run=promisify(execFile);
async function fixture(t){
 const root=await fs.mkdtemp(path.resolve('tmp/public current preparation '));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await run('git',['-C',root,'init','-q']);await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
 const specPath=path.join(root,'specs/pay/requirements.md');await fs.mkdir(path.dirname(specPath),{recursive:true});await fs.writeFile(specPath,'# Pay\n\nAC-001: Export pay.\n');
 await fs.mkdir(path.join(root,'src'));await fs.writeFile(path.join(root,'src/pay.test.mjs'),'import assert from "node:assert/strict";assert.equal(2+2,4);\n');
 const draft=await preparePreparationCandidate({specPath,operation:'PLAN'}),candidateExecutionRoot=draft.candidateExecutionRoot;
 for(const [name,bytes] of initialArtifacts({form:'standalone'})){
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
