import test from'node:test';import assert from'node:assert/strict';import{classifyFailure}from'../failures.mjs';
test('infrastructure denial is not Sentinel failure',()=>assert.equal(classifyFailure({error:'NO_PROGRESS',terminalAttempt:{threadId:'t',turnId:'u'},providerEvents:[{method:'item/completed',params:{threadId:'t',turnId:'u',item:{type:'commandExecution',exitCode:71,aggregatedOutput:'sandbox-exec: sandbox_apply: Operation not permitted'}}}]}).domain,'infrastructure'));
test('unknown stays unknown and independent product failure distinct',()=>{assert.equal(classifyFailure({error:'weird'}).domain,'unclassified');assert.equal(classifyFailure({oracle:'FAIL'}).domain,'product');});
import {assessHarnessObservation} from '../failures.mjs';
test('admitted target failure remains valid observation while config drift fails closed',()=>{const r={status:'BLOCKED',failure:{domain:'budget'},closed:false,oracle:null};assert.equal(assessHarnessObservation({runnerContractProof:{status:'NOT_APPLICABLE'},result:r,configuration:[{status:'MATCH'}]}).harnessValid,true);assert.equal(assessHarnessObservation({runnerContractProof:{status:'NOT_APPLICABLE'},result:r,configuration:[{status:'MISMATCH'}]}).harnessValid,false);assert.equal(assessHarnessObservation({runnerContractProof:{status:'NOT_APPLICABLE'},result:r,configuration:[{status:'MATCH'}],integrity:false}).harnessValid,false);});
test('PASS needs actual closure and independent oracle, unknown failures stay diagnostic',()=>{assert.equal(assessHarnessObservation({runnerContractProof:{status:'NOT_APPLICABLE'},result:{status:'PASS'},configuration:[{status:'MATCH'}]}).harnessValid,false);assert.equal(assessHarnessObservation({runnerContractProof:{status:'NOT_APPLICABLE'},result:{status:'BLOCKED',failure:{domain:'unclassified'}},configuration:[{status:'MATCH'}]}).harnessValid,false);});
test('causal budget stop and structured model error survive generic transport wrapper',()=>{assert.equal(classifyFailure({error:'UNCERTAIN_TRANSPORT_interrupted',stopReason:'OBSERVED_TOKEN_LIMIT'}).domain,'budget');assert.equal(classifyFailure({error:'Requirements: missing content',errorCode:'INVALID_CURRENT_IMAGE'}).domain,'model-output');});

test('missing or wrong contract cannot become official-capable even with matched model',()=>{const r={status:'PASS',closed:true,oracle:'PASS',complete:true};assert.equal(assessHarnessObservation({result:r,configuration:[{status:'MATCH'}],runnerContractProof:{status:'MISMATCH'}}).harnessValid,false);assert.equal(assessHarnessObservation({result:r,configuration:[{status:'MATCH'}],runnerContractProof:{status:'NOT_APPLICABLE'}}).harnessValid,false);assert.equal(assessHarnessObservation({result:r,configuration:[{status:'MATCH'}],runnerContractProof:{status:'MATCH'},trajectoryStatus:'PASS'}).harnessValid,true)});

import {failureObservation} from '../failures.mjs';
const attempt={threadId:'thread',turnId:'turn'};
const capacity={method:'error',params:{...attempt,error:{message:'Reconnecting... 2/5',additionalDetails:'Selected model is at capacity. Please try a different model.',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}},willRetry:true}};
const classify=(providerEvents,extra={})=>classifyFailure({status:'BLOCKED',stopReason:'TURN_DEADLINE',error:'TURN_DEADLINE',providerEvents,terminalAttempt:attempt,...extra});
test('capacity in exact unresolved terminal attempt is separate from deadline termination',()=>{
 const r=classify([capacity]);assert.equal(r.domain,'provider-availability');assert.equal(r.availability.status,'UNRESOLVED');assert.deepEqual(r.termination,{domain:'budget',code:'TURN_DEADLINE'});assert.equal(r.availability.willRetry,true);
});
test('successful completion after retry clears unresolved availability attribution',()=>{
 const r=classify([capacity,{method:'turn/completed',params:{...attempt,turn:{id:'turn',status:'completed'}}}]);assert.equal(r.domain,'budget');assert.equal(r.availability.status,'RESOLVED');
 assert.deepEqual(classify([capacity],{status:'PASS'}),{domain:null,code:null});
});
test('old thread or turn capacity and infrastructure failures do not contaminate terminal attempt',()=>{
 for(const ids of [{threadId:'old',turnId:'turn'},{threadId:'thread',turnId:'old'}]){
 const r=classify([{...capacity,params:{...capacity.params,...ids}},{method:'item/completed',params:{...ids,item:{type:'commandExecution',exitCode:71,aggregatedOutput:'sandbox_apply: Operation not permitted'}}}]);
 assert.equal(r.domain,'budget');assert.equal(r.availability,undefined);
 }
 assert.equal(classify([capacity],{terminalAttempt:null}).domain,'budget');
});
test('stream disconnect alone is not model capacity',()=>{
 const r=classify([{method:'error',params:{...attempt,error:{message:'disconnected',codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}},willRetry:true}}]);assert.equal(r.domain,'budget');assert.equal(r.availability,undefined);
});
test('deadline without provider error keeps budget classification',()=>{assert.deepEqual(classify([]),{domain:'budget',code:'TURN_DEADLINE'});});
test('later public progress is observed without claiming unresolved capacity caused stop',()=>{
 for(const progress of [{method:'item/completed',params:{...attempt,item:{type:'commandExecution',exitCode:0}}},{method:'item/agentMessage/delta',params:{...attempt,delta:'working'}}]){
 const r=classify([capacity,progress]);assert.equal(r.domain,'budget');assert.equal(r.availability.status,'PROGRESS_AFTER_ERROR');assert.equal(classify([progress,capacity]).domain,'provider-availability');
 }
});
test('failure collector contains no arbitrary error text, reasoning, auth or command output',()=>{
 const r=failureObservation({...capacity,params:{...capacity.params,auth:'secret',reasoning:'private',error:{...capacity.params.error,token:'secret'}}});
 assert.ok(!JSON.stringify(r).includes('secret'));assert.ok(!JSON.stringify(r).includes('private'));assert.equal(r.params.error.capacityObserved,true);
 assert.equal(failureObservation({method:'item/started',params:{...attempt,item:{type:'reasoning',text:'private'}}}),null);
 const command=failureObservation({method:'item/completed',params:{...attempt,item:{type:'commandExecution',exitCode:1,aggregatedOutput:'secret'}}});assert.ok(!JSON.stringify(command).includes('secret'));
 assert.deepEqual(failureObservation(r),r);
});
