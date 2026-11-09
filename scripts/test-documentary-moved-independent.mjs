import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {fixture,implement} from './fixtures/portable-resume-independent.mjs';
import {inspectRequestedOperation,prepareDocumentaryResumption,installDocumentaryResumption} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {normalizedFormal} from './fixtures/portable-formal-independent.mjs';
import {ChildProcess} from 'node:child_process';
function reviewOf(authority){const hashes=new Map(authority.artifactHashes.map(x=>[x.path,x.sha256]));const review=(scope,authoritySha256,names)=>({scope,decision:'approved',authoritySha256,examinedArtifactHashes:names.sort().map(path=>({path,sha256:hashes.get(path)})),evidenceDecisions:[],summary:'Synthetic current-byte review for new documentary context, never historical approval.'});return {globalReview:review('set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:authority.deliveries.map(d=>({deliveryId:d.deliveryId,review:review('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};}
test('different physical root reaches fresh formal PASS and preserves original bytes',async t=>{
 const original=await fixture(t,true,{single:true});
 const root=await fs.mkdtemp(path.resolve('tmp/documentary-moved-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.cp(original.root,root,{recursive:true});await fs.rm(path.join(root,'tmp'),{recursive:true,force:true});await fs.rm(path.join(root,'reviewed'),{recursive:true,force:true});
 const f={root,specPath:path.join(root,path.relative(original.root,original.specPath)),image:{f:{execution:path.join(root,path.relative(original.root,original.image.f.execution))}}};
 for(const name of ['activation.json','approved-preparation.json','continuity.json'])await fs.unlink(path.join(f.image.f.execution,name));
 const productBefore=await fs.readFile(path.join(root,'src/pay.mjs'));const testBefore=await fs.readFile(path.join(root,'src/pay.test.mjs'));
 const files=new Map();for(const name of ['plan.md','tasks.md','plans/slice-01.md','tasks/slice-01.md'])files.set(name,await fs.readFile(path.join(f.image.f.execution,name)));
 const calls=[],spawn=ChildProcess.prototype.spawn;ChildProcess.prototype.spawn=function(o){if(o.args?.some(a=>/src\/pay\.test\.mjs$/.test(String(a))))calls.push(o.args);return spawn.call(this,o);};t.after(()=>{ChildProcess.prototype.spawn=spawn;});
 const request={specPath:f.specPath,slice:'slice-01',operation:'VALIDATE_SLICE'};
 const decision=await inspectRequestedOperation(request);const prepared=await prepareDocumentaryResumption({...request,expectedDecisionSha256:decision.decisionSha256});
 const installed=await installDocumentaryResumption({handle:prepared.handle,review:reviewOf(prepared.authority)});assert.equal(installed.publication,'confirmed');
 t.diagnostic(JSON.stringify({publication:installed}));
 assert.ok(installed.retainedBackup,'old source has an explicit retained path');for(const [name,bytes] of files)assert.deepEqual(await fs.readFile(path.join(installed.retainedBackup,name)),bytes);
 await implement(f,{slice:'slice-01'});assert.deepEqual(await fs.readFile(path.join(root,'src/pay.mjs')),productBefore);assert.deepEqual(await fs.readFile(path.join(root,'src/pay.test.mjs')),testBefore);await normalizedFormal({...f,delivery:{slice:'slice-01'}},{responseVariant:'stnl-current-native-judgment-v1'});
 const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');assert.equal(calls.length,2);
 for(const [name,bytes] of files)assert.deepEqual(await fs.readFile(path.join(installed.retainedBackup,name)),bytes);
 const relocated=await fs.mkdtemp(path.resolve('tmp/documentary-controls-moved-'));t.after(()=>fs.rm(relocated,{recursive:true,force:true}));await fs.cp(root,relocated,{recursive:true});await fs.rm(path.join(relocated,'tmp'),{recursive:true,force:true});try{const probe=await inspectRequestedOperation({specPath:path.join(relocated,path.relative(root,f.specPath)),slice:'slice-01',operation:'VALIDATE_SLICE'});assert.equal(probe.mode,'documentary-resumption');assert.deepEqual(probe.missingControls,[]);assert.equal(probe.historicalProof,'unverified');assert.equal(probe.formalStatus,'not-established');t.diagnostic(JSON.stringify({relocationWithControls:{mode:probe.mode,missingControls:probe.missingControls,relocatedFrom:probe.relocatedFrom,historicalProof:probe.historicalProof,formalStatus:probe.formalStatus}}));const evidenceDir=path.join(relocated,path.relative(root,f.image.f.execution),'evidence');const evidenceFile=path.join(evidenceDir,(await fs.readdir(evidenceDir))[0]);await fs.appendFile(evidenceFile,'tampered');await assert.rejects(()=>inspectRequestedOperation({specPath:path.join(relocated,path.relative(root,f.specPath)),slice:'slice-01',operation:'VALIDATE_SLICE'}));}catch(error){t.diagnostic(JSON.stringify({relocationWithControls:{code:error.code,message:error.message,diagnostics:error.diagnostics}}));throw error;}t.diagnostic(JSON.stringify({physicalRecipeInvocations:calls.length}));
});
test('VALIDATE bootstrap cannot turn an admitted no-op execution into product editing',async t=>{
 const f=await fixture(t,true,{single:true});for(const name of ['activation.json','approved-preparation.json','continuity.json'])await fs.unlink(path.join(f.image.f.execution,name));
 const request={specPath:f.specPath,slice:'slice-01',operation:'VALIDATE_SLICE'},decision=await inspectRequestedOperation(request);
 const prepared=await prepareDocumentaryResumption({...request,expectedDecisionSha256:decision.decisionSha256});await installDocumentaryResumption({handle:prepared.handle,review:reviewOf(prepared.authority)});
 const controller=await import('../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');const image=await captureCurrentExecution(f.specPath);
 const admitted=await controller.begin({specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE',expectedActivationId:image.inspection.activationId});
 await fs.appendFile(path.join(f.root,'src/pay.mjs'),'// unauthorized mutation after admission\n');
 await assert.rejects(()=>controller.reserveDispatch(admitted.handle,{responseVariant:'stnl-current-native-judgment-v1'}),e=>e.code==='RESUMPTION_SCOPE_CHANGED');
});
