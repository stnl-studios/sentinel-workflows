import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixture,approveFixture,verificationBody} from './test-p1b-preparation.mjs';
import {formal,revise,implementedFixture,setSection,evidence,native} from './test-p1b-continuity.mjs';
import {implementOffline} from './test-p1b-publication.mjs';
import {resolveExecutionWorkspace,readExecutionActivation,beginPreparedExecutionOperation,inspectDeliveryContinuity,readRunnerVerification,inspectExecutionState,preflightExecutionOperation,validateExecutionCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {classifyOwnedAllocation,assertOwnedPreparationCandidate,preparationRegistryPath,captureExecutionTree} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {publishExecutionCopy} from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import {verifyNativeRunnerReceipt,captureNativeRunnerResult} from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import {executeRunnerVerification,assertRunnerVerification,verificationCommand} from '../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';
import {validateManagedChangedAreas,resolveCapturedRunnerCommands} from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import {createManagedSliceContext,managedEnvironment,assertManagedRunnerReceipt} from '../skills/workflows/stnl-slice-quality-manager/runtime/managed-slice-context.mjs';
import {invokeIndependentRunner} from '../agents/codex/runtime/validation-runner.mjs';
import {projectPreparationAuthority,validateApprovedPreparation,sha256} from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import {checkDistributableSkill,EXECUTION_DISTRIBUTION_POLICY} from './lib/check-distributable-skill.mjs';

const env={...process.env};delete env.NODE_TEST_CONTEXT;
const editPair=async(f,heading,body)=>{for(const name of ['plans/slice-01.md','tasks/slice-01.md']){const file=path.join(f.candidate,name);await fs.writeFile(file,setSection(await fs.readFile(file,'utf8'),heading,body));}};
test('U2-R3-F1 fabricated and copied updated witnesses never acquire producer authority',async()=>{
  const f=await fixture();const sibling=path.join(f.root,'legitimate-spec');await fs.mkdir(sibling);
  const spec=path.join(sibling,'feature_spec.md');const original=Buffer.from('# Legitimate sibling authority\n');await fs.writeFile(spec,original);
  const marker=sibling+'.owner.json',identity=(await captureExecutionTree(sibling)).identity;
  const genuine=JSON.parse(await fs.readFile(f.candidate+'.owner.json','utf8'));
  const results=[];
  for(const record of [{...genuine,allocationId:randomUUID(),candidate:sibling,retentionRoot:sibling,candidateIdentity:identity},
    {...genuine,candidate:sibling,retentionRoot:sibling,candidateIdentity:identity}]){
    await fs.writeFile(marker,JSON.stringify(record));
    await assert.rejects(classifyOwnedAllocation({workspace:f.workspace,marker}),/producer association/);
    await assert.rejects(assertOwnedPreparationCandidate({candidateExecutionRoot:sibling,resolveWorkspace:resolveExecutionWorkspace}),/producer association/);
    assert.equal((await resolveExecutionWorkspace(sibling)).specRoot,sibling);
    assert.equal((await resolveExecutionWorkspace(spec)).specRoot,sibling);
    results.push({record,classifier:'rejected',guard:'rejected',officialSpecSelected:true});
  }
  await approveFixture(f);
  const donor=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN'});
  const realSourceEnvelope=JSON.parse(await fs.readFile(donor.candidateExecutionRoot+'.owner.json','utf8'));
  assert.ok(realSourceEnvelope.source.files.some(entry=>entry.path==='activation.json'));
  const rebound={...realSourceEnvelope,candidate:sibling,retentionRoot:sibling,candidateIdentity:identity};
  await fs.writeFile(marker,JSON.stringify(rebound));
  await assert.rejects(classifyOwnedAllocation({workspace:f.workspace,marker,activation:(await readExecutionActivation(f.specPath)).activation}),/producer association/);
  await assert.rejects(assertOwnedPreparationCandidate({candidateExecutionRoot:sibling,resolveWorkspace:resolveExecutionWorkspace}),/producer association/);
  assert.equal((await resolveExecutionWorkspace(sibling)).specRoot,sibling);
  results.push({record:rebound,sourceCASFromRealREPLAN:true,classifier:'rejected',guard:'rejected',officialSpecSelected:true});
  assert.deepEqual(await fs.readFile(spec),original);
  await evidence(f,'R3-F1-updated-witness',{results,registry:JSON.parse(await fs.readFile(await preparationRegistryPath(f.workspace),'utf8'))});
});
test('U2-R3-F1 genuine pre-PLAN association survives another process and stale CAS',async()=>{
  const f=await fixture();const marker=f.candidate+'.owner.json';
  const module=pathToFileURL(path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs')).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {classifyOwnedAllocation} from ${JSON.stringify(module)}; console.log(JSON.stringify(await classifyOwnedAllocation(${JSON.stringify({workspace:f.workspace,marker})})));`],{env,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).classification,'active');
  await fs.mkdir(path.join(f.candidate,'nested'));await fs.writeFile(path.join(f.candidate,'nested/feature_spec.md'),'# candidate resemblance\n');
  await assert.rejects(resolveExecutionWorkspace(path.join(f.candidate,'nested')),/owned operational/);
  await fs.rm(path.join(f.candidate,'nested'),{recursive:true});
  await approveFixture(f);
  assert.equal((await classifyOwnedAllocation({workspace:f.workspace,marker,activation:(await readExecutionActivation(f.specPath)).activation})).classification,'diagnostic');
  await assert.rejects(assertOwnedPreparationCandidate({candidateExecutionRoot:f.candidate,resolveWorkspace:resolveExecutionWorkspace}),/CAS.*stale/);
  await assert.rejects(resolveExecutionWorkspace(f.candidate),/owned operational/);
  await evidence(f,'R3-F1-process-stale',{childOutput:child.stdout,prePlan:true,stale:'diagnostic',staleExcluded:true});
});
test('U2-R3-F1 absent, corrupt and unsafe registry blocks candidate use without excluding a sibling',async()=>{
  const f=await fixture(),registry=await preparationRegistryPath(f.workspace),bytes=await fs.readFile(registry);
  const sibling=path.join(f.root,'sibling');await fs.mkdir(sibling);await fs.writeFile(path.join(sibling,'feature_spec.md'),'# valid spec\n');
  const envelope=JSON.parse(await fs.readFile(f.candidate+'.owner.json','utf8'));
  await fs.writeFile(sibling+'.owner.json',JSON.stringify({...envelope,candidate:sibling,retentionRoot:sibling,candidateIdentity:(await captureExecutionTree(sibling)).identity}));
  for(const state of ['absent','corrupt','symlink']){
    await fs.unlink(registry);
    if(state==='corrupt')await fs.writeFile(registry,'{"executionRoot":');
    if(state==='symlink'){await fs.writeFile(registry+'.target',bytes);await fs.symlink(registry+'.target',registry);}
    await assert.rejects(assertOwnedPreparationCandidate({candidateExecutionRoot:f.candidate,resolveWorkspace:resolveExecutionWorkspace}),/registry|JSON|symlink|symbolic/);
    assert.equal((await resolveExecutionWorkspace(sibling)).specRoot,sibling);
    if(state==='absent')await fs.writeFile(registry,bytes);else{await fs.unlink(registry);await fs.writeFile(registry,bytes);}
  }
  await evidence(f,'R3-F1-registry-guards',{states:['absent','corrupt','symlink'],candidateRejected:true,siblingPreserved:true});
});
async function basenameFixture({linked=true}={}){
  const f=await fixture(),file=path.join(f.root,'external.test.mjs');
  await fs.writeFile(file,'import test from "node:test";import assert from "node:assert/strict";import {greeting} from "./src/unpredicted.mjs";test("approved basename",()=>assert.equal(greeting,"hello"));\n');
  await editPair(f,'Expected Tests','- node --test external.test.mjs');
  await editPair(f,'Verification Recipe',verificationBody({file:'external.test.mjs',kind:'input'}));
  if(linked)await editPair(f,'Existing Inputs','- `external.test.mjs`');
  return {...f,file};
}
test('U2-R3-F2 bare basename without typed Existing Inputs is rejected before activation',async()=>{
  const f=await basenameFixture({linked:false});
  await assert.rejects(approveFixture(f),/verification input.*Existing Inputs/);
  assert.equal(await captureExecutionTree(f.workspace.executionRoot),null);
  const missing=await fixture();await editPair(missing,'Verification Recipe','- none');
  await assert.rejects(approveFixture(missing),/Verification Recipe/);
  await evidence(f,'R3-F2-unlinked',{rejectedBeforeActivation:true,missingRecipeRejected:true});
});
test('U2-R3-F2 recipe reaches runner/receipt and basename drift invalidates actual PASS',async()=>{
  const f=await basenameFixture();const approved=await approveFixture(f);
  const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const impl=await implementOffline(f,admitted);
  await assert.rejects(validateManagedChangedAreas({workspace:f.root,taskArtifact:path.join(f.workspace.executionRoot,'tasks/slice-01.md'),changedAreas:['../../external.test.mjs']}),/authorized|approved|scope/i);
  const taskBytes=await fs.readFile(impl.copy.candidateTaskArtifact);
  await fs.writeFile(impl.copy.candidateTaskArtifact,setSection(taskBytes.toString('utf8'),'Changed Areas','- `../../external.test.mjs`\n- `../../src/greeting.test.mjs`\n- `../../src/unpredicted.mjs`'));
  await assert.rejects(validateExecutionCandidate(f.specPath,impl.copy.candidateExecutionRoot),/current file-backed candidate evidence does not own every Changed Areas/);
  await fs.writeFile(impl.copy.candidateTaskArtifact,taskBytes);
  await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:impl.copy.candidateRoot});
  const pass=await formal(f);const receipt=JSON.parse(await fs.readFile(pass.captured.receiptFile,'utf8'));
  assert.equal(receipt.verification.checks[0].command,'node --test external.test.mjs');assert.equal(receipt.verification.checks[0].exit,0);
  assert.match(receipt.verification.checks[0].stdout,/^# pass 1$/mu);
  assert.deepEqual(receipt.verification.verification,await readRunnerVerification(f.specPath,'slice-01'));
  const before=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(before.currentValidation,'current');
  await fs.writeFile(f.file,'import test from "node:test";import assert from "node:assert/strict";test("approved basename",()=>assert.fail("actual changed proof"));\n');
  const failed=spawnSync(process.execPath,['--test','external.test.mjs'],{cwd:f.root,env,encoding:'utf8'});assert.equal(failed.status,1);
  const after=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(after.currentValidation,'revalidation-required');assert.notEqual(after.state,'COMPLETE');assert.ok(after.affectedPaths.includes('external.test.mjs'));
  assert.equal(after.historicalPass,'attempt-01');
  await evidence(f,'R3-F2-basename',{before,after,receipt,inputDidNotGrantWriteScope:true,actualAfterExit:failed.status,actualAfterOutput:failed.stdout});
});
test('U2-R3-F2 prose homonyms never become inputs and recipe revision is consumed',async()=>{
  const f=await fixture();for(const name of ['Node.js','Greeting.length','v22.20.0'])await fs.writeFile(path.join(f.root,name),'unrelated prose homonym\n');
  await editPair(f,'Expected Tests','- Node.js v22.20.0 observes Greeting.length; `Node.js` is explanation. src/unrelated.test.mjs is prose.');
  await approveFixture(f);
  const current=await readExecutionActivation(f.specPath),owner=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',current.activation.activationId);
  const impl=await implementOffline(f,owner);await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:impl.copy.candidateRoot});await formal(f);
  await fs.writeFile(path.join(f.root,'Node.js'),'changed unrelated homonym\n');
  assert.equal((await inspectDeliveryContinuity(f.specPath,'1')).currentValidation,'current');
  const recipe=JSON.parse(verificationBody({file:'../../src/greeting.test.mjs'}).slice('- Recipe: '.length));
  recipe.checks[0].args.splice(1,0,{literal:'--test-name-pattern=AC-001'});
  await revise(f,{recipe:'- Recipe: '+JSON.stringify(recipe),proof:'Use the revised explicit name filter while preserving AC-001.'});
  assert.equal((await inspectDeliveryContinuity(f.specPath,'1')).currentValidation,'revalidation-required');
  const pass=await formal(f);const receipt=JSON.parse(await fs.readFile(pass.captured.receiptFile,'utf8'));
  assert.equal(receipt.verification.checks[0].command,'node --test --test-name-pattern=AC-001 src/greeting.test.mjs');
  assert.equal(receipt.verification.verification.recipeSha256,(await readRunnerVerification(f.specPath,'slice-01')).recipeSha256);
  assert.equal((await inspectExecutionState(f.specPath)).state,'COMPLETE');
  await evidence(f,'R3-F2-revised-recipe',{receipt,homonymDidNotInvalidate:true});
});
test('U2-R3-F2 divergent recipe receipt cannot grant PASS and completed checks are not replayed',async()=>{
  const f=await implementedFixture(),pass=await formal(f,{publish:false});const file=pass.captured.receiptFile,bytes=await fs.readFile(file),receipt=JSON.parse(bytes);
  receipt.verification.verification.checks[0].args=[...receipt.verification.verification.checks[0].args,{literal:'wrong'}];await fs.writeFile(file,JSON.stringify(receipt));
  await assert.rejects(verifyNativeRunnerReceipt({...pass.captured,operation:'VALIDATE_SLICE',slice:'slice-01',workspace:f.root}),/verification.*differs/);
  await fs.writeFile(file,bytes);
  const observation=receipt.verification;assert.throws(()=>assertRunnerVerification(observation,{format:'stnl-resolved-verification-v1',recipeSha256:'different',checks:[]}),/binding/);
  const output=path.join(f.root,'one-shot.verification.json'),verification=await readRunnerVerification(f.specPath,'slice-01');
  const first=await executeRunnerVerification({verification,outputFile:output});const metadata=await fs.stat(output);
  assert.deepEqual(await executeRunnerVerification({verification,outputFile:output}),first);assert.equal((await fs.stat(output)).mtimeMs,metadata.mtimeMs);
  const pending=path.join(f.root,'uncertain.verification.json');await fs.writeFile(pending,JSON.stringify({format:'stnl-runner-verification-v1',status:'started',verification,checks:[]}));
  await assert.rejects(executeRunnerVerification({verification,outputFile:pending}),/did not conclude/);
  await evidence(f,'R3-F2-receipt-guards',{divergentRejected:true,completedReused:true,pendingRefused:true,receipt:JSON.parse(bytes)});
});
test('U2-R3-F2 managed adapter consumes reviewed recipe in request and verifies its real receipt',async()=>{
  const f=await implementedFixture(),snapshot=await fs.realpath(path.resolve('.'));
  const inspected=await preflightExecutionOperation(f.specPath,'VALIDATE_SLICE','1');
  const officialPreflight={exitCode:0,operation:'VALIDATE_SLICE',slice:'slice-01',specPath:f.specPath,state:inspected.state,
    authority:'sha256:'+inspected.currentFingerprint,activationId:inspected.activation.activationId,legalOperations:inspected.legalOperations,mandatoryRecovery:inspected.mandatoryRecovery ?? null};
  const context=await createManagedSliceContext({officialPreflight,workspace:f.root,snapshot,
    adapterPath:path.join(snapshot,'agents/codex/runtime/validation-runner.mjs'),bridgePath:path.join(snapshot,'agents/codex/runtime/managed-runner-bridge.mjs'),preflightPath:path.join(snapshot,'agents/codex/runtime/managed-slice-preflight.mjs')});
  const tmpdir=path.join(f.root,'managed-tmp');await fs.mkdir(path.join(tmpdir,'stnl-runner-broker'),{recursive:true});
  const environment=managedEnvironment({...env,TMPDIR:tmpdir},context),active={protocol:3,sequence:1,operation:'VALIDATE_SLICE',slice:'slice-01',workspace:f.root,tmpdir,officialPreflight};
  await fs.writeFile(path.join(tmpdir,'stnl-runner-broker/active.json'),JSON.stringify(active));
  let request=null;
  const receipt=await invokeIndependentRunner({snapshot,workspace:f.root,tmpdir,env:environment,operation:'VALIDATE_SLICE',sequence:1,slice:'slice-01',officialPreflight,prompt:'Review the prepared greeting; simulated offline semantic judgment only.',
    runTurn:async({prompt,eventsPath,operationId})=>{
      request=prompt;const observed=JSON.parse(prompt.match(/REVIEWED_VERIFICATION=(.*)/u)[1]);
      assert.equal(observed.checks[0].exit,0);assert.match(observed.checks[0].stdout,/^# pass 1$/mu);
      const response=JSON.stringify({status:'PASS',head:'offline-tree',commands:assertRunnerVerification(observed,observed.verification),evidence:'Recipe executed by official runner adapter; this fixture controls semantic judgment.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve recipe-bound observation.'});
      await fs.writeFile(eventsPath,[{type:'thread.started',thread_id:'offline-r3-managed'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:response}},{type:'turn.completed'}].map(event=>JSON.stringify({...event,operationId})).join('\n')+'\n');
      return {completed:true,threadId:'offline-r3-managed',error:null,processError:null,errorEvent:null};
    }});
  assert.equal(receipt.status,'RUNNER_RESPONSE_CAPTURED');
  await assertManagedRunnerReceipt({operation:'VALIDATE_SLICE',slice:'slice-01',workspace:f.root,receiptFile:receipt.receiptFile,semanticResponseFile:receipt.semanticResponseFile,environment});
  const bytes=await fs.readFile(receipt.receiptFile),forged=JSON.parse(bytes);forged.verification.verification.recipeSha256='sha256:'+'0'.repeat(64);await fs.writeFile(receipt.receiptFile,JSON.stringify(forged));
  await assert.rejects(assertManagedRunnerReceipt({operation:'VALIDATE_SLICE',slice:'slice-01',workspace:f.root,receiptFile:receipt.receiptFile,semanticResponseFile:receipt.semanticResponseFile,environment}),/verification.*differs/);
  await fs.writeFile(receipt.receiptFile,bytes);
  const eventBytes=await fs.readFile(receipt.eventsPath),events=eventBytes.toString('utf8').trim().split('\n').map(JSON.parse);
  const extra=spawnSync(process.execPath,['-e','process.exit(7)'],{cwd:f.root,env,encoding:'utf8'});assert.equal(extra.status,7);
  const operationId=events[0].operationId,command='STNL_VERIFICATION_COMMAND=1 node -e "process.exit(7)"';
  events.splice(2,0,{operationId,type:'item.started',item:{id:'item_0',type:'command_execution',command}},
    {operationId,type:'item.completed',item:{id:'item_0',type:'command_execution',command,status:'failed',exit_code:extra.status}});
  await fs.writeFile(receipt.eventsPath,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  await assert.rejects(resolveCapturedRunnerCommands({receiptFile:receipt.receiptFile,semanticResponseFile:receipt.semanticResponseFile,operation:'VALIDATE_SLICE'}),/additional SDK verification/);
  await fs.writeFile(receipt.eventsPath,eventBytes);
  await evidence(f,'R3-managed-recipe',{request,receipt,externalCalls:0,semanticJudgment:'controlled offline',receiptTamperRejected:true,extraActualExit:extra.status,additionalSDKVerificationRefused:true});
});
test('U2-R3-F2 old recipe-less preparation is historical only, never fresh authority',async()=>{
  const f=await fixture(),approved=await approveFixture(f),snapshot=structuredClone(approved.snapshot);
  for(const artifact of snapshot.reviewedArtifacts){
    artifact.utf8=artifact.utf8.replace(/^## Verification Recipe\n\n[^\n]+\n\n/gmu,'');
    artifact.sha256=sha256(Buffer.from(artifact.utf8));
  }
  const artifacts=new Map(snapshot.reviewedArtifacts.map(a=>[a.path,a.utf8]));
  const historical=projectPreparationAuthority(artifacts,{historical:true});
  Object.assign(snapshot,historical);
  assert.throws(()=>validateApprovedPreparation(snapshot),/missing|sections/);
  assert.equal(validateApprovedPreparation(snapshot,{historical:true}).normativeSha256,historical.normativeSha256);
  assert.notEqual(historical.normativeSha256,approved.authority.normativeSha256);
  await evidence(f,'R3-F2-historical-only',{currentRejected:true,historicalRead:true,oldNormativeSha256:historical.normativeSha256,newNormativeSha256:approved.authority.normativeSha256});
});
test('U2-R3-F2 changing a reviewed input during its own check cannot become tested current state',async()=>{
  const f=await basenameFixture();
  await fs.writeFile(f.file,'import test from "node:test";import fs from "node:fs";test("self mutation",()=>fs.writeFileSync("external.test.mjs","throw new Error(\\"changed proof\\");\\n"));\n');
  const approved=await approveFixture(f),admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  // The real command completes zero but changes the proof's captured bytes.
  await assert.rejects(implementOffline(f,admitted),/inputs changed while the recipe ran/);
  assert.notEqual((await inspectExecutionState(f.specPath)).state,'COMPLETE');
  const root=path.dirname((await readExecutionActivation(f.specPath)).activation.activeAttempt.runner.receiptFile);
  const observation=JSON.parse(await fs.readFile(path.join(root,'round-1.verification.json'),'utf8'));
  assert.equal(observation.checks[0].exit,0);assert.equal(observation.status,'inputs-changed');
  await evidence(f,'R3-F2-during-command-drift',{zeroExitDidNotGrantTestedState:true,observation,changedInput:await fs.readFile(f.file,'utf8')});
});
test('U2-R3-F2 native verify CLI runs the bound recipe once before capture and refuses missing observation',async()=>{
  const f=await implementedFixture(),current=await readExecutionActivation(f.specPath);
  const admitted=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',current.activation.activationId),start=await native(f,admitted.owner);
  const response={status:'PASS',commands:(await readRunnerVerification(f.specPath,'slice-01')).checks.map(check=>({command:verificationCommand(check),exit:0}))};
  const result={agentId:start.agentId,status:'completed',finalResponse:JSON.stringify(response)};
  await assert.rejects(captureNativeRunnerResult({originFile:start.originFile,result}),/did not execute.*verify-native/);
  const helper=path.resolve('skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs');
  const command=spawnSync(process.execPath,[helper,'verify-native','--origin-file',start.originFile],{cwd:f.root,env,encoding:'utf8'});
  assert.equal(command.status,0,command.stderr);const observed=JSON.parse(command.stdout);assert.equal(observed.checks[0].exit,0);
  const observationFile=path.join(path.dirname(start.originFile),'round-1.verification.json'),metadata=await fs.stat(observationFile);
  const captured=await captureNativeRunnerResult({originFile:start.originFile,result});
  assert.equal((await fs.stat(observationFile)).mtimeMs,metadata.mtimeMs);
  await verifyNativeRunnerReceipt({...captured,operation:'VALIDATE_SLICE',slice:'slice-01',workspace:f.root});
  await evidence(f,'R3-native-verify-cli',{observed,missingObservationRefused:true,captureDidNotReplay:true,receipt:JSON.parse(await fs.readFile(captured.receiptFile,'utf8'))});
});
test('U2-R3 distribution permits only the named recipe producer to execute external commands',async()=>{
  const f=await fixture(),root=path.join(f.root,'minimal-distribution'),runtime=path.join(root,'runtime');await fs.mkdir(runtime,{recursive:true});
  for(const file of ['runner-verification.mjs','execution-publication.mjs'])await fs.copyFile(path.resolve('skills/workflows/stnl-slice-executor/runtime',file),path.join(runtime,file));
  assert.deepEqual(await checkDistributableSkill(root,EXECUTION_DISTRIBUTION_POLICY),[]);
  assert.ok((await checkDistributableSkill(root)).some(message=>message.includes('operational runtime must not execute external commands')));
  await fs.writeFile(path.join(runtime,'other-operation.mjs'),'import {execFile} from "node:child_process";\n');
  const refused=await checkDistributableSkill(root,EXECUTION_DISTRIBUTION_POLICY);
  assert.ok(refused.some(message=>message.includes('runtime/other-operation.mjs')));
  await evidence(f,'R3-distribution-capability',{recipeProducerAllowed:true,otherRuntimeRefused:refused});
});
