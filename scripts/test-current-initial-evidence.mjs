import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {composeInitialImplementationEvidence as compose, validateInitialImplementationEvidence as validate} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs';
import {validateCurrentEvidence} from '../skills/workflows/stnl-slice-executor/runtime/execution-current.mjs';
import {AUTHORITY, CONTEXT, OWNER, RECIPE, RESOLVED, DELIVERY_PREIMAGE, TARGET, COMMAND, MANIFEST_0, manifest,
  nativeRound, managedRound, initial, rebindRaw, payload, ORACLE} from './fixtures/current-initial-evidence.mjs';

const decode = bytes => JSON.parse(Buffer.from(bytes).toString('utf8'));
const encode = ORACLE.encode;
const hash = ORACLE.hash;
const copied = value => structuredClone(value);
function assertCode(action, code) {
  assert.throws(action, error => error?.code === code, `expected ${code}`);
}
function editJson(cap, field, mutate) {
  const value = decode(cap[field]); mutate(value); cap[field] = encode(value);
}
function recaptured(cap, rawText, status = null) {
  rebindRaw(cap, rawText);
  if (status !== null) editJson(cap,'receipt',value => { value.semanticResponseStatus=status; });
  if (cap.transport==='managed') {
    const latest=decode(cap.latest); latest.receipt=decode(cap.receipt); cap.latest=encode(latest);
  }
}
function schemaRejection(transport) {
  const cap=transport==='native' ? nativeRound() : managedRound();
  recaptured(cap,'not-json');
  cap.verificationObservation=null;
  editJson(cap,'receipt',receipt => {
    receipt.status='RUNNER_RESULT_BLOCKED'; receipt.semanticResponseStatus=null;
    receipt.verification=null; receipt.testedState=null; receipt.captureFailure='Invalid result schema';
    if (transport==='managed') {receipt.exitCode=1; receipt.captureFailureCode='RUNNER_RESPONSE_SCHEMA_INVALID';}
  });
  if (transport==='managed') {
    editJson(cap,'latest',latest => {latest.receipt=decode(cap.receipt);});
    editJson(cap,'closedSupervisor',supervisor => {supervisor.capturedReceipts=0;});
  }
  return cap;
}
function multi(transport, statuses) {
  const rounds=statuses.map((status,index) => {
    const round=index+1, exit=status==='TESTS_FAIL' ? 1 : 0;
    return transport==='native' ? nativeRound(round,status,exit) : managedRound(round,status,exit,statuses.length,statuses.length);
  });
  if (transport==='managed') {
    const final=rounds.at(-1);
    for (const cap of rounds) {cap.latest=Uint8Array.from(final.latest);cap.closedSupervisor=Uint8Array.from(final.closedSupervisor);}
  }
  return initial(rounds);
}
const validationInput = (input, bundleBytes) => {
  const {rounds, ...expectation}=input;
  return {...expectation,bundleBytes};
};
const validateResult = (input, result) => validate(validationInput(input,result.bytes));

test('E01 native: authored record, full domain, hashes and counters', () => {
  const input=initial([nativeRound()]);
  const result=compose(input);
  assert.equal(result.outcome,'recorded');
  assert.deepEqual(result.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0});
  assert.equal(result.consumedInvocations,1);
  assert.deepEqual(result.bundle.implementation[0].testedWork,manifest(1));
  assert.equal(result.bundle.validation,null);
  assert.deepEqual(result.bundle.findingsChecks,[]);
  assert.deepEqual(result.bundle.support,[]);
  assert.equal(result.bundle.implementation[0].origin.localRevision,1);
  assert.equal(result.bundle.implementation[0].origin.ownershipToken,undefined);
  assert.equal(result.bundle.implementation[0].contract.delivery.deliveryId,AUTHORITY.delivery.deliveryId);
  assert.equal(result.bundle.implementation[0].contract.terminal,null);
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
  assert.equal(result.bundle.implementation[0].recordUtf8,expectedRecord);
  const currentAuthoritySha256=hash(Buffer.concat([Buffer.from('stnl-ec1/delivery/v1'),Buffer.from([0]),Buffer.from(DELIVERY_PREIMAGE)]));
  assert.equal(result.bundle.currentAuthoritySha256,currentAuthoritySha256);
  const cap=input.rounds[0];
  const originCapsule=Buffer.from('{"baselineUtf8":'+JSON.stringify(Buffer.from(cap.baselineCapture).toString('utf8'))+
    ',"dispatchUtf8":'+JSON.stringify(Buffer.from(cap.dispatch).toString('utf8'))+
    ',"format":"stnl-native-origin-bundle-v1","originUtf8":'+JSON.stringify(Buffer.from(cap.origin).toString('utf8'))+'}\n');
  const agentCapsule=Buffer.from('{"agentUtf8":'+JSON.stringify(Buffer.from(cap.agentBinding).toString('utf8'))+
    ',"claimUtf8":'+JSON.stringify(Buffer.from(cap.agentClaim).toString('utf8'))+
    ',"format":"stnl-native-agent-bundle-v1"}\n');
  const expectedSources={transport:'native',rawResponse:hash(cap.rawResponse),receipt:hash(cap.receipt),
    verificationObservation:hash(cap.verificationObservation),removalProofs:[],legacyPreparation:null,
    origin:hash(originCapsule),agentBinding:hash(agentCapsule),concludedToolResult:hash(cap.concludedToolResult)};
  const {ownershipToken, ...originIdentity}=OWNER;
  const expectedOrigin={...originIdentity,transport:'native',dispatchId:'dispatch-pay',runnerId:'agent-pay-1'};
  const objects=[cap.rawResponse,cap.receipt,cap.verificationObservation,originCapsule,agentCapsule,cap.concludedToolResult]
    .map(source=>({id:hash(source),bytesBase64:Buffer.from(source).toString('base64')})).sort((a,b)=>a.id.localeCompare(b.id,'en'));
  assert.deepEqual(result.bundle,{
    format:'stnl-current-evidence-v1',deliveryId:OWNER.deliveryId,slice:OWNER.slice,
    logicalTaskPath:'tasks/slice-01.md',currentAuthoritySha256,
    implementation:[{kind:'implementation-check',recordFormat:'stnl-task-record-v2',id:'implementation-check-01',
      origin:expectedOrigin,contract:{delivery:AUTHORITY.delivery,context:AUTHORITY.context,terminal:null,recipe:RECIPE},
      recordUtf8:expectedRecord,testedWork:manifest(1),sources:expectedSources}],
    findingsChecks:[],validation:null,openFindings:[],openDivergences:[],support:[],objects,
  });
  const ids=result.bundle.objects.map(item => item.id);
  assert.deepEqual(ids,[...ids].sort());
  for (const item of result.bundle.objects) assert.equal(item.id,hash(Buffer.from(item.bytesBase64,'base64')));
  assert.equal(result.sha256,hash(result.bytes));
  assert.deepEqual(validateResult(input,result).bundle,result.bundle);
  assert.doesNotThrow(()=>validateCurrentEvidence(result.bundle));
  const fileArea=initial([nativeRound()]);
  fileArea.authority.delivery.authorizedAreas=`- file: \`${TARGET}\``;
  assert.equal(compose(fileArea).outcome,'recorded');
});

test('E02 removed managed transport is refused before evidence or counters change',()=>{
 const input=initial([managedRound()]),before=copied(input);assertCode(()=>compose(input),'UNSUPPORTED_FORMAT');assert.deepEqual(input,before);
});

test('E03 two/three rounds preserve failure and derive correction paths', () => {
  for (const transport of ['native']) for (const statuses of [
    ['TESTS_FAIL','TESTS_PASS'], ['TESTS_FAIL','TESTS_FAIL','TESTS_PASS'],
  ]) {
    const input=multi(transport,statuses), result=compose(input);
    assert.equal(result.bundle.implementation.length,statuses.length);
    assert.equal(result.consumedInvocations,statuses.length);
    assert.deepEqual(result.bundle.implementation.map(item=>item.id),statuses.map((_,index)=>`implementation-check-${String(index+1).padStart(2,'0')}`));
    assert.match(result.bundle.implementation[1].recordUtf8,/- Correction paths: \.\.\/\.\.\/\.\.\/\.\.\/src\/pay\.mjs/u);
    assert.deepEqual(validateResult(input,result).bundle,result.bundle);
  }
  const skipped=multi('native',['TESTS_PASS','TESTS_PASS']);
  assertCode(()=>compose(skipped),'INVALID_CURRENT_IMAGE');
  const fourth=multi('native',['TESTS_FAIL','TESTS_FAIL','TESTS_PASS']);
  fourth.rounds.push(nativeRound(3,'TESTS_FAIL',1));
  assertCode(()=>compose(fourth),'INVALID_CURRENT_IMAGE');
  const replay=multi('native',['TESTS_FAIL','TESTS_PASS']);
  replay.rounds[1]=replay.rounds[0];
  assertCode(()=>compose(replay),'INVALID_CURRENT_IMAGE');
  const suppressed=initial([nativeRound(2,'TESTS_PASS',0)]);
  assertCode(()=>compose(suppressed),'INVALID_CURRENT_IMAGE');
  const afterRejection=initial([schemaRejection('native'),nativeRound(2)]);
  assertCode(()=>compose(afterRejection),'INVALID_CURRENT_IMAGE');
});

test('E04 concluded semantic rejection preserves claims and consumption', () => {
  for (const transport of ['native']) {
    const malformed=initial([schemaRejection(transport)]);
    const result=compose(malformed);
    assert.equal(result.outcome,'rejected');
    assert.equal(result.bundle.implementation.length,0);
    assert.equal(result.bundle.support.length,1);
    assert.equal(result.bundle.support[0].sources.verificationObservation,null);
    assert.equal(result.consumedInvocations,1);
    assert.match(result.bundle.support[0].diagnostic,/RUNNER_SEMANTIC_RESULT_INVALID/u);
    assert.deepEqual(validateResult(malformed,result).bundle,result.bundle);
    const contradictory=transport==='native' ? nativeRound(1,'TESTS_PASS',1) : managedRound(1,'TESTS_PASS',1);
    const rejected=compose(initial([contradictory]));
    assert.equal(rejected.outcome,'rejected');
    assert.equal(rejected.bundle.implementation.length,0);
    assert.equal(Buffer.from(contradictory.rawResponse).toString('utf8').includes('TESTS_PASS'),true);
    const noFailure=transport==='native' ? nativeRound(1,'TESTS_FAIL',0) : managedRound(1,'TESTS_FAIL',0);
    assert.match(compose(initial([noFailure])).bundle.support[0].diagnostic,/TESTS_FAIL requires an observed nonzero exit/u);
    const notApplicable=transport==='native' ? nativeRound(1,'TESTS_NOT_APPLICABLE',0) : managedRound(1,'TESTS_NOT_APPLICABLE',0);
    assert.match(compose(initial([notApplicable])).bundle.support[0].diagnostic,/reviewed nonempty recipe/u);
    const retained=schemaRejection(transport);
    const observed=decode((transport==='native' ? nativeRound() : managedRound()).verificationObservation);
    retained.verificationObservation=encode(observed);
    editJson(retained,'receipt',receipt=>{receipt.verification=observed;});
    if (transport==='managed') editJson(retained,'latest',latest=>{latest.receipt=decode(retained.receipt);});
    const retainedInput=initial([retained]), retainedResult=compose(retainedInput);
    assert.equal(retainedResult.outcome,'rejected');
    assert.equal(retainedResult.bundle.support[0].sources.verificationObservation,hash(retained.verificationObservation));
    assert.deepEqual(validateResult(retainedInput,retainedResult).bundle,retainedResult.bundle);
    const hidden=schemaRejection(transport);
    editJson(hidden,'receipt',receipt=>{receipt.verification=observed;});
    if (transport==='managed') editJson(hidden,'latest',latest=>{latest.receipt=decode(hidden.receipt);});
    assertCode(()=>compose(initial([hidden])),'EVIDENCE_INCOMPLETE');
    const corrupt=copied(retained);
    editJson(corrupt,'verificationObservation',value=>{value.before.entries[1].sha256=`sha256:${'0'.repeat(64)}`;});
    editJson(corrupt,'receipt',receipt=>{receipt.verification=decode(corrupt.verificationObservation);});
    if (transport==='managed') editJson(corrupt,'latest',latest=>{latest.receipt=decode(corrupt.receipt);});
    assertCode(()=>compose(initial([corrupt])),'EVIDENCE_STALE');
    const changedInput=copied(retained);
    editJson(changedInput,'verificationObservation',value=>{
      for (const phase of ['before','after']) value[phase].entries[1].sha256=`sha256:${'0'.repeat(64)}`;
    });
    editJson(changedInput,'receipt',receipt=>{receipt.verification=decode(changedInput.verificationObservation);});
    if (transport==='managed') editJson(changedInput,'latest',latest=>{latest.receipt=decode(changedInput.receipt);});
    assertCode(()=>compose(initial([changedInput])),'EVIDENCE_STALE');
  }
  const pending=schemaRejection('native');
  editJson(pending,'concludedToolResult',item=>{item.status='pending';});
  assertCode(()=>compose(initial([pending])),'OWNER_UNCERTAIN');
  for (const transport of ['native']) {
    const foreign=schemaRejection(transport);
    editJson(foreign,'receipt',receipt=>{receipt.owner.operationAttemptId=DUMMY;});
    assertCode(()=>compose(initial([foreign])),'OWNER_MISMATCH');
    const altered=schemaRejection(transport);
    editJson(altered,'receipt',receipt=>{receipt.semanticResponseSha256='0'.repeat(64);});
    assertCode(()=>compose(initial([altered])),'EVIDENCE_INCOMPLETE');
  }
});

test('E05 initial guard and migration discrimination', () => {
  const input=initial([nativeRound()]);
  const previous=Buffer.from(input.rounds[0].rawResponse);
  for (const field of ['implementationChecks','findingsChecks','validationAttempts','findings']) {
    const bad=copied(input);bad.counters[field]=1;assertCode(()=>compose(bad),'INVALID_CURRENT_IMAGE');
    const negativeZero=copied(input);negativeZero.counters[field]=-0;
    assertCode(()=>compose(negativeZero),'INVALID_CURRENT_IMAGE');
  }
  for (const operation of ['APPLY_FINDINGS','VALIDATE_SLICE']) {
    const bad=copied(input);bad.owner.operation=operation;assertCode(()=>compose(bad),'INVALID_CURRENT_IMAGE');
  }
  const existing=copied(input);existing.currentEvidence={};assertCode(()=>compose(existing),'INVALID_CURRENT_IMAGE');
  const foreign=copied(input);editJson(foreign.rounds[0],'origin',value=>{value.owner.operationAttemptId=DUMMY;});
  assertCode(()=>compose(foreign),'OWNER_MISMATCH');
  const old=copied(input);editJson(old.rounds[0],'receipt',value=>{delete value.owner.localRevision;});
  assertCode(()=>compose(old),'UNSUPPORTED_FORMAT');
  const legacy=copied(input);editJson(legacy.rounds[0],'verificationObservation',value=>{value.format='stnl-runner-verification-v1';});
  assertCode(()=>compose(legacy),'UNSUPPORTED_FORMAT');
  const oldOwner=copied(input);delete oldOwner.owner.localRevision;
  assertCode(()=>compose(oldOwner),'UNSUPPORTED_FORMAT');
  const imported={...copied(input),imported:true};
  assertCode(()=>compose(imported),'UNSUPPORTED_FORMAT');
  const mixed=copied(input);mixed.rounds=[nativeRound(1,'TESTS_FAIL',1),managedRound(2)];
  assertCode(()=>compose(mixed),'UNSUPPORTED_FORMAT');
  const malformedDelivery=copied(input);
  malformedDelivery.authority.delivery.obligations=[{}];
  malformedDelivery.rounds[0].receipt=encode(null);
  assert.throws(()=>compose(malformedDelivery),error=>error?.code==='INVALID_CURRENT_IMAGE'
    && /delivery\.obligation/u.test(error.message));
  const duplicateDependency=copied(input);
  duplicateDependency.authority.delivery.dependencies=[OWNER.deliveryId];
  assertCode(()=>compose(duplicateDependency),'INVALID_CURRENT_IMAGE');
  const badRecipe=copied(input);
  badRecipe.authority.delivery.verificationRecipe.checks[0].args=[{file:{kind:'unknown',path:TARGET}}];
  assertCode(()=>compose(badRecipe),'INVALID_CURRENT_IMAGE');
  for (const fullOwner of ['slice-00','slice-001']) {
    const rejectionOnly=initial([schemaRejection('native')]);
    rejectionOnly.authority.delivery.obligations[0].fullOwner=fullOwner;
    assert.throws(()=>compose(rejectionOnly),error=>error?.code==='INVALID_CURRENT_IMAGE'
      && /delivery\.obligation\.fullOwner: noncanonical slice/u.test(error.message));
  }
  assert.deepEqual(Buffer.from(input.rounds[0].rawResponse),previous);
});
const DUMMY='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

test('E06 removed managed captures remain unsupported even with plausible completed or altered SDK material',()=>{
 const base=managedRound();
 for(const field of ['closedSupervisor','latest','managedContext','events','runtimeIdentity']){const cap=copied(base);cap[field]=field==='runtimeIdentity'?[]:encode(null);assertCode(()=>compose(initial([cap])),'UNSUPPORTED_FORMAT');}
 for(const mutate of [value=>{value.checks[0].exit=1;},value=>{value.checks[0].command='echo foreign';}]){const cap=nativeRound();editJson(cap,'verificationObservation',mutate);assertCode(()=>compose(initial([cap])),'EVIDENCE_STALE');}
});

test('E07 native independent origin, receipt and recipe guards', () => {
  const cases=[
    ['agentClaim',value=>{value.agentId='foreign';},'OWNER_MISMATCH'],
    ['origin',value=>{value.dispatchId='foreign';},'OWNER_MISMATCH'],
    ['concludedToolResult',value=>{value.status='pending';},'OWNER_UNCERTAIN'],
    ['receipt',value=>{value.semanticResponseSha256='0'.repeat(64);},'EVIDENCE_INCOMPLETE'],
    ['receipt',value=>{value.attempt=2;},'INVALID_CURRENT_IMAGE'],
    ['origin',value=>{value.verification.recipeSha256=`sha256:${'0'.repeat(64)}`;},'EVIDENCE_STALE'],
    ['concludedToolResult',value=>{value.agentId='foreign';},'OWNER_MISMATCH'],
    ['agentBinding',value=>{value.originFile='/tmp/foreign/round-1.origin.json';},'OWNER_MISMATCH'],
    ['receipt',value=>{value.testedState.entries[0].value=`sha256:${'0'.repeat(64)}`;},'EVIDENCE_STALE'],
  ];
  for (const [field,mutation,code] of cases) {
    const cap=nativeRound();editJson(cap,field,mutation);assertCode(()=>compose(initial([cap])),code);
  }
});

test('E08 manifests, input, unexpected children and real removal proof', () => {
  for (const kind of ['absent','directory']) {
    const entry=kind==='absent' ? {path:'config/settings.json',kind:'absent'}
      : {path:'config/settings.json',kind:'directory',children:[]};
    const coherent=nativeRound();editJson(coherent,'baselineCapture',value=>{
      value.manifest.entries[0].children=kind==='absent' ? [] : ['settings.json'];
      value.manifest.entries[1]=entry;
    });
    editJson(coherent,'verificationObservation',value=>{
      for (const phase of ['before','after']) {
        value[phase].entries[0].children=kind==='absent' ? [] : ['settings.json'];
        value[phase].entries[1]=entry;
      }
    });
    editJson(coherent,'receipt',receipt=>{receipt.verification=decode(coherent.verificationObservation);});
    assert.throws(()=>compose(initial([coherent])),error=>error?.code==='EVIDENCE_STALE'
      && /Existing Input is not a file/u.test(error.message));
  }
  const changed=nativeRound();editJson(changed,'verificationObservation',value=>{value.after.entries[1].sha256=`sha256:${'0'.repeat(64)}`;});
  assertCode(()=>compose(initial([changed])),'EVIDENCE_STALE');
  const stableInput=nativeRound();editJson(stableInput,'verificationObservation',value=>{
    value.before.entries[1].sha256=`sha256:${'0'.repeat(64)}`;
    value.after.entries[1].sha256=`sha256:${'0'.repeat(64)}`;
  });
  editJson(stableInput,'receipt',value=>{value.verification=decode(stableInput.verificationObservation);});
  assertCode(()=>compose(initial([stableInput])),'EVIDENCE_STALE');
  const outside=nativeRound();editJson(outside,'baselineCapture',value=>{
    value.manifest.entries.splice(2,0,{path:'secret',kind:'file',sha256:`sha256:${'0'.repeat(64)}`,mode:420});
  });
  assertCode(()=>compose(initial([outside])),'EVIDENCE_INCOMPLETE');
  const ignored=nativeRound();editJson(ignored,'verificationObservation',value=>{
    for (const phase of ['before','after']) {
      value[phase].entries[2].children=['.cache','pay.mjs'];
      value[phase].entries.splice(3,0,{path:'src/.cache',kind:'file',sha256:`sha256:${'0'.repeat(64)}`,mode:420});
    }
  });
  editJson(ignored,'receipt',value=>{value.verification=decode(ignored.verificationObservation);});
  assertCode(()=>compose(initial([ignored])),'EVIDENCE_STALE');
  const created=nativeRound();editJson(created,'verificationObservation',value=>{
    for (const phase of ['before','after']) {
      value[phase].entries[2].children=['pay.mjs','sub'];
      value[phase].entries.push({path:'src/sub',kind:'directory',children:['extra.mjs']},
        {path:'src/sub/extra.mjs',kind:'file',sha256:hash(Buffer.from('extra\n')),mode:420});
    }
  });
  editJson(created,'receipt',value=>{value.verification=decode(created.verificationObservation);
    value.testedState.entries.push({path:'../../../../src/sub/extra.mjs',value:hash(Buffer.from('extra\n'))});});
  assert.equal(compose(initial([created])).outcome,'recorded');
  const omitted=nativeRound();editJson(omitted,'baselineCapture',value=>{
    value.manifest.entries[2].children=['empty'];
    value.manifest.entries.splice(3,0,{path:'src/empty',kind:'directory',children:[]});
  });
  assertCode(()=>compose(initial([omitted])),'EVIDENCE_STALE');
  const removed=nativeRound();
  const prior=manifest(1), after=copied(prior);
  after.entries[2].children=[];after.entries[3]={path:'src/pay.mjs',kind:'absent'};
  editJson(removed,'baselineCapture',value=>{value.manifest=prior;});
  editJson(removed,'verificationObservation',value=>{value.before=after;value.after=after;});
  editJson(removed,'receipt',value=>{value.verification=decode(removed.verificationObservation);value.testedState.entries[0].value='REMOVED';});
  const product=Buffer.from('pay-v1\n');
  removed.removalProofs=[encode({format:'stnl-current-removal-proof-v1',owner:OWNER,round:1,path:'src/pay.mjs',
    sha256:hash(product),mode:420,bytesBase64:product.toString('base64')})];
  assert.equal(compose(initial([removed])).outcome,'recorded');
  const invented=copied(removed);
  invented.removalProofs[0]=encode({...decode(removed.removalProofs[0]),sha256:`sha256:${'0'.repeat(64)}`});
  assertCode(()=>compose(initial([invented])),'EVIDENCE_INCOMPLETE');
  const absent=copied(removed);editJson(absent,'baselineCapture',value=>{value.manifest=MANIFEST_0;});
  assertCode(()=>compose(initial([absent])),'EVIDENCE_INCOMPLETE');
});

test('E09 raw preservation, strict JSON, shape and object closure', () => {
  const cap=nativeRound();
  const pretty=JSON.stringify(payload(1),null,2).replaceAll('\n','\r\n');
  recaptured(cap,pretty,'TESTS_PASS');
  const result=compose(initial([cap]));
  const rawId=result.bundle.implementation[0].sources.rawResponse;
  assert.equal(rawId,hash(Buffer.from(pretty)));
  const prettyBundle=Uint8Array.from(Buffer.from(JSON.stringify(result.bundle,null,2)+'\n'));
  assert.equal(validate(validationInput(initial([nativeRound()]),prettyBundle)).sha256,hash(prettyBundle));
  const duplicate=nativeRound();recaptured(duplicate,Buffer.from(duplicate.rawResponse).toString('utf8').replace('"status":"TESTS_PASS"','"status":"TESTS_PASS","status":"TESTS_FAIL"'));
  editJson(duplicate,'receipt',receipt=>{receipt.semanticResponseStatus='TESTS_FAIL';});
  assert.equal(compose(initial([duplicate])).outcome,'rejected');
  const getter=initial([nativeRound()]);Object.defineProperty(getter.owner,'operation',{get(){throw Error('getter invoked');},enumerable:true});
  assertCode(()=>compose(getter),'INVALID_CURRENT_IMAGE');
  const disguised=initial([nativeRound()]);disguised.rounds=Object.assign([], {extra:true});
  assertCode(()=>compose(disguised),'INVALID_CURRENT_IMAGE');
  const map=initial([nativeRound()]);map.rounds[0].removalProofs=new Map();
  assertCode(()=>compose(map),'INVALID_CURRENT_IMAGE');
  const bom=nativeRound();recaptured(bom,`\ufeff${Buffer.from(bom.rawResponse).toString('utf8')}`);
  assertCode(()=>compose(initial([bom])),'INVALID_CURRENT_IMAGE');
  const unicode=schemaRejection('native');recaptured(unicode,'{"status":"\\ud800"}');
  assert.equal(compose(initial([unicode])).outcome,'rejected');
  const extra=copied(result.bundle);extra.objects.push({id:hash(Buffer.from('orphan')),bytesBase64:Buffer.from('orphan').toString('base64')});
  extra.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  assertCode(()=>validate(validationInput(initial([nativeRound()]),encode(extra))),'EVIDENCE_INCOMPLETE');
  const badBase64=copied(result.bundle);badBase64.objects[0].bytesBase64='!';
  assertCode(()=>validate(validationInput(initial([nativeRound()]),encode(badBase64))),'EVIDENCE_INCOMPLETE');
  const badHash=copied(result.bundle);badHash.objects[0].id=`sha256:${'0'.repeat(64)}`;
  assertCode(()=>validate(validationInput(initial([nativeRound()]),encode(badHash))),'EVIDENCE_INCOMPLETE');
  const missing=copied(result.bundle);missing.objects.pop();
  assertCode(()=>validate(validationInput(initial([nativeRound()]),encode(missing))),'EVIDENCE_INCOMPLETE');
  const capsule=copied(result.bundle);
  const source=capsule.implementation[0].sources.origin;
  const stored=capsule.objects.find(item=>item.id===source);
  const expanded={...JSON.parse(Buffer.from(stored.bytesBase64,'base64').toString('utf8')),extra:'unreviewed'};
  const expandedBytes=encode(expanded);stored.id=hash(expandedBytes);stored.bytesBase64=Buffer.from(expandedBytes).toString('base64');
  capsule.implementation[0].sources.origin=stored.id;capsule.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  assert.doesNotThrow(()=>validateCurrentEvidence(capsule));
  assertCode(()=>validate(validationInput(initial([nativeRound()]),encode(capsule))),'INVALID_CURRENT_IMAGE');
});

test('E10 validator rederives semantic bundle after coherent envelope edits', () => {
  const input=initial([nativeRound()]), result=compose(input);
  assert.doesNotThrow(()=>validateCurrentEvidence(result.bundle));
  for (const [mutate,code] of [
    [bundle=>{bundle.implementation[0].recordUtf8+='\n- Invented: yes';},'EVIDENCE_STALE'],
    [bundle=>{bundle.implementation[0].id='implementation-check-02';},'INVALID_CURRENT_IMAGE'],
    [bundle=>{bundle.implementation[0].origin.runnerId='foreign';},'EVIDENCE_STALE'],
    [bundle=>{bundle.implementation[0].contract.context.objective='Foreign objective';},'EVIDENCE_STALE'],
    [bundle=>{bundle.implementation[0].recordUtf8=bundle.implementation[0].recordUtf8.replace(COMMAND,'foreign');},'EVIDENCE_STALE'],
  ]) {
    const altered=copied(result.bundle);mutate(altered);
    assert.doesNotThrow(()=>validateCurrentEvidence(altered));
    assertCode(()=>validate(validationInput(input,encode(altered))),code);
  }
  const extra=copied(result.bundle);extra.implementation.push(copied(extra.implementation[0]));extra.implementation[1].id='implementation-check-02';
  assertCode(()=>validate(validationInput(input,encode(extra))),'INVALID_CURRENT_IMAGE');
  const changedCapsule=copied(result.bundle);
  const previous=changedCapsule.implementation[0].sources.origin;
  const object=changedCapsule.objects.find(item=>item.id===previous);
  const capsule=JSON.parse(Buffer.from(object.bytesBase64,'base64').toString('utf8'));
  for (const key of ['originUtf8','dispatchUtf8']) {
    const document=JSON.parse(capsule[key]);document.dispatchId='different-dispatch';
    capsule[key]=JSON.stringify(document)+'\n';
  }
  const capsuleBytes=Uint8Array.from(Buffer.from('{"baselineUtf8":'+JSON.stringify(capsule.baselineUtf8)+
    ',"dispatchUtf8":'+JSON.stringify(capsule.dispatchUtf8)+',"format":"stnl-native-origin-bundle-v1","originUtf8":'+JSON.stringify(capsule.originUtf8)+'}\n'));
  object.id=hash(capsuleBytes);object.bytesBase64=Buffer.from(capsuleBytes).toString('base64');
  changedCapsule.implementation[0].sources.origin=object.id;
  changedCapsule.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  assert.doesNotThrow(()=>validateCurrentEvidence(changedCapsule));
  assertCode(()=>validate(validationInput(input,encode(changedCapsule))),'EVIDENCE_STALE');
});

test('E11 physical candidate depth does not change delivery authority', () => {
  const one=initial([nativeRound()]), two=initial([nativeRound()]);
  two.context.physicalExecutionRoot='/tmp/deep/pay/candidate';
  editJson(two.rounds[0],'baselineCapture',value=>{value.context=two.context;});
  const a=compose(one), b=compose(two);
  assert.equal(a.bundle.currentAuthoritySha256,b.bundle.currentAuthoritySha256);
  assert.notEqual(a.bundle.implementation[0].sources.origin,b.bundle.implementation[0].sources.origin);
  assert.deepEqual(b.bundle.implementation[0].testedWork,a.bundle.implementation[0].testedWork);
  const saved=process.cwd();
  try {process.chdir('/tmp');assert.deepEqual(compose(initial([nativeRound()])).bundle.currentAuthoritySha256,a.bundle.currentAuthoritySha256);}
  finally {process.chdir(saved);}
});

test('E12 isolated byte-identical executor and quality copies', async () => {
  const here=path.dirname(fileURLToPath(import.meta.url));
  const root=path.resolve(here,'..');
  const left=path.join(root,'skills/workflows/stnl-slice-executor/runtime');
  const right=path.join(root,'skills/workflows/stnl-slice-quality-manager/runtime');
  const moduleName='execution-evidence-current.mjs';
  const oldNames=[moduleName,'execution-current.mjs','runner-result-contract.mjs'];
  const names=[...oldNames,'execution-evidence-proof.mjs'];
  for (const name of names) assert.deepEqual(await fs.readFile(path.join(left,name)),await fs.readFile(path.join(right,name)),name);
  const withoutProof=await fs.mkdtemp(path.join(os.tmpdir(),'l22-missing-proof-'));
  let temporary=null;
  try {
    temporary=await fs.mkdtemp(path.join(os.tmpdir(),'l22-isolated-'));
    for (const name of oldNames) await fs.copyFile(path.join(left,name),path.join(withoutProof,name));
    assert.deepEqual((await fs.readdir(withoutProof)).sort(),[...oldNames].sort());
    await assert.rejects(()=>import(pathToFileURL(path.join(withoutProof,moduleName)).href),error=>
      error?.code==='ERR_MODULE_NOT_FOUND' && String(error.message).includes('execution-evidence-proof.mjs'));
    for (const [index,source] of [left,right].entries()) {
      const destination=path.join(temporary,`copy-${index}`);await fs.mkdir(destination);
      for (const name of names) await fs.copyFile(path.join(source,name),path.join(destination,name));
      assert.deepEqual((await fs.readdir(destination)).sort(),[...names].sort());
      const api=await import(pathToFileURL(path.join(destination,moduleName)).href);
      assert.deepEqual(Object.keys(api).sort(),['assertTestCoverageCorrectionWork','composeInitialImplementationEvidence','validateInitialImplementationEvidence']);
      for (const capture of [nativeRound(),schemaRejection('native')]) {
        const input=initial([capture]);const result=api.composeInitialImplementationEvidence(input);
        assert.equal(api.validateInitialImplementationEvidence(validationInput(input,result.bytes)).outcome,result.outcome);
      }
      const wrongOwner=initial([nativeRound()]);wrongOwner.owner.operation='APPLY_FINDINGS';
      assertCode(()=>api.composeInitialImplementationEvidence(wrongOwner),'INVALID_CURRENT_IMAGE');
      const current=initial([nativeRound()]);const result=api.composeInitialImplementationEvidence(current);
      const changed=copied(result.bundle);changed.implementation[0].recordUtf8+='\n- Changed: yes';
      assertCode(()=>api.validateInitialImplementationEvidence(validationInput(current,encode(changed))),'EVIDENCE_STALE');
    }
  } finally {
    await Promise.all([
      fs.rm(withoutProof,{recursive:true,force:true}),
      ...(temporary===null ? [] : [fs.rm(temporary,{recursive:true,force:true})]),
    ]);
  }
});

test('L2.2 semantic PASS fields reject placeholders with otherwise coherent captured evidence', () => {
  const fields=[['coverage','Coverage'],['selectedChecks','Selected checks'],
    ['verificationTypesConsidered','Verification types considered']];
  for (const transport of ['native']) for (const [field,label] of fields) for (const value of ['none','  none  ','   ']) {
    const cap=transport==='native' ? nativeRound() : managedRound();
    const raw=payload(1);raw[field]=value;
    recaptured(cap,JSON.stringify(raw)+'\n');
    const input=initial([cap]), result=compose(input);
    assert.equal(result.outcome,'rejected');
    assert.equal(result.bundle.implementation.length,0);
    assert.match(result.bundle.support[0].diagnostic,new RegExp(label,'u'));
    assert.equal(result.bundle.support[0].sources.rawResponse,hash(cap.rawResponse));
    assert.deepEqual(validateResult(input,result).bundle,result.bundle);
  }
  for (const transport of ['native']) {
    const cap=transport==='native' ? nativeRound() : managedRound();
    const raw=payload(1);raw.coverage='json:"none"';
    recaptured(cap,JSON.stringify(raw)+'\n');
    assert.equal(compose(initial([cap])).outcome,'recorded');
  }
});

test('L2.2 rendered record grammar covers present fields, fileless reason and corrections', () => {
  const presentFields=[['head','HEAD'],['discoverySources','Discovery sources'],['discoveryActions','Discovery actions'],
    ['verificationTypesConsidered','Verification types considered'],['selectedChecks','Selected checks'],
    ['selectionRationale','Selection rationale'],['coverage','Coverage'],['failures','Failures'],
    ['blockers','Blockers'],['unexpectedWorkspaceEffects','Unexpected workspace effects'],
    ['persistenceSummary','Persistence summary']];
  for (const transport of ['native']) for (const [field,label] of presentFields) for (const value of [' pending ','   ']) {
    const cap=transport==='native' ? nativeRound(1,'TESTS_FAIL',1) : managedRound(1,'TESTS_FAIL',1);
    const raw=payload(1,'TESTS_FAIL',1);raw[field]=value;
    recaptured(cap,JSON.stringify(raw)+'\n');
    const input=initial([cap]), result=compose(input);
    assert.equal(result.outcome,'rejected');
    assert.match(result.bundle.support[0].diagnostic,new RegExp(label,'u'));
    assert.equal(result.bundle.support[0].sources.rawResponse,hash(cap.rawResponse));
    assert.deepEqual(validateResult(input,result).bundle,result.bundle);
  }
  for (const transport of ['native']) for (const status of ['TESTS_PASS','TESTS_FAIL','BLOCKED']) {
    const exit=status==='TESTS_FAIL' ? 1 : 0;
    const fileless=value=>{
      const cap=transport==='native' ? nativeRound(1,status,exit) : managedRound(1,status,exit);
      editJson(cap,'baselineCapture',baseline=>{baseline.manifest=manifest(1);});
      editJson(cap,'receipt',receipt=>{receipt.testedState.entries=[];});
      if (transport==='managed') editJson(cap,'latest',latest=>{latest.receipt=decode(cap.receipt);});
      const raw=payload(1,status,exit);raw.filelessReason=value;
      recaptured(cap,JSON.stringify(raw)+'\n');
      return cap;
    };
    for (const value of ['none','  none  ','   ']) {
      const cap=fileless(value), result=compose(initial([cap]));
      assert.equal(result.outcome,'rejected');
      assert.match(result.bundle.support[0].diagnostic,/(?:Fileless reason|Tested scope)/u);
    }
    assert.equal(compose(initial([fileless('No source file changed.')])).outcome,'recorded');
  }
  for (const field of ['priorRoundFailure','correctionApplied','inSliceRationale']) {
    const input=multi('native',['TESTS_FAIL','TESTS_PASS']);
    const raw=payload(2,'TESTS_PASS',0);raw[field]='  none  ';
    recaptured(input.rounds[1],JSON.stringify(raw)+'\n');
    const result=compose(input);
    assert.equal(result.outcome,'rejected');
    assert.match(result.bundle.support[0].diagnostic,/(?:Prior-round failure|Correction applied|In-slice rationale)/u);
    assert.equal(result.bundle.implementation.length,1);
  }
});

test('L2.2 removed managed transport cannot be disguised by a native receipt',()=>{
 const cap=managedRound();editJson(cap,'receipt',receipt=>{receipt.transport='native';});assertCode(()=>compose(initial([cap])),'UNSUPPORTED_FORMAT');
});

test('L2.2 native rounds cannot borrow the next round from an external override',()=>{
 const input=multi('native',['TESTS_FAIL','TESTS_FAIL']);recaptured(input.rounds[0],JSON.stringify(payload(2,'TESTS_FAIL',1))+'\n');assertCode(()=>compose(input),'INVALID_CURRENT_IMAGE');
});

test('L2.2 observed negative exit is a valid signed check value', () => {
  for (const transport of ['native']) {
    const input=initial([transport==='native' ? nativeRound(1,'TESTS_FAIL',-1) : managedRound(1,'TESTS_FAIL',-1)]);
    const result=compose(input);
    assert.equal(result.outcome,'recorded');
    assert.match(result.bundle.implementation[0].recordUtf8,/exit:-1/u);
    assert.deepEqual(validateResult(input,result).bundle,result.bundle);
  }
});

test('L2.2 JSON-valid wrong shapes fail with stable codes', () => {
  const nullReceipt=nativeRound();nullReceipt.receipt=encode(null);
  assertCode(()=>compose(initial([nullReceipt])),'INVALID_CURRENT_IMAGE');
  const badOriginFile=nativeRound();editJson(badOriginFile,'receipt',receipt=>{receipt.originFile=[];});
  assertCode(()=>compose(initial([badOriginFile])),'INVALID_CURRENT_IMAGE');
  const nullEvent=managedRound();
  const lines=Buffer.from(nullEvent.events).toString('utf8').trimEnd().split('\n');
  lines[0]='null';nullEvent.events=Uint8Array.from(Buffer.from(lines.join('\n')+'\n'));
  assertCode(()=>compose(initial([nullEvent])),'UNSUPPORTED_FORMAT');
  const nullProof=nativeRound();nullProof.removalProofs=[encode(null)];
  assertCode(()=>compose(initial([nullProof])),'INVALID_CURRENT_IMAGE');
});
