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
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {payload} from './fixtures/current-initial-evidence.mjs';
import {publishCandidate} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {preparationRegistryPath} from '../skills/workflows/stnl-execution-planner/runtime/execution-publication.mjs';
import {resolveExecutionWorkspace} from '../skills/workflows/stnl-execution-planner/runtime/execution-workspace.mjs';
import {createHash} from 'node:crypto';
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

test('B-T16 invalid draft is corrected in its same registered allocation before exact new review',async t=>{
 const f=await fixture(t),marker=await fs.readFile(f.candidateExecutionRoot+'.owner.json');
 const registry=await preparationRegistryPath(await resolveExecutionWorkspace(f.specPath));
 const association=()=>fs.readFile(registry,'utf8').then(JSON.parse);
 const file=path.join(f.candidateExecutionRoot,'plans/slice-01.md'),original=await fs.readFile(file,'utf8');
 await fs.writeFile(file,original.replace('## Dependencies\n\n- none','## Dependencies\n\n- none; explanatory prose'));
 await assert.rejects(publishPreparationCandidate(f),error=>/invalid dependency carrier/u.test(error.message));
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
 assert.equal((await association()).allocations.length,1);assert.equal((await association()).allocations[0].candidate,f.candidateExecutionRoot);
 await fs.writeFile(file,original);await publishPreparationCandidate(f);
 const {authority}=await serializePlanPathClaims(f);
 const result=await publishPreparationCandidate({...f,reviewDecision:reviewFor(authority)});
 assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');
 assert.ok(marker.length);assert.equal((await inspectCurrentExecution(f.specPath)).state,'MATERIALIZED_PRISTINE');
 assert.deepEqual((await association()).allocations,[]);
});

test('B-T14/B-T17 public padded authoring and CLI FAIL retry retain both captures through CLOSE',async t=>{
 const f=await fixture(t,{form:'lifecycle',single:true}),index=path.join(f.candidateExecutionRoot,'tasks.md');
 await fs.writeFile(index,(await fs.readFile(index,'utf8')).replace('| [ ] |','|   [ ]   |'));
 await publishPreparationCandidate(f);const {authority}=await serializePlanPathClaims(f);
 assert.equal((await publishPreparationCandidate({...f,reviewDecision:reviewFor(authority)})).publication,'confirmed');
 await run('git',['-C',f.root,'add','.gitignore','docs/spec/feature_spec.md','src/pay.test.mjs']);
 await run('git',['-C',f.root,'-c','user.name=Mechanical Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture base']);
 const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
 const call=async args=>{
  try{return JSON.parse((await run(process.execPath,[cli,...args])).stdout);}
  catch(error){error.message+='\n'+(error.stdout??'');throw error;}
 };
 const initial=await inspectCurrentExecution(f.specPath),started=await call(['begin','--spec-path',f.specPath,'--slice','slice-01',
   '--expected-activation-id',initial.activationId,'--operation','EXECUTE_SLICE']);
 const handle=path.join(f.root,'handle.json');await fs.writeFile(handle,JSON.stringify(started.handle));
 let failedSources;
 for(const round of [1,2]) {
  const dispatch=await call(['reserve-dispatch','--handle',handle,'--response-variant','stnl-current-native-judgment-v1']);
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),`export const pay=()=>${JSON.stringify(round===1?'broken':'paid')};\n`);
  const agentId='mechanical-fail-retry-'+round;await call(['bind-native','--handle',handle,'--agent-id',agentId]);
  const measured=await verifyNative(dispatch.originFile);assert.equal(measured.commands[0].exit,round===1?1:0);
  const {head,...result}=payload(round,round===1?'TESTS_FAIL':'TESTS_PASS',measured.commands[0].exit);result.commands=measured.commands;
  const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result}),tool=path.join(f.root,'mechanical-result-'+round+'.json');
  await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse}));
  const captured=await call(['capture-native','--handle',handle,'--tool-result-file',tool]);
  const resumed=await call(['resume','--handle',handle]);assert.equal(resumed.responseSha256,captured.rawResponseSha256);
  if(round===1){
   assert.equal(resumed.nextAction,'reserve-dispatch');
   failedSources=await Promise.all(['response','request','origin','observation','receipt'].map(async name=>{
    const file=path.join(path.dirname(dispatch.originFile),'round-1.'+name+'.json');return {file,bytes:await fs.readFile(file)};
   }));
   await assert.rejects(call(['publish','--handle',handle]),error=>/native terminal result has not been captured/u.test(error.stdout));
  }else assert.equal((await call(['publish','--handle',handle])).publication,'confirmed');
 }
 for(const item of failedSources)assert.deepEqual(await fs.readFile(item.file),item.bytes);
 const image=await inspectCurrentExecution(f.specPath);
 const formal=await begin({specPath:f.specPath,slice:'slice-01',expectedActivationId:image.activationId,operation:'VALIDATE_SLICE'});
 const formalHandle=path.join(f.root,'formal-handle.json');await fs.writeFile(formalHandle,JSON.stringify(formal.handle));
 const dispatch=await call(['reserve-dispatch','--handle',formalHandle,'--terminal','--response-variant','stnl-current-native-judgment-v1']);
 const agentId='mechanical-integral-fail-retry';await bindNative(formal.handle,agentId);const measured=await verifyNative(dispatch.originFile);
 const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:measured.commands,
   evidence:'Mechanical complete pay check passed after the retained failed round.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'No runner writes.'},newFindings:[]});
 // Same basename as the controller's private copy, but a separate caller-owned
 // directory. Geometry, not the filename, distinguishes input from output.
 const inputRoot=path.join(f.root,'tmp/native-results');await fs.mkdir(inputRoot);
 const tool=path.join(inputRoot,'round-1.tool-result.json'),inputBytes=JSON.stringify({agentId,status:'completed',finalResponse});
 await fs.writeFile(tool,inputBytes,{flag:'wx'});
 await call(['capture-native','--handle',formalHandle,'--tool-result-file',tool]);
 assert.equal(await fs.readFile(tool,'utf8'),inputBytes);
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(dispatch.originFile),'round-1.tool-result.json'),'utf8')),JSON.parse(inputBytes));
 await call(['publish','--handle',formalHandle]);
 const complete=await inspectCurrentExecution(f.specPath);assert.equal(complete.state,'COMPLETE');assert.equal(complete.deliveries[0].counters.implementationChecks,2);
 const bundle=JSON.parse(await fs.readFile(path.join(path.dirname(f.specPath),'execution/evidence',authority.deliveries[0].deliveryId+'.json')));
 const expected='sha256:'+createHash('sha256').update(failedSources[0].bytes).digest('hex');assert.ok(bundle.objects.some(item=>item.id===expected));
 const closed=await publishCandidate('CLOSE',path.dirname(f.specPath),null);assert.equal(closed.publication,'confirmed');assert.equal(closed.cleanup,'complete');
 assert.equal((await inspectCurrentExecution(f.specPath)).state,'SPEC_CLOSED');
});

test('public capture rejects a caller envelope aliasing the private formal output and preserves the partial proof',async t=>{
 const f=await fixture(t,{form:'lifecycle',single:true});
 await publishPreparationCandidate(f);const {authority}=await serializePlanPathClaims(f);
 await publishPreparationCandidate({...f,reviewDecision:reviewFor(authority)});
 await run('git',['-C',f.root,'add','.gitignore','docs/spec/feature_spec.md','src/pay.test.mjs']);
 await run('git',['-C',f.root,'-c','user.name=Mechanical Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture base']);
 let image=await inspectCurrentExecution(f.specPath);
 const execution=await begin({specPath:f.specPath,slice:'slice-01',expectedActivationId:image.activationId,operation:'EXECUTE_SLICE'});
 const prepared=await reserveDispatch(execution.handle,{responseVariant:'stnl-current-native-judgment-v1'});
 await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
 await bindNative(execution.handle,'mechanical-execute');const checked=await verifyNative(prepared.originFile);
 const {head,...result}=payload(1,'TESTS_PASS',0);result.commands=checked.commands;
 const initialInput=path.join(f.root,'execute-envelope.json');await fs.writeFile(initialInput,JSON.stringify({agentId:'mechanical-execute',status:'completed',finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result})}));
 await captureNative(execution.handle,initialInput);await publish(execution.handle);
 image=await inspectCurrentExecution(f.specPath);
 const formal=await begin({specPath:f.specPath,slice:'slice-01',expectedActivationId:image.activationId,operation:'VALIDATE_SLICE'});
 const handleFile=path.join(f.root,'formal-handle.json');await fs.writeFile(handleFile,JSON.stringify(formal.handle));
 const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
 const call=async args=>JSON.parse((await run(process.execPath,[cli,...args])).stdout);
 const dispatch=await call(['reserve-dispatch','--handle',handleFile,'--terminal','--response-variant','stnl-current-native-judgment-v1']);
 await call(['bind-native','--handle',handleFile,'--agent-id','mechanical-formal']);
 const observed=await call(['verify-native','--origin-file',dispatch.originFile]);
 const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result:{status:'PASS',commands:observed.commands,
  evidence:'Mechanical pay proof only.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'No runner writes.'},newFindings:[]});
 const privateRoot=path.dirname(dispatch.originFile),input=path.join(privateRoot,'round-1.tool-result.json');
 const inputBytes=JSON.stringify({agentId:'mechanical-formal',status:'completed',finalResponse});
 await fs.writeFile(input,inputBytes,{flag:'wx'});
 await assert.rejects(call(['capture-native','--handle',handleFile,'--tool-result-file',input]),error=>/EEXIST/u.test(error.stdout));
 assert.equal(await fs.readFile(input,'utf8'),inputBytes);
 assert.equal(await fs.readFile(path.join(privateRoot,'round-1.response.json'),'utf8'),finalResponse);
 const owner=JSON.parse(await fs.readFile(path.join(privateRoot,'owner.json'),'utf8'));
 assert.equal(owner.runner.status,'running');assert.equal(owner.candidate,null);
 assert.equal((await call(['resume','--handle',handleFile])).nextAction,'await-same-agent');
 await assert.rejects(inspectCurrentExecution(f.specPath),error=>error.code==='OWNER_UNCERTAIN');
 // Deliberately no recovery, publication, removal or rewritten conclusion.
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
