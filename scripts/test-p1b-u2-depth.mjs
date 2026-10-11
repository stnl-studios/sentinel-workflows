import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {fixture,approveFixture} from './test-p1b-preparation.mjs';
import {evidence} from './test-p1b-continuity.mjs';
import {resolveExecutionWorkspace,readExecutionActivation,beginPreparedExecutionOperation} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {classifyOwnedAllocation,assertOwnedPreparationCandidate,captureExecutionTree,preparationRegistryPath} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {prepareExecutionCopy} from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';

const environment={...process.env};delete environment.NODE_TEST_CONTEXT;
const consumers=['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor','stnl-slice-quality-manager','stnl-spec-roadmap','stnl-spec-test-runbook'];
const deepRoot=(root,depth)=>path.join(root,...Array.from({length:depth},(_,index)=>`level-${index+1}`));
async function apparentSpec(root,depth) {
  const directory=deepRoot(root,depth),file=path.join(directory,'feature_spec.md');
  await fs.mkdir(directory,{recursive:true});await fs.writeFile(file,'# Candidate resemblance; never an official authority\n');
  return {directory,file};
}
async function rejectedSelections(resolveWorkspace,selected) {
  const before=await fs.readFile(selected.file),results=[];
  for(const selection of [selected.directory,selected.file]) {
    let diagnostic=null;
    await assert.rejects(resolveWorkspace(selection),error=>{diagnostic=error.message;return /owned operational candidate\/stage\/backup cannot be selected as official SPEC_PATH/u.test(error.message);});
    results.push({selection,accepted:false,diagnostic});
  }
  assert.deepEqual(await fs.readFile(selected.file),before);
  return results;
}

test('U2-R4-F1 genuine pre-PLAN candidates exclude every physical descendant in all six consumers',async()=>{
  const f=await fixture(),marker=f.candidate+'.owner.json',registry=await preparationRegistryPath(f.workspace),registryBytes=await fs.readFile(registry);
  const selections=[];
  for(const depth of [0,1,2,3,5,12,40])selections.push({depth,...await apparentSpec(f.candidate,depth)});
  const module=pathToFileURL(path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs')).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {classifyOwnedAllocation} from ${JSON.stringify(module)};console.log(JSON.stringify(await classifyOwnedAllocation(${JSON.stringify({workspace:f.workspace,marker})})));`],{env:environment,encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout).classification,'active');
  await assertOwnedPreparationCandidate({candidateExecutionRoot:f.candidate,resolveWorkspace:resolveExecutionWorkspace});
  const results=[];
  for(const consumer of consumers) {
    const {resolveExecutionWorkspace:resolveWorkspace}=await import(pathToFileURL(path.resolve('skills/workflows',consumer,'runtime/execution-state.mjs')).href);
    for(const selected of selections)results.push({consumer,depth:selected.depth,observations:await rejectedSelections(resolveWorkspace,selected)});
  }
  assert.deepEqual(await fs.readFile(registry),registryBytes,'Discovery must not change the trusted creation association');
  assert.equal(await fs.stat(f.workspace.executionRoot).catch(()=>null),null,'Discovery cannot activate the pre-PLAN execution');
  await evidence(f,'R4-F1-preplan-depth',{depths:selections.map(s=>s.depth),consumers,child:{exit:child.status,stdout:child.stdout},results,registryUnchanged:true});
});

test('U2-R4-F1 stale preparation descendants remain operational and stale guard still refuses use',async()=>{
  const f=await fixture();await approveFixture(f);
  const marker=f.candidate+'.owner.json',current=await readExecutionActivation(f.specPath),before=await captureExecutionTree(f.workspace.executionRoot);
  assert.equal((await classifyOwnedAllocation({workspace:f.workspace,marker,activation:current.activation})).classification,'diagnostic');
  const results=[];
  for(const depth of [3,12,40])results.push({depth,observations:await rejectedSelections(resolveExecutionWorkspace,await apparentSpec(f.candidate,depth))});
  await assert.rejects(assertOwnedPreparationCandidate({candidateExecutionRoot:f.candidate,resolveWorkspace:resolveExecutionWorkspace}),/source\/CAS is stale/);
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
  await evidence(f,'R4-F1-stale-depth',{classification:'diagnostic',staleUseRejected:true,results,officialUnchanged:true});
});

test('U2-R4-F1 unproven fabricated or copied ancestor markers cannot exclude legitimate deep SPECs',async()=>{
  const f=await fixture();await approveFixture(f);
  const donor=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN'}),genuine=JSON.parse(await fs.readFile(donor.candidateExecutionRoot+'.owner.json','utf8'));
  const sibling=path.join(f.root,'legitimate-sibling');await fs.mkdir(sibling);
  const marker=sibling+'.owner.json',selected=await apparentSpec(sibling,12),bytes=await fs.readFile(selected.file),identity=(await captureExecutionTree(sibling)).identity;
  const records=[{...genuine,allocationId:randomUUID(),candidate:sibling,retentionRoot:sibling,candidateIdentity:identity,operation:'PLAN',source:null,expectedActivationId:null},
    {...genuine,candidate:sibling,retentionRoot:sibling,candidateIdentity:identity}];
  const registry=await preparationRegistryPath(f.workspace),registryBytes=await fs.readFile(registry),results=[];
  for(const [index,record] of records.entries()) {
    await fs.writeFile(marker,JSON.stringify(record));
    await assert.rejects(classifyOwnedAllocation({workspace:f.workspace,marker,activation:(await readExecutionActivation(f.specPath)).activation}),/producer association/);
    await assert.rejects(assertOwnedPreparationCandidate({candidateExecutionRoot:sibling,resolveWorkspace:resolveExecutionWorkspace}),/producer association/);
    for(const consumer of consumers) {
      const {resolveExecutionWorkspace:resolveWorkspace}=await import(pathToFileURL(path.resolve('skills/workflows',consumer,'runtime/execution-state.mjs')).href);
      for(const selection of [selected.directory,selected.file]) {
        const resolved=await resolveWorkspace(selection);assert.equal(resolved.specRoot,selected.directory);
        results.push({case:index===0?'fabricated':'copied-updated-witness',consumer,selection,accepted:true,specRoot:resolved.specRoot});
      }
    }
  }
  await fs.writeFile(marker,'{"invalid":');
  assert.equal((await resolveExecutionWorkspace(selected.file)).specRoot,selected.directory);
  await fs.writeFile(marker+'.target',JSON.stringify(records[1]));await fs.unlink(marker);await fs.symlink(marker+'.target',marker);
  assert.equal((await resolveExecutionWorkspace(selected.directory)).specRoot,selected.directory,'Unsafe hints do not become authority');
  assert.deepEqual(await fs.readFile(selected.file),bytes);assert.deepEqual(await fs.readFile(registry),registryBytes);
  await evidence(f,'R4-F1-unproven-depth',{results,malformedHintIgnored:true,symlinkHintIgnored:true,bytesAndRegistryPreserved:true});
});

test('U2-R4-F1 registered execution copies exclude deep descendants while copied hints remain unproven',async()=>{
  const f=await fixture(),approved=await approveFixture(f),admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',approved.activation.activationId);
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:admitted.owner}),marker=copy.candidateRoot+'.copy.json';
  const before=await captureExecutionTree(f.workspace.executionRoot),envelope=JSON.parse(await fs.readFile(marker,'utf8'));
  assert.equal((await classifyOwnedAllocation({workspace:f.workspace,marker,activation:(await readExecutionActivation(f.specPath)).activation})).classification,'active');
  const owned=await apparentSpec(copy.candidateRoot,12),ownedResults=await rejectedSelections(resolveExecutionWorkspace,owned);
  const sibling=path.join(f.root,'unregistered-copy-hint');await fs.mkdir(sibling);const selected=await apparentSpec(sibling,12),unregistered=sibling+'.copy.json';
  await fs.writeFile(unregistered,JSON.stringify({...envelope,candidate:sibling,retentionRoot:sibling}));
  await assert.rejects(classifyOwnedAllocation({workspace:f.workspace,marker:unregistered}),/producer registration/);
  assert.equal((await resolveExecutionWorkspace(selected.directory)).specRoot,selected.directory);
  assert.equal((await resolveExecutionWorkspace(selected.file)).specRoot,selected.directory);
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
  await evidence(f,'R4-F1-copy-depth',{ownedResults,unregisteredDeepSpecAccepted:true,officialUnchanged:true});
});

test('U2-R4-F1 unowned deep standalone authority terminates ancestry traversal in another process',async()=>{
  const f=await fixture(),directory=deepRoot(f.root,40);await fs.mkdir(directory,{recursive:true});
  const authority=path.join(directory,'requirements.md');await fs.writeFile(authority,'# Legitimate deep standalone authority\n');
  const module=pathToFileURL(path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-state.mjs')).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {resolveExecutionWorkspace} from ${JSON.stringify(module)};console.log(JSON.stringify(await resolveExecutionWorkspace(${JSON.stringify(authority)})));`],{env:environment,encoding:'utf8',timeout:10000});
  assert.equal(child.status,0,child.stderr);const resolved=JSON.parse(child.stdout);assert.equal(resolved.authorityPath,authority);assert.equal(resolved.kind,'standalone');
  await evidence(f,'R4-F1-unowned-termination',{child:{exit:child.status,stdout:child.stdout},resolved});
});
