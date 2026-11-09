import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {fixture,implement} from './fixtures/portable-resume-independent.mjs';
import {inspectRequestedOperation,prepareDocumentaryResumption,installDocumentaryResumption} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {normalizedFormal} from './fixtures/portable-formal-independent.mjs';
import {ChildProcess} from 'node:child_process';
function reviewOf(authority){const hashes=new Map(authority.artifactHashes.map(x=>[x.path,x.sha256]));const review=(scope,authoritySha256,names)=>({scope,decision:'approved',authoritySha256,examinedArtifactHashes:names.sort().map(path=>({path,sha256:hashes.get(path)})),evidenceDecisions:[],summary:'Synthetic current-byte review for new documentary context, never historical approval.'});return {globalReview:review('set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:authority.deliveries.map(d=>({deliveryId:d.deliveryId,review:review('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};}

async function bootstrap(t){const f=await fixture(t,true,{single:true});for(const n of ['activation.json','approved-preparation.json','continuity.json'])await fs.unlink(path.join(f.image.f.execution,n));const request={specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE'};const d=await inspectRequestedOperation(request);const p=await prepareDocumentaryResumption({...request,expectedDecisionSha256:d.decisionSha256});await installDocumentaryResumption({handle:p.handle,review:reviewOf(p.authority)});return f;}
function count(t){const calls=[],spawn=ChildProcess.prototype.spawn;ChildProcess.prototype.spawn=function(o){if(o.args?.some(a=>/src\/pay\.test\.mjs$/.test(String(a))))calls.push(o.args);return spawn.call(this,o);};t.after(()=>{ChildProcess.prototype.spawn=spawn;});return calls;}

import * as controller from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {payload} from './fixtures/current-initial-evidence.mjs';
test('captured FAIL1 survives interrupted publication on same owner without recipe replay',async t=>{
 const f=await bootstrap(t),calls=count(t),image=await captureCurrentExecution(f.specPath);
 const start=await controller.begin({specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE',expectedActivationId:image.inspection.activationId});
 await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"broken";\n');
 const dispatch=await controller.reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});await controller.bindNative(start.handle,'synthetic-failed-owner');const measured=await controller.verifyNative(dispatch.originFile);
 const {head,...result}=payload(1,'TESTS_FAIL',1);result.commands=measured.commands;result.automaticCheckRound='1/5';
 const tool=path.join(f.root,'captured-failure.json');await fs.writeFile(tool,JSON.stringify({agentId:'synthetic-failed-owner',status:'completed',finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result})}));await controller.captureNative(start.handle,tool);
 const toolBefore=await fs.readFile(tool),originBefore=await fs.readFile(dispatch.originFile);assert.equal(calls.length,1);
 await assert.rejects(()=>controller.publish(start.handle,{checkpoint:async phase=>{if(phase==='after-candidate-file')throw Object.assign(new Error('synthetic interrupted candidate'),{code:'CONTROLLED_INTERRUPTION'});}}),e=>e.code==='CONTROLLED_INTERRUPTION');
 const resumed=await controller.resume(start.handle);assert.equal(resumed.nextAction,'normalize');await controller.normalize(start.handle);const done=await controller.publish(start.handle);assert.equal(done.publication,'confirmed');assert.equal(calls.length,1);
 assert.deepEqual(await fs.readFile(tool),toolBefore);assert.deepEqual(await fs.readFile(dispatch.originFile),originBefore);
 const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.deliveries[0].auxiliaryStatus,'TESTS_FAIL');assert.equal(final.inspection.deliveries[0].counters.implementationChecks,1);assert.equal(JSON.parse(Buffer.from(final.activationBytes).toString()).activeAttempt,null);t.diagnostic(JSON.stringify({physicalRecipeInvocations:calls.length,publication:done.publication}));
});
