import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {fixture,implement} from './fixtures/portable-resume-independent.mjs';
import {inspectRequestedOperation,prepareDocumentaryResumption,installDocumentaryResumption} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {normalizedFormal} from './fixtures/portable-formal-independent.mjs';
import {ChildProcess} from 'node:child_process';
function reviewOf(authority){const hashes=new Map(authority.artifactHashes.map(x=>[x.path,x.sha256]));const review=(scope,authoritySha256,names)=>({scope,decision:'approved',authoritySha256,examinedArtifactHashes:names.sort().map(path=>({path,sha256:hashes.get(path)})),evidenceDecisions:[],summary:'Synthetic current-byte review for new documentary context, never historical approval.'});return {globalReview:review('set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md']),deliveries:authority.deliveries.map(d=>({deliveryId:d.deliveryId,review:review('slice',d.authoritySha256,[`plans/${d.slice}.md`,`tasks/${d.slice}.md`])}))};}

async function bootstrap(t){const f=await fixture(t,true,{single:true});for(const n of ['activation.json','approved-preparation.json','continuity.json'])await fs.unlink(path.join(f.image.f.execution,n));const request={specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE'};const d=await inspectRequestedOperation(request);const p=await prepareDocumentaryResumption({...request,expectedDecisionSha256:d.decisionSha256});await installDocumentaryResumption({handle:p.handle,review:reviewOf(p.authority)});return f;}
function count(t){const calls=[],spawn=ChildProcess.prototype.spawn;ChildProcess.prototype.spawn=function(o){if(o.args?.some(a=>/src\/pay\.test\.mjs$/.test(String(a))))calls.push(o.args);return spawn.call(this,o);};t.after(()=>{ChildProcess.prototype.spawn=spawn;});return calls;}
test('one real TESTS_FAIL is publishable and same request cannot reset attempt budget',async t=>{
 const f=await bootstrap(t),calls=count(t);const decision=await inspectRequestedOperation({specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE',requestId:'failure-command-1'});
 const executed=await implement(f,{slice:'slice-01'},{beginOptions:{documentaryRequest:decision.documentaryRequest},status:'TESTS_FAIL',afterBegin:()=>fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"broken";\n')});
 assert.equal(executed.published.publication,'confirmed');assert.equal(calls.length,1);const controller=await import('../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
 await assert.rejects(()=>controller.reserveDispatch(executed.start.handle,{responseVariant:'stnl-current-native-judgment-v1'}));
 await assert.rejects(async()=>{const repeat=await inspectRequestedOperation({specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE',requestId:'failure-command-1'});await controller.begin({specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE',expectedActivationId:repeat.inspection.activationId,documentaryRequest:repeat.documentaryRequest});});assert.equal(calls.length,1);t.diagnostic(JSON.stringify({physicalRecipeInvocations:calls.length}));
});
test('explicit EXECUTE permits product editing and subsequent formal proves the new bytes',async t=>{
 const f=await bootstrap(t),calls=count(t);await implement(f,{slice:'slice-01'},{afterBegin:()=>fs.appendFile(path.join(f.root,'src/pay.mjs'),'// approved implementation edit\n')});
 await normalizedFormal({...f,delivery:{slice:'slice-01'}},{responseVariant:'stnl-current-native-judgment-v1'});const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');assert.equal(calls.length,2);t.diagnostic(JSON.stringify({physicalRecipeInvocations:calls.length}));
});
