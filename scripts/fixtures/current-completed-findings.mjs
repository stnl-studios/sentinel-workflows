import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {completedNativeCase} from './current-completed-native.mjs';
import {normalizedFormal} from './current-native-normalization.mjs';
import {begin,reserveDispatch,bindNative,verifyNative,captureNative,publish} from
  '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const sha=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
let serial=0;
export async function completedFormal(f,{status='PASS',findings=[],references='none',dispositions='none',...options}={}) {
  return normalizedFormal(f,{...options,beforeCapture:async input=>{
    const tool=JSON.parse(await fs.readFile(input.tool)),response=JSON.parse(tool.finalResponse);
    response.result.status=status;response.result.findingReferences=references;response.result.findingDispositions=dispositions;
    response.result.blockers=status==='BLOCKED'?'Controlled unavailable formal prerequisite.':'none';
    response.newFindings=findings;tool.finalResponse=JSON.stringify(response);
    await fs.writeFile(input.tool,JSON.stringify(tool)+'\n');
    if(options.beforeCapture)await options.beforeCapture(input);
  }});
}
export async function completedBlockingCase(t,options={}) {
  const f=await completedNativeCase(t,{drift:false,...options});
  await fs.writeFile(path.join(f.root,'other/greeting.mjs'),'export const greeting="broken";\n');
  const finding={id:'finding-01',severity:'blocking',originAttempt:'attempt-03',
    problem:'The approved greeting export regressed.',evidence:'The prepared test observes broken instead of hello.',
    impact:'AC-001 is unmet.',relatedAuthority:'AC-001; obligation-01',expectedCorrection:'Restore the greeting export to hello.'};
  const formal=await completedFormal(f,{status:'NEEDS_FIX',findings:[finding],references:'finding-01',dispositions:'finding-01=active'});
  return {...f,blockingFormal:formal};
}
export async function startCompletedApply(f,{successor=false}={}) {
  const activation=JSON.parse(await fs.readFile(path.join(f.image.f?.execution??f.view.execution,'activation.json')));
  const {normalizeSuccessor}=await import('../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs');
  const input={specPath:f.specPath,slice:f.delivery.slice,expectedActivationId:activation.activationId,operation:'APPLY_FINDINGS'};
  return successor?normalizeSuccessor(input):begin(input);
}
// These identities and final responses are mechanical stimuli. Live transport
// acceptance uses separate official agents after the final source freeze.
export async function completedApplyRound(f,start,{status='TESTS_PASS',edit=null,invalid=false,head=null,agentId=null,
  beforeVerify=null,beforeCapture=null,responseMutation=null}={}) {
  if(edit!==null)await fs.writeFile(path.join(f.root,'other/greeting.mjs'),edit);
  const dispatch=await reserveDispatch(start.handle),id=agentId??`mechanical-completed-findings-${++serial}`;
  await bindNative(start.handle,id);if(beforeVerify)await beforeVerify({dispatch});
  const measured=await verifyNative(dispatch.originFile);
  const requestBytes=await fs.readFile(dispatch.requestFile),request=JSON.parse(requestBytes);
  const result={status,automaticCheckRound:`${request.round}/5`,head:head??f.head,
    discoverySources:'Approved task, implementation and prepared test.',discoveryActions:'Inspected the greeting export and assertion.',
    verificationTypesConsidered:'Prepared Node test.',nonApplicabilityRationale:'none',noVerificationCommandConfirmation:'An applicable check ran.',
    commands:measured.commands,resultOfEachCommandAndExitCode:'The official helper observed the prepared check.',
    selectedChecks:'Prepared greeting test.',selectionRationale:'AC-001 coverage.',coverage:'The prepared assertion observes the exported greeting.',
    findingsVerified:status==='TESTS_PASS'?'finding-01':'none',correctionsCovered:edit?'Changed the private greeting export.'
      :request.round>1?'The private greeting remains broken after the previous failed check; no successful correction is claimed.':'none',
    regressionsSelected:'Prepared greeting assertion.',unsupportedActiveFindings:status==='TESTS_PASS'?'none':'finding-01',
    failures:status==='TESTS_FAIL'?'The greeting still violates AC-001.':'none',evidenceOrFailureSummary:'Official helper observation retained.',
    affectedFilesOrBehaviors:'other/greeting.mjs',blockers:status==='BLOCKED'?'Controlled missing prerequisite.':'none',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve captured bytes; no runner product edits.'};
  const response={format:'stnl-current-findings-response-v1',requestSha256:sha(requestBytes),result};
  const finalResponse=invalid?'INVALID_COMPLETED_APPLY_RESPONSE':JSON.stringify(responseMutation?responseMutation(response):response);
  const tool=path.join(f.root,`mechanical-completed-tool-${++serial}.json`);
  await fs.writeFile(tool,JSON.stringify({agentId:id,status:'completed',finalResponse})+'\n');
  if(beforeCapture)await beforeCapture({dispatch,tool,measured});
  return {dispatch,measured,tool,finalResponse,captured:await captureNative(start.handle,tool)};
}
export const publishCompletedApply=start=>publish(start.handle);
