import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {initialArtifacts,REQUIREMENTS} from './fixtures/current-initial-preparation.mjs';
import {projectInitialPreparation} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {resolveCurrentExecutionContext} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {inspectCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {inspectCurrentExecution as inspectQualityExecution} from '../skills/workflows/stnl-slice-quality-manager/runtime/execution-current-reader.mjs';
import {installCurrentInitial,recoverCurrentInitialPublication} from '../skills/workflows/stnl-slice-executor/runtime/install-current-initial.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish,normalizeSuccessor,resume} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import {payload as initialPayload} from './fixtures/current-initial-evidence.mjs';
import {applyPayload} from './fixtures/current-findings-evidence.mjs';

import {preparePreparationCandidate} from '../skills/workflows/stnl-slice-executor/runtime/prepare-task-candidate.mjs';
import {captureExecutionTree,resolveExecutionFilesystemRoots,executionLockIdentity} from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
const run=promisify(execFile);
const repo=path.resolve('.');
const operationCli=path.join(repo,'skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function fixture({otherInput=false,kind='standalone',entry='file'}={}) {
  const root=await fs.mkdtemp(path.join(repo,'tmp/stnl-initial-test-'));
  await run('git',['-C',root,'init','-q']);
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  await fs.mkdir(path.join(root,'specs/pay'),{recursive:true});
  await fs.mkdir(path.join(root,'src'));
  const authorityPath=path.join(root,'specs/pay',kind==='lifecycle'?'feature_spec.md':'requirements.md');
  const specPath=kind==='lifecycle'&&entry==='directory'?path.dirname(authorityPath):authorityPath;
  const lifecycleHeader='# File Purpose Header\n\n```yaml\npurpose: Pay feature.\nstatus: ready\nread_when: Reviewing pay.\ndo_not_read_when: Another feature is selected.\ncontains: Pay requirements.\nowner: stnl-spec-lifecycle-manager\nupdate_policy: Author writes.\n```\n\n';
  const lifecycleBody='# Feature: Pay\n\n'+[['Objective','Pay export.'],['Context','Pay module.'],['Scope','Pay export.'],['Out of Scope','Authentication.'],['Business Rules','Observe pay.'],['Relevant Contracts','AC-001: Pay export.']].map(([name,body])=>`## ${name}\n\n${body}\n\n`).join('');
  await fs.writeFile(authorityPath,kind==='lifecycle'?lifecycleHeader+lifecycleBody:'# Initial delivery\n\nAC-001: export pay.\n');
  await fs.writeFile(path.join(root,'src/pay.test.mjs'),
    'import test from "node:test";import assert from "node:assert/strict";import {pay} from "./pay.mjs";test("AC-001",()=>assert.equal(pay(),"paid"));\n');
  if(otherInput) await fs.writeFile(path.join(root,'src/other.txt'),'independent input\n');
  const before=await inspectCurrentExecution(specPath);
  const {context}=await resolveCurrentExecutionContext(specPath);
  const artifacts=new Map([...initialArtifacts({form:kind})].map(([name,bytes])=>{
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
  await run('git',['-C',root,'add','.gitignore',path.relative(root,authorityPath),'src/pay.test.mjs',
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

async function sealedBlockingFormal(f) {
  await installCurrentInitial(f);
  const execute=await reserved(f,'stnl-current-native-judgment-v1');
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  await bindNative(execute.started.handle,'controlled-apply-predecessor-execute');
  const executeMeasured=await verifyNative(execute.dispatch.originFile);
  const {head,...executeResult}=initialPayload(1);
  executeResult.commands=executeMeasured.commands;
  const executeFile=path.join(f.root,'controlled-apply-predecessor-execute.json');
  await fs.writeFile(executeFile,JSON.stringify({agentId:'controlled-apply-predecessor-execute',status:'completed',
    finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result:executeResult})})+'\n');
  await captureNative(execute.started.handle,executeFile);
  await publish(execute.started.handle);
  const prior=await inspectCurrentExecution(f.specPath);
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"broken";\n');
  const formal=await begin({specPath:f.specPath,slice:'slice-01',
    expectedActivationId:prior.activationId,operation:'VALIDATE_SLICE'});
  const formalDispatch=await reserveDispatch(formal.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  await bindNative(formal.handle,'controlled-apply-predecessor-formal');
  const formalMeasured=await verifyNative(formalDispatch.originFile);
  const request=JSON.parse(await fs.readFile(formalDispatch.requestFile));
  const finding={id:'finding-01',severity:'blocking',originAttempt:request.attemptId,
    problem:'The pay export returns broken.',evidence:'The prepared assertion fails on the pay result.',
    impact:'AC-001 is unmet.',relatedAuthority:'AC-001',expectedCorrection:'Restore the pay result to paid.'};
  const formalResult={status:'NEEDS_FIX',commands:formalMeasured.commands,
    evidence:'The prepared pay assertion failed with the recorded exit.',
    findingReferences:'finding-01',findingDispositions:'finding-01=active',blockers:'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'No runner edits.'};
  const formalFile=path.join(f.root,'controlled-apply-predecessor-formal.json');
  await fs.writeFile(formalFile,JSON.stringify({agentId:'controlled-apply-predecessor-formal',status:'completed',
    finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result:formalResult,newFindings:[finding]})})+'\n');
  await captureNative(formal.handle,formalFile);
  await publish(formal.handle);
  const inspection=await inspectCurrentExecution(f.specPath);
  assert.equal(inspection.normalHandoff.operation,'APPLY_FINDINGS');
  return inspection;
}

test('Initial first APPLY semantic refusal publishes from the same captured bytes after partial failure',async()=>{
  const f=await fixture();
  const predecessor=await sealedBlockingFormal(f);
  const started=await begin({specPath:f.specPath,slice:'slice-01',
    expectedActivationId:predecessor.activationId,operation:'APPLY_FINDINGS'});
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  const dispatch=await reserveDispatch(started.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  const agentId='controlled-apply-refusal';
  await bindNative(started.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const {head,...result}=applyPayload(1,'TESTS_PASS',0);
  result.commands=measured.commands;
  result.coverage='none'; // controlled semantic defect after one verified APPLY recipe
  const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result});
  const file=path.join(f.root,'controlled-apply-refusal.json');
  await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
  const foreign=path.join(f.root,'controlled-apply-refusal-foreign.json');
  await fs.writeFile(foreign,JSON.stringify({agentId:'foreign-agent',status:'completed',finalResponse})+'\n');
  await assert.rejects(captureNative(started.handle,foreign),error=>error.code==='OWNER_MISMATCH');
  const captured=await captureNative(started.handle,file);
  assert.equal(captured.captureClass,'initial-rejection');
  assert.equal(captured.nextAction,'publish');
  assert.equal(captured.rawResponseSha256,digest(Buffer.from(finalResponse)));
  assert.equal((await captureNative(started.handle,file)).replayed,true);
  const changed=path.join(f.root,'controlled-apply-refusal-changed.json');
  await fs.writeFile(changed,JSON.stringify({agentId,status:'completed',finalResponse:finalResponse+' '})+'\n');
  await assert.rejects(captureNative(started.handle,changed),error=>error.code==='OWNER_MISMATCH');
  const owned=path.dirname(dispatch.originFile);
  const responseBefore=await fs.readFile(path.join(owned,'round-1.response.json'));
  const observationBefore=await fs.readFile(path.join(owned,'round-1.observation.json'));
  assert.equal(digest(responseBefore),captured.rawResponseSha256);
  let interrupted=false;
  await assert.rejects(publish(started.handle,{checkpoint:phase=>{
    if(phase==='after-candidate-file') {interrupted=true;throw new Error('controlled APPLY partial candidate');}
  }}),/controlled APPLY partial candidate/u);
  assert.equal(interrupted,true);
  const handleFile=path.join(f.root,'controlled-apply-refusal-handle.json');
  await fs.writeFile(handleFile,JSON.stringify(started.handle)+'\n');
  const cli=async command=>JSON.parse((await run(process.execPath,[operationCli,command,'--handle',handleFile])).stdout);
  const resumed=await cli('resume');
  assert.equal(resumed.nextAction,'normalize');
  assert.equal(resumed.responseSha256,captured.rawResponseSha256);
  const normalized=await cli('normalize');
  assert.equal(normalized.rawResponseSha256,captured.rawResponseSha256);
  const published=await cli('publish');
  assert.equal(published.publication,'confirmed');
  assert.equal(published.cleanup,'complete');
  assert.equal(published.transition.outcome,'rejected');
  assert.equal(digest(await fs.readFile(path.join(owned,'round-1.response.json'))),captured.rawResponseSha256);
  assert.deepEqual(await fs.readFile(path.join(owned,'round-1.observation.json')),observationBefore);
  await assert.rejects(fs.lstat(path.join(owned,'round-2.origin.json')),error=>error.code==='ENOENT');
  const a=await inspectCurrentExecution(f.specPath),b=await inspectQualityExecution(f.specPath);
  assert.deepEqual(a,b);
  assert.equal(a.state,'VALIDATION_BLOCKED');
  assert.equal(a.normalHandoff,null);
  assert.equal(a.deliveries[0].persistedValidation,'uncertain');
  assert.deepEqual(a.deliveries[0].counters,
    {implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:1});
  assert.deepEqual(a.deliveries[1].counters,
    {implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0});
});

test('Initial first APPLY valid BLOCKED stays distinct from semantic refusal',async()=>{
  const f=await fixture();
  const predecessor=await sealedBlockingFormal(f);
  const started=await begin({specPath:f.specPath,slice:'slice-01',
    expectedActivationId:predecessor.activationId,operation:'APPLY_FINDINGS'});
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  const dispatch=await reserveDispatch(started.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  const agentId='controlled-apply-blocked';
  await bindNative(started.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const {head,...result}=applyPayload(1,'BLOCKED',0);
  result.commands=measured.commands;
  const file=path.join(f.root,'controlled-apply-blocked.json');
  await fs.writeFile(file,JSON.stringify({agentId,status:'completed',
    finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result})})+'\n');
  const captured=await captureNative(started.handle,file);
  assert.equal(captured.status,'BLOCKED');
  assert.equal(captured.captureClass,'formal-response');
});

test('Initial first APPLY malformed native response cannot enter semantic refusal',async()=>{
  const f=await fixture();
  const predecessor=await sealedBlockingFormal(f);
  const started=await begin({specPath:f.specPath,slice:'slice-01',
    expectedActivationId:predecessor.activationId,operation:'APPLY_FINDINGS'});
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  const dispatch=await reserveDispatch(started.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  const agentId='controlled-apply-schema-defect';
  await bindNative(started.handle,agentId);
  await verifyNative(dispatch.originFile);
  const file=path.join(f.root,'controlled-apply-schema-defect.json');
  await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse:'{"invalid":'})+'\n');
  await assert.rejects(captureNative(started.handle,file),error=>error.code==='RUNNER_RESULT_REJECTED');
  const handleFile=path.join(f.root,'controlled-apply-schema-handle.json');
  await fs.writeFile(handleFile,JSON.stringify(started.handle)+'\n');
  const resumed=JSON.parse((await run(process.execPath,[operationCli,'resume','--handle',handleFile])).stdout);
  assert.equal(resumed.nextAction,'stop-and-diagnose');
});

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

test('Initial concluded semantic EXECUTE refusal publishes and resumes the same captured bytes',async()=>{
  const f=await fixture();
  await installCurrentInitial(f);
  const {started,dispatch}=await reserved(f,'stnl-current-native-judgment-v1');
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  const agentId='controlled-initial-refusal';
  await bindNative(started.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const {head,...result}=initialPayload(1);
  result.commands=measured.commands;
  result.coverage='none'; // controlled semantic defect after a real verified recipe
  const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result});
  const file=path.join(f.root,'controlled-refusal-tool.json');
  await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
  const foreign=path.join(f.root,'foreign-refusal-tool.json');
  await fs.writeFile(foreign,JSON.stringify({agentId:'foreign-agent',status:'completed',finalResponse})+'\n');
  await assert.rejects(captureNative(started.handle,foreign),error=>error.code==='OWNER_MISMATCH');
  const captured=await captureNative(started.handle,file);
  assert.equal(captured.captureClass,'initial-rejection');
  assert.equal(captured.rawResponseSha256,digest(Buffer.from(finalResponse)));
  assert.equal((await captureNative(started.handle,file)).replayed,true);
  const different=path.join(f.root,'different-refusal-tool.json');
  await fs.writeFile(different,JSON.stringify({agentId,status:'completed',finalResponse:finalResponse+' '})+'\n');
  await assert.rejects(captureNative(started.handle,different),error=>error.code==='OWNER_MISMATCH');
  const owned=path.dirname(dispatch.originFile);
  const rawBefore=await fs.readFile(path.join(owned,'round-1.response.json'));
  const observationBefore=await fs.readFile(path.join(owned,'round-1.observation.json'));
  assert.equal(digest(rawBefore),captured.rawResponseSha256);
  let fault=false;
  await assert.rejects(publish(started.handle,{checkpoint:phase=>{
    if(phase==='after-candidate-file') {fault=true;throw new Error('controlled partial candidate');}
  }}),/controlled partial candidate/u);
  assert.equal(fault,true);
  const handleFile=path.join(f.root,'controlled-refusal-handle.json');
  await fs.writeFile(handleFile,JSON.stringify(started.handle)+'\n');
  const cli=async command=>JSON.parse((await run(process.execPath,[operationCli,command,'--handle',handleFile])).stdout);
  const resumed=await cli('resume');
  assert.equal(resumed.nextAction,'normalize');
  assert.equal(resumed.responseSha256,captured.rawResponseSha256);
  const normalized=await cli('normalize');
  assert.equal(normalized.rawResponseSha256,captured.rawResponseSha256);
  const published=await cli('publish');
  assert.equal(published.publication,'confirmed');
  assert.equal(published.cleanup,'complete');
  assert.equal(published.transition.outcome,'rejected');
  assert.equal(digest(await fs.readFile(path.join(owned,'round-1.response.json'))),captured.rawResponseSha256);
  assert.deepEqual(await fs.readFile(path.join(owned,'round-1.observation.json')),observationBefore);
  await assert.rejects(fs.lstat(path.join(owned,'round-2.origin.json')),error=>error.code==='ENOENT');
  const a=await inspectCurrentExecution(f.specPath),b=await inspectQualityExecution(f.specPath);
  assert.deepEqual(a,b);
  assert.equal(a.state,'MATERIALIZED_PRISTINE');
  assert.equal(a.normalHandoff.operation,'EXECUTE_SLICE');
  assert.equal(a.deliveries[0].persistedValidation,'revalidation-required');
  assert.deepEqual(a.deliveries[0].counters,
    {implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0});
  assert.deepEqual(a.deliveries[1].counters,
    {implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0});
  await assert.rejects(()=>begin({specPath:f.specPath,slice:'slice-01',
    expectedActivationId:a.activationId,operation:'EXECUTE_SLICE'}));
  const successor=await normalizeSuccessor({specPath:f.specPath,slice:'slice-01',expectedActivationId:a.activationId});
  assert.notEqual(successor.owner.operationAttemptId,started.owner.operationAttemptId);
  const next=await reserveDispatch(successor.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  assert.equal(JSON.parse(await fs.readFile(next.requestFile)).round,2);
});

test('Initial valid BLOCKED is distinct from semantic refusal and remains outside recovery scope',async()=>{
  const f=await fixture();
  await installCurrentInitial(f);
  const {started,dispatch}=await reserved(f,'stnl-current-native-judgment-v1');
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  const agentId='controlled-initial-blocked';
  await bindNative(started.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const {head,...result}=initialPayload(1,'BLOCKED');
  result.commands=measured.commands;
  result.blockers='The inspected authority has an unresolved external dependency.';
  const finalResponse=JSON.stringify({format:'stnl-current-native-judgment-v1',result});
  const file=path.join(f.root,'controlled-blocked-tool.json');
  await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
  const captured=await captureNative(started.handle,file);
  assert.equal(captured.captureClass,'formal-response');
  assert.equal(captured.status,'BLOCKED');
  await assert.rejects(publish(started.handle),error=>error.code==='UNSUPPORTED_FORMAT'
    && /Initial BLOCKED requires operational recovery outside quiet profile/u.test(error.message));
  assert.equal((await captureNative(started.handle,file)).replayed,true);
});

test('Initial malformed native response cannot enter the concluded semantic refusal profile',async()=>{
  const f=await fixture();
  await installCurrentInitial(f);
  const {started,dispatch}=await reserved(f);
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  const agentId='controlled-initial-schema-defect';
  await bindNative(started.handle,agentId);
  await verifyNative(dispatch.originFile);
  const file=path.join(f.root,'controlled-schema-tool.json');
  await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse:'{"invalid":'})+'\n');
  const captured=await captureNative(started.handle,file);
  assert.equal(captured.captureClass,'findings-rejection');
  await assert.rejects(publish(started.handle),error=>error.code==='RUNNER_RESULT_REJECTED');
});

for(const terminal of [false,true])test(`Initial native judgment EXECUTE, formal NEEDS_FIX, APPLY and new formal use one selected variant${terminal?' with terminal request binding':''}`,async()=>{
  const f=await fixture();
  await installCurrentInitial(f);
  let ordinal=0;
  async function operation(kind,{before=null,after=null,status,findings=[]}={}) {
    if(before!==null) await fs.writeFile(path.join(f.root,'src/pay.mjs'),before);
    const inspection=await inspectCurrentExecution(f.specPath);
    const started=await begin({specPath:f.specPath,slice:'slice-01',
      expectedActivationId:inspection.activationId,operation:kind});
    if(after!==null) await fs.writeFile(path.join(f.root,'src/pay.mjs'),after);
    if(terminal && kind!=='VALIDATE_SLICE')await assert.rejects(
      reserveDispatch(started.handle,{terminal:true}),error=>error.code==='INVALID_CURRENT_IMAGE');
    const dispatch=await reserveDispatch(started.handle,{responseVariant:'stnl-current-native-judgment-v1',
      terminal:terminal && kind==='VALIDATE_SLICE'});
    const agentId=`mechanical-initial-cycle-${++ordinal}`;
    await bindNative(started.handle,agentId);
    const measured=await verifyNative(dispatch.originFile);
    const request=JSON.parse(await fs.readFile(dispatch.requestFile));
    assert.equal(Object.hasOwn(request,'terminal'),terminal && kind==='VALIDATE_SLICE');
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
    const continuity=JSON.parse(await fs.readFile(path.join(f.root,'specs/pay/requirements-execution/continuity.json')));
    const bundle=JSON.parse(await fs.readFile(path.join(f.root,'specs/pay/requirements-execution',continuity.deliveries[0].evidence.path)));
    for(const check of [...bundle.implementation,...bundle.findingsChecks])assert.equal(check.contract.terminal,null);
    if(kind==='VALIDATE_SLICE')assert.deepEqual(bundle.validation.contract.terminal,request.terminal??null);
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

test('Initial promotes the same registered PLAN inode and retires only its controls',async()=>{
  const f=await fixture();
  const {workspace}=await resolveCurrentExecutionContext(f.specPath);
  const prepared=await preparePreparationCandidate({specPath:f.specPath,operation:'PLAN'});
  const candidate=prepared.candidateExecutionRoot;
  await fs.cp(f.preparationRoot,candidate,{recursive:true});
  const before=await captureExecutionTree(candidate),source=await captureExecutionTree(f.preparationRoot);
  const installed=await installCurrentInitial({...f,preparationRoot:candidate});
  assert.equal(installed.publication,'confirmed');assert.equal(installed.cleanup,'complete');
  assert.equal(installed.candidateRoot,candidate);assert.equal(installed.preparationDisposition,'retired');
  const live=await captureExecutionTree(workspace.executionRoot);
  assert.deepEqual(live.identity,before.identity,'Initial must rename the reviewed PLAN, not copy its tree');
  assert.deepEqual(live.files.filter(item=>!['activation.json','approved-preparation.json','continuity.json'].includes(item.path)),before.files);
  assert.deepEqual(await captureExecutionTree(f.preparationRoot),source,'external input remains unchanged');
  assert.equal(await fs.stat(candidate).catch(()=>null),null);
  assert.equal(await fs.stat(`${candidate}.owner.json`).catch(()=>null),null);
  assert.equal(await fs.stat(installed.allocation).catch(()=>null),null);
  const roots=await resolveExecutionFilesystemRoots(workspace);
  assert.deepEqual(JSON.parse(await fs.readFile(roots.preparationRegistry)).allocations,[]);
});

for(const point of ['after-install','after-activation-intent'])test(`Initial recovery restores absence and retires its same candidate at ${point}`,async()=>{
  const f=await fixture(),source=await captureExecutionTree(f.preparationRoot);
  let allocation;
  await assert.rejects(installCurrentInitial({...f,checkpoint:step=>{if(step===point)throw new Error('controlled Initial interruption');}}),error=>{
    allocation=error.allocation;return /controlled Initial interruption/.test(error.message)&&typeof allocation==='string';
  });
  const result=await recoverCurrentInitialPublication({specPath:f.specPath,allocation});
  assert.equal(result.publication,'aborted');assert.equal(result.cleanup,'complete');
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
  assert.deepEqual(await captureExecutionTree(f.preparationRoot),source);
});

for(const point of ['before-backup','after-backup'])test(`Initial rejects a byte-identical candidate replacement at ${point} before promotion`,async()=>{
  const f=await fixture();let candidate,saved;
  await assert.rejects(installCurrentInitial({...f,checkpoint:async(step,paths)=>{if(step===point){
    candidate=paths.stage;saved=candidate+'.original';await fs.rename(candidate,saved);await fs.cp(saved,candidate,{recursive:true});
  }}}),/identity|registered|candidate/i);
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
  assert.notDeepEqual((await captureExecutionTree(candidate)).identity,(await captureExecutionTree(saved)).identity);
  assert.deepEqual((await captureExecutionTree(candidate)).files,(await captureExecutionTree(saved)).files);
  await fs.access(`${candidate}.owner.json`);
});

for(const variant of ['rename','sync'])test(`Initial recovery retains its lease on uncertain ${variant} while restoring absence`,async()=>{
  const f=await fixture();let allocation;
  await assert.rejects(installCurrentInitial({...f,checkpoint:step=>{if(step==='after-activation-intent')throw new Error('controlled interruption');}}),error=>{allocation=error.allocation;return /controlled interruption/.test(error.message);});
  const record=JSON.parse(await fs.readFile(allocation)),{workspace}=await resolveCurrentExecutionContext(f.specPath);
  const rename=fs.rename,open=fs.open;let armed=false,injected=0,caught;
  fs.rename=async(from,to)=>{if(from===workspace.executionRoot&&to===record.candidate){
    if(variant==='rename'){injected++;throw Object.assign(Error('controlled rename uncertainty'),{code:'EIO'});}
    const result=await rename(from,to);armed=true;return result;
  }return rename(from,to);};
  fs.open=async(file,...args)=>{if(armed&&file===path.dirname(workspace.executionRoot)){injected++;throw Object.assign(Error('controlled sync uncertainty'),{code:'EIO'});}return open(file,...args);};
  try{await recoverCurrentInitialPublication({specPath:f.specPath,allocation});}catch(error){caught=error;}finally{fs.rename=rename;fs.open=open;}
  assert.equal(injected,1);assert.equal(caught?.retainExecutionLock,true);
  await fs.access(allocation);await fs.access(`${record.candidate}.owner.json`);
  await fs.access((await executionLockIdentity(workspace)).lockPath);
});

for(const entry of ['directory','file'])test(`Initial lifecycle ${entry} entry shares its canonical PLAN and authority`,async()=>{
  const f=await fixture({kind:'lifecycle',entry});
  const drafted=await preparePreparationCandidate({specPath:f.specPath,operation:'PLAN'});
  await fs.cp(f.preparationRoot,drafted.candidateExecutionRoot,{recursive:true});
  const marker=JSON.parse(await fs.readFile(`${drafted.candidateExecutionRoot}.owner.json`));
  assert.equal(path.basename(marker.specPath),'feature_spec.md');
  const alternate=entry==='directory'?path.join(f.specPath,'feature_spec.md'):path.dirname(f.specPath);
  assert.equal((await preparePreparationCandidate({specPath:alternate,operation:'REVIEW_PLAN',candidateExecutionRoot:drafted.candidateExecutionRoot})).status,'AWAITING_REVIEW');
  const installed=await installCurrentInitial({...f,specPath:alternate,preparationRoot:drafted.candidateExecutionRoot});
  assert.equal(installed.cleanup,'complete');
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'MATERIALIZED_PRISTINE');
});

test('Initial controller seals explicit physical policy through handle and dispatch reentry',async()=>{
  const f=await fixture();await installCurrentInitial(f);
  const inspection=await inspectCurrentExecution(f.specPath);
  const temporaryRoot=path.join(f.root,'tmp','sentinel');
  const filesystemContext={productRoot:f.root,temporaryRoot,excludedRoots:[temporaryRoot]};
  const started=await begin({specPath:f.specPath,slice:'slice-01',operation:'EXECUTE_SLICE',expectedActivationId:inspection.activationId,filesystemContext});
  assert.deepEqual(started.handle.filesystemContext,filesystemContext);
  assert.equal((await resume(started.handle)).phase,'working');
  const dispatch=await reserveDispatch(started.handle,{responseVariant:'stnl-current-native-judgment-v1'});
  assert.equal(dispatch.phase,'dispatch-reserved');
  assert.equal(path.dirname(path.dirname(dispatch.originFile)),path.join(temporaryRoot,createHash('sha256').update(path.join(f.root,'specs/pay/requirements-execution')).digest('hex')));
  const origin=JSON.parse(await fs.readFile(dispatch.originFile));
  assert.deepEqual(origin.admission.binding.filesystemContext,filesystemContext);
  const changedRoot=path.join(f.root,'tmp','another controller');
  await assert.rejects(resume({...started.handle,filesystemContext:{...filesystemContext,temporaryRoot:changedRoot,excludedRoots:[changedRoot]}}));
  assert.equal(await fs.stat(changedRoot).catch(()=>null),null);
});

test('Initial resumes exact deterministic files on its same PLAN after a pre-publisher write failure',async()=>{
  const f=await fixture();const prepared=await preparePreparationCandidate({specPath:f.specPath,operation:'PLAN'});
  const candidate=prepared.candidateExecutionRoot;await fs.cp(f.preparationRoot,candidate,{recursive:true});
  const identity=(await captureExecutionTree(candidate)).identity,open=fs.open;let injected=0,caught;
  fs.open=async(file,...args)=>{if(file===path.join(candidate,'continuity.json')){injected++;throw Object.assign(Error('controlled second generated write'),{code:'EIO'});}return open(file,...args);};
  try{await installCurrentInitial({...f,preparationRoot:candidate});}catch(error){caught=error;}finally{fs.open=open;}
  assert.equal(injected,1);assert.equal(caught?.candidateRoot,candidate);assert.equal(caught?.publication,'not-started');
  const approval=await fs.readFile(path.join(candidate,'approved-preparation.json'));
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
  const installed=await installCurrentInitial({...f,preparationRoot:candidate});
  const {workspace}=await resolveCurrentExecutionContext(f.specPath);
  assert.deepEqual((await captureExecutionTree(workspace.executionRoot)).identity,identity);
  assert.deepEqual(await fs.readFile(path.join(workspace.executionRoot,'approved-preparation.json')),approval);
  assert.equal(installed.cleanup,'complete');
});

test('Initial refuses stale generated files on a registered PLAN without overwriting them',async()=>{
  const f=await fixture();const prepared=await preparePreparationCandidate({specPath:f.specPath,operation:'PLAN'});
  await fs.cp(f.preparationRoot,prepared.candidateExecutionRoot,{recursive:true});
  const file=path.join(prepared.candidateExecutionRoot,'continuity.json');await fs.writeFile(file,'foreign generated bytes\n');
  const before=await captureExecutionTree(prepared.candidateExecutionRoot);
  await assert.rejects(installCurrentInitial({...f,preparationRoot:prepared.candidateExecutionRoot}),error=>error.code==='STALE_APPROVAL');
  assert.deepEqual(await captureExecutionTree(prepared.candidateExecutionRoot),before);
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
});

test('Initial interruption restores absence; explicit own recovery precedes a fresh reviewed install',async()=>{
  const f=await fixture();let interrupted;
  await assert.rejects(installCurrentInitial({...f,checkpoint:step=>{
    if(step==='before-activation') throw new Error('injected before activation');
  }}),error=>{interrupted=error;return /injected before activation/u.test(error.message);});
  assert.equal((await inspectCurrentExecution(f.specPath)).state,'NO_EXECUTION');
  assert.ok(interrupted.allocation);const source=await captureExecutionTree(f.preparationRoot);
  await assert.rejects(installCurrentInitial(f),/prior preparation publication or cleanup remains pending/u);
  assert.deepEqual(await captureExecutionTree(f.preparationRoot),source);
  const recovered=await recoverCurrentInitialPublication({specPath:f.specPath,allocation:interrupted.allocation});
  assert.equal(recovered.publication,'aborted');assert.equal(recovered.cleanup,'complete');assert.deepEqual(await captureExecutionTree(f.preparationRoot),source);
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
  const installed=await installCurrentInitial({...first,checkpoint:step=>{if(step==='cleanup')throw new Error('retain pending publisher');}});
  assert.equal(installed.cleanup,'pending');
  const markerBefore=await fs.readFile(installed.allocation);
  await installCurrentInitial(second);
  await assert.rejects(recoverCurrentInitialPublication({specPath:second.specPath,
    allocation:installed.allocation}),/another execution/u);
  assert.deepEqual(await fs.readFile(installed.allocation),markerBefore);
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

for(const secondInvalid of [false,true])test(`D1 Initial concluded formal refusal has exactly one successor (${secondInvalid?'exhausted':'PASS'})`,async()=>{
  const f=await fixture();await installCurrentInitial(f);
  const implementation=await reserved(f,'stnl-current-native-judgment-v1');
  await fs.writeFile(path.join(f.root,'src/pay.mjs'),'export const pay=()=>"paid";\n');
  await bindNative(implementation.started.handle,'mechanical-D1-Initial-implementation');
  const measured=await verifyNative(implementation.dispatch.originFile),{head,...result}=initialPayload(1);result.commands=measured.commands;
  const tool=path.join(f.root,'mechanical-D1-Initial-implementation.json');await fs.writeFile(tool,JSON.stringify({agentId:'mechanical-D1-Initial-implementation',status:'completed',finalResponse:JSON.stringify({format:'stnl-current-native-judgment-v1',result})}));
  await captureNative(implementation.started.handle,tool);await publish(implementation.started.handle);
  const {context}=await resolveCurrentExecutionContext(f.specPath);
  const carrier={...f,head:(await run('git',['-C',f.root,'rev-parse','HEAD'])).stdout.trim(),
    delivery:{slice:'slice-01'},view:{execution:context.logicalExecutionRoot}};
  const{normalizedFormal}=await import('./fixtures/current-native-normalization.mjs');
  await normalizedFormal(carrier,{invalid:true,responseVariant:'stnl-current-native-judgment-v1'});
  assert.equal((await inspectCurrentExecution(f.specPath)).normalHandoff?.operation,'VALIDATE_SLICE');
  await normalizedFormal(carrier,{successor:true,invalid:secondInvalid,responseVariant:'stnl-current-native-judgment-v1'});
  const image=await inspectCurrentExecution(f.specPath),current=image.deliveries.find(item=>item.slice==='slice-01');
  assert.equal(current.counters.validationAttempts,secondInvalid?0:1);
  if(secondInvalid)assert.equal(image.normalHandoff,null);else assert.equal(current.formalStatus,'PASS');
});

for(const kind of ['standalone','lifecycle'])test(`Initial ${kind} pending cleanup excludes every fresh family until its own recovery finishes`,async()=>{
 const f=await fixture({kind});try{
  const result=await installCurrentInitial({...f,checkpoint:step=>{if(step==='cleanup')throw new Error('controlled pending cleanup');}});
  assert.equal(result.publication,'confirmed');assert.equal(result.cleanup,'pending');
  const image=await inspectCurrentExecution(f.specPath),{context}=await resolveCurrentExecutionContext(f.specPath),activationFile=path.join(context.logicalExecutionRoot,'activation.json'),before=await fs.readFile(activationFile);
  await assert.rejects(begin({specPath:f.specPath,slice:image.normalHandoff.slice,operation:'EXECUTE_SLICE',expectedActivationId:image.activationId}),/publication or cleanup remains pending/u);
  assert.deepEqual(await fs.readFile(activationFile),before);
  const {workspace}=await resolveCurrentExecutionContext(f.specPath),roots=await resolveExecutionFilesystemRoots(workspace),names=await fs.readdir(roots.materialRoot);
  const members=JSON.parse(await fs.readFile(path.join(context.logicalExecutionRoot,'continuity.json'))).deliveries.map(x=>x.deliveryId);
  await assert.rejects(preparePreparationCandidate({specPath:f.specPath,operation:'REPLAN',completedDeliveryIds:members}),/publication or cleanup remains pending/u);
  const {allocateCurrentLocalReviewCandidate}=await import('../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
  await assert.rejects(allocateCurrentLocalReviewCandidate(context),/publication or cleanup remains pending/u);
  const {publishExecutionUpdate}=await import('../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs');
  await assert.rejects(publishExecutionUpdate({workspace,candidateExecutionRoot:f.preparationRoot,expectedTree:await captureExecutionTree(context.logicalExecutionRoot),expectedActivationId:image.activationId,currentReplacement:true,recheckRequirements:async()=>{},readActivated:async()=>{throw Error('must not read a new publisher base');}}),/publication or cleanup remains pending/u);
  if(kind==='lifecycle'){
   const {publishCandidate}=await import('../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs');
   const manifest=path.join(f.root,'blocked-resume-input.json');await fs.writeFile(manifest,'{}');
   await assert.rejects(publishCandidate('RESUME',path.dirname(f.specPath),f.preparationRoot,{manifestPath:manifest}),/publication or cleanup remains pending/u);
  }
  assert.deepEqual(await fs.readdir(roots.materialRoot),names);assert.deepEqual(await fs.readFile(activationFile),before);
  const recovered=await recoverCurrentInitialPublication({specPath:f.specPath,allocation:result.allocation});
  assert.equal(recovered.cleanup,'complete');
  const next=await reserved(f);assert.equal(next.started.phase,'working');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('current reservation rejects an actual material-root replacement at common acquire before creating controls',async()=>{
 const f=await fixture();const open=fs.open;try{
  await installCurrentInitial(f);
  const {context,workspace}=await resolveCurrentExecutionContext(f.specPath),roots=await resolveExecutionFilesystemRoots(workspace);
  const image=await inspectCurrentExecution(f.specPath),activationFile=path.join(context.logicalExecutionRoot,'activation.json'),before=await fs.readFile(activationFile),beforeNames=await fs.readdir(roots.materialRoot);
  let swapped=false;
  fs.open=async function(file,...args){
   if(String(file)===roots.lockPath&&typeof args[0]==='number'&&!swapped){
    swapped=true;await fs.rename(roots.materialRoot,roots.materialRoot+'.test-original');await fs.mkdir(roots.materialRoot);
    for(const name of await fs.readdir(roots.materialRoot+'.test-original'))await fs.rename(path.join(roots.materialRoot+'.test-original',name),path.join(roots.materialRoot,name));
   }
   return open.call(this,file,...args);
  };
  await assert.rejects(begin({specPath:f.specPath,slice:image.normalHandoff.slice,operation:'EXECUTE_SLICE',expectedActivationId:image.activationId}),/filesystem binding changed/u);
  assert.ok(swapped);assert.deepEqual(await fs.readFile(activationFile),before);assert.deepEqual(await fs.readdir(roots.materialRoot),beforeNames);
 }finally{fs.open=open;await fs.rm(f.root,{recursive:true,force:true});}
});

test('lifecycle-family common barrier excludes controller with no orphan operation',async()=>{
 const f=await fixture();try{
  await installCurrentInitial(f);const {workspace,context}=await resolveCurrentExecutionContext(f.specPath);
  const roots=await resolveExecutionFilesystemRoots(workspace),beforeNames=await fs.readdir(roots.materialRoot);
  const {withExecutionPublicationLock}=await import('../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-publication.mjs');
  const image=await inspectCurrentExecution(f.specPath),activationFile=path.join(context.logicalExecutionRoot,'activation.json'),before=await fs.readFile(activationFile);
  await withExecutionPublicationLock(workspace,async()=>{
   await assert.rejects(begin({specPath:f.specPath,slice:image.normalHandoff.slice,operation:'EXECUTE_SLICE',expectedActivationId:image.activationId}),/lock already exists/u);
   assert.deepEqual(await fs.readdir(roots.materialRoot),beforeNames);assert.deepEqual(await fs.readFile(activationFile),before);
  });
  assert.equal((await reserved(f)).started.phase,'working');
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
