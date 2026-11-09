import test from 'node:test';
import assert from 'node:assert/strict';
import {composeInitialImplementationEvidence} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs';
import {composeCurrentValidationEvidence,inspectCurrentEvidence,validateCurrentEvidenceCarriers} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {AUTHORITY,CONTEXT,MANIFEST_0,manifest,nativeRound,initial} from './fixtures/current-initial-evidence.mjs';
import {request,capture,validationOwner,ORACLE,rebindRaw} from './fixtures/current-validation-evidence.mjs';

function pass() {
  const base=composeInitialImplementationEvidence(initial([nativeRound()]));
  const owner=validationOwner();
  const {cap}=capture({request:request({baseBytes:base.bytes,counters:base.counters,owner})});
  return composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner,
    previous:{bundleBytes:base.bytes,counters:base.counters},capture:cap});
}
function inspect(proof,observedWork) {
  return inspectCurrentEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:proof.bytes,
    counters:proof.counters,baseline:MANIFEST_0,observedWork});
}
function addition() {
  const work=manifest();
  work.entries.find(e=>e.path==='src').children.push('verification-6.test.mjs');
  work.entries.push({path:'src/verification-6.test.mjs',kind:'file',sha256:ORACLE.hash(Buffer.from('new synthetic verification')),mode:420});
  return work;
}

test('new verification files remain conservatively stale without authenticated dependency independence',()=>{
  for(let i=0;i<5;i++) {
    const facts=inspect(pass(),addition());
    assert.equal(facts.formalStatus,'PASS');
    assert.equal(facts.observationMatches,false);
    assert.equal(facts.observedValidation,'revalidation-required');
  }
});
for(const [name,mutate] of [
  ['recorded implementation bytes',w=>{w.entries.find(e=>e.path==='src/pay.mjs').sha256=ORACLE.hash(Buffer.from('drift'));}],
  ['recorded input bytes',w=>{w.entries.find(e=>e.path==='config/settings.json').sha256=ORACLE.hash(Buffer.from('drift'));}],
  ['recorded file permissions',w=>{w.entries.find(e=>e.path==='src/pay.mjs').mode=493;}],
  ['recorded implementation removal',w=>{w.entries.find(e=>e.path==='src').children=[];w.entries.splice(w.entries.findIndex(e=>e.path==='src/pay.mjs'),1,{path:'src/pay.mjs',kind:'absent'});}],
])test(`real impact still requires revalidation after ${name}`,()=>{
  const work=manifest();mutate(work);
  const facts=inspect(pass(),work);
  assert.equal(facts.formalStatus,'PASS');
  assert.equal(facts.observationMatches,false);
  assert.equal(facts.observedValidation,'revalidation-required');
});

test('new directory enumeration does not conceal simultaneous change of a prior dependency',()=>{
  const work=addition();work.entries.find(e=>e.path==='src/pay.mjs').sha256=ORACLE.hash(Buffer.from('drift'));
  assert.equal(inspect(pass(),work).observedValidation,'revalidation-required');
});

test('later rejected validation preserves the authenticated prior PASS without claiming current PASS',()=>{
  const prior=pass(),owner=validationOwner(2);
  const {cap}=capture({request:request({baseBytes:prior.bytes,counters:prior.counters,owner})});
  rebindRaw(cap,'not-json');
  const receipt=ORACLE.decode(cap.receipt);
  Object.assign(receipt,{status:'RUNNER_RESULT_BLOCKED',semanticResponseStatus:null,testedState:null,
    verification:null,captureFailure:'runner response schema invalid'});
  cap.receipt=ORACLE.encode(receipt);cap.verificationObservation=null;
  const rejected=composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner,
    previous:{bundleBytes:prior.bytes,counters:prior.counters},capture:cap});
  const facts=inspect(rejected,manifest());
  assert.equal(facts.formalStatus,null);
  assert.equal(facts.rejection.origin.operation,'VALIDATE_SLICE');
  assert.equal(facts.latest.payload.status,'PASS');
  assert.deepEqual(facts.latest.request.scope.paths,['src/pay.mjs']);
  assert.notEqual(facts.observedValidation,'current');
});

for(const [name,content] of [
  ['package.json','{"type":"commonjs"}'],
  ['shadow.mjs','export const replacement = true;'],
  ['autodiscovered.test.mjs','throw new Error("new test fails");'],
])test(`new ${name} cannot inherit PASS without a dependency proof`,()=>{
  const work=manifest();
  work.entries.find(entry=>entry.path==='src').children.push(name);
  work.entries.find(entry=>entry.path==='src').children.sort();
  work.entries.push({path:`src/${name}`,kind:'file',mode:420,sha256:ORACLE.hash(Buffer.from(content))});
  work.entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  assert.equal(inspect(pass(),work).observedValidation,'revalidation-required');
});

function carrier(facts,prior,overlap) {
  return {facts,sections:{
    'Implementation Test Evidence':facts.records.implementation.map(r=>r.recordUtf8).join('\n\n')||'- none',
    'Findings Test Evidence':'- none','Validation Attempts':'- none','Validation Findings':'- none',
    'Effective Validation Base':'- none','Divergences':'- none','Scope Expansion':'- none',
    'Changed Areas':'- `../../../../src/pay.mjs`','Corrections Applied':'- none',
    'Prior Validation Overlap':overlap,'Delegation Blocker':'- none','Diff Summary':'- Implemented pay.',
    'Final Result':'- pending'},
    continuity:{validation:'unvalidated',evidence:`evidence/${facts.bundle.deliveryId}.json`,action:'VALIDATE_SLICE'},
    index:{validation:'pending',result:'pending',done:'[ ]'},slice:'slice-01',priorDeliveries:[{slice:'slice-09',facts:prior}]};
}

test('carrier still requires prior authenticated PASS overlap after a later VALIDATE rejection',()=>{
  const prior=pass(),owner=validationOwner(2);
  const {cap}=capture({request:request({baseBytes:prior.bytes,counters:prior.counters,owner})});
  rebindRaw(cap,'not-json');const receipt=ORACLE.decode(cap.receipt);
  Object.assign(receipt,{status:'RUNNER_RESULT_BLOCKED',semanticResponseStatus:null,testedState:null,
    verification:null,captureFailure:'runner response schema invalid'});
  cap.receipt=ORACLE.encode(receipt);cap.verificationObservation=null;
  const rejected=composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner,
    previous:{bundleBytes:prior.bytes,counters:prior.counters},capture:cap});
  const priorFacts=inspect(rejected,manifest());
  const current=composeInitialImplementationEvidence(initial([nativeRound()]));
  const currentFacts=inspect(current,manifest());
  assert.throws(()=>validateCurrentEvidenceCarriers(carrier(currentFacts,priorFacts,'- none')),
    error=>error.code==='INVALID_CURRENT_IMAGE'&&error.message.includes('Prior Validation Overlap'));
  assert.doesNotThrow(()=>validateCurrentEvidenceCarriers(carrier(currentFacts,priorFacts,
    '- Slice 09 overlap: `../../../../src/pay.mjs`; Existing proven path.')));
  // A mere rejected request is not enough. Without its authenticated retained
  // PASS the carrier must not invent an overlap obligation.
  assert.doesNotThrow(()=>validateCurrentEvidenceCarriers(carrier(currentFacts,
    {...priorFacts,latest:null},'- none')));
});
