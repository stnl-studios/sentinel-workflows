import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture,approveFixture,reviewDecision} from './test-p1b-preparation.mjs';
import {implementOffline} from './test-p1b-publication.mjs';
import {inspectExecutionState,readExecutionActivation,readRunnerVerification,beginPreparedExecutionOperation,readDeliveryContinuity,inspectDeliveryContinuity,resolveExecutionWorkspace,validateExecutionCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {prepareExecutionCopy,publishExecutionCopy} from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import {startNativeRunnerCapture,bindNativeRunnerIdentity,captureNativeRunnerResult,runNativeRunnerVerification} from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import {serializeRunnerExecutionBundleFromResponse,insertExecutionEvidenceInCandidate} from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import {prepareValidationCopy} from '../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import {prepareValidationCandidate} from '../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import {publishValidationCandidate} from '../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {publishPreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {readPreparationArtifacts,updateOperationalChecklist} from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';

import {verificationCommand} from '../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';

export const setSection=(text,heading,body)=>text.replace(new RegExp(`(^## ${heading}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu'),`$1${body}\n\n`);
const commandEnvironment={...process.env};delete commandEnvironment.NODE_TEST_CONTEXT;
export async function observedGreeting(f,directory='src',testCount=1) {
  const result=spawnSync(process.execPath,['--test',`${directory}/greeting.test.mjs`],{cwd:f.root,env:commandEnvironment,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,new RegExp(`^# tests ${testCount}$`,'mu'));assert.match(result.stdout,new RegExp(`^# pass ${testCount}$`,'mu'));
  return result.stdout;
}
export async function native(f,owner) {
  const start=await startNativeRunnerCapture({specPath:f.specPath,owner,workspace:f.root,captureParent:f.root});
  const agentId=`u2-offline-${randomUUID()}`;f.invocations=(f.invocations ?? 0)+1;
  await bindNativeRunnerIdentity({...start,agentId});return {...start,agentId};
}
export const capture=async(start,response,changedAreas=null)=>{await runNativeRunnerVerification({originFile:start.originFile});return captureNativeRunnerResult({originFile:start.originFile,
  result:{agentId:start.agentId,status:'completed',finalResponse:JSON.stringify(response)},changedAreas});};
export async function evidence(f,label,details={}) {
  const output=path.join(f.root,`u2-${label}-proof.json`);
  await fs.writeFile(output,JSON.stringify({externalCalls:0,fixture:f.root,specPath:f.specPath,invocations:f.invocations ?? null,...details},null,2)+'\n');
  if(process.env.STNL_U2_EVIDENCE_PARENT) await fs.copyFile(output,path.join(process.env.STNL_U2_EVIDENCE_PARENT,`${label}-${path.basename(f.root)}.json`));
  console.log(`U2 preserved ${label}: ${output}`);
}
export async function implementedFixture() {
  const f=await fixture();const approved=await approveFixture(f);
  const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const implementation=await implementOffline(f,admitted);f.invocations=1;
  const publication=await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot});
  return {...f,implementation,publication};
}
export async function formal(f,{reuse=null,publish=true,slice='slice-01',directory='src',responseOverride=null,editCandidate=null,testCount=1}={}) {
  const current=await readExecutionActivation(f.specPath);
  const admitted=reuse?.admitted ?? await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE',BigInt(slice.slice(6)).toString(),current.activation.activationId);
  const ownerFile=path.join(f.root,'u2-operation-owner.json');await fs.writeFile(ownerFile,JSON.stringify({specPath:f.specPath,owner:admitted.owner}));
  const previous=process.env.STNL_OPERATION_OWNER_FILE;process.env.STNL_OPERATION_OWNER_FILE=ownerFile;
  try {
    const parent=path.join(f.root,'u2-formal-candidates');await fs.mkdir(parent,{recursive:true});
    const start=reuse?.start ?? await native(f,admitted.owner);
    const copy=await prepareValidationCopy({specPath:f.specPath,slice,candidateParent:parent,owner:admitted.owner});
    if(editCandidate) await editCandidate(copy);
    const response=reuse?.response ?? {status:'PASS',head:'u2-offline-working-tree',commands:(await readRunnerVerification(f.specPath,slice)).checks.map(check=>({command:verificationCommand(check),exit:0})),
      evidence:await observedGreeting(f,directory,testCount),findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve the concluded result and its receipt'};
    if(responseOverride) Object.assign(response,responseOverride);
    const captured=reuse?.captured ?? await capture(start,response);
    const prepared=await prepareValidationCandidate({specPath:f.specPath,slice,workspace:f.root,candidateExecutionRoot:copy.candidateExecutionRoot,...captured});
    const publication=publish ? await publishValidationCandidate({specPath:f.specPath,slice,candidateExecutionRoot:copy.candidateExecutionRoot,owner:admitted.owner}) : null;
    return {admitted,start,response,captured,prepared,copy,publication};
  } finally {if(previous===undefined)delete process.env.STNL_OPERATION_OWNER_FILE;else process.env.STNL_OPERATION_OWNER_FILE=previous;}
}
export async function revise(f,{proof='node --test src/greeting.test.mjs (also assert exact export contract)',revision=null,slice='slice-01',exerciseNegatives=false,globalStrategy=null,recipe=null}={}) {
  const before=await inspectExecutionState(f.specPath);const r=revision ?? before.globalPlan.revision+1;
  const p=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',revisionMode:'same-delivery-revision'});
  const id=before.preparation.deliveries.find(d=>d.slice===slice).deliveryId;
  const header='| Slice | Prior delivery ID | Relation | Prior preparation revision | Reason | Affected verification |\n|---|---|---|---|---|---|';
  let plan=await fs.readFile(path.join(p.candidateExecutionRoot,'plan.md'),'utf8');
  plan=setSection(plan,'Delivery Continuity',`${header}\n`+before.preparation.deliveries.map(d=>`| ${d.slice} | ${d.deliveryId} | same | ${before.tasks.get(d.slice).revision} | Greeting result remains identical; strengthen observable proof | ${d.slice===slice ? 'greeting assertion' : 'unchanged'} |`).join('\n'));
  plan=plan.replace('- Review state: approved','- Review state: pending');
  if(globalStrategy) plan=plan.replace(/^- Strategy: .+$/mu,`- Strategy: ${globalStrategy}`);
  plan=plan.replace('- Replan reason:', '- Replan reason:');
  if (!plan.includes('- Replan reason:')) plan=plan.replace('- Strategy:', '- Replan reason: The same greeting result needs stronger proof\n- Strategy:');
  await fs.writeFile(path.join(p.candidateExecutionRoot,'plan.md'),plan);
  for (const name of [`plans/${slice}.md`,`tasks/${slice}.md`]) {
    const file=path.join(p.candidateExecutionRoot,name);let text=setSection(await fs.readFile(file,'utf8'),'Expected Tests',`- ${proof}`);if(recipe)text=setSection(text,'Verification Recipe',recipe);await fs.writeFile(file,text);
  }
  if(exerciseNegatives) {
    const live=await fs.readFile(path.join(f.workspace.executionRoot,'activation.json'));const injected=randomUUID();const originals=[];
    for(const name of [`plans/${slice}.md`,`tasks/${slice}.md`]) {const file=path.join(p.candidateExecutionRoot,name);const bytes=await fs.readFile(file);originals.push([file,bytes]);await fs.writeFile(file,bytes.toString('utf8').replaceAll(id,injected));}
    await assert.rejects(publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:p.candidateExecutionRoot}),/model-supplied delivery identity differs/);
    assert.deepEqual(await fs.readFile(path.join(f.workspace.executionRoot,'activation.json')),live);for(const [file,bytes]of originals)await fs.writeFile(file,bytes);
  }
  await publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:p.candidateExecutionRoot});
  const review=await preparePreparationCandidate({specPath:f.specPath,operation:'REVIEW_PLAN'});
  for (const [name,text] of await readPreparationArtifacts(review.candidateExecutionRoot)) await fs.writeFile(path.join(review.candidateExecutionRoot,name),text.replace('status: draft','status: ready').replace('- Review state: pending','- Review state: approved'));
  if(exerciseNegatives) {
    const before=await fs.readFile(path.join(f.workspace.executionRoot,'plan.md'));
    const file=path.join(review.candidateExecutionRoot,`tasks/${slice}.md`);const original=await fs.readFile(file);
    await fs.writeFile(file,setSection(original.toString('utf8'),'Result','Independent audit endpoint beyond greeting acceptance.'));
    await assert.rejects(publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:review.candidateExecutionRoot,reviewDecision:{...reviewDecision,status:'blocked',summary:'Controlled independent review refuses new independent audit result under the old greeting delivery identity.'}}),/approved|review/);
    assert.deepEqual(await fs.readFile(path.join(f.workspace.executionRoot,'plan.md')),before);await fs.writeFile(file,original);
  }
  await publishPreparationCandidate({specPath:f.specPath,candidateExecutionRoot:review.candidateExecutionRoot,reviewDecision:{...reviewDecision,summary:'Controlled offline semantic decision: same greeting result/obligations/boundaries; only its proof changes. This fixture does not certify LLM judgment.'}});
  return {r,id,p,review};
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
test('U2-A01 legitimate correction preserves delivery, failed check and counters',async()=>{
  const f=await fixture();const approved=await approveFixture(f);const id=approved.authority.deliveries[0].deliveryId;
  const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const first=await implementOffline(f,admitted,{forceFail:true});f.invocations=1;
  const candidateBefore=await fs.readFile(first.copy.candidateTaskArtifact);
  await assert.rejects(updateOperationalChecklist({candidateExecutionRoot:first.copy.candidateExecutionRoot,slice:'slice-01',reason:'Attempt to smuggle an independent endpoint into the technical checklist',checklist:'- [ ] 1.1 Implement unrelated audit endpoint | obligations: obligation-99'}),/obligation/);
  assert.deepEqual(await fs.readFile(first.copy.candidateTaskArtifact),candidateBefore);
  const started=await startNativeRunnerCapture({specPath:f.specPath,owner:admitted.owner,workspace:f.root,captureParent:f.root,candidateTaskArtifact:first.copy.candidateTaskArtifact});
  const agentId=`u2-round2-${randomUUID()}`;await bindNativeRunnerIdentity({...started,agentId});f.invocations++;
  await fs.writeFile(path.join(f.root,'src/unpredicted.mjs'),'export const greeting="hello";\n');await observedGreeting(f);
  let task=await fs.readFile(first.copy.candidateTaskArtifact,'utf8');task=setSection(task,'Corrections Applied','- `../../src/unpredicted.mjs`');await fs.writeFile(first.copy.candidateTaskArtifact,task);
  const response={...first.response,status:'TESTS_PASS',automaticCheckRound:'2/3',commands:[{command:first.command,exit:0}],failures:'none',priorRoundFailure:'Greeting was wrong in the observed first round',correctionApplied:'Correct greeting export within the approved result',inSliceRationale:'Same greeting obligation and boundary',evidenceOrFailureSummary:'Observed corrected greeting assertion'};
  const captured=await capture({...started,agentId},response,['../../src/greeting.test.mjs','../../src/unpredicted.mjs']);
  const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'EXECUTE_SLICE',response:JSON.stringify(response),workspace:f.root,taskArtifact:first.copy.candidateTaskArtifact,...captured});
  await insertExecutionEvidenceInCandidate({taskArtifact:first.copy.candidateTaskArtifact,operation:'EXECUTE_SLICE',bundle,validateProspectiveTask:task=>validateExecutionCandidate(f.specPath,first.copy.candidateExecutionRoot,[task])});
  await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:first.copy.candidateRoot});await formal(f);
  const state=await inspectExecutionState(f.specPath);assert.equal(state.state,'COMPLETE');assert.equal(state.preparation.deliveries[0].deliveryId,id);
  assert.deepEqual(state.tasks.get('slice-01').implementationChecks.map(c=>[c.id,c.status]),[['implementation-check-01','TESTS_FAIL'],['implementation-check-02','TESTS_PASS']]);
  await evidence(f,'A01',{deliveryId:id,checks:state.tasks.get('slice-01').implementationChecks.map(c=>c.id)});
});
test('U2-A02 same delivery revision retains slot, snapshot and proof history',async()=>{
  const f=await implementedFixture();await formal(f);const revision=await revise(f,{exerciseNegatives:true});
  const state=await inspectExecutionState(f.specPath);assert.equal(state.preparation.deliveries.length,1);assert.equal(state.preparation.deliveries[0].deliveryId,revision.id);
  assert.equal(state.globalPlan.revision,2);assert.equal(state.tasks.get('slice-01').attempts[0].id,'attempt-01');
  await formal(f);const after=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(after.latestAttempt,'attempt-02');assert.equal(after.currentValidation,'current');assert.equal(after.history.length,1);
  await evidence(f,'A02',{after});
});
test('U2-A03 historical PASS survives product and test drift, new attempt restores current',async()=>{
  const f=await implementedFixture();await formal(f);const before=await readExecutionActivation(f.specPath);
  await fs.appendFile(path.join(f.root,'src/greeting.test.mjs'),'// proof input changed\n');
  const drift=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(drift.currentValidation,'revalidation-required');assert.equal(drift.historicalPass,'attempt-01');assert.notEqual(drift.state,'COMPLETE');
  assert.deepEqual((await readExecutionActivation(f.specPath)).activation,before.activation);
  await formal(f);const after=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(after.currentValidation,'current');assert.equal(after.latestAttempt,'attempt-02');
  await evidence(f,'A03',{beforeActivation:before.activation.activationId,drift,after});
});
test('U2-A04 a second delivery proof revision demonstrably preserves the first current PASS',async()=>{
  const f=await fixture();await fs.mkdir(path.join(f.root,'second'));await fs.appendFile(f.specPath,'AC-002: Export a separate deterministic greeting with independent files.\n');
  let global=await fs.readFile(path.join(f.candidate,'plan.md'),'utf8');
  const row=global.split('\n').find(line=>line.startsWith('| 01 -'));
  global=global.replace(row,row+'\n'+row.replace('01 - Greeting','02 - Independent greeting').replace('AC-001','AC-002').replace('`src`','`second`').replace('slice-01','slice-02'));
  await fs.writeFile(path.join(f.candidate,'plan.md'),global);
  let index=await fs.readFile(path.join(f.candidate,'tasks.md'),'utf8');const taskRow=index.split('\n').find(line=>line.startsWith('| [ ] | 01'));
  index=index.replace(taskRow,taskRow+'\n'+taskRow.replace('01 - Greeting','02 - Independent greeting').replace('slice-01','slice-02'));await fs.writeFile(path.join(f.candidate,'tasks.md'),index);
  for(const folder of ['plans','tasks']) {
    let text=await fs.readFile(path.join(f.candidate,folder,'slice-01.md'),'utf8');
    text=text.replaceAll('Slice 01','Slice 02').replaceAll('- Slice: 01','- Slice: 02').replaceAll('slice-01','slice-02').replaceAll('AC-001','AC-002').replaceAll('`src`','`second`').replaceAll('src/greeting','second/greeting').replaceAll('1.1','2.1');
    await fs.writeFile(path.join(f.candidate,folder,'slice-02.md'),text);
  }
  const approved=await approveFixture(f);const ids=approved.authority.deliveries;
  for(const [slice,directory] of [['slice-01','src'],['slice-02','second']]) {
    const current=await readExecutionActivation(f.specPath);const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE',BigInt(slice.slice(6)).toString(),current.activation.activationId);
    const implemented=await implementOffline(f,admitted,{slice,directory});f.invocations=(f.invocations ?? 0)+1;
    await publishExecutionCopy({specPath:f.specPath,slice,candidateRoot:implemented.copy.candidateRoot});await formal(f,{slice,directory});
  }
  assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');
  await revise(f,{slice:'slice-02',proof:'node --test second/greeting.test.mjs with exact export assertion'});
  const first=await inspectDeliveryContinuity(f.specPath,'1');const second=await inspectDeliveryContinuity(f.specPath,'2');
  assert.equal(first.currentValidation,'current');assert.equal(second.currentValidation,'revalidation-required');
  assert.deepEqual((await readExecutionActivation(f.specPath)).authority.deliveries,ids);
  await revise(f,{slice:'slice-02',proof:'node --test second/greeting.test.mjs with exact export assertion',globalStrategy:'Global verification premise changed without demonstrated local non-affectation'});
  const ambiguous=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(ambiguous.currentValidation,'revalidation-required');assert.equal(ambiguous.historicalPass,'attempt-01');
  await evidence(f,'A04',{first,second,ids,ambiguous});
});
test('U2-A07 rejected persistence retries the same receipt without a runner',async()=>{
  const f=await implementedFixture();const captured=await formal(f,{publish:false});
  const file=path.join(captured.copy.candidateExecutionRoot,'tasks/slice-01.md');await fs.appendFile(file,'\n## Unknown persistence carrier\n\nInvalid\n');
  await assert.rejects(publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:captured.copy.candidateExecutionRoot,owner:captured.admitted.owner}));
  const invocations=f.invocations;const receipt=await fs.readFile(captured.captured.receiptFile);const retried=await formal(f,{reuse:captured});
  assert.equal(f.invocations,invocations);assert.deepEqual(await fs.readFile(captured.captured.receiptFile),receipt);assert.equal(retried.prepared.attemptId,'attempt-01');assert.ok(await fs.stat(file));
  assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');await evidence(f,'A07',{rejected:file,receipt:captured.captured.receiptFile,invocations});
});
test('U2-A08 two sealed cycles remain compact and tampered archive blocks read only',async()=>{
  const f=await implementedFixture();await formal(f);await fs.appendFile(path.join(f.root,'src/greeting.test.mjs'),'// revalidation 1\n');await formal(f);
  await fs.appendFile(path.join(f.root,'src/greeting.test.mjs'),'// revalidation 2\n');await formal(f);
  const info=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(info.latestAttempt,'attempt-03');assert.equal(info.history.length,2);
  const task=await fs.readFile(path.join(f.workspace.executionRoot,'tasks/slice-01.md'),'utf8');assert.equal([...task.matchAll(/^### attempt-/gmu)].length,1);assert.ok(task.includes('continuity.json#'));
  const cli=fileURLToPath(new URL('../skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[cli,f.specPath,'--inspect-continuity','1'],{env:commandEnvironment,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).latestAttempt,'attempt-03');
  const selected=await inspectDeliveryContinuity(f.specPath,'1',{revision:1,attempt:'attempt-01'});assert.equal(selected.selection.attempt.id,'attempt-01');assert.equal(selected.selection.attempt.status,'PASS');
  const historical=spawnSync(process.execPath,[cli,f.specPath,'--inspect-continuity','1','--revision','1','--attempt','attempt-01'],{env:commandEnvironment,encoding:'utf8'});assert.equal(historical.status,0,historical.stderr);assert.equal(JSON.parse(historical.stdout).selection.attempt.id,'attempt-01');
  const indexFile=path.join(f.workspace.executionRoot,'continuity.json');const indexBytes=await fs.readFile(indexFile);const index=JSON.parse(indexBytes);
  index.deliveries[0].history[0].taskRef.logicalTaskPath='rebased/slice-01.md';await fs.writeFile(indexFile,JSON.stringify(index));await assert.rejects(readDeliveryContinuity(f.workspace),/anchor differs/);await fs.writeFile(indexFile,indexBytes);
  const duplicate=JSON.parse(indexBytes);duplicate.deliveries.push(duplicate.deliveries[0]);await fs.writeFile(indexFile,JSON.stringify(duplicate));await assert.rejects(readDeliveryContinuity(f.workspace),/duplicate|differ/);await fs.writeFile(indexFile,indexBytes);
  const live=await fs.readFile(path.join(f.workspace.executionRoot,'activation.json'));
  const archive=path.resolve(f.workspace.executionRoot,info.history[0].taskRef.path);await fs.appendFile(archive,'tamper\n');
  await assert.rejects(inspectDeliveryContinuity(f.specPath,'1'),/retained|differ/);assert.deepEqual(await fs.readFile(path.join(f.workspace.executionRoot,'activation.json')),live);
  await evidence(f,'A08',{info,tamperedArchive:archive});
});
}
