import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {reservedOperation} from './fixtures/current-native-operation.mjs';
import {bindNative,resume,reserveDispatch,verifyNative} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentActiveExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {resolveCurrentExecutionContext,executionWorkspaceFromContext} from '../skills/workflows/stnl-slice-executor/runtime/execution-workspace.mjs';
import {resolveExecutionFilesystemRoots} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';

// Benchmark ledger accounting and its observation-race adapter are retired.
// Product authority is exercised through official reservation/bind/resume only;
// a human-readable child label never establishes admission.
test('official reservation stays unbound until native bind; arbitrary name is accepted only once',async t=>{
 const f=await reservedOperation(t),before=await fs.readFile(f.dispatch.originFile);
 assert.deepEqual(await resume(f.start.handle),{phase:'dispatch-reserved',nextAction:'bind-same-agent-or-block'});
 await assert.rejects(reserveDispatch(f.start.handle));
 await bindNative(f.start.handle,'/root/arbitrary-name');
 const state=await resume(f.start.handle);
 assert.equal(state.phase,'running');assert.equal(state.nextAction,'await-same-agent');
 assert.equal(state.agentId,'/root/arbitrary-name');
 await assert.rejects(bindNative(f.start.handle,'/root/foreign'));
 const image=await captureCurrentActiveExecution(f.specPath,f.start.owner);
 assert.equal(JSON.parse(Buffer.from(image.activationBytes)).activeAttempt.operationAttemptId,f.start.owner.operationAttemptId);
 assert.deepEqual(await fs.readFile(f.dispatch.originFile),before,'binding does not rewrite frozen origin');
});
for(const mutation of ['agent','round','owner','registry','dispatch','frozen-origin','phase','runner-status'])
test('official controller refuses corrupted native admission: '+mutation,async t=>{
 const f=await reservedOperation(t);await bindNative(f.start.handle,'/root/check');
 const root=path.dirname(f.dispatch.originFile),marker=path.join(root,'owner.json');
 if(mutation==='agent'){
  const file=path.join(root,'round-1.agent.json'),value=JSON.parse(await fs.readFile(file));
  value.agentId='/root/foreign';await fs.writeFile(file,JSON.stringify(value));
 }else if(mutation==='frozen-origin'){
  const value=JSON.parse(await fs.readFile(f.dispatch.originFile));value.dispatchId='foreign';
  await fs.writeFile(f.dispatch.originFile,JSON.stringify(value));
 }else if(mutation==='registry'){
  const {workspace,context}=await resolveCurrentExecutionContext(f.specPath);
  const roots=await resolveExecutionFilesystemRoots(executionWorkspaceFromContext(context,workspace));
  const value=JSON.parse(await fs.readFile(roots.operationRegistry));value.operations=[];
  await fs.writeFile(roots.operationRegistry,JSON.stringify(value));
 }else{
  const value=JSON.parse(await fs.readFile(marker));
  if(mutation==='round')value.runner.round=2;
  if(mutation==='owner')value.binding.owner.operation='EXECUTE_SLICE';
  if(mutation==='dispatch')value.runner.dispatchId='foreign';
  if(mutation==='phase')value.phase='foreign';
  if(mutation==='runner-status')value.runner.status='unknown';
  await fs.writeFile(marker,JSON.stringify(value));
 }
 await assert.rejects(verifyNative(f.dispatch.originFile));
});
