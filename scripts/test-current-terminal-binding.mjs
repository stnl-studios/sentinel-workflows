import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {minimalImage,completedImage,proofBundle,DELIVERY_ID} from './fixtures/current-execution-images.mjs';
import {completedNativeCase} from './fixtures/current-completed-native.mjs';
import {normalizedFormal} from './fixtures/current-native-normalization.mjs';
import {completedFindingsCycle} from './fixtures/current-native-findings-operation.mjs';
import {nativeOperationCase} from './fixtures/current-native-operation.mjs';
import {begin,reserveDispatch,bindNative,verifyNative} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {currentTerminalProjection,validateCurrentTerminalProjection,validateCurrentEvidence} from
  '../skills/workflows/stnl-slice-executor/runtime/execution-current.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {completedEvidenceContext} from '../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs';
import {retireActive} from './fixtures/current-reader-campaign.mjs';

const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
const decode=value=>JSON.parse(Buffer.from(value));
const run=promisify(execFile);
const invalid=error=>['INVALID_CURRENT_IMAGE','EVIDENCE_STALE','EVIDENCE_INCOMPLETE',
  'OWNER_MISMATCH','UNSUPPORTED_FORMAT'].includes(error.code);

test('Terminal projection normalizes owner UUID without mutating active/completed leaves or proof',()=>{
  const a=minimalImage(),c=completedImage(proofBundle());
  const before=[JSON.stringify(a),JSON.stringify(c)];
  const active=currentTerminalProjection(a.preparation),completed=currentTerminalProjection(c.preparation);
  assert.deepEqual(active,completed);
  assert.equal(active.deliveries[0].obligations[0].fullOwner,DELIVERY_ID);
  assert.equal(a.preparation.normativeProjection.deliveries[0].obligations[0].fullOwner,'slice-01');
  assert.equal(c.preparation.normativeProjection.completed[0].obligations[0].fullOwner,'delivery:'+DELIVERY_ID);
  assert.deepEqual([JSON.stringify(a),JSON.stringify(c)],before);
  active.deliveries[0].verificationRecipe.checks[0].inputs.push({kind:'input',path:'isolated.json'});
  assert.equal(a.preparation.normativeProjection.deliveries[0].verificationRecipe.checks[0].inputs.length,0);
});

test('Terminal projection rejects unknown fields, selector owners and missing dependencies',()=>{
  const value=currentTerminalProjection(minimalImage().preparation);
  for(const mutate of [
    x=>{x.extra=true;},x=>{x.deliveries[0].extra=true;},
    x=>{x.deliveries[0].obligations[0].fullOwner='slice-01';},
    x=>{x.deliveries[0].obligations[0].fullOwner='delivery:'+DELIVERY_ID;},
    x=>{x.deliveries[0].dependencies=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'];},
  ]) {
    const changed=structuredClone(value);mutate(changed);
    assert.throws(()=>validateCurrentTerminalProjection(changed),invalid);
  }
});

test('Terminal frozen request and admitted snapshot are verified before executing the recipe',async t=>{
  const f=await nativeOperationCase(t);
  const start=await begin({specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:f.activationId});
  const dispatch=await reserveDispatch(start.handle,{terminal:true,responseVariant:'stnl-current-native-judgment-v1'});
  await bindNative(start.handle,'mechanical-terminal-preflight');
  const requestBytes=await fs.readFile(dispatch.requestFile),originBytes=await fs.readFile(dispatch.originFile);
  const request=decode(requestBytes);request.terminal.objective+=' foreign';
  await fs.writeFile(dispatch.requestFile,json(request));
  await assert.rejects(()=>verifyNative(dispatch.originFile),error=>error.code==='EVIDENCE_STALE'&&/before recipe/u.test(error.message));
  await fs.writeFile(dispatch.requestFile,requestBytes);
  const origin=decode(originBytes);origin.terminalPreparationUtf8+=' ';
  await fs.writeFile(dispatch.originFile,json(origin));
  await assert.rejects(()=>verifyNative(dispatch.originFile),error=>error.code==='OWNER_MISMATCH');
  await assert.rejects(fs.lstat(path.join(path.dirname(dispatch.originFile),'round-1.verification.json')),{code:'ENOENT'});
});

// These are controlled native-shaped captures in disposable workspaces, never
// official model conclusions or evidence for the later live acceptance block.
test('Terminal v3 binds admitted active+completed snapshot and certifies COMPLETE after verified recovery',async t=>{
  const f=await completedNativeCase(t),before=await captureCurrentExecution(f.specPath);
  const snapshotBytes=Buffer.from(before.files.get('approved-preparation.json'));
  const snapshot=decode(snapshotBytes),a=decode(before.files.get('continuity.json')).completed[0];
  const result=await normalizedFormal(f,{terminal:true,responseVariant:'stnl-current-native-judgment-v1',
    partial:true,terminalFault:true,
    evidence:'Mechanical terminal binding case; no real global judgment is claimed.'});
  const request=decode(await fs.readFile(result.dispatch.requestFile)),origin=decode(await fs.readFile(result.dispatch.originFile));
  assert.equal(request.format,'stnl-current-validation-request-v3');
  assert.equal(result.dispatch.requestSha256,sha(await fs.readFile(result.dispatch.requestFile)));
  assert.equal(origin.requestSha256,result.dispatch.requestSha256);
  assert.deepEqual(Buffer.from(origin.terminalPreparationUtf8),snapshotBytes);
  assert.equal(sha(Buffer.from(origin.terminalPreparationUtf8)),origin.admission.baseActivation.approvedSnapshotSha256);
  assert.equal(origin.admission.reservedActivation.approvedSnapshotSha256,sha(snapshotBytes));
  assert.deepEqual(Object.keys(request.authority).sort(),['context','delivery','localRevision','normativeSha256','preparationRevision']);
  assert.deepEqual(Object.keys(request.authority.context).sort(),['objective','requirementsAuthority','risks','strategy']);
  const leaves=[...snapshot.normativeProjection.deliveries,...snapshot.normativeProjection.completed];
  const bySlice=new Map([...snapshot.deliveries,...snapshot.completed].map(item=>[item.slice,item.deliveryId]));
  const expected={requirementsAuthority:snapshot.requirementsAuthority,
    objective:snapshot.normativeProjection.global.objective,strategy:snapshot.normativeProjection.global.strategy,
    risks:snapshot.normativeProjection.global.risks,deliveries:leaves.map(leaf=>({...leaf,
      obligations:leaf.obligations.map(item=>({...item,fullOwner:item.fullOwner.startsWith('delivery:')
        ?item.fullOwner.slice(9):bySlice.get(item.fullOwner)}))})).sort((a,b)=>a.deliveryId<b.deliveryId?-1:1)};
  assert.deepEqual(request.terminal,expected);
  const after=await captureCurrentExecution(f.specPath),continuity=decode(after.files.get('continuity.json'));
  const selected=continuity.deliveries[0],bundle=decode(after.files.get(selected.evidence.path));
  assert.deepEqual(bundle.validation.contract.terminal,expected);
  assert.equal(bundle.validation.origin.normativeSha256,request.authority.normativeSha256);
  assert.equal(bundle.validation.origin.localRevision,request.authority.localRevision);
  assert.deepEqual(Buffer.from(after.files.get('approved-preparation.json')),snapshotBytes);
  assert.deepEqual(Buffer.from(after.files.get(a.evidence.path)),Buffer.from(before.files.get(a.evidence.path)));
  const raw=await fs.readFile(path.join(path.dirname(result.dispatch.originFile),'round-1.response.json'));
  assert.deepEqual(raw,Buffer.from(result.finalResponse));
  assert.equal(sha(raw),result.captured.rawResponseSha256);
  assert.equal(after.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(after.inspection.state,'COMPLETE');
  assert.equal(after.inspection.normalHandoff,null);
  await fs.rename(path.join(f.root,'tmp/sentinel'),path.join(f.root,'tmp/retired-terminal-controls'));
  const cli=path.resolve('skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
  const fresh=JSON.parse((await run(process.execPath,[cli,'inspect','--spec-path',f.specPath])).stdout);
  assert.deepEqual(fresh,after.inspection);

  const inspect=async mutate=>{
    const changed=structuredClone(bundle);mutate(changed);
    const files=new Map(after.files),bytes=json(changed),next=structuredClone(continuity);
    files.set(selected.evidence.path,bytes);next.deliveries[0].evidence.sha256=sha(bytes);
    return completedEvidenceContext({context:after.context,snapshotBytes,continuity:next,files});
  };
  const replaceOrigin=(b,mutate)=>{
    const id=b.validation.sources.origin,object=b.objects.find(item=>item.id===id),capsule=decode(Buffer.from(object.bytesBase64,'base64'));
    mutate(capsule);const bytes=json(capsule),next=sha(bytes);
    b.validation.sources.origin=next;object.id=next;object.bytesBase64=bytes.toString('base64');
    b.objects.sort((a,b)=>a.id<b.id?-1:1);
  };
  const cases={
    'record terminal appended or changed after conclusion':b=>{b.validation.contract.terminal.objective+=' changed';},
    'record terminal stripped after conclusion':b=>{b.validation.contract.terminal=null;},
    'request terminal differs from admitted snapshot':b=>replaceOrigin(b,c=>{
      const r=JSON.parse(c.validationRequestUtf8);r.terminal.risks+=' foreign';c.validationRequestUtf8=JSON.stringify(r)+'\n';
    }),
    'unknown request field':b=>replaceOrigin(b,c=>{
      const r=JSON.parse(c.validationRequestUtf8);r.foreign=true;c.validationRequestUtf8=JSON.stringify(r)+'\n';
    }),
    'null terminal field is not a local request':b=>replaceOrigin(b,c=>{
      const r=JSON.parse(c.validationRequestUtf8);r.terminal=null;c.validationRequestUtf8=JSON.stringify(r)+'\n';
    }),
    'missing snapshot witness':b=>replaceOrigin(b,c=>{
      const o=JSON.parse(c.originUtf8);delete o.terminalPreparationUtf8;c.originUtf8=JSON.stringify(o)+'\n';
    }),
    'snapshot same content with foreign bytes':b=>replaceOrigin(b,c=>{
      const o=JSON.parse(c.originUtf8);o.terminalPreparationUtf8+=' ';c.originUtf8=JSON.stringify(o)+'\n';
    }),
    'missing official admission':b=>replaceOrigin(b,c=>{
      const o=JSON.parse(c.originUtf8);delete o.admission;c.originUtf8=JSON.stringify(o)+'\n';
    }),
    'A1 no longer descends from A0':b=>replaceOrigin(b,c=>{
      const o=JSON.parse(c.originUtf8);o.admission.reservedActivation.previousActivationId=o.admission.reservedActivation.activationId;
      c.originUtf8=JSON.stringify(o)+'\n';
    }),
  };
  for(const [name,mutate] of Object.entries(cases))await t.test(name,()=>assert.rejects(()=>inspect(mutate),invalid));

  const view={project:f.root,execution:f.image.f.execution,specPath:f.specPath,source:f.specPath,
    spec:path.dirname(f.specPath),authority:after.requirementsAuthority,activation:decode(after.activationBytes),
    snapshot:decode(snapshotBytes),continuity,files:new Map([...after.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),
    artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8)]))};
  await retireActive(view,['slice-02']);
  const retired=await captureCurrentExecution(f.specPath),done=decode(retired.files.get('continuity.json')).completed;
  const retained=decode(retired.files.get(done.find(item=>item.deliveryId===selected.deliveryId).evidence.path));
  assert.deepEqual(retained.validation,bundle.validation);
  assert.deepEqual(retained.objects,bundle.objects);
  assert.deepEqual(currentTerminalProjection(decode(retired.files.get('approved-preparation.json'))),expected);
  assert.equal(retired.inspection.completed.length,2);
  assert.equal(retired.inspection.state,'COMPLETE');
});

test('Terminal v4 after APPLY retains local auxiliary contracts without terminal judgment',async t=>{
  const {fixture,formal}=await completedFindingsCycle(t,{terminal:true});
  const request=decode(await fs.readFile(formal.dispatch.requestFile));
  assert.equal(request.format,'stnl-current-validation-request-v4');
  const image=await captureCurrentExecution(fixture.specPath),current=decode(image.files.get('continuity.json')).deliveries[0];
  const bundle=decode(image.files.get(current.evidence.path));
  assert.deepEqual(bundle.validation.contract.terminal,request.terminal);
  assert.ok(bundle.findingsChecks.length>0);
  for(const check of [...bundle.implementation,...bundle.findingsChecks])assert.equal(check.contract.terminal,null);
  assert.equal(image.inspection.deliveries[0].formalStatus,'PASS');
  assert.equal(image.inspection.state,'COMPLETE');
  const changed=structuredClone(bundle);changed.findingsChecks[0].contract.terminal=request.terminal;
  assert.throws(()=>validateCurrentEvidence(changed),invalid);
});
