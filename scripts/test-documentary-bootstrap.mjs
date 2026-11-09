import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {fixture,implement} from './fixtures/portable-resume-independent.mjs';
import {inspectRequestedOperation,prepareDocumentaryResumption,installDocumentaryResumption,recoverDocumentaryResumption} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
function reviewOf(authority){const hashes=new Map(authority.artifactHashes.map(x=>[x.path,x.sha256]));const review=(scope,authoritySha256,names)=>({scope,decision:'approved',authoritySha256,examinedArtifactHashes:names.sort().map(path=>({path,sha256:hashes.get(path)})),evidenceDecisions:[],summary:'Synthetic current-byte review for new documentary context, never historical approval.'});return {globalReview:review('set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:authority.deliveries.map(d=>({deliveryId:d.deliveryId,review:review('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};}
test('new documentary context returns to native execution',async t=>{const f=await fixture(t,true);const root=f.image.f.execution;for(const name of ['activation.json','approved-preparation.json','continuity.json'])await fs.unlink(path.join(root,name));
const request={specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE'};const decision=await inspectRequestedOperation(request);assert.equal(decision.historicalBudget,'unknown');const prepared=await prepareDocumentaryResumption({...request,expectedDecisionSha256:decision.decisionSha256});const installed=await installDocumentaryResumption({handle:prepared.handle,review:reviewOf(prepared.authority)});assert.equal(installed.publication,'confirmed');await implement(f,{slice:'slice-01'});const image=await captureCurrentExecution(f.specPath);assert.equal(image.inspection.normalHandoff.operation,'VALIDATE_SLICE');await normalizedFormal({...f,delivery:{slice:'slice-01'}},{responseVariant:'stnl-current-native-judgment-v1'});const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.state,'TARGET_CURRENT');assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');assert.equal(final.inspection.deliveries[1].formalStatus,null);});

test('documentary handle recovers interrupted publication without rewriting the source',async t=>{
 const f=await fixture(t,true,{single:true}),root=f.image.f.execution;
 for(const name of ['activation.json','approved-preparation.json','continuity.json'])await fs.unlink(path.join(root,name));
 const before=new Map();for(const name of ['plan.md','tasks.md','plans/slice-01.md','tasks/slice-01.md'])before.set(name,await fs.readFile(path.join(root,name)));
 const request={specPath:f.specPath,slice:'slice-01',operation:'VALIDATE_SLICE'},decision=await inspectRequestedOperation(request);
 const prepared=await prepareDocumentaryResumption({...request,expectedDecisionSha256:decision.decisionSha256});let allocation;
 try{await installDocumentaryResumption({handle:prepared.handle,review:reviewOf(prepared.authority),checkpoint:async phase=>{if(phase==='after-backup')throw Error('controlled documentary interruption');}});assert.fail('interruption expected');}catch(error){assert.match(error.message,/controlled documentary interruption/);allocation=error.allocation;}
 assert.ok(allocation);const recovered=await recoverDocumentaryResumption({handle:prepared.handle,allocation});assert.equal(recovered.publication,'aborted');
 assert.equal((await recoverDocumentaryResumption({handle:prepared.handle,allocation})).publication,'aborted');
 for(const [name,bytes]of before)assert.deepEqual(await fs.readFile(path.join(root,name)),bytes);
 assert.equal((await inspectRequestedOperation(request)).mode,'documentary-resumption');
});
