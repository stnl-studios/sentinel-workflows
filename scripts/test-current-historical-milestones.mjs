import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {packCaptureSources} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-proof.mjs';
import {inspectCurrentEvidence} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {nativeRound} from './fixtures/current-initial-evidence.mjs';
import {authenticatedSliceMilestone,markHistoricalSliceMilestones,inspectCurrentExecution}
  from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {overlappingActiveImage,overlappingPostImage,campaignImage} from './fixtures/current-reader-campaign.mjs';
import {cleanup} from './fixtures/current-quiet-reader.mjs';

const file=(value,name='src/shared.mjs')=>({path:name,kind:'file',sha256:value,mode:420});
const manifest=value=>({format:'stnl-current-work-v1',entries:[file(value)]});
function delivery(n,{before='v0',after=`v${n}`,now=after,pass=true,changes=['src/shared.mjs']}={}) {
  return {slice:`slice-0${n}`,deliveryId:String(n),observation:{manifest:manifest(now)},facts:{
    formalStatus:pass?'PASS':null,persistedValidation:pass?'current':'unvalidated',
    observedValidation:now===after?(pass?'current':'unvalidated'):'revalidation-required',
    observationMatches:now===after,baseline:manifest(before),sealedWork:manifest(after),
    verifiedChanges:changes,rejection:null,openFindings:[],openDivergences:[]}};
}
const pending=items=>markHistoricalSliceMilestones(items).find(item=>!item.milestoneSatisfied)?.slice;

test('four checkpoints: execution alone does not release slice 3; formal PASS does',()=>{
  const items=[delivery(1),delivery(2,{before:'v1',pass:false}),delivery(3,{pass:false,changes:[]}),delivery(4,{pass:false,changes:[]})];
  assert.equal(pending(items),'slice-02');
  items[1].facts.formalStatus='PASS';items[1].facts.persistedValidation='current';items[1].facts.observedValidation='current';
  assert.equal(pending(items),'slice-03');
  items[2].facts.formalStatus='PASS';items[2].facts.persistedValidation='current';items[2].facts.observedValidation='current';
  assert.equal(pending(items),'slice-04');
});

test('successor execution owns an authenticated edit while its validation remains pending',()=>{
  const a=delivery(1,{now:'v2'}),b=delivery(2,{before:'v1',pass:false});
  const original=structuredClone(a.facts);
  assert.equal(pending([a,b]),'slice-02');
  assert.equal(a.milestoneSatisfied,true);assert.deepEqual(a.facts,original);
});

test('historical chain follows reviewed serial order, not numeric slice names',()=>{
  const a=delivery(3,{after:'v1',now:'v3'}),b=delivery(1,{before:'v1',after:'v2',now:'v3'}),c=delivery(2,{before:'v2',after:'v3'});
  assert.equal(pending([a,b,c]),undefined);
});

test('retired UUID order cannot reverse an approved dependency chain',()=>{
  const earlier=delivery(1,{now:'v2'}),later=delivery(2,{before:'v1'});
  earlier.deliveryId='z-earlier';later.deliveryId='a-later';
  markHistoricalSliceMilestones([later,earlier],[
    {deliveryId:'a-later',dependencies:['z-earlier']},{deliveryId:'z-earlier',dependencies:[]}]);
  assert.equal(earlier.milestoneSatisfied,true);assert.equal(later.milestoneSatisfied,true);
});

test('independent archived milestones recover native admission order instead of UUID order',()=>{
  const a=delivery(1,{now:'v2'}),b=delivery(2,{before:'v1'});
  for(const [item,sequence]of [[a,10],[b,20]]) {
    const cap=nativeRound(),objects=[];
    const origin=JSON.parse(Buffer.from(cap.origin));origin.admission={baseActivation:{sequence}};
    cap.origin=Buffer.from(JSON.stringify(origin));
    const sources=packCaptureSources('initial-implementation',cap,{add(bytes){
      const data=Buffer.from(bytes),id='sha256:'+createHash('sha256').update(data).digest('hex');
      objects.push({id,bytesBase64:data.toString('base64')});return id;
    }});
    item.facts.bundle={objects};
    item.facts.latest={record:{origin:{operation:'EXECUTE_SLICE'},sources,testedWork:item.facts.sealedWork}};
  }
  a.deliveryId='z';b.deliveryId='a';
  markHistoricalSliceMilestones([b,a],[],new Set(['a','z']));
  assert.equal(a.milestoneSatisfied,true);assert.equal(b.milestoneSatisfied,true);
});

test('retained implementation capture survives a later APPLY cycle baseline',()=>{
  const a=delivery(1,{now:'v3'}),b=delivery(2,{before:'v2',after:'v3'}),cap=nativeRound(),objects=[];
  const baseline=JSON.parse(Buffer.from(cap.baselineCapture));baseline.manifest=manifest('v1');
  cap.baselineCapture=Buffer.from(JSON.stringify(baseline));
  const sources=packCaptureSources('initial-implementation',cap,{add(bytes){
    const data=Buffer.from(bytes),id='sha256:'+createHash('sha256').update(data).digest('hex');
    objects.push({id,bytesBase64:data.toString('base64')});return id;
  }});
  b.facts.bundle={objects,implementation:[{sources,origin:{operation:'EXECUTE_SLICE',localRevision:1}}]};
  b.facts.latest={record:{origin:{localRevision:1}}};
  markHistoricalSliceMilestones([a,b]);assert.equal(a.milestoneSatisfied,true);assert.equal(b.milestoneSatisfied,true);
});

test('legacy APPLY without retained implementation provenance stays conservative',async()=>{
  const fixture=await campaignImage({kind:'APPLY_PASS'});
  try {
    const current=fixture.continuity.deliveries[0],bundle=fixture.campaign.base.bundle;
    const context={logicalSpecRoot:fixture.spec,logicalAuthorityPath:fixture.source,
      logicalExecutionRoot:fixture.execution,physicalExecutionRoot:fixture.execution,productRoot:fixture.project};
    const facts=inspectCurrentEvidence({context,authority:fixture.activeProof.authority,
      bundleBytes:fixture.campaign.base.bytes,counters:current.counters,baseline:current.baseline,
      observedWork:bundle.validation.testedWork});
    const original=JSON.parse(Buffer.from(fixture.campaign.captures[0].baselineCapture)).manifest;
    assert.notDeepEqual(facts.baseline,original,'APPLY really replaced the operational cycle baseline');
    const predecessor={deliveryId:'predecessor',facts:{formalStatus:'PASS',persistedValidation:'current',
      observationMatches:false,observedValidation:'revalidation-required',sealedWork:original,
      baseline:original,openFindings:[],verifiedChanges:[]},observation:{manifest:bundle.validation.testedWork}};
    const successor={deliveryId:current.deliveryId,facts,observation:{manifest:bundle.validation.testedWork}};
    markHistoricalSliceMilestones([predecessor,successor]);assert.equal(predecessor.milestoneSatisfied,false);
    assert.equal(successor.milestoneSatisfied,true);
  }finally{await cleanup(fixture);}
});

test('unexplained drift, changed current slice, and unproven overlap remain pending',()=>{
  for(const [a,b] of [
    [delivery(1,{now:'foreign'}),delivery(2,{before:'v1',now:'foreign'})],
    [delivery(1,{now:'v2'}),delivery(2,{before:'foreign'})],
    [delivery(1,{now:'v2'}),delivery(2,{before:'v1',changes:[]})],
  ])assert.equal(pending([a,b]),'slice-01');
  assert.equal(pending([delivery(1,{now:'foreign'})]),'slice-01');
});

test('local revision review, formal rejection and blocking findings are not milestones',()=>{
  for(const edit of [facts=>facts.consumption={kind:'historical-local-review'},
    facts=>facts.rejection={origin:{operation:'VALIDATE_SLICE'}},
    facts=>facts.openFindings=[{severity:'blocking'}],facts=>facts.formalStatus=null]) {
    const item=delivery(1);edit(item.facts);assert.equal(authenticatedSliceMilestone(item.facts),false);
    assert.equal(pending([item]),'slice-01');
  }
});

test('real Initial and converted proofs retain predecessor PASS after successor overlap',async t=>{
  for(const [name,builder]of [['Initial',()=>overlappingActiveImage()],['converted',()=>overlappingPostImage(t,{laterSharedChange:true})]]) {
    await t.test(name,async()=>{
      const fixture=await builder();
      try {
        if(name==='converted')await fs.writeFile(path.join(fixture.project,'fourth/state.mjs'),'export const state=1;\n');
        const before=await fs.readFile(path.join(fixture.execution??fixture.image.f.execution,'activation.json'));
        const inspected=await inspectCurrentExecution(fixture.specPath);
        assert.equal(inspected.deliveries[0].formalStatus,'PASS');
        assert.equal(inspected.deliveries[0].observedValidation,'revalidation-required');
        assert.equal(inspected.state,'COMPLETE');assert.equal(inspected.normalHandoff,null);
        assert.ok(inspected.deliveries.every(item=>!Object.hasOwn(item,'milestoneSatisfied')));
        assert.deepEqual(await fs.readFile(path.join(fixture.execution??fixture.image.f.execution,'activation.json')),before);
        if(name==='converted') {
          await fs.writeFile(path.join(fixture.project,'fourth/state.mjs'),'export const state=2;\n');
          assert.equal((await inspectCurrentExecution(fixture.specPath)).normalHandoff?.slice,'slice-03');
        }
      } finally {if(name==='Initial')await cleanup(fixture);}
    });
  }
});
