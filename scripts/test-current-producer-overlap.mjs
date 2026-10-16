import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {overlappingPostImage,retireActive} from './fixtures/current-reader-campaign.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {captureCurrentExecution as captureQuality} from '../skills/workflows/stnl-slice-quality-manager/runtime/execution-current-reader.mjs';
import {begin,publish,resume} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {inspectPostConversionEvidence,validateCurrentEvidenceCarriers} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {validateCurrentPreparation} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';

const run=promisify(execFile),sha=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const body=(text,name)=>text.split(`## ${name}\n\n`)[1].split('\n## ')[0].trim();

test('P01 controlled controller publishes prior overlap, resumes exact bytes, then clears obsolete overlap',async t=>{
  const fixture=await overlappingPostImage(t,{operationOnly:true});
  const captured=await normalizedFormal(fixture,{captureOnly:true});
  assert.ok(captured.captured&&!captured.captureError);
  const handle=captured.start.handle,ownerRoot=path.dirname(captured.dispatch.originFile);
  const sources=new Map(await Promise.all(['response','receipt','observation','origin','request','tool-result','agent','claim']
    .map(async suffix=>[suffix,await fs.readFile(path.join(ownerRoot,`round-1.${suffix}.json`))])));
  const admitted=await fs.readFile(path.join(fixture.image.f.execution,'activation.json'));
  await assert.rejects(()=>publish(handle,{checkpoint:async phase=>{
    if(phase==='after-candidate-file')throw new Error('controlled overlap candidate interruption');
  }}),/controlled overlap candidate interruption/u);
  assert.deepEqual(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')),admitted);
  const handleFile=path.join(fixture.root,'overlap-handle.json');await fs.writeFile(handleFile,JSON.stringify(handle)+'\n');
  const guard=path.join(fixture.root,'no-new-runner.mjs');
  await fs.writeFile(guard,`import childProcess from 'node:child_process';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
for(const method of ['execFile','execFileSync','spawn','spawnSync','fork','exec','execSync']) {
  const original=childProcess[method];
  childProcess[method]=function(command,...args) {
    if(path.basename(String(command))!=='git')throw new Error('Unexpected new runner/check during captured-byte recovery: '+command);
    return original.call(this,command,...args);
  };
}
syncBuiltinESMExports();\n`);
  const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
  const separate=async command=>{
    try{return JSON.parse((await run(process.execPath,['--import',guard,cli,command,'--handle',handleFile],{timeout:30000})).stdout);}
    catch(error){error.message+='\n'+(error.stdout??'');throw error;}
  };
  const resumed=await separate('resume');assert.equal(resumed.nextAction,'normalize');assert.equal(resumed.responseSha256,sha(sources.get('response')));
  const normalized=await separate('normalize');assert.equal(normalized.rawResponseSha256,sha(sources.get('response')));
  // Validate the fully composed carrier while A1 is still official. Neither
  // malformed presentation is installed or allowed to alter captured proof.
  const candidate=path.join(ownerRoot,'candidate'),a1=JSON.parse(admitted);
  const candidateFiles=new Map(await Promise.all(a1.artifacts.map(async item=>[item.path,await fs.readFile(path.join(candidate,item.path))])));
  const snapshotBytes=candidateFiles.get('approved-preparation.json');
  const continuity=JSON.parse(candidateFiles.get('continuity.json'));
  for(const item of continuity.deliveries)if(item.evidence&&!candidateFiles.has(item.evidence.path))
    candidateFiles.set(item.evidence.path,await fs.readFile(path.join(candidate,item.evidence.path)));
  const input=await captureCurrentExecutionAfterAdmission(fixture);
  const prepared=validateCurrentPreparation({context:input.context,requirementsAuthority:input.requirementsAuthority,
    snapshotBytes,artifacts:new Map([...candidateFiles].filter(([name])=>name.endsWith('.md'))),profile:'converted-current'});
  const carrier=prepared.currentArtifacts.deliveries.find(item=>item.slice==='slice-02'),selected=continuity.deliveries.at(-1);
  const facts=await inspectPostConversionEvidence({context:input.context,snapshotBytes,current:selected,
    bundleBytes:candidateFiles.get(selected.evidence.path),observedWork:selected.baseline});
  const priorDeliveries=[];
  for(const prior of continuity.deliveries.slice(0,-1))priorDeliveries.push({slice:prior.slice,
    facts:await inspectPostConversionEvidence({context:input.context,snapshotBytes,current:prior,
      bundleBytes:candidateFiles.get(prior.evidence.path),observedWork:prior.baseline})});
  const validate=sections=>validateCurrentEvidenceCarriers({facts,sections,
    continuity:{...carrier.continuity,evidence:selected.evidence.path},index:carrier.index,slice:selected.slice,priorDeliveries});
  assert.doesNotThrow(()=>validate(carrier.sections));
  const overlap=carrier.sections['Prior Validation Overlap'];
  for(const declaration of ['- none',overlap.replace('Slice 03 overlap','Slice 01 overlap')])
    assert.throws(()=>validate({...carrier.sections,'Prior Validation Overlap':declaration}),
      error=>error.code==='INVALID_CURRENT_IMAGE'&&/Prior Validation Overlap/u.test(error.message));
  assert.deepEqual(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')),admitted);
  const published=await separate('publish');assert.equal(published.publication,'confirmed');assert.equal(published.cleanup,'complete');
  for(const [suffix,bytes]of sources)assert.deepEqual(await fs.readFile(path.join(ownerRoot,`round-1.${suffix}.json`)),bytes);
  await assert.rejects(fs.lstat(path.join(ownerRoot,'round-2.origin.json')),error=>error.code==='ENOENT');
  const first=await captureCurrentExecution(fixture.specPath),quality=await captureQuality(fixture.specPath);
  assert.deepEqual(first.inspection,quality.inspection);assert.equal(first.inspection.deliveries.at(-1).formalStatus,'PASS');
  const current=JSON.parse(Buffer.from(first.files.get('continuity.json'))).deliveries.at(-1);
  assert.equal(current.counters.validationAttempts,2);
  const task=Buffer.from(first.files.get('tasks/slice-02.md')).toString('utf8');
  assert.match(body(task,'Prior Validation Overlap'),/Slice 03 overlap:.*other\/greeting\.mjs/u);
  assert.doesNotMatch(body(task,'Prior Validation Overlap'),/Slice 01 overlap/u);
  // The completed view is an authored preparation only. Reuse the controller's
  // exact carrier and proof; no new native operation with completed is admitted.
  for(const selectors of [['slice-01'],['slice-01','slice-03']]) {
    const snapshot=JSON.parse(Buffer.from(first.files.get('approved-preparation.json')));
    const view={project:fixture.root,execution:fixture.image.f.execution,specPath:fixture.specPath,
      source:fixture.specPath,spec:path.dirname(fixture.specPath),authority:first.requirementsAuthority,
      activation:JSON.parse(Buffer.from(first.activationBytes)),snapshot,
      files:new Map([...first.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),
      artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8)])),
      continuity:JSON.parse(Buffer.from(first.files.get('continuity.json')))};
    try {
      await retireActive(view,selectors);const completed=await captureCurrentExecution(fixture.specPath);
      assert.equal(completed.inspection.completed.length,selectors.length);
      assert.ok(completed.inspection.completed.every(item=>item.observedValidation==='current'));
      assert.deepEqual(completed.inspection.deliveries.map(item=>item.slice),selectors.length===1?['slice-03','slice-02']:['slice-02']);
      assert.deepEqual(Buffer.from(completed.files.get('tasks/slice-02.md')),Buffer.from(first.files.get('tasks/slice-02.md')));
      assert.deepEqual(Buffer.from(completed.files.get(current.evidence.path)),Buffer.from(first.files.get(current.evidence.path)));
      assert.notEqual(completed.inspection.state,'COMPLETE');
    } finally {
      for(const [name,bytes]of first.files) {await fs.mkdir(path.dirname(path.join(view.execution,name)),{recursive:true});await fs.writeFile(path.join(view.execution,name),bytes);}
      await fs.writeFile(path.join(view.execution,'activation.json'),first.activationBytes);
    }
  }
  // Only B's private output drifts. Its next legal validation has no overlap
  // with C's verified scope, so the producer must replace the old declaration.
  await fs.writeFile(path.join(fixture.root,'third/later.mjs'),'export const greeting="private update";\n');
  const next=await normalizedFormal(fixture);assert.equal(next.published.publication,'confirmed');
  const final=await captureCurrentExecution(fixture.specPath);
  assert.equal(body(Buffer.from(final.files.get('tasks/slice-02.md')).toString('utf8'),'Prior Validation Overlap'),'- none');
  assert.equal(final.inspection.deliveries.at(-1).counters.validationAttempts,3);
  assert.equal(final.inspection.normalHandoff,null);
});

async function captureCurrentExecutionAfterAdmission(fixture) {
  const {captureCurrentActiveExecution}=await import('../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs');
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  return captureCurrentActiveExecution(fixture.specPath,activation.activeAttempt);
}

test('P02 controlled shared input drift blocks publication and resumes the same captured bytes after restoration',async t=>{
  const fixture=await overlappingPostImage(t,{operationOnly:true,sharedInput:true});
  const input=path.join(fixture.root,'shared-config.json'),original=await fs.readFile(input);
  await fs.writeFile(input,'{"mode":"drift"}\n');
  const drifted=await captureCurrentExecution(fixture.specPath);
  assert.equal(drifted.inspection.deliveries[0].observedValidation,'current');
  assert.equal(drifted.inspection.deliveries[1].observedValidation,'revalidation-required');
  assert.equal(drifted.inspection.deliveries[2].observedValidation,'revalidation-required');
  assert.equal(drifted.inspection.normalHandoff.slice,'slice-03');
  await assert.rejects(()=>begin({specPath:fixture.specPath,slice:'slice-02',expectedActivationId:drifted.inspection.activationId}),
    error=>error.code==='UNSUPPORTED_FORMAT');
  await fs.writeFile(input,original);
  const captured=await normalizedFormal(fixture,{captureOnly:true});assert.ok(captured.captured&&!captured.captureError);
  const root=path.dirname(captured.dispatch.originFile),raw=await fs.readFile(path.join(root,'round-1.response.json'));
  const observation=await fs.readFile(path.join(root,'round-1.observation.json'));
  const receipt=await fs.readFile(path.join(root,'round-1.receipt.json'));
  const admitted=await fs.readFile(path.join(fixture.image.f.execution,'activation.json'));
  await fs.writeFile(input,'{"mode":"drift-after-capture"}\n');
  await assert.rejects(()=>publish(captured.start.handle),error=>error.code==='EVIDENCE_STALE');
  assert.deepEqual(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')),admitted);
  await fs.writeFile(input,original);
  assert.equal((await resume(captured.start.handle)).responseSha256,sha(raw));
  const published=await publish(captured.start.handle);assert.equal(published.publication,'confirmed');
  for(const [suffix,bytes]of [['response',raw],['observation',observation],['receipt',receipt]])
    assert.deepEqual(await fs.readFile(path.join(root,`round-1.${suffix}.json`)),bytes);
  await assert.rejects(fs.lstat(path.join(root,'round-2.origin.json')),error=>error.code==='ENOENT');
  const final=await captureCurrentExecution(fixture.specPath);
  assert.ok(final.inspection.deliveries.every(item=>item.observedValidation==='current'));
  assert.equal(final.inspection.deliveries.at(-1).counters.validationAttempts,2);
  assert.doesNotMatch(body(Buffer.from(final.files.get('tasks/slice-02.md')).toString('utf8'),'Prior Validation Overlap'),/shared-config/u);
});
