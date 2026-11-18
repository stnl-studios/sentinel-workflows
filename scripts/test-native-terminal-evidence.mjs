import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {validateCurrentImage} from '../skills/workflows/stnl-slice-executor/runtime/execution-current.mjs';
import {validateWorkspace} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs';
import {publishCandidate} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';

import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {READY_FIXTURE} from '../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';


test('converted retained proof survives retirement and terminal validation through public CLOSE',async t=>{
  const cleanups=[];
  t.after(async()=>{for(const cleanup of cleanups)await cleanup();});
  const f=await completedNativeCase({after:cleanup=>cleanups.push(cleanup)},{documentarySource:READY_FIXTURE,drift:true,retire:true});
  const specPath=path.dirname(f.specPath);
  await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  // The retired benchmark capsule/receipt wrapper is intentionally not retained.
  // Exercise the product's current image and public CLOSE directly.
  const before=await captureCurrentExecution(f.specPath);
  assert.equal(before.inspection.state,'COMPLETE');
  assert.ok(before.inspection.completed.length>0);
  validateCurrentImage({activationBytes:before.activationBytes,files:before.files});
  for(const [label,mutate]of [
    ['missing continuity',files=>files.delete('continuity.json')],
    ['changed continuity',files=>files.set('continuity.json',Buffer.from('{}'))],
    ['foreign carrier',files=>files.set('plans/slice-99.md',Buffer.from('foreign Markdown\n'))],
    ['changed reviewed carrier',files=>files.set('plan.md',Buffer.from('changed plan\n'))],
    ['changed approved snapshot',files=>files.set('approved-preparation.json',Buffer.from('{}'))],
  ]){
    const files=new Map(before.files);mutate(files);
    assert.throws(()=>validateCurrentImage({activationBytes:before.activationBytes,files}),undefined,label);
  }
  assert.deepEqual((await captureCurrentExecution(f.specPath)).activationBytes,before.activationBytes);
  assert.deepEqual((await captureCurrentExecution(f.specPath)).files,before.files);
  const receipt=await publishCandidate('CLOSE',specPath,null);
  assert.equal(receipt.publication,'confirmed');
  assert.equal(receipt.cleanup,'complete');
  assert.equal(validateWorkspace(specPath).closed,true);
});
