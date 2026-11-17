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
test('inconsistent structural claims cannot replace a historical existing-file proof',()=>{
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

const absent=path=>({path,kind:'absent'});
const stepOf=(before,after,changes)=>({before:new Map(before.map(x=>[x.path,x])),after:new Map(after.map(x=>[x.path,x])),changes:new Set(changes)});
function structural(before,after,steps,outputs=['sql/one.sqlproj']) {
  return {root:'sql',records:after,outputs,sealed:directory(before),current:directory(after),steps};
}
test('authenticated exact-file creation and removal preserve historical coverage',()=>{
  const existing=file('sql/settings.json','stable'),created=file('sql/two.sql','created');
  const add=stepOf([absent(created.path)],[created],[created.path]);
  assert.equal(historicalExternalContextMatches(structural([existing],[existing,created],[add])),true);
  const remove=stepOf([created],[absent(created.path)],[created.path]);
  assert.equal(historicalExternalContextMatches(structural([existing,created],[existing],[remove])),true);
  // Omission is not proof of absence, including in a projected directory list.
  add.before.clear();assert.equal(historicalExternalContextMatches(structural([existing],[existing,created],[add])),false);
  remove.after.clear();assert.equal(historicalExternalContextMatches(structural([existing,created],[existing],[remove])),false);
});
test('new and removed nested directories reconstruct only proved topology and leaves',()=>{
  const parent={path:'sql/new',kind:'directory',mode:493};
  const nested={path:'sql/new/nested',kind:'directory',mode:493};
  const leaf=file('sql/new/nested/two.sql','created');
  const add=stepOf([absent(parent.path)],[parent,nested,leaf],[leaf.path]);
  assert.equal(historicalExternalContextMatches(structural([],[parent,nested,leaf],[add])),true);
  const remove=stepOf([parent,nested,leaf],[absent(parent.path)],[leaf.path]);
  assert.equal(historicalExternalContextMatches(structural([parent,nested,leaf],[],[remove])),true);
  const foreign=file('sql/new/nested/foreign.sql','foreign');
  assert.equal(historicalExternalContextMatches(structural([],[parent,nested,leaf,foreign],[add])),false);
  // A foreign historical sibling cannot disappear under an authorized removal.
  assert.equal(historicalExternalContextMatches(structural([parent,nested,leaf,foreign],[],[remove])),false);
});
test('file replacement with directory and foreign directory mode edits remain blocked',()=>{
  const old=file('sql/helper.sql','old'),replacement={path:old.path,kind:'directory',mode:493};
  assert.equal(historicalExternalContextMatches(structural([old],[replacement],[stepOf([old],[replacement],[old.path])])),false);
  const parent={path:'sql/new',kind:'directory',mode:493},afterParent={...parent,mode:448};
  const oldLeaf=file('sql/new/helper.sql','old'),newLeaf=file(oldLeaf.path,'new');
  assert.equal(historicalExternalContextMatches(structural([parent,oldLeaf],[afterParent,newLeaf],
    [stepOf([parent,oldLeaf],[afterParent,newLeaf],[oldLeaf.path])])),false);
});
test('projected root child membership follows proved own-output creation/removal only',()=>{
  const own=file('sql/one.sqlproj','own'),settings=file('sql/settings.json','stable');
  const remove=stepOf([own],[absent(own.path)],[own.path]);
  const f=structural([settings],[settings],[remove]);
  f.sealed.children=['one.sqlproj'];f.current.children=[];
  assert.equal(historicalExternalContextMatches(f),true);
  f.steps[0].after.clear();assert.equal(historicalExternalContextMatches(f),false);
});

test('removing an entire captured root requires proved absence and reconstructs its old context',()=>{
  const own=file('sql/one.sqlproj','own'),external=file('sql/helper.sql','helper');
  const oldRoot={...directory([external]),children:['one.sqlproj']};
  const successorRoot={path:'sql',kind:'directory',mode:493,children:['helper.sql','one.sqlproj']};
  const remove=stepOf([successorRoot,own,external],[absent('sql')],[own.path,external.path]);
  const f={root:'sql',outputs:[own.path],records:[],sealed:oldRoot,current:absent('sql'),steps:[remove]};
  assert.equal(historicalExternalContextMatches(f),true);
  remove.changes.delete(external.path);assert.equal(historicalExternalContextMatches(f),false);
  remove.changes.add(external.path);remove.after.clear();assert.equal(historicalExternalContextMatches(f),false);
});
test('reader accepts proved whole-root removal with different successor projection and rejects foreign deletion',()=>{
  for(const foreign of [false,true]) {
    const own=file('sql/nested/one.sqlproj','own'),external=file('sql/nested/helper.sql','helper');
    const foreignFile=file('sql/nested/foreign.sql','foreign');
    const records=[external,...(foreign?[foreignFile]:[])];
    const aRoot={...directory(records),children:['nested']};
    const aNested={path:'sql/nested',kind:'directory',mode:493,children:['one.sqlproj']};
    const bRoot={path:'sql',kind:'directory',mode:493,children:['nested']};
    const bNested={path:'sql/nested',kind:'directory',mode:493,children:['helper.sql','one.sqlproj']};
    const work=entries=>({format:'stnl-current-work-v1',entries});
    const old=work([aRoot,aNested,own]),now=work([absent('sql')]);
    const pass={formalStatus:'PASS',persistedValidation:'current',openFindings:[],rejection:null};
    const a={deliveryId:'a',targets:[{path:'sql',inventoryOutputs:[own.path]}],
      facts:{...pass,baseline:old,sealedWork:old,verifiedChanges:[],observationMatches:false,observedValidation:'revalidation-required'},
      observation:{manifest:now,externalContexts:new Map()}};
    const b={deliveryId:'b',facts:{...pass,baseline:work([bRoot,bNested,own,external]),sealedWork:now,
      verifiedChanges:[own.path,external.path],observationMatches:true,observedValidation:'current'},observation:{manifest:now}};
    markHistoricalSliceMilestones([a,b]);assert.equal(a.milestoneSatisfied,!foreign);assert.equal(b.milestoneSatisfied,true);
  }
});

test('projected nested own-output additions compose across successors with unchanged external context',()=>{
  const ownA=file('sql/pkg/a.sql','a'),ownB=file('sql/pkg/b.sql','b'),ownC=file('sql/pkg/c.sql','c');
  const root={...directory([]),children:['pkg']};
  const dir=children=>({path:'sql/pkg',kind:'directory',mode:493,children});
  const work=entries=>({format:'stnl-current-work-v1',entries});
  const pass={formalStatus:'PASS',persistedValidation:'current',openFindings:[],rejection:null};
  const old=work([root,dir(['a.sql']),ownA,absent(ownB.path),absent(ownC.path)]);
  const now=work([root,dir(['a.sql','b.sql','c.sql']),ownA,ownB,ownC]);
  const a={deliveryId:'a',facts:{...pass,baseline:old,sealedWork:old,verifiedChanges:[],observationMatches:false,observedValidation:'revalidation-required'},
    observation:{manifest:now,externalContexts:new Map([['sql',{records:[],outputs:[ownA.path,ownB.path,ownC.path]}]])}};
  const successor=(id,leaf)=>({deliveryId:id,facts:{...pass,
    baseline:work([dir([]),absent(leaf.path)]),sealedWork:work([dir([leaf.path.split('/').at(-1)]),leaf]),
    verifiedChanges:[leaf.path],observationMatches:true,observedValidation:'current'},observation:{manifest:now}});
  markHistoricalSliceMilestones([a,successor('b',ownB)]);
  assert.equal(a.milestoneSatisfied,false,'projected child c has no authenticated owning change');
  markHistoricalSliceMilestones([a,successor('b',ownB),successor('c',ownC)]);
  assert.equal(a.milestoneSatisfied,true);
});
