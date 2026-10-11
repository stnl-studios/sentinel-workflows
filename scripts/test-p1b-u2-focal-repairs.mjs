import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fixture,approveFixture,verificationBody} from './test-p1b-preparation.mjs';
import {implementedFixture,formal,native,capture,setSection,evidence} from './test-p1b-continuity.mjs';
import {implementOffline} from './test-p1b-publication.mjs';
import {resolveExecutionWorkspace,readExecutionActivation,beginPreparedExecutionOperation,inspectDeliveryContinuity,inspectExecutionState,validateExecutionCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {classifyOwnedAllocation,captureExecutionTree} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {prepareExecutionCopy,publishExecutionCopy} from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import {serializeRunnerExecutionBundleFromResponse,insertExecutionEvidenceInCandidate} from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';

const environment={...process.env};delete environment.NODE_TEST_CONTEXT;

test('U2-V-F1 plausible marker without producer binding preserves official SPEC selection',async()=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-u2-unproven-')));
  const authority=path.join(root,'requirements.md');await fs.writeFile(authority,'# Requirements\n');
  const workspace=await resolveExecutionWorkspace(authority);
  const sibling=path.join(root,'legitimate-spec');await fs.mkdir(sibling);
  const spec=path.join(sibling,'feature_spec.md');await fs.writeFile(spec,'# Legitimate sibling\n');
  const before=await fs.readFile(spec);assert.equal((await resolveExecutionWorkspace(sibling)).specRoot,sibling);
  const marker=sibling+'.owner.json';
  await fs.writeFile(marker,JSON.stringify({format:'stnl-execution-publication-owner-v1',allocationId:randomUUID(),executionRoot:workspace.executionRoot,candidate:sibling,retentionRoot:sibling}));
  assert.equal((await resolveExecutionWorkspace(sibling)).specRoot,sibling);
  assert.equal((await resolveExecutionWorkspace(spec)).specRoot,sibling);
  await assert.rejects(classifyOwnedAllocation({workspace,marker}),/producer.*envelope|unproven/);
  assert.deepEqual(await fs.readFile(spec),before);assert.ok(await fs.stat(marker));
  // Even plausible capsule names and a self-declared empty retention do not
  // establish the source image of a publication producer.
  const id=randomUUID();const capsule=path.join(root,`.stnl-execution-backup-${id}`);await fs.mkdir(capsule);
  await fs.writeFile(path.join(capsule,'feature_spec.md'),'# Legitimate capsule-named SPEC\n');
  const capsuleMarker=path.join(root,`.stnl-execution-publication-${id}.json`);
  await fs.writeFile(capsuleMarker,JSON.stringify({format:'stnl-execution-publication-owner-v1',allocationId:id,executionRoot:workspace.executionRoot,candidate:capsule,retentionRoot:capsule,owner:null,retention:{allocationId:id,executionRoot:workspace.executionRoot,producer:'preparation-publication',owner:null,retainedPaths:[]}}));
  assert.equal((await resolveExecutionWorkspace(capsule)).specRoot,capsule);
  await assert.rejects(classifyOwnedAllocation({workspace,marker:capsuleMarker}),/producer.*envelope|unproven/);
  // The official producer path remains excluded even while its publication is pending.
  const f=await fixture();const approved=await approveFixture(f);const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
  assert.equal((await classifyOwnedAllocation({workspace:f.workspace,marker:copy.candidateRoot+'.copy.json',activation:(await readExecutionActivation(f.specPath)).activation})).classification,'active');
  const unregisteredMarker=sibling+'.copy.json';
  const copiedEnvelope=JSON.parse(await fs.readFile(copy.candidateRoot+'.copy.json','utf8'));
  await fs.writeFile(unregisteredMarker,JSON.stringify({...copiedEnvelope,candidate:sibling,retentionRoot:sibling}));
  await assert.rejects(classifyOwnedAllocation({workspace:f.workspace,marker:unregisteredMarker}),/producer registration/);
  assert.equal((await resolveExecutionWorkspace(sibling)).specRoot,sibling,'A copied envelope is not a registered allocation');
  const fakeSpec=path.join(copy.candidateRoot,'fake-spec');await fs.mkdir(fakeSpec);await fs.writeFile(path.join(fakeSpec,'feature_spec.md'),'# Candidate resemblance\n');
  await assert.rejects(resolveExecutionWorkspace(fakeSpec),/owned operational/);
  await evidence({root,specPath:spec},'F1',{marker,bytesPreserved:true});
});

async function proofFixture({declared=false,withConfig=false}={}) {
  const f=await fixture();await fs.mkdir(path.join(f.root,'checks'));
  const file=path.join(f.root,'checks/greeting.test.mjs');const config=path.join(f.root,'checks/greeting.config.json');
  if(withConfig)await fs.writeFile(config,'{"greeting":"hello"}\n');
  await fs.writeFile(file,'import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs";import {greeting} from "../src/unpredicted.mjs";test("approved external proof",()=>assert.equal(greeting,'+(withConfig?'JSON.parse(fs.readFileSync("checks/greeting.config.json","utf8")).greeting':'"hello"')+'));\n');
  for(const name of ['plans/slice-01.md','tasks/slice-01.md']) {
    const p=path.join(f.candidate,name);let text=await fs.readFile(p,'utf8');
    text=setSection(text,'Expected Tests','- node --test checks/greeting.test.mjs'+(withConfig?' (configuration `checks/greeting.config.json`)':''));
    text=setSection(text,'Verification Recipe',verificationBody({file:'checks/greeting.test.mjs',kind:'input',inputs:withConfig ? ['checks/greeting.config.json'] : []}));
    if(declared)text=setSection(text,'Existing Inputs','- `checks/greeting.test.mjs`'+(declared==='all'?'\n- `checks/greeting.config.json`':''));
    await fs.writeFile(p,text);
  }
  return {...f,file,config};
}
async function publishAndChangeProof(f) {
  const approved=await approveFixture(f);const owner=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const implementation=await implementOffline(f,owner);f.invocations=1;
  await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implementation.copy.candidateRoot});
  const observed=spawnSync(process.execPath,['--test','checks/greeting.test.mjs'],{cwd:f.root,env:environment,encoding:'utf8'});
  assert.equal(observed.status,0,observed.stdout+observed.stderr);assert.match(observed.stdout,/^# pass 1$/mu);
  await formal(f,{responseOverride:{commands:[{command:'node --test checks/greeting.test.mjs',exit:observed.status}],evidence:observed.stdout}});
  const before=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(before.currentValidation,'current');
  const image=(await readExecutionActivation(f.specPath)).activation;const raw=await fs.readFile(path.join(f.workspace.executionRoot,'tasks/slice-01.md'));
  const configBytes=await fs.readFile(f.config);await fs.writeFile(f.config,'{"greeting":"wrong"}\n');
  const configFailure=spawnSync(process.execPath,['--test','checks/greeting.test.mjs'],{cwd:f.root,env:environment,encoding:'utf8'});assert.equal(configFailure.status,1);
  const configDrift=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(configDrift.currentValidation,'revalidation-required');assert.ok(configDrift.affectedPaths.includes('checks/greeting.config.json'));
  await fs.writeFile(f.config,configBytes);
  await fs.writeFile(f.file,'import test from "node:test";import assert from "node:assert/strict";test("changed proof fails",()=>assert.fail("changed acceptance input"));\n');
  const failed=spawnSync(process.execPath,['--test','checks/greeting.test.mjs'],{cwd:f.root,env:environment,encoding:'utf8'});assert.equal(failed.status,1);assert.match(failed.stdout,/^# fail 1$/mu);
  const after=await inspectDeliveryContinuity(f.specPath,'1');assert.equal(after.currentValidation,'revalidation-required');assert.notEqual(after.state,'COMPLETE');assert.ok(after.affectedPaths.includes('checks/greeting.test.mjs'));
  assert.deepEqual((await readExecutionActivation(f.specPath)).activation,image);assert.deepEqual(await fs.readFile(path.join(f.workspace.executionRoot,'tasks/slice-01.md')),raw);
  await evidence(f,'F2-proof-drift',{before,after,beforeExit:observed.status,afterExit:failed.status,beforeOutput:observed.stdout,afterOutput:failed.stdout,configDrift,configFailureOutput:configFailure.stdout});
}
test('U2-V-F2 an accepted named proof outside product areas has a verified input binding',async()=>{
  const unlinked=await proofFixture();let refused=null;
  try {await approveFixture(unlinked);}catch(error){refused=error;}
  if(refused) {
    assert.match(refused.message,/verification input.*Existing Inputs/);
    assert.equal(await captureExecutionTree(unlinked.workspace.executionRoot),null);
    await evidence(unlinked,'F2-unlinked-rejected',{diagnostic:refused.message});
  } else {
    // Before the repair this official flow accepts the unlinked proof, then hides its failure.
    // Use the already approved image rather than approving it again.
    const current=await readExecutionActivation(unlinked.specPath);const owner=await beginPreparedExecutionOperation(unlinked.specPath,'EXECUTE_SLICE','1',current.activation.activationId);
    const impl=await implementOffline(unlinked,owner);await publishExecutionCopy({specPath:unlinked.specPath,slice:'slice-01',candidateRoot:impl.copy.candidateRoot});
    const observed=spawnSync(process.execPath,['--test','checks/greeting.test.mjs'],{cwd:unlinked.root,env:environment,encoding:'utf8'});assert.equal(observed.status,0);
    await formal(unlinked,{responseOverride:{commands:[{command:'node --test checks/greeting.test.mjs',exit:0}],evidence:observed.stdout}});
    await fs.writeFile(unlinked.file,'import test from "node:test";import assert from "node:assert/strict";test("external proof fails",()=>assert.fail("changed input"));\n');
    assert.equal(spawnSync(process.execPath,['--test','checks/greeting.test.mjs'],{cwd:unlinked.root,env:environment}).status,1);
    const unlinkedAfter=await inspectDeliveryContinuity(unlinked.specPath,'1');await evidence(unlinked,'F2-before-unlinked',{unlinkedAfter,realBeforeExit:observed.status,realAfterExit:1});
    assert.equal(unlinkedAfter.currentValidation,'revalidation-required');
  }
  const partial=await proofFixture({declared:true,withConfig:true});
  await assert.rejects(approveFixture(partial),/verification input.*Existing Inputs/);
  const linked=await proofFixture({declared:'all',withConfig:true});await publishAndChangeProof(linked);
});

test('U2-V-F3 NEEDS_FIX correction PASS reopens twice with true PASS IDs and preserved findings',async()=>{
  const f=await implementedFixture();const phases=[];
  const finding='### finding-01\n\n- Severity: blocking\n- State: active\n- Origin: attempt-01\n- Problem: Add the exact greeting length assertion.\n- Evidence: Prepared proof checks value only.\n- Impact: Controlled proof acceptance is incomplete.\n- Related authority: AC-001\n- Expected correction: Add length assertion in the approved test.';
  await formal(f,{responseOverride:{status:'NEEDS_FIX',findingReferences:'finding-01',findingDispositions:'finding-01=active'},editCandidate:async c=>{const file=path.join(c.candidateExecutionRoot,'tasks/slice-01.md');await fs.writeFile(file,setSection(await fs.readFile(file,'utf8'),'Validation Findings',finding));}});
  const current=await readExecutionActivation(f.specPath);const admitted=await beginPreparedExecutionOperation(f.specPath,'APPLY_FINDINGS','1',current.activation.activationId);
  const start=await native(f,admitted.owner);const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner});
  const text=await fs.readFile(copy.candidateTaskArtifact,'utf8');await fs.writeFile(copy.candidateTaskArtifact,setSection(text,'Corrections Applied','- `../../src/greeting.test.mjs`'));
  await fs.appendFile(path.join(f.root,'src/greeting.test.mjs'),'test("exact greeting length",()=>assert.equal(greeting.length,5));\n');
  const observed=spawnSync(process.execPath,['--test','src/greeting.test.mjs'],{cwd:f.root,env:environment,encoding:'utf8'});assert.equal(observed.status,0);assert.match(observed.stdout,/^# pass 2$/mu);
  const response={...f.implementation.response,commands:[{command:'node --test src/greeting.test.mjs',exit:observed.status}],findingsCycle:'attempt-01',findingsVerified:'finding-01',correctionsCovered:'Added and executed exact length assertion',regressionsSelected:'Prior value assertion executed with new length assertion',unsupportedActiveFindings:'none'};
  for(const key of ['priorRoundFailure','correctionApplied','inSliceRationale'])delete response[key];
  const captured=await capture(start,response,['../../src/greeting.test.mjs','../../src/unpredicted.mjs']);
  const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'APPLY_FINDINGS',response:JSON.stringify(response),workspace:f.root,taskArtifact:copy.candidateTaskArtifact,...captured});
  await insertExecutionEvidenceInCandidate({taskArtifact:copy.candidateTaskArtifact,operation:'APPLY_FINDINGS',bundle,validateProspectiveTask:t=>validateExecutionCandidate(f.specPath,copy.candidateExecutionRoot,[t])});
  await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:copy.candidateRoot});
  const pass=await formal(f,{testCount:2,responseOverride:{findingReferences:'finding-01',findingDispositions:'finding-01=resolved'},editCandidate:async c=>{const file=path.join(c.candidateExecutionRoot,'tasks/slice-01.md');await fs.writeFile(file,setSection(await fs.readFile(file,'utf8'),'Validation Findings',finding.replace('- State: active','- State: resolved')+'\n- Resolution: attempt-02 verifies the actual length assertion.'));}});
  const official=path.join(f.workspace.executionRoot,'tasks/slice-01.md');const rawPass=await fs.readFile(official,'utf8');
  await evidence(f,'F3-published-pass',{rawContinuity:rawPass.match(/## Continuity\n\n([\s\S]*?)(?=\n## )/u)[1],derived:await inspectDeliveryContinuity(f.specPath,'1')});
  assert.match(rawPass,/^- Historical PASS: attempt-02$/mu);
  phases.push({phase:'NEEDS_FIX-then-PASS',info:await inspectDeliveryContinuity(f.specPath,'1'),receipt:pass.captured.receiptFile});
  for(let cycle=1;cycle<=2;cycle++) {
    await fs.appendFile(path.join(f.root,'src/greeting.test.mjs'),`// actual proof drift cycle ${cycle}\n`);
    assert.equal((await inspectDeliveryContinuity(f.specPath,'1')).currentValidation,'revalidation-required');
    await formal(f,{testCount:2,responseOverride:{findingReferences:'finding-01',findingDispositions:'finding-01=resolved'}});
    const state=await inspectExecutionState(f.specPath);const task=state.tasks.get('slice-01');
    assert.equal(state.state,'COMPLETE');assert.equal(task.findings[0].origin,'attempt-01');assert.equal(task.findings[0].state,'resolved');assert.equal(task.findingsChecks[0].id,'findings-check-01');
    assert.equal(task.attempts.at(-1).id,'attempt-'+String(cycle+2).padStart(2,'0'));assert.equal(task.implementationChecks[0].id,'implementation-check-01');
    phases.push({phase:'compact-'+cycle,info:await inspectDeliveryContinuity(f.specPath,'1')});
  }
  const state=await inspectExecutionState(f.specPath);assert.deepEqual(state.tasks.get('slice-01').attempts.map(a=>[a.id,a.status]),[['attempt-01','NEEDS_FIX'],['attempt-02','PASS'],['attempt-03','PASS'],['attempt-04','PASS']]);
  assert.equal([...((await fs.readFile(official,'utf8')).matchAll(/^### attempt-/gmu))].length,1);
  assert.equal(f.invocations,6,'One implementation, three formal revalidations plus initial NEEDS_FIX and one APPLY');
  await evidence(f,'F3-two-cycles',{phases,realCorrectionOutput:observed.stdout});
});
