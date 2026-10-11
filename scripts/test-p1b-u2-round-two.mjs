import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture,approveFixture,verificationBody} from './test-p1b-preparation.mjs';
import {setSection,evidence} from './test-p1b-continuity.mjs';
import {resolveExecutionWorkspace,readExecutionActivation,preflightExecutionOperation} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {classifyOwnedAllocation,captureExecutionTree,assertOwnedPreparationCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';

async function observe(fn) {try {return {value:await fn()};}catch(error) {return {error:error.message};}}
async function siblingFixture() {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stnl-u2-r2-marker-')));
  const specPath=path.join(root,'requirements.md');await fs.writeFile(specPath,'# Requirements\n');
  const workspace=await resolveExecutionWorkspace(specPath);
  const sibling=path.join(root,'legitimate-spec');await fs.mkdir(sibling);
  const file=path.join(sibling,'feature_spec.md');await fs.writeFile(file,'# Legitimate sibling authority\n');
  return {root,specPath,workspace,sibling,file,marker:sibling+'.owner.json'};
}

test('U2-V-F1-R2 impossible preparation source and CAS confer no ownership',async()=>{
  const f=await siblingFixture();const original=await fs.readFile(f.file);
  await fs.writeFile(f.marker,JSON.stringify({format:'stnl-preparation-allocation-v1',producer:'preparation',allocationId:randomUUID(),executionRoot:f.workspace.executionRoot,candidate:f.sibling,retentionRoot:f.sibling,operation:'PLAN',specPath:f.specPath,source:'not-a-tree',expectedActivationId:'not-an-activation'}));
  const classified=await observe(()=>classifyOwnedAllocation({workspace:f.workspace,marker:f.marker}));
  const selected=await observe(()=>resolveExecutionWorkspace(f.sibling));
  await evidence(f,'R2-F1-impossible',{classified,selected});
  assert.ok(classified.error,'Impossible source/CAS must not classify as owned');
  assert.equal(selected.value?.specRoot,f.sibling);
  assert.equal((await resolveExecutionWorkspace(f.file)).specRoot,f.sibling);
  assert.deepEqual(await fs.readFile(f.file),original);assert.ok(await fs.stat(f.marker));
});

test('U2-V-F1-R2 copied preparation envelope cannot adopt an unrelated physical root',async()=>{
  const f=await siblingFixture();const donor=await fixture();await approveFixture(donor);
  const live=await readExecutionActivation(donor.specPath);const image=await captureExecutionTree(donor.workspace.executionRoot);
  const genuine=await preparePreparationCandidate({specPath:donor.specPath,operation:'REPLAN'});
  const genuineMarker=genuine.candidateExecutionRoot+'.owner.json';const bytes=await fs.readFile(genuineMarker);
  const envelope=JSON.parse(bytes);await fs.writeFile(f.marker,JSON.stringify({...envelope,candidate:f.sibling,retentionRoot:f.sibling}));
  const classified=await observe(()=>classifyOwnedAllocation({workspace:donor.workspace,marker:f.marker,activation:live.activation}));
  const selected=await observe(()=>resolveExecutionWorkspace(f.sibling));
  await evidence(f,'R2-F1-copied',{donor:donor.root,genuineMarker,classified,selected});
  assert.ok(classified.error,'Source/CAS from a real candidate must not bind another root');
  assert.equal(selected.value?.specRoot,f.sibling);
  await assert.rejects(assertOwnedPreparationCandidate({candidateExecutionRoot:f.sibling,specPath:donor.specPath,resolveWorkspace:resolveExecutionWorkspace}),/identity|allocation|ownership|envelope/);
  assert.equal((await classifyOwnedAllocation({workspace:donor.workspace,marker:genuineMarker,activation:live.activation})).classification,'active');
  // Root ownership is stable through legal editing, but stale CAS remains diagnostic.
  await fs.mkdir(path.join(genuine.candidateExecutionRoot,'nested-spec'));
  await fs.writeFile(path.join(genuine.candidateExecutionRoot,'nested-spec/feature_spec.md'),'# Candidate resemblance\n');
  await assert.rejects(resolveExecutionWorkspace(path.join(genuine.candidateExecutionRoot,'nested-spec')),/owned operational/);
  const forgedFields=[['source','not-a-tree'],['source',null],['expectedActivationId','not-an-activation'],['candidateIdentity',{dev:'0',ino:'0'}],['source',{identity:{dev:'1',ino:'2'},files:[{path:'../escape',type:'directory'}]}]];
  for(const [key,value] of forgedFields) {
    await fs.writeFile(genuineMarker,JSON.stringify({...envelope,[key]:value}));
    await assert.rejects(classifyOwnedAllocation({workspace:donor.workspace,marker:genuineMarker,activation:live.activation}),/source|CAS|envelope|allocation/);
  }
  await fs.writeFile(genuineMarker,bytes);
  assert.deepEqual(await captureExecutionTree(donor.workspace.executionRoot),image);
  assert.deepEqual(await fs.readFile(f.file),Buffer.from('# Legitimate sibling authority\n'));
});

test('U2-V-F2-R2 runtime and version prose is not an undeclared proof file',async()=>{
  const f=await fixture();const description='- node --test src/greeting.test.mjs (Node.js v22.20.0)';
  for(const name of ['plans/slice-01.md','tasks/slice-01.md']) {
    const file=path.join(f.candidate,name);await fs.writeFile(file,setSection(await fs.readFile(file,'utf8'),'Expected Tests',description));
  }
  const approved=await observe(()=>approveFixture(f));
  await evidence(f,'R2-F2-runtime-prose',{description,diagnostic:approved.error,approved:!!approved.value,officialExists:(await captureExecutionTree(f.workspace.executionRoot))!==null});
  assert.ok(approved.value,approved.error);
  assert.equal((await preflightExecutionOperation(f.specPath,'EXECUTE_SLICE','1')).state,'MATERIALIZED_PRISTINE');
  assert.equal(await fs.stat(path.join(f.root,'Node.js')).catch(()=>null),null);
  assert.equal(await fs.stat(path.join(f.root,'v22.20.0')).catch(()=>null),null);
  // Dotted prose remains prose even when an unrelated same-named file exists.
  const prose=await fixture();await fs.writeFile(path.join(prose.root,'Node.js'),'unrelated preexisting product bytes\n');
  await fs.writeFile(path.join(prose.root,'Greeting.length'),'unrelated preexisting product bytes\n');
  for(const name of ['plans/slice-01.md','tasks/slice-01.md']) {
    const file=path.join(prose.candidate,name);
    await fs.writeFile(file,setSection(await fs.readFile(file,'utf8'),'Expected Tests','- node --test src/greeting.test.mjs (V8.js v12.3.4; Node.js v22.20.0)\n- The assertion observes Greeting.length in the exported value.'));
  }
  await approveFixture(prose);
  assert.equal((await preflightExecutionOperation(prose.specPath,'EXECUTE_SLICE','1')).state,'MATERIALIZED_PRISTINE');
  assert.equal(await fs.readFile(path.join(prose.root,'Node.js'),'utf8'),'unrelated preexisting product bytes\n');
  // Explicit typed references replace the obsolete lexical admission assertions.
  // Neither code spans nor prose select a file; its reviewed recipe does.
  for(const body of ['- node --test `.outside.test.mjs`','- `node --test .outside.test.mjs`']) {
    const outside=await fixture();await fs.writeFile(path.join(outside.root,'.outside.test.mjs'),'import test from "node:test";test("existing external proof",()=>{});\n');
    for(const name of ['plans/slice-01.md','tasks/slice-01.md']) {
      const file=path.join(outside.candidate,name);await fs.writeFile(file,setSection(setSection(await fs.readFile(file,'utf8'),'Expected Tests',body),'Verification Recipe',verificationBody({file:'../../.outside.test.mjs',kind:'input'})));
    }
    await assert.rejects(approveFixture(outside),/verification input.*Existing Inputs/);
    assert.equal(await captureExecutionTree(outside.workspace.executionRoot),null);
  }
});
