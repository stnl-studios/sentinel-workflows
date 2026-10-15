import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initialArtifacts,REQUIREMENTS} from './fixtures/current-initial-preparation.mjs';
import {projectInitialPreparation} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {resolveCurrentExecutionContext} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {inspectCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {installCurrentInitial,recoverCurrentInitialPublication} from '../skills/workflows/stnl-slice-executor/runtime/install-current-initial.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {payload as initialPayload} from './fixtures/current-initial-evidence.mjs';

const run=promisify(execFile);
const repo=path.resolve('.');
async function fixture({otherInput=false}={}) {
  const root=await fs.mkdtemp(path.join(repo,'tmp/stnl-initial-test-'));
  await run('git',['-C',root,'init','-q']);
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  await fs.mkdir(path.join(root,'specs/pay'),{recursive:true});
  await fs.mkdir(path.join(root,'src'));
  const specPath=path.join(root,'specs/pay/requirements.md');
  await fs.writeFile(specPath,'# Initial delivery\n\nAC-001: export pay.\n');
  await fs.writeFile(path.join(root,'src/pay.test.mjs'),
    'import test from "node:test";import assert from "node:assert/strict";import {pay} from "./pay.mjs";test("AC-001",()=>assert.equal(pay(),"paid"));\n');
  if(otherInput) await fs.writeFile(path.join(root,'src/other.txt'),'independent input\n');
  const before=await inspectCurrentExecution(specPath);
  const {context}=await resolveCurrentExecutionContext(specPath);
  const artifacts=new Map([...initialArtifacts({form:'standalone'})].map(([name,bytes])=>{
    let content=bytes.toString('utf8').replaceAll(REQUIREMENTS,before.requirementsAuthority);
    if(otherInput && ['plans/slice-02.md','tasks/slice-02.md'].includes(name)) content=content
      .replace('## Existing Inputs\n\n- none\n\n','## Existing Inputs\n\n- `../../../../src/other.txt`\n\n');
    return [name,Buffer.from(content)];
  }));
  const projected=projectInitialPreparation({context,requirementsAuthority:before.requirementsAuthority,artifacts});
  const hashes=new Map(projected.artifactHashes.map(item=>[item.path,item.sha256]));
  const decision=(scope,hash,names)=>({scope,decision:'approved',authoritySha256:hash,
    examinedArtifactHashes:[...names].sort().map(name=>({path:name,sha256:hashes.get(name)})),
    evidenceDecisions:[],summary:'Reviewed the exact Initial preparation bytes for the local fixture.'});
  const review={globalReview:decision('set',projected.globalReviewAuthoritySha256,['plan.md','tasks.md']),
    deliveries:projected.deliveries.map(item=>({deliveryId:item.deliveryId,
      review:decision('slice',item.authoritySha256,[`plans/${item.slice}.md`,`tasks/${item.slice}.md`])}))};
  const preparationRoot=path.join(root,'reviewed');
  for(const [name,bytes] of artifacts) {
    const target=path.join(preparationRoot,name);
    await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.writeFile(target,bytes);
  }
  await run('git',['-C',root,'add','.gitignore','specs/pay/requirements.md','src/pay.test.mjs',
    ...(otherInput?['src/other.txt']:[])]);
  await run('git',['-C',root,'-c','user.name=Sentinel','-c','user.email=sentinel@example.invalid',
    'commit','-qm','fixture baseline']);
  return {root,specPath,preparationRoot,review};
}
async function reserved(f,responseVariant) {
  const image=await inspectCurrentExecution(f.specPath);
  const started=await begin({specPath:f.specPath,slice:image.normalHandoff.slice,
    expectedActivationId:image.activationId,operation:'EXECUTE_SLICE'});
  const dispatch=await reserveDispatch(started.handle,responseVariant?{responseVariant}:undefined);
  return {started,dispatch};
}

test('Initial new native judgment binds HEAD without runner transcription',async()=>{
  const f=await fixture();
  await installCurrentInitial(f);
  const {started,dispatch}=await reserved(f,'stnl-current-native-judgment-v1');
  assert.equal(dispatch.responseVariant,'stnl-current-native-judgment-v1');
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  await bindNative(started.handle,'mechanical-initial-judgment');
  const measured=await verifyNative(dispatch.originFile);
  const {head,...result}=initialPayload(1);
  result.commands=measured.commands;
  const response=JSON.stringify({format:'stnl-current-native-judgment-v1',result});
  const file=path.join(f.root,'mechanical-tool.json');
  await fs.writeFile(file,JSON.stringify({agentId:'mechanical-initial-judgment',status:'completed',finalResponse:response})+'\n');
  const captured=await captureNative(started.handle,file);
  assert.equal(captured.status,'TESTS_PASS');
  assert.equal((await publish(started.handle)).publication,'confirmed');
  assert.equal((await inspectCurrentExecution(f.specPath)).normalHandoff.operation,'VALIDATE_SLICE');
});

test('Initial native judgment EXECUTE, formal NEEDS_FIX, APPLY and new formal use one selected variant',async()=>{
  const f=await fixture();
  await installCurrentInitial(f);
  let ordinal=0;
  async function operation(kind,{before=null,after=null,status,findings=[]}={}) {
    if(before!==null) await fs.writeFile(path.join(f.root,'src/pay.mjs'),before);
    const inspection=await inspectCurrentExecution(f.specPath);
    const started=await begin({specPath:f.specPath,slice:'slice-01',
      expectedActivationId:inspection.activationId,operation:kind});
    if(after!==null) await fs.writeFile(path.join(f.root,'src/pay.mjs'),after);
    const dispatch=await reserveDispatch(started.handle,{responseVariant:'stnl-current-native-judgment-v1'});
    const agentId=`mechanical-initial-cycle-${++ordinal}`;
    await bindNative(started.handle,agentId);
    const measured=await verifyNative(dispatch.originFile);
    const request=JSON.parse(await fs.readFile(dispatch.requestFile));
    let result;
    if(kind==='EXECUTE_SLICE') {
      const {head,...semantic}=initialPayload(1);
      result=semantic;
      result.commands=measured.commands;
    } else if(kind==='VALIDATE_SLICE') result={status,
      commands:measured.commands,evidence:'The prepared pay assertion was executed with its recorded exit.',
      findingReferences:findings.length?'finding-01':status==='PASS'?'finding-01':'none',
      findingDispositions:findings.length?'finding-01=active':status==='PASS'?'finding-01=resolved':'none',
      blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'No runner edits.'};
    else result={status:'TESTS_PASS',automaticCheckRound:'1/3',
      discoverySources:'Approved task, source and test.',discoveryActions:'Inspected approved source and test.',
      verificationTypesConsidered:'Approved Node module test.',nonApplicabilityRationale:'none',
      noVerificationCommandConfirmation:'An applicable check ran.',commands:measured.commands,
      resultOfEachCommandAndExitCode:'The approved module test completed.',
      selectedChecks:'Approved Node module test.',selectionRationale:'AC-001 coverage.',
      coverage:'The pay export is exercised by the prepared test.',findingsVerified:'finding-01',
      correctionsCovered:'The pay export now equals paid.',regressionsSelected:'Pay import assertion.',
      unsupportedActiveFindings:'none',failures:'none',evidenceOrFailureSummary:'The approved test exited zero.',
      affectedFilesOrBehaviors:'src/pay.mjs',blockers:'none',unexpectedWorkspaceEffects:'none',
      persistenceSummary:'The native helper retained the reviewed observation; the runner made no product changes.'};
    const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result,
      ...(kind==='VALIDATE_SLICE'?{newFindings:findings.map(item=>({...item,originAttempt:request.attemptId}))}:{})});
    const file=path.join(f.root,`mechanical-initial-cycle-${ordinal}.json`);
    await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
    const captured=await captureNative(started.handle,file);
    assert.equal(captured.status,kind==='APPLY_FINDINGS'?'TESTS_PASS':status??'TESTS_PASS');
    const published=await publish(started.handle);
    assert.equal(published.publication,'confirmed');
    return inspectCurrentExecution(f.specPath);
  }
  const paid='export const pay=()=>"paid";\n';
  const broken='export const pay=()=>"broken";\n';
  const execute=await operation('EXECUTE_SLICE',{after:paid});
  assert.equal(execute.normalHandoff.operation,'VALIDATE_SLICE');
  const finding={id:'finding-01',severity:'blocking',problem:'The pay export returns broken.',
    evidence:'The prepared assertion fails on the pay result.',impact:'AC-001 is unmet.',
    relatedAuthority:'AC-001',expectedCorrection:'Restore the pay result to paid.'};
  const formal=await operation('VALIDATE_SLICE',{before:broken,status:'NEEDS_FIX',findings:[finding]});
  assert.equal(formal.normalHandoff.operation,'APPLY_FINDINGS');
  const apply=await operation('APPLY_FINDINGS',{after:paid});
  assert.equal(apply.normalHandoff.operation,'VALIDATE_SLICE');
  const final=await operation('VALIDATE_SLICE',{status:'PASS'});
  assert.equal(final.deliveries[0].formalStatus,'PASS');
  assert.deepEqual(final.deliveries[0].counters,
    {implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1});
});

test('Initial ingress installs reviewed bytes once and reads back pristine',async()=>{
  const f=await fixture();
  const installed=await installCurrentInitial(f);
  assert.equal(installed.publication,'confirmed');
  const image=await inspectCurrentExecution(f.specPath);
  assert.equal(image.state,'MATERIALIZED_PRISTINE');
  assert.deepEqual(image.normalHandoff.operation,'EXECUTE_SLICE');
  await assert.rejects(installCurrentInitial(f),error=>error.code==='STALE_BASE');
  assert.equal((await inspectCurrentExecution(f.specPath)).activationId,image.activationId);
});

test('Initial interruption before activation restores absence and permits a fresh reviewed install',async()=>{
  const f=await fixture();
  await assert.rejects(installCurrentInitial({...f,checkpoint:step=>{
    if(step==='before-activation') throw new Error('injected before activation');
  }}),/injected before activation/);
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
  const installed=await installCurrentInitial(f);
  assert.equal(installed.publication,'confirmed');
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'MATERIALIZED_PRISTINE');
});

test('Initial rejects a reviewed source changed at before-backup under the publication lock',async()=>{
  const f=await fixture();
  await assert.rejects(installCurrentInitial({...f,checkpoint:async step=>{
    if(step==='before-backup') await fs.appendFile(path.join(f.preparationRoot,'plan.md'),'\nlate edit\n');
  }}),error=>error.code==='STALE_APPROVAL');
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
});

test('Initial rejects requirements changed at before-backup under the publication lock',async()=>{
  const f=await fixture();
  await assert.rejects(installCurrentInitial({...f,checkpoint:async step=>{
    if(step==='before-backup') await fs.appendFile(f.specPath,'\nlate requirement\n');
  }}),error=>error.code==='STALE_APPROVAL');
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
});

test('Initial rejects product input changed at before-backup under the publication lock',async()=>{
  const f=await fixture();
  await assert.rejects(installCurrentInitial({...f,checkpoint:async step=>{
    if(step==='before-backup') await fs.appendFile(path.join(f.root,'src/pay.test.mjs'),'// late input edit\n');
  }}),error=>error.code==='EVIDENCE_STALE');
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
});

test('Initial interruption after activation recovers the exact installed image',async()=>{
  const f=await fixture();
  let allocation;
  await assert.rejects(installCurrentInitial({...f,checkpoint:step=>{
    if(step==='after-activation') throw new Error('injected after activation');
  }}),error=>{
    allocation=error.allocation;
    return /activation outcome uncertain/u.test(error.message) && typeof allocation==='string';
  });
  const before=await inspectCurrentExecution(f.specPath);
  assert.equal(before.state,'MATERIALIZED_PRISTINE');
  const recovered=await recoverCurrentInitialPublication({specPath:f.specPath,allocation});
  assert.equal(recovered.publication,'confirmed');
  assert.equal(recovered.cleanup,'complete');
  assert.equal((await inspectCurrentExecution(f.specPath)).activationId,before.activationId);
});

test('Initial recovery refuses another execution allocation',async()=>{
  const first=await fixture();
  const second=await fixture();
  const installed=await installCurrentInitial(first);
  await installCurrentInitial(second);
  await assert.rejects(recoverCurrentInitialPublication({specPath:second.specPath,
    allocation:installed.allocation}),/another execution/u);
});

test('Initial native recipe permits absent approved output after admission',async()=>{
  const f=await fixture();
  await installCurrentInitial(f);
  const {started,dispatch}=await reserved(f);
  assert.equal(dispatch.round,1);
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  await bindNative(started.handle,'mechanical-initial-runner');
  const verified=await verifyNative(dispatch.originFile);
  assert.equal(verified.status,'completed');
  assert.deepEqual(verified.commands.map(item=>item.exit),[0]);
});

test('Initial native preflight blocks a changed approved test reference before recipe',async()=>{
  const f=await fixture();
  await installCurrentInitial(f);
  const {started,dispatch}=await reserved(f);
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  await fs.appendFile(path.join(f.root,'src/pay.test.mjs'),'// foreign input edit\n');
  await bindNative(started.handle,'mechanical-initial-input-drift');
  await assert.rejects(verifyNative(dispatch.originFile),error=>error.code==='EVIDENCE_STALE');
  const verification=path.join(path.dirname(dispatch.originFile),'round-1.verification.json');
  await assert.rejects(fs.lstat(verification),error=>error.code==='ENOENT');
});

test('Initial native preflight blocks another delivery input change',async()=>{
  const f=await fixture({otherInput:true});
  await installCurrentInitial(f);
  const {started,dispatch}=await reserved(f);
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  await fs.writeFile(path.join(f.root,'src/other.txt'),'changed independent input\n');
  await bindNative(started.handle,'mechanical-initial-other-drift');
  await assert.rejects(verifyNative(dispatch.originFile),error=>error.code==='EVIDENCE_STALE');
  const verification=path.join(path.dirname(dispatch.originFile),'round-1.verification.json');
  await assert.rejects(fs.lstat(verification),error=>error.code==='ENOENT');
});
