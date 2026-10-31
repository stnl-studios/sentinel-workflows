import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {reseal,writeImage} from './fixtures/current-quiet-reader.mjs';
import {completedBlockingCase,startCompletedApply,completedApplyRound,completedFormal} from './fixtures/current-completed-findings.mjs';
import {completedPristineCase,execute,formal,reviewInput} from './fixtures/current-completed-pristine.mjs';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {prepareCurrentLocalReview,finalizeCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {publishCurrentLocalReview} from '../skills/workflows/stnl-slice-executor/runtime/current-local-review.mjs';
import {reserveDispatch,publish,normalizeSuccessor,resume} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

for(const operation of ['EXECUTE_SLICE','APPLY_FINDINGS'])test(`operational producer recovery: ${operation} four corrected schema failures retain their lineage`,async t=>{
  const f=operation==='EXECUTE_SLICE'?await completedPristineCase(t):await completedBlockingCase(t);
  const owners=[];
  for(let index=0;index<5;index++) {
    const responseMutation=index<4?response=>{delete response.result[['coverage','selectionRationale','discoverySources','selectedChecks'][index]];return response;}:null;
    let start;
    if(operation==='EXECUTE_SLICE')start=(await execute(f,{successor:index>0,responseMutation})).start;
    else {
      start=await startCompletedApply(f,{successor:index>0});
      await completedApplyRound(f,start,{edit:index===0?'export const greeting="hello";\n':null,responseMutation});
    }
    owners.push(start.owner.operationAttemptId);
    let published;try{published=await publish(start.handle);}catch(error){error.message=`${operation}/producer-${index+1}: ${error.message}`;throw error;}
    assert.equal(published.transition.outcome,index<4?'rejected':'recorded');
    const image=await captureCurrentExecution(f.specPath);
    const current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries.find(item=>item.slice===f.delivery.slice);
    if(index<4){assert.equal(current.normalization.status,'settled');assert.equal(current.normalization.consumedInvocations,index+1);}
    else {
      assert.equal(current.normalization,null);
      const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path)));
      assert.deepEqual(bundle.support.filter(item=>item.kind==='rejection'&&item.origin.operation===operation).map(item=>item.operationAttemptId),owners.slice(0,4));
      await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:image.inspection.activationId}));
    }
  }
});

test('operational EXECUTE recurrence uses authenticated Initial authority without an absent request',async t=>{
  const f=await completedPristineCase(t);
  for(const [index,value]of [0,false].entries()){
    const item=await execute(f,{successor:index>0,responseMutation:r=>{r.result.coverage=value;return r;}});
    const published=await publish(item.start.handle);
    assert.equal(published.transition.normalization.status,'settled');
  }
  const corrected=await execute(f,{successor:true});await publish(corrected.start.handle);
  assert.equal((await captureCurrentExecution(f.specPath)).inspection.normalHandoff.operation,'VALIDATE_SLICE');
});
for(const operation of ['EXECUTE_SLICE','APPLY_FINDINGS'])test(`operational producer recovery forbids reused predecessor agent: ${operation}`,async t=>{
  const f=operation==='EXECUTE_SLICE'?await completedPristineCase(t):await completedBlockingCase(t);
  let prior;
  if(operation==='EXECUTE_SLICE'){
    const item=await execute(f,{invalid:true});await publish(item.start.handle);
    prior=JSON.parse(await fs.readFile(path.join(path.dirname(item.rounds[0].dispatch.originFile),'round-1.agent.json'))).agentId;
    await assert.rejects(()=>execute(f,{successor:true,agentIdOverride:prior}),error=>error.code==='OWNER_MISMATCH');
  }else{
    const start=await startCompletedApply(f),item=await completedApplyRound(f,start,{invalid:true});await publish(start.handle);
    prior=JSON.parse(await fs.readFile(path.join(path.dirname(item.dispatch.originFile),'round-1.agent.json'))).agentId;
    const next=await startCompletedApply(f,{successor:true});
    await assert.rejects(()=>completedApplyRound(f,next,{agentId:prior}),error=>error.code==='OWNER_MISMATCH');
  }
});

test('operational APPLY mixed owner preserves its first baseline through FAIL and correction',async t=>{
  const f=await completedBlockingCase(t),first=await startCompletedApply(f);
  await completedApplyRound(f,first,{invalid:true});await publish(first.handle);
  const next=await startCompletedApply(f,{successor:true});
  await completedApplyRound(f,next,{status:'TESTS_FAIL',edit:'export const greeting="broken-correction";\n'});
  await completedApplyRound(f,next,{edit:'export const greeting="hello";\n'});
  const published=await publish(next.handle);assert.equal(published.transition.outcome,'recorded');
  const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.normalHandoff.operation,'VALIDATE_SLICE');
});

test('completed v3 publishes concluded rejection and admits only one inherited successor',async t=>{
  const f=await completedNativeCase(t),before=await captureCurrentExecution(f.specPath);
  const result=await normalizedFormal(f,{invalid:true});assert.equal(result.published.transition.outcome,'rejected');
  const rejected=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(rejected.files.get('continuity.json'))).deliveries[0];
  assert.equal(current.normalization.status,'settled');assert.equal(current.normalization.consumedInvocations,1);
  assert.deepEqual(rejected.inspection.completed,before.inspection.completed);
  assert.deepEqual(rejected.files.get('approved-preparation.json'),before.files.get('approved-preparation.json'));
  await normalizedFormal(f,{successor:true});const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(final.inspection.deliveries[0].counters.validationAttempts,before.inspection.deliveries[0].counters.validationAttempts+1);
  assert.deepEqual(final.inspection.completed,before.inspection.completed);
  await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:final.inspection.activationId}),error=>error.code==='NORMALIZATION_NOT_ELIGIBLE');
});

test('completed v3 third concluded rejection exhausts after two corrections',async t=>{
  const f=await completedNativeCase(t);await normalizedFormal(f,{invalid:true});
  await normalizedFormal(f,{successor:true,invalid:true});
  await normalizedFormal(f,{successor:true,invalid:true});const image=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.equal(current.normalization.status,'exhausted');assert.equal(current.normalization.consumedInvocations,3);assert.equal(image.inspection.normalHandoff,null);
  await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:image.inspection.activationId}));
});


test('judgment variant preserves malformed final bytes and admits one completed successor',async t=>{
  const f=await completedNativeCase(t),responseVariant='stnl-current-native-judgment-v1';
  const first=await normalizedFormal(f,{invalid:true,responseVariant,invalidText:'{first official-shaped mechanical refusal'});
  assert.equal(first.captured.captureClass,'formal-rejection');
  assert.equal(first.published.transition.outcome,'rejected');
  const result=await normalizedFormal(f,{successor:true,responseVariant});
  assert.equal(result.published.publication,'confirmed');
  const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
});


test('rejected EXECUTE gets a new owner with only the original remaining budget',async t=>{
  const f=await completedPristineCase(t),first=await execute(f,{invalid:true});await publish(first.start.handle);
  const rejected=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(rejected.files.get('continuity.json'))).deliveries[0];
  assert.equal(c.normalization.status,'settled');assert.equal(c.normalization.consumedInvocations,1);
  assert.equal(rejected.inspection.normalHandoff?.operation,'EXECUTE_SLICE');
  const second=await execute(f,{successor:true});assert.notEqual(second.start.owner.operationAttemptId,first.start.owner.operationAttemptId);
  assert.equal(JSON.parse(await fs.readFile(second.rounds[0].dispatch.requestFile)).round,2);
  await publish(second.start.handle);
  const image=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path)));
  assert.equal(bundle.support.filter(item=>item.kind==='rejection').length,1);
  assert.equal(current.counters.implementationChecks,1);assert.equal(current.normalization,null);
  assert.equal(image.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
  await formal(f);assert.equal((await captureCurrentExecution(f.specPath)).inspection.deliveries[0].formalStatus,'PASS');
});

test('FAIL then rejected invocation two leaves exactly invocation three',async t=>{
  const f=await completedPristineCase(t),first=await execute(f,{statuses:['TESTS_FAIL','TESTS_PASS'],invalid:true,invalidAt:2});
  await publish(first.start.handle);const rejected=await captureCurrentExecution(f.specPath);
  const c=JSON.parse(Buffer.from(rejected.files.get('continuity.json'))).deliveries[0];
  assert.equal(c.counters.implementationChecks,1);assert.equal(c.normalization.consumedInvocations,2);
  const second=await execute(f,{successor:true});await publish(second.start.handle);
  const final=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(final.files.get('continuity.json'))).deliveries[0];
  assert.equal(current.counters.implementationChecks,2);assert.equal(current.normalization,null);
  await assert.rejects(()=>reserveDispatch(second.start.handle,{responseVariant:'stnl-current-native-judgment-v1'}));
});


test('converted v3 with completed supports two actual private recipe reviews',async t=>{
  const f=await completedNativeCase(t,{drift:false}),before=await captureCurrentExecution(f.specPath);
  for(const round of [1,2]) {
    const image=await captureCurrentExecution(f.specPath),input=reviewInput(image,round),proposal=prepareCurrentLocalReview(input);
    assert.throws(()=>finalizeCurrentLocalReview({proposal,review:null}));
    const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent private recipe approval.',
      evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Changed private check requires a fresh formal under the revised recipe.'}))};
    const candidate=finalizeCurrentLocalReview({proposal,review});
    assert.equal(JSON.parse(candidate.files.get('continuity.json')).deliveries[0].localRevision,round+1);
    const published=await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,
      planBytes:input.planBytes,reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
    assert.equal(published.publication,'confirmed');
    const reviewed=await captureCurrentExecution(f.specPath);assert.equal(reviewed.inspection.deliveries[0].formalStatus,null);
    await normalizedFormal(f);const current=await captureCurrentExecution(f.specPath);
    assert.equal(current.inspection.deliveries[0].formalStatus,'PASS');assert.deepEqual(current.inspection.completed,before.inspection.completed);
  }
  const final=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(final.files.get('continuity.json'))).deliveries[0];
  assert.equal(c.localRevision,3);assert.equal(c.counters.validationAttempts,before.inspection.deliveries[0].counters.validationAttempts+2);
});

test('EXECUTE preserves removal bytes before the private output disappears and formal proves absence',async t=>{
  const f=await completedPristineCase(t,{extraOutput:true});
  const removed=await fs.readFile(path.join(f.root,'other/obsolete module.mjs'));
  const operation=await execute(f,{beforeReserve:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs'))});
  await publish(operation.start.handle);const image=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  const bundle=JSON.parse(Buffer.from(image.files.get(c.evidence.path))),refs=bundle.implementation[0].sources.removalProofs;
  assert.equal(refs.length,1);const proof=JSON.parse(Buffer.from(bundle.objects.find(item=>item.id===refs[0]).bytesBase64,'base64'));
  assert.equal(proof.path,'other/obsolete module.mjs');assert.deepEqual(Buffer.from(proof.bytesBase64,'base64'),removed);
  await formal(f);assert.equal((await captureCurrentExecution(f.specPath)).inspection.deliveries[0].formalStatus,'PASS');
});


test('current v1 formal rejection with completed publishes and consumes one successor',async t=>{
  const f=await completedPristineCase(t),implementation=await execute(f);await publish(implementation.start.handle);
  await normalizedFormal(f,{invalid:true,responseVariant:'stnl-current-native-judgment-v1'});
  const rejected=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(rejected.files.get('continuity.json'))).deliveries[0];
  assert.equal(c.normalization.status,'settled');assert.equal(c.counters.validationAttempts,0);
  const result=await normalizedFormal(f,{successor:true,responseVariant:'stnl-current-native-judgment-v1'});
  assert.equal(result.published.publication,'confirmed');const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');assert.equal(final.inspection.deliveries[0].counters.validationAttempts,1);
});

test('converted v4 formal refusal after APPLY preserves findings until its one successor',async t=>{
  const f=await completedBlockingCase(t),start=await startCompletedApply(f);
  await completedApplyRound(f,start,{edit:'export const greeting="hello";\n'});await publish(start.handle);
  const before=await captureCurrentExecution(f.specPath);
  await normalizedFormal(f,{invalid:true});const rejected=await captureCurrentExecution(f.specPath);
  assert.equal(rejected.inspection.deliveries[0].counters.findings,before.inspection.deliveries[0].counters.findings);
  await normalizedFormal(f,{successor:true,references:'finding-01',dispositions:'finding-01=resolved'});
  const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  assert.deepEqual(final.inspection.completed,before.inspection.completed);
});


test('converted APPLY removal is witnessed before effect and survives the following v4 formal',async t=>{
  const f=await completedBlockingCase(t,{extraOutput:true}),start=await startCompletedApply(f);
  const bytes=await fs.readFile(path.join(f.root,'other/obsolete module.mjs'));
  await completedApplyRound(f,start,{edit:'export const greeting="hello";\n',beforeVerify:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs'))});
  await publish(start.handle);await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
  const image=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.equal(image.inspection.deliveries[0].formalStatus,'PASS');
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path)));
  const ids=bundle.findingsChecks.flatMap(item=>item.sources.removalProofs);assert.equal(ids.length,1);
  const proof=JSON.parse(Buffer.from(bundle.objects.find(item=>item.id===ids[0]).bytesBase64,'base64'));
  assert.deepEqual(Buffer.from(proof.bytesBase64,'base64'),bytes);
});


test('closed converted v4 findings permits an approved private recipe review and fresh formal',async t=>{
  const f=await completedBlockingCase(t),start=await startCompletedApply(f);
  await completedApplyRound(f,start,{edit:'export const greeting="hello";\n'});await publish(start.handle);
  await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
  const before=await captureCurrentExecution(f.specPath),input=reviewInput(before,1),proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent review after a closed findings cycle.',
    evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Private recipe changed; prior cycle stays literal until independent current proof replaces it.'}))};
  await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
    reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
  const reviewed=await captureCurrentExecution(f.specPath);assert.equal(reviewed.inspection.deliveries[0].formalStatus,null);
  await normalizedFormal(f);const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');assert.deepEqual(final.inspection.completed,before.inspection.completed);
  assert.equal(final.inspection.deliveries[0].counters.findings,before.inspection.deliveries[0].counters.findings);
});


test('typed recipe and SPEC/workspace/product paths with spaces use the normal vertical',async t=>{
  const f=await completedPristineCase(t,{spaces:true,extraOutput:true});
  assert.ok(f.root.includes(' '));assert.ok(f.specPath.includes(' '));assert.ok(f.productFile.includes(' '));assert.ok(f.testFile.includes(' '));
  const operation=await execute(f,{beforeReserve:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs'))});
  assert.ok(operation.rounds[0].observation.commands[0].command.includes('greeting test.mjs'));
  await publish(operation.start.handle);await formal(f);const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
});


test('identical malformed EXECUTE stops after two corrections without a fourth owner',async t=>{
  const sameInvalid=async({file})=>{const tool=JSON.parse(await fs.readFile(file));tool.finalResponse='IDENTICAL_INVALID_EXECUTE_RESPONSE';await fs.writeFile(file,JSON.stringify(tool)+'\n');};
  const f=await completedPristineCase(t),first=await execute(f,{beforeCapture:sameInvalid});await publish(first.start.handle);
  const second=await execute(f,{successor:true,beforeCapture:sameInvalid});await publish(second.start.handle);
  const third=await execute(f,{successor:true,beforeCapture:sameInvalid});await publish(third.start.handle);
  const image=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.equal(c.normalization.status,'exhausted');assert.equal(c.normalization.consumedInvocations,3);
  assert.equal(c.normalization.episodeId,first.start.owner.operationAttemptId);assert.equal(c.normalization.round,3);
  assert.equal(image.inspection.normalHandoff,null);
  await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:image.inspection.activationId}));
});

test('refusal in invocation five consumes the local margin and forbids a successor',async t=>{
  const f=await completedPristineCase(t),first=await execute(f,{statuses:['TESTS_FAIL','TESTS_FAIL','TESTS_FAIL','TESTS_FAIL','TESTS_PASS'],invalid:true,invalidAt:5});
  await publish(first.start.handle);const image=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.equal(c.counters.implementationChecks,4);assert.equal(c.normalization.status,'exhausted');assert.equal(c.normalization.consumedInvocations,5);
  assert.equal(image.inspection.normalHandoff,null);
  await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:image.inspection.activationId}));
});

test('current v1 third formal refusal exhausts without consuming a formal ID',async t=>{
  const f=await completedPristineCase(t),implementation=await execute(f);await publish(implementation.start.handle);
  await normalizedFormal(f,{invalid:true});await normalizedFormal(f,{successor:true,invalid:true});
  await normalizedFormal(f,{successor:true,invalid:true});
  const image=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0];
  assert.equal(c.normalization.status,'exhausted');assert.equal(c.normalization.consumedInvocations,3);assert.equal(c.counters.validationAttempts,0);
  assert.equal(image.inspection.normalHandoff,null);
});

test('current v2 refusal after APPLY has exactly one formal successor',async t=>{
  const f=await completedPristineCase(t),implementation=await execute(f);await publish(implementation.start.handle);
  await fs.writeFile(path.join(f.root,'other/greeting.mjs'),'export const greeting="broken";\n');
  const finding={id:'finding-01',severity:'blocking',originAttempt:'attempt-01',problem:'Greeting violates the approved requirement.',
    evidence:'Prepared assertion observes broken.',impact:'AC-001 is unmet.',relatedAuthority:'AC-001; obligation-01',expectedCorrection:'Restore hello.'};
  await formal(f,{status:'NEEDS_FIX',newFindings:[finding],references:'finding-01',dispositions:'finding-01=active'});
  const start=await startCompletedApply(f);await completedApplyRound(f,start,{edit:'export const greeting="hello";\n'});await publish(start.handle);
  await normalizedFormal(f,{invalid:true});await normalizedFormal(f,{successor:true,references:'finding-01',dispositions:'finding-01=resolved'});
  const image=await captureCurrentExecution(f.specPath);assert.equal(image.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(image.inspection.deliveries[0].counters.validationAttempts,2);
});


test('ordinary FAIL in the successor keeps only its final original invocation',async t=>{
  const f=await completedPristineCase(t),first=await execute(f,{invalid:true});await publish(first.start.handle);
  const second=await execute(f,{successor:true,statuses:['TESTS_FAIL','TESTS_PASS']});await publish(second.start.handle);
  const image=await captureCurrentExecution(f.specPath);assert.equal(image.inspection.deliveries[0].counters.implementationChecks,2);
  assert.equal(image.inspection.normalHandoff?.operation,'VALIDATE_SLICE');
});

for(const defect of ['missing','foreign-owner','wrong-mode','wrong-bytes'])test(`removal proof ${defect} blocks incorporation and preserves its first response`,async t=>{
  const f=await completedPristineCase(t,{extraOutput:true});let capturedInput;
  await assert.rejects(()=>execute(f,{beforeReserve:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs')),
    beforeCapture:async input=>{
      capturedInput=input;const name='round-1.removal-'+createHash('sha256').update('other/obsolete module.mjs').digest('hex')+'.json';
      const file=path.join(path.dirname(input.dispatch.originFile),name);
      if(defect==='missing')await fs.rm(file);
      else {const proof=JSON.parse(await fs.readFile(file));
        if(defect==='foreign-owner')proof.owner.operationAttemptId='00000000-0000-4000-8000-000000000099';
        if(defect==='wrong-mode')proof.mode=proof.mode===0?1:0;
        if(defect==='wrong-bytes')proof.bytesBase64=Buffer.from('not the old output').toString('base64');
        await fs.writeFile(file,JSON.stringify(proof)+'\n');}
    }}));
  assert.ok(capturedInput);
  assert.equal(await fs.readFile(path.join(path.dirname(capturedInput.dispatch.originFile),'round-1.response.json'),'utf8'),capturedInput.raw);
  const status=await resume(capturedInput.start.handle);assert.notEqual(status.nextAction,'publish');
  const activation=JSON.parse(await fs.readFile(path.join(f.view.execution,'activation.json')));assert.equal(activation.activeAttempt.operationAttemptId,capturedInput.start.owner.operationAttemptId);
});


test('private review after a normalized converted formal keeps required proof until fresh validation',async t=>{
  const f=await completedNativeCase(t);await normalizedFormal(f,{invalid:true});await normalizedFormal(f,{successor:true});
  const image=await captureCurrentExecution(f.specPath),input=reviewInput(image,1),proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent review after a concluded normalization.',
    evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Changed private recipe requires new validation; closed normalization sources stay literal while needed.'}))};
  await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
    reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
  await normalizedFormal(f);const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  assert.deepEqual(final.inspection.completed,image.inspection.completed);
});


test('repeated converted private reviews preserve an independently active native sibling',async t=>{
  const f=await completedNativeCase(t,{drift:false,retire:false}),before=await captureCurrentExecution(f.specPath);
  const a=JSON.parse(Buffer.from(before.files.get('continuity.json'))).deliveries[0],aBytes=before.files.get(a.evidence.path);
  for(const round of [1,2]) {
    const image=await captureCurrentExecution(f.specPath),input=reviewInput(image,round,f.delivery.slice),proposal=prepareCurrentLocalReview(input);
    const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent private review of B only.',
      evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Private B recipe changed; native A contract and sources remain exact.'}))};
    await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
      reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
    await normalizedFormal(f);
  }
  const final=await captureCurrentExecution(f.specPath);assert.equal(final.inspection.deliveries[1].formalStatus,'PASS');
  assert.deepEqual(final.files.get(a.evidence.path),aBytes);assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
});


test('private recipe reviews retain exactly the removed output witness across fresh formal proof',async t=>{
  const f=await completedBlockingCase(t,{extraOutput:true}),start=await startCompletedApply(f);
  await completedApplyRound(f,start,{edit:'export const greeting="hello";\n',beforeVerify:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs'))});
  await publish(start.handle);await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
  const before=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(before.files.get('continuity.json'))).deliveries[0];
  const old=JSON.parse(Buffer.from(before.files.get(c.evidence.path))),proof=old.findingsChecks[0].sources.removalProofs[0];
  for(const round of [1,2]) {
    const image=await captureCurrentExecution(f.specPath),input=reviewInput(image,round),proposal=prepareCurrentLocalReview(input);
    const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent private recipe review with a removed private output.',
      evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Revalidate changed recipe while retaining the immutable removal proof.'}))};
    await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
      reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
    if(round===1) {await normalizedFormal(f,{invalid:true});await normalizedFormal(f,{successor:true});}
    else await normalizedFormal(f);
  }
  const final=await captureCurrentExecution(f.specPath),current=JSON.parse(Buffer.from(final.files.get('continuity.json'))).deliveries[0];
  const bundle=JSON.parse(Buffer.from(final.files.get(current.evidence.path)));
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');assert.equal(current.counters.findingsChecks,1);
  assert.equal(bundle.findingsChecks.length,0);assert.equal(bundle.support.filter(item=>item.kind==='findings-check').length,1);
  assert.deepEqual(bundle.objects.find(item=>item.id===proof),old.objects.find(item=>item.id===proof));
  assert.deepEqual(final.inspection.completed,before.inspection.completed);
});


test('concluded malformed EXECUTE preserves a blocked receipt without inventing Tested state',async t=>{
  const f=await completedPristineCase(t),first=await execute(f,{beforeCapture:async({file})=>{
    const tool=JSON.parse(await fs.readFile(file));tool.finalResponse='{first malformed mechanical result';await fs.writeFile(file,JSON.stringify(tool)+'\n');
  }});
  await publish(first.start.handle);const rejected=await captureCurrentExecution(f.specPath);
  const c=JSON.parse(Buffer.from(rejected.files.get('continuity.json'))).deliveries[0];assert.equal(c.counters.implementationChecks,0);
  const bundle=JSON.parse(Buffer.from(rejected.files.get(c.evidence.path))),record=bundle.support[0];
  const receipt=JSON.parse(Buffer.from(bundle.objects.find(item=>item.id===record.sources.receipt).bytesBase64,'base64'));
  assert.equal(receipt.testedState,null);assert.equal(receipt.status,'RUNNER_RESULT_BLOCKED');
  const second=await execute(f,{successor:true});await publish(second.start.handle);await formal(f);
  assert.equal((await captureCurrentExecution(f.specPath)).inspection.deliveries[0].formalStatus,'PASS');
});


test('coherently resealed counters cannot reset the rejected episode',async t=>{
  const f=await completedPristineCase(t),first=await execute(f,{invalid:true});await publish(first.start.handle);
  const image=await captureCurrentExecution(f.specPath),original=JSON.parse(Buffer.from(image.files.get('continuity.json')));
  for(const field of ['consumedInvocations','causeSha256','sourceOperationAttemptId']) {
    const fixture={execution:f.view.execution,activation:JSON.parse(Buffer.from(image.activationBytes)),
      files:new Map([...image.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),continuity:structuredClone(original)};
    const n=fixture.continuity.deliveries[0].normalization;
    if(field==='consumedInvocations')n[field]=0;
    if(field==='causeSha256')n[field]='sha256:'+'a'.repeat(64);
    if(field==='sourceOperationAttemptId')n[field]='00000000-0000-4000-8000-000000000099';
    reseal(fixture);await writeImage(fixture);await assert.rejects(()=>captureCurrentExecution(f.specPath),/normalization|refusal/i);
    for(const[name,bytes]of image.files)await fs.writeFile(path.join(f.view.execution,name),bytes);
    await fs.writeFile(path.join(f.view.execution,'activation.json'),image.activationBytes);
  }
  assert.equal((await captureCurrentExecution(f.specPath)).inspection.normalHandoff?.operation,'EXECUTE_SLICE');
});


test('private review after normalized EXECUTE keeps its first formal and inherited source authority',async t=>{
  const f=await completedPristineCase(t),first=await execute(f,{invalid:true});await publish(first.start.handle);
  const second=await execute(f,{successor:true});await publish(second.start.handle);
  const image=await captureCurrentExecution(f.specPath),input=reviewInput(image,1),proposal=prepareCurrentLocalReview(input);
  const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent private review before first formal of a normalized implementation.',
    evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Private reporter changed; preserve literal implementation and rejected predecessor until independent current formal.'}))};
  await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
    reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
  await formal(f);const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');assert.equal(final.inspection.deliveries[0].counters.implementationChecks,1);
  assert.equal(final.inspection.deliveries[0].counters.validationAttempts,1);assert.deepEqual(final.inspection.completed,image.inspection.completed);
});


test('a coherently rebound source cannot claim a different predecessor closure',async t=>{
  const f=await completedPristineCase(t),first=await execute(f,{invalid:true});await publish(first.start.handle);
  const second=await execute(f,{successor:true});await publish(second.start.handle);
  const image=await captureCurrentExecution(f.specPath),continuity=JSON.parse(Buffer.from(image.files.get('continuity.json'))),current=continuity.deliveries[0];
  const bundle=JSON.parse(Buffer.from(image.files.get(current.evidence.path))),record=bundle.implementation.at(-1),oldId=record.sources.origin;
  const stored=bundle.objects.find(item=>item.id===oldId),capsule=JSON.parse(Buffer.from(stored.bytesBase64,'base64'));
  for(const key of ['originUtf8','dispatchUtf8']) {
    const origin=JSON.parse(capsule[key]);origin.admission.baseActivation.lastAttempt.operationAttemptId='00000000-0000-4000-8000-000000000099';
    origin.admission.reservedActivation.lastAttempt.operationAttemptId='00000000-0000-4000-8000-000000000099';capsule[key]=JSON.stringify(origin)+'\n';
  }
  const body=Buffer.from(JSON.stringify(capsule)+'\n'),newId='sha256:'+createHash('sha256').update(body).digest('hex');
  record.sources.origin=newId;stored.id=newId;stored.bytesBase64=body.toString('base64');bundle.objects.sort((a,b)=>a.id<b.id?-1:1);
  const bytes=Buffer.from(JSON.stringify(bundle)+'\n');current.evidence.sha256='sha256:'+createHash('sha256').update(bytes).digest('hex');
  const fixture={execution:f.view.execution,activation:JSON.parse(Buffer.from(image.activationBytes)),files:new Map([...image.files].map(([name,value])=>[name,Buffer.from(value)])),continuity};
  fixture.files.set(current.evidence.path,bytes);reseal(fixture);await writeImage(fixture);
  await assert.rejects(()=>captureCurrentExecution(f.specPath),/predecessor closure/);
});

for(const removalAt of ['refusal','successor','successor-after-FAIL','successor-review-exhausted'])test(`retained normalized EXECUTE removal keeps its exact predecessor closure (${removalAt})`,async t=>{
  const f=await completedPristineCase(t,{extraOutput:true});
  const deleted=await fs.readFile(path.join(f.root,'other/obsolete module.mjs'));
  const first=await execute(f,{invalid:true,...(removalAt==='successor-after-FAIL'?{statuses:['TESTS_FAIL','TESTS_PASS'],invalidAt:2}:{}),
    ...(removalAt==='refusal'?{beforeReserve:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs'))}:{})});
  await publish(first.start.handle);
  const second=await execute(f,{successor:true,...(removalAt!=='refusal'?{beforeReserve:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs'))}:{})});await publish(second.start.handle);
  await formal(f);
  await fs.writeFile(path.join(f.root,'other/greeting.mjs'),'export const greeting="broken";\n');
  const finding={id:'finding-01',severity:'blocking',originAttempt:'attempt-02',problem:'The greeting export regressed.',
    evidence:'The prepared assertion observes broken instead of hello.',impact:'AC-001 is unmet.',relatedAuthority:'AC-001; obligation-01',expectedCorrection:'Restore hello.'};
  await completedFormal(f,{status:'NEEDS_FIX',findings:[finding],references:'finding-01',dispositions:'finding-01=active'});
  const start=await startCompletedApply(f);await completedApplyRound(f,start,{edit:'export const greeting="hello";\n'});await publish(start.handle);
  if(removalAt.startsWith('successor')&&removalAt!=='successor-after-FAIL')await normalizedFormal(f,{invalid:true});
  await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved',successor:removalAt==='successor'||removalAt==='successor-review-exhausted'});
  if(removalAt==='successor'||removalAt==='successor-review-exhausted') {
    const before=await captureCurrentExecution(f.specPath),input=reviewInput(before,1),proposal=prepareCurrentLocalReview(input);
    const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent approval retaining the normalized EXECUTE removal closure.',
      evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'The private recipe changed; revalidate without rewriting the retained removal episode.'}))};
    await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,
      reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
    await normalizedFormal(f,{invalid:true});
    if(removalAt==='successor-review-exhausted') {
      await normalizedFormal(f,{successor:true,invalid:true});
      await normalizedFormal(f,{successor:true,invalid:true});
    }
    else await completedFormal(f,{successor:true});
    if(removalAt==='successor') {
      const previous=await captureCurrentExecution(f.specPath),next=reviewInput(previous,2),candidate=prepareCurrentLocalReview(next);
      const approval={...candidate.reviewRequest,decision:'approved',summary:'Controlled independent second private recipe review after normalized formal proof.',
        evidenceDecisions:candidate.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Revalidate the second private recipe change, preserving only demanded immutable witnesses.'}))};
      await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:next.planBytes,
        reviewedTaskBytes:next.reviewedTaskBytes,currentTaskBytes:next.currentTaskBytes,review:approval});
      await completedFormal(f);
    }
  }
  const image=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(image.files.get('continuity.json'))).deliveries[0],bundle=JSON.parse(Buffer.from(image.files.get(c.evidence.path)));
  assert.equal(image.inspection.deliveries[0].formalStatus,removalAt==='successor-review-exhausted'?null:'PASS');
  if(removalAt==='successor-review-exhausted') {
    assert.equal(c.normalization.status,'exhausted');assert.equal(c.normalization.consumedInvocations,3);
    assert.equal(c.counters.validationAttempts,3);assert.equal(image.inspection.normalHandoff,null);
    await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:image.inspection.activationId}));
  }
  const checks=bundle.support.filter(item=>item.kind==='implementation-check');assert.equal(checks.length,removalAt==='successor-after-FAIL'?2:1);
  const refusal=bundle.support.find(item=>item.kind==='rejection'&&item.origin.operation==='EXECUTE_SLICE');assert.ok(refusal);assert.equal(refusal.operationAttemptId,first.start.owner.operationAttemptId);
  const proofs=[...checks,refusal].flatMap(item=>item.sources.removalProofs);assert.equal(proofs.length,1);
  assert.deepEqual(Buffer.from(JSON.parse(Buffer.from(bundle.objects.find(item=>item.id===proofs[0]).bytesBase64,'base64')).bytesBase64,'base64'),deleted);
});

for(const removalAt of ['successor','refusal'])for(const exhausted of removalAt==='successor'?[false,true]:[false])test(`normalized APPLY removal survives private review and fresh formal; removalAt=${removalAt}; exhausted=${exhausted}`,async t=>{
  const f=await completedBlockingCase(t,{extraOutput:true}),first=await startCompletedApply(f);
  await completedApplyRound(f,first,{invalid:true,...(removalAt==='refusal'?{beforeVerify:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs'))}:{})});await publish(first.handle);
  const next=await startCompletedApply(f,{successor:true});
  await completedApplyRound(f,next,{edit:'export const greeting="hello";\n',...(removalAt==='successor'?{beforeVerify:async()=>fs.rm(path.join(f.root,'other/obsolete module.mjs'))}:{})});
  await publish(next.handle);await completedFormal(f,{references:'finding-01',dispositions:'finding-01=resolved'});
  const before=await captureCurrentExecution(f.specPath);
  for(const round of [1,2]) {
    const image=await captureCurrentExecution(f.specPath),input=reviewInput(image,round),proposal=prepareCurrentLocalReview(input);
    const review={...proposal.reviewRequest,decision:'approved',summary:'Controlled independent private review of normalized APPLY removal.',evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(x=>({...x,reason:'Revalidate recipe with exact predecessor and removal witness.'}))};
    await publishCurrentLocalReview({specPath:f.specPath,slice:f.delivery.slice,planBytes:input.planBytes,reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
    if(exhausted) {
      await normalizedFormal(f,{invalid:true});await normalizedFormal(f,{successor:true,invalid:true});
      await normalizedFormal(f,{successor:true,invalid:true});
      const stopped=await captureCurrentExecution(f.specPath),c=JSON.parse(Buffer.from(stopped.files.get('continuity.json'))).deliveries[0];
      assert.equal(c.normalization.status,'exhausted');assert.equal(c.normalization.consumedInvocations,3);assert.equal(stopped.inspection.normalHandoff,null);
      await assert.rejects(()=>normalizeSuccessor({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:stopped.inspection.activationId}));return;
    }
    await normalizedFormal(f);
  }
  const final=await captureCurrentExecution(f.specPath);
  assert.equal(final.inspection.deliveries[0].formalStatus,'PASS');
  const c=JSON.parse(Buffer.from(final.files.get('continuity.json'))).deliveries[0],bundle=JSON.parse(Buffer.from(final.files.get(c.evidence.path)));
  assert.equal(bundle.support.filter(x=>x.kind==='rejection'&&x.origin.operation==='APPLY_FINDINGS').length,1);
  assert.equal(c.counters.findingsChecks,1);assert.deepEqual(final.inspection.completed,before.inspection.completed);
  for(const field of ['operation','deliveryId','slice','missing-refusal']) {
    const continuity=JSON.parse(Buffer.from(final.files.get('continuity.json'))),current=continuity.deliveries[0];
    const changed=JSON.parse(Buffer.from(final.files.get(current.evidence.path)));
    if(field==='missing-refusal') {
      changed.support=changed.support.filter(item=>item.kind!=='rejection');
      const refs=new Set([...changed.implementation,...changed.findingsChecks,...changed.support,changed.validation].filter(Boolean).flatMap(item=>Object.values(item.sources).flat()).filter(item=>typeof item==='string'));
      changed.objects=changed.objects.filter(item=>refs.has(item.id));
    } else {
      const record=changed.support.find(item=>item.kind==='findings-check'),oldId=record.sources.origin;
      const stored=changed.objects.find(item=>item.id===oldId),capsule=JSON.parse(Buffer.from(stored.bytesBase64,'base64'));
      for(const key of ['originUtf8','dispatchUtf8']) {
        const origin=JSON.parse(capsule[key]),value=field==='operation'?'EXECUTE_SLICE':field==='slice'?'slice-99':'00000000-0000-4000-8000-000000000099';
        origin.admission.baseActivation.lastAttempt[field]=value;origin.admission.reservedActivation.lastAttempt[field]=value;capsule[key]=JSON.stringify(origin)+'\n';
      }
      const body=Buffer.from(JSON.stringify(capsule)+'\n'),newId='sha256:'+createHash('sha256').update(body).digest('hex');
      record.sources.origin=newId;stored.id=newId;stored.bytesBase64=body.toString('base64');changed.objects.sort((a,b)=>a.id<b.id?-1:1);
    }
    const bytes=Buffer.from(JSON.stringify(changed)+'\n');current.evidence.sha256='sha256:'+createHash('sha256').update(bytes).digest('hex');
    const fixture={execution:f.view.execution,activation:JSON.parse(Buffer.from(final.activationBytes)),files:new Map([...final.files].map(([name,value])=>[name,Buffer.from(value)])),continuity};
    fixture.files.set(current.evidence.path,bytes);reseal(fixture);await writeImage(fixture);
    await assert.rejects(()=>captureCurrentExecution(f.specPath),/retained APPLY (?:predecessor closure|successor has no bounded predecessor)/);
    for(const[name,value]of final.files)await fs.writeFile(path.join(f.view.execution,name),value);
    await fs.writeFile(path.join(f.view.execution,'activation.json'),final.activationBytes);
  }
});
