import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {blockingFormalCase} from './current-native-findings-operation.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative} from
  '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function productNormalizationCase(test,options={}) {
  const {fixture}=await blockingFormalCase(test,options);
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image.f.execution,'activation.json')));
  const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'});
  const source=path.join(fixture.root,'src/greeting.mjs');
  await fs.writeFile(source,'export const greeting="hello";\n');
  async function round(index,{status='TESTS_PASS',agentId=`mechanical-product-drift-${index}`}={}) {
    const dispatch=await reserveDispatch(start.handle);
    await bindNative(start.handle,agentId);
    const measured=await verifyNative(dispatch.originFile);
    const request=await fs.readFile(dispatch.requestFile);
    const result={status,automaticCheckRound:`${index}/5`,head:fixture.head,
      discoverySources:'Approved task, product source and test.',
      discoveryActions:'Inspected approved source and prepared test.',
      verificationTypesConsidered:'Approved Node module test.',nonApplicabilityRationale:'none',
      noVerificationCommandConfirmation:'An applicable check ran.',commands:measured.commands,
      resultOfEachCommandAndExitCode:'Approved test completed.',
      selectedChecks:'Approved Node module test.',selectionRationale:'AC-001 coverage and correction.',
      coverage:'Prepared test imports the greeting export.',
      findingsVerified:status==='TESTS_PASS'?'finding-01':'none',
      correctionsCovered:'The greeting export was corrected and inspected.',
      regressionsSelected:'Greeting import assertion.',
      unsupportedActiveFindings:status==='TESTS_PASS'?'none':'finding-01',
      failures:status==='TESTS_FAIL'?'AC-001 failed.':'none',
      evidenceOrFailureSummary:status==='TESTS_PASS'?'The approved test passed.':'The approved test failed.',
      affectedFilesOrBehaviors:'src/greeting.mjs',blockers:'none',unexpectedWorkspaceEffects:'none',
      persistenceSummary:'The native helper retained the reviewed observation; the runner made no edits.'};
    const finalResponse=JSON.stringify({format:'stnl-current-findings-response-v1',
      requestSha256:sha(request),result});
    const toolFile=path.join(fixture.root,`product-drift-tool-${index}.json`);
    await fs.writeFile(toolFile,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
    const capture=await captureNative(start.handle,toolFile);
    return {dispatch,measured,capture,toolFile,finalResponse};
  }
  return {fixture,start,source,round};
}
