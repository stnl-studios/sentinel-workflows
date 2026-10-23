import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {completedBlockingCase,startCompletedApply,completedApplyRound,publishCompletedApply,completedFormal} from './fixtures/current-completed-findings.mjs';
import {READY_FIXTURE} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
import {currentOperationBindingSha256} from '../skills/workflows/stnl-slice-executor/runtime/execution-current.mjs';
import {inspectPostConversionEvidence} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {retainedCase,retainedOperation,retainedLocalReview} from './fixtures/current-operational-retention.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {publishCandidate} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
const records=image=>[...image.files].filter(([name])=>name.startsWith('evidence/')).flatMap(([,bytes])=>{const b=JSON.parse(Buffer.from(bytes));return [...b.implementation,...b.findingsChecks,...b.support,b.validation].filter(Boolean);});
const close=f=>publishCandidate('CLOSE',path.dirname(f.specPath),null);

const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
async function rejectHistoricalMutations(t,image) {
 const current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
 const original=JSON.parse(Buffer.from(image.files.get(current.evidence.path)));
 const check=bundle=>{
  const bytes=Buffer.from(JSON.stringify(bundle)+'\n');
  return inspectPostConversionEvidence({context:image.context,snapshotBytes:image.files.get('approved-preparation.json'),
   current:{...current,evidence:{...current.evidence,sha256:sha(bytes)}},bundleBytes:bytes,
   observedWork:current.baseline,lastAttempt:JSON.parse(Buffer.from(image.activationBytes)).lastAttempt});
 };
 await check(original);
 function objectMutation(bundle,record,key,change) {
  const id=record.sources[key],object=bundle.objects.find(o=>o.id===id);
  const changed=change(Buffer.from(object.bytesBase64,'base64'));
  const replacement=sha(changed);
  object.id=replacement;object.bytesBase64=changed.toString('base64');
  for(const r of [...bundle.implementation,...bundle.findingsChecks,...bundle.support,bundle.validation].filter(Boolean))
   for(const [field,value]of Object.entries(r.sources))if(value===id)r.sources[field]=replacement;
  bundle.objects.sort((a,b)=>a.id.localeCompare(b.id));
 }
 for(const [label,mutate]of [
  ['missing source',(b,r)=>{b.objects=b.objects.filter(o=>o.id!==r.sources.origin);}],
  ['raw bytes changed with recomputed object digest',(b,r)=>objectMutation(b,r,'rawResponse',bytes=>Buffer.concat([bytes,Buffer.from(' ')]))],
  ['record owner changed',(b,r)=>{r.origin.operationAttemptId='00000000-0000-4000-8000-000000000000';}],
  ['historical round changed',(b,r)=>objectMutation(b,r,'origin',bytes=>{const cap=JSON.parse(bytes),origin=JSON.parse(cap.originUtf8);origin.attempt=2;cap.originUtf8=JSON.stringify(origin);return Buffer.from(JSON.stringify(cap));})],
  ['historical admission owner changed',(b,r)=>objectMutation(b,r,'origin',bytes=>{const cap=JSON.parse(bytes),origin=JSON.parse(cap.originUtf8);origin.admission.binding.owner.operationAttemptId='00000000-0000-4000-8000-000000000000';cap.originUtf8=JSON.stringify(origin);return Buffer.from(JSON.stringify(cap));})],
  ['repacked incomplete A0/A1 admission',(b,r)=>objectMutation(b,r,'origin',bytes=>{const cap=JSON.parse(bytes),origin=JSON.parse(cap.originUtf8);origin.admission={baseActivation:{artifacts:origin.admission.baseActivation.artifacts,approvedSnapshotSha256:origin.admission.baseActivation.approvedSnapshotSha256}};cap.originUtf8=JSON.stringify(origin);return Buffer.from(JSON.stringify(cap));})],
  ['A0 relabel with a rehashed binding',(b,r)=>objectMutation(b,r,'origin',bytes=>{
   const cap=JSON.parse(bytes),origin=JSON.parse(cap.originUtf8),admission=origin.admission;
   admission.baseActivation.activationId='00000000-0000-4000-8000-000000000000';
   admission.reservedActivation.previousActivationId=admission.baseActivation.activationId;
   admission.binding.baseActivationId=admission.baseActivation.activationId;
   admission.reservedActivation.activeAttempt.operationRef.allocationSha256=currentOperationBindingSha256(admission.binding);
   cap.originUtf8=JSON.stringify(origin);return Buffer.from(JSON.stringify(cap));
  })],
  ['A0 preparation differs from reservation',(b,r)=>objectMutation(b,r,'origin',bytes=>{
   const cap=JSON.parse(bytes),origin=JSON.parse(cap.originUtf8);origin.admission.baseActivation.preparationRevision++;
   cap.originUtf8=JSON.stringify(origin);return Buffer.from(JSON.stringify(cap));
  })],
  ['historical snapshot changed',(b,r)=>objectMutation(b,r,'origin',bytes=>{const cap=JSON.parse(bytes),origin=JSON.parse(cap.originUtf8);origin.admission.baseActivation.approvedSnapshotSha256='sha256:'+'0'.repeat(64);cap.originUtf8=JSON.stringify(origin);return Buffer.from(JSON.stringify(cap));})],
  ['unsupported extra object',(b)=>{const bytes=Buffer.from('foreign');b.objects.push({id:sha(bytes),bytesBase64:bytes.toString('base64')});b.objects.sort((a,b)=>a.id.localeCompare(b.id));}],
 ])await t.test(label,async()=>{
  const bundle=structuredClone(original),record=bundle.support.find(r=>r.kind==='validation');
  assert.ok(record,'fixture must retain a historical formal');mutate(bundle,record);
  await assert.rejects(check(bundle));
 });
}
async function rejectRetirementMutations(t,f,result) {
 const ownerFile=path.join(path.dirname(result.dispatch.originFile),'owner.json'),original=await fs.readFile(ownerFile);
 const image=await captureCurrentExecution(f.specPath);
 for(const [label,change]of [
  ['uncertain owner',r=>{r.phase='activation_written';}],
  ['exhausted refusal',r=>{r.terminalTransition.normalization.status='exhausted';}],
  ['foreign normalization cause',r=>{r.terminalTransition.normalization.causeSha256='sha256:'+'0'.repeat(64);}],
  ['foreign normalization source',r=>{r.terminalTransition.normalization.sourceOperationAttemptId='00000000-0000-4000-8000-000000000000';}],
  ['incorrect captured round',r=>{r.runner.round=2;r.runner.consumedInvocations=2;}],
 ])await t.test(label,async()=>{
  const record=JSON.parse(original);change(record);
  try{await fs.writeFile(ownerFile,JSON.stringify(record)+'\n');await assert.rejects(close(f));}
  finally{await fs.writeFile(ownerFile,original);}
  assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,image.activationBytes);
 });
 const response=result.dispatch.originFile.replace(/\.origin\.json$/u,'.response.json'),raw=await fs.readFile(response);
 await t.test('private captured bytes cannot diverge from official replica',async()=>{
  try{await fs.writeFile(response,Buffer.concat([raw,Buffer.from(' ')]));await assert.rejects(close(f));}
  finally{await fs.writeFile(response,raw);}
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,image.files);
 });
}

test('retirement retains a concluded formal refusal through local review and bounded successor CLOSE',async t=>{
 const f=await retainedCase(t);
 const rejected=await normalizedFormal(f,{invalid:true,responseVariant:'stnl-current-native-judgment-v1'});
 await normalizedFormal(f,{successor:true,responseVariant:'stnl-current-native-judgment-v1'});
 const before=records(await captureCurrentExecution(f.specPath));
 await retainedLocalReview(f);
 const after=records(await captureCurrentExecution(f.specPath));
 for(const record of before)assert.ok(after.some(r=>r.origin.operationAttemptId===record.origin.operationAttemptId));
 await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
 const image=await captureCurrentExecution(f.specPath);
 assert.equal(image.inspection.state,'COMPLETE');
 assert.ok(records(image).some(r=>r.kind==='rejection'&&r.operationAttemptId===rejected.start.owner.operationAttemptId));
 await rejectHistoricalMutations(t,image);
 await rejectRetirementMutations(t,f,rejected);
 const receipt=await close(f);assert.equal(receipt.publication,'confirmed');assert.equal(receipt.cleanup,'complete');
});

test('two converted APPLY cycles retain operational captures and resolved findings through recovery and CLOSE',async t=>{
 const f=await retainedCase(t);const attempts=[];
 for(const stage of [
  {status:'NEEDS_FIX',edit:'broken',newId:'finding-01',refs:'finding-01',dispositions:'finding-01=active'},
  {op:'APPLY_FINDINGS',status:'TESTS_PASS',edit:'hello',verified:'finding-01'},
  {status:'NEEDS_FIX',edit:'broken again',newId:'finding-02',refs:'finding-01, finding-02',dispositions:'finding-01=resolved, finding-02=active'},
  {op:'APPLY_FINDINGS',status:'TESTS_PASS',edit:'hello',verified:'finding-02',terminalFault:true},
  {status:'PASS',terminal:true,refs:'finding-02',dispositions:'finding-02=resolved'},
 ]) {
  const result=await retainedOperation(f,stage);attempts.push(result.started.owner.operationAttemptId);
  const image=await captureCurrentExecution(f.specPath),seen=records(image).map(r=>r.origin.operationAttemptId);
  for(const id of attempts)assert.ok(seen.includes(id),'previous operational capture must remain official');
  if(stage.op==='APPLY_FINDINGS'&&attempts.length===4){
   const carrier=Buffer.from(image.files.get(`tasks/${f.delivery.slice}.md`)).toString();
   assert.match(carrier,/finding-01[\s\S]*?- State: resolved/);
   assert.match(carrier,/finding-02[\s\S]*?- State: active/);
  }
 }
 const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.state,'COMPLETE');
 await rejectHistoricalMutations(t,final);
 const receipt=await close(f);assert.equal(receipt.publication,'confirmed');assert.equal(receipt.cleanup,'complete');
});

test('private review preserves an entire closed APPLY episode through a pure formal replacement and CLOSE',async t=>{
 const f=await retainedCase(t);
 for(const stage of [
  {status:'NEEDS_FIX',edit:'broken',newId:'finding-01',refs:'finding-01',dispositions:'finding-01=active'},
  {op:'APPLY_FINDINGS',status:'TESTS_PASS',edit:'hello',verified:'finding-01'},
  {status:'PASS',refs:'finding-01',dispositions:'finding-01=resolved'},
 ])await retainedOperation(f,stage);
 await retainedLocalReview(f);
 await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
 const image=await captureCurrentExecution(f.specPath);assert.equal(image.inspection.state,'COMPLETE');
 await rejectHistoricalMutations(t,image);
 const receipt=await close(f);assert.equal(receipt.publication,'confirmed');assert.equal(receipt.cleanup,'complete');
});

test('bounded normalized APPLY episode retires its refusal and successor through integral CLOSE',async t=>{
 const f=await completedBlockingCase(t,{documentarySource:READY_FIXTURE}),first=await startCompletedApply(f);
 await completedApplyRound(f,first,{invalid:true});await publishCompletedApply(first);
 const successor=await startCompletedApply(f,{successor:true});
 await completedApplyRound(f,successor,{edit:'export const greeting="hello";\n'});await publishCompletedApply(successor);
 await completedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1',references:'finding-01',dispositions:'finding-01=resolved'});
 assert.equal((await captureCurrentExecution(f.specPath)).inspection.state,'COMPLETE');
 const receipt=await close(f);assert.equal(receipt.publication,'confirmed');assert.equal(receipt.cleanup,'complete');
});
