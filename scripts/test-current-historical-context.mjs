import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {historicalExternalContextMatches,markHistoricalSliceMilestones} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
const hash=records=>'sha256:'+createHash('sha256').update(Buffer.from('stnl-output-external-context-v1\0'+JSON.stringify([...records].sort((a,b)=>a.path.localeCompare(b.path))))).digest('hex');
const file=(path,value)=>({path,kind:'file',mode:420,sha256:'sha256:'+createHash('sha256').update(value).digest('hex')});
const directory=records=>({path:'sql',kind:'directory',mode:493,externalContextSha256:hash(records)});
function fixture() {
  const project0=file('sql/one.sqlproj','before'),project1=file('sql/one.sqlproj','after');
  const helper0=file('sql/helper.sql','before'),helper1=file('sql/helper.sql','after');
  const foreign0=file('sql/settings.json','original');
  const records=[helper1,foreign0];
  return {root:'sql',records,outputs:['sql/one.sqlproj'],sealed:directory([helper0,foreign0]),current:directory(records),
    steps:[{before:new Map([project0,helper0].map(x=>[x.path,x])),after:new Map([project1,helper1].map(x=>[x.path,x])),changes:new Set([project0.path,helper0.path])}]};
}
test('project/helper edits reconstruct the historical fingerprint despite different output domains',()=>{
  const f=fixture();assert.notEqual(hash([]),f.sealed.externalContextSha256);
  assert.equal(historicalExternalContextMatches(f),true);
});
test('foreign change before successor baseline is not attributed to legitimate helper edit',()=>{
  const f=fixture(),foreign=file('sql/settings.json','foreign before baseline');
  f.records=f.records.map(x=>x.path===foreign.path?foreign:x);f.current=directory(f.records);
  // The successor observed this foreign file unchanged before and after its own
  // edit. It is still not a verified change and must remain in reconstruction.
  f.steps[0].before.set(foreign.path,foreign);f.steps[0].after.set(foreign.path,foreign);
  assert.equal(historicalExternalContextMatches(f),false);
});
test('post-capture changes, wrong baseline, unowned edits and mode changes fail closed',()=>{
  for(const mutate of [
    f=>{f.records[0]=file('sql/helper.sql','foreign');f.current=directory(f.records);},
    f=>f.steps[0].before.set('sql/helper.sql',file('sql/helper.sql','wrong baseline')),
    f=>f.steps[0].changes.delete('sql/helper.sql'),
    f=>{f.current.mode=448;},
  ]) {const f=fixture();mutate(f);assert.equal(historicalExternalContextMatches(f),false);}
});
test('multiple authorized successor edits reverse in order, preserving unrelated rows',()=>{
  const f=fixture(),before=f.steps[0].after.get('sql/helper.sql'),after=file('sql/helper.sql','third');
  f.steps.push({before:new Map([[before.path,before]]),after:new Map([[after.path,after]]),changes:new Set([after.path])});
  f.records=f.records.map(x=>x.path===after.path?after:x);f.current=directory(f.records);
  assert.equal(historicalExternalContextMatches(f),true);
  f.steps.reverse();assert.equal(historicalExternalContextMatches(f),false);
});
test('structural additions/removals require separate proof and never use leaf-edit exception',()=>{
  for(const kind of ['absent','directory']) {const f=fixture();f.steps[0].before.set('sql/helper.sql',{path:'sql/helper.sql',kind});assert.equal(historicalExternalContextMatches(f),false);}
});


test('reader milestone attribution consumes the captured predecessor projection, not successor hashes',()=>{
  for(const foreign of [false,true]) {
    const f=fixture(),step=f.steps[0];
    if(foreign) {
      f.records[1]=file('sql/settings.json','foreign before admission');f.current=directory(f.records);
    }
    const work=entries=>({format:'stnl-current-work-v1',entries});
    const old=work([f.sealed,step.before.get('sql/one.sqlproj')]);
    const now=work([f.current,step.after.get('sql/one.sqlproj')]);
    const pass={formalStatus:'PASS',persistedValidation:'current',openFindings:[],rejection:null};
    const a={deliveryId:'a',facts:{...pass,baseline:old,sealedWork:old,verifiedChanges:[],
      observationMatches:false,observedValidation:'revalidation-required'},
      observation:{manifest:now,externalContexts:new Map([['sql',{records:f.records,outputs:f.outputs}]])}};
    const b={deliveryId:'b',facts:{...pass,baseline:work([...step.before.values()]),sealedWork:work([...step.after.values()]),
      verifiedChanges:[...step.changes],observationMatches:true,observedValidation:'current'},
      observation:{manifest:work([...step.after.values()])}};
    markHistoricalSliceMilestones([a,b]);assert.equal(a.milestoneSatisfied,!foreign);assert.equal(b.milestoneSatisfied,true);
  }
});
