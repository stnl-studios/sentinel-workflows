import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {nativeOperationCase} from './current-native-operation.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from
  '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const run=promisify(execFile);
const finding={id:'finding-01',severity:'blocking',originAttempt:'attempt-02',
  problem:'The approved greeting export is broken.',
  evidence:'The prepared greeting test imports the export and observes broken instead of hello.',
  impact:'AC-001 is unmet.',relatedAuthority:'AC-001; obligation-01',
  expectedCorrection:'Set the greeting export to hello.'};

async function operation(fixture,ordinal,{kind='VALIDATE_SLICE',status,edit=null,references='none',dispositions='none',findings=[],verified='finding-01'}) {
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:kind});
  if(edit!==null) await fs.writeFile(path.join(fixture.root,'src/greeting.mjs'),edit);
  const dispatch=await reserveDispatch(start.handle);
  const agentId=`mechanical-findings-agent-${ordinal}`;
  await bindNative(start.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const request=await fs.readFile(dispatch.requestFile);
  const head=fixture.head;
  const result=kind==='APPLY_FINDINGS'?{
    status,automaticCheckRound:'1/3',head,
    discoverySources:'Approved task, source and test.',discoveryActions:'Inspected approved source and test.',
    verificationTypesConsidered:'Approved Node module test.',nonApplicabilityRationale:'none',
    noVerificationCommandConfirmation:'An applicable check ran.',commands:measured.commands,
    resultOfEachCommandAndExitCode:'The approved module test completed.',
    selectedChecks:'Approved Node module test.',selectionRationale:'AC-001 coverage.',
    coverage:'The greeting export is exercised by the prepared test.',findingsVerified:verified,
    correctionsCovered:'The greeting export now equals hello.',regressionsSelected:'Greeting import assertion.',
    unsupportedActiveFindings:'none',failures:'none',
    evidenceOrFailureSummary:'The approved test exited zero.',affectedFilesOrBehaviors:'src/greeting.mjs',
    blockers:'none',unexpectedWorkspaceEffects:'none',
    persistenceSummary:'The native helper retained the reviewed observation; the runner made no product changes.'}:{
    status,head,commands:measured.commands,evidence:'The approved test observed the greeting export.',
    findingReferences:references,findingDispositions:dispositions,blockers:'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'none'};
  const finalResponse=JSON.stringify({format:kind==='APPLY_FINDINGS'
    ?'stnl-current-findings-response-v1':'stnl-current-validation-response-v1',
    requestSha256:sha(request),result,...(kind==='APPLY_FINDINGS'?{}:{newFindings:findings})});
  const tool=path.join(fixture.root,`mechanical-findings-tool-${ordinal}.json`);
  await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
  const capture=await captureNative(start.handle,tool);
  const published=await publish(start.handle);
  return {start,dispatch,capture,published};
}

export async function blockingFormalCase(test,options={}) {
  const fixture=await nativeOperationCase(test,options);
  await fs.writeFile(path.join(fixture.root,'src/greeting.mjs'),'export const greeting="broken";\n');
  const first=await operation(fixture,1,{status:'NEEDS_FIX',references:'finding-01',
    dispositions:'finding-01=active',findings:[finding]});
  return {fixture,first};
}

export async function completedFindingsCycle(test) {
  const {fixture,first}=await blockingFormalCase(test);
  const apply=await operation(fixture,2,{kind:'APPLY_FINDINGS',status:'TESTS_PASS',
    edit:'export const greeting="hello";\n'});
  const formal=await operation(fixture,3,{status:'PASS',references:'finding-01',
    dispositions:'finding-01=resolved'});
  return {fixture,first,apply,formal,operation:(ordinal,options)=>operation(fixture,ordinal,options)};
}

export async function applyRoundsCase(test,statuses) {
  const {fixture}=await blockingFormalCase(test);
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
  const rounds=[];
  for(const [index,status] of statuses.entries()) {
    const round=index+1;
    if(status==='TESTS_PASS') await fs.writeFile(path.join(fixture.root,'src/greeting.mjs'),
      'export const greeting="hello";\n');
    const dispatch=await reserveDispatch(start.handle);
    const agentId=`mechanical-findings-round-agent-${round}`;
    await bindNative(start.handle,agentId);
    const measured=await verifyNative(dispatch.originFile);
    const request=await fs.readFile(dispatch.requestFile);
    const result={status,automaticCheckRound:`${round}/3`,head:fixture.head,
      discoverySources:'Approved task, source and test.',
      discoveryActions:'Inspected approved source and test.',
      verificationTypesConsidered:'Approved Node module test.',nonApplicabilityRationale:'none',
      noVerificationCommandConfirmation:'An applicable check ran.',commands:measured.commands,
      resultOfEachCommandAndExitCode:status==='TESTS_PASS'
        ?'The approved module test exited zero.':'The approved module test exited nonzero.',
      selectedChecks:'Approved Node module test.',selectionRationale:'AC-001 coverage.',
      coverage:'The greeting export is exercised by the prepared test.',
      findingsVerified:status==='TESTS_PASS'?'finding-01':'none',
      correctionsCovered:status==='TESTS_PASS'?'The greeting export now equals hello.'
        :round>1?'The greeting export remains broken after the preceding failed check.':'none',
      regressionsSelected:'Greeting import assertion.',
      unsupportedActiveFindings:status==='TESTS_PASS'?'none':'finding-01',
      failures:status==='TESTS_PASS'?'none':'AC-001 fails: greeting is broken.',
      evidenceOrFailureSummary:status==='TESTS_PASS'
        ?'The approved test exited zero.':'The approved test failed AC-001.',
      affectedFilesOrBehaviors:'src/greeting.mjs',blockers:'none',unexpectedWorkspaceEffects:'none',
      persistenceSummary:'The native helper retained the reviewed observation; the runner made no product changes.'};
    const finalResponse=JSON.stringify({format:'stnl-current-findings-response-v1',
      requestSha256:sha(request),result});
    const tool=path.join(fixture.root,`mechanical-findings-round-${round}.json`);
    await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
    rounds.push({dispatch,capture:await captureNative(start.handle,tool),measured});
    if(round===1 && statuses.length>1) {
      const handleFile=path.join(fixture.root,'mechanical-findings-handle.json');
      await fs.writeFile(handleFile,JSON.stringify(start.handle)+'\n');
      const controller=fileURLToPath(new URL('../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs',import.meta.url));
      const resumed=JSON.parse((await run(process.execPath,[controller,'resume','--handle',handleFile],
        {timeout:30000})).stdout);
      if(resumed.phase!=='captured' || resumed.nextAction!=='reserve-dispatch')
        throw new Error('fresh controller process did not resume the captured FAIL prefix');
      rounds[0].freshProcessResume=resumed;
    }
  }
  return {fixture,start,rounds};
}
