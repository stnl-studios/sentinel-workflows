import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,copyFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {composeCurrentFindingsEvidence,validateCurrentFindingsEvidence} from '../skills/workflows/stnl-slice-executor/runtime/findings-evidence-current.mjs';
import {composeInitialImplementationEvidence,validateInitialImplementationEvidence} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs';
import {composeCurrentValidationEvidence,validateCurrentValidationEvidence} from '../skills/workflows/stnl-slice-executor/runtime/validation-evidence-current.mjs';
import {findingsRoundCaptureSha256} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-proof.mjs';
import {AUTHORITY,CONTEXT,COMMAND,PRODUCT,TARGET,INPUT,RESOLVED,manifest,initial,nativeRound,OWNER} from './fixtures/current-initial-evidence.mjs';
import {finding,validationOwner,request as formalRequest,capture as formalCapture,filelessInitial,retainedRemovalInitial} from './fixtures/current-validation-evidence.mjs';
import {needsFixBase,applyOwner,applyCapture,applyPayload,roundLink,closeManaged,rebindRaw,
  encode,decode,hash,canonicalBytes,authoredBundle,authoredCheck,authoredFormal,
  initialGolden,findingsGolden} from './fixtures/current-findings-evidence.mjs';

const clone=value=>structuredClone(value);
const failure=(code,fragment)=>error=>error?.code===code && (!fragment || String(error.message).includes(fragment));
const assertBytesEqual=(actual,expected)=>assert.deepEqual(Buffer.from(actual),Buffer.from(expected));
const compose=(base,rounds,owner=applyOwner())=>composeCurrentFindingsEvidence({context:clone(CONTEXT),authority:clone(AUTHORITY),
  owner:clone(owner),previous:{bundleBytes:base.bytes,counters:clone(base.counters)},rounds});
const readback=(result,work=manifest(2))=>validateCurrentFindingsEvidence({context:clone(CONTEXT),authority:clone(AUTHORITY),
  bundleBytes:result.bytes,counters:clone(result.counters),observedWork:clone(work)});
const direct=(bundle,counters,work=manifest(2))=>validateCurrentFindingsEvidence({context:clone(CONTEXT),authority:clone(AUTHORITY),
  bundleBytes:canonicalBytes(bundle),counters:clone(counters),observedWork:clone(work)});
const native=()=>{const base=needsFixBase();const owner=applyOwner();const {cap,request}=applyCapture({base,owner});return {base,owner,cap,request};};
function updateReceipt(cap,change) {
  const receipt=decode(cap.receipt);change(receipt);cap.receipt=encode(receipt);
  if (cap.transport==='managed' && cap.latest) {const latest=decode(cap.latest);latest.receipt=receipt;cap.latest=encode(latest);}
}
function rebindRequest(cap,change) {
  const request=decode(cap.applyRequest);change(request);cap.applyRequest=encode(request);
  const response=decode(cap.rawResponse);response.requestSha256=hash(cap.applyRequest);rebindRaw(cap,response);
}
function schemaReject(cap,text='{') {
  rebindRaw(cap,text);
  updateReceipt(cap,item=>{item.status='RUNNER_RESULT_BLOCKED';item.semanticResponseStatus=null;
    item.testedState=null;item.verification=null;item.captureFailure='runner response schema invalid';
    if (cap.transport==='managed') {item.exitCode=1;item.captureFailureCode='RUNNER_RESPONSE_SCHEMA_INVALID';}});
  cap.verificationObservation=null;
  if (cap.transport==='managed') {const supervisor=decode(cap.closedSupervisor);supervisor.capturedReceipts=0;cap.closedSupervisor=encode(supervisor);}
}
function expectedRecord(base,cap) {
  const request=decode(cap.applyRequest),payload=decode(cap.rawResponse).result;
  const after=manifest(2);const file=after.entries.find(item=>item.path==='src/pay.mjs');
  return [
    '### findings-check-01','- Automatic check round: 1/3','- Status: TESTS_PASS',
    '- HEAD: 0123456789abcdef',`- Tested scope: ${TARGET}`,
    `- Delivery ID: ${request.owner.deliveryId}`,'- Preparation revision: 1','- Local revision: 1',
    `- Normative sha256: ${request.owner.normativeSha256}`,
    `- Operation attempt ID: ${request.owner.operationAttemptId}`,
    `- Origin activation ID: ${request.owner.originActivationId}`,
    '- Tested state:',`  - \`${TARGET}\` | ${file.sha256}`,
    '- Commands:',`  - \`${COMMAND}\` | exit:0`,
    `- Discovery sources: ${payload.discoverySources}`,`- Discovery actions: ${payload.discoveryActions}`,
    `- Verification types considered: ${payload.verificationTypesConsidered}`,
    `- Non-applicability rationale: ${payload.nonApplicabilityRationale}`,
    `- No verification-command confirmation: ${payload.noVerificationCommandConfirmation}`,
    `- Selected checks: ${payload.selectedChecks}`,`- Selection rationale: ${payload.selectionRationale}`,
    `- Coverage: ${payload.coverage}`,`- Failures: ${payload.failures}`,`- Blockers: ${payload.blockers}`,
    `- Unexpected workspace effects: ${payload.unexpectedWorkspaceEffects}`,
    `- Persistence summary: ${payload.persistenceSummary}`,
    '- Findings cycle: attempt-01','- Finding IDs: finding-01','- Findings verified: finding-01',
    `- Corrections covered: ${TARGET}`,`- Regressions: ${payload.regressionsSelected}`,
    '- Unsupported active findings: none',
  ].join('\n');
}
function authoredNative(base,cap) {
  return authoredBundle({validation:base.bundle.validation,openFindings:base.bundle.openFindings,
    findingsChecks:[authoredCheck(cap,'findings-check-01',expectedRecord(base,cap))],captures:[cap],
    objects:base.bundle.objects,counters:{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1}}).bundle;
}
function rebindFormalRequest(cap,change) {
  const request=decode(cap.validationRequest);change(request);cap.validationRequest=encode(request);
  const response=decode(cap.rawResponse);response.requestSha256=hash(cap.validationRequest);rebindRaw(cap,response);
}
function assertRoots(result,{implementation=[],checks=[],formal,support=[]}) {
  const bundle=result.bundle;
  assert.deepEqual(bundle.implementation.map(item=>item.id),implementation);
  assert.deepEqual(bundle.findingsChecks.map(item=>item.id),checks);
  assert.equal(bundle.validation?.id,formal);
  assert.deepEqual(bundle.support.map(item=>item.kind==='rejection'?'rejection':item.id),support);
  const all=[...bundle.implementation,...bundle.findingsChecks,...bundle.support,...(bundle.validation?[bundle.validation]:[])];
  const refs=new Set(all.flatMap(item=>Object.entries(item.sources).flatMap(([key,value])=>
    key==='transport'||value===null?[]:Array.isArray(value)?value:[value])));
  assert.deepEqual(bundle.objects.map(item=>item.id),[...refs].sort());
}
function assertRejectedApply(base,caps,owner,relation,accepted=[]) {
  const result=compose(base,caps,owner);
  assert.equal(result.outcome,'rejected');assert.equal(result.validation,'uncertain');
  assert.equal(result.consumedInvocations,caps.length);
  assert.deepEqual(result.bundle.findingsChecks,accepted);
  assert.deepEqual(result.counters,{...base.counters,findingsChecks:base.counters.findingsChecks+accepted.length});
  assert.deepEqual(result.bundle.openFindings,base.bundle.openFindings);
  const rejected=result.bundle.support.at(-1);
  assert.match(rejected.diagnostic,relation);assert.equal(rejected.consumedInvocations,caps.length);
  assert.equal(rejected.sources.rawResponse,hash(caps.at(-1).rawResponse));
  assert.equal(rejected.sources.receipt,hash(caps.at(-1).receipt));
  assert.equal(rejected.sources.verificationObservation,caps.at(-1).verificationObservation===null?null:hash(caps.at(-1).verificationObservation));
  assert.equal(result.bundle.objects.find(item=>item.id===rejected.sources.rawResponse).bytesBase64,
    Buffer.from(caps.at(-1).rawResponse).toString('base64'));
  return result;
}
function formalAfter(apply,status='PASS',newFindings=[],work=manifest(2)) {
  const owner=validationOwner(apply.counters.validationAttempts+1);
  const request=formalRequest({baseBytes:apply.bytes,counters:apply.counters,openFindings:apply.bundle.openFindings,
    priorScopePaths:['src/pay.mjs'],owner,scopePaths:['src/pay.mjs']});
  request.format='stnl-current-validation-request-v2';
  request.base.auxiliary={kind:'findings',operationAttemptId:apply.bundle.findingsChecks[0].origin.operationAttemptId,
    cycle:/^- Findings cycle: (attempt-[0-9]+)$/mu.exec(apply.bundle.findingsChecks[0].recordUtf8)[1],firstCheckId:apply.bundle.findingsChecks[0].id,lastCheckId:apply.bundle.findingsChecks.at(-1).id,
    recordsSha256:hash(canonicalBytes(apply.bundle.findingsChecks))};
  const all=apply.bundle.openFindings.map(item=>item.id);
  const added=newFindings.map(item=>item.id);
  const references=[...all,...added].sort().join(', ')||'none';
  const dispositions=[...all.map(id=>`${id}=${status==='PASS'?'resolved':'active'}`),...added.map(id=>`${id}=active`)].sort().join(', ')||'none';
  const {cap}=formalCapture({request,status,newFindings,findingReferences:references,
    findingDispositions:dispositions,work});
  return {owner,request,cap,input:{context:clone(CONTEXT),authority:clone(AUTHORITY),owner,
    previous:{bundleBytes:apply.bytes,counters:apply.counters},capture:cap}};
}
const OLD_BYTES=Buffer.from('legacy pay helper\n');
const OLD_PATH='../../../../src/old.mjs';
const OLD_SCOPE=['src/old.mjs','src/pay.mjs'];
function oldSourceWork(kind='file') {
  const work=clone(manifest(1));
  if (kind==='file') work.entries[2].children=['old.mjs','pay.mjs'];
  work.entries.splice(3,0,kind==='file'
    ? {path:'src/old.mjs',kind:'file',sha256:hash(OLD_BYTES),mode:420}
    : {path:'src/old.mjs',kind:'absent'});
  return work;
}
function removalBase() {
  const first=needsFixBase(),owner=validationOwner(2),work=oldSourceWork();
  const asked=formalRequest({baseBytes:first.bytes,counters:first.counters,openFindings:first.bundle.openFindings,
    priorScopePaths:['src/pay.mjs'],owner,scopePaths:OLD_SCOPE});
  const {cap}=formalCapture({request:asked,status:'NEEDS_FIX',findingReferences:'finding-01',
    findingDispositions:'finding-01=active',work});
  const base=composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner,
    previous:{bundleBytes:first.bytes,counters:first.counters},capture:cap});
  return {base,before:work,after:oldSourceWork('absent')};
}
function oldSourceCapture(base,owner,before,after,newRemoval=false) {
  const {cap}=applyCapture({base,owner,before,after});
  rebindRequest(cap,item=>{item.base.priorScopePaths=[...OLD_SCOPE];item.scopePaths=[...OLD_SCOPE];});
  const response=decode(cap.rawResponse);
  response.result.correctionsCovered=newRemoval?'Removed legacy helper inside approved src.':'Rechecked prior helper correction.';
  response.result.affectedFilesOrBehaviors='src/old.mjs and pay check';rebindRaw(cap,response);
  updateReceipt(cap,item=>{item.testedState.entries=[
    {path:OLD_PATH,value:after.entries.find(entry=>entry.path==='src/old.mjs').kind==='absent'
      ? 'REMOVED' : after.entries.find(entry=>entry.path==='src/old.mjs').sha256},
    {path:TARGET,value:after.entries.find(entry=>entry.path==='src/pay.mjs').sha256},
  ];});
  if (newRemoval) cap.removalProofs=[encode({format:'stnl-current-removal-proof-v1',owner,round:1,
    path:'src/old.mjs',sha256:hash(OLD_BYTES),mode:420,bytesBase64:OLD_BYTES.toString('base64')})];
  return cap;
}

function authoredRemovalScenario({transport='native',recreated=false,implementationChecks=2}={}) {
  const old=retainedRemovalInitial(recreated?'file':'absent');
  const initialFinalScope=recreated?[...OLD_SCOPE]:['src/pay.mjs'];
  const formalScope=[...OLD_SCOPE],applyPriorScope=[...formalScope];
  const records=old.rounds.map((cap,index)=>authoredCheck(cap,`implementation-check-0${index+1}`,
    initialGolden(cap,index?[TARGET,...(recreated?[OLD_PATH]:[])].sort():[])));
  const initialBase=authoredBundle({implementation:records,captures:old.rounds,
    counters:{implementationChecks,findingsChecks:0,validationAttempts:0,findings:0}});
  const work=retainedRemovalInitial().work,owner=validationOwner(1);
  const request=formalRequest({baseBytes:initialBase.bytes,counters:initialBase.counters,
    priorScopePaths:initialFinalScope,scopePaths:formalScope,owner});
  const {cap}=formalCapture({transport,request,status:'NEEDS_FIX',newFindings:[finding(1,1)],
    findingReferences:'finding-01',findingDispositions:'finding-01=active',work});
  updateReceipt(cap,receipt=>{receipt.testedState.entries.unshift({path:OLD_PATH,value:'REMOVED'});});
  const base=authoredBundle({implementation:records,validation:authoredFormal(cap),openFindings:[finding(1,1)],
    captures:[...old.rounds,cap],counters:{implementationChecks,findingsChecks:0,validationAttempts:1,findings:1}});
  const apply=oldSourceCapture(base,applyOwner(),work,work);
  const check=authoredCheck(apply,'findings-check-01',findingsGolden(apply,{corrections:[]}));
  const expected=authoredBundle({findingsChecks:[check],validation:base.bundle.validation,
    openFindings:[finding(1,1)],support:records,captures:[...old.rounds,cap,apply],
    counters:{implementationChecks,findingsChecks:1,validationAttempts:1,findings:1}});
  return {old,records,initialBase,initialFinalScope,formalScope,applyPriorScope,
    base,apply,expected,work,formalCap:cap,formalOwner:owner};
}
function repack(result,{checks=result.bundle.findingsChecks,validation=result.bundle.validation,
  support=result.bundle.support,captures=[],openFindings=result.bundle.openFindings,counters=result.counters}={}) {
  return authoredBundle({implementation:result.bundle.implementation,findingsChecks:checks,validation,support,
    openFindings,captures,counters,objects:result.bundle.objects});
}
function authoredGap(transport='native',checks=99) {
  const origin=needsFixBase({transport});
  const owner=validationOwner(5),second=finding(2,5,'advisory');
  const asked=formalRequest({baseBytes:Buffer.from('pruned historical base'),
    counters:{implementationChecks:1,findingsChecks:checks,validationAttempts:4,findings:1},
    openFindings:[finding(1,1)],owner});
  asked.format='stnl-current-validation-request-v2';asked.base.auxiliary={kind:'findings',
    operationAttemptId:applyOwner(20).operationAttemptId,cycle:'attempt-04',firstCheckId:'findings-check-98',
    lastCheckId:'findings-check-99',recordsSha256:hash(Buffer.from('pruned historical cycle'))};
  const {cap}=formalCapture({transport,request:asked,status:'NEEDS_FIX',newFindings:[second],
    findingReferences:'finding-01, finding-02',findingDispositions:'finding-01=active, finding-02=active'});
  const base=authoredBundle({validation:authoredFormal(cap),openFindings:[finding(1,1),second],
    support:[origin.bundle.validation],captures:[cap],objects:origin.bundle.objects,
    counters:{implementationChecks:1,findingsChecks:checks,validationAttempts:5,findings:2}});
  const ownerApply=applyOwner(21),apply=applyCapture({base,owner:ownerApply,transport}).cap;
  if(transport==='managed')closeManaged([apply]);
  const record=authoredCheck(apply,`findings-check-${checks+1}`,findingsGolden(apply));
  const expected=authoredBundle({findingsChecks:[record],validation:base.bundle.validation,openFindings:base.bundle.openFindings,
    support:[origin.bundle.validation],captures:[apply],objects:base.bundle.objects,
    counters:{implementationChecks:1,findingsChecks:checks+1,validationAttempts:5,findings:2}});
  return {base,apply,cap,origin,expected,owner:ownerApply};
}

function twoWitnesses(transport='native',recreateInitial=false) {
  const firstPath='src/initial.mjs',firstClaim='../../../../src/initial.mjs',firstBytes=Buffer.from('initial helper');
  const domain=(initialKind,oldKind,pay=1)=>{
    const work=manifest(pay),leaves=[];
    for(const [name,kind,bytes] of [[firstPath,initialKind,firstBytes],['src/old.mjs',oldKind,OLD_BYTES]])
      if(kind)leaves.push(kind==='absent'?{path:name,kind}:{path:name,kind,sha256:hash(bytes),mode:420});
    work.entries.push(...leaves);work.entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    work.entries.find(item=>item.path==='src').children=work.entries.filter(item=>item.path.startsWith('src/')&&item.kind==='file').map(item=>item.path.slice(4));
    return work;
  };
  const first=nativeRound(),before=domain('file','file'),after=domain('absent','absent');
  before.entries.find(item=>item.path==='src').children=['initial.mjs','old.mjs'];
  before.entries[before.entries.findIndex(item=>item.path==='src/pay.mjs')]={path:'src/pay.mjs',kind:'absent'};
  const baseline=decode(first.baselineCapture);baseline.manifest=before;first.baselineCapture=encode(baseline);
  const observation=decode(first.verificationObservation);observation.before=after;observation.after=after;first.verificationObservation=encode(observation);
  updateReceipt(first,item=>{item.verification=observation;item.testedState.entries=[{path:firstClaim,value:'REMOVED'},{path:OLD_PATH,value:'REMOVED'},{path:TARGET,value:manifest(1).entries[3].sha256}];});
  first.removalProofs=[encode({format:'stnl-current-removal-proof-v1',owner:OWNER,round:1,path:firstPath,
    sha256:hash(firstBytes),mode:420,bytesBase64:firstBytes.toString('base64')}),
    encode({format:'stnl-current-removal-proof-v1',owner:OWNER,round:1,path:'src/old.mjs',
      sha256:hash(OLD_BYTES),mode:420,bytesBase64:OLD_BYTES.toString('base64')})];
  const initialRecord=authoredCheck(first,'implementation-check-01',initialGolden(first));
  const initialBase=authoredBundle({implementation:[initialRecord],captures:[first],
    counters:{implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0}});
  const scope=[firstPath,'src/old.mjs','src/pay.mjs'],workBefore=domain('absent','file'),workAfter=domain('absent','absent');
  const entries=work=>scope.map(name=>{const entry=work.entries.find(item=>item.path===name);return {path:'../../../../'+name,value:entry.kind==='absent'?'REMOVED':entry.sha256};});
  const request=formalRequest({baseBytes:initialBase.bytes,counters:initialBase.counters,owner:validationOwner(1),
    priorScopePaths:scope,scopePaths:scope});
  const admissionCap=formalCapture({request,status:'NEEDS_FIX',newFindings:[finding(1,1)],findingReferences:'finding-01',
    findingDispositions:'finding-01=active',work:workBefore}).cap;
  updateReceipt(admissionCap,item=>{item.testedState.entries=entries(workBefore);});
  const admission=authoredBundle({implementation:[initialRecord],validation:authoredFormal(admissionCap),
    openFindings:[finding(1,1)],captures:[first,admissionCap],
    counters:{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:1}});
  const ownerA=applyOwner(50),a=applyCapture({base:admission,owner:ownerA,transport,before:workBefore,after:workAfter}).cap;
  rebindRequest(a,item=>{item.base.priorScopePaths=scope;item.scopePaths=scope;});
  updateReceipt(a,item=>{item.testedState.entries=entries(workAfter);});
  a.removalProofs=[encode({format:'stnl-current-removal-proof-v1',owner:ownerA,round:1,path:'src/old.mjs',sha256:hash(OLD_BYTES),mode:420,bytesBase64:OLD_BYTES.toString('base64')})];
  if(transport==='managed')closeManaged([a]);
  const checkA=authoredCheck(a,'findings-check-01',findingsGolden(a,{corrections:[OLD_PATH]}));
  const applied=authoredBundle({findingsChecks:[checkA],validation:admission.bundle.validation,openFindings:[finding(1,1)],
    support:[initialRecord],captures:[first,admissionCap,a],counters:{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1}});
  const nextRequest=formalRequest({baseBytes:applied.bytes,counters:applied.counters,owner:validationOwner(2),
    openFindings:[finding(1,1)],priorScopePaths:scope,scopePaths:scope});
  nextRequest.format='stnl-current-validation-request-v2';nextRequest.base.auxiliary={kind:'findings',operationAttemptId:ownerA.operationAttemptId,
    cycle:'attempt-01',firstCheckId:'findings-check-01',lastCheckId:'findings-check-01',recordsSha256:hash(canonicalBytes([checkA]))};
  const formal=formalCapture({request:nextRequest,status:'NEEDS_FIX',findingReferences:'finding-01',findingDispositions:'finding-01=active',work:workAfter}).cap;
  updateReceipt(formal,item=>{item.testedState.entries=entries(workAfter);});
  const base=authoredBundle({findingsChecks:[checkA],validation:authoredFormal(formal),openFindings:[finding(1,1)],
    support:[initialRecord,admission.bundle.validation],captures:[first,admissionCap,a,formal],
    counters:{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1}});
  const ownerB=applyOwner(51),finalWork=recreateInitial?domain('file','absent'):workAfter;
  const b=applyCapture({base,owner:ownerB,transport,before:workAfter,after:finalWork}).cap;
  rebindRequest(b,item=>{item.base.priorScopePaths=scope;item.scopePaths=scope;});
  updateReceipt(b,item=>{item.testedState.entries=entries(finalWork);});if(transport==='managed')closeManaged([b]);
  const checkB=authoredCheck(b,'findings-check-02',findingsGolden(b,{corrections:recreateInitial?[firstClaim]:[]}));
  const expected=authoredBundle({findingsChecks:[checkB],validation:base.bundle.validation,openFindings:[finding(1,1)],
    support:[...(recreateInitial?[]:[initialRecord]),checkA,admission.bundle.validation],captures:[first,admissionCap,a,formal,b],
    counters:{implementationChecks:1,findingsChecks:2,validationAttempts:2,findings:1}});
  return {expected,work:finalWork,a,b,base,applied,admission,first,initialRecord,formal};
}

test('A01 native authored request, envelope, record and counters preserve finding',()=>{
  const f=native();const expected=authoredNative(f.base,f.cap);
  const result=compose(f.base,[f.cap],f.owner);
  assert.deepEqual(result.bundle,expected);
  assertBytesEqual(result.bytes,canonicalBytes(expected));
  assert.deepEqual(result.counters,{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1});
  assert.deepEqual(result.bundle.openFindings,[finding(1,1)]);
  assert.equal(result.auxiliaryStatus,'TESTS_PASS');assert.equal(result.formalStatus,'NEEDS_FIX');
  assert.equal(result.validation,'revalidation-required');assert.equal(result.consumedInvocations,1);
  assert.equal(direct(expected,result.counters).sha256,hash(canonicalBytes(expected)));
  const changed=clone(f.cap);rebindRequest(changed,item=>{item.base.validation.id='attempt-02';});
  assert.throws(()=>compose(f.base,[changed],f.owner),failure('EVIDENCE_STALE','base'));
  const ownerMismatch=clone(f.cap);rebindRequest(ownerMismatch,item=>{item.owner.ownershipToken=applyOwner(77).ownershipToken;});
  assert.throws(()=>compose(f.base,[ownerMismatch],f.owner),failure('OWNER_MISMATCH','input owner'));
  const digest=clone(f.cap);rebindRequest(digest,item=>{item.base.validation.recordSha256=hash(Buffer.from('other formal'));});
  assert.throws(()=>compose(f.base,[digest],f.owner),failure('EVIDENCE_STALE','findings base'));
});

test('A02 native causal links preserve raw rounds, budgets and independent authored readback; managed is refused',()=>{
 const base=needsFixBase(),owner=applyOwner();
 const first=applyCapture({base,owner,status:'TESTS_FAIL',exit:1}),frozen=roundLink(first.cap);
 assert.equal(findingsRoundCaptureSha256(first.cap),frozen);
 const second=applyCapture({base,owner,round:2,previousCheck:{id:first.request.checkId,roundCaptureSha256:frozen}}),beforeSecond=Buffer.from(second.cap.applyRequest);
 const result=compose(base,[first.cap,second.cap],owner);assert.equal(result.auxiliaryStatus,'TESTS_PASS');assert.equal(result.consumedInvocations,2);assert.deepEqual(result.bundle.findingsChecks.map(item=>item.id),['findings-check-01','findings-check-02']);assert.equal(readback(result,manifest(3)).validation,'revalidation-required');assert.deepEqual(Buffer.from(second.cap.applyRequest),beforeSecond);
 const wrong=clone(second.cap);rebindRequest(wrong,item=>{item.previousCheck.roundCaptureSha256=hash(canonicalBytes(result.bundle.findingsChecks[0]));});assert.throws(()=>compose(base,[first.cap,wrong],owner),failure('EVIDENCE_STALE','previous check link'));
 const f1=applyCapture({base,owner,status:'TESTS_FAIL',exit:1});
 const f2=applyCapture({base,owner,round:2,status:'TESTS_FAIL',exit:1,before:manifest(2),after:manifest(3),previousCheck:{id:f1.request.checkId,roundCaptureSha256:roundLink(f1.cap)}});
 const f3=applyCapture({base,owner,round:3,status:'TESTS_FAIL',exit:1,before:manifest(3),after:manifest(3),previousCheck:{id:f2.request.checkId,roundCaptureSha256:roundLink(f2.cap)}});
 const exhausted=compose(base,[f1.cap,f2.cap,f3.cap],owner);assert.equal(exhausted.auxiliaryStatus,'TESTS_FAIL');assert.equal(exhausted.counters.findingsChecks,3);
 const malformed=clone(f3.cap);schemaReject(malformed);const rejected=compose(base,[f1.cap,f2.cap,malformed],owner);assert.equal(rejected.outcome,'rejected');assert.equal(rejected.counters.findingsChecks,2);assert.equal(rejected.consumedInvocations,3);
 const expectedChecks=[authoredCheck(first.cap,'findings-check-01',findingsGolden(first.cap)),authoredCheck(second.cap,'findings-check-02',findingsGolden(second.cap,{roundCorrections:[TARGET],priorFailure:'Pay check failed.'}))];
 const expected=authoredBundle({findingsChecks:expectedChecks,validation:base.bundle.validation,openFindings:[finding(1,1)],captures:[first.cap,second.cap],objects:base.bundle.objects,counters:{implementationChecks:1,findingsChecks:2,validationAttempts:1,findings:1}});assert.deepEqual(result.bundle,expected.bundle);assert.equal(direct(expected.bundle,expected.counters,manifest(3)).auxiliaryStatus,'TESTS_PASS');
 const staleSource=clone([first.cap,second.cap]),altered=decode(staleSource[0].rawResponse);altered.result.evidenceOrFailureSummary='Different complete prior evidence.';rebindRaw(staleSource[0],altered);assert.throws(()=>compose(base,staleSource,owner),failure('EVIDENCE_STALE','previous check link'));
 const expectedPrefix=[authoredCheck(f1.cap,'findings-check-01',findingsGolden(f1.cap)),authoredCheck(f2.cap,'findings-check-02',findingsGolden(f2.cap,{roundCorrections:[TARGET],priorFailure:'Pay check failed.'}))];assert.deepEqual(rejected.bundle.findingsChecks,expectedPrefix);assertRejectedApply(base,[f1.cap,f2.cap,malformed],owner,/strict JSON/,expectedPrefix);
 const retiredBase=needsFixBase({transport:'managed'}),retired=applyCapture({base:retiredBase,owner,transport:'managed'}).cap,before=clone(retired);assert.throws(()=>findingsRoundCaptureSha256(retired),failure('UNSUPPORTED_FORMAT'));assert.throws(()=>compose(retiredBase,[retired],owner),failure('UNSUPPORTED_FORMAT'));assert.deepEqual(clone(retired),before);
});

test('A03 selection includes blocking and advisory with exact complement',()=>{
  const first=needsFixBase();const advisory=finding(2,2,'advisory');const owner=validationOwner(2);
  const asked=formalRequest({baseBytes:first.bytes,counters:first.counters,openFindings:first.bundle.openFindings,
    priorScopePaths:['src/pay.mjs'],owner});
  const {cap:formalCap}=formalCapture({request:asked,status:'NEEDS_FIX',newFindings:[advisory],
    findingReferences:'finding-01, finding-02',findingDispositions:'finding-01=active, finding-02=active'});
  const base=composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner,
    previous:{bundleBytes:first.bytes,counters:first.counters},capture:formalCap});
  const resultPayload=applyPayload(1,'TESTS_PASS',0,['finding-01','finding-02']);
  resultPayload.findingsVerified='finding-01';resultPayload.unsupportedActiveFindings='finding-02';
  const cap=applyCapture({base,result:resultPayload}).cap;
  const result=compose(base,[cap]);
  assert.deepEqual(result.bundle.openFindings,[finding(1,1),advisory]);
  assert.match(result.bundle.findingsChecks[0].recordUtf8,/Finding IDs: finding-01, finding-02/u);
  const wrong=clone(cap);const response=decode(wrong.rawResponse);response.result.unsupportedActiveFindings='none';rebindRaw(wrong,response);
  assert.equal(compose(base,[wrong]).outcome,'rejected');
  for(const mutate of [request=>{request.base.openFindings.pop();},request=>{request.base.openFindings[0].problem='Changed detail';},
    request=>{request.base.openFindings[0].originAttempt='attempt-99';},request=>{request.base.openFindings.push(finding(3,99));}]) {
    const altered=clone(cap);rebindRequest(altered,mutate);
    assert.throws(()=>compose(base,[altered]),failure('EVIDENCE_STALE','findings base'));
  }
  for(const [verified,unsupported] of [['finding-03','finding-01, finding-02'],['finding-01','finding-01, finding-02'],['finding-02','none']]) {
    const changed=clone(cap),raw=decode(changed.rawResponse);raw.result.findingsVerified=verified;raw.result.unsupportedActiveFindings=unsupported;rebindRaw(changed,raw);
    assertRejectedApply(base,[changed],applyOwner(),/selection\/unsupported complement/);
  }
  const next=formalAfter(result,'NEEDS_FIX',[finding(3,3)]);
  const answer=decode(next.cap.rawResponse);answer.result.findingDispositions='finding-01=resolved, finding-02=active, finding-03=active';rebindRaw(next.cap,answer);
  const disposed=composeCurrentValidationEvidence(next.input),newOwner=applyOwner(90);
  const resurrect=applyCapture({base:disposed,owner:newOwner,before:manifest(2),after:manifest(2)}).cap;
  rebindRequest(resurrect,item=>{item.base.openFindings.unshift(finding(1,1));});
  assert.throws(()=>compose(disposed,[resurrect],newOwner),failure('EVIDENCE_STALE','findings base'));
});

test('A04 high-water check ids, failure terminal and incomplete prefix',()=>{
  const f=native();const first=applyCapture({base:f.base,owner:f.owner,status:'TESTS_FAIL',exit:1});
  assert.throws(()=>compose(f.base,[first.cap],f.owner),failure('EVIDENCE_INCOMPLETE','FAIL prefix'));
  const second=applyCapture({base:f.base,owner:f.owner,round:2,status:'TESTS_FAIL',exit:1,before:manifest(2),after:manifest(3),
    previousCheck:{id:first.request.checkId,roundCaptureSha256:roundLink(first.cap)}});
  const third=applyCapture({base:f.base,owner:f.owner,round:3,status:'TESTS_FAIL',exit:1,before:manifest(3),after:manifest(3),
    previousCheck:{id:second.request.checkId,roundCaptureSha256:roundLink(second.cap)}});
  const result=compose(f.base,[first.cap,second.cap,third.cap],f.owner);
  assert.equal(result.consumedInvocations,3);assert.equal(result.counters.findingsChecks,3);
  assert.deepEqual(result.bundle.findingsChecks.map(item=>item.id),['findings-check-01','findings-check-02','findings-check-03']);
  const fourth=clone(third.cap);rebindRequest(fourth,item=>{item.round=4;item.checkId='findings-check-04';});
  assert.throws(()=>compose(f.base,[first.cap,second.cap,third.cap,fourth],f.owner),failure('INVALID_CURRENT_IMAGE'));
  for(const checkId of ['findings-check-01','findings-check-03']) {
    const changed=clone(second.cap);rebindRequest(changed,item=>{item.checkId=checkId;});
    assert.throws(()=>compose(f.base,[first.cap,changed,third.cap],f.owner),failure('INVALID_CURRENT_IMAGE','check ID'));
  }
  const pass=clone(first.cap),body=decode(pass.rawResponse);body.result.status='TESTS_PASS';body.result.failures='none';
  const observation=decode(pass.verificationObservation);observation.checks[0].exit=0;pass.verificationObservation=encode(observation);
  body.result.commands[0].exit=0;rebindRaw(pass,body);updateReceipt(pass,item=>{item.semanticResponseStatus='TESTS_PASS';item.verification=observation;});
  const successor=clone(second.cap);rebindRequest(successor,item=>{item.previousCheck.roundCaptureSha256=roundLink(pass);});
  assert.throws(()=>compose(f.base,[pass,successor],f.owner),failure('INVALID_CURRENT_IMAGE','prior round did not fail'));
  const applied=compose(f.base,[f.cap],f.owner),another=applyOwner(80);
  const restart=applyCapture({base:f.base,owner:another}).cap;
  assert.throws(()=>compose(applied,[restart],another),failure('STALE_BASE','already has a findings cycle'));
  for(const value of [-0,Number.MAX_SAFE_INTEGER+1,-1]) {
    const counts={...f.base.counters,findingsChecks:value};
    assert.throws(()=>compose({...f.base,counters:counts},[f.cap],f.owner),failure('INVALID_CURRENT_IMAGE','integer'));
  }
  const boundary=authoredGap();
  assert.equal(direct(boundary.expected.bundle,boundary.expected.counters).bundle.findingsChecks[0].id,'findings-check-100');
  const overflow=clone(boundary.apply);rebindRequest(overflow,item=>{item.base.counters.findingsChecks=Number.MAX_SAFE_INTEGER;});
  assert.throws(()=>compose(f.base,[overflow],boundary.owner),failure('INVALID_CURRENT_IMAGE','integer'));
});

test('A05 complete scope retains old leaf while correction is a subset',()=>{
  const f=native();const result=compose(f.base,[f.cap],f.owner);
  assert.match(result.bundle.findingsChecks[0].recordUtf8,/Corrections covered: \.\.\/\.\.\/\.\.\/\.\.\/src\/pay\.mjs/u);
  const wrong=clone(f.cap);rebindRequest(wrong,item=>{item.scopePaths=[];});
  assert.throws(()=>compose(f.base,[wrong],f.owner),failure('EVIDENCE_STALE','derived scope'));
  const outside=clone(f.cap);const baseline=decode(outside.baselineCapture);baseline.manifest.entries[1].mode=384;outside.baselineCapture=encode(baseline);
  assert.throws(()=>compose(f.base,[outside],f.owner),failure('EVIDENCE_STALE'));
  const extra=clone(manifest(1));extra.entries[2].children=['extra.mjs','pay.mjs'];
  extra.entries.splice(3,0,{path:'src/extra.mjs',kind:'file',sha256:hash(Buffer.from('extra\n')),mode:420});
  const added=applyCapture({base:f.base,owner:f.owner,before:manifest(1),after:extra}).cap;
  rebindRequest(added,item=>{item.scopePaths=['src/extra.mjs','src/pay.mjs'];});
  updateReceipt(added,item=>{item.testedState.entries=[
    {path:'../../../../src/extra.mjs',value:hash(Buffer.from('extra\n'))},
    {path:TARGET,value:manifest(1).entries.at(-1).sha256},
  ];});
  const augmented=compose(f.base,[added],f.owner);
  assert.match(augmented.bundle.findingsChecks[0].recordUtf8,/Corrections covered: \.\.\/\.\.\/\.\.\/\.\.\/src\/extra\.mjs/u);
  assert.match(augmented.bundle.findingsChecks[0].recordUtf8,/Tested scope: .*src\/pay\.mjs/u);
  assert.equal(readback(augmented,extra).auxiliaryStatus,'TESTS_PASS');
  const reduced=clone(added);rebindRequest(reduced,item=>{item.scopePaths=['src/extra.mjs'];});
  assert.deepEqual(decode(reduced.applyRequest).scopePaths,['src/extra.mjs']);
  assert.throws(()=>compose(f.base,[reduced],f.owner),failure('EVIDENCE_STALE','derived scope'));
  const noDelta=applyCapture({base:f.base,owner:f.owner,before:manifest(1),after:manifest(1)}).cap;
  const observedOnly=compose(f.base,[noDelta],f.owner);
  assert.equal(observedOnly.bundle.findingsChecks[0].recordUtf8,findingsGolden(noDelta,{corrections:[]}));
  const mode=manifest(1);mode.entries.at(-1).mode=384;
  const modeCap=applyCapture({base:f.base,owner:f.owner,before:manifest(1),after:mode}).cap;
  assert.equal(compose(f.base,[modeCap],f.owner).bundle.findingsChecks[0].recordUtf8,findingsGolden(modeCap));
  const inputDelta=manifest(2);inputDelta.entries[1].mode=384;
  const inputCap=applyCapture({base:f.base,owner:f.owner,after:inputDelta}).cap;
  assert.throws(()=>compose(f.base,[inputCap],f.owner),failure('EVIDENCE_STALE','exclusive input changed'));
  for(const key of ['unexpectedWorkspaceEffects','regressionsSelected','failures','blockers']) {
    const bad=clone(noDelta),response=decode(bad.rawResponse);response.result[key]='pending';rebindRaw(bad,response);
    assertRejectedApply(f.base,[bad],f.owner,/missing persisted value/);
  }
  const ignored=clone(extra);ignored.entries[2].children=['.ignored.mjs','pay.mjs'];ignored.entries[3].path='src/.ignored.mjs';
  const ignoredCap=applyCapture({base:f.base,owner:f.owner,before:manifest(1),after:ignored}).cap;
  rebindRequest(ignoredCap,item=>{item.scopePaths=['src/.ignored.mjs','src/pay.mjs'];});
  updateReceipt(ignoredCap,item=>{item.testedState.entries=[{path:'../../../../src/.ignored.mjs',value:ignored.entries[3].sha256},{path:TARGET,value:manifest(1).entries[3].sha256}];});
  assert.equal(compose(f.base,[ignoredCap],f.owner).bundle.findingsChecks[0].recordUtf8,
    findingsGolden(ignoredCap,{corrections:['../../../../src/.ignored.mjs']}));
  // The recipe targets only the authorized new file. Pay is an exclusive input;
  // src is structural closure and does not grant edits to its other children.
  const newPath='../../../../src/new.mjs';
  const authority=clone(AUTHORITY);authority.delivery.authorizedAreas=`- file: \`${newPath}\``;
  authority.delivery.existingInputs+=`\n- \`${TARGET}\``;
  authority.delivery.expectedTests='- node src/new.mjs';
  const recipe=clone(authority.delivery.verificationRecipe);
  recipe.checks[0].args=[{file:{kind:'product',path:newPath}}];
  recipe.checks[0].inputs=[{kind:'input',path:INPUT},{kind:'input',path:TARGET}];
  authority.delivery.verificationRecipe=recipe;
  const resolved=clone(RESOLVED);resolved.recipeSha256=hash(canonicalBytes(recipe).subarray(0,-1));
  resolved.checks[0].args=['src/new.mjs'];
  const command='node src/new.mjs';
  const before=manifest(1);before.entries.splice(3,0,{path:'src/new.mjs',kind:'absent'});
  const after=clone(before);after.entries[2].children=['new.mjs','pay.mjs'];
  after.entries[3]={path:'src/new.mjs',kind:'file',sha256:hash(Buffer.from('new output')),mode:420};
  const initialCap=nativeRound(1,'TESTS_FAIL',1);
  const initialBaseline=decode(initialCap.baselineCapture);initialBaseline.manifest=clone(before);
  initialCap.baselineCapture=encode(initialBaseline);
  const initialObservation=decode(initialCap.verificationObservation);
  initialObservation.recipe=clone(recipe);initialObservation.resolved=clone(resolved);
  initialObservation.before=clone(before);initialObservation.after=clone(before);
  initialObservation.checks[0].request=clone(resolved.checks[0]);initialObservation.checks[0].command=command;
  initialCap.verificationObservation=encode(initialObservation);
  const initialOrigin=decode(initialCap.origin);initialOrigin.verification=clone(resolved);
  initialCap.origin=encode(initialOrigin);initialCap.dispatch=encode(initialOrigin);
  updateReceipt(initialCap,item=>{item.verification=initialObservation;item.testedState.entries=[];});
  const initialResponse=decode(initialCap.rawResponse);
  initialResponse.commands=[{command,exit:1}];
  initialResponse.resultOfEachCommandAndExitCode=`${command} exit 1`;
  initialResponse.affectedFilesOrBehaviors='src/new.mjs';
  initialResponse.filelessReason='The approved new output is absent and the captured node check failed.';
  rebindRaw(initialCap,initialResponse);
  const initialRecord=authoredCheck(initialCap,'implementation-check-01',initialGolden(initialCap),authority);
  const initialBase=authoredBundle({implementation:[initialRecord],captures:[initialCap],authority,
    counters:{implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0}});
  const initialControl=composeInitialImplementationEvidence({...initial([initialCap]),authority});
  assert.deepEqual(initialControl.bundle,initialBase.bundle);
  assertBytesEqual(initialControl.bytes,initialBase.bytes);
  const request=formalRequest({baseBytes:initialBase.bytes,counters:initialBase.counters,authority,owner:validationOwner(1),
    priorScopePaths:[],scopePaths:['src/new.mjs']});
  const formal=formalCapture({request,status:'NEEDS_FIX',newFindings:[finding(1,1)],
    findingReferences:'finding-01',findingDispositions:'finding-01=active',work:before,
    approvedAuthority:authority,resolved,command,exit:1}).cap;
  const admission=authoredBundle({implementation:[initialRecord],validation:authoredFormal(formal,authority),
    openFindings:[finding(1,1)],captures:[initialCap,formal],
    authority,counters:{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:1}});
  assert.equal(validateCurrentValidationEvidence({context:CONTEXT,authority,bundleBytes:admission.bytes,
    counters:admission.counters,observedWork:before}).formalStatus,'NEEDS_FIX');
  const structural=applyCapture({base:admission,before,after}).cap;
  rebindRequest(structural,item=>{item.authority=authority;item.base.priorScopePaths=['src/new.mjs'];item.scopePaths=['src/new.mjs'];});
  const structuralResponse=decode(structural.rawResponse);
  structuralResponse.result.commands=[{command,exit:0}];
  structuralResponse.result.resultOfEachCommandAndExitCode=`${command} exit 0`;
  structuralResponse.result.affectedFilesOrBehaviors='src/new.mjs';
  structuralResponse.result.correctionsCovered='Created src/new.mjs inside the approved file claim.';
  rebindRaw(structural,structuralResponse);
  const structuralOrigin=decode(structural.origin);structuralOrigin.verification=clone(resolved);
  structural.origin=encode(structuralOrigin);structural.dispatch=encode(structuralOrigin);
  const structuralObservation=decode(structural.verificationObservation);
  structuralObservation.recipe=clone(recipe);structuralObservation.resolved=clone(resolved);
  structuralObservation.checks[0].request=clone(resolved.checks[0]);
  structuralObservation.checks[0].command=command;
  structural.verificationObservation=encode(structuralObservation);
  updateReceipt(structural,item=>{item.verification=structuralObservation;
    item.testedState.entries=[{path:'../../../../src/new.mjs',value:after.entries[3].sha256}];});
  const expectedStructural=authoredBundle({findingsChecks:[authoredCheck(structural,'findings-check-01',
    findingsGolden(structural,{corrections:['../../../../src/new.mjs']}),authority)],validation:admission.bundle.validation,
    openFindings:[finding(1,1)],captures:[formal,structural],authority,
    counters:{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1}});
  const inspectStructural=result=>validateCurrentFindingsEvidence({context:CONTEXT,authority,bundleBytes:result.bytes,
    counters:result.counters,observedWork:after});
  assert.deepEqual(decode(structural.applyRequest).authority.delivery.verificationRecipe,recipe);
  assert.deepEqual(decode(structural.verificationObservation).recipe,recipe);
  const structuralComposed=composeCurrentFindingsEvidence({context:CONTEXT,authority,owner:applyOwner(),
    previous:{bundleBytes:admission.bytes,counters:admission.counters},rounds:[structural]});
  assert.deepEqual(structuralComposed.bundle,expectedStructural.bundle);
  assertBytesEqual(structuralComposed.bytes,expectedStructural.bytes);
  assert.equal(inspectStructural(expectedStructural).auxiliaryStatus,'TESTS_PASS');
  const illegal=clone(structural),observed=decode(illegal.verificationObservation);
  const sibling={path:'src/other.mjs',kind:'file',sha256:hash(Buffer.from('other output')),mode:420};
  for (const work of [observed.before,observed.after]) {
    work.entries[2].children=['new.mjs','other.mjs','pay.mjs'];
    work.entries.splice(4,0,clone(sibling));
  }
  illegal.verificationObservation=encode(observed);
  updateReceipt(illegal,item=>{item.verification=observed;});
  const illegallyAuthored=authoredBundle({findingsChecks:[authoredCheck(illegal,'findings-check-01',
    findingsGolden(illegal,{corrections:['../../../../src/new.mjs','../../../../src/other.mjs']}),authority)],validation:admission.bundle.validation,
    openFindings:[finding(1,1)],captures:[formal,illegal],authority,counters:expectedStructural.counters});
  assert.throws(()=>validateCurrentFindingsEvidence({context:CONTEXT,authority,bundleBytes:illegallyAuthored.bytes,
    counters:illegallyAuthored.counters,observedWork:observed.after}),
    failure('EVIDENCE_INCOMPLETE','unexpected domain member src/other.mjs'));
  const escaped=clone(noDelta),escapePayload=decode(escaped.rawResponse);
  escapePayload.result.unexpectedWorkspaceEffects='json:"literal effect"';escapePayload.result.regressionsSelected='First line\nSecond line';
  rebindRaw(escaped,escapePayload);
  const expectedEscaping=findingsGolden(noDelta,{corrections:[]})
    .replace('- Unexpected workspace effects: none',`- Unexpected workspace effects: json:${JSON.stringify(escapePayload.result.unexpectedWorkspaceEffects)}`)
    .replace('- Regressions: Selected direct pay regression.',`- Regressions: json:${JSON.stringify(escapePayload.result.regressionsSelected)}`);
  assert.equal(compose(f.base,[escaped],f.owner).bundle.findingsChecks[0].recordUtf8,expectedEscaping);
  const full=removalBase(),preserved=oldSourceCapture(full.base,f.owner,full.before,full.before);
  assert.equal(compose(full.base,[preserved],f.owner).auxiliaryStatus,'TESTS_PASS');
  const omittedLeaf=applyCapture({base:full.base,owner:f.owner,before:full.before,after:manifest(1)}).cap;
  rebindRequest(omittedLeaf,item=>{item.base.priorScopePaths=OLD_SCOPE;item.scopePaths=OLD_SCOPE;});
  assert.throws(()=>compose(full.base,[omittedLeaf],f.owner),failure('EVIDENCE_STALE','prior domain member omitted src/old.mjs'));
  const missingChild=clone(preserved),missingObservation=decode(missingChild.verificationObservation);
  missingObservation.before.entries=missingObservation.before.entries.filter(item=>item.path!=='src/old.mjs');
  missingObservation.after=clone(missingObservation.before);missingChild.verificationObservation=encode(missingObservation);
  updateReceipt(missingChild,item=>{item.verification=missingObservation;});
  assert.throws(()=>compose(full.base,[missingChild],f.owner),failure('EVIDENCE_INCOMPLETE','missing present child'));
});

test('A06 formal baseline, next baseline, observation and predecessor ID agree',()=>{
  const f=native();const result=compose(f.base,[f.cap],f.owner);assert.equal(readback(result).auxiliaryStatus,'TESTS_PASS');
  const old=clone(f.cap);const baseline=decode(old.baselineCapture);baseline.manifest=manifest(2);old.baselineCapture=encode(baseline);
  assert.throws(()=>compose(f.base,[old],f.owner),failure('EVIDENCE_STALE'));
  const changed=clone(f.cap);const observation=decode(changed.verificationObservation);observation.before=manifest(1);
  changed.verificationObservation=encode(observation);updateReceipt(changed,item=>{item.verification=observation;});
  assert.throws(()=>compose(f.base,[changed],f.owner),failure('EVIDENCE_STALE'));
  const failing=applyCapture({base:f.base,owner:f.owner,status:'TESTS_FAIL',exit:1});
  const next=applyCapture({base:f.base,owner:f.owner,round:2,status:'TESTS_PASS',exit:0,
    before:manifest(2),after:manifest(3),previousCheck:{id:failing.request.checkId,roundCaptureSha256:roundLink(failing.cap)}});
  rebindRequest(next.cap,item=>{item.previousCheck.id='findings-check-99';});
  assert.throws(()=>compose(f.base,[failing.cap,next.cap],f.owner),failure('EVIDENCE_STALE','previous check link'));
  const goodNext=clone(next.cap);rebindRequest(goodNext,item=>{item.previousCheck.id='findings-check-01';});
  const continuous=compose(f.base,[failing.cap,goodNext],f.owner);
  assert.equal(continuous.bundle.findingsChecks[1].recordUtf8,findingsGolden(goodNext,{roundCorrections:[TARGET],priorFailure:'Pay check failed.'}));
  const discontinuous=clone(goodNext),start=decode(discontinuous.baselineCapture);start.manifest=manifest(1);discontinuous.baselineCapture=encode(start);
  assert.throws(()=>compose(f.base,[failing.cap,discontinuous],f.owner),failure('EVIDENCE_STALE','baseline continuity'));
  const expected=repack(continuous,{checks:[authoredCheck(failing.cap,'findings-check-01',findingsGolden(failing.cap)),
    authoredCheck(goodNext,'findings-check-02',findingsGolden(goodNext,{roundCorrections:[TARGET],priorFailure:'Pay check failed.'}))]});
  assert.equal(direct(expected.bundle,expected.counters,manifest(3)).auxiliaryStatus,'TESTS_PASS');
  const forged=clone(expected.bundle);forged.findingsChecks[1].recordUtf8=forged.findingsChecks[1].recordUtf8.replace('Prior-round failure: Pay check failed.','Prior-round failure: Invented failure.');
  assert.throws(()=>direct(forged,expected.counters,manifest(3)),failure('EVIDENCE_STALE','current findings records'));
  const badDirect=repack(expected,{checks:[expected.bundle.findingsChecks[0],
    authoredCheck(next.cap,'findings-check-02',findingsGolden(next.cap,{roundCorrections:[TARGET],priorFailure:'Pay check failed.'}))],captures:[next.cap]});
  assert.throws(()=>direct(badDirect.bundle,badDirect.counters,manifest(3)),failure('EVIDENCE_STALE','previous check link'));
});

test('A07 removal proof requires real preimage bytes, mode and owner',()=>{
  const f=removalBase(),owner=applyOwner();
  const cap=oldSourceCapture(f.base,owner,f.before,f.after,true);
  assert.equal(compose(f.base,[cap],owner).bundle.findingsChecks.length,1);
  const wrong=clone(cap);const proof=decode(wrong.removalProofs[0]);proof.mode=384;wrong.removalProofs=[encode(proof)];
  assert.throws(()=>compose(f.base,[wrong],owner),failure('EVIDENCE_INCOMPLETE','removal'));
  const foreign=clone(cap);const claimed=decode(foreign.removalProofs[0]);claimed.owner=applyOwner(99);
  foreign.removalProofs=[encode(claimed)];
  assert.throws(()=>compose(f.base,[foreign],owner),failure('OWNER_MISMATCH','removal'));
  const absentProof=clone(cap);absentProof.removalProofs=[];
  assert.throws(()=>compose(f.base,[absentProof],owner),failure('EVIDENCE_INCOMPLETE','removal proof set'));
  const wrongBytes=clone(cap),document=decode(wrongBytes.removalProofs[0]);document.bytesBase64=Buffer.from('invented').toString('base64');
  wrongBytes.removalProofs=[encode(document)];
  assert.throws(()=>compose(f.base,[wrongBytes],owner),failure('EVIDENCE_INCOMPLETE','removal bytes'));
  const replacement=oldSourceWork();replacement.entries[3].sha256=hash(Buffer.from('new legacy bytes'));replacement.entries[3].mode=384;
  const make=(round,before,after,status,previousCheck,proof)=>{
    const built=applyCapture({base:f.base,owner,round,before,after,status,exit:status==='TESTS_FAIL'?1:0,previousCheck}).cap;
    rebindRequest(built,item=>{item.base.priorScopePaths=OLD_SCOPE;item.scopePaths=OLD_SCOPE;});
    updateReceipt(built,item=>{item.testedState.entries=[{path:OLD_PATH,value:after.entries[3].kind==='absent'?'REMOVED':after.entries[3].sha256},
      {path:TARGET,value:after.entries[4].sha256}];});
    if(proof)built.removalProofs=[encode({format:'stnl-current-removal-proof-v1',owner,round,path:'src/old.mjs',
      sha256:before.entries[3].sha256,mode:before.entries[3].mode,bytesBase64:Buffer.from(proof).toString('base64')})];
    return built;
  };
  const remove=make(1,f.before,f.after,'TESTS_FAIL',null,OLD_BYTES);
  const recreate=make(2,f.after,replacement,'TESTS_FAIL',{id:'findings-check-01',roundCaptureSha256:roundLink(remove)});
  const removeAgain=make(3,replacement,f.after,'TESTS_PASS',{id:'findings-check-02',roundCaptureSha256:roundLink(recreate)},'new legacy bytes');
  const result=compose(f.base,[remove,recreate,removeAgain],owner);
  assertRoots(result,{checks:['findings-check-01','findings-check-02','findings-check-03'],formal:'attempt-02',support:['attempt-01']});
  const staleProof=clone(removeAgain);staleProof.removalProofs=[encode({...decode(remove.removalProofs[0]),round:3})];
  assert.throws(()=>compose(f.base,[remove,recreate,staleProof],owner),failure('EVIDENCE_INCOMPLETE','removal preimage'));
  const staleWitness=authoredRemovalScenario({recreated:true});
  assert.deepEqual(decode(staleWitness.old.rounds.at(-1).receipt).testedState.entries.map(item=>item.path),[OLD_PATH,TARGET]);
  assert.deepEqual(decode(staleWitness.formalCap.validationRequest).base.priorScopePaths,OLD_SCOPE);
  assert.throws(()=>direct(staleWitness.expected.bundle,staleWitness.expected.counters,staleWitness.work),
    failure('EVIDENCE_INCOMPLETE','current REMOVED lacks witness'));
});

test('A08 fileless input domain obtains its reason from APPLY raw bytes',()=>{
  const setup=filelessInitial();const initialBase=composeInitialImplementationEvidence({...initial([setup.cap]),authority:setup.authority});
  const formalOwner=validationOwner(1);
  const priorReason=decode(setup.cap.rawResponse).filelessReason;
  const asked=formalRequest({baseBytes:initialBase.bytes,counters:initialBase.counters,owner:formalOwner,
    authority:setup.authority,priorScopePaths:[],scopePaths:[],filelessReason:priorReason});
  const resolved=decode(setup.cap.origin).verification;
  const {cap:formalCap}=formalCapture({request:asked,status:'NEEDS_FIX',newFindings:[finding(1,1)],
    findingReferences:'finding-01',findingDispositions:'finding-01=active',work:setup.work,
    resolved,approvedAuthority:setup.authority,command:'node config/settings.json'});
  const base=composeCurrentValidationEvidence({context:CONTEXT,authority:setup.authority,owner:formalOwner,
    previous:{bundleBytes:initialBase.bytes,counters:initialBase.counters},capture:formalCap});
  const owner=applyOwner();const {cap}=applyCapture({base,owner});
  const request=decode(cap.applyRequest);request.authority=clone(setup.authority);
  request.base.priorScopePaths=[];request.scopePaths=[];cap.applyRequest=encode(request);
  const baseline=decode(cap.baselineCapture);baseline.manifest=clone(setup.work);cap.baselineCapture=encode(baseline);
  const observed=decode(cap.verificationObservation);
  observed.before=clone(setup.work);observed.after=clone(setup.work);
  observed.recipe=clone(setup.authority.delivery.verificationRecipe);observed.resolved=clone(resolved);
  observed.checks[0].request=clone(resolved.checks[0]);observed.checks[0].command='node config/settings.json';
  cap.verificationObservation=encode(observed);
  const origin=decode(cap.origin);origin.verification=clone(resolved);cap.origin=encode(origin);cap.dispatch=encode(origin);
  updateReceipt(cap,item=>{item.verification=observed;item.testedState.entries=[];});
  const response=decode(cap.rawResponse);response.requestSha256=hash(cap.applyRequest);
  response.result.commands=[{command:'node config/settings.json',exit:0}];
  response.result.filelessReason='Corrected input-only evidence has no product output.';
  response.result.correctionsCovered='Corrected input-only proof context.';
  rebindRaw(cap,response);
  const input={context:CONTEXT,authority:setup.authority,owner,
    previous:{bundleBytes:base.bytes,counters:base.counters},rounds:[cap]};
  const accepted=composeCurrentFindingsEvidence(input);
  assert.equal(accepted.auxiliaryStatus,'TESTS_PASS');
  assert.equal(accepted.bundle.findingsChecks[0].recordUtf8.includes('Fileless reason: Corrected input-only evidence has no product output.'),true);
  assert.equal(validateCurrentFindingsEvidence({context:CONTEXT,authority:setup.authority,bundleBytes:accepted.bytes,
    counters:accepted.counters,observedWork:setup.work}).validation,'revalidation-required');
  const missing=clone(cap);const malformed=decode(missing.rawResponse);delete malformed.result.filelessReason;rebindRaw(missing,malformed);
  assert.equal(composeCurrentFindingsEvidence({...input,rounds:[missing]}).outcome,'rejected');
  const f=native();const raw=decode(f.cap.rawResponse);raw.result.filelessReason='Input-only corrected verification has no output file.';
  const invalid=clone(f.cap);rebindRaw(invalid,raw);
  assert.equal(compose(f.base,[invalid],f.owner).outcome,'rejected');
  const omitted=clone(f.cap);const missingObserved=decode(omitted.verificationObservation);
  missingObserved.after.entries.splice(1,1);missingObserved.before=clone(missingObserved.after);
  omitted.verificationObservation=encode(missingObserved);updateReceipt(omitted,item=>{item.verification=missingObserved;});
  assert.throws(()=>compose(f.base,[omitted],f.owner),failure('EVIDENCE_INCOMPLETE'));
  const newReason=decode(cap.rawResponse).result.filelessReason;
  const formalRequestV2=formalRequest({baseBytes:accepted.bytes,counters:accepted.counters,owner:validationOwner(2),
    authority:setup.authority,openFindings:[finding(1,1)],priorScopePaths:[],scopePaths:[],filelessReason:newReason});
  formalRequestV2.format='stnl-current-validation-request-v2';formalRequestV2.base.auxiliary={kind:'findings',
    operationAttemptId:owner.operationAttemptId,cycle:'attempt-01',firstCheckId:'findings-check-01',lastCheckId:'findings-check-01',
    recordsSha256:hash(canonicalBytes(accepted.bundle.findingsChecks))};
  const later=formalCapture({request:formalRequestV2,status:'PASS',findingReferences:'finding-01',findingDispositions:'finding-01=resolved',
    work:setup.work,resolved,approvedAuthority:setup.authority,command:'node config/settings.json'}).cap;
  const judged=composeCurrentValidationEvidence({context:CONTEXT,authority:setup.authority,owner:validationOwner(2),
    previous:{bundleBytes:accepted.bytes,counters:accepted.counters},capture:later});
  assert.equal(judged.validation,'current');assertRoots(judged,{checks:['findings-check-01'],formal:'attempt-02',support:['attempt-01']});
  assert.equal(judged.bundle.support.some(item=>item.kind==='implementation-check'),false);
  const wrongReason=clone(later);rebindFormalRequest(wrongReason,item=>{item.scope.filelessReason=priorReason;});
  assert.throws(()=>composeCurrentValidationEvidence({context:CONTEXT,authority:setup.authority,owner:validationOwner(2),
    previous:{bundleBytes:accepted.bytes,counters:accepted.counters},capture:wrongReason}),failure('EVIDENCE_STALE','fileless reason'));
  for(const value of ['','pending','<reason>']) {
    const bad=clone(cap),raw=decode(bad.rawResponse);raw.result.filelessReason=value;rebindRaw(bad,raw);
    const rejected=composeCurrentFindingsEvidence({...input,rounds:[bad]});
    assert.equal(rejected.outcome,'rejected');assert.equal(rejected.bundle.findingsChecks.length,0);
    assert.equal(rejected.bundle.support.at(-1).sources.rawResponse,hash(bad.rawResponse));
  }
  for(const kind of ['absent','directory']) {
    const bad=clone(cap),observed=decode(bad.verificationObservation);
    observed.before.entries[1]=kind==='absent'?{path:'config/settings.json',kind}:{path:'config/settings.json',kind,children:[]};
    if(kind==='absent')observed.before.entries[0].children=[];
    observed.after=clone(observed.before);bad.verificationObservation=encode(observed);updateReceipt(bad,item=>{item.verification=observed;});
    assert.throws(()=>composeCurrentFindingsEvidence({...input,rounds:[bad]}),failure('EVIDENCE_STALE','Existing Input is not a file'));
  }
});

test('A09 external envelope, receipt class and semantic rejection are distinct',()=>{
  const f=native();assert.equal(compose(f.base,[f.cap],f.owner).outcome,'recorded');
  const schema=clone(f.cap);schemaReject(schema);
  const rejected=compose(f.base,[schema],f.owner);assert.equal(rejected.outcome,'rejected');
  assert.equal(rejected.bundle.findingsChecks.length,0);assert.equal(rejected.consumedInvocations,1);
  assert.equal(decode(schema.receipt).semanticResponseStatus,null);
  const mismatch=clone(f.cap);const response=decode(mismatch.rawResponse);response.requestSha256=hash(Buffer.from('stale'));
  response.unexpected='extra envelope field';
  rebindRaw(mismatch,response);assert.throws(()=>compose(f.base,[mismatch],f.owner),failure('EVIDENCE_STALE'));
  const acceptedBad=clone(f.cap);const bad=decode(acceptedBad.rawResponse);bad.result.status='TESTS_FAIL';rebindRaw(acceptedBad,bad);
  assert.throws(()=>compose(f.base,[acceptedBad],f.owner),failure('OWNER_UNCERTAIN'));
  const semantic=clone(f.cap);const body=decode(semantic.rawResponse);body.result.status='TESTS_NOT_APPLICABLE';
  rebindRaw(semantic,body);updateReceipt(semantic,item=>{item.semanticResponseStatus='TESTS_NOT_APPLICABLE';});
  assert.equal(compose(f.base,[semantic],f.owner).outcome,'rejected');
  const failedPass=clone(f.cap);const observed=decode(failedPass.verificationObservation);observed.checks[0].exit=1;
  failedPass.verificationObservation=encode(observed);
  updateReceipt(failedPass,item=>{item.verification=observed;});
  const reported=decode(failedPass.rawResponse);reported.result.commands[0].exit=1;rebindRaw(failedPass,reported);
  assert.equal(compose(f.base,[failedPass],f.owner).outcome,'rejected');
  const falseSchema=clone(f.cap);updateReceipt(falseSchema,item=>{item.status='RUNNER_RESULT_BLOCKED';item.semanticResponseStatus=null;
    item.captureFailure='schema invalid';item.testedState=null;item.verification=null;});falseSchema.verificationObservation=null;
  assert.throws(()=>compose(f.base,[falseSchema],f.owner),failure('OWNER_UNCERTAIN'));
  const blocked=applyCapture({base:f.base,owner:f.owner,status:'BLOCKED',before:manifest(1),after:manifest(1)}).cap;
  const diagnostic=compose(f.base,[blocked],f.owner);
  assert.equal(diagnostic.auxiliaryStatus,'BLOCKED');assert.equal(diagnostic.validation,'revalidation-required');
  const refusedFormal=formalAfter(diagnostic,'PASS');
  assert.throws(()=>composeCurrentValidationEvidence(refusedFormal.input),failure('INVALID_CURRENT_IMAGE','cannot admit formal'));
  // Complete absent scope without a REMOVED tuple is diagnostic, not fileless.
  const absent=manifest(1);absent.entries[2].children=[];absent.entries[3]={path:'src/pay.mjs',kind:'absent'};
  const asked=formalRequest({baseBytes:f.base.bytes,counters:f.base.counters,openFindings:[finding(1,1)],owner:validationOwner(2)});
  const form=formalCapture({request:asked,status:'NEEDS_FIX',findingReferences:'finding-01',findingDispositions:'finding-01=active',work:absent}).cap;
  const absentBase=composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner:validationOwner(2),
    previous:{bundleBytes:f.base.bytes,counters:f.base.counters},capture:form});
  const absentCheck=applyCapture({base:absentBase,before:absent,after:absent,status:'BLOCKED'}).cap;
  updateReceipt(absentCheck,item=>{item.testedState.entries=[];});
  const absentResult=compose(absentBase,[absentCheck]);
  assert.equal(absentResult.auxiliaryStatus,'BLOCKED');assert.doesNotMatch(absentResult.bundle.findingsChecks[0].recordUtf8,/Fileless reason:/u);
  assert.match(absentResult.bundle.findingsChecks[0].recordUtf8,/- Tested state: none/u);
  assert.equal(readback(absentResult,absent).auxiliaryStatus,'BLOCKED');
  for(const transport of ['native']) {
    const base=needsFixBase({transport}),owner=applyOwner();
    const good=applyCapture({base,owner,transport,before:manifest(1),after:manifest(1)}).cap;
    if(transport==='managed')closeManaged([good]);
    assert.equal(compose(base,[good],owner).auxiliaryStatus,'TESTS_PASS');
    const refusedCap=clone(good);schemaReject(refusedCap);
    if(transport==='managed')closeManaged([refusedCap]);
    const refused=assertRejectedApply(base,[refusedCap],owner,/RUNNER_SEMANTIC_RESULT_INVALID/);
    assert.equal(readback(refused,manifest(1)).outcome,'rejected');
    const refusalReplay=compose(refused,[refusedCap],owner);
    assert.equal(refusalReplay.replayed,true);assertBytesEqual(refusalReplay.bytes,refused.bytes);
    const semanticCap=clone(good),semanticRaw=decode(semanticCap.rawResponse);
    semanticRaw.result.regressionsSelected='pending';rebindRaw(semanticCap,semanticRaw);
    if(transport==='managed')closeManaged([semanticCap]);
    const semanticRefusal=assertRejectedApply(base,[semanticCap],owner,/missing persisted value/);
    assert.equal(readback(semanticRefusal,manifest(1)).outcome,'rejected');
    const semanticReplay=compose(semanticRefusal,[semanticCap],owner);
    assert.equal(semanticReplay.replayed,true);assertBytesEqual(semanticReplay.bytes,semanticRefusal.bytes);
    for(const [label,make] of [
      ['syntax',()=>'{'],['envelope',()=>({format:'unsupported',requestSha256:hash(good.applyRequest),result:decode(good.rawResponse).result})],
      ['payload',()=>({format:'stnl-current-findings-response-v1',requestSha256:hash(good.applyRequest),result:{status:'TESTS_PASS'}})]]) {
      for(const observed of [false,true]) {
        const cap=clone(good),observation=cap.verificationObservation;
        schemaReject(cap,typeof make()==='string'?make():JSON.stringify(make()));
        if(observed){cap.verificationObservation=observation;updateReceipt(cap,item=>{item.verification=decode(observation);});}
        if(transport==='managed')closeManaged([cap]);
        assertRejectedApply(base,[cap],owner,/RUNNER_SEMANTIC_RESULT_INVALID/);
      }
    }
    for(const [key,value,relation] of [['failures','none',/FAIL lacks observed failure/],['commands',[],/payload requires executed commands/],
      ['regressionsSelected','pending',/missing persisted value/]]) {
      const cap=clone(good),raw=decode(cap.rawResponse);raw.result[key]=value;
      if(key==='failures'){raw.result.status='TESTS_FAIL';updateReceipt(cap,item=>{item.semanticResponseStatus='TESTS_FAIL';});}
      rebindRaw(cap,raw);if(transport==='managed')closeManaged([cap]);assertRejectedApply(base,[cap],owner,relation);
    }
    const extra=clone(good),raw=decode(extra.rawResponse);raw.extra=true;rebindRaw(extra,raw);
    if(transport==='managed')closeManaged([extra]);assertRejectedApply(base,[extra],owner,/fields differ/);
    for(const raw of [decode(good.rawResponse).result,{format:'stnl-current-findings-response-v1',requestSha256:hash(good.applyRequest),result:{}},
      '{"result":{"status":"TESTS_PASS"},"result":{"status":"TESTS_FAIL"}}']) {
      const bad=clone(good);rebindRaw(bad,raw);if(transport==='managed')closeManaged([bad]);
      assert.throws(()=>compose(base,[bad],owner),failure('OWNER_UNCERTAIN','cannot bind result status'));
    }
    const stale=clone(good);// Rebind transport while keeping the old envelope request hash.
    rebindRequest(stale,item=>{item.scopePaths=[];});stale.rawResponse=good.rawResponse;
    rebindRaw(stale,Buffer.from(good.rawResponse).toString());if(transport==='managed')closeManaged([stale]);
    assert.throws(()=>compose(base,[stale],owner),failure('EVIDENCE_STALE','requestSha256'));
  }
  const transportMismatch=clone(f.cap);transportMismatch.rawResponse=Buffer.from(Buffer.from(f.cap.rawResponse).toString()+' ');
  assert.throws(()=>compose(f.base,[transportMismatch],f.owner),failure('EVIDENCE_INCOMPLETE','raw native result differs'));
  const toolMismatch=clone(f.cap),tool=decode(toolMismatch.concludedToolResult);tool.finalResponse+=' ';toolMismatch.concludedToolResult=encode(tool);
  assert.throws(()=>compose(f.base,[toolMismatch],f.owner),failure('EVIDENCE_INCOMPLETE','raw native result differs'));
  const statusMissing=clone(f.cap);updateReceipt(statusMissing,item=>{item.semanticResponseStatus=null;});
  assert.throws(()=>compose(f.base,[statusMissing],f.owner),failure('OWNER_UNCERTAIN','cannot bind result status'));
  const failWithoutFailure=applyCapture({base:f.base,owner:f.owner,status:'TESTS_FAIL',exit:1}).cap;
  const failurePayload=decode(failWithoutFailure.rawResponse);failurePayload.result.failures='none';rebindRaw(failWithoutFailure,failurePayload);
  assertRejectedApply(f.base,[failWithoutFailure],f.owner,/lacks objective Failures/);
  const hiddenMechanical=clone(f.cap),invalidResult=decode(hiddenMechanical.rawResponse);delete invalidResult.result.coverage;
  rebindRaw(hiddenMechanical,invalidResult);hiddenMechanical.verificationObservation=null;
  updateReceipt(hiddenMechanical,item=>{item.verification=null;});
  assert.throws(()=>compose(f.base,[hiddenMechanical],f.owner),failure('EVIDENCE_INCOMPLETE','accepted findings lack observation'));
});

test('A10 formal v2 is tied to complete APPLY and alone disposes findings',()=>{
  const f=native();const applied=compose(f.base,[f.cap],f.owner);
  const formal=formalAfter(applied,'PASS');const result=composeCurrentValidationEvidence(formal.input);
  assert.equal(decode(formal.cap.validationRequest).format,'stnl-current-validation-request-v2');
  const authoredPass=authoredBundle({findingsChecks:[authoredCheck(f.cap,'findings-check-01',findingsGolden(f.cap))],
    validation:authoredFormal(formal.cap),openFindings:[],support:[f.base.bundle.validation],
    captures:[f.cap,formal.cap],objects:f.base.bundle.objects,
    counters:{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1}});
  assert.deepEqual(result.bundle,authoredPass.bundle);
  assert.equal(validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:authoredPass.bytes,
    counters:authoredPass.counters,observedWork:manifest(2)}).validation,'current');
  assert.equal(result.formalStatus,'PASS');assert.equal(result.validation,'current');
  assert.deepEqual(result.bundle.openFindings,[]);
  assert.equal(result.bundle.findingsChecks.length,1);
  assert.deepEqual(result.counters,{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1});
  assert.equal(validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:result.bytes,
    counters:result.counters,observedWork:manifest(2)}).validation,'current');
  const v1=clone(formal.input);const asked=decode(v1.capture.validationRequest);asked.format='stnl-current-validation-request-v1';
  delete asked.base.auxiliary;v1.capture.validationRequest=encode(asked);
  rebindFormalRequest(v1.capture,item=>item);
  assert.throws(()=>composeCurrentValidationEvidence(v1),failure('INVALID_CURRENT_IMAGE','v1 cannot follow findings checks'));
  const incompleteV2=clone(formal.input);
  rebindFormalRequest(incompleteV2.capture,item=>{delete item.base.auxiliary;});
  assert.throws(()=>composeCurrentValidationEvidence(incompleteV2),failure('INVALID_CURRENT_IMAGE','validation request base: fields differ'));
  const wrong=clone(formal.input);const request=decode(wrong.capture.validationRequest);
  request.base.auxiliary.recordsSha256=hash(Buffer.from('wrong cycle'));wrong.capture.validationRequest=encode(request);
  rebindFormalRequest(wrong.capture,item=>item);
  assert.throws(()=>composeCurrentValidationEvidence(wrong),failure('EVIDENCE_STALE','auxiliary'));
  const blockedFormal=formalAfter(applied,'BLOCKED');const blocked=composeCurrentValidationEvidence(blockedFormal.input);
  assert.equal(blocked.formalStatus,'BLOCKED');assert.deepEqual(blocked.bundle.openFindings,[finding(1,1)]);
  assert.equal(blocked.validation,'revalidation-required');
  const incomplete=clone(formal.cap),answer=decode(incomplete.rawResponse);answer.result.findingDispositions='none';rebindRaw(incomplete,answer);
  const rejected=composeCurrentValidationEvidence({...formal.input,capture:incomplete});
  assert.equal(rejected.outcome,'rejected');assert.equal(rejected.validation,'uncertain');assert.deepEqual(rejected.counters,applied.counters);
  assertRoots(rejected,{checks:['findings-check-01'],formal:'attempt-01',support:['rejection']});
  assert.equal(rejected.bundle.support[0].sources.rawResponse,hash(incomplete.rawResponse));
  assert.equal(readback(rejected).formalStatus,'NEEDS_FIX');
  const afterPass=formalAfter(result,'PASS'),badAfterPass=clone(afterPass.cap),badPayload=decode(badAfterPass.rawResponse);
  badPayload.result.evidence='pending';rebindRaw(badAfterPass,badPayload);
  const laterRejection=composeCurrentValidationEvidence({...afterPass.input,capture:badAfterPass});
  assertRoots(laterRejection,{checks:['findings-check-01'],formal:'attempt-02',support:['attempt-01','rejection']});
  assert.deepEqual(laterRejection.bundle.validation,result.bundle.validation);
  assert.equal(laterRejection.validation,'uncertain');assert.deepEqual(laterRejection.counters,result.counters);
  for(const [mutate,code,relation] of [[request=>{request.base.auxiliary.cycle='attempt-99';},'EVIDENCE_STALE','auxiliary'],
    [request=>{request.base.counters.findingsChecks=2;},'INVALID_CURRENT_IMAGE','base counters']]) {
    const bad=clone(formal.cap);rebindFormalRequest(bad,mutate);
    assert.throws(()=>composeCurrentValidationEvidence({...formal.input,capture:bad}),failure(code,relation));
  }
  const rounds=[];
  for(let round=1;round<=3;round++) rounds.push(applyCapture({base:f.base,owner:f.owner,round,status:'TESTS_FAIL',exit:1,
    before:manifest(1),after:manifest(1),previousCheck:round===1?null:
      {id:`findings-check-0${round-1}`,roundCaptureSha256:roundLink(rounds.at(-1))}}).cap);
  const exhausted=compose(f.base,rounds,f.owner);
  const passing=formalAfter(exhausted,'PASS',[],manifest(3));
  const validated=composeCurrentValidationEvidence(passing.input);
  assert.equal(validated.validation,'current');assert.deepEqual(validated.bundle.findingsChecks,exhausted.bundle.findingsChecks);
  assert.match(validated.bundle.validation.recordUtf8,/`node src\/pay.mjs` \| exit:0/u);
  assert.ok(validated.bundle.findingsChecks.every(item=>item.recordUtf8.includes('| exit:1')));
  const wrongIndex=clone(applied.bundle);wrongIndex.openFindings=[];
  assert.throws(()=>direct(wrongIndex,applied.counters),failure('INVALID_CURRENT_IMAGE','current findings index'));
  const refusedApply=clone(f.cap);schemaReject(refusedApply);
  const refused=compose(f.base,[refusedApply],f.owner);
  const nextRequest=formalAfter(applied,'PASS');nextRequest.input.previous={bundleBytes:refused.bytes,counters:refused.counters};
  rebindFormalRequest(nextRequest.cap,item=>{item.base.evidenceSha256=hash(refused.bytes);item.base.counters=refused.counters;});
  assert.throws(()=>composeCurrentValidationEvidence(nextRequest.input),failure('RUNNER_RESULT_REJECTED','normalization'));
});

test('synthetic Initial NEEDS_FIX correction reaches new formal PASS with replay and stale guards',()=>{
  const {base,owner,cap}=native();
  assert.deepEqual(base.bundle.openFindings,[finding(1,1)]);
  const applied=compose(base,[cap],owner);
  assert.equal(applied.validation,'revalidation-required');
  assert.deepEqual(applied.bundle.openFindings,[finding(1,1)]);
  assert.deepEqual(applied.counters,{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1});
  const replayApply=compose(base,[cap],owner);
  assert.deepEqual(replayApply.bytes,applied.bytes);
  const stale=clone(cap);
  rebindRequest(stale,item=>{item.scopePaths=[];});
  stale.rawResponse=cap.rawResponse;
  rebindRaw(stale,Buffer.from(cap.rawResponse).toString());
  assert.throws(()=>compose(base,[stale],owner),failure('EVIDENCE_STALE','requestSha256'));
  const formal=formalAfter(applied,'PASS');
  const completed=composeCurrentValidationEvidence(formal.input);
  assert.equal(completed.formalStatus,'PASS');
  assert.equal(completed.validation,'current');
  assert.deepEqual(completed.bundle.openFindings,[]);
  assert.deepEqual(completed.counters,{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1});
  assert.match(completed.bundle.validation.recordUtf8,/finding-01=resolved/u);
  const replayFormal=composeCurrentValidationEvidence({...formal.input,
    previous:{bundleBytes:completed.bytes,counters:completed.counters}});
  assert.equal(replayFormal.replayed,true);
  assert.deepEqual(replayFormal.bytes,completed.bytes);
  const staleFormal=clone(formal.input);
  rebindFormalRequest(staleFormal.capture,item=>{item.base.auxiliary.cycle='attempt-99';});
  assert.throws(()=>composeCurrentValidationEvidence(staleFormal),failure('EVIDENCE_STALE','auxiliary'));
});

test('A11 PASS effective base follows formal observation and passive drift',()=>{
  const f=native();const applied=compose(f.base,[f.cap],f.owner);
  assert.equal(readback(applied).validation,'revalidation-required');
  const formal=formalAfter(applied,'PASS');const completed=composeCurrentValidationEvidence(formal.input);
  assert.equal(completed.validation,'current');
  const drift=validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:completed.bytes,
    counters:completed.counters,observedWork:manifest(3)});
  assert.equal(drift.validation,'revalidation-required');
  assert.equal(readback(completed,manifest(3)).validation,'revalidation-required');
  const mode=clone(manifest(2));mode.entries.at(-1).mode=448;
  assert.equal(readback(completed,mode).validation,'revalidation-required');
  const refreshed=formalAfter(completed,'PASS',[],manifest(3));
  const current=composeCurrentValidationEvidence(refreshed.input);
  assert.equal(current.validation,'current');assert.equal(current.bundle.validation.id,'attempt-03');
  assertRoots(current,{checks:['findings-check-01'],formal:'attempt-03',support:['attempt-01']});
  const replay=composeCurrentValidationEvidence({...refreshed.input,previous:{bundleBytes:current.bytes,counters:current.counters}});
  assert.equal(replay.replayed,true);assert.equal(replay.validation,'current');assert.deepEqual(replay.bytes,current.bytes);
  const inputMode=manifest(3);inputMode.entries[1].mode=384;
  assert.equal(readback(current,inputMode).validation,'revalidation-required');
  const child=manifest(3);child.entries[2].children.push('visible.mjs');
  child.entries.push({path:'src/visible.mjs',kind:'file',sha256:hash(Buffer.from('visible')),mode:420});
  assert.equal(readback(current,child).validation,'revalidation-required');
  const forged=clone(current.bundle);forged.validation.recordUtf8=forged.validation.recordUtf8.replace('0123456789abcdef','fedcba9876543210');
  assert.throws(()=>direct(forged,current.counters,manifest(3)),failure('EVIDENCE_STALE','formal record'));
  const refreshedAgain=formalAfter(current,'NEEDS_FIX',[finding(2,4)],manifest(3));
  const needsFix=composeCurrentValidationEvidence(refreshedAgain.input);
  assert.equal(needsFix.formalStatus,'NEEDS_FIX');assert.deepEqual(needsFix.bundle.openFindings,[finding(2,4)]);
  const owner=applyOwner(66),cap=applyCapture({base:needsFix,owner,before:manifest(3),after:manifest(3)}).cap;
  const next=compose(needsFix,[cap],owner);assertRoots(next,{checks:['findings-check-02'],formal:'attempt-04',support:[]});
});

test('A12 thirty corrections prune old cycles while high-water counters grow',()=>{
  const f=native();let current=compose(f.base,[f.cap],f.owner);
  const origin=f.base.bundle.validation;let priorAdmission=origin,lastApply=f.cap;
  let oracle=authoredBundle({findingsChecks:[authoredCheck(f.cap,'findings-check-01',findingsGolden(f.cap))],
    validation:origin,openFindings:[finding(1,1)],objects:f.base.bundle.objects,captures:[f.cap],
    counters:{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1}});
  assert.deepEqual(current.bundle,oracle.bundle);
  for (let n=2;n<=30;n+=1) {
    const formal=formalAfter(current,'NEEDS_FIX');current=composeCurrentValidationEvidence(formal.input);
    const latest=authoredFormal(formal.cap);
    oracle=authoredBundle({findingsChecks:[authoredCheck(lastApply,`findings-check-${String(n-1).padStart(2,'0')}`,
      findingsGolden(lastApply,{corrections:n===2?[TARGET]:[]}))],validation:latest,openFindings:[finding(1,1)],
      support:n===2?[origin]:[origin,priorAdmission],objects:oracle.bundle.objects,captures:[formal.cap],
      counters:{implementationChecks:1,findingsChecks:n-1,validationAttempts:n,findings:1}});
    assert.deepEqual(current.bundle,oracle.bundle,`formal ${n} exact records and objects`);
    const owner=applyOwner(10+n);
    const cap=applyCapture({base:current,owner,before:manifest(2),after:manifest(2)}).cap;
    current=compose(current,[cap],owner);
    oracle=authoredBundle({findingsChecks:[authoredCheck(cap,`findings-check-${String(n).padStart(2,'0')}`,findingsGolden(cap,{corrections:[]}))],
      validation:latest,openFindings:[finding(1,1)],support:[origin],objects:oracle.bundle.objects,captures:[cap],
      counters:{implementationChecks:1,findingsChecks:n,validationAttempts:n,findings:1}});
    assert.deepEqual(current.bundle,oracle.bundle,`APPLY ${n} exact records and objects`);
    assert.deepEqual(current.counters,oracle.counters);
    assertRoots(current,{checks:[`findings-check-${String(n).padStart(2,'0')}`],formal:`attempt-${String(n).padStart(2,'0')}`,support:['attempt-01']});
    priorAdmission=latest;lastApply=cap;
  }
  assert.equal(readback(current,manifest(2)).formalStatus,'NEEDS_FIX');
  const old=clone(f.cap);assert.throws(()=>compose(current,[old],f.owner),failure('STALE_BASE'));
  const other=native();const firstApply=compose(other.base,[other.cap],other.owner);
  const changed=formalAfter(firstApply,'NEEDS_FIX',[finding(2,2)]);
  const answer=decode(changed.cap.rawResponse);
  answer.result.findingDispositions='finding-01=resolved, finding-02=active';
  rebindRaw(changed.cap,answer);
  const partial=composeCurrentValidationEvidence(changed.input);
  assert.deepEqual(partial.bundle.openFindings,[finding(2,2)]);
  const replacementOwner=applyOwner(99);
  const replacement=applyCapture({base:partial,owner:replacementOwner,before:manifest(2),after:manifest(2)}).cap;
  const pruned=compose(partial,[replacement],replacementOwner);
  assert.equal(pruned.bundle.support.some(item=>item.kind==='validation' && item.id==='attempt-01'),false);
  const finish=formalAfter(pruned,'PASS'),closed=composeCurrentValidationEvidence(finish.input);
  assert.deepEqual(closed.bundle.openFindings,[]);
  assertRoots(closed,{checks:['findings-check-02'],formal:'attempt-03',support:['attempt-02']});
  const next=formalAfter(closed,'PASS'),cleared=composeCurrentValidationEvidence(next.input);
  assertRoots(cleared,{checks:['findings-check-02'],formal:'attempt-04',support:['attempt-02']});
  assert.deepEqual(cleared.counters,{implementationChecks:1,findingsChecks:2,validationAttempts:4,findings:2});
  // The admission literal contains an auxiliary hash for pruned cycle A; it is
  // not an object root and cannot demand that obsolete chain.
  assert.equal(cleared.bundle.objects.some(item=>item.id===decode(changed.cap.validationRequest).base.auxiliary.recordsSha256),false);
  // Include the old sources coherently, then require rejection specifically for
  // an undemanded cycle rather than a missing hash.
  const oldCycle=authoredBundle({findingsChecks:pruned.bundle.findingsChecks,validation:pruned.bundle.validation,
    openFindings:pruned.bundle.openFindings,support:firstApply.bundle.findingsChecks,
    objects:[...pruned.bundle.objects,...firstApply.bundle.objects],counters:pruned.counters});
  assert.throws(()=>direct(oldCycle.bundle,oldCycle.counters),failure('INVALID_CURRENT_IMAGE','undemanded removal cycle'));
  const originMissing=clone(current.bundle);originMissing.support=originMissing.support.filter(item=>item.id!=='attempt-01');
  const without=authoredBundle({findingsChecks:originMissing.findingsChecks,validation:originMissing.validation,
    openFindings:originMissing.openFindings,support:originMissing.support,objects:current.bundle.objects,counters:current.counters});
  assert.deepEqual(without.bundle.openFindings.map(item=>[item.id,item.originAttempt]),[['finding-01','attempt-01']]);
  const missingOrigin=without.bundle.openFindings[0].originAttempt;
  assert.equal([...without.bundle.support,without.bundle.validation]
    .some(item=>item.kind==='validation' && item.id===missingOrigin),false);
  assert.throws(()=>direct(without.bundle,without.counters),failure('EVIDENCE_INCOMPLETE'));
  assert.throws(()=>direct(current.bundle,{...current.counters,findingsChecks:current.bundle.findingsChecks.length}),
    failure('INVALID_CURRENT_IMAGE'));
  const invalidFormal=formalAfter(pruned,'PASS'),invalidCapture=clone(invalidFormal.cap),invalidResponse=decode(invalidCapture.rawResponse);
  invalidResponse.result.evidence='pending';rebindRaw(invalidCapture,invalidResponse);
  const refused=composeCurrentValidationEvidence({...invalidFormal.input,capture:invalidCapture});
  assertRoots(refused,{checks:['findings-check-02'],formal:'attempt-02',support:['rejection']});
  assert.equal(refused.validation,'uncertain');assert.deepEqual(refused.bundle.openFindings,[finding(2,2)]);
});

test('A13 prior removal cycle remains only while an absent leaf needs its bytes',()=>{
  const f=removalBase(),firstOwner=applyOwner();
  const first=oldSourceCapture(f.base,firstOwner,f.before,f.after,true);
  const applied=compose(f.base,[first],firstOwner);
  const owner=validationOwner(3);
  const asked=formalRequest({baseBytes:applied.bytes,counters:applied.counters,openFindings:applied.bundle.openFindings,
    priorScopePaths:OLD_SCOPE,owner,scopePaths:OLD_SCOPE});
  asked.format='stnl-current-validation-request-v2';asked.base.auxiliary={kind:'findings',
    operationAttemptId:firstOwner.operationAttemptId,cycle:'attempt-02',firstCheckId:'findings-check-01',
    lastCheckId:'findings-check-01',recordsSha256:hash(canonicalBytes(applied.bundle.findingsChecks))};
  const {cap}=formalCapture({request:asked,status:'NEEDS_FIX',findingReferences:'finding-01',
    findingDispositions:'finding-01=active',work:f.after});
  const receipt=decode(cap.receipt);receipt.testedState.entries=[
    {path:OLD_PATH,value:'REMOVED'},
    {path:TARGET,value:f.after.entries.find(item=>item.path==='src/pay.mjs').sha256},
  ];cap.receipt=encode(receipt);
  const formal=composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner,
    previous:{bundleBytes:applied.bytes,counters:applied.counters},capture:cap});
  const inheritedOwner=applyOwner(13);
  const inherited=oldSourceCapture(formal,inheritedOwner,f.after,f.after);
  const retained=compose(formal,[inherited],inheritedOwner);
  assert.equal(retained.bundle.support.filter(item=>item.kind==='findings-check').length,1);
  assert.equal(validateCurrentFindingsEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:retained.bytes,
    counters:retained.counters,observedWork:f.after}).auxiliaryStatus,'TESTS_PASS');
  const nextOwner=applyOwner(12);
  const next=oldSourceCapture(formal,nextOwner,f.after,oldSourceWork());
  const result=compose(formal,[next],nextOwner);
  assert.equal(result.bundle.support.filter(item=>item.kind==='findings-check').length,0);
  assert.equal(readback(result,oldSourceWork()).validation,'revalidation-required');
  for(const transport of ['native']) {
    const authored=authoredRemovalScenario({transport});
    assert.equal(direct(authored.expected.bundle,authored.expected.counters,authored.work).auxiliaryStatus,'TESTS_PASS');
    assertRoots(authored.expected,{checks:['findings-check-01'],formal:'attempt-01',support:['implementation-check-01','implementation-check-02']});
    const missing=authoredBundle({findingsChecks:authored.expected.bundle.findingsChecks,validation:authored.expected.bundle.validation,
      openFindings:[finding(1,1)],objects:authored.expected.bundle.objects,counters:authored.expected.counters});
    assert.throws(()=>direct(missing.bundle,missing.counters,authored.work),failure('EVIDENCE_INCOMPLETE','REMOVED lacks witness'));
    const regressed=authoredRemovalScenario({transport,implementationChecks:1});
    assert.equal(regressed.records.length,2);
    assert.deepEqual(decode(regressed.formalCap.validationRequest).base.priorScopePaths,['src/pay.mjs']);
    assert.throws(()=>direct(regressed.expected.bundle,regressed.expected.counters,regressed.work),
      failure('INVALID_CURRENT_IMAGE','retained Initial counters'));
  }
  const witnesses=retained.bundle.support.filter(item=>item.kind==='findings-check');
  assert.deepEqual(witnesses.map(item=>item.id),['findings-check-01']);
  assertRoots(retained,{checks:['findings-check-02'],formal:'attempt-03',support:['findings-check-01','attempt-01']});
  const lowCounts={...retained.counters,implementationChecks:0};
  assert.throws(()=>direct(retained.bundle,lowCounts,f.after),failure('INVALID_CURRENT_IMAGE','counter'));
  const duplicate=clone(retained.bundle);duplicate.support.unshift(clone(retained.bundle.findingsChecks[0]));
  assert.throws(()=>direct(duplicate,retained.counters,f.after),failure('INVALID_CURRENT_IMAGE','duplicate evidence record ordinal'));
  const zeroCheck=authoredRemovalScenario(),zeroCap=clone(zeroCheck.apply);
  const lastInitialReceipt=decode(zeroCheck.old.rounds.at(-1).receipt);
  assert.deepEqual(lastInitialReceipt.testedState.entries.map(item=>item.path),[TARGET]);
  assert.deepEqual(zeroCheck.initialFinalScope,['src/pay.mjs']);
  const formalRequestScope=decode(zeroCheck.formalCap.validationRequest);
  assert.deepEqual(formalRequestScope.base.priorScopePaths,zeroCheck.initialFinalScope);
  assert.deepEqual(formalRequestScope.scope.paths,zeroCheck.formalScope);
  assert.deepEqual(decode(zeroCheck.apply.applyRequest).base.priorScopePaths,zeroCheck.applyPriorScope);
  assert.deepEqual(zeroCheck.applyPriorScope,zeroCheck.formalScope);
  const checkedInitial=validateInitialImplementationEvidence({context:CONTEXT,authority:AUTHORITY,owner:OWNER,
    currentEvidence:null,counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},
    bundleBytes:zeroCheck.initialBase.bytes});
  assertBytesEqual(checkedInitial.bytes,zeroCheck.initialBase.bytes);
  assert.deepEqual(checkedInitial.bundle,zeroCheck.initialBase.bundle);
  const checkedFormal=validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:zeroCheck.base.bytes,counters:zeroCheck.base.counters,observedWork:zeroCheck.work});
  assert.equal(checkedFormal.formalStatus,'NEEDS_FIX');
  assertBytesEqual(checkedFormal.bytes,zeroCheck.base.bytes);
  const composedFormal=composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    owner:zeroCheck.formalOwner,previous:{bundleBytes:zeroCheck.initialBase.bytes,
      counters:zeroCheck.initialBase.counters},capture:zeroCheck.formalCap});
  assert.deepEqual(composedFormal.bundle,zeroCheck.base.bundle);
  assertBytesEqual(composedFormal.bytes,zeroCheck.base.bytes);
  const wrongPrior=clone(zeroCheck.formalCap);
  rebindFormalRequest(wrongPrior,item=>{item.base.priorScopePaths=[...OLD_SCOPE];});
  const wrongPriorBase=authoredBundle({implementation:zeroCheck.records,validation:authoredFormal(wrongPrior),
    openFindings:[finding(1,1)],captures:[...zeroCheck.old.rounds,wrongPrior],counters:zeroCheck.base.counters});
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:wrongPriorBase.bytes,counters:wrongPriorBase.counters,observedWork:zeroCheck.work}),
  failure('EVIDENCE_STALE','first formal prior scope'));
  schemaReject(zeroCap);
  const zeroRefusal=assertRejectedApply(zeroCheck.base,[zeroCap],applyOwner(),/RUNNER_SEMANTIC_RESULT_INVALID/);
  assertRoots(zeroRefusal,{checks:[],formal:'attempt-01',
    support:['implementation-check-01','implementation-check-02','rejection']});
  assert.deepEqual(zeroRefusal.counters,{implementationChecks:2,findingsChecks:0,validationAttempts:1,findings:1});
  assert.deepEqual(zeroRefusal.bundle.implementation,[]);
  assert.deepEqual(zeroRefusal.bundle.findingsChecks,[]);
  assert.deepEqual(zeroRefusal.bundle.validation,zeroCheck.base.bundle.validation);
  assert.deepEqual(zeroRefusal.bundle.openFindings,[finding(1,1)]);
  assert.equal(zeroRefusal.auxiliaryStatus,null);
  const zeroReadback=readback(zeroRefusal,zeroCheck.work);
  assert.equal(zeroReadback.outcome,'rejected');
  assert.equal(zeroReadback.validation,'uncertain');
  assert.equal(zeroReadback.auxiliaryStatus,null);
  assertBytesEqual(zeroReadback.bytes,zeroRefusal.bytes);
  const zeroReplay=compose(zeroRefusal,[zeroCap],applyOwner());
  assert.equal(zeroReplay.replayed,true);
  assert.deepEqual(zeroReplay.bundle,zeroRefusal.bundle);
  assertBytesEqual(zeroReplay.bytes,zeroRefusal.bytes);
  const noZeroWitness=authoredBundle({validation:zeroRefusal.bundle.validation,
    openFindings:zeroRefusal.bundle.openFindings,support:[zeroRefusal.bundle.support.at(-1)],
    objects:zeroRefusal.bundle.objects,counters:zeroRefusal.counters});
  assert.throws(()=>direct(noZeroWitness.bundle,noZeroWitness.counters,zeroCheck.work),
    failure('EVIDENCE_INCOMPLETE','REMOVED lacks witness'));
  for(const transport of ['native']) {
    const both=twoWitnesses(transport);
    assert.equal(direct(both.expected.bundle,both.expected.counters,both.work).auxiliaryStatus,'TESTS_PASS');
    assertRoots(both.expected,{checks:['findings-check-02'],formal:'attempt-02',support:['implementation-check-01','findings-check-01','attempt-01']});
    const replacement=twoWitnesses(transport,true);
    assert.equal(direct(replacement.expected.bundle,replacement.expected.counters,replacement.work).auxiliaryStatus,'TESTS_PASS');
    assertRoots(replacement.expected,{checks:['findings-check-02'],formal:'attempt-02',support:['findings-check-01','attempt-01']});
    const future=clone(both.a);rebindRequest(future,item=>{item.base.counters.findingsChecks=9;item.checkId='findings-check-10';});
    if(transport==='managed')closeManaged([future]);
    const high=authoredCheck(future,'findings-check-10',findingsGolden(future,{corrections:[OLD_PATH]}));
    const corrupt=repack(both.expected,{support:[both.initialRecord,high,both.admission.bundle.validation],captures:[future]});
    assert.throws(()=>direct(corrupt.bundle,corrupt.counters,both.work),failure('INVALID_CURRENT_IMAGE','retained APPLY counters'));
  }
});

test('A14 byte-exact replay is idempotent and owner conflicts cannot mint a check',()=>{
  const f=native();const first=compose(f.base,[f.cap],f.owner);
  const again=compose(f.base,[f.cap],f.owner);
  assertBytesEqual(again.bytes,first.bytes);
  const input={context:CONTEXT,authority:AUTHORITY,owner:f.owner,
    previous:{bundleBytes:first.bytes,counters:first.counters},rounds:[f.cap]};
  const replay=composeCurrentFindingsEvidence(input);
  assert.equal(replay.replayed,true);assertBytesEqual(replay.bytes,first.bytes);
  const changed=clone(f.cap);const response=decode(changed.rawResponse);response.result.evidenceOrFailureSummary='Different checked evidence.';
  rebindRaw(changed,response);assert.throws(()=>composeCurrentFindingsEvidence({...input,rounds:[changed]}),failure('OWNER_MISMATCH'));
  const formal=formalAfter(first,'NEEDS_FIX');const later=composeCurrentValidationEvidence(formal.input);
  assert.throws(()=>composeCurrentFindingsEvidence({...input,previous:{bundleBytes:later.bytes,counters:later.counters}}),failure('STALE_BASE'));
  const sameWork=applyCapture({base:f.base,owner:f.owner,before:manifest(1),after:manifest(1)}).cap;
  const applied=compose(f.base,[sameWork],f.owner);
  // The admission formal is retained but no longer the last incorporation.
  const sources=new Map(f.base.bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')]));
  const capsule=decode(sources.get(f.base.bundle.validation.sources.origin)),agent=decode(sources.get(f.base.bundle.validation.sources.agentBinding));
  const admitted={transport:'native',validationRequest:Buffer.from(capsule.validationRequestUtf8),origin:Buffer.from(capsule.originUtf8),
    dispatch:Buffer.from(capsule.dispatchUtf8),baselineCapture:Buffer.from(capsule.baselineUtf8),agentBinding:Buffer.from(agent.agentUtf8),
    agentClaim:Buffer.from(agent.claimUtf8),rawResponse:sources.get(f.base.bundle.validation.sources.rawResponse),
    receipt:sources.get(f.base.bundle.validation.sources.receipt),concludedToolResult:sources.get(f.base.bundle.validation.sources.concludedToolResult),
    verificationObservation:sources.get(f.base.bundle.validation.sources.verificationObservation),removalProofs:[]};
  assert.throws(()=>composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner:validationOwner(1),
    previous:{bundleBytes:applied.bytes,counters:applied.counters},capture:admitted}),failure('STALE_BASE'));
  const tokenChanged={...f.owner,ownershipToken:applyOwner(45).ownershipToken};
  assert.throws(()=>compose(applied,[sameWork],tokenChanged),failure('OWNER_MISMATCH','input owner'));
  const judgment=formalAfter(applied,'PASS',[],manifest(3));
  const judged=composeCurrentValidationEvidence(judgment.input);
  const last=composeCurrentValidationEvidence({...judgment.input,previous:{bundleBytes:judged.bytes,counters:judged.counters}});
  assert.equal(last.replayed,true);assert.equal(last.validation,'current');assertBytesEqual(last.bytes,judged.bytes);
  const malformed=clone(judgment.cap),body=decode(malformed.rawResponse);body.result.evidence='pending';rebindRaw(malformed,body);
  const refusal=composeCurrentValidationEvidence({...judgment.input,capture:malformed});
  assert.throws(()=>compose(refusal,[sameWork],f.owner),failure('STALE_BASE','after formal'));
  const refusalReplay=composeCurrentValidationEvidence({...judgment.input,capture:malformed,
    previous:{bundleBytes:refusal.bytes,counters:refusal.counters}});
  assert.equal(refusalReplay.replayed,true);assertBytesEqual(refusalReplay.bytes,refusal.bytes);assert.equal(refusalReplay.validation,'uncertain');
  const rejectedCap=clone(sameWork);schemaReject(rejectedCap);const rejectedApply=compose(f.base,[rejectedCap],f.owner);
  assert.equal(compose(rejectedApply,[rejectedCap],f.owner).replayed,true);
  const pretty=Buffer.from(JSON.stringify(applied.bundle,null,2)+'\r\n');
  assertBytesEqual(compose({...applied,bytes:pretty},[sameWork],f.owner).bytes,pretty);
  for(const field of ['rawResponse','receipt','applyRequest','baselineCapture','verificationObservation','origin','dispatch','agentBinding','agentClaim','concludedToolResult']) {
    const varied=clone(sameWork);varied[field]=Buffer.concat([Buffer.from(varied[field]),Buffer.from(' ')]);
    assert.throws(()=>compose(applied,[varied],f.owner),failure('OWNER_MISMATCH','different captured sources'));
  }
  const alteredOwner=clone(judgment.input);alteredOwner.owner.ownershipToken=applyOwner(77).ownershipToken;
  alteredOwner.previous={bundleBytes:judged.bytes,counters:judged.counters};
  assert.throws(()=>composeCurrentValidationEvidence(alteredOwner),failure('OWNER_MISMATCH','request owner'));
  const addedProof=clone(sameWork);addedProof.removalProofs=[Buffer.from('different proof bytes')];
  assert.throws(()=>compose(applied,[addedProof],f.owner),failure('OWNER_MISMATCH','different captured sources'));
  const managedBase=needsFixBase({transport:'managed'}),managedCap=applyCapture({base:managedBase,transport:'managed',before:manifest(1),after:manifest(1)}).cap;
  closeManaged([managedCap]);const beforeManaged=clone(managedCap);assert.throws(()=>compose(managedBase,[managedCap]),failure('UNSUPPORTED_FORMAT'));assert.deepEqual(clone(managedCap),beforeManaged);
});

test('A15 direct authored readback rejects a recomposed but false role relation',()=>{
  const f=native();const authored=authoredNative(f.base,f.cap);
  const counters={implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1};
  assert.equal(direct(authored,counters).auxiliaryStatus,'TESTS_PASS');
  const unfamiliar=clone(authored),originId=unfamiliar.findingsChecks[0].sources.origin;
  const originObject=unfamiliar.objects.find(item=>item.id===originId);
  const capsule=decode(Buffer.from(originObject.bytesBase64,'base64'));
  capsule.format='stnl-native-findings-origin-bundle-v9';
  const capsuleBytes=canonicalBytes(capsule);originObject.id=hash(capsuleBytes);
  originObject.bytesBase64=Buffer.from(capsuleBytes).toString('base64');
  unfamiliar.findingsChecks[0].sources.origin=originObject.id;
  unfamiliar.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  assert.throws(()=>direct(unfamiliar,counters),failure('UNSUPPORTED_FORMAT','capsule format'));
  const rejectedCap=clone(f.cap);schemaReject(rejectedCap);
  const refused=compose(f.base,[rejectedCap],f.owner);
  assert.equal(readback(refused,manifest(1)).outcome,'rejected');
  const mixed=clone(refused.bundle);mixed.implementation=clone(f.base.bundle.implementation);
  mixed.objects=[...new Map([...mixed.objects,...f.base.bundle.objects].map(item=>[item.id,item])).values()]
    .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  assert.throws(()=>direct(mixed,refused.counters,manifest(1)),failure('INVALID_CURRENT_IMAGE','unsupported records'));
  const initialBase=composeInitialImplementationEvidence(initial([nativeRound()]));
  const owner=validationOwner(1),request=formalRequest({baseBytes:initialBase.bytes,counters:initialBase.counters,owner});
  request.format='stnl-current-validation-request-v2';
  request.base.auxiliary={kind:'findings',operationAttemptId:applyOwner().operationAttemptId,cycle:'attempt-01',
    firstCheckId:'findings-check-01',lastCheckId:'findings-check-01',recordsSha256:hash(canonicalBytes([]))};
  const {cap}=formalCapture({request,status:'PASS'});
  assert.equal(decode(cap.rawResponse).requestSha256,hash(cap.validationRequest));
  assert.equal(decode(cap.receipt).semanticResponseSha256,hash(cap.rawResponse).slice(7));
  assert.equal(decode(cap.concludedToolResult).finalResponse,Buffer.from(cap.rawResponse).toString('utf8'));
  assert.throws(()=>composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner,
    previous:{bundleBytes:initialBase.bytes,counters:initialBase.counters},capture:cap}),
    failure('INVALID_CURRENT_IMAGE','version does not match current auxiliary'));
  const missing=clone(authored);missing.objects=missing.objects.filter(item=>item.id!==authored.findingsChecks[0].sources.origin);
  assert.throws(()=>direct(missing,counters),failure('EVIDENCE_INCOMPLETE'));
  const wrong=clone(authored);wrong.findingsChecks[0].recordUtf8+='\n- Invented: yes';
  assert.throws(()=>direct(wrong,counters),failure('EVIDENCE_STALE'));
  const orphan=clone(authored);orphan.objects.push({id:hash(Buffer.from('orphan')),
    bytesBase64:Buffer.from('orphan').toString('base64')});orphan.objects.sort((a,b)=>a.id.localeCompare(b.id));
  assert.throws(()=>direct(orphan,counters),failure('EVIDENCE_INCOMPLETE','orphan object'));
  const observedWork=manifest(2);
  Object.defineProperty(observedWork,'entries',{get(){throw new Error('getter executed');},enumerable:true});
  assert.throws(()=>validateCurrentFindingsEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:canonicalBytes(authored),counters,observedWork}),error=>error.message!=='getter executed');
  for(const transport of ['native']) {
    const base=needsFixBase({transport}),cap=applyCapture({base,transport}).cap;
    if(transport==='managed')closeManaged([cap]);
    const expected=authoredBundle({findingsChecks:[authoredCheck(cap,'findings-check-01',findingsGolden(cap))],
      validation:base.bundle.validation,openFindings:[finding(1,1)],objects:base.bundle.objects,captures:[cap],
      counters:{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1}});
    assert.equal(direct(expected.bundle,expected.counters).auxiliaryStatus,'TESTS_PASS');
    const formalOwner=validationOwner(2),asked=formalRequest({baseBytes:expected.bytes,counters:expected.counters,
      openFindings:[finding(1,1)],priorScopePaths:['src/pay.mjs'],owner:formalOwner});
    asked.format='stnl-current-validation-request-v2';
    asked.base.auxiliary={kind:'findings',operationAttemptId:applyOwner().operationAttemptId,cycle:'attempt-01',
      firstCheckId:'findings-check-01',lastCheckId:'findings-check-01',
      recordsSha256:hash(canonicalBytes(expected.bundle.findingsChecks))};
    const formalCap=formalCapture({transport,request:asked,status:'PASS',findingReferences:'finding-01',
      findingDispositions:'finding-01=resolved',work:manifest(2)}).cap;
    const accepted=authoredBundle({findingsChecks:expected.bundle.findingsChecks,validation:authoredFormal(formalCap),
      openFindings:[],support:[base.bundle.validation],objects:expected.bundle.objects,captures:[formalCap],
      counters:{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1}});
    const validated=validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:accepted.bytes,
      counters:accepted.counters,observedWork:manifest(2)});
    assert.deepEqual(validated.bundle,accepted.bundle);
    assert.equal(validated.bundle.validation.sources.receipt,hash(formalCap.receipt));
    const composed=composeCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,owner:formalOwner,
      previous:{bundleBytes:expected.bytes,counters:expected.counters},capture:formalCap});
    assert.deepEqual(composed.bundle,accepted.bundle);
    const gap=authoredGap(transport);
    assert.equal(direct(gap.expected.bundle,gap.expected.counters).auxiliaryStatus,'TESTS_PASS');
    assertRoots(gap.expected,{checks:['findings-check-100'],formal:'attempt-05',support:['attempt-01']});
    // Change only the declaration in the origin, rebuild raw/tool/receipt,
    // its complete record and source set. The selected detail remains false.
    const request=formalRequest({baseBytes:Buffer.from('origin base'),owner:validationOwner(1)});
    const changedFinding=finding(1,1);changedFinding.problem='Different authored origin problem';
    const changedOrigin=formalCapture({transport,request,status:'NEEDS_FIX',newFindings:[changedFinding],
      findingReferences:'finding-01',findingDispositions:'finding-01=active'}).cap;
    const recomposed=repack(gap.expected,{support:[authoredFormal(changedOrigin)],captures:[changedOrigin]});
    assert.throws(()=>direct(recomposed.bundle,recomposed.counters),failure('EVIDENCE_STALE','origin detail'));
    if(transport==='managed') {
      const noClose=clone(cap);delete noClose.closedSupervisor;
      assert.throws(()=>compose(base,[noClose]),failure('INVALID_CURRENT_IMAGE','fields differ'));
    }
  }
  for(const field of ['applyRequest','transport','rawResponse','receipt','removalProofs']) {
    let reads=0;const cap=clone(f.cap),value=cap[field];
    Object.defineProperty(cap,field,{enumerable:true,get(){reads++;return value;}});
    assert.throws(()=>compose(f.base,[cap],f.owner),failure('INVALID_CURRENT_IMAGE','non-data property'));
    const incorporated=authoredNative(f.base,f.cap);
    assert.throws(()=>compose({bundle:incorporated,bytes:canonicalBytes(incorporated),counters},[cap],f.owner),
      failure('INVALID_CURRENT_IMAGE','non-data property'));
    assert.equal(reads,0);
  }
  let reads=0;const caps=[f.cap];Object.defineProperty(caps,0,{enumerable:true,get(){reads++;return f.cap;}});
  assert.throws(()=>compose(f.base,caps,f.owner),failure('INVALID_CURRENT_IMAGE','dense array'));assert.equal(reads,0);
  const exotic=clone(f.cap);Object.setPrototypeOf(exotic,{unexpected:true});
  assert.throws(()=>compose(f.base,[exotic],f.owner),failure('INVALID_CURRENT_IMAGE','plain object'));
  const sparse=[];sparse.length=1;
  assert.throws(()=>compose(f.base,sparse,f.owner),failure('INVALID_CURRENT_IMAGE','dense array'));
  // Complete authored removal-only roles, including distinct Initial and APPLY
  // witnesses, enter the reader without a producer anywhere in their setup.
  for(const transport of ['native']) {
    const roles=twoWitnesses(transport);
    assert.equal(direct(roles.expected.bundle,roles.expected.counters,roles.work).validation,'revalidation-required');
    const broken=clone(roles.a),proof=decode(broken.removalProofs[0]);proof.sha256=hash(Buffer.from('unrelated'));
    broken.removalProofs=[encode(proof)];
    const record=authoredCheck(broken,'findings-check-01',findingsGolden(broken,{corrections:[OLD_PATH]}));
    const corrupted=repack(roles.expected,{support:[roles.initialRecord,record,roles.admission.bundle.validation],captures:[broken]});
    assert.throws(()=>direct(corrupted.bundle,corrupted.counters,roles.work),failure('EVIDENCE_INCOMPLETE','removal preimage'));
  }
});

test('A16 isolated skill distributions expose two facades and fail on missing sibling',async()=>{
  const root=fileURLToPath(new URL('../skills/workflows/',import.meta.url));
  const temp=fileURLToPath(new URL('../tmp/',import.meta.url));
  const names=['execution-current.mjs','runner-result-contract.mjs','execution-evidence-proof.mjs',
    'execution-evidence-current.mjs','current-evidence-state.mjs','findings-evidence-current.mjs','validation-evidence-current.mjs'];
  const compatibility=needsFixBase();
  assert.equal(validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:compatibility.bytes,
    counters:compatibility.counters,observedWork:manifest(1)}).formalStatus,'NEEDS_FIX');
  const initialOnly=authoredBundle({implementation:compatibility.bundle.implementation,
    objects:compatibility.bundle.objects,counters:{implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0}});
  const checkedInitial=composeInitialImplementationEvidence(initial([nativeRound()]));
  assertBytesEqual(checkedInitial.bytes,initialOnly.bytes);
  const apply=applyCapture({base:compatibility}).cap;
  assert.throws(()=>composeInitialImplementationEvidence({...initial([apply]),owner:applyOwner()}),failure('INVALID_CURRENT_IMAGE'));
  assert.throws(()=>composeCurrentFindingsEvidence({imported:true}),failure('UNSUPPORTED_FORMAT'));
  const unknown=clone(apply);rebindRequest(unknown,item=>{item.format='stnl-current-findings-request-v9';});
  assert.throws(()=>compose(compatibility,[unknown]),failure('UNSUPPORTED_FORMAT','findings request format'));
  const beforeCwd=process.cwd(),beforeEnv=JSON.stringify(process.env);
  for (const family of ['stnl-slice-executor','stnl-slice-quality-manager']) {
    for (const name of names) {
      const source=await readFile(path.join(root,family,'runtime',name),'utf8');
      assert.doesNotMatch(source,/from ['"](?:node:fs|\.\.\/|.*agents\/codex\/)|process\.(?:cwd|env)\b/u);
    }
    const isolated=await mkdtemp(path.join(temp,'l24-isolated-'));
    try {
      for (const name of names) await copyFile(path.join(root,family,'runtime',name),path.join(isolated,name));
      const findings=await import(pathToFileURL(path.join(isolated,'findings-evidence-current.mjs')).href);
      const formal=await import(pathToFileURL(path.join(isolated,'validation-evidence-current.mjs')).href);
      const proof=await import(pathToFileURL(path.join(isolated,'execution-evidence-proof.mjs')).href);
      for(const helper of ['verifyCapturedInvocation','verifyWorkObservation','packCaptureSources','restoreCaptureSources',
        'closeEvidenceObjects','verifyAuxiliaryWork','findingsRoundCaptureSha256']) assert.equal(typeof proof[helper],'function');
      assert.deepEqual(Object.keys(findings).sort(),['composeCurrentFindingsEvidence','validateCurrentFindingsEvidence']);
      assert.deepEqual(Object.keys(formal).sort(),['composeCurrentValidationEvidence','validateCurrentValidationEvidence']);
      const f=native();const result=findings.composeCurrentFindingsEvidence({context:CONTEXT,authority:AUTHORITY,owner:f.owner,
        previous:{bundleBytes:f.base.bytes,counters:f.base.counters},rounds:[f.cap]});
      assert.equal(result.validation,'revalidation-required');
    } finally {await rm(isolated,{recursive:true,force:true});}
    const missing=await mkdtemp(path.join(temp,'l24-missing-'));
    try {
      for (const name of names.filter(item=>item!=='current-evidence-state.mjs'))
        await copyFile(path.join(root,family,'runtime',name),path.join(missing,name));
      await assert.rejects(()=>import(pathToFileURL(path.join(missing,'findings-evidence-current.mjs')).href),
        error=>error?.code==='ERR_MODULE_NOT_FOUND');
    } finally {await rm(missing,{recursive:true,force:true});}
  }
  assert.equal(process.cwd(),beforeCwd);assert.equal(JSON.stringify(process.env),beforeEnv);
});
