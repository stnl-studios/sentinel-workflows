// Offline documentation checks only: no Sentinel authority, provider or model execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=bytes=>'sha256:'+sha256(bytes);
const plain=value=>JSON.parse(JSON.stringify(value));
const docs=['stnl-slice-executor','stnl-slice-quality-manager'].map(skill=>new URL(`../skills/workflows/${skill}/references/runner-invocation.md`,import.meta.url));
function example(file){
 const text=fs.readFileSync(file,'utf8');
 const blocks=[...text.matchAll(/<!-- evidence-navigation-example:start -->\s*```javascript\n([\s\S]*?)\n```\s*<!-- evidence-navigation-example:end -->/g)];
 assert.equal(blocks.length,1,'exactly one executable documented example required');
 return blocks[0][1];
}
function fixture(){
 const utf8='# Reviewed plan\n'+ 'Concrete requirement and test evidence.\n'.repeat(250);
 const bytes=Buffer.from(JSON.stringify({status:'PASS',evidence:'Sanitized historical evidence. '.repeat(400)}));
 const taskUtf8='# Reviewed task\n'+ 'Independent acceptance obligation.\n'.repeat(120);
 return {snapshot:{reviewedArtifacts:[{path:'plan.md',utf8,sha256:digest(utf8)},{path:'tasks/slice-01.md',utf8:taskUtf8,sha256:digest(taskUtf8)}],legacyPayload:'Old presentation payload. '.repeat(300),normativeProjection:{requirements:[{id:'R-001',text:'Preserve existing behavior'}]}},bundle:{objects:[{id:digest(bytes),bytesBase64:bytes.toString('base64')}]},bytes};
}
function invoke(code,snapshot,bundle){
 return vm.runInNewContext(code+'\nevidenceNavigation(snapshot,bundle,sha256)',{Buffer,snapshot,bundle,sha256},{timeout:1000});
}
function frozen(value){if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;}
test('both distributed guidance examples remain identical',()=>assert.equal(example(docs[0]),example(docs[1])));
for(const file of docs){const name=file.pathname.split('/').at(-3);
 test(`${name}: execute documented selection, preserve exact content and originals`,t=>{
  const code=example(file),{snapshot,bundle,bytes}=fixture();const before=JSON.stringify({snapshot,bundle});frozen(snapshot);frozen(bundle);
  const result=invoke(code,snapshot,bundle),index=plain(result);
  assert.deepEqual(index,{reviewedArtifacts:snapshot.reviewedArtifacts.map(({path,sha256})=>({path,sha256})),objects:bundle.objects.map(({id})=>({id}))});
  assert(Buffer.isBuffer(result.readObject(bundle.objects[0].id)));assert.deepEqual(result.readObject(bundle.objects[0].id),bytes);
  assert.equal(JSON.stringify({snapshot,bundle}),before);
  const after=JSON.stringify(index).length;
  assert(after<before.length/10,'navigation display must remove repeated payload, not source data');
  assert.equal(Object.hasOwn(index,'legacyPayload'),false,'positive selection excludes unrelated fields without guessing their names');
  t.diagnostic(`Synthetic presentation characters: before=${before.length}, after=${after}, removed=${before.length-after}. Original source bytes remain intact.`);
  t.diagnostic('Navigation only: does not semantically validate normativeProjection or authenticate the complete snapshot; official validation remains required.');
  assert.equal(sha256(Buffer.from(snapshot.reviewedArtifacts[0].utf8)),snapshot.reviewedArtifacts[0].sha256.slice(7));
 });
 test(`${name}: missing or corrupt snapshot fields and duplicate identities fail explicitly`,()=>{
  const changes=[x=>delete x.snapshot.reviewedArtifacts,x=>x.snapshot.reviewedArtifacts=[],x=>delete x.snapshot.normativeProjection,x=>x.snapshot.normativeProjection=[],x=>delete x.snapshot.reviewedArtifacts[0].utf8,x=>x.snapshot.reviewedArtifacts[0].utf8+='changed',x=>x.snapshot.reviewedArtifacts[0].sha256=digest('wrong'),x=>x.snapshot.reviewedArtifacts.push({...x.snapshot.reviewedArtifacts[0]}),x=>delete x.bundle.objects,x=>x.bundle.objects.push({...x.bundle.objects[0]}),x=>delete x.bundle.objects[0].bytesBase64,x=>x.bundle.objects[0].id='not-a-digest'];
  for(const change of changes){const x=fixture();change(x);const before=JSON.stringify(x);assert.throws(()=>invoke(example(file),x.snapshot,x.bundle),/EVIDENCE_NAVIGATION_INVALID/);assert.equal(JSON.stringify(x),before);}
 });
 test(`${name}: selected object missing, noncanonical base64 or hash mismatch cannot masquerade as verified`,()=>{
  for(const corrupt of [x=>x.bundle.objects[0].bytesBase64+='!',x=>x.bundle.objects[0].bytesBase64+='\n',x=>x.bundle.objects[0].bytesBase64=Buffer.from('changed').toString('base64'),x=>x.bundle.objects[0].id=digest('foreign')]){
   const x=fixture();corrupt(x);const before=JSON.stringify(x);const result=invoke(example(file),x.snapshot,x.bundle);
   // Index creation does NOT authenticate unselected object bytes. Reading must fail.
   assert.throws(()=>result.readObject(x.bundle.objects[0].id),/EVIDENCE_NAVIGATION_INVALID/);assert.equal(JSON.stringify(x),before);
  }
  const x=fixture(),result=invoke(example(file),x.snapshot,x.bundle);assert.throws(()=>result.readObject(digest('absent')),/EVIDENCE_NAVIGATION_INVALID/);
 });
}

test('navigation does not claim semantic validation of normativeProjection or full snapshot',()=>{
 const x=fixture();x.snapshot.normativeProjection={unexpectedSemanticField:'not an approved semantic schema'};
 for(const file of docs){const result=invoke(example(file),x.snapshot,x.bundle);assert.equal(result.reviewedArtifacts.length,2);assert.equal(Object.hasOwn(result,'validSnapshot'),false);assert.equal(Object.hasOwn(result,'approved'),false);}
});
