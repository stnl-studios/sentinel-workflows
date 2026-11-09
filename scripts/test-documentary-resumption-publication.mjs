// Synthetic boundary tests: no historical approval or production result is claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {publishExecutionUpdate,recoverDocumentaryResumptionPublication,captureExecutionTree,
 resolveExecutionFilesystemRoots,assertNoPendingExecutionPublication} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs';
async function fixture(t) {
 const root=await fs.mkdtemp(path.join('/tmp','resumption-publisher-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const productRoot=path.join(root,'product'),specRoot=path.join(productRoot,'spec'),temporaryRoot=path.join(productRoot,'tmp','sentinel');
 const workspace={specRoot,executionRoot:path.join(specRoot,'execution'),filesystemContext:{productRoot,temporaryRoot,excludedRoots:[temporaryRoot]}};
 await fs.mkdir(workspace.executionRoot,{recursive:true});await fs.mkdir(temporaryRoot,{recursive:true});execFileSync('git',['init','-q',productRoot]);await fs.writeFile(path.join(productRoot,'.gitignore'),'tmp/sentinel/\n');
 await fs.writeFile(path.join(workspace.executionRoot,'old-proof.txt'),'old unverified proof\n');
 const roots=await resolveExecutionFilesystemRoots(workspace);await fs.mkdir(roots.materialRoot,{recursive:true});
 const candidate=path.join(roots.materialRoot,'candidate');await fs.mkdir(candidate);
 await fs.writeFile(path.join(candidate,'approved-preparation.json'),'{}\n');await fs.writeFile(path.join(candidate,'plan.md'),'new plan\n');
 const expectedTree=await captureExecutionTree(workspace.executionRoot);
 const readActivated=async()=>({activation:JSON.parse(await fs.readFile(path.join(workspace.executionRoot,'activation.json'),'utf8'))});
 let owned=false;
 const assertResumptionQuiet=async()=>{if(owned)throw Error('native owner uncertain');};
 const options={workspace,candidateExecutionRoot:candidate,expectedTree,expectedActivationId:null,currentResumption:true,
  readActivated,assertResumptionQuiet,authorizeDiff:async()=>{},recheckRequirements:async()=>{},recheckProducts:async()=>{},
  validateCandidate:async()=>({preparationRevision:1,requirementsAuthority:{},normativeSha256:'sha256:'+'1'.repeat(64)})};
 const recover=marker=>recoverDocumentaryResumptionPublication({workspace,marker,readActivated,assertResumptionQuiet,validateInstalledActivation:()=>{}});
 return {root,workspace,candidate,expectedTree,options,recover,setOwner:value=>{owned=value;}};
}
test('new publication retains literal old tree and inerts its marker; recovery is idempotent',async t=>{
 const f=await fixture(t),result=await publishExecutionUpdate(f.options);
 assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');
 assert.deepEqual(await captureExecutionTree(result.retainedBackup),f.expectedTree);
 await assertNoPendingExecutionPublication(f.workspace);
 assert.equal((await f.recover(result.allocation)).publication,'confirmed');
 assert.equal((await f.recover(result.allocation)).publication,'confirmed');
});
for(const phase of ['before-backup','after-backup','after-install','before-activation','after-activation-intent','after-activation','before-resumption-archive'])
 test('literal crash recovery at '+phase,async t=>{
 const f=await fixture(t);let marker;
 try{await publishExecutionUpdate({...f.options,checkpoint:async p=>{if(p===phase)throw Error('synthetic crash');}});}catch(e){marker=e.allocation;}
 assert.ok(marker);const result=await f.recover(marker);
 assert.equal(result.publication,['after-activation','before-resumption-archive'].includes(phase)?'confirmed':'aborted');
 if(result.publication==='aborted')assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),f.expectedTree);
 else assert.deepEqual(await captureExecutionTree(result.retainedBackup),f.expectedTree);
 await assertNoPendingExecutionPublication(f.workspace);
 assert.equal((await f.recover(result.allocation)).publication,result.publication);
 });
test('source CAS, uncertain owner, invalid candidate and symlink block',async t=>{
 for(const kind of ['cas','owner','invalid','symlink'])await t.test(kind,async t=>{
  const f=await fixture(t);
  if(kind==='cas')await fs.writeFile(path.join(f.workspace.executionRoot,'new.txt'),'changed');
  if(kind==='owner')f.setOwner(true);
  if(kind==='invalid')f.options.validateCandidate=async()=>{throw Error('candidate invalid');};
  if(kind==='symlink')await fs.symlink('/tmp',path.join(f.candidate,'escape'));
  const before=await captureExecutionTree(f.workspace.executionRoot);
  await assert.rejects(publishExecutionUpdate(f.options));
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),before);
 });
});
test('late CAS change prevents swap and preserves owner marker',async t=>{
 const f=await fixture(t);
 await assert.rejects(publishExecutionUpdate({...f.options,checkpoint:async p=>{if(p==='before-backup')await fs.writeFile(path.join(f.workspace.executionRoot,'race'),'changed');}}),/base changed/);
 assert.equal(await fs.readFile(path.join(f.workspace.executionRoot,'old-proof.txt'),'utf8'),'old unverified proof\n');
});
test('absent execution is a fresh resumption without fabricated PLAN registration',async t=>{
 const f=await fixture(t);await fs.rm(f.workspace.executionRoot,{recursive:true});
 const result=await publishExecutionUpdate({...f.options,expectedTree:null});
 assert.equal(result.retainedBackup,null);assert.equal(result.activation.previousActivationId,null);
 assert.equal((await f.recover(result.allocation)).publication,'confirmed');
});
test('uncertain native owner blocks recovery despite missing activation and preserves all bytes',async t=>{
 const f=await fixture(t);let marker;
 try{await publishExecutionUpdate({...f.options,checkpoint:async p=>{if(p==='after-backup')throw Error('crash');}});}catch(e){marker=e.allocation;}
 const record=JSON.parse(await fs.readFile(marker));f.setOwner(true);
 const backup=await captureExecutionTree(record.backup),candidate=await captureExecutionTree(f.candidate);
 await assert.rejects(f.recover(marker),/owner uncertain/);
 assert.deepEqual(await captureExecutionTree(record.backup),backup);
 assert.deepEqual(await captureExecutionTree(f.candidate),candidate);
 assert.equal(await captureExecutionTree(f.workspace.executionRoot),null);
 f.setOwner(false);await f.recover(marker);assert.equal((await f.recover(marker)).publication,'aborted');
});
test('changed retained tree blocks recovery instead of restoring foreign bytes',async t=>{
 const f=await fixture(t);let marker;
 try{await publishExecutionUpdate({...f.options,checkpoint:async p=>{if(p==='after-backup')throw Error('crash');}});}catch(e){marker=e.allocation;}
 const record=JSON.parse(await fs.readFile(marker));await fs.writeFile(path.join(record.backup,'old-proof.txt'),'tampered');
 await assert.rejects(f.recover(marker),/roles differ/);
 assert.equal(await captureExecutionTree(f.workspace.executionRoot),null);
});
test('marker-only interrupted allocation can archive without deleting any predecessor',async t=>{
 const f=await fixture(t);let marker;
 try{await publishExecutionUpdate({...f.options,checkpoint:async p=>{if(p==='before-backup')throw Error('crash');}});}catch(e){marker=e.allocation;}
 const record=JSON.parse(await fs.readFile(marker));await fs.rmdir(record.retentionRoot);
 assert.equal((await f.recover(marker)).publication,'aborted');
 assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot),f.expectedTree);
});
