import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,nativeRound,ORACLE,CONTEXT,AUTHORITY,OWNER} from './fixtures/current-initial-evidence.mjs';
import {filelessInitial,capture,request,validationOwner} from './fixtures/current-validation-evidence.mjs';
const decode=bytes=>JSON.parse(Buffer.from(bytes)),encode=ORACLE.encode;
const mirrors=['stnl-slice-executor/runtime','stnl-slice-quality-manager/runtime','stnl-execution-planner/runtime','stnl-plan-reviewer/runtime','stnl-spec-roadmap/runtime','stnl-spec-test-runbook/runtime','stnl-spec-lifecycle-manager/runtime/lib'];
const absentOutput=work=>{work.entries=work.entries.filter(item=>!item.path.startsWith('src'));work.entries.push({path:'src',kind:'absent'});};
function initialCapture(change) {
  const cap=nativeRound(),baseline=decode(cap.baselineCapture);change(baseline.manifest);cap.baselineCapture=encode(baseline);return cap;
}
function unchangedAbsent() {
  const value=filelessInitial();value.authority.delivery.authorizedAreas='- file: `../../../../src/pay.mjs`';absentOutput(value.work);
  const baseline=decode(value.cap.baselineCapture);baseline.manifest=value.work;value.cap.baselineCapture=encode(baseline);
  const observed=decode(value.cap.verificationObservation);observed.before=value.work;observed.after=value.work;value.cap.verificationObservation=encode(observed);
  const receipt=decode(value.cap.receipt);receipt.verification=observed;value.cap.receipt=encode(receipt);return value;
}
for(const mirror of mirrors)test(`literal output absence coverage and negatives: ${mirror}`,async()=>{
  const root=new URL(`../skills/workflows/${mirror}/`,import.meta.url);
  const {composeInitialImplementationEvidence:compose}=await import(new URL('execution-evidence-current.mjs',root));
  const {verifyWorkObservation:observe}=await import(new URL('execution-evidence-proof.mjs',root));
  const {composeCurrentValidationEvidence:formal}=await import(new URL('current-evidence-state.mjs',root));
  const cap=initialCapture(absentOutput),input=initial([cap]);input.authority.delivery.authorizedAreas='- file: `../../../../src/pay.mjs`';
  assert.equal(compose(input).outcome,'recorded','literal absent ancestor covers original implementation baseline');
  const quiet=unchangedAbsent(),fileless=initial([quiet.cap]);fileless.authority=quiet.authority;
  const base=compose(fileless);assert.equal(base.outcome,'recorded','before and tested work may both prove output absent');
  const owner=validationOwner(),reason=decode(quiet.cap.rawResponse).filelessReason;
  const asked=request({baseBytes:base.bytes,counters:base.counters,owner,scopePaths:[],priorScopePaths:[],filelessReason:reason,authority:quiet.authority});
  const verification=decode(quiet.cap.verificationObservation);
  const captured=capture({request:asked,work:quiet.work,approvedAuthority:quiet.authority,resolved:verification.resolved,command:verification.checks[0].command});
  assert.equal(formal({context:CONTEXT,authority:quiet.authority,owner,previous:{bundleBytes:base.bytes,counters:base.counters},capture:captured.cap}).formalStatus,'PASS');
  // Direct shared baseline path used by current/native converted proof readers.
  const inspect=c=>observe('current-validation',{capture:c,receipt:decode(c.receipt),expectation:{context:CONTEXT,authority:quiet.authority,owner},priorScopePaths:[],removalScopePaths:[]});
  assert.doesNotThrow(()=>inspect(captured.cap));
  for(const [name,change] of [
    ['unproved output absence',work=>{work.entries=work.entries.filter(item=>item.path!=='src/pay.mjs');}],
    ['missing input ancestor',work=>{work.entries=work.entries.filter(item=>!item.path.startsWith('config'));work.entries.unshift({path:'config',kind:'absent'});}],
    ['undeclared extra',work=>{work.entries.push({path:'unowned',kind:'absent'});}],
    ['symlink manifest',work=>{work.entries.find(item=>item.path==='src').kind='symlink';}],
  ]) {
    assert.throws(()=>compose(initial([initialCapture(change)])),undefined,name);
  }
  for(const [name,change] of [
    ['unproved ancestor',work=>{work.entries=work.entries.filter(item=>item.path!=='src');}],
    ['input absent',work=>{work.entries=work.entries.filter(item=>!item.path.startsWith('config'));work.entries.unshift({path:'config',kind:'absent'});}],
    ['outside claim',work=>{work.entries.push({path:'unowned',kind:'absent'});}],
  ]) {
    const altered=structuredClone(captured.cap),baseline=decode(altered.baselineCapture);change(baseline.manifest);altered.baselineCapture=encode(baseline);
    assert.throws(()=>inspect(altered),undefined,name);
  }
});
