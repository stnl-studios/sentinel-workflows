// Real controller/reader fixtures; authored setup is not a live model qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {inspectEvidence,begin,reserveDispatch,bindNative} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const controller=path.join(repo,'skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
const sha=x=>'sha256:'+createHash('sha256').update(x).digest('hex');
async function snapshot(root){const out={};async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name),s=await fs.lstat(p);if(e.isDirectory())await walk(p);else if(e.isFile())out[path.relative(root,p)]={hash:sha(await fs.readFile(p)),mode:s.mode};else out[path.relative(root,p)]={link:await fs.readlink(p)};}}await walk(root);return out;}
async function fixture(t,options={}){
 const cwd=process.cwd(),temp=await fs.mkdtemp(path.join(repo,'benchmark-temp/evidence-inspection-'));
 process.chdir(temp);let f;
 try{f=await completedNativeCase({after:()=>{}},{drift:false,retire:false,...options});}finally{process.chdir(cwd);}
 t.after(()=>fs.rm(temp,{recursive:true,force:true}));return f;
}
test('quiet evidence index and literal selections authenticate real carriers without writes',async t=>{
 const f=await fixture(t),before=await snapshot(f.root),image=await captureCurrentExecution(f.specPath);
 const continuity=JSON.parse(Buffer.from(image.files.get('continuity.json'))),delivery=continuity.deliveries[0];
 const bundle=JSON.parse(Buffer.from(image.files.get(delivery.evidence.path)));
 const index=await inspectEvidence({specPath:f.specPath,deliveryId:delivery.deliveryId});
 assert.equal(index.selection,'index');assert.equal(index.deliveryInspection.formalStatus,'PASS');assert.equal(index.deliveryInspection.persistedValidation,'current');assert.equal(index.evidenceSha256,sha(image.files.get(delivery.evidence.path)));
 for(const cli of [controller,controller.replace('stnl-slice-executor','stnl-slice-quality-manager')]){const output=execFileSync(process.execPath,[cli,'inspect-evidence','--spec-path',f.specPath,'--delivery-id',delivery.deliveryId],{encoding:'utf8'});assert.deepEqual(JSON.parse(output),index);}
 assert(!JSON.stringify(index).includes('recordUtf8'));assert(!JSON.stringify(index).includes('bytesBase64'));assert(!JSON.stringify(index).includes('ownershipToken'));
 assert(index.records.length>0);assert(index.objects.length>0);
 for(const item of [...bundle.implementation,...bundle.findingsChecks,...(bundle.validation?[bundle.validation]:[]),...bundle.support].filter(x=>x.id)){
  const result=await inspectEvidence({specPath:f.specPath,deliveryId:delivery.deliveryId,recordId:item.id});assert.equal(result.recordUtf8,item.recordUtf8);assert.equal(result.recordSha256,sha(item.recordUtf8));assert.deepEqual(result.origin,item.origin);
 }
 const object=bundle.objects[0],result=await inspectEvidence({specPath:f.specPath,deliveryId:delivery.deliveryId,objectId:object.id});assert.equal(result.bytesBase64,object.bytesBase64);assert.equal(sha(Buffer.from(result.bytesBase64,'base64')),object.id);
 for(const selection of [{deliveryId:'unknown'},{recordId:'absent'},{objectId:sha('absent')},{recordId:'x',objectId:sha('x')}])await assert.rejects(inspectEvidence({specPath:f.specPath,deliveryId:delivery.deliveryId,...selection}));
 assert.deepEqual(await snapshot(f.root),before);
 t.diagnostic(`Authenticated index ${JSON.stringify(index).length} chars vs evidence ${JSON.stringify(bundle).length}; no source rewriting.`);
});
test('active native origin uses same owner and reserved activation; quiet and stale origins fail closed',async t=>{
 const f=await fixture(t,{drift:true,retire:true}),image=await captureCurrentExecution(f.specPath),activation=JSON.parse(Buffer.from(image.activationBytes));
 const start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:activation.activationId});
 const dispatch=await reserveDispatch(start.handle);await bindNative(start.handle,'simulated-read-only-inspector');
 const before=await snapshot(f.root),query={originFile:dispatch.originFile,deliveryId:f.delivery.deliveryId};
 assert.equal((await inspectEvidence(query)).selection,'index');
 const foreign=JSON.parse(Buffer.from(image.files.get('continuity.json'))).completed[0]?.deliveryId;assert(foreign && foreign!==query.deliveryId);
 await assert.rejects(inspectEvidence({...query,deliveryId:foreign}),e=>e.code==='OWNER_MISMATCH');
 await assert.rejects(inspectEvidence({specPath:f.specPath,deliveryId:f.delivery.deliveryId}));
 await assert.rejects(inspectEvidence({...query,specPath:f.specPath}));
 assert.deepEqual(await snapshot(f.root),before);
 const bytes=await fs.readFile(dispatch.originFile),origin=JSON.parse(bytes);origin.admission.reservedActivation.sequence+=1;
 await fs.writeFile(dispatch.originFile,JSON.stringify(origin));const tampered=await snapshot(f.root);
 await assert.rejects(inspectEvidence(query),e=>e.code==='STALE_BASE');assert.deepEqual(await snapshot(f.root),tampered);
 await fs.writeFile(dispatch.originFile,bytes);
 origin.owner.ownershipToken='foreign-owner';await fs.writeFile(dispatch.originFile,JSON.stringify(origin));
 await assert.rejects(inspectEvidence(query),e=>e.code==='OWNER_MISMATCH');await fs.writeFile(dispatch.originFile,bytes);
});
test('corrupt evidence and unknown CLI arguments never return partial evidence or write controls',async t=>{
 const f=await fixture(t),image=await captureCurrentExecution(f.specPath),continuity=JSON.parse(Buffer.from(image.files.get('continuity.json'))),delivery=continuity.deliveries[0];
 const file=path.join(f.image.f.execution,delivery.evidence.path),bytes=await fs.readFile(file),bundle=JSON.parse(bytes);
 bundle.objects[0].bytesBase64=Buffer.from('corrupt').toString('base64');await fs.writeFile(file,JSON.stringify(bundle));const before=await snapshot(f.root);
 await assert.rejects(inspectEvidence({specPath:f.specPath,deliveryId:delivery.deliveryId}));assert.deepEqual(await snapshot(f.root),before);await fs.writeFile(file,bytes);
 for(const args of [['--unexpected','x'],['--record-id','a','--object-id','b'],['--origin-file','absent']]){
  try{execFileSync(process.execPath,[controller,'inspect-evidence','--spec-path',f.specPath,'--delivery-id',delivery.deliveryId,...args],{encoding:'utf8',stdio:'pipe'});assert.fail('invalid argv accepted');}catch(e){assert.equal(e.status,1);assert.equal(JSON.parse(e.stdout).code,'INVALID_ARGUMENTS');}
 }
 assert.deepEqual(await fs.readFile(file),bytes);
 await fs.unlink(file);const missing=await snapshot(f.root);await assert.rejects(inspectEvidence({specPath:f.specPath,deliveryId:delivery.deliveryId}));assert.deepEqual(await snapshot(f.root),missing);
});
