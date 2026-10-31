import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {reviewInput} from './fixtures/current-completed-pristine.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {prepareCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {publishCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/current-local-review.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,abort,resume} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {abort as qualityAbort} from '../skills/workflows/stnl-slice-quality-manager/runtime/execution-current-operation.mjs';
import {validateCurrentActivation,validateCurrentAbortDisposition} from '../skills/workflows/stnl-slice-executor/runtime/execution-current.mjs';

const decode=bytes=>JSON.parse(Buffer.from(bytes)),run=promisify(execFile);
const raw='{"format":"stnl-current-native-judgment-v1","result":{"status":"BLOCKED","evidence":"A command failure was reported; no observation exists. \\"quoted\\" Ω"},"requestSha256":"not-allowed-in-this-variant"}';
async function fixture(t) {
  const f=await completedNativeCase(t,{drift:false}),source=await captureCurrentExecution(f.specPath);
  const input=reviewInput(source,1),proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled private recipe review for abort mechanics.',
    evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Retain literal historical proof and revalidate the private recipe change.'}))};
  await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
    reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
  const before=await captureCurrentExecution(f.specPath),start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:before.inspection.activationId});
  const dispatch=await reserveDispatch(start.handle,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'}),agentId='mechanical-abort-agent';
  await bindNative(start.handle,agentId);
  const tool=path.join(f.root,'tmp/abort-tool.json');await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse:raw})+'\n');
  return {...f,before,start,dispatch,tool,agentId,operationRoot:path.dirname(dispatch.originFile)};
}
async function tree(root) {
  const entries=[];
  for(const entry of await fs.readdir(root,{withFileTypes:true})) {
    const file=path.join(root,entry.name);
    if(entry.isDirectory())for(const [name,bytes]of await tree(file))entries.push([entry.name+'/'+name,bytes]);
    else entries.push([entry.name,await fs.readFile(file)]);
  }
  return entries.sort(([a],[b])=>a<b?-1:a>b?1:0);
}

async function refusalSnapshot(f) {
  return {controlsAndRegistry:await tree(path.dirname(f.operationRoot)),execution:await tree(f.image.f.execution),
    product:await tree(path.join(f.root,path.dirname(f.productFile)))};
}

test('native abort refuses foreign or initially absent registry before any effects in both controllers',async t=>{
  for(const close of [abort,qualityAbort])for(const state of ['foreign','empty','missing']) {
    const f=await fixture(t),registryPath=path.join(path.dirname(f.operationRoot),'registry.json');
    const registry=decode(await fs.readFile(registryPath));
    if(state==='missing')await fs.rm(registryPath);
    else {
      if(state==='empty')registry.operations=[];
      else {
        const operationId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        registry.operations.push({operationId,marker:path.join(path.dirname(f.operationRoot),operationId,'owner.json')});
      }
      await fs.writeFile(registryPath,JSON.stringify(registry)+'\n');
    }
    const before=await refusalSnapshot(f);
    await assert.rejects(close(f.start.handle,f.tool),{code:'OWNER_UNCERTAIN'});
    assert.deepEqual(await refusalSnapshot(f),before,state);
  }
});

test('native abort refuses an origin dispatch differing from the bound runner without effects in both controllers',async t=>{
  for(const close of [abort,qualityAbort]) {
    const f=await fixture(t),origin=decode(await fs.readFile(f.dispatch.originFile));
    origin.dispatchId='foreign-dispatch';await fs.writeFile(f.dispatch.originFile,JSON.stringify(origin)+'\n');
    const before=await refusalSnapshot(f);
    await assert.rejects(close(f.start.handle,f.tool),{code:'OWNER_MISMATCH'});
    assert.deepEqual(await refusalSnapshot(f),before);
  }
});

test('native abort rechecks registry exclusivity and dispatch on sealed-intent resumption',async t=>{
  for(const change of ['registry','dispatch']) {
    const f=await fixture(t);
    await assert.rejects(abort(f.start.handle,f.tool,{checkpoint:at=>{
      if(at==='after-abort-intent')throw Object.assign(Error('controlled intent interruption'),{code:'CONTROLLED_ABORT_FAULT'});
    }}),{code:'CONTROLLED_ABORT_FAULT'});
    const target=change==='registry'?path.join(path.dirname(f.operationRoot),'registry.json'):f.dispatch.originFile;
    const original=await fs.readFile(target),changed=decode(original);
    if(change==='registry')changed.operations=[];else changed.dispatchId='foreign-dispatch';
    await fs.writeFile(target,JSON.stringify(changed)+'\n');
    const before=await refusalSnapshot(f);
    await assert.rejects(qualityAbort(f.start.handle),{code:change==='registry'?'OWNER_UNCERTAIN':'OWNER_MISMATCH'});
    assert.deepEqual(await refusalSnapshot(f),before,change);
    await fs.writeFile(target,original);
    assert.equal((await qualityAbort(f.start.handle)).cleanup,'complete');
  }
});

test('native abort closes only the ended unstarted invocation, retaining diagnosis/consumption and forward activation',async t=>{
  const f=await fixture(t),controls=await tree(f.operationRoot),product=await fs.readFile(path.join(f.root,f.productFile));
  const result=await abort(f.start.handle,f.tool);
  assert.equal(result.publication,'aborted');assert.equal(result.cleanup,'complete');assert.equal(result.consumedInvocations,1);
  assert.equal(result.activation.sequence,decode(await fs.readFile(path.join(f.operationRoot,'round-1.origin.json'))).admission.reservedActivation.sequence+1);
  assert.equal(result.activation.previousActivationId,f.start.activationA1);assert.notEqual(result.activation.activationId,f.start.activationA0);
  assert.equal(result.activation.activeAttempt,null);assert.equal(result.activation.lastAttempt.outcome,'aborted');
  const proof=validateCurrentAbortDisposition(result.activation.lastAttempt);assert.equal(proof.toolResult.finalResponse,raw);
  assert.equal(result.activation.lastAttempt.abort.diagnostic.reason,raw);
  assert.equal(result.activation.lastAttempt.abort.consumedInvocations,1);
  const after=await captureCurrentExecution(f.specPath);
  for(const [name,bytes]of f.before.files)assert.deepEqual(Buffer.from(after.files.get(name)),Buffer.from(bytes),name);
  assert.equal(after.inspection.state,'IMPLEMENTED_AWAITING_VALIDATION');assert.equal(after.inspection.deliveries[0].formalStatus,null);
  assert.equal(after.inspection.abortedInvocation.consumedInvocations,1);assert.equal(after.inspection.normalHandoff.operation,'VALIDATE_SLICE');
  for(const [name,bytes]of controls)if(name!=='owner.json')assert.deepEqual(await fs.readFile(path.join(f.operationRoot,name)),bytes);
  assert.deepEqual(await fs.readFile(path.join(f.root,f.productFile)),product);
  const marker=decode(await fs.readFile(path.join(f.operationRoot,'owner.json')));assert.equal(marker.phase,'aborted');assert.equal(marker.runner.consumedInvocations,1);
  const registry=decode(await fs.readFile(path.join(path.dirname(f.operationRoot),'registry.json')));assert.deepEqual(registry.operations,[]);
  assert.equal((await resume(f.start.handle)).nextAction,'none');
  const duplicate=await abort(f.start.handle,f.tool);assert.equal(duplicate.activation.activationId,result.activation.activationId);
  await assert.rejects(verifyNative(f.dispatch.originFile));
  await fs.rename(f.operationRoot,f.operationRoot+'.offline');
  const cli=JSON.parse((await run(process.execPath,[path.resolve('skills/workflows/stnl-slice-quality-manager/runtime/execution-current-reader.mjs'),f.specPath])).stdout);
  assert.equal(cli.activationId,result.activation.activationId);assert.equal(cli.abortedInvocation.consumedInvocations,1);
  await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.state,'COMPLETE');
  const continuity=decode(final.files.get('continuity.json')),current=continuity.deliveries[0],bundle=decode(final.files.get(current.evidence.path));
  const originObject=bundle.objects.find(item=>item.id===bundle.validation.sources.origin),capsule=decode(Buffer.from(originObject.bytesBase64,'base64'));
  const admission=JSON.parse(capsule.originUtf8).admission;
  assert.equal(admission.baseActivation.lastAttempt.abort.diagnostic.reason,raw);assert.equal(admission.baseActivation.lastAttempt.abort.consumedInvocations,1);
  assert.equal(current.counters.validationAttempts,decode(f.before.files.get('continuity.json')).deliveries[0].counters.validationAttempts+1);
});

test('native abort refuses active, uncertain, foreign or changed producers and source without effects',async t=>{
  const f=await fixture(t),original=await fs.readFile(f.tool),sourceRoot=f.image.f.execution;
  await assert.rejects(abort(f.start.handle));
  for(const change of [value=>value.status='running',value=>value.status='uncertain',value=>value.agentId='foreign',
    value=>value.finalResponse='',value=>value.processError='uncertain tool completion']) {
    const value=decode(original);change(value);await fs.writeFile(f.tool,JSON.stringify(value));
    const owned=await tree(f.operationRoot),live=await tree(sourceRoot);await assert.rejects(abort(f.start.handle,f.tool));
    assert.deepEqual(await tree(f.operationRoot),owned);assert.deepEqual(await tree(sourceRoot),live);
  }
  await fs.writeFile(f.tool,Buffer.concat([Buffer.from(`{"agentId":"${f.agentId}","status":"completed","finalResponse":"`),Buffer.from([255]),Buffer.from('"}') ]));
  await assert.rejects(abort(f.start.handle,f.tool),{code:'INVALID_CURRENT_IMAGE'});
  await fs.writeFile(f.tool,original);
  for(const name of ['round-1.verification.json','round-1.observation.json','round-1.receipt.json','foreign.txt']) {
    await fs.writeFile(path.join(f.operationRoot,name),'{"status":"started"}');
    const before=await tree(f.operationRoot);await assert.rejects(abort(f.start.handle,f.tool));assert.deepEqual(await tree(f.operationRoot),before);
    await fs.rm(path.join(f.operationRoot,name));
  }
  const product=path.join(f.root,f.productFile),bytes=await fs.readFile(product);await fs.appendFile(product,'\n// drift\n');
  const owned=await tree(f.operationRoot);await assert.rejects(abort(f.start.handle,f.tool));assert.deepEqual(await tree(f.operationRoot),owned);await fs.writeFile(product,bytes);
  const result=await abort(f.start.handle,f.tool),changed=decode(original);changed.finalResponse+=' changed';await fs.writeFile(f.tool,JSON.stringify(changed));
  await assert.rejects(abort(f.start.handle,f.tool));assert.equal((await captureCurrentExecution(f.specPath)).inspection.activationId,result.activation.activationId);
});

test('native abort rechecks producer controls after sealing intent and blocks a changed source',async t=>{
  const f=await fixture(t),claim=path.join(f.operationRoot,'round-1.claim.json'),original=await fs.readFile(claim);
  await assert.rejects(abort(f.start.handle,f.tool,{checkpoint:async at=>{
    if(at==='after-abort-intent')await fs.writeFile(claim,JSON.stringify({...decode(original),agentId:'foreign'}));
  }}));
  assert.equal(decode(await fs.readFile(path.join(f.image.f.execution,'activation.json'))).activationId,f.start.activationA1);
  assert.equal((await resume(f.start.handle)).nextAction,'resume-abort');
  await fs.writeFile(claim,original);
  assert.equal((await abort(f.start.handle)).publication,'aborted');
});

for(const phase of ['after-abort-intent','after-abort-activation','after-abort-readback','before-abort-registry-completion','after-abort-registry-completion'])
test(`native abort resumes its exact disposition after ${phase}`,async t=>{
  const f=await fixture(t);let injected=0,first;
  try{first=await abort(f.start.handle,f.tool,{checkpoint:at=>{if(at===phase){injected++;throw Object.assign(Error('controlled abort interruption'),{code:'CONTROLLED_ABORT_FAULT'});}}});}
  catch(error){assert.equal(error.code,'CONTROLLED_ABORT_FAULT');}
  assert.equal(injected,1);if(first)assert.equal(first.cleanup,'pending');
  const pending=await resume(f.start.handle);assert.equal(pending.nextAction,'resume-abort');
  if(phase==='after-abort-intent') {
    await assert.rejects(verifyNative(f.dispatch.originFile));
    await assert.rejects(fs.readFile(path.join(f.operationRoot,'round-1.verification.json')),{code:'ENOENT'});
  }
  const handleFile=path.join(f.root,'tmp/abort-handle.json');await fs.writeFile(handleFile,JSON.stringify(f.start.handle));
  const resumed=JSON.parse((await run(process.execPath,[path.resolve('skills/workflows/stnl-slice-quality-manager/runtime/execution-current-operation.mjs'),
    phase==='after-abort-registry-completion'?'cleanup':'abort','--handle',handleFile],{cwd:'/tmp'})).stdout);
  assert.equal(resumed.publication,'aborted');assert.equal(resumed.cleanup,'complete');
  assert.equal((await abort(f.start.handle)).activation.activationId,resumed.activation.activationId);
  assert.equal((await resume(f.start.handle)).nextAction,'none');
});

test('native verification start and abort cannot both pass the common lease',async t=>{
  const f=await fixture(t),open=fs.open;
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const output=path.join(f.operationRoot,'round-1.verification.json');
  fs.open=async(file,...args)=>{
    if(file===output&&args[0]==='wx'){entered();await gate;}
    return open(file,...args);
  };
  const verifying=verifyNative(f.dispatch.originFile);
  try {
    await started;
    const before=await tree(f.operationRoot);
    await assert.rejects(abort(f.start.handle,f.tool));
    assert.deepEqual(await tree(f.operationRoot),before);
  }finally{release();fs.open=open;}
  const measured=await verifying;assert.equal(measured.status,'completed');
  assert.ok((await fs.readFile(output)).length);
  await assert.rejects(abort(f.start.handle,f.tool));
  const active=decode(await fs.readFile(path.join(f.image.f.execution,'activation.json')));
  assert.equal(active.activationId,f.start.activationA1);assert.ok(active.activeAttempt);
});

test('native aborted activation rejects changed conclusion, consumption and admission',async t=>{
  const f=await fixture(t),result=await abort(f.start.handle,f.tool);
  for(const alter of [value=>value.lastAttempt.abort.consumedInvocations=0,value=>value.lastAttempt.abort.diagnostic.reason='changed',
    value=>value.previousActivationId=f.start.activationA0,value=>value.lastAttempt.operationRef.allocationSha256='sha256:'+'0'.repeat(64)]) {
    const changed=structuredClone(result.activation);alter(changed);assert.throws(()=>validateCurrentActivation(changed));
  }
});

test('native abort cannot chain another disposal to reset the concluded invocation consumption',async t=>{
  const f=await fixture(t),closed=await abort(f.start.handle,f.tool);
  const next=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:closed.activation.activationId});
  await reserveDispatch(next.handle,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const agentId=f.agentId+'-next';await bindNative(next.handle,agentId);
  const tool=path.join(f.root,'tmp/second-abort-tool.json');await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse:raw}));
  await assert.rejects(abort(next.handle,tool));
  const activation=decode(await fs.readFile(path.join(f.image.f.execution,'activation.json')));
  assert.equal(activation.activationId,next.activationA1);assert.ok(activation.activeAttempt);
  assert.equal(activation.lastAttempt.abort.consumedInvocations,1);
});

test('native abort retains forward intent after terminal-parent sync failure and resumes without restoring A0',async t=>{
  const f=await fixture(t),open=fs.open;let injected=0;
  fs.open=async(file,...args)=>{
    if(file===f.image.f.execution&&typeof args[0]==='number'&&!injected){injected++;throw Object.assign(Error('controlled abort fsync failure'),{code:'EIO'});}
    return open(file,...args);
  };
  try{await assert.rejects(abort(f.start.handle,f.tool),{code:'EIO'});}finally{fs.open=open;}
  assert.equal(injected,1);
  const terminal=decode(await fs.readFile(path.join(f.image.f.execution,'activation.json')));
  assert.equal(terminal.previousActivationId,f.start.activationA1);assert.equal(terminal.activeAttempt,null);
  assert.equal((await resume(f.start.handle)).nextAction,'resume-abort');
  const result=await abort(f.start.handle);assert.equal(result.activation.activationId,terminal.activationId);
  assert.equal(result.cleanup,'complete');assert.equal(result.consumedInvocations,1);
});
