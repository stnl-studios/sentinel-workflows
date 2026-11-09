import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ChildProcess,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution,captureCurrentActiveExecution,validateCurrentReviewCandidate,currentTerminalProductBasisMatches} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,publish} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {prepareCurrentLocalReview,finalizeCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {finding} from './fixtures/current-validation-evidence.mjs';
import {retireActive} from './fixtures/current-reader-campaign.mjs';

const decode=bytes=>JSON.parse(Buffer.from(bytes));
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const run=promisify(execFile);
const invalid=error=>['EVIDENCE_STALE','EVIDENCE_INCOMPLETE','INVALID_CURRENT_IMAGE','OWNER_UNCERTAIN','RUNNER_RESULT_REJECTED'].includes(error.code);

async function privateReview(f,image,slice) {
  const snapshot=decode(image.files.get('approved-preparation.json'));
  const revise=value=>Buffer.from(value).toString('utf8').replace('- Local revision: 1','- Local revision: 2');
  const proposal=prepareCurrentLocalReview({context:image.context,requirementsAuthority:image.requirementsAuthority,
    previous:{activationBytes:image.activationBytes,files:image.files},slice,
    planBytes:Buffer.from(revise(image.files.get(`plans/${slice}.md`)).replace(/(## Risks and Strategy\n\n)/u,'$1- Explicit private reviewed strategy.\n')),
    reviewedTaskBytes:Buffer.from(revise(snapshot.reviewedArtifacts.find(item=>item.path===`tasks/${slice}.md`).utf8)),
    currentTaskBytes:Buffer.from(revise(image.files.get(`tasks/${slice}.md`)))});
  const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled private review: only the selected private strategy changes.',
    evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'The exact selected historical proof requires new validation; independent contributions remain current.'}))};
  const next=finalizeCurrentLocalReview({proposal,review}),approved=decode(next.files.get('approved-preparation.json'));
  const activation={...decode(image.activationBytes),previousActivationId:image.inspection.activationId,activationId:randomUUID(),
    sequence:image.inspection.sequence+1,preparationRevision:approved.preparationRevision,normativeSha256:approved.normativeSha256,
    approvedSnapshotSha256:sha(next.files.get('approved-preparation.json')),lastAttempt:null,
    artifacts:[...next.files].map(([path,bytes])=>({path,sha256:sha(bytes)})).sort((a,b)=>a.path<b.path?-1:1)};
  for(const [name,bytes]of next.files)await fs.writeFile(path.join(f.image.f.execution,name),bytes);
  await fs.writeFile(path.join(f.image.f.execution,'activation.json'),json(activation));
}

// Controlled captures in disposable workspaces only; this suite never invokes
// a model and is not evidence for the separate real native acceptance block.
function changedCapture(image,edit) {
  const files=new Map([...image.files].map(([name,bytes])=>[name,Buffer.from(bytes)]));
  const continuity=decode(files.get('continuity.json')),current=continuity.deliveries[0];
  const old=current.evidence.sha256,bundle=decode(files.get(current.evidence.path));
  edit(bundle);
  const next=json(bundle);current.evidence.sha256=sha(next);files.set(current.evidence.path,next);
  files.set('continuity.json',json(continuity));
  const task=`tasks/${current.slice}.md`;
  files.set(task,Buffer.from(files.get(task).toString('utf8').replaceAll(old,current.evidence.sha256)));
  return files;
}
function changedSource(bundle,name,edit) {
  const object=bundle.objects.find(item=>item.id===bundle.validation.sources[name]);
  const value=decode(Buffer.from(object.bytesBase64,'base64'));edit(value);
  const bytes=json(value);object.id=sha(bytes);object.bytesBase64=bytes.toString('base64');
  bundle.validation.sources[name]=object.id;bundle.objects.sort((a,b)=>a.id<b.id?-1:1);
}
function changedBasis(image,edit) {
  return changedCapture(image,bundle=>changedSource(bundle,'origin',capsule=>{
    const origin=JSON.parse(capsule.originUtf8);edit(origin);
    capsule.originUtf8=JSON.stringify(origin)+'\n';capsule.dispatchUtf8=capsule.originUtf8;
  }));
}

test('T01 terminal v2 preserves valid certification and rejects post-capture product-basis tampering',async t=>{
  const f=await completedNativeCase(t);await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const image=await captureCurrentExecution(f.specPath),a=image.inspection.completed[0];
  assert.equal(image.inspection.state,'COMPLETE');assert.equal(image.observedByDelivery.size,2);
  assert.ok(image.observedByDelivery.has(a.deliveryId));
  const cases={
    'missing completed witness (old block1 binding remains local)':o=>{o.otherDeliveryWork=[];},
    'duplicate witness':o=>{o.otherDeliveryWork.push(structuredClone(o.otherDeliveryWork[0]));},
    'null witness':o=>{o.otherDeliveryWork[0]=null;},
    'primitive witness':o=>{o.otherDeliveryWork[0]='foreign';},
    'different captured product hash':o=>{o.otherDeliveryWork[0].manifest.entries.find(x=>x.kind==='file').sha256='sha256:'+'f'.repeat(64);},
    'different captured directory membership':o=>{o.otherDeliveryWork[0].manifest.entries.find(x=>x.kind==='directory').children=[];},
    'different captured file mode':o=>{o.otherDeliveryWork[0].manifest.entries.find(x=>x.kind==='file').mode=0;},
  };
  const continuity=decode(image.files.get('continuity.json')),selected=continuity.deliveries[0];
  const bundle=decode(image.files.get(selected.evidence.path));
  const capsule=decode(Buffer.from(bundle.objects.find(item=>item.id===bundle.validation.sources.origin).bytesBase64,'base64'));
  const origin=JSON.parse(capsule.originUtf8);
  const observed=decode(Buffer.from(bundle.objects.find(item=>item.id===bundle.validation.sources.verificationObservation).bytesBase64,'base64'));
  assert.equal(observed.executionContext.format,'stnl-same-operation-context-v1');
  assert.equal(observed.executionContext.invocation.binding.originSha256,sha(Buffer.from(capsule.originUtf8)));
  const unchanged=await validateCurrentReviewCandidate({specPath:f.specPath,files:image.files});
  assert.equal(unchanged.state,'COMPLETE');assert.equal(unchanged.normalHandoff,null);
  assert.equal(unchanged.deliveries[0].formalStatus,'PASS');assert.equal(unchanged.deliveries[0].observedValidation,'current');
  assert.equal(unchanged.completed[0].observedValidation,'current');
  // Unit coverage of the semantic comparison is deliberately separate from the
  // public reader. The latter must reject tampered v2 captures before reaching
  // this comparison; neither layer rewrites or removes the invocation binding.
  const others=[{deliveryId:a.deliveryId,slice:a.slice,initialObservation:true,
    observation:{manifest:structuredClone(image.observedByDelivery.get(a.deliveryId).manifest)}}];
  assert.equal(currentTerminalProductBasisMatches(origin.otherDeliveryWork,others),true);
  for(const [name,edit]of Object.entries(cases)) {
    await t.test(`semantic basis comparison: ${name}`,()=>{
      const authored=structuredClone(origin),before=structuredClone(others);edit(authored);
      assert.equal(currentTerminalProductBasisMatches(authored.otherDeliveryWork,others),false);
      assert.deepEqual(others,before);
    });
    await t.test(`public reader rejects post-capture tampering: ${name}`,async()=>{
      await assert.rejects(()=>validateCurrentReviewCandidate({specPath:f.specPath,files:changedBasis(image,edit)}),
        error=>error.code==='OWNER_MISMATCH'&&error.message==='native replay invocation identity: binding differs');
    });
  }
  for(const [name,edit]of Object.entries({
    'owner':invocation=>{invocation.binding.owner.ownershipToken=randomUUID();},
    'request':invocation=>{invocation.binding.requestSha256='sha256:'+'0'.repeat(64);},
    'output path':invocation=>{invocation.outputFile=path.join(path.dirname(invocation.outputFile),'foreign.verification.json');},
  }))await t.test(`public reader rejects rehashed invocation ${name}`,async()=>{
    const files=changedCapture(image,bundle=>changedSource(bundle,'verificationObservation',observation=>{
      edit(observation.executionContext.invocation);
      observation.executionContext.invocationSha256=sha(Buffer.from(canonical(observation.executionContext.invocation)));
    }));
    await assert.rejects(()=>validateCurrentReviewCandidate({specPath:f.specPath,files}),
      error=>error.code==='OWNER_MISMATCH'&&error.message==='native replay invocation identity: binding differs');
  });
  const after=await captureCurrentExecution(f.specPath);
  assert.equal(after.inspection.state,'COMPLETE');assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(after.inspection.deliveries[0].observedValidation,'current');
  assert.equal(after.inspection.completed[0].observedValidation,'current');
  assert.deepEqual(after.files,image.files);assert.deepEqual(after.activationBytes,image.activationBytes);
});

test('T01 newer local revalidation preserves local PASS but invalidates the retained retired terminal judgment',async t=>{
  const f=await completedNativeCase(t,{retire:false,independent:true});
  await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const before=await captureCurrentExecution(f.specPath);assert.equal(before.inspection.state,'COMPLETE');
  const continuity=decode(before.files.get('continuity.json')),sibling=continuity.deliveries[0];
  const terminal=continuity.deliveries.find(item=>item.deliveryId===f.delivery.deliveryId);
  const snapshot=decode(before.files.get('approved-preparation.json'));
  // Author a reviewed completed integral owner, preserving its exact native
  // proof. The remaining independent contribution is then revalidated through
  // the real producer; no origin or invocation fingerprint is rewritten.
  await retireActive({project:f.root,execution:f.image.f.execution,specPath:f.specPath,source:f.specPath,
    spec:path.dirname(f.specPath),authority:before.requirementsAuthority,activation:decode(before.activationBytes),
    snapshot,continuity,files:new Map([...before.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),
    artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8)]))},[terminal.slice]);
  const retired=await captureCurrentExecution(f.specPath);assert.equal(retired.inspection.state,'COMPLETE');
  await fs.appendFile(path.join(f.root,'src/greeting.mjs'),'// independently validated sibling delta\n');
  await normalizedFormal({...f,delivery:sibling});
  const after=await captureCurrentExecution(f.specPath);
  assert.ok([...after.inspection.deliveries,...after.inspection.completed]
    .every(item=>item.formalStatus==='PASS'&&item.observedValidation==='current'));
  assert.equal(after.inspection.state,'VALIDATION_BLOCKED');assert.equal(after.inspection.normalHandoff,null);
  assert.equal(after.inspection.diagnostics[0].reason,'EVIDENCE_STALE: terminal judgment precedes current local validation');
  const terminalBundle=decode(after.files.get(terminal.evidence.path));
  const siblingBundle=decode(after.files.get(sibling.evidence.path));
  assert.ok(siblingBundle.validation.origin.preparationRevision>terminalBundle.validation.origin.preparationRevision);
  const capsule=decode(Buffer.from(terminalBundle.objects.find(item=>item.id===terminalBundle.validation.sources.origin).bytesBase64,'base64'));
  const origin=JSON.parse(capsule.originUtf8);
  const others=image=>[{deliveryId:sibling.deliveryId,slice:sibling.slice,initialObservation:true,
    observation:image.observedByDelivery.get(sibling.deliveryId)}];
  // The retained terminal basis also differs, but the newer local generation
  // takes diagnostic precedence. Same-generation basis rejection is covered
  // separately by test-current-sibling-admission.mjs.
  assert.equal(currentTerminalProductBasisMatches(origin.otherDeliveryWork,others(retired)),true);
  assert.equal(currentTerminalProductBasisMatches(origin.otherDeliveryWork,others(after)),false);
  assert.deepEqual(after.files.get('approved-preparation.json'),retired.files.get('approved-preparation.json'));
  assert.deepEqual(after.files.get(terminal.evidence.path),retired.files.get(terminal.evidence.path));
});

test('T02 completed observations guard before recipe, composition and publication without new verification',async t=>{
  const f=await completedNativeCase(t),before=await captureCurrentExecution(f.specPath);
  const start=await begin({specPath:f.specPath,slice:'slice-02',expectedActivationId:before.inspection.activationId});
  const dispatch=await reserveDispatch(start.handle,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const origin=decode(await fs.readFile(dispatch.originFile));
  assert.deepEqual(origin.otherDeliveryWork.map(item=>item.deliveryId),before.inspection.completed.map(item=>item.deliveryId));
  await bindNative(start.handle,'mechanical-terminal-current-guards');
  const originBytes=await fs.readFile(dispatch.originFile),malformed=decode(originBytes);
  const missing=decode(originBytes);delete missing.otherDeliveryWork;
  await fs.writeFile(dispatch.originFile,json(missing));
  const originalSpawn=ChildProcess.prototype.spawn;let subprocesses=0;
  ChildProcess.prototype.spawn=function(){subprocesses+=1;throw new Error('Unexpected subprocess before terminal basis guard');};
  try {
    await assert.rejects(()=>verifyNative(dispatch.originFile),error=>error.code==='OWNER_MISMATCH');
  } finally {ChildProcess.prototype.spawn=originalSpawn;}
  assert.equal(subprocesses,0,'missing terminal basis must fail before recipe or HEAD commands');
  for(const name of ['verification','observation','receipt'])await assert.rejects(
    fs.lstat(path.join(path.dirname(dispatch.originFile),`round-1.${name}.json`)),{code:'ENOENT'});
  malformed.otherDeliveryWork[0]=null;await fs.writeFile(dispatch.originFile,json(malformed));
  await assert.rejects(()=>verifyNative(dispatch.originFile),error=>error.code==='EVIDENCE_INCOMPLETE');
  await fs.writeFile(dispatch.originFile,originBytes);
  const file=path.join(f.root,'src/greeting.mjs'),bytes=await fs.readFile(file);
  await fs.appendFile(file,'// completed drift before recipe\n');
  await assert.rejects(()=>verifyNative(dispatch.originFile),invalid);
  await assert.rejects(fs.lstat(path.join(path.dirname(dispatch.originFile),'round-1.verification.json')),{code:'ENOENT'});
  await fs.writeFile(file,bytes);
});

test('T02 local nonterminal origins preserve the existing absent-basis route',async t=>{
  const f=await completedNativeCase(t),before=await captureCurrentExecution(f.specPath);
  const start=await begin({specPath:f.specPath,slice:'slice-02',expectedActivationId:before.inspection.activationId});
  const dispatch=await reserveDispatch(start.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  const origin=decode(await fs.readFile(dispatch.originFile));assert.equal(origin.terminalPreparationUtf8,undefined);
  delete origin.otherDeliveryWork;await fs.writeFile(dispatch.originFile,json(origin));
  await bindNative(start.handle,'mechanical-local-absent-basis');
  const measured=await verifyNative(dispatch.originFile);assert.equal(measured.status,'completed');
  assert.ok(measured.commands.length>0);assert.ok(measured.commands.every(item=>item.exit===0));
  for(const name of ['verification','observation'])assert.ok((await fs.lstat(
    path.join(path.dirname(dispatch.originFile),`round-1.${name}.json`))).isFile());
});

test('T03 terminal publication refuses completed drift and resumes the original capture after restoration',async t=>{
  const f=await completedNativeCase(t),file=path.join(f.root,'src/greeting.mjs'),bytes=await fs.readFile(file);
  const result=await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1',
    beforePublish:async({start,dispatch})=>{
      await assert.rejects(()=>captureCurrentExecution(f.specPath),error=>error.code==='OWNER_UNCERTAIN');
      assert.notEqual((await captureCurrentActiveExecution(f.specPath,start.owner)).inspection.state,'COMPLETE');
      const root=path.dirname(dispatch.originFile),observation=await fs.readFile(path.join(root,'round-1.observation.json'));
      const raw=await fs.readFile(path.join(root,'round-1.response.json'));
      await fs.appendFile(file,'// completed drift after capture\n');
      await assert.rejects(()=>publish(start.handle),invalid);await fs.writeFile(file,bytes);
      // Also drift under the publication lock at the last authorization gate.
      let moved=false;
      await assert.rejects(()=>publish(start.handle,{checkpoint:async phase=>{
        if(phase==='before-backup')await fs.appendFile(file,'// completed drift before swap\n');
        if(phase==='after-backup')moved=true;
      }}),invalid);
      assert.equal(moved,false,'global product drift must fail before moving the official tree');
      await fs.writeFile(file,bytes);
      assert.deepEqual(await fs.readFile(path.join(root,'round-1.observation.json')),observation);
      assert.deepEqual(await fs.readFile(path.join(root,'round-1.response.json')),raw);
      await assert.rejects(fs.lstat(path.join(root,'round-2.origin.json')),{code:'ENOENT'});
    }});
  assert.equal(result.published.publication,'confirmed');
  const after=await captureCurrentExecution(f.specPath);assert.equal(after.inspection.state,'COMPLETE');
});

for(const status of ['NEEDS_FIX','BLOCKED','refusal'])test(`T05 later ${status} prevents an older integral PASS from certifying completion`,async t=>{
  const f=await completedNativeCase(t);await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const before=await captureCurrentExecution(f.specPath);assert.equal(before.inspection.state,'COMPLETE');
  await fs.appendFile(path.join(f.root,f.productFile),'// next legal local delta\n');
  await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1',invalid:status==='refusal',
    beforeCapture:status==='refusal'?null:async({tool,dispatch})=>{
      const doc=decode(await fs.readFile(tool)),answer=JSON.parse(doc.finalResponse);answer.result.status=status;
      if(status==='BLOCKED')answer.result.blockers='Controlled current semantic gap blocks integral acceptance.';
      else {
        const request=decode(await fs.readFile(dispatch.requestFile));
        answer.newFindings=[finding(1,Number(request.attemptId.slice(8)))];
        answer.result.findingReferences='finding-01';answer.result.findingDispositions='finding-01=active';
      }
      doc.finalResponse=JSON.stringify(answer);await fs.writeFile(tool,json(doc));
    }});
  const after=await captureCurrentExecution(f.specPath);
  assert.notEqual(after.inspection.state,'COMPLETE');
  assert.equal(after.inspection.deliveries[0].formalStatus,status==='refusal'?null:status);
  assert.equal(after.inspection.completed[0].observedValidation,'current');
});

test('T04 an obsolete integral PASS remains historical while equivalent local proof is retained',async t=>{
  const f=await completedNativeCase(t);await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const image=await captureCurrentExecution(f.specPath);
  await privateReview(f,image,'slice-02');
  const pending=await captureCurrentExecution(f.specPath);
  assert.equal(pending.inspection.completed[0].observedValidation,'current');assert.equal(pending.inspection.deliveries[0].formalStatus,null);
  assert.equal(pending.inspection.normalHandoff.operation,'VALIDATE_SLICE');
  const sourceBundle=decode(image.files.get(decode(image.files.get('continuity.json')).deliveries[0].evidence.path));
  await normalizedFormal(f);
  const after=await captureCurrentExecution(f.specPath),current=decode(after.files.get('continuity.json')).deliveries[0];
  const bundle=decode(after.files.get(current.evidence.path));
  assert.ok(bundle.support.some(record=>JSON.stringify(record)===JSON.stringify(sourceBundle.validation)));
  assert.equal(bundle.validation.contract.terminal,null);
  assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');assert.equal(after.inspection.deliveries[0].observedValidation,'current');
  assert.equal(after.inspection.completed[0].observedValidation,'current');
  assert.equal(after.inspection.state,'IMPLEMENTED_AWAITING_VALIDATION');
  // Historical integral support cannot certify the new local proof; its live
  // owner may supply a fresh judgment without another preparation change.
  assert.deepEqual(after.inspection.normalHandoff,{operation:'VALIDATE_SLICE',slice:current.slice,deliveryId:current.deliveryId});
  assert.deepEqual(after.inspection.diagnostics,[{kind:'evidence',artifact:'continuity.json',field:'terminal',
    reason:'EVIDENCE_INCOMPLETE: local PASS has no terminal judgment'}]);
});

test('T06 a current latest integral PASS loses only certification when another reviewed contribution changes',async t=>{
  const f=await completedNativeCase(t,{retire:false,independent:true});
  await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const before=await captureCurrentExecution(f.specPath);assert.equal(before.inspection.state,'COMPLETE');
  const old=decode(before.files.get(decode(before.files.get('continuity.json')).deliveries[1].evidence.path));
  await privateReview(f,before,'slice-01');
  const pending=await captureCurrentExecution(f.specPath);
  const a=decode(pending.files.get('continuity.json')).deliveries[0];
  await normalizedFormal({...f,delivery:a});
  const after=await captureCurrentExecution(f.specPath),b=decode(after.files.get('continuity.json')).deliveries[1];
  assert.deepEqual(decode(after.files.get(b.evidence.path)).validation,old.validation);
  assert.ok(after.inspection.deliveries.every(item=>item.formalStatus==='PASS'&&item.observedValidation==='current'));
  assert.equal(after.inspection.state,'VALIDATION_BLOCKED');assert.equal(after.inspection.normalHandoff,null);
  assert.match(after.inspection.diagnostics[0].reason,/terminal judgment target differs/u);
});

test('T07 mechanical terminal/completed capture resumes a partial candidate in new processes without another recipe',async t=>{
  const f=await completedNativeCase(t),before=await captureCurrentExecution(f.specPath);
  const captured=await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1',captureOnly:true});
  const operationRoot=path.dirname(captured.dispatch.originFile),controls=new Map();
  for(const name of await fs.readdir(operationRoot))if(name!=='owner.json')
    controls.set(name,await fs.readFile(path.join(operationRoot,name)));
  let faults=0;
  await assert.rejects(publish(captured.start.handle,{checkpoint:phase=>{
    if(phase==='after-candidate-file') {
      faults+=1;throw Object.assign(new Error('controlled terminal candidate interruption'),{code:'CONTROLLED_CANDIDATE_FAILURE'});
    }
  }}),{code:'CONTROLLED_CANDIDATE_FAILURE'});
  assert.equal(faults,1);
  const handleFile=path.join(f.root,'terminal recovery handle.json');await fs.writeFile(handleFile,json(captured.start.handle));
  const controller=path.resolve('skills/workflows/stnl-slice-quality-manager/runtime/execution-current-operation.mjs');
  const separate=async command=>JSON.parse((await run(process.execPath,[controller,command,'--handle',handleFile],{cwd:'/tmp'})).stdout);
  const pending=await separate('resume');assert.equal(pending.nextAction,'normalize');
  assert.equal(pending.responseSha256,captured.captured.rawResponseSha256);
  const repaired=await separate('normalize');assert.equal(repaired.rawResponseSha256,captured.captured.rawResponseSha256);
  const result=await separate('publish');assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'complete');
  assert.equal((await separate('resume')).nextAction,'none');
  for(const [name,bytes]of controls)assert.deepEqual(await fs.readFile(path.join(operationRoot,name)),bytes,name);
  await assert.rejects(fs.lstat(path.join(operationRoot,'round-2.origin.json')),{code:'ENOENT'});
  const after=await captureCurrentExecution(f.specPath),delivery=after.inspection.deliveries[0];
  assert.equal(after.inspection.state,'COMPLETE');assert.equal(delivery.formalStatus,'PASS');assert.equal(after.inspection.normalHandoff,null);
  assert.equal(delivery.counters.validationAttempts,before.inspection.deliveries[0].counters.validationAttempts+1);
  for(const [id,work]of before.observedByDelivery)
    assert.deepEqual(after.observedByDelivery.get(id).manifest,work.manifest);
  assert.deepEqual(after.files.get('evidence/'+before.inspection.completed[0].deliveryId+'.json'),
    before.files.get('evidence/'+before.inspection.completed[0].deliveryId+'.json'));
});
