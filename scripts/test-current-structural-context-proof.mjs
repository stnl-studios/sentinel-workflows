import test from 'node:test';
import assert from 'node:assert/strict';
import {initial,nativeRound,ORACLE,CONTEXT,AUTHORITY,MANIFEST_0,manifest} from './fixtures/current-initial-evidence.mjs';
import {capture,request,validationOwner} from './fixtures/current-validation-evidence.mjs';
import {composeInitialImplementationEvidence} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-current.mjs';
import {composeCurrentValidationEvidence,inspectCurrentEvidence} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {assertExternalOutputContextTransition as transition,assertExternalOutputContextLineage as lineage,
  projectConversionObservedWork} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-proof.mjs';
const decode=b=>JSON.parse(Buffer.from(b)),clone=structuredClone,hash=ORACLE.hash,encode=ORACLE.encode;
const empty=hash(Buffer.from('stnl-output-external-context-v1\0[]'));
const marker={path:'src',kind:'directory',children:['pay.mjs'],externalContextSha256:empty,mode:493};
const info={areas:[{kind:'file',path:'src/pay.mjs'}],inputs:[{kind:'input',path:'config/settings.json'}],refs:[]};
const absent=()=>({format:'stnl-current-work-v1',entries:[{path:'src',kind:'absent'}]});
const marked=()=>({format:'stnl-current-work-v1',entries:[clone(marker),clone(manifest().entries.at(-1))]});
const stale=e=>e.code==='EVIDENCE_STALE';
test('context starts only at literal absent root and preserves independently editable exact output',()=>{
  const work=marked();assert.doesNotThrow(()=>transition(absent(),work,info,'create'));
  const next=clone(work);next.entries[1].sha256=hash(Buffer.from('own edit'));
  assert.doesNotThrow(()=>transition(work,next,info,'own edit'));
  assert.doesNotThrow(()=>lineage(absent(),next,info,'formal'));
});
for(const [name,edit] of [
  ['changed external hash',w=>{w.entries[0].externalContextSha256=hash(Buffer.from('package'));}],
  ['omitted external hash',w=>{delete w.entries[0].externalContextSha256;}],
  ['changed root mode',w=>{w.entries[0].mode=448;}],
  ['omitted root mode',w=>{delete w.entries[0].mode;}],
])test(`auxiliary context rejects ${name}`,()=>{const before=marked(),after=clone(before);edit(after);assert.throws(()=>transition(before,after,info,name),stale);});
test('an existing directory cannot self-authorize a new empty context marker',()=>{
  const before=marked();delete before.entries[0].externalContextSha256;
  assert.throws(()=>transition(before,marked(),info,'unproved root'),stale);
  assert.throws(()=>lineage(before,marked(),info,'unproved formal root'),stale);
});
test('observed context cannot authorize a directory claim or input-only ancestor',()=>{
  for(const domain of [
    {areas:[{kind:'directory',path:'src'}],inputs:[],refs:[]},
    {areas:info.areas,inputs:[{kind:'input',path:'src/pay.mjs'}],refs:[]},
  ])assert.throws(()=>transition(absent(),marked(),domain,'unclaimed context'),stale);
});
test('an omitted child of a projected directory is not literal ancestor absence',()=>{
  const before={format:'stnl-current-work-v1',entries:[{path:'src',kind:'directory',children:[]}]};
  assert.throws(()=>transition(before,marked(),info,'projected absence'),stale);
});
test('formal validation can seal changed external bytes but cannot drop their observation',()=>{
  const before=marked(),after=clone(before);after.entries[0].externalContextSha256=hash(Buffer.from('new package'));after.entries[0].mode=448;
  assert.doesNotThrow(()=>lineage(before,after,info,'fresh formal'));
  delete after.entries[0].externalContextSha256;assert.throws(()=>lineage(before,after,info,'dropped context'),stale);
});
function legacyPass({missing=true}={}) {
  const authority=clone(AUTHORITY);authority.delivery.authorizedAreas='- file: `../../../../src/pay.mjs`';
  const cap=nativeRound(),baseline=decode(cap.baselineCapture);
  if(missing)baseline.manifest.entries=baseline.manifest.entries.filter(e=>!e.path.startsWith('src')).concat({path:'src',kind:'absent'});
  cap.baselineCapture=encode(baseline);
  const input=initial([cap]);input.authority=authority;
  const base=composeInitialImplementationEvidence(input),owner=validationOwner();
  const asked=request({baseBytes:base.bytes,counters:base.counters,owner,authority});
  const formal=capture({request:asked,work:manifest(),approvedAuthority:authority});
  const result=composeCurrentValidationEvidence({context:CONTEXT,authority,owner,
    previous:{bundleBytes:base.bytes,counters:base.counters},capture:formal.cap});
  return {authority,baseline:baseline.manifest,result,base};
}
for(const [name,edit] of [
  ['new context fingerprint',w=>{Object.assign(w.entries.find(e=>e.path==='src'),marker);}],
  ['directory mode alone',w=>{w.entries.find(e=>e.path==='src').mode=448;}],
])test(`legacy PASS is not retroactively current after ${name}`,()=>{
  const f=legacyPass(),work=manifest();edit(work);
  const facts=inspectCurrentEvidence({context:CONTEXT,authority:f.authority,bundleBytes:f.result.bytes,
    counters:f.result.counters,baseline:f.baseline,observedWork:work});
  assert.equal(facts.formalStatus,'PASS');assert.equal(facts.observationMatches,false);
  assert.equal(facts.observedValidation,'revalidation-required');
});
test('formal marker cannot be injected into a historical existing-directory contract',()=>{
  const f=legacyPass({missing:false}),owner=validationOwner(2),work=manifest();Object.assign(work.entries.find(e=>e.path==='src'),marker);
  const asked=request({baseBytes:f.result.bytes,counters:f.result.counters,owner,authority:f.authority});
  const formal=capture({request:asked,work,approvedAuthority:f.authority});
  assert.throws(()=>composeCurrentValidationEvidence({context:CONTEXT,authority:f.authority,owner,
    previous:{bundleBytes:f.result.bytes,counters:f.result.counters},capture:formal.cap}),stale);
});
const delivery=(id='cccccccc-cccc-4ccc-8ccc-cccccccccccc',slice='slice-01')=>({slice,deliveryId:id,
  authorizedAreas:'- file: `../../../../src/pay.mjs`',existingInputs:AUTHORITY.delivery.existingInputs,
  verificationRecipe:AUTHORITY.delivery.verificationRecipe});
test('scoped conversion retains read-context digest and modes without claiming foreign files',()=>{
  const work={format:'stnl-current-work-v1',entries:[clone(manifest().entries[1]),...marked().entries]};
  const d=delivery(),projected=projectConversionObservedWork({context:CONTEXT,deliveries:[d],observedWork:work}).get(d.deliveryId);
  assert.deepEqual(projected,work);assert.equal(projected.entries[1].externalContextSha256,empty);
  assert.equal(projected.entries[1].mode,493);
});
test('one delivery-specific digest cannot be transplanted across shared-root conversion domains',()=>{
  const work={format:'stnl-current-work-v1',entries:[clone(manifest().entries[1]),...marked().entries]};
  assert.throws(()=>projectConversionObservedWork({context:CONTEXT,
    deliveries:[delivery(),delivery('dddddddd-dddd-4ddd-8ddd-dddddddddddd','slice-02')],observedWork:work}),
    e=>e.code==='UNSUPPORTED_FORMAT');
});
