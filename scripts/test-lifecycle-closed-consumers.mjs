import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {publishCandidate} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {temporaryDirectory,READY_FIXTURE,copyTree,snapshot} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
import {resolveExecutionFilesystemRoots} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs';
const run=promisify(execFile),repo=process.cwd(),url=relative=>pathToFileURL(path.join(repo,relative)).href;
for(const inaccessible of [false,true])test(`new public consumers read closed after cleanup with temporary namespace ${inaccessible?'inaccessible':'absent'}`,async t=>{
 const root=await fs.realpath(await temporaryDirectory('u314-closed-readers-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const target=path.join(root,'target');await copyTree(READY_FIXTURE,target);
 assert.equal((await publishCandidate('CLOSE',target,null)).cleanup,'complete');const roots=await resolveExecutionFilesystemRoots({specRoot:target,executionRoot:path.join(target,'execution')});assert.equal(await fs.lstat(roots.materialRoot).catch(()=>null),null);const before=snapshot(root);
 const code=`import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
 const target=process.argv[1],temporary=process.argv[2];let temporaryReads=0;
 for(const method of ['mkdir','writeFile','appendFile','unlink','rename','link','symlink','rmdir','rm'])fs[method]=async()=>{throw new Error('reader attempted mutation '+method);};
 ${inaccessible?`for(const method of ['readFile','lstat','stat','readdir','open','realpath','access']){const original=fs[method];fs[method]=async function(file,...args){if(typeof file==='string'&&(file===temporary||file.startsWith(temporary+'/'))){temporaryReads++;throw Object.assign(new Error('temporary namespace inaccessible'),{code:'EACCES'});}return original.call(this,file,...args);};}`:''}
 syncBuiltinESMExports();
 for(const skill of ${JSON.stringify(['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor','stnl-slice-quality-manager','stnl-spec-roadmap','stnl-spec-test-runbook'])}){
  const facade=await import(${JSON.stringify(url('skills/workflows/'))}+skill+'/runtime/execution-state.mjs');const image=await facade.inspectExecutionState(target);assert.equal(image.state,'SPEC_CLOSED');assert.equal(image.normalHandoff,null);assert.equal(image.activationId,null);assert.deepEqual(image.completed,[]);assert.deepEqual(image.deliveries,[]);
 }
 const reader=await import(${JSON.stringify(url('skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-current-reader.mjs'))});assert.equal((await reader.inspectCurrentExecution(target)).state,'SPEC_CLOSED');
 const lifecycle=await import(${JSON.stringify(url('skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs'))});assert.equal(lifecycle.deriveLifecycleHandoff(target).execution_state,'NOT_APPLICABLE');assert.equal(lifecycle.deriveLifecycleHandoff(target).normal_handoff,null);
 const projection=await import(${JSON.stringify(url('skills/workflows/stnl-spec-roadmap/runtime/lib/projection.mjs'))});const projected=await projection.projectRoadmap({candidates:[{id:'CAND-001',spec_path:'target',depends_on:[]}],coverage:[],gaps:[]},path.dirname(target));const item=projected.candidates.get('CAND-001');assert.equal(item.documentary_status,'closed');assert.equal(item.execution_state,'SPEC_CLOSED');assert.equal(item.dependency_verdict,'UNKNOWN');assert.equal(item.lifecycle_handoff,null);
 const runbook=await import(${JSON.stringify(url('skills/workflows/stnl-spec-test-runbook/runtime/lib/core.mjs'))});const spec=await runbook.inspectWorkspace(target,'SPEC',{});assert.deepEqual(spec.mandatory_sources,[path.join(target,'feature_spec.md')]);
 for(const [scope,selection] of [['EXECUTION',{}],['SLICE',{slice:'1'}],['TASK',{slice:'1',task:'1.1'}],['MULTI_SLICE',{slices:['1','2']}]])await assert.rejects(runbook.inspectWorkspace(target,scope,selection),error=>error.code==='SPEC_CLOSED');
 assert.equal(temporaryReads,0);console.log(JSON.stringify({state:'SPEC_CLOSED',projection:'UNKNOWN',temporaryReads}));`;
 const result=JSON.parse((await run(process.execPath,['--input-type=module','-e',code,target,roots.temporaryRoot],{timeout:30000})).stdout);assert.equal(result.state,'SPEC_CLOSED');assert.equal(result.projection,'UNKNOWN');assert.equal(snapshot(root),before);
});
