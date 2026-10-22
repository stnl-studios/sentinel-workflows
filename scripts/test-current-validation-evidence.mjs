import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {composeInitialImplementationEvidence,validateInitialImplementationEvidence} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs';
import {composeCurrentValidationEvidence,validateCurrentValidationEvidence} from '../skills/workflows/stnl-slice-executor/runtime/validation-evidence-current.mjs';
import {validateCurrentEvidence} from '../skills/workflows/stnl-slice-executor/runtime/execution-current.mjs';
import {AUTHORITY,CONTEXT,COMMAND,DELIVERY_PREIMAGE,manifest,nativeRound,initial,OWNER,RECIPE,RESOLVED,TARGET} from './fixtures/current-initial-evidence.mjs';
import {EXPECTED_FIRST_COUNTERS,EXPECTED_INITIAL_COUNTERS,INITIAL_SCOPE,ORACLE,validationOwner,
  finding,payload,request,capture,rebindRaw,filelessInitial,removedInitial,retainedRemovalInitial,FILENAME} from './fixtures/current-validation-evidence.mjs';

const clone=value=>structuredClone(value);
const digest=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const json=value=>Uint8Array.from(Buffer.from(JSON.stringify(value)+'\n'));
const parse=value=>JSON.parse(Buffer.from(value).toString('utf8'));
const code=(name,part)=>error=>error?.code===name && (!part || String(error.message).includes(part));
const initialBase=()=>composeInitialImplementationEvidence(initial([nativeRound()]));
function first(options={}) {
  const base=options.base??initialBase();
  const owner=options.owner??validationOwner(options.number??1);
  const asked=request({baseBytes:base.bytes,counters:base.counters,openFindings:base.bundle.openFindings,
    priorScopePaths:options.priorScopePaths??INITIAL_SCOPE,owner,scopePaths:options.scopePaths??INITIAL_SCOPE,
    filelessReason:options.filelessReason??null,authority:options.authority??AUTHORITY});
  const {cap,response}=capture({transport:options.transport??'native',request:asked,
    status:options.status??'PASS',newFindings:options.newFindings??[],
    findingReferences:options.findingReferences??'none',findingDispositions:options.findingDispositions??'none',
    exit:options.exit??0,work:options.work??manifest(1),resolved:options.resolved??RESOLVED,
    approvedAuthority:options.authority??AUTHORITY,command:options.command??COMMAND});
  return {base,owner,asked,cap,response,input:{context:clone(CONTEXT),authority:clone(options.authority??AUTHORITY),
    owner:clone(owner),previous:{bundleBytes:base.bytes,counters:base.counters},capture:cap}};
}
function next(prior,number,options={}) {
  return first({...options,base:prior,number,
    priorScopePaths:options.priorScopePaths??INITIAL_SCOPE});
}
function readback(result,work=manifest(1)) {
  return validateCurrentValidationEvidence({context:clone(CONTEXT),authority:clone(AUTHORITY),
    bundleBytes:result.bytes,counters:result.counters,observedWork:clone(work)});
}
function expectedFirstRecord() {
  return [
    '### attempt-01',
    `- Delivery ID: ${OWNER.deliveryId}`,
    '- Preparation revision: 1',
    '- Local revision: 1',
    `- Normative sha256: ${OWNER.normativeSha256}`,
    `- Operation attempt ID: ${validationOwner(1).operationAttemptId}`,
    `- Origin activation ID: ${OWNER.originActivationId}`,
    '- Type: initial',
    '- Status: PASS',
    '- HEAD: 0123456789abcdef',
    '- Verified scope: ../../../../src/pay.mjs',
    '- Commands:',
    '  - `node src/pay.mjs` | exit:0',
    '- Evidence: Direct recipe observation and file hash.',
    '- Finding references: none',
    '- Finding dispositions: none',
    '- Blockers: none',
    '- Unexpected workspace effects: none',
    '- Persistence summary: Current record retained.',
  ].join('\n');
}
function mutateBundle(result,change) {
  const bundle=clone(result.bundle);change(bundle);
  return {context:clone(CONTEXT),authority:clone(AUTHORITY),bundleBytes:json(bundle),
    counters:clone(result.counters),observedWork:manifest(1)};
}
function updateReceipt(cap,edit) {
  const receipt=parse(cap.receipt);edit(receipt);cap.receipt=json(receipt);
  if (cap.transport==='managed') {const latest=parse(cap.latest);latest.receipt=receipt;cap.latest=json(latest);}
}
function rebindRequest(cap,edit) {
  const asked=parse(cap.validationRequest);edit(asked);cap.validationRequest=json(asked);
  const response=parse(cap.rawResponse);response.requestSha256=digest(cap.validationRequest);
  rebindRaw(cap,response);
}
function schemaReject(cap,raw='{') {
  rebindRaw(cap,raw);
  updateReceipt(cap,receipt=>{
    receipt.status='RUNNER_RESULT_BLOCKED';receipt.semanticResponseStatus=null;receipt.testedState=null;
    receipt.verification=null;receipt.captureFailure='runner response schema invalid';
    if (cap.transport==='managed') {receipt.captureFailureCode='RUNNER_RESPONSE_SCHEMA_INVALID';receipt.exitCode=1;}
  });
  cap.verificationObservation=null;
  if (cap.transport==='managed') {const supervisor=parse(cap.closedSupervisor);supervisor.capturedReceipts=0;cap.closedSupervisor=json(supervisor);}
}
function assertRejected(input,cause) {
  const result=composeCurrentValidationEvidence(input);
  assert.equal(result.outcome,'rejected');
  assert.equal(result.consumedInvocations,1);
  assert.match(result.bundle.support.at(-1).diagnostic,cause);
  return result;
}

test('V01 primeira validação native PASS: request, record e bytes literais',()=>{
  const f=first();const result=composeCurrentValidationEvidence(f.input);
  assert.equal(result.outcome,'recorded');assert.equal(result.replayed,false);
  assert.equal(result.consumedInvocations,1);assert.equal(result.formalStatus,'PASS');assert.equal(result.validation,'current');
  assert.deepEqual(result.counters,EXPECTED_FIRST_COUNTERS);
  assert.equal(result.bundle.validation.id,'attempt-01');
  assert.equal(result.bundle.validation.recordUtf8,expectedFirstRecord());
  assert.equal(result.bundle.validation.contract.terminal,null);
  assert.equal(result.bundle.validation.origin.operation,'VALIDATE_SLICE');
  const authored=authoredNativeBundle(f.base,f.cap);
  assert.deepEqual(result.bundle,authored);
  assert.deepEqual(result.bytes,sealed(authored));
  assert.equal(f.asked.base.evidenceSha256,digest(f.base.bytes));
  assert.equal(f.response.requestSha256,digest(f.cap.validationRequest));
  assert.equal(result.sha256,digest(result.bytes));
  assert.deepEqual(readback(result).bytes,result.bytes);
  const noCarrier=clone(f.input);updateReceipt(noCarrier.capture,receipt=>{receipt.testedState=null;});
  assert.throws(()=>composeCurrentValidationEvidence(noCarrier),code('EVIDENCE_INCOMPLETE','testedState carrier'));
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:f.base.bytes,counters:f.base.counters,observedWork:manifest(1)}),code('INVALID_CURRENT_IMAGE','incorporation'));
});

test('V02 removed managed formal is refused; native fileless domain retains auxiliary authority',()=>{
 const managed=first({transport:'managed'}),before=clone(managed.input);assert.throws(()=>composeCurrentValidationEvidence(managed.input),code('UNSUPPORTED_FORMAT'));assert.deepEqual(managed.input,before);
 const nativeNoCarrier=first();updateReceipt(nativeNoCarrier.cap,receipt=>{receipt.testedState=null;});assert.throws(()=>composeCurrentValidationEvidence(nativeNoCarrier.input),code('EVIDENCE_INCOMPLETE','testedState carrier'));
  const fileless=filelessInitial();const initInput=initial([fileless.cap]);initInput.authority=fileless.authority;
  const base=composeInitialImplementationEvidence(initInput);
  const f=first({base,authority:fileless.authority,scopePaths:[],priorScopePaths:[],
    filelessReason:'No product output; input-only task state verified.',work:fileless.work,resolved:parse(fileless.cap.origin).verification,
    command:'node config/settings.json'});
  const result=composeCurrentValidationEvidence(f.input);
  assert.equal(result.validation,'current');assert.match(result.bundle.validation.recordUtf8,/Verified scope: fileless task state/u);
  const blank=clone(f.input);rebindRequest(blank.capture,asked=>{asked.scope.filelessReason='none';});
  assert.throws(()=>composeCurrentValidationEvidence(blank),code('INVALID_CURRENT_IMAGE','placeholder'));
});

test('V03 NEEDS_FIX deriva dois findings do raw concluído',()=>{
  const items=[finding(1,1),finding(2,1,'advisory')];
  const f=first({status:'NEEDS_FIX',newFindings:items,findingReferences:'finding-01, finding-02',
    findingDispositions:'finding-01=active, finding-02=active'});
  const result=composeCurrentValidationEvidence(f.input);
  assert.deepEqual(result.bundle.openFindings,items);
  assert.deepEqual(result.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:2});
  assert.equal(result.validation,'revalidation-required');
  const index=mutateBundle(result,bundle=>{bundle.openFindings[0].problem='fabricated index detail';});
  assert.throws(()=>validateCurrentValidationEvidence(index),code('INVALID_CURRENT_IMAGE','openFindings'));
  const bad=clone(f.input);const raw=parse(bad.capture.rawResponse);raw.newFindings[0].problem='none';rebindRaw(bad.capture,raw);
  assertRejected(bad,/response\.newFindings\[0\]\.problem: placeholder/u);
  const coherent=clone(f.cap);const changedRaw=parse(coherent.rawResponse);
  changedRaw.newFindings[0].problem='Finding 01 has a different observed problem.';
  rebindRaw(coherent,changedRaw);
  const incompatible=resealNativeRecord(result.bundle,coherent);
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(incompatible),counters:result.counters,observedWork:manifest(1)}),
    code('INVALID_CURRENT_IMAGE','openFindings index'));
  const avulso=clone(f.input);avulso.newFindings=[finding(3,1)];
  assert.throws(()=>composeCurrentValidationEvidence(avulso),code('INVALID_CURRENT_IMAGE','fields differ'));
});

test('V04 revalidação dispõe parcialmente e preserva origens',()=>{
  const start=first({status:'NEEDS_FIX',newFindings:[finding(1,1),finding(2,1,'advisory')],
    findingReferences:'finding-01, finding-02',findingDispositions:'finding-01=active, finding-02=active'});
  const base=composeCurrentValidationEvidence(start.input);
  const later=next(base,2,{status:'NEEDS_FIX',newFindings:[finding(3,2)],
    findingReferences:'finding-01, finding-02, finding-03',
    findingDispositions:'finding-01=resolved, finding-02=active, finding-03=active'});
  const result=composeCurrentValidationEvidence(later.input);
  assert.deepEqual(result.bundle.openFindings.map(item=>item.id),['finding-02','finding-03']);
  assert.deepEqual(result.bundle.support.filter(item=>item.kind==='validation').map(item=>item.id),['attempt-01']);
  assert.deepEqual(result.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:2,findings:3});
  const omitted=clone(later.input);rebindRequest(omitted.capture,asked=>{asked.base.openFindings.pop();});
  assert.throws(()=>composeCurrentValidationEvidence(omitted),code('INVALID_CURRENT_IMAGE','base openFindings'));
  for (const value of ['finding-01=resolved, finding-02=active, finding-03=active, finding-04=resolved',
    'finding-01=superseded, finding-02=active, finding-03=active']) {
    const bad=clone(later.input);const raw=parse(bad.capture.rawResponse);raw.result.findingDispositions=value;rebindRaw(bad.capture,raw);
    assertRejected(bad,value.includes('superseded') ? /finding dispositions: invalid disposition/u : /finding dispositions: binding differs/u);
  }
  const altered=clone(later.input);rebindRequest(altered.capture,asked=>{
    asked.base.openFindings[0].problem='Edited historical detail';
  });
  assert.throws(()=>composeCurrentValidationEvidence(altered),code('INVALID_CURRENT_IMAGE','base openFindings'));
  const fabricatedOrigin=clone(start.cap);const originRaw=parse(fabricatedOrigin.rawResponse);
  originRaw.result.status='PASS';rebindRaw(fabricatedOrigin,originRaw);
  updateReceipt(fabricatedOrigin,receipt=>{receipt.semanticResponseStatus='PASS';});
  const falseOrigin=resealNativeRecord(result.bundle,fabricatedOrigin,result.bundle.support[0]);
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(falseOrigin),counters:result.counters,observedWork:manifest(1)}),
    code('INVALID_CURRENT_IMAGE','retained formal record is rejected'));
});

test('V05 PASS, NEEDS_FIX e BLOCKED impõem disposição formal',()=>{
  const advisory=first({status:'NEEDS_FIX',newFindings:[finding(1,1),finding(2,1,'advisory')],
    findingReferences:'finding-01, finding-02',findingDispositions:'finding-01=active, finding-02=active'});
  const base=composeCurrentValidationEvidence(advisory.input);
  const pass=next(base,2,{status:'PASS',findingReferences:'finding-01, finding-02',
    findingDispositions:'finding-01=resolved, finding-02=active'});
  assert.equal(composeCurrentValidationEvidence(pass.input).formalStatus,'PASS');
  for (const [status,dispositions] of [['PASS','finding-01=active, finding-02=active'],
    ['NEEDS_FIX','finding-01=resolved, finding-02=active'],['BLOCKED','finding-01=resolved, finding-02=active']]) {
    const negative=next(base,2,{status,findingReferences:'finding-01, finding-02',findingDispositions:dispositions});
    assertRejected(negative.input,status==='PASS' ? /PASS retains blocking finding/u
      : status==='NEEDS_FIX' ? /NEEDS_FIX requires active blocker/u : /BLOCKED cannot create\/resolve findings/u);
  }
  const blocked=next(base,2,{status:'BLOCKED',findingReferences:'finding-01, finding-02',
    findingDispositions:'finding-01=active, finding-02=active'});
  assert.equal(composeCurrentValidationEvidence(blocked.input).formalStatus,'BLOCKED');
  const invented=first({status:'BLOCKED',newFindings:[finding(1,1)],
    findingReferences:'finding-01',findingDispositions:'finding-01=active'});
  assertRejected(invented.input,/new findings require NEEDS_FIX/u);
  for (const [status,key,value,reason] of [
    ['BLOCKED','blockers','none',/Blockers: placeholder/u],
    ['PASS','unexpectedWorkspaceEffects','pending',/Unexpected workspace effects: missing persisted value/u],
    ['PASS','persistenceSummary','n/a',/Persistence summary: missing persisted value/u],
  ]) {
    const fixture=first({status});const raw=parse(fixture.cap.rawResponse);raw.result[key]=value;
    rebindRaw(fixture.cap,raw);assertRejected(fixture.input,reason);
  }
});

test('V06 drift passivo exige nova captura estável',()=>{
  const passed=composeCurrentValidationEvidence(first().input);
  const variants=[
    work=>{work.entries.at(-1).sha256=digest(Buffer.from('different product'));},
    work=>{work.entries[1].sha256=digest(Buffer.from('different input'));},
    work=>{work.entries.at(-1).mode=493;},
    work=>{work.entries[2].children=['ignored.txt','pay.mjs'];work.entries.splice(3,0,{path:'src/ignored.txt',kind:'file',sha256:digest(Buffer.from('ignored')),mode:420});},
  ];
  for (const edit of variants) {const work=manifest(1);edit(work);assert.equal(readback(passed,work).validation,'revalidation-required');}
  const drift=manifest(2);const refreshed=next(passed,2,{work:drift,status:'PASS'});
  assert.equal(composeCurrentValidationEvidence(refreshed.input).validation,'current');
  const staleCapture=clone(refreshed.input);const observation=parse(staleCapture.capture.verificationObservation);
  observation.after=manifest(1);staleCapture.capture.verificationObservation=json(observation);
  updateReceipt(staleCapture.capture,receipt=>{receipt.verification=observation;});
  assert.throws(()=>composeCurrentValidationEvidence(staleCapture),code('EVIDENCE_STALE','product changed'));
});

test('V07 domínio, inputs e ausência não fabricam remoção',()=>{
  const retained=retainedRemovalInitial();
  const retainedBase=composeInitialImplementationEvidence(initial(retained.rounds));
  assert.deepEqual(parse(retained.rounds[1].receipt).testedState.entries.map(item=>item.path),['../../../../src/pay.mjs']);
  const omittedRemoval=first({base:retainedBase,work:retained.omittedWork,scopePaths:INITIAL_SCOPE});
  assert.throws(()=>composeCurrentValidationEvidence(omittedRemoval.input),code('EVIDENCE_INCOMPLETE','retained removal member omitted src/old.mjs'));
  const coveredRemoval=first({base:retainedBase,work:retained.work,
    scopePaths:['src/old.mjs','src/pay.mjs']});
  updateReceipt(coveredRemoval.cap,receipt=>{receipt.testedState.entries.unshift({path:'../../../../src/old.mjs',value:'REMOVED'});});
  const coveredResult=composeCurrentValidationEvidence(coveredRemoval.input);
  assert.equal(coveredResult.formalStatus,'PASS');
  for (const [state,expectedScope] of [
    ['file',['src/old.mjs','src/pay.mjs']],
    ['directory',['src/old.mjs/nested.mjs','src/pay.mjs']],
  ]) {
    const rebuilt=retainedRemovalInitial(state);
    const rebuiltBase=composeInitialImplementationEvidence(initial(rebuilt.rounds));
    const fixture=first({base:rebuiltBase,work:rebuilt.work,
      priorScopePaths:expectedScope,scopePaths:expectedScope});
    const accepted=composeCurrentValidationEvidence(fixture.input);
    assert.equal(accepted.formalStatus,'PASS',state);
    assert.deepEqual(parse(fixture.cap.validationRequest).scope.paths,expectedScope,state);
    assert.equal(parse(fixture.cap.receipt).testedState.entries.some(item=>item.value==='REMOVED'),false,state);
    if (state==='directory') {
      const inventedDirectoryOutput=clone(fixture.input);
      rebindRequest(inventedDirectoryOutput.capture,asked=>{
        asked.scope.paths=['src/old.mjs',...expectedScope];
      });
      assert.throws(()=>composeCurrentValidationEvidence(inventedDirectoryOutput),
        code('EVIDENCE_STALE','derived validation scope'));
    }
  }
  const rebuiltDirectory=retainedRemovalInitial('directory');
  const directoryAfterRemoval=next(coveredResult,2,{work:rebuiltDirectory.work,
    priorScopePaths:['src/old.mjs','src/pay.mjs'],
    scopePaths:['src/old.mjs/nested.mjs','src/pay.mjs']});
  assert.equal(composeCurrentValidationEvidence(directoryAfterRemoval.input).formalStatus,'PASS');
  const removed=removedInitial();
  const removedBase=composeInitialImplementationEvidence(initial([removed.cap]));
  const removedFixture=first({base:removedBase,work:removed.work,status:'PASS'});
  updateReceipt(removedFixture.cap,receipt=>{receipt.testedState.entries=[{path:'../../../../src/pay.mjs',value:'REMOVED'}];});
  assert.equal(composeCurrentValidationEvidence(removedFixture.input).formalStatus,'PASS');
  const base=composeCurrentValidationEvidence(first().input);
  const absent=manifest(1);absent.entries[2].children=[];absent.entries[3]={path:'src/pay.mjs',kind:'absent'};
  const asked=next(base,2,{work:absent,status:'NEEDS_FIX',scopePaths:INITIAL_SCOPE,
    findingReferences:'finding-01',findingDispositions:'finding-01=active',newFindings:[finding(1,2)]});
  const needs=composeCurrentValidationEvidence(asked.input);
  assert.equal(needs.formalStatus,'NEEDS_FIX');
  const falseRemoved=clone(asked.input);updateReceipt(falseRemoved.capture,receipt=>{
    receipt.testedState.entries=[{path:'../../../../src/pay.mjs',value:'REMOVED'}];});
  assert.throws(()=>composeCurrentValidationEvidence(falseRemoved),code('EVIDENCE_INCOMPLETE','prior bytes'));
  const missing=clone(asked.input);const observation=parse(missing.capture.verificationObservation);
  observation.after.entries=observation.after.entries.filter(item=>item.path!=='src/pay.mjs');
  missing.capture.verificationObservation=json(observation);updateReceipt(missing.capture,receipt=>{receipt.verification=observation;});
  assert.throws(()=>composeCurrentValidationEvidence(missing),code('EVIDENCE_STALE','product changed'));
  const badInput=clone(asked.input);const obs=parse(badInput.capture.verificationObservation);
  for (const snapshot of [obs.before,obs.after]) {snapshot.entries[1]={path:'config/settings.json',kind:'absent'};snapshot.entries[0].children=[];}
  const baseline=parse(badInput.capture.baselineCapture);baseline.manifest=clone(obs.before);
  badInput.capture.baselineCapture=json(baseline);
  badInput.capture.verificationObservation=json(obs);updateReceipt(badInput.capture,receipt=>{receipt.verification=obs;});
  assert.throws(()=>composeCurrentValidationEvidence(badInput),code('EVIDENCE_STALE','Existing Input'));
  const ignoredWork=manifest(1);
  ignoredWork.entries[2].children=['ignored.txt','pay.mjs'];
  ignoredWork.entries.splice(3,0,{path:'src/ignored.txt',kind:'file',sha256:digest(Buffer.from('ignored\n')),mode:420});
  const omittedIgnored=first({work:ignoredWork,scopePaths:INITIAL_SCOPE});
  assert.throws(()=>composeCurrentValidationEvidence(omittedIgnored.input),code('EVIDENCE_STALE','derived validation scope'));
  const coveredIgnored=first({work:ignoredWork,scopePaths:['src/ignored.txt','src/pay.mjs']});
  const priorWithIgnored=composeCurrentValidationEvidence(coveredIgnored.input);
  const omittedPrior=next(priorWithIgnored,2,{priorScopePaths:['src/ignored.txt','src/pay.mjs'],scopePaths:INITIAL_SCOPE});
  assert.throws(()=>composeCurrentValidationEvidence(omittedPrior.input),code('EVIDENCE_INCOMPLETE','prior scope member omitted src/ignored.txt'));
  const missingChild=clone(omittedIgnored.input);
  const childBaseline=parse(missingChild.capture.baselineCapture);
  const childObserved=parse(missingChild.capture.verificationObservation);
  for (const work of [childBaseline.manifest,childObserved.before,childObserved.after]) {
    work.entries=work.entries.filter(item=>item.path!=='src/ignored.txt');
  }
  missingChild.capture.baselineCapture=json(childBaseline);missingChild.capture.verificationObservation=json(childObserved);
  updateReceipt(missingChild.capture,receipt=>{receipt.verification=childObserved;});
  assert.throws(()=>composeCurrentValidationEvidence(missingChild),code('EVIDENCE_INCOMPLETE','missing present child'));
  const missingInput=clone(asked.input);
  const inputBaseline=parse(missingInput.capture.baselineCapture);
  const inputObserved=parse(missingInput.capture.verificationObservation);
  for (const work of [inputBaseline.manifest,inputObserved.before,inputObserved.after]) {
    work.entries=work.entries.filter(item=>item.path!=='config/settings.json');work.entries[0].children=[];
  }
  missingInput.capture.baselineCapture=json(inputBaseline);missingInput.capture.verificationObservation=json(inputObserved);
  updateReceipt(missingInput.capture,receipt=>{receipt.verification=inputObserved;});
  assert.throws(()=>composeCurrentValidationEvidence(missingInput),code('EVIDENCE_INCOMPLETE','missing declared config/settings.json'));
  const inputDirectory=clone(asked.input);
  const dirBaseline=parse(inputDirectory.capture.baselineCapture);
  const dirObserved=parse(inputDirectory.capture.verificationObservation);
  for (const work of [dirBaseline.manifest,dirObserved.before,dirObserved.after]) work.entries[1]={path:'config/settings.json',kind:'directory',children:[]};
  inputDirectory.capture.baselineCapture=json(dirBaseline);inputDirectory.capture.verificationObservation=json(dirObserved);
  updateReceipt(inputDirectory.capture,receipt=>{receipt.verification=dirObserved;});
  assert.throws(()=>composeCurrentValidationEvidence(inputDirectory),code('EVIDENCE_STALE','Existing Input'));
});

test('V08 poda de trinta formais mantém somente demanda corrente',()=>{
  const firstA=first({status:'NEEDS_FIX',newFindings:[finding(1,1)],
    findingReferences:'finding-01',findingDispositions:'finding-01=active'});
  const createdA=composeCurrentValidationEvidence(firstA.input);
  const secondB=next(createdA,2,{status:'NEEDS_FIX',newFindings:[finding(2,2)],
    findingReferences:'finding-01, finding-02',findingDispositions:'finding-01=resolved, finding-02=active'});
  const createdB=composeCurrentValidationEvidence(secondB.input);
  const thirdB=next(createdB,3,{status:'BLOCKED',findingReferences:'finding-02',
    findingDispositions:'finding-02=active'});
  const activeB=composeCurrentValidationEvidence(thirdB.input);
  assert.deepEqual(activeB.bundle.support.map(item=>item.id),['attempt-02']);
  assert.deepEqual(activeB.bundle.openFindings,[finding(2,2)]);
  assert.match(activeB.bundle.support[0].recordUtf8,/finding-01=resolved/u);
  assert.equal(readback(activeB).validation,'revalidation-required');
  const retainedB=new Map(firstA.base.bundle.objects.map(item=>[item.id,item]));
  oracleNativeSources(secondB.cap,retainedB);oracleNativeSources(thirdB.cap,retainedB);
  assert.deepEqual(activeB.bundle.objects,[...retainedB.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
  assert.equal(activeB.bundle.objects.some(item=>item.id===digest(firstA.cap.rawResponse)),false);
  const original=first({status:'NEEDS_FIX',newFindings:[finding(1,1),finding(2,1,'advisory')],
    findingReferences:'finding-01, finding-02',findingDispositions:'finding-01=active, finding-02=active'});
  const firstResult=composeCurrentValidationEvidence(original.input);
  const intermediate=next(firstResult,2,{status:'NEEDS_FIX',
    findingReferences:'finding-01, finding-02',findingDispositions:'finding-01=active, finding-02=resolved'});
  let current=composeCurrentValidationEvidence(intermediate.input);
  let lastCapture;
  for (let n=3;n<=30;n+=1) {
    const fixture=next(current,n,{status:'BLOCKED',findingReferences:'finding-01',
      findingDispositions:'finding-01=active'});
    lastCapture=fixture.cap;
    current=composeCurrentValidationEvidence(fixture.input);
    assert.deepEqual(current.bundle.support.filter(item=>item.kind==='validation').map(item=>item.id),['attempt-01'],`attempt ${n}`);
    assert.equal(current.bundle.validation.id,`attempt-${String(n).padStart(2,'0')}`);
  }
  assert.deepEqual(current.bundle.openFindings,[finding(1,1)]);
  assert.equal(current.counters.validationAttempts,30);
  assert.equal(current.counters.findings,2);
  const objectMap=new Map(original.base.bundle.objects.map(item=>[item.id,item]));
  oracleNativeSources(original.cap,objectMap);
  oracleNativeSources(lastCapture,objectMap);
  assert.deepEqual(current.bundle.objects,[...objectMap.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0));
  assert.equal(current.bundle.objects.some(item=>item.id===digest(intermediate.cap.rawResponse)),false);
  const resolved=composeCurrentValidationEvidence(next(current,31,{status:'PASS',
    findingReferences:'finding-01',findingDispositions:'finding-01=resolved'}).input);
  assert.deepEqual(resolved.bundle.support.filter(item=>item.kind==='validation').map(item=>item.id),['attempt-01']);
  const last=composeCurrentValidationEvidence(next(resolved,32).input);
  assert.deepEqual(last.bundle.support,[]);
  assert.deepEqual(last.bundle.openFindings,[]);
  assert.equal(last.bundle.validation.id,'attempt-32');
  assert.equal(last.counters.validationAttempts,32);
  assert.equal(last.counters.findings,2);
  assert.ok(last.bundle.objects.length<resolved.bundle.objects.length);
  assert.equal(readback(last).validation,'current');
  const missing=mutateBundle(current,bundle=>{bundle.support=[];bundle.objects=bundle.objects.filter(item=>{
    const refs=new Set();
    for (const record of [...bundle.implementation,bundle.validation]) for (const [key,value] of Object.entries(record.sources)) {
      if (key==='transport' || value===null) continue;
      if (Array.isArray(value)) value.forEach(id=>refs.add(id)); else refs.add(value);
    }
    return refs.has(item.id);
  });});
  assert.throws(()=>validateCurrentValidationEvidence(missing),code('EVIDENCE_INCOMPLETE','finding origin is absent'));
});

test('V09 replay usa só última incorporação e mesmos bytes',()=>{
  const f=first();const once=composeCurrentValidationEvidence(f.input);
  const replay=clone(f.input);replay.previous={bundleBytes:once.bytes,counters:once.counters};
  const twice=composeCurrentValidationEvidence(replay);
  assert.equal(twice.replayed,true);assert.equal(twice.consumedInvocations,1);
  assert.deepEqual(twice.bytes,once.bytes);assert.deepEqual(twice.counters,once.counters);
  const changed=clone(replay);const raw=parse(changed.capture.rawResponse);
  raw.result.evidence='Different claim under same owner.';rebindRaw(changed.capture,raw);
  assert.throws(()=>composeCurrentValidationEvidence(changed),code('OWNER_MISMATCH','different captured sources'));
  const firstBad=first({status:'NEEDS_FIX',newFindings:[finding(1,1)],
    findingReferences:'finding-01',findingDispositions:'finding-01=active'});
  const a=composeCurrentValidationEvidence(firstBad.input);
  const b=composeCurrentValidationEvidence(next(a,2,{status:'BLOCKED',findingReferences:'finding-01',
    findingDispositions:'finding-01=active'}).input);
  const old=clone(firstBad.input);old.previous={bundleBytes:b.bytes,counters:b.counters};
  assert.throws(()=>composeCurrentValidationEvidence(old),code('STALE_BASE'));
  const third=composeCurrentValidationEvidence(next(b,3,{status:'BLOCKED',findingReferences:'finding-01',
    findingDispositions:'finding-01=active'}).input);
  const retainedReplay=clone(firstBad.input);retainedReplay.previous={bundleBytes:third.bytes,counters:third.counters};
  assert.throws(()=>composeCurrentValidationEvidence(retainedReplay),code('STALE_BASE'));
  const prunedFirst=first();const prunedOne=composeCurrentValidationEvidence(prunedFirst.input);
  const prunedTwo=composeCurrentValidationEvidence(next(prunedOne,2).input);
  const prunedThree=composeCurrentValidationEvidence(next(prunedTwo,3).input);
  assert.deepEqual(prunedThree.bundle.support,[]);
  const prunedReplay=clone(prunedFirst.input);
  prunedReplay.previous={bundleBytes:prunedThree.bytes,counters:prunedThree.counters};
  assert.throws(()=>composeCurrentValidationEvidence(prunedReplay),code('STALE_BASE'));
  const second=next(once,2);const applied=composeCurrentValidationEvidence(second.input);
  assert.equal(applied.bundle.validation.id,'attempt-02');
  assert.deepEqual(parse(f.cap.rawResponse).result,parse(second.cap.rawResponse).result);
  assert.notEqual(digest(f.cap.validationRequest),digest(second.cap.validationRequest));
  const differentRequestBytes=clone(second.input);
  differentRequestBytes.capture.validationRequest=Uint8Array.from(Buffer.from(JSON.stringify(parse(second.cap.validationRequest),null,2)+'\n'));
  assert.throws(()=>composeCurrentValidationEvidence(differentRequestBytes),code('EVIDENCE_STALE','requestSha256'));
  const stale=clone(second.input);stale.capture.validationRequest=f.cap.validationRequest;
  assert.throws(()=>composeCurrentValidationEvidence(stale),error=>['STALE_BASE','OWNER_MISMATCH'].includes(error?.code));
});

test('V10 recusa concluída preserva raw sem criar attempt',()=>{
  for (const transport of ['native']) {
    const f=first({transport});schemaReject(f.cap,'{ malformed');
    const result=composeCurrentValidationEvidence(f.input);
    assert.equal(result.outcome,'rejected',transport);assert.equal(result.validation,'uncertain');
    assert.equal(result.bundle.validation,null);assert.equal(result.bundle.support.length,1);
    assert.deepEqual(result.counters,EXPECTED_INITIAL_COUNTERS);
    const objects=new Map(result.bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')]));
    assert.equal(objects.get(result.bundle.support[0].sources.rawResponse).toString('utf8'),'{ malformed');
    const again=clone(f.input);again.previous={bundleBytes:result.bytes,counters:result.counters};
    assert.deepEqual(composeCurrentValidationEvidence(again).bytes,result.bytes);
    const foreign=clone(f.input);updateReceipt(foreign.capture,receipt=>{receipt.owner.operationAttemptId=validationOwner(99).operationAttemptId;});
    assert.throws(()=>composeCurrentValidationEvidence(foreign),code('OWNER_MISMATCH'));
  }
  const semantic=first();const response=parse(semantic.cap.rawResponse);response.newFindings=[{...finding(1,1),problem:'none'}];
  rebindRaw(semantic.cap,response);
  const semanticResult=assertRejected(semantic.input,/response\.newFindings\[0\]\.problem: placeholder/u);
  const semanticObjects=new Map(semanticResult.bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')]));
  const semanticSupport=semanticResult.bundle.support.at(-1);
  assert.deepEqual(semanticObjects.get(semanticSupport.sources.verificationObservation),Buffer.from(semantic.cap.verificationObservation));
  const verdict=first({status:'PASS',exit:1});
  assertRejected(verdict.input,/RUNNER_VERDICT_EVIDENCE_CONFLICT/u);
  const oldPayload=first();schemaReject(oldPayload.cap,JSON.stringify(payload()));
  assertRejected(oldPayload.input,/validation response: fields differ/u);
  const pending=first({transport:'managed'});const supervisor=parse(pending.cap.closedSupervisor);supervisor.pending=true;pending.cap.closedSupervisor=json(supervisor);
  assert.throws(()=>composeCurrentValidationEvidence(pending.input),code('UNSUPPORTED_FORMAT'));
  const unfinished=first({transport:'managed'});
  const lines=Buffer.from(unfinished.cap.events).toString('utf8').trimEnd().split('\n');
  unfinished.cap.events=Uint8Array.from(Buffer.from(lines.slice(0,-1).join('\n')+'\n'));
  assert.throws(()=>composeCurrentValidationEvidence(unfinished.input),code('UNSUPPORTED_FORMAT'));
  const incompleteManaged=first({transport:'managed'});incompleteManaged.cap.verificationObservation=null;
  assert.throws(()=>composeCurrentValidationEvidence(incompleteManaged.input),code('UNSUPPORTED_FORMAT'));
  const good=composeCurrentValidationEvidence(first().input);
  const refusal=next(good,2);schemaReject(refusal.cap,'{ malformed');
  const after=composeCurrentValidationEvidence(refusal.input);
  assert.equal(after.bundle.validation.id,'attempt-01');
  assert.equal(after.bundle.support.at(-1).kind,'rejection');
  assert.deepEqual(after.counters,good.counters);
  const following=next(after,3);
  assert.throws(()=>composeCurrentValidationEvidence(following.input),code('RUNNER_RESULT_REJECTED'));
});

test('V11 guards fechados, versões e counters canônicos',()=>{
  const f=first();const valid=composeCurrentValidationEvidence(f.input);
  assert.equal(parse(f.cap.validationRequest).format,'stnl-current-validation-request-v1');
  assert.equal(valid.formalStatus,'PASS');
  for (const [label,edit,expected] of [
    ['negative zero',input=>{input.previous.counters.findings=-0;},'INVALID_CURRENT_IMAGE'],
    ['float',input=>{input.previous.counters.findings=1.5;},'INVALID_CURRENT_IMAGE'],
    ['overflow',input=>{input.previous.counters.findings=Number.MAX_SAFE_INTEGER+1;},'INVALID_CURRENT_IMAGE'],
    ['stale counter',input=>{input.previous.counters.validationAttempts=1;},'INVALID_CURRENT_IMAGE'],
    ['authority',input=>{input.authority.context.objective='Other objective';},'EVIDENCE_STALE'],
    ['imported',input=>{input.imported=true;},'UNSUPPORTED_FORMAT'],
  ]) {
    const input=clone(f.input);edit(input);
    assert.throws(()=>composeCurrentValidationEvidence(input),error=>error?.code===expected,label);
  }
  let calls=0;const getter=clone(f.input);
  Object.defineProperty(getter.capture,'receipt',{enumerable:true,get(){calls+=1;return f.cap.receipt;}});
  assert.throws(()=>composeCurrentValidationEvidence(getter),code('INVALID_CURRENT_IMAGE','non-data'));
  assert.equal(calls,0);
  const symbol=clone(f.input);symbol[Symbol('hidden')]=1;
  assert.throws(()=>composeCurrentValidationEvidence(symbol),code('INVALID_CURRENT_IMAGE','non-data'));
  const exotic=clone(f.input);exotic.capture.removalProofs.extra='hidden';
  assert.throws(()=>composeCurrentValidationEvidence(exotic),code('INVALID_CURRENT_IMAGE','dense array'));
  for (const [label,edit,expected] of [
    ['ID 00',req=>{req.attemptId='attempt-00';},'INVALID_CURRENT_IMAGE'],
    ['ID 001',req=>{req.attemptId='attempt-001';},'INVALID_CURRENT_IMAGE'],
    ['old envelope',req=>{req.format='stnl-current-validation-request-v0';},'UNSUPPORTED_FORMAT'],
    ['future envelope',req=>{req.format='stnl-current-validation-request-v3';},'UNSUPPORTED_FORMAT'],
    ['object envelope',req=>{req.format={includes:'stnl-current-validation-request-v0'};},'INVALID_CURRENT_IMAGE'],
  ]) {
    const input=clone(f.input);const req=parse(input.capture.validationRequest);edit(req);input.capture.validationRequest=json(req);
    if(label==='future envelope') {
      rebindRequest(input.capture,()=>{});
      assert.equal(parse(input.capture.rawResponse).requestSha256,digest(input.capture.validationRequest));
      assert.equal(parse(input.capture.receipt).semanticResponseSha256,digest(input.capture.rawResponse).slice(7));
      assert.equal(parse(input.capture.concludedToolResult).finalResponse,Buffer.from(input.capture.rawResponse).toString('utf8'));
    }
    assert.throws(()=>composeCurrentValidationEvidence(input),code(expected),label);
  }
  for (const [label,edit,part,expectedCode='INVALID_CURRENT_IMAGE'] of [
    ['terminal',bundle=>{bundle.validation.contract.terminal={...clone(AUTHORITY.context),deliveries:[{...clone(AUTHORITY.delivery),obligations:AUTHORITY.delivery.obligations.map(item=>({...clone(item),fullOwner:OWNER.deliveryId}))}]};},'formal record','EVIDENCE_STALE'],
    ['findingsChecks',bundle=>{bundle.findingsChecks=[{...clone(bundle.validation),kind:'findings-check',id:'findings-check-01'}];},'unsupported records'],
    ['divergences',bundle=>{bundle.openDivergences=[{id:'divergence-01',severity:'blocking',problem:'x',evidence:'x',requiredAuthorityOperation:'REPLAN'}];},'unsupported records'],
  ]) {
    const input=mutateBundle(valid,edit);
    assert.throws(()=>validateCurrentValidationEvidence(input),error=>{assert.equal(error.code,expectedCode,label+': '+error.message);assert.ok(error.message.includes(part),label+': '+error.message);return true;},label);
  }
  const first99=Array.from({length:98},(_,index)=>finding(index+1,1));
  const firstIds=first99.map(item=>item.id).join(', ');
  const high=first({status:'NEEDS_FIX',newFindings:first99,
    findingReferences:firstIds,findingDispositions:first99.map(item=>`${item.id}=active`).join(', ')});
  const highResult=composeCurrentValidationEvidence(high.input);
  assert.equal(highResult.counters.findings,98);
  const lastTwo=[finding(100,2),finding(99,2)];
  const all=[...first99,...lastTwo].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const hundred=next(highResult,2,{status:'NEEDS_FIX',newFindings:lastTwo,
    findingReferences:all.map(item=>item.id).join(', '),
    findingDispositions:all.map(item=>`${item.id}=active`).join(', ')});
  const hundredResult=composeCurrentValidationEvidence(hundred.input);
  assert.equal(hundredResult.counters.findings,100);
  assert.deepEqual(hundredResult.bundle.openFindings.map(item=>item.id),all.map(item=>item.id));
  const unordered=clone(hundred.input);const raw=parse(unordered.capture.rawResponse);
  raw.newFindings.reverse();rebindRaw(unordered.capture,raw);
  assertRejected(unordered,/newFindings: noncanonical order/u);
});

const canonical=value=>{
  if (value===null || typeof value==='boolean') return String(value);
  if (typeof value==='string') return JSON.stringify(value);
  if (typeof value==='number') return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key=>`${canonical(key)}:${canonical(value[key])}`).join(',')}}`;
};
const sealed=value=>Uint8Array.from(Buffer.from(canonical(value)+'\n'));
function oracleNativeSources(cap,objects) {
  const add=bytes=>{const id=digest(bytes);objects.set(id,{id,bytesBase64:Buffer.from(bytes).toString('base64')});return id;};
  const originCapsule={format:'stnl-native-validation-origin-bundle-v1',originUtf8:Buffer.from(cap.origin).toString('utf8'),
    dispatchUtf8:Buffer.from(cap.dispatch).toString('utf8'),baselineUtf8:Buffer.from(cap.baselineCapture).toString('utf8'),
    validationRequestUtf8:Buffer.from(cap.validationRequest).toString('utf8')};
  const agentCapsule={format:'stnl-native-agent-bundle-v1',agentUtf8:Buffer.from(cap.agentBinding).toString('utf8'),
    claimUtf8:Buffer.from(cap.agentClaim).toString('utf8')};
  return {transport:'native',rawResponse:add(cap.rawResponse),receipt:add(cap.receipt),
    verificationObservation:cap.verificationObservation===null?null:add(cap.verificationObservation),
    removalProofs:[],legacyPreparation:null,origin:add(sealed(originCapsule)),agentBinding:add(sealed(agentCapsule)),
    concludedToolResult:add(cap.concludedToolResult)};
}
function retainedObjects(bundle,objects) {
  const refs=new Set();
  for (const record of [...bundle.implementation,...bundle.support,...(bundle.validation?[bundle.validation]:[])]) {
    for (const [key,value] of Object.entries(record.sources)) {
      if (key==='transport' || value===null) continue;
      if (Array.isArray(value)) value.forEach(id=>refs.add(id)); else refs.add(value);
    }
  }
  return [...refs].sort().map(id=>objects.get(id));
}
function resealNativeRecord(bundle,cap,record=bundle.validation) {
  const amended=clone(bundle);
  const selected=record===bundle.validation ? amended.validation : amended.support.find(item=>item.id===record.id);
  const objects=new Map(amended.objects.map(item=>[item.id,item]));
  selected.sources=oracleNativeSources(cap,objects);
  amended.objects=retainedObjects(amended,objects);
  return amended;
}
function authoredNativeBundle(base,cap,recordText=expectedFirstRecord()) {
  const objects=new Map(base.bundle.objects.map(item=>[item.id,item]));
  const sources=oracleNativeSources(cap,objects);
  const owner=parse(cap.validationRequest).owner;
  const nativeOrigin=parse(cap.origin);const agent=parse(cap.agentBinding);
  const origin={operationAttemptId:owner.operationAttemptId,deliveryId:owner.deliveryId,slice:owner.slice,
    operation:'VALIDATE_SLICE',preparationRevision:1,localRevision:1,normativeSha256:owner.normativeSha256,
    originActivationId:owner.originActivationId,transport:'native',dispatchId:nativeOrigin.dispatchId,runnerId:agent.agentId};
  const record={kind:'validation',recordFormat:'stnl-task-record-v2',id:'attempt-01',origin,
    contract:{delivery:clone(AUTHORITY.delivery),context:clone(AUTHORITY.context),terminal:null,recipe:clone(RECIPE)},
    recordUtf8:recordText,testedWork:manifest(1),sources};
  const bundle={...clone(base.bundle),validation:record,openFindings:[],support:[],
    objects:[...objects.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)};
  return bundle;
}

test('V12 validator direto reconstrói bundle authored e detecta adulteração coerente',()=>{
  const f=first();const authored=authoredNativeBundle(f.base,f.cap);
  const pretty=Uint8Array.from(Buffer.from(JSON.stringify(authored,null,2)+'\r\n'));
  const direct=validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:pretty,
    counters:EXPECTED_FIRST_COUNTERS,observedWork:manifest(1)});
  assert.deepEqual(direct.bytes,pretty);
  assert.equal(direct.bundle.validation.recordUtf8,expectedFirstRecord());
  const prettyRaw=clone(f.cap);rebindRaw(prettyRaw,JSON.stringify(parse(prettyRaw.rawResponse),null,2).replaceAll('\n','\r\n'));
  const authoredPretty=authoredNativeBundle(f.base,prettyRaw);
  assert.equal(validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(authoredPretty),counters:EXPECTED_FIRST_COUNTERS,observedWork:manifest(1)}).validation,'current');
  for (const [label,edit,expected,part] of [
    ['record',bundle=>{bundle.validation.recordUtf8+='\n- Hidden: claim';},'EVIDENCE_STALE','formal record'],
    ['contract',bundle=>{bundle.validation.contract.context.strategy='Another strategy';},'EVIDENCE_STALE','formal record'],
    ['index',bundle=>{bundle.openFindings=[finding(1,1)];},'INVALID_CURRENT_IMAGE','openFindings index'],
  ]) {
    const bundle=clone(authored);edit(bundle);
    assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:json(bundle),
      counters:EXPECTED_FIRST_COUNTERS,observedWork:manifest(1)}),code(expected,part),label);
  }
  const changed=clone(f.cap);const req=parse(changed.validationRequest);req.scope.paths=[];req.scope.filelessReason='Invented absence.';
  changed.validationRequest=json(req);const response=parse(changed.rawResponse);response.requestSha256=digest(changed.validationRequest);
  rebindRaw(changed,response);
  const resealed=authoredNativeBundle(f.base,changed);
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,bundleBytes:json(resealed),
    counters:EXPECTED_FIRST_COUNTERS,observedWork:manifest(1)}),code('EVIDENCE_STALE','scope'));
  const rawChanged=clone(f.cap);const rawResponse=parse(rawChanged.rawResponse);
  rawResponse.result.evidence='Altered evidence with consistent capture hashes.';rebindRaw(rawChanged,rawResponse);
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(authoredNativeBundle(f.base,rawChanged)),counters:EXPECTED_FIRST_COUNTERS,observedWork:manifest(1)}),
    code('EVIDENCE_STALE','formal record'));
  const originChanged=clone(f.cap);const claimedOrigin=parse(originChanged.origin);
  claimedOrigin.dispatchId='other-dispatch';originChanged.origin=json(claimedOrigin);
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(authoredNativeBundle(f.base,originChanged)),counters:EXPECTED_FIRST_COUNTERS,observedWork:manifest(1)}),
    code('OWNER_MISMATCH','dispatch'));
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(authored),counters:{...EXPECTED_FIRST_COUNTERS,validationAttempts:2},observedWork:manifest(1)}),
    code('INVALID_CURRENT_IMAGE','counters'));
  const created=composeCurrentValidationEvidence(first({status:'NEEDS_FIX',
    newFindings:[finding(1,1),finding(2,1,'advisory')],findingReferences:'finding-01, finding-02',
    findingDispositions:'finding-01=active, finding-02=active'}).input);
  const passFixture=next(created,2,{status:'PASS',findingReferences:'finding-01, finding-02',
    findingDispositions:'finding-01=resolved, finding-02=active'});
  const passed=composeCurrentValidationEvidence(passFixture.input);
  const jumped=clone(passFixture.cap);rebindRequest(jumped,asked=>{asked.base.counters.findings=3;});
  const jumpedBundle=resealNativeRecord(passed.bundle,jumped);
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(jumpedBundle),counters:{...passed.counters,findings:3},observedWork:manifest(1)}),
    code('INVALID_CURRENT_IMAGE','consecutive formal counters'));
  const changedDisposition=clone(passFixture.cap);const dispositionRaw=parse(changedDisposition.rawResponse);
  dispositionRaw.result.findingDispositions='finding-01=active, finding-02=active';
  rebindRaw(changedDisposition,dispositionRaw);
  const dispositionBundle=resealNativeRecord(passed.bundle,changedDisposition);
  dispositionBundle.validation.recordUtf8=dispositionBundle.validation.recordUtf8.replace(
    '- Finding dispositions: finding-01=resolved, finding-02=active',
    '- Finding dispositions: finding-01=active, finding-02=active');
  assert.notEqual(dispositionBundle.validation.recordUtf8,passed.bundle.validation.recordUtf8);
  dispositionBundle.openFindings=[finding(1,1),finding(2,1,'advisory')];
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(dispositionBundle),counters:passed.counters,observedWork:manifest(1)}),
    code('INVALID_CURRENT_IMAGE','PASS retains blocking finding'));
  const reduced=composeCurrentValidationEvidence(next(created,2,{status:'NEEDS_FIX',
    findingReferences:'finding-01, finding-02',findingDispositions:'finding-01=active, finding-02=resolved'}).input);
  const third=next(reduced,3,{status:'BLOCKED',findingReferences:'finding-01',findingDispositions:'finding-01=active'});
  const current=composeCurrentValidationEvidence(third.input);
  const falsified=clone(third.cap);const request=parse(falsified.validationRequest);
  request.base.counters.findings=1;falsified.validationRequest=json(request);
  const counterResponse=parse(falsified.rawResponse);counterResponse.requestSha256=digest(falsified.validationRequest);
  rebindRaw(falsified,counterResponse);
  const counterBundle=resealNativeRecord(current.bundle,falsified);
  assert.throws(()=>validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
    bundleBytes:sealed(counterBundle),counters:{...current.counters,findings:1},observedWork:manifest(1)}),
    code('INVALID_CURRENT_IMAGE','latest finding counter below retained origins'));
  const impossible=clone(f.input);const inflated=parse(impossible.capture.validationRequest);
  inflated.base.counters.findings=99;impossible.capture.validationRequest=json(inflated);
  assert.throws(()=>composeCurrentValidationEvidence(impossible),code('INVALID_CURRENT_IMAGE','first formal request cannot inherit findings'));
});

test('V13 distribuição isolada importa somente siblings e preserva semântica',async()=>{
  const root=fileURLToPath(new URL('../skills/workflows/',import.meta.url));
  const temporaryRoot=fileURLToPath(new URL('../tmp/',import.meta.url));
  const names=['execution-current.mjs','runner-result-contract.mjs','execution-evidence-proof.mjs',
    'execution-evidence-current.mjs','current-evidence-state.mjs','findings-evidence-current.mjs',
    'validation-evidence-current.mjs'];
  const workdir=process.cwd();const environment=JSON.stringify(process.env);
  const expected=composeCurrentValidationEvidence(first().input);
  for (const family of ['stnl-slice-executor','stnl-slice-quality-manager']) {
    const directory=await mkdtemp(path.join(temporaryRoot,'l23-distribution-'));
    try {
      for (const name of names) await copyFile(path.join(root,family,'runtime',name),path.join(directory,name));
      const module=await import(pathToFileURL(path.join(directory,'validation-evidence-current.mjs')).href);
      const findings=await import(pathToFileURL(path.join(directory,'findings-evidence-current.mjs')).href);
      const proof=await import(pathToFileURL(path.join(directory,'execution-evidence-proof.mjs')).href);
      assert.deepEqual(Object.keys(module).sort(),['composeCurrentValidationEvidence','validateCurrentValidationEvidence']);
      assert.deepEqual(Object.keys(findings).sort(),['composeCurrentFindingsEvidence','validateCurrentFindingsEvidence']);
      for (const name of ['closeEvidenceObjects','packCaptureSources','restoreCaptureSources','verifyCapturedInvocation',
        'verifyWorkObservation','verifyAuxiliaryWork','findingsRoundCaptureSha256']) assert.equal(typeof proof[name],'function');
      const fresh=first();const candidate=module.composeCurrentValidationEvidence(fresh.input);
      assert.deepEqual(candidate.bytes,expected.bytes);
      assert.equal(module.validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
        bundleBytes:candidate.bytes,counters:candidate.counters,observedWork:manifest(1)}).validation,'current');
      assert.throws(()=>module.composeCurrentValidationEvidence(first({transport:'managed'}).input),code('UNSUPPORTED_FORMAT'));
      const needing=first({status:'NEEDS_FIX',newFindings:[finding(1,1)],
        findingReferences:'finding-01',findingDispositions:'finding-01=active'});
      assert.deepEqual(module.composeCurrentValidationEvidence(needing.input).bundle.openFindings,[finding(1,1)]);
      const repeated=clone(fresh.input);repeated.previous={bundleBytes:candidate.bytes,counters:candidate.counters};
      assert.equal(module.composeCurrentValidationEvidence(repeated).replayed,true);
      const authored=authoredNativeBundle(fresh.base,fresh.cap);
      assert.equal(module.validateCurrentValidationEvidence({context:CONTEXT,authority:AUTHORITY,
        bundleBytes:sealed(authored),counters:EXPECTED_FIRST_COUNTERS,observedWork:manifest(1)}).validation,'current');
    } finally {await rm(directory,{recursive:true,force:true});}
    const missing=await mkdtemp(path.join(temporaryRoot,'l24-missing-sibling-'));
    try {
      for (const name of names.filter(item=>item!=='current-evidence-state.mjs'))
        await copyFile(path.join(root,family,'runtime',name),path.join(missing,name));
      await assert.rejects(()=>import(pathToFileURL(path.join(missing,'validation-evidence-current.mjs')).href),
        error=>error?.code==='ERR_MODULE_NOT_FOUND');
    } finally {await rm(missing,{recursive:true,force:true});}
  }
  assert.equal(process.cwd(),workdir);assert.equal(JSON.stringify(process.env),environment);
});

test('V14 extração conserva Initial e não habilita APPLY',async()=>{
  const source=initial([nativeRound()]);const result=composeInitialImplementationEvidence(source);
  assert.equal(result.outcome,'recorded');assert.equal(result.bundle.format,'stnl-current-evidence-v1');
  assert.equal(result.bundle.implementation.length,1);assert.equal(result.bundle.validation,null);
  assert.deepEqual(result.counters,EXPECTED_INITIAL_COUNTERS);
  assert.equal(result.bundle.currentAuthoritySha256,digest(Buffer.concat([
    Buffer.from('stnl-ec1/delivery/v1'),Buffer.from([0]),Buffer.from(DELIVERY_PREIMAGE)])));
  const expectedRecord=[
    '### implementation-check-01','- Automatic check round: 1/3','- Status: TESTS_PASS',
    '- HEAD: 0123456789abcdef',`- Tested scope: ${TARGET}`,
    `- Delivery ID: ${OWNER.deliveryId}`,'- Preparation revision: 1','- Local revision: 1',
    `- Normative sha256: ${OWNER.normativeSha256}`,`- Operation attempt ID: ${OWNER.operationAttemptId}`,
    `- Origin activation ID: ${OWNER.originActivationId}`,'- Tested state:',
    `  - \`${TARGET}\` | ${manifest(1).entries.at(-1).sha256}`,'- Commands:',`  - \`${COMMAND}\` | exit:0`,
    '- Discovery sources: Read the approved plan and task.','- Discovery actions: Inspected pay source.',
    '- Verification types considered: Direct node check.','- Non-applicability rationale: none',
    '- No verification-command confirmation: Confirmed direct recipe only.',
    '- Selected checks: verification-01','- Selection rationale: Covers the observable delivery.',
    '- Coverage: Pay command and settings.','- Failures: none','- Blockers: none',
    '- Unexpected workspace effects: none','- Persistence summary: Retain current evidence.',
  ].join('\n');
  const cap=source.rounds[0];
  const originCapsule=sealed({format:'stnl-native-origin-bundle-v1',
    originUtf8:Buffer.from(cap.origin).toString('utf8'),dispatchUtf8:Buffer.from(cap.dispatch).toString('utf8'),
    baselineUtf8:Buffer.from(cap.baselineCapture).toString('utf8')});
  const agentCapsule=sealed({format:'stnl-native-agent-bundle-v1',
    agentUtf8:Buffer.from(cap.agentBinding).toString('utf8'),claimUtf8:Buffer.from(cap.agentClaim).toString('utf8')});
  const expectedSources={transport:'native',rawResponse:digest(cap.rawResponse),receipt:digest(cap.receipt),
    verificationObservation:digest(cap.verificationObservation),removalProofs:[],legacyPreparation:null,
    origin:digest(originCapsule),agentBinding:digest(agentCapsule),concludedToolResult:digest(cap.concludedToolResult)};
  const {ownershipToken, ...originOwner}=OWNER;
  const expectedOrigin={...originOwner,transport:'native',dispatchId:'dispatch-pay',runnerId:'agent-pay-1'};
  const objects=[cap.rawResponse,cap.receipt,cap.verificationObservation,originCapsule,agentCapsule,cap.concludedToolResult]
    .map(bytes=>({id:digest(bytes),bytesBase64:Buffer.from(bytes).toString('base64')}))
    .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const authored={format:'stnl-current-evidence-v1',deliveryId:OWNER.deliveryId,slice:OWNER.slice,
    logicalTaskPath:'tasks/slice-01.md',currentAuthoritySha256:result.bundle.currentAuthoritySha256,
    implementation:[{kind:'implementation-check',recordFormat:'stnl-task-record-v2',id:'implementation-check-01',
      origin:expectedOrigin,contract:{delivery:clone(AUTHORITY.delivery),context:clone(AUTHORITY.context),
        terminal:null,recipe:clone(RECIPE)},recordUtf8:expectedRecord,testedWork:manifest(1),sources:expectedSources}],
    findingsChecks:[],validation:null,openFindings:[],openDivergences:[],support:[],objects};
  assert.deepEqual(result.bundle,authored);
  assert.deepEqual(result.bytes,sealed(authored));
  const {rounds, ...readInput}=source;
  assert.deepEqual(validateInitialImplementationEvidence({...readInput,bundleBytes:result.bytes}).bytes,result.bytes);
  const malformed=clone(authored);const wrongCapsule=sealed({format:'stnl-native-origin-bundle-v2'});
  malformed.implementation[0].sources.origin=digest(wrongCapsule);
  malformed.objects=malformed.objects.filter(item=>item.id!==digest(originCapsule));
  malformed.objects.push({id:digest(wrongCapsule),bytesBase64:Buffer.from(wrongCapsule).toString('base64')});
  malformed.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  assert.throws(()=>validateInitialImplementationEvidence({...readInput,bundleBytes:sealed(malformed)}),
    code('INVALID_CURRENT_IMAGE','fields differ'));
  const mixed=initial([nativeRound(1,'TESTS_FAIL',1),nativeRound(2,'TESTS_PASS',0)]);
  mixed.rounds[1].transport='unknown';
  assert.throws(()=>composeInitialImplementationEvidence(mixed),code('UNSUPPORTED_FORMAT'));
  const forbidden=clone(source);forbidden.owner.operation='APPLY_FINDINGS';
  assert.throws(()=>composeInitialImplementationEvidence(forbidden),code('INVALID_CURRENT_IMAGE','initial'));
  assert.deepEqual(Object.keys(await import('../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs')).sort(),
    ['composeInitialImplementationEvidence','validateInitialImplementationEvidence']);
});
