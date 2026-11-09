import {publishPreparationCandidate} from './fixtures/synthetic-preparation-approval.mjs';
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

import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {READY_FIXTURE} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const product=await loadProduct(path.resolve(import.meta.dirname,'..'));

test('converted retained proof survives retirement and terminal reentry validation through public CLOSE',async t=>{
  const cleanups=[];
  t.after(async()=>{for(const cleanup of cleanups)await cleanup();});
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
  const completed=JSON.parse(Buffer.from(before.files.get('continuity.json'))).completed[0];
  assert.ok(completed);
  const rewrite=(e,name,bytes,{rebind=true}={})=>{
    e.source.files=e.source.files.filter(item=>item.name!==name);
    if(bytes!==null)e.source.files.push({name,bytesBase64:bytes.toString('base64'),sha256:sha(bytes)});
    if(rebind) {
      const activation=JSON.parse(Buffer.from(e.source.activationBase64,'base64'));
      activation.artifacts=activation.artifacts.filter(item=>item.path!==name);
      if(bytes!==null)activation.artifacts.push({path:name,sha256:sha(bytes)});
      activation.artifacts.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
      e.source.activationBase64=Buffer.from(JSON.stringify(activation)).toString('base64');
      e.disposition.artifactManifestSha256=sha(Buffer.from(JSON.stringify(activation.artifacts)));
    }
    e.sourceSha256=sha(Buffer.from(JSON.stringify(e.source)));
  };
  // Rebind capsule/activation digests where indicated so these refusals prove
  // the full layout and normative/evidence guards, not just an outer checksum.
  for(const [label,mutate] of [
    ['foreign Markdown',e=>rewrite(e,'plans/slice-99.md',Buffer.from('foreign Markdown\n'))],
    ['incomplete retained pair',e=>rewrite(e,`plans/${completed.slice}.md`,null)],
    ['retained document bytes',e=>rewrite(e,`tasks/${completed.slice}.md`,Buffer.from('changed retained bytes\n'),{rebind:false})],
    ['reviewed carrier',e=>rewrite(e,'plan.md',Buffer.from(Buffer.from(before.files.get('plan.md')).toString().replace(/^- Plan revision: .+$/mu,'- Plan revision: 999')))],
    ['evidence digest',e=>rewrite(e,completed.evidence.path,Buffer.concat([before.files.get(completed.evidence.path),Buffer.from(' ')]))],
    ['snapshot authority',e=>{
      const approved=JSON.parse(Buffer.from(before.files.get('approved-preparation.json')));
      approved.requirementsAuthority='sha256:'+'0'.repeat(64);
      rewrite(e,'approved-preparation.json',Buffer.from(JSON.stringify(approved)));
    }],
  ]) {
    const bad=structuredClone(pre);mutate(bad);
    await assert.rejects(validateRetainedSource({product,evidence:bad,specPath,workspace}),
      error=>['INVALID_CURRENT_IMAGE','STALE_APPROVAL','REQUIREMENTS_CHANGED','EVIDENCE_INCOMPLETE','EVIDENCE_STALE'].includes(error.code),label);
  }
  assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,before.activationBytes);
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,before.files);

  const receipt=await publishCandidate('CLOSE',specPath,null);
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
