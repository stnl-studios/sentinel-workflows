import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';
import {resolveCurrentExecutionContext} from '../skills/workflows/stnl-execution-planner/runtime/execution-workspace.mjs';
import {resolveExecutionFilesystemRoots,executionLockIdentity} from '../skills/workflows/stnl-execution-planner/runtime/execution-publication.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {assertPreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs';
import {allocateCurrentLocalReviewCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const run=promisify(execFile),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const selectors=['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS'];
async function fixture(t,{ignored=true,git=true}={}) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'u314-producer-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const product=path.join(root,'product with spaces');await fs.mkdir(path.join(product,'specs'),{recursive:true});
 if(git){await run('git',['init','-q',product]);await fs.writeFile(path.join(product,'.gitignore'),ignored?'/tmp/sentinel/\n':'!/tmp/\n!/tmp/sentinel/\n');}
 const specPath=path.join(product,'specs','requirements.md');await fs.writeFile(specPath,'# Requirements\n\nAC-001: normal preparation.\n');
 const temporaryRoot=path.join(root,'excluded operations'),extra=path.join(root,'other excluded');
 const filesystemContext=git?null:{productRoot:product,temporaryRoot,excludedRoots:[extra,temporaryRoot]};
 const resolved=await resolveCurrentExecutionContext(specPath,{filesystemContext});
 return {root,product,specPath,...resolved,filesystemContext};
}
async function snapshot(root) {
 const rows=[];
 async function visit(directory){for(const name of (await fs.readdir(directory)).sort()){
  const file=path.join(directory,name),meta=await fs.lstat(file);
  rows.push([path.relative(root,file),String(meta.dev),String(meta.ino),meta.mode,meta.nlink,
   meta.isSymbolicLink()?await fs.readlink(file):meta.isFile()?sha(await fs.readFile(file)):'directory']);
  if(meta.isDirectory()&&!meta.isSymbolicLink())await visit(file);
 }}
 await visit(root);return rows;
}
async function unchanged(f,action){const before=await snapshot(f.root);await action();assert.deepEqual(await snapshot(f.root),before);}
const actors={
 preparation:f=>preparePreparationCandidate({specPath:f.specPath,operation:'PLAN',filesystemContext:f.filesystemContext}),
 localReview:f=>allocateCurrentLocalReviewCandidate(f.context,{filesystemContext:f.filesystemContext}),
};
for(const [name,allocate] of Object.entries(actors)) {
 test(`${name}: exclusion fails before any operational mkdir`,async t=>{
  const f=await fixture(t,{ignored:false});
  await unchanged(f,()=>assert.rejects(allocate(f),e=>e.code==='TEMP_ROOT_UNPROVEN'));
  assert.equal(await fs.stat(path.join(f.product,'tmp')).catch(()=>null),null);
 });
 test(`${name}: normal ignored allocation stays in the single resolved namespace`,async t=>{
  const f=await fixture(t),roots=await resolveExecutionFilesystemRoots(f.workspace);
  const result=await allocate(f),candidate=typeof result==='string'?result:result.candidateExecutionRoot;
  assert.equal(path.dirname(candidate),roots.materialRoot);
  assert.equal(await fs.realpath(candidate),candidate);
  assert.equal(await fs.stat(roots.lockPath).catch(()=>null),null,'successful allocator must release its common lease');
  if(name==='preparation') {
   const owned=await assertPreparationCandidate(candidate,f.specPath);
   assert.equal(owned.marker.format,'stnl-preparation-allocation-v2');
   assert.equal(path.dirname(owned.root),roots.materialRoot);
   const registry=JSON.parse(await fs.readFile(roots.preparationRegistry));
   assert.equal(registry.format,'stnl-preparation-registry-v2');
   assert.deepEqual(registry.allocations[0].filesystemBinding,owned.marker.filesystemBinding);
   assert.equal((await fs.lstat(roots.materialRoot)).ino.toString(),owned.marker.filesystemBinding.materialRootIdentity.ino);
  }
 });
 test(`${name}: inherited Git authority selectors block with zero allocation`,async t=>{
  const f=await fixture(t);
  for(const field of selectors){const present=Object.hasOwn(process.env,field),before=process.env[field];
   process.env[field]=field==='GIT_CONFIG_COUNT'?'0':'fixture selector';
   try{await unchanged(f,()=>assert.rejects(allocate(f),e=>e.code==='TEMP_ROOT_UNPROVEN'));}
   finally{if(present)process.env[field]=before;else delete process.env[field];}
  }
 });
}

test('equivalent explicit policy set reenters its registered physical allocation',async t=>{
 const f=await fixture(t,{git:false});
 const start=await actors.preparation(f);
 const reordered={...f.filesystemContext,excludedRoots:[...f.filesystemContext.excludedRoots].reverse()};
 await unchanged(f,async()=>{
  const owned=await assertPreparationCandidate(start.candidateExecutionRoot,f.specPath,{filesystemContext:reordered});
  assert.deepEqual(owned.marker.filesystemContext.excludedRoots,[...reordered.excludedRoots].sort());
  const review=await preparePreparationCandidate({specPath:f.specPath,operation:'REVIEW_PLAN',candidateExecutionRoot:owned.root,filesystemContext:reordered});
  assert.equal(review.status,'AWAITING_REVIEW');
 });
});

for(const role of ['materialRoot','temporaryRoot','targetParent'])test(`preparation rejects physical ${role} replacement while candidate and controls retain their own inodes`,async t=>{
 const f=await fixture(t),start=await actors.preparation(f);
 const roots=await resolveExecutionFilesystemRoots(f.workspace),directory=roots[role],saved=directory+'.test-owned-previous';
 await fs.rename(directory,saved);await fs.mkdir(directory);
 for(const name of await fs.readdir(saved))await fs.rename(path.join(saved,name),path.join(directory,name));
 await unchanged(f,()=>assert.rejects(assertPreparationCandidate(start.candidateExecutionRoot,f.specPath),/filesystem|physical|policy/u));
});

test('legacy preparation controls block new allocation without adoption or deletion',async t=>{
 const f=await fixture(t),roots=await resolveExecutionFilesystemRoots(f.workspace),old=path.join(roots.targetParent,`.stnl-execution-${roots.specKey}.preparations.json`);
 await fs.writeFile(old,'{"format":"stnl-preparation-registry-v1","foreign":"preserve"}\n');
 await unchanged(f,()=>assert.rejects(actors.preparation(f),e=>e.code==='EXECUTION_PUBLICATION_BLOCKED'));
 assert.equal(await fs.stat(path.join(f.product,'tmp')).catch(()=>null),null);
});

test('lifecycle-family common lease excludes admissible PLAN and local-review allocation before mkdir',async t=>{
 const f=await fixture(t),roots=await resolveExecutionFilesystemRoots(f.workspace);
 await fs.mkdir(roots.materialRoot,{recursive:true});
 const {withExecutionPublicationLock}=await import('../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs');
 await withExecutionPublicationLock(f.workspace,async()=>{
  for(const allocate of Object.values(actors))await unchanged(f,()=>assert.rejects(allocate(f),/lock already exists/u));
 });
 const next=await actors.preparation(f);assert.ok(next.candidateExecutionRoot);
});
