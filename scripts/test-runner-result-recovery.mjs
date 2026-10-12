import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { implementedFixture, formal, native, capture, setSection } from './test-p1b-continuity.mjs';
import { fixture, approveFixture } from './test-p1b-preparation.mjs';
import { implementOffline } from './test-p1b-publication.mjs';
import { beginPreparedExecutionOperation, beginRunnerResultRecovery, preflightRunnerResultRecovery,
  preflightExecutionOperation, readExecutionActivation, inspectExecutionState, validateExecutionCandidate }
  from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { captureExecutionTree } from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import { startNativeRunnerCapture, bindNativeRunnerIdentity, verifyNativeRunnerReceipt }
  from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { prepareExecutionCopy, publishExecutionCopy } from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import { serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate, persistMalformedRunnerResultInCandidate,
  recoverableRunnerResultDiagnostic } from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { recoverySection } from '../skills/workflows/stnl-slice-executor/runtime/runner-result-recovery.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function requestFor(f) {
  const state = await inspectExecutionState(f.specPath);
  assert.equal(state.state, 'RUNNER_RESULT_BLOCKED');
  return { expectedActivationId: state.activation.activationId,
    rejectedOperationAttemptId: state.activation.activeAttempt.operationAttemptId,
    rejection: state.activeDelegationBlockers[0].recoveryProof };
}
async function proof(f, label, value) {
  const directory = process.env.STNL_RECOVERY_EVIDENCE;
  if (directory) await fs.writeFile(path.join(directory, `${label}-${path.basename(f.root)}.json`), JSON.stringify({ root:f.root, externalCalls:0, ...value },null,2)+'\n');
}
async function malformedFormal() {
  const f = await implementedFixture();
  const result = await formal(f, { responseOverride: { commands:'malformed-command-tuples' } });
  assert.equal(result.prepared.status, 'RUNNER_RESULT_BLOCKED');
  return { f, result, recovery: await requestFor(f) };
}

test('recovery native VALIDATE: explicit successor, fresh result, publication and immutable rejection', async () => {
  const { f, result, recovery } = await malformedFormal();
  const bytes = await fs.readFile(result.captured.receiptFile);
  const response = await fs.readFile(result.captured.semanticResponseFile);
  await assert.rejects(beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',recovery.expectedActivationId), /active|owns/);
  const admitted = await beginRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',recovery);
  assert.notEqual(admitted.owner.operationAttemptId,result.admitted.owner.operationAttemptId);
  assert.notEqual(admitted.owner.originActivationId,result.admitted.owner.originActivationId);
  assert.equal(admitted.owner.recovery.predecessor.operationAttemptId,result.admitted.owner.operationAttemptId);
  await assert.rejects(beginRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',recovery), /CAS|differs/);
  await assert.rejects(verifyNativeRunnerReceipt({...result.captured,operation:'VALIDATE_SLICE',slice:'slice-01',workspace:f.root}),/owner|differs/);
  const start = await startNativeRunnerCapture({specPath:f.specPath,owner:admitted.owner,workspace:f.root,captureParent:f.root});
  await assert.rejects(bindNativeRunnerIdentity({...start,agentId:result.start.agentId}), /EEXIST/);
  start.agentId='offline-fresh-'+randomUUID();await bindNativeRunnerIdentity({...start,agentId:start.agentId});
  assert.notEqual(start.originFile,result.start.originFile);
  const done = await formal(f,{reuse:{admitted,start}});
  assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');
  assert.equal(done.prepared.formalStatus,'PASS');
  assert.deepEqual(await fs.readFile(result.captured.receiptFile),bytes);
  assert.deepEqual(await fs.readFile(result.captured.semanticResponseFile),response);
  await proof(f,'native-validate',{state:'COMPLETE',predecessor:result.admitted.owner,successor:admitted.owner,receiptSha256:sha(bytes),newReceipt:done.captured.receiptFile});
});

test('recovery native refuses stale CAS, wrong owner, changed receipt/proof/authority and uncertain dispatch without mutation', async () => {
  const { f, result, recovery } = await malformedFormal();
  const tree = await captureExecutionTree(f.workspace.executionRoot);
  for (const bad of [{...recovery,expectedActivationId:randomUUID()},{...recovery,rejectedOperationAttemptId:randomUUID()},
    {...recovery,rejection:{...recovery.rejection,sha256:'sha256:'+'0'.repeat(64)}}]) {
    await assert.rejects(beginRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',bad),/CAS|differs|changed/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),tree);
  }
  for (const file of [result.captured.receiptFile,result.captured.semanticResponseFile,recovery.rejection.path,f.specPath]) {
    const bytes=await fs.readFile(file);await fs.appendFile(file,' ');
    await assert.rejects(beginRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',recovery),/changed|stale|authority/);
    await fs.writeFile(file,bytes);assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),tree);
  }
  const extra=path.join(path.dirname(result.start.originFile),'round-2.origin.json');await fs.writeFile(extra,'{}');
  await assert.rejects(beginRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',recovery),/uncertain/);
  await fs.unlink(extra);
  assert.equal((await preflightRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',recovery)).state,'RUNNER_RESULT_BLOCKED');
  await proof(f,'native-negatives',{preserved:true,scenarios:8});
});

test('recovery native concurrent CAS admits exactly one successor and second malformed cannot recover', async () => {
  const { f, recovery } = await malformedFormal();
  const results = await Promise.allSettled([1,2].map(()=>beginRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',recovery)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const admitted=results.find(r=>r.status==='fulfilled').value;
  const start=await native(f,admitted.owner);
  await formal(f,{reuse:{admitted,start},responseOverride:{commands:'malformed'}});
  const second=await requestFor(f);
  await assert.rejects(beginRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',second),/already consumed/);
  await proof(f,'native-cas-limit',{admissions:1,secondRecovery:'rejected'});
});

async function auxiliaryBlocked() {
  const f=await fixture(),approved=await approveFixture(f);
  const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const first=await implementOffline(f,admitted,{forceFail:true});
  const check=recoverySection(await fs.readFile(first.copy.candidateTaskArtifact,'utf8'),'Implementation Test Evidence');
  const start=await startNativeRunnerCapture({specPath:f.specPath,owner:admitted.owner,workspace:f.root,captureParent:f.root,candidateTaskArtifact:first.copy.candidateTaskArtifact});
  const agentId='offline-recovery-'+randomUUID();await bindNativeRunnerIdentity({...start,agentId});
  const captured=await capture({...start,agentId},{status:'TESTS_FAIL'},['../../src/greeting.test.mjs','../../src/unpredicted.mjs']);
  let error;
  try { await serializeRunnerExecutionBundleFromResponse({operation:'EXECUTE_SLICE',response:JSON.stringify({status:'TESTS_FAIL'}),workspace:f.root,taskArtifact:first.copy.candidateTaskArtifact,...captured}); }
  catch(e) { error=e; }
  assert.ok(recoverableRunnerResultDiagnostic(error));
  await persistMalformedRunnerResultInCandidate({operation:'EXECUTE_SLICE',workspace:f.root,taskArtifact:first.copy.candidateTaskArtifact,...captured,error,diagnostic:recoverableRunnerResultDiagnostic(error)});
  await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:first.copy.candidateRoot});
  assert.equal(recoverySection(await fs.readFile(path.join(f.workspace.executionRoot,'tasks/slice-01.md'),'utf8'),'Implementation Test Evidence'),check);
  return {f,first,check,recovery:await requestFor(f)};
}
test('recovery native EXECUTE retains private round one and continues round two with only one invocation left',async()=>{
  const {f,first,check,recovery}=await auxiliaryBlocked();
  const admitted=await beginRunnerResultRecovery(f.specPath,'EXECUTE_SLICE','1',recovery);
  assert.equal(admitted.owner.recovery.round,2);assert.equal(admitted.owner.recovery.consumedInvocations,2);
  const start=await native(f,admitted.owner);assert.equal(start.attempt,2);
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
  assert.equal(recoverySection(await fs.readFile(copy.candidateTaskArtifact,'utf8'),'Implementation Test Evidence'),check);
  await fs.writeFile(path.join(f.root,'src/unpredicted.mjs'),'export const greeting="hello";\n');
  let text=await fs.readFile(copy.candidateTaskArtifact,'utf8');text=setSection(text,'Corrections Applied','- `../../src/unpredicted.mjs`');await fs.writeFile(copy.candidateTaskArtifact,text);
  const response={...first.response,status:'TESTS_PASS',automaticCheckRound:'2/3',commands:[{command:first.command,exit:0}],failures:'none',priorRoundFailure:'Greeting assertion expected hello',correctionApplied:'Correct greeting value',inSliceRationale:'Same greeting obligation',evidenceOrFailureSummary:'Observed greeting fixed'};
  const captured=await capture(start,response,['../../src/greeting.test.mjs','../../src/unpredicted.mjs']);
  const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'EXECUTE_SLICE',response:JSON.stringify(response),workspace:f.root,taskArtifact:copy.candidateTaskArtifact,...captured});
  await insertExecutionEvidenceInCandidate({taskArtifact:copy.candidateTaskArtifact,operation:'EXECUTE_SLICE',bundle,validateProspectiveTask:task=>validateExecutionCandidate(f.specPath,copy.candidateExecutionRoot,[task])});
  await assert.rejects(startNativeRunnerCapture({specPath:f.specPath,owner:admitted.owner,workspace:f.root,captureParent:f.root,candidateTaskArtifact:copy.candidateTaskArtifact}),/cannot dispatch/);
  await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:copy.candidateRoot});
  const state=await inspectExecutionState(f.specPath);assert.equal(state.state,'IMPLEMENTED_AWAITING_VALIDATION');
  assert.deepEqual(state.tasks.get('slice-01').implementationChecks.map(c=>c.round),[1,2]);
  assert.equal(state.tasks.get('slice-01').implementationChecks[0].body.trim(),check.split('\n').slice(1).join('\n').trim());
  await formal(f);assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');
  await proof(f,'native-execute',{state:'COMPLETE',rounds:[1,2],invocations:3,privateCheckSha256:sha(check)});
});

import { createManagedSliceContext, managedEnvironment } from '../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';
import { startOfficialRunnerBroker, submitOfficialRunnerRequest } from '../agents/codex/runtime/runner-broker.mjs';
import { invokeIndependentRunner } from '../agents/codex/runtime/validation-runner.mjs';
import { prepareValidationCopy } from '../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import { prepareValidationCandidate } from '../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import { publishValidationCandidate } from '../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import { readRunnerVerification } from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { verificationCommand } from '../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';
const ROOT=await fs.realpath(path.resolve(import.meta.dirname,'..'));
const restoreEnvironment = original => {for(const key of Object.keys(process.env))if(!(key in original))delete process.env[key];Object.assign(process.env,original);};
async function managedContext(f,sequence,recovery=null,operation='VALIDATE_SLICE') {
  const preflight=recovery ? await preflightRunnerResultRecovery(f.specPath,operation,'1',recovery) : await preflightExecutionOperation(f.specPath,operation,'1');
  const officialPreflight={exitCode:0,operation,slice:'slice-01',inputSlice:'1',specPath:f.specPath,state:preflight.state,authority:'sha256:'+preflight.currentFingerprint,legalOperations:preflight.legalOperations,mandatoryRecovery:preflight.mandatoryRecovery,activationId:preflight.activation.activationId};
  const context=await createManagedSliceContext({officialPreflight,workspace:f.root,snapshot:ROOT,adapterPath:path.join(ROOT,'agents/codex/runtime/validation-runner.mjs'),bridgePath:path.join(ROOT,'agents/codex/runtime/managed-runner-bridge.mjs'),preflightPath:path.join(ROOT,'agents/codex/runtime/managed-slice-preflight.mjs'),recovery});
  Object.assign(officialPreflight,{owner:context.owner,expectedActivationId:context.expectedActivationId});
  const tmpdir=path.join(path.dirname(f.root),`${path.basename(f.root)}-managed-${sequence}`);await fs.mkdir(tmpdir);
  const env=managedEnvironment({...process.env,TMPDIR:tmpdir},context);
  Object.assign(process.env,env);
  return {context,officialPreflight,tmpdir,env,sequence};
}
async function managedBroker(f,context,response,oldThread=null) {
  let calls=0;
  const broker=await startOfficialRunnerBroker({workspace:f.root,operation:'VALIDATE_SLICE',slice:'slice-01',...context,pollIntervalMs:1,
    invoke:request=>invokeIndependentRunner({...request,snapshot:ROOT,env:context.env,runTurn:async args=>{
      calls++;const threadId=oldThread ?? 'offline-recovery-'+randomUUID();
      const events=[{type:'thread.started',thread_id:threadId},{type:'turn.started'},{type:'item.completed',item:{id:'final',type:'agent_message',text:JSON.stringify(response)}},{type:'turn.completed'}];
      await fs.writeFile(args.eventsPath,events.map(e=>JSON.stringify({...e,operationId:args.operationId})).join('\n')+'\n',{flag:'wx'});
      return {completed:true,turnStarted:true,threadId,error:null,processError:null,errorEvent:null,requestedModel:args.model,requestedEffort:args.effort,reportedModel:args.model,usage:null};
    }})});
  return {broker,calls:()=>calls};
}
async function managedValidation(f,c) {
  const receipt=await submitOfficialRunnerRequest({workspace:f.root,tmpdir:c.tmpdir,operation:'VALIDATE_SLICE',sequence:c.sequence,slice:'slice-01',prompt:'Validate the current reviewed recipe.',pollIntervalMs:1,timeoutMs:10000});
  const copy=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:c.tmpdir,owner:c.context.owner});
  const prepared=await prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,candidateExecutionRoot:copy.candidateExecutionRoot,semanticResponseFile:receipt.semanticResponseFile,receiptFile:receipt.receiptFile});
  await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',candidateExecutionRoot:copy.candidateExecutionRoot,owner:c.context.owner});
  return {receipt,prepared,copy};
}
test('recovery managed VALIDATE requires closed supervisor, preserves broker and publishes a new observed PASS',async()=>{
  const environment={...process.env};const f=await implementedFixture();let first,second,firstClosed=false;
  try {
    const c1=await managedContext(f,1);first=await managedBroker(f,c1,{status:'PASS'});
    const rejected=await managedValidation(f,c1);assert.equal(rejected.prepared.status,'RUNNER_RESULT_BLOCKED');
    const recovery=await requestFor(f);
    await assert.rejects(preflightRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',recovery),/conclusion uncertain/);
    await first.broker.close();firstClosed=true;
    const before=await captureExecutionTree(f.workspace.executionRoot);
    const supervisor=path.join(c1.tmpdir,'stnl-runner-broker/001.supervisor.json');const supervisorBytes=await fs.readFile(supervisor);
    for(const mutation of [{pending:true},{cancelledPending:true},{closedAt:null}]) {
      await fs.writeFile(supervisor,JSON.stringify({...JSON.parse(supervisorBytes),...mutation}));
      await assert.rejects(beginRunnerResultRecovery(f.specPath,'VALIDATE_SLICE','1',recovery),/conclusion uncertain/);
      assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
    }
    await fs.writeFile(supervisor,supervisorBytes);
    const oldActive=path.join(c1.tmpdir,'stnl-runner-broker/active.json'),oldBytes=await fs.readFile(oldActive),oldReceipt=await fs.readFile(rejected.receipt.receiptFile);
    const c2=await managedContext(f,2,recovery);
    const response={status:'PASS',head:'offline-working-tree',commands:(await readRunnerVerification(f.specPath,'slice-01')).checks.map(check=>({command:verificationCommand(check),exit:0})),evidence:'Observed greeting assertion under the reviewed recipe.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Persist newly observed result'};
    second=await managedBroker(f,c2,response);
    const done=await managedValidation(f,c2);assert.equal(done.prepared.formalStatus,'PASS');
    assert.equal(done.receipt.attempt,2);assert.notEqual(done.receipt.threadId,rejected.receipt.threadId);
    assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');
    assert.deepEqual(await fs.readFile(oldActive),oldBytes);assert.deepEqual(await fs.readFile(rejected.receipt.receiptFile),oldReceipt);
    await second.broker.close();second=null;
    assert.equal(first.calls(),1);
    await proof(f,'managed-validate',{state:'COMPLETE',oldBroker:oldActive,receiptSha256:sha(oldReceipt),newReceipt:done.receipt.receiptFile,successor:c2.context.owner,supervisorNegatives:4});
  }finally{if(second)await second.broker.close();if(first&&!firstClosed)await first.broker.close();restoreEnvironment(environment);}
});

test('recovery native exhausted invocation budget cannot run a fourth check after a real third-invocation failure',async()=>{
  const {f,first,recovery}=await auxiliaryBlocked();
  const admitted=await beginRunnerResultRecovery(f.specPath,'EXECUTE_SLICE','1',recovery);
  const start=await native(f,admitted.owner);
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
  const response={...first.response,automaticCheckRound:'2/3',priorRoundFailure:'Greeting assertion still fails',correctionApplied:'Inspected the same greeting path; failure remains',inSliceRationale:'Same greeting obligation'};
  const captured=await capture(start,response,['../../src/greeting.test.mjs','../../src/unpredicted.mjs']);
  const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'EXECUTE_SLICE',response:JSON.stringify(response),workspace:f.root,taskArtifact:copy.candidateTaskArtifact,...captured});
  await insertExecutionEvidenceInCandidate({taskArtifact:copy.candidateTaskArtifact,operation:'EXECUTE_SLICE',bundle,validateProspectiveTask:task=>validateExecutionCandidate(f.specPath,copy.candidateExecutionRoot,[task],{privateAutomaticCheck:{operation:'EXECUTE_SLICE',slice:'slice-01',round:2}})});
  const text=await fs.readFile(copy.candidateTaskArtifact);const tree=await captureExecutionTree(f.workspace.executionRoot);
  await assert.rejects(startNativeRunnerCapture({specPath:f.specPath,owner:admitted.owner,workspace:f.root,captureParent:f.root,candidateTaskArtifact:copy.candidateTaskArtifact}),/cannot dispatch/);
  assert.deepEqual(await fs.readFile(copy.candidateTaskArtifact),text);assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),tree);
  await proof(f,'native-budget',{invocations:3,nextRound:3,additionalDispatch:'rejected',lastStatus:'TESTS_FAIL',privateCheckSha256:sha(text)});
});

test('recovery managed refuses a reused predecessor thread and does not publish its response',async()=>{
  const environment={...process.env};const f=await implementedFixture();let first,second,firstClosed=false;
  try {
    const c1=await managedContext(f,1);first=await managedBroker(f,c1,{status:'PASS'});
    const rejected=await managedValidation(f,c1);await first.broker.close();firstClosed=true;
    const c2=await managedContext(f,2,await requestFor(f));
    const response={status:'PASS',head:'offline-working-tree',commands:(await readRunnerVerification(f.specPath,'slice-01')).checks.map(check=>({command:verificationCommand(check),exit:0})),evidence:'Observed reviewed recipe.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Attempted reused identity'};
    second=await managedBroker(f,c2,response,rejected.receipt.threadId);
    const before=await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(managedValidation(f,c2),/reused predecessor runner identity/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
    assert.equal(first.calls(),1);assert.equal(second.calls(),1);
    await proof(f,'managed-replay',{oldThread:rejected.receipt.threadId,rejected:true,calls:2,canonicalBytesPreserved:true});
  }finally{if(second)await second.broker.close();if(first&&!firstClosed)await first.broker.close();restoreEnvironment(environment);}
});
