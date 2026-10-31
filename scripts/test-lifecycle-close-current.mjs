import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {syncBuiltinESMExports} from 'node:module';
import {publishCandidate} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {deriveCloseExecutionDisposition,validateCloseTransition,validateWorkspace} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs';
import {temporaryDirectory,READY_FIXTURE,copyTree,snapshot} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
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

test('CLOSE admission uses the real integral COMPLETE reader, not local PASS or textual markers',async t=>{
 const f=await completedNativeCase(t,{documentarySource:READY_FIXTURE,drift:true});
 const target=path.dirname(f.specPath);assert.equal(validateWorkspace(target).status,'ready');
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
