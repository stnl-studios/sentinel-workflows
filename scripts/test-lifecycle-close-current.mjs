import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {syncBuiltinESMExports} from 'node:module';
import {publishCandidate,recoverIncompletePublication,TEST_ONLY_ACK,TEST_ONLY_ACK_ENV,TEST_ONLY_CRASH_ENV} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveExecutionFilesystemRoots,createLifecycleCloseArchive} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs';
import {deriveCloseExecutionDisposition,validateCloseTransition,validateWorkspace} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs';
import {temporaryDirectory,READY_FIXTURE,PUBLISHER_CLI,copyTree,snapshot} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

async function fixture(t){const root=await temporaryDirectory('lifecycle-close-current-');t.after(()=>fs.rm(root,{recursive:true,force:true}));const target=path.join(root,'target');await copyTree(READY_FIXTURE,target);return {root,target};}

test('normal CLOSE renders directly into its single existing owned stage and preserves externals',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.target,'assets'));await fs.writeFile(path.join(f.target,'assets','bytes.bin'),Buffer.from([0,1,255]));
 const mkdir=fs.mkdir;let stages=0;
 fs.mkdir=async function(file,...args){if(String(file).includes('.lifecycle-stage-'))stages++;return mkdir.call(this,file,...args);};
 syncBuiltinESMExports();
 try{assert.deepEqual(await deriveCloseExecutionDisposition(f.target),{kind:'absent'});await publishCandidate('CLOSE',f.target,null);}
 finally{fs.mkdir=mkdir;syncBuiltinESMExports();}
 assert.equal(stages,1);assert.equal(validateWorkspace(f.target).closed,true);assert.deepEqual(await fs.readFile(path.join(f.target,'assets','bytes.bin')),Buffer.from([0,1,255]));
 assert.equal(await fs.stat(path.join(f.target,'execution')).catch(()=>null),null);
});

test('external CLOSE candidate is refused before any allocation or source mutation',async t=>{
 const f=await fixture(t),input=path.join(f.root,'external');await copyTree(READY_FIXTURE,input);const before=snapshot(f.target),names=await fs.readdir(f.root);
 await assert.rejects(publishCandidate('CLOSE',f.target,input),/does not accept an external candidate/u);
 assert.equal(snapshot(f.target),before);assert.deepEqual(await fs.readdir(f.root),names);
});

test('opaque, unknown or foreign execution cannot authorize CLOSE and is preserved before allocation',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.target,'execution'));await fs.writeFile(path.join(f.target,'execution','foreign.txt'),'preserve me');const before=snapshot(f.target),names=await fs.readdir(f.root);
 await assert.rejects(publishCandidate('CLOSE',f.target,null),/cannot discard execution/u);
 assert.equal(snapshot(f.target),before);assert.deepEqual(await fs.readdir(f.root),names);
});

test('CLOSE admission blocks unresolved current drift even with textual runbook PASS',async t=>{
 const f=await completedNativeCase(t,{documentarySource:READY_FIXTURE,drift:true});
 const target=path.dirname(f.specPath);assert.equal(validateWorkspace(target).status,'ready');
 await fs.mkdir(path.join(target,'runbook'));
 await fs.writeFile(path.join(target,'runbook','results.json'),JSON.stringify({status:'PASS',criteria:'all',source:'manual checklist'}));
 const local=await captureCurrentExecution(f.specPath);assert.notEqual(local.inspection.state,'COMPLETE');
 await assert.rejects(deriveCloseExecutionDisposition(target),/requires current integral COMPLETE/u);
 await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
 const complete=await captureCurrentExecution(f.specPath);assert.equal(complete.inspection.state,'COMPLETE');
 const {closedDocumentFixture}=await import('../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/helpers.mjs');
 const staged=closedDocumentFixture(target,path.join(f.root,'documentary-closed-stage'));
 const validation=await validateCloseTransition(target,staged);assert.equal(validation.sourceExecutionDisposition.kind,'discard-current-complete');
 const disposition=await deriveCloseExecutionDisposition(target);assert.equal(disposition.kind,'discard-current-complete');assert.equal(disposition.activationId,complete.inspection.activationId);assert.equal(disposition.requirementsAuthority,complete.requirementsAuthority);
 await fs.appendFile(path.join(f.root,f.productFile),'// current product drift\n');
 await assert.rejects(deriveCloseExecutionDisposition(target),/COMPLETE|cannot discard execution/u);
});


test('CLOSE reuses authenticated historical coverage without a new terminal judgment',async t=>{
 const f=await completedNativeCase(t,{documentarySource:READY_FIXTURE,drift:false});
 const target=path.dirname(f.specPath),before=await captureCurrentExecution(f.specPath);
 assert.equal(before.inspection.state,'COMPLETE');
 const book=JSON.parse(Buffer.from(before.files.get('continuity.json')));
 for(const item of [...book.deliveries,...book.completed]) {
  const bundle=JSON.parse(Buffer.from(before.files.get(item.evidence.path)));
  assert.equal(bundle.validation.contract.terminal,null);
 }
 const disposition=await deriveCloseExecutionDisposition(target);
 assert.equal(disposition.kind,'discard-current-complete');
 assert.equal(disposition.activationId,before.inspection.activationId);
 // Admission is read-only: it reuses proofs instead of minting another validation.
 const after=await captureCurrentExecution(f.specPath);
 assert.deepEqual(after.activationBytes,before.activationBytes);
 assert.deepEqual(after.files,before.files);
 const result=await publishCandidate('CLOSE',target,null);
 assert.equal(result.cleanup,'complete');assert.ok(result.historicalArchive);
 const archive=JSON.parse(await fs.readFile(result.historicalArchive));
 const retained=new Map(archive.executionSnapshot.files.map(row=>[row.path,Buffer.from(row.bytesBase64,'base64')]));
 assert.equal(archive.executionSnapshot.activationId,before.inspection.activationId);
 assert.deepEqual(retained.get('activation.json'),Buffer.from(before.activationBytes));
 for(const [name,bytes] of before.files)assert.deepEqual(retained.get(name),Buffer.from(bytes),name);
 assert.equal(await fs.stat(path.join(target,'execution')).catch(()=>null),null);
 assert.equal(await recoverIncompletePublication(target),false);
});

// Recovery must preserve the source until the sealed historical image is intact.
test('CLOSE snapshot corruption blocks recovery before retirement and retry retains exact history',async t=>{
 const f=await completedNativeCase(t,{documentarySource:READY_FIXTURE,drift:false});
 const target=path.dirname(f.specPath);
 await assert.rejects(promisify(execFile)(process.execPath,[PUBLISHER_CLI,'CLOSE',target],{
  timeout:120000,env:{...process.env,[TEST_ONLY_ACK_ENV]:TEST_ONLY_ACK,[TEST_ONLY_CRASH_ENV]:'TERMINAL_WITNESS_DURABLE'}
 }),error=>error.signal==='SIGKILL');
 const roots=await resolveExecutionFilesystemRoots({specRoot:target,executionRoot:path.join(target,'execution')});
 const witness=JSON.parse(await fs.readFile(roots.lockPath)).terminalRetirement;
 const binding=witness.closeBinding.historicalArchive,original=await fs.readFile(binding.path);
 const backup=witness.roles.find(row=>row.identity.ino===witness.closeBinding.sourceIdentity.ino);
 const backupPath=path.join(roots.materialRoot,backup.path),identity=(await fs.stat(backupPath)).ino;
 await fs.appendFile(binding.path,'changed');
 await assert.rejects(recoverIncompletePublication(target),/archive|owned file/u);
 assert.equal((await fs.stat(backupPath)).ino,identity);
 await fs.writeFile(binding.path,original);
 const result=await recoverIncompletePublication(target);
 assert.equal(result.cleanup,'complete');assert.equal(result.historicalArchive,binding.path);
 assert.deepEqual(await fs.readFile(binding.path),original);
 assert.equal(await recoverIncompletePublication(target),false);
});


test('historical execution snapshot rejects traversal, duplicate paths and altered payload before allocation',async ()=>{
 await assert.rejects(createLifecycleCloseArchive(null,null,[],[],{requirementsAuthority:null,activationId:null,files:[]}),/historical execution authority invalid/u);
 const row={path:'activation.json',bytesBase64:Buffer.from('{}').toString('base64'),sha256:'sha256:'+'0'.repeat(64)};
 for(const name of ['../outside','/absolute','a/../b','a\\b','a//b']){
  await assert.rejects(createLifecycleCloseArchive(null,null,[],[],{requirementsAuthority:'sha256:'+'a'.repeat(64),activationId:'12345678-1234-1234-1234-123456789abc',files:[{...row,path:name}]}),/historical execution paths invalid/u);
 }
 const {createHash}=await import('node:crypto');
 const valid={...row,sha256:'sha256:'+createHash('sha256').update('{}').digest('hex')};
 await assert.rejects(createLifecycleCloseArchive(null,null,[],[],{requirementsAuthority:'sha256:'+'a'.repeat(64),activationId:'12345678-1234-1234-1234-123456789abc',files:[valid,valid]}),/historical execution paths invalid/u);
 await assert.rejects(createLifecycleCloseArchive(null,null,[],[],{requirementsAuthority:'sha256:'+'a'.repeat(64),activationId:'12345678-1234-1234-1234-123456789abc',files:[row]}),/historical execution bytes differ/u);
});
