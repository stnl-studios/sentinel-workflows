import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {captureCurrentExecution,validateCurrentReviewCandidate} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {captureCurrentSetReplacementSource} from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
const decode=bytes=>JSON.parse(Buffer.from(bytes));

test('historical complete criteria need no extra terminal judgment and still reject forged evidence',async t=>{
  const f=await completedNativeCase(t,{retire:false,drift:false});
  const before=await captureCurrentExecution(f.specPath);
  assert.ok(before.inspection.deliveries.every(x=>x.formalStatus==='PASS'&&x.observedValidation==='current'));
  assert.equal(before.inspection.state,'COMPLETE');
  const approved=decode(before.files.get('approved-preparation.json'));
  assert.equal(approved.normativeProjection.deliveries[0].obligations[0].contribution,'partial');
  assert.equal(approved.normativeProjection.deliveries[1].obligations[0].contribution,'complete');
  assert.deepEqual(before.inspection.diagnostics,[]);
  assert.equal(before.inspection.normalHandoff,null);
  assert.deepEqual((await captureCurrentSetReplacementSource(f.specPath)).activationBytes,before.activationBytes);
  // Rehash a forged local observation, while retaining every carrier identity.
  // Invalid proof must fail authentication, not be admitted as missing terminal.
  const files=new Map([...before.files].map(([name,bytes])=>[name,Buffer.from(bytes)]));
  const book=decode(files.get('continuity.json')),selected=book.deliveries.find(x=>x.deliveryId===f.delivery.deliveryId);
  const old=selected.evidence.sha256,bundle=decode(files.get(selected.evidence.path));
  const object=bundle.objects.find(x=>x.id===bundle.validation.sources.verificationObservation);
  const observation=decode(Buffer.from(object.bytesBase64,'base64'));
  observation.executionContext.invocation.binding.originSha256='sha256:'+'f'.repeat(64);
  const bytes=Buffer.from(JSON.stringify(observation)+'\n');
  const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
  object.id=sha(bytes);object.bytesBase64=bytes.toString('base64');
  bundle.validation.sources.verificationObservation=object.id;bundle.objects.sort((a,b)=>a.id.localeCompare(b.id));
  const changed=Buffer.from(JSON.stringify(bundle)+'\n');selected.evidence.sha256=sha(changed);
  files.set(selected.evidence.path,changed);files.set('continuity.json',Buffer.from(JSON.stringify(book)+'\n'));
  const task='tasks/'+selected.slice+'.md';files.set(task,Buffer.from(files.get(task).toString().replaceAll(old,selected.evidence.sha256)));
  await assert.rejects(()=>validateCurrentReviewCandidate({specPath:f.specPath,files}),
    e=>e.message==='native replay invocation identity: binding differs');
  const after=await captureCurrentExecution(f.specPath);
  assert.deepEqual(after.files,before.files);
  assert.deepEqual(after.activationBytes,before.activationBytes);
});

test('independent complete owners reuse their approved criteria without another terminal operation',async t=>{
  const f=await completedNativeCase(t,{retire:false,drift:false,independent:true});
  const current=await captureCurrentExecution(f.specPath);
  assert.equal(current.inspection.normalHandoff,null);
  assert.ok(current.inspection.deliveries.every(x=>x.formalStatus==='PASS'));
  assert.equal(current.inspection.state,'COMPLETE');
  assert.deepEqual((await captureCurrentSetReplacementSource(f.specPath)).activationBytes,current.activationBytes);
});

test('historical complete coverage does not reopen retired owners',async t=>{
  const {retireActive}=await import('./fixtures/current-reader-campaign.mjs');
  const f=await completedNativeCase(t,{retire:false,drift:false});
  await retireActive(f.view,['slice-01','slice-02']);
  const current=await captureCurrentExecution(f.specPath);
  assert.equal(current.inspection.state,'COMPLETE');
  assert.equal(current.inspection.normalHandoff,null);
});

test('missing terminal source gate refuses local drift and corrupt current carriers',async t=>{
  const f=await completedNativeCase(t,{retire:true,drift:false,independent:true});
  const before=await captureCurrentSetReplacementSource(f.specPath);
  const product=f.root+'/'+f.productFile,original=await fs.readFile(product);
  await fs.appendFile(product,'// unvalidated change\n');
  await assert.rejects(()=>captureCurrentSetReplacementSource(f.specPath),e=>['REPLAN_REQUIRED','EVIDENCE_STALE'].includes(e.code));
  await fs.writeFile(product,original);
  const continuity=decode(before.files.get('continuity.json'));
  const evidence=f.image.f.execution+'/'+continuity.deliveries[0].evidence.path;
  const bytes=await fs.readFile(evidence);await fs.writeFile(evidence,'{}\n');
  await assert.rejects(()=>captureCurrentSetReplacementSource(f.specPath));
  await fs.writeFile(evidence,bytes);
  assert.deepEqual((await captureCurrentSetReplacementSource(f.specPath)).activationBytes,before.activationBytes);
});
