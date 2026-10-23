import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {completedNativeCase,reopeningInput} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {loadProduct} from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
import {retainBeforeClose,finishCloseEvidence,validateRetainedSource,validateTerminalEvidence} from '../benchmarks/sentinel-todo/runtime/native-evidence.mjs';
import {publishCandidate} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import {preparePreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {publishPreparationCandidate} from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {READY_FIXTURE} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const product=await loadProduct(path.resolve(import.meta.dirname,'..'));

test('converted retained proof is verified, but required public CLOSE remains a discriminant',async t=>{
  const cleanups=[];let preserve=false;
  t.after(async()=>{if(!preserve)for(const cleanup of cleanups)await cleanup();});
  const f=await completedNativeCase({after:cleanup=>cleanups.push(cleanup)},{documentarySource:READY_FIXTURE,drift:false,retire:false});
  const specPath=path.dirname(f.specPath),workspace=await fs.realpath(f.root);
  const source=await captureCurrentExecution(f.specPath),snapshot=JSON.parse(Buffer.from(source.files.get('approved-preparation.json')));
  async function replace(input,terminalValidation=false) {
    const draft=await preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',
      completedDeliveryIds:input.completedDeliveryIds,terminalValidation});
    for(const [name,bytes]of input.artifacts) {
      const file=path.join(draft.candidateExecutionRoot,name);
      await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
    }
    const options={specPath:f.specPath,candidateExecutionRoot:draft.candidateExecutionRoot};
    const pending=await publishPreparationCandidate(options);
    const approve=request=>({...request,decision:'approved',summary:'Offline exact reviewed replacement; not model acceptance.',
      evidenceDecisions:request.evidenceDecisions.map(item=>({...item,reason:'Verified local proof and current ownership.'}))});
    await publishPreparationCandidate({...options,reviewDecision:{globalReview:approve(pending.reviewRequest.globalReview),
      deliveries:pending.reviewRequest.deliveries.map(item=>({deliveryId:item.deliveryId,review:approve(item.review)}))}});
  }
  const members=JSON.parse(Buffer.from(source.files.get('continuity.json'))).deliveries;
  await replace({completedDeliveryIds:members.map(item=>item.deliveryId),
    artifacts:new Map(snapshot.reviewedArtifacts.filter(item=>['plan.md','tasks.md'].includes(item.path)).map(item=>
      [item.path,Buffer.from(item.utf8.split('\n').filter(line=>!line.includes('| 01 - Foundation |')&&!line.includes('| 02 - Verification |')).join('\n'))]))});
  const retired=await captureCurrentExecution(f.specPath);
  const input=reopeningInput(retired,f.delivery.deliveryId,{terminalValidation:true});
  await replace(input,true);
  const beforeTerminal=await captureCurrentExecution(f.specPath);
  await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  const pre=await retainBeforeClose({product,specPath,workspace,artifacts:{}});
  assert.ok(pre.source.inspection.completed.length>0);
  await validateRetainedSource({product,evidence:pre,specPath,workspace});
  const before=await captureCurrentExecution(f.specPath);
  for(const mutate of [
    e=>{e.disposition.activationId='00000000-0000-0000-0000-000000000000';},
    e=>{e.source.manifests.pop();},
    e=>{e.source.files.find(item=>item.name==='continuity.json').bytesBase64=Buffer.from('{}').toString('base64');},
    e=>{e.source.context.productRoot+='/foreign';},
  ]) {
    const bad=structuredClone(pre);mutate(bad);
    await assert.rejects(validateRetainedSource({product,evidence:bad,specPath,workspace}));
  }
  assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,before.activationBytes);
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,before.files);
  const beforeDocuments=JSON.stringify(product.workspaceSnapshot(specPath));
  let receipt;
  try { receipt=await publishCandidate('CLOSE',specPath,null); }
  catch(error) {
    preserve=true;
    const origins=image=>[...image.files].filter(([name])=>name.startsWith('evidence/')).flatMap(([,bytes])=>{
      const bundle=JSON.parse(Buffer.from(bytes));
      return [...bundle.implementation,bundle.validation,...bundle.findingsChecks,...bundle.support].filter(Boolean)
        .map(record=>({deliveryId:record.origin.deliveryId,operation:record.origin.operation,
          operationAttemptId:record.origin.operationAttemptId,preparationRevision:record.origin.preparationRevision}));
    });
    const before=origins(beforeTerminal), after=origins(await captureCurrentExecution(f.specPath));
    const lost=before.filter(item=>!after.some(other=>other.operationAttemptId===item.operationAttemptId));
    const blockedPath=error.message.split(': ').at(-1);
    const afterImage=await captureCurrentExecution(f.specPath);
    const sourceBytesPreserved=pre.source.activationBase64===Buffer.from(afterImage.activationBytes).toString('base64')
      &&pre.source.files.length===afterImage.files.size
      &&pre.source.files.every(file=>file.bytesBase64===Buffer.from(afterImage.files.get(file.name)).toString('base64'));
    const documentsPreserved=beforeDocuments===JSON.stringify(product.workspaceSnapshot(specPath));
    const owner=blockedPath.startsWith(workspace+'/tmp/')?JSON.parse(await fs.readFile(path.join(blockedPath,'owner.json'))):null;
    await fs.writeFile(path.resolve('tmp/u3-planejamento/U3.16-S2-2026-10-23.noPvk5/converted-close-blocker-reviewed.json'),
      JSON.stringify({error:error.message,fixtureRoot:workspace,sourceSetup:'authored current EC-1 boundary; subsequent native-shaped local checks, Q18 retirement, Q20 reentry and terminal validation use public producers; no model',
        before,after,lost,blockedOwner:owner?.binding?.owner??null,retirementState:owner?.phase??null,sourceBytesPreserved,documentsPreserved,sourcePreserved:(await captureCurrentExecution(f.specPath)).inspection.state==='COMPLETE'},null,2)+'\n');
    assert.equal(sourceBytesPreserved,true);assert.equal(documentsPreserved,true);
    assert.ok(lost.some(item=>item.operationAttemptId===owner.binding.owner.operationAttemptId));
    throw error;
  }
  const evidence=await finishCloseEvidence({product,pre,commandResults:[receipt]});
  await validateTerminalEvidence({product,evidence,specPath,workspace});
  for(const field of ['sourceSha256','sourceActivationId','transactionId']) {
    const bad=structuredClone(evidence);
    if(field==='sourceSha256') bad[field]='sha256:'+'0'.repeat(64);
    else if(field==='sourceActivationId') bad.disposition.activationId='00000000-0000-0000-0000-000000000000';
    else bad.receipt.transactionId='invalid';
    await assert.rejects(validateTerminalEvidence({product,evidence:bad,specPath,workspace}));
  }
  const bad=structuredClone(evidence);
  bad.source.manifests.pop(); bad.sourceSha256=sha(Buffer.from(JSON.stringify(bad.source)));
  await assert.rejects(validateTerminalEvidence({product,evidence:bad,specPath,workspace}));
});
