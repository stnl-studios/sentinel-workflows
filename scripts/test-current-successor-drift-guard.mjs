import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

// Isolate the exact private admission predicate without exporting a production
// test hook. The full controller regression is in Initial native operations.
const runtime=new URL('../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs',import.meta.url);
const source=await fs.readFile(runtime,'utf8');
const start=source.indexOf('async function initialSuccessorOwnsDrift('),end=source.indexOf('async function requireInitial(',start);
assert.ok(start>=0&&end>start);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const predicate=Function('parseCurrentJson','MAX_NATIVE_PRODUCER_TURNS','same','verifyWorkObservation','path','verifyInitialStructuralAdditions','isDeepStrictEqual',
  source.slice(start,end)+'\nreturn initialSuccessorOwnsDrift;');
const bytes=value=>Buffer.from(JSON.stringify(value));
const file=(name,hash)=>({path:name,kind:'file',sha256:hash,mode:420});
function fixture({area={kind:'file',path:'src/owned.mjs'},inputs=[]}={}) {
  const before={format:'stnl-current-work-v1',entries:[{path:'src',kind:'directory',children:['owned.mjs']},file('src/owned.mjs','old')]};
  const after=structuredClone(before);after.entries[1].sha256='changed';
  const prior={deliveryId:'prior',slice:'slice-01',evidence:{path:'prior.json'}};
  const current={deliveryId:'current',slice:'slice-02',evidence:{},baseline:structuredClone(before),
    normalization:{operation:'EXECUTE_SLICE',status:'settled',consumedInvocations:1,sourceOperationAttemptId:'attempt'},
    lastDiagnostic:{operationAttemptId:'attempt'}};
  const continuity={deliveries:[prior,current]};
  const image={context:{},activation:{lastAttempt:{outcome:'rejected',operation:'EXECUTE_SLICE',deliveryId:'current',operationAttemptId:'attempt'}},
    files:new Map([['approved-preparation.json',bytes({normativeProjection:{deliveries:[{deliveryId:'current'}]}})],
      ['prior.json',bytes({validation:{testedWork:before}})]]),
    inspection:{deliveries:[{deliveryId:'prior',observedValidation:'revalidation-required',formalStatus:'PASS'}]},
    observedByDelivery:new Map([['prior',{manifest:after}],['current',{manifest:structuredClone(after)}]])};
  return {image,current,continuity,before,after,
    check:()=>predicate(JSON.parse,5,same,()=>({areas:[area],inputs}),path,async()=>true,isDeepStrictEqual)(image,current,continuity)};
}
function add(f,name,{own=false}={}) {
  f.after.entries[0].children.push(name.slice(4));f.after.entries.push(file(name,'new'));
  if(own)f.image.observedByDelivery.set('current',{manifest:structuredClone(f.after)});
}

test('owned existing file delta admits its exact rejected EXECUTE successor',async()=>assert.equal(await fixture().check(),true));
test('new unowned package metadata cannot hide behind an owned file delta',async()=>{
  const f=fixture();add(f,'src/package.json');assert.equal(await f.check(),false);
});
test('broad output directory alone does not prove ownership of newly added package metadata',async()=>{
  const f=fixture({area:{kind:'directory',path:'src'}});add(f,'src/package.json',{own:true});assert.equal(await f.check(),false);
});
for(const name of ['src/shadow.mjs','src/discovered.test.mjs'])test(`new ${name} outside exact file authority denies shortcut`,async()=>{
  const f=fixture();add(f,name);assert.equal(await f.check(),false);
});
test('input delta is never attributed to output scope',async()=>{
  assert.equal(await fixture({area:{kind:'directory',path:'src'},inputs:[{kind:'input',path:'src/owned.mjs'}]}).check(),false);
});
test('new directory cannot hide behind a changed authorized file',async()=>{
  const f=fixture({area:{kind:'directory',path:'src'}});
  f.after.entries[0].children.push('nested');f.after.entries.push({path:'src/nested',kind:'directory',children:[]});
  f.image.observedByDelivery.set('current',{manifest:structuredClone(f.after)});
  assert.equal(await f.check(),false);
});
test('own observation must match the entire attributed file state',async()=>{
  const f=fixture();f.image.observedByDelivery.get('current').manifest.entries[1].sha256='different';assert.equal(await f.check(),false);
});
test('foreign rejection identity cannot use the drift exception',async()=>{
  const f=fixture();f.image.activation.lastAttempt.operationAttemptId='foreign';assert.equal(await f.check(),false);
});
test('new explicitly approved file requires captured absence and matching own observation',async()=>{
  const f=fixture({area:{kind:'file',path:'src/new.mjs'}});
  f.after.entries[1].sha256='old';add(f,'src/new.mjs',{own:true});
  assert.equal(await f.check(),false);
  f.current.baseline.entries.push({path:'src/new.mjs',kind:'absent'});
  assert.equal(await f.check(),true);
});

function markedContext(f) {
  f.before.entries[0].externalContextSha256='sha256:'+'1'.repeat(64);
  f.after.entries[0].externalContextSha256='sha256:'+'2'.repeat(64);
  f.image.files.set('prior.json',bytes({validation:{testedWork:f.before}}));
  f.current.baseline.entries[0].externalContextSha256='sha256:'+'3'.repeat(64);
  f.image.observedByDelivery.get('current').manifest.entries[0].externalContextSha256='sha256:'+'3'.repeat(64);
  return f;
}
test('changed sibling fingerprint is explained only by a stable exact own context root',async()=>{
  assert.equal(await markedContext(fixture()).check(),true);
});
for(const fault of ['changed','missing-baseline','missing-observation'])test(`existing root successor rejects ${fault} own context`,async()=>{
  const f=markedContext(fixture());
  if(fault==='changed')f.image.observedByDelivery.get('current').manifest.entries[0].externalContextSha256='sha256:'+'4'.repeat(64);
  if(fault==='missing-baseline')delete f.current.baseline.entries[0].externalContextSha256;
  if(fault==='missing-observation')delete f.image.observedByDelivery.get('current').manifest.entries[0].externalContextSha256;
  assert.equal(await f.check(),false);
});

test('projected sibling need not contain the exact owned output explained by shared context',async()=>{
  const f=markedContext(fixture());
  f.before.entries=f.before.entries.filter(entry=>entry.path!=='src/owned.mjs');f.before.entries[0].children=[];
  f.after.entries=f.after.entries.filter(entry=>entry.path!=='src/owned.mjs');f.after.entries[0].children=[];
  f.image.files.set('prior.json',bytes({validation:{testedWork:f.before}}));
  f.image.observedByDelivery.set('prior',{manifest:f.after});
  assert.equal(await f.check(),true);
  f.image.observedByDelivery.get('current').manifest.entries[0].externalContextSha256='sha256:'+'4'.repeat(64);
  assert.equal(await f.check(),false,'hidden external change cannot ride the owned output');
});
