import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {currentImage} from './current-operational-consumption.mjs';
import {begin,normalize,normalizeSuccessor,reserveDispatch,bindNative,verifyNative,captureNative,publish,resume} from
  '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let next=0;
const run=promisify(execFile);

// Mechanical fault carrier for bounded cases. Live acceptance uses independent
// agents and exact tool finalResponse bytes in the ignored native smoke package.
export async function normalizedFormal(fixture,{successor=false,invalid=false,partial=false,
  candidateMutation=null,beforeCapture=null,beforePublish=null,captureOnly=false,
  invalidText='INVALID_FORMAL_RESPONSE',headOverride=null,terminalFault=false,
  references='none',dispositions='none',responseVariant=null,terminal=false,reviewTriage=null,
  status='PASS',blockers='none',responseMutation=null,agentIdOverride=null,
  evidence='The prepared AC-001 test passed under the official native verification helper.'}={}) {
  const number=++next;
  const activation=JSON.parse(await fs.readFile(path.join(fixture.image?.f?.execution??fixture.view.execution,'activation.json'),'utf8'));
  const options={specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:activation.activationId};
  const start=successor?await normalizeSuccessor(options):await begin(options);
  const dispatch=await reserveDispatch(start.handle,{responseVariant,terminal});
  const agentId=agentIdOverride??`mechanical-normalization-${number}`;
  await bindNative(start.handle,agentId);
  const measured=await verifyNative(dispatch.originFile);
  const request=await fs.readFile(dispatch.requestFile);
  let finalResponse=invalid?invalidText:JSON.stringify({
    format:'stnl-current-validation-response-v1',requestSha256:sha(request),
    result:{status,head:headOverride??fixture.head,commands:measured.commands,
      evidence,
      findingReferences:references,findingDispositions:dispositions,blockers,
      unexpectedWorkspaceEffects:'none',persistenceSummary:'No product or task file changed.'},
    newFindings:[]});
  if(!invalid&&responseVariant) {
    const envelope=JSON.parse(finalResponse);delete envelope.requestSha256;delete envelope.result.head;
    envelope.format=responseVariant;finalResponse=JSON.stringify(envelope);
  }
  if(responseMutation)finalResponse=JSON.stringify(responseMutation(JSON.parse(finalResponse)));
  const tool=path.join(fixture.root,`mechanical-normalization-${number}.json`);
  await fs.writeFile(tool,JSON.stringify({agentId,status:'completed',finalResponse})+'\n');
  if(beforeCapture) await beforeCapture({start,dispatch,tool,finalResponse});
  let captured;
  let reviewTriageFile=null;
  if(reviewTriage) {
    reviewTriageFile=path.join(fixture.root,`mechanical-triage-${number}.json`);
    await fs.writeFile(reviewTriageFile,JSON.stringify(await reviewTriage({request:JSON.parse(request),requestBytes:request,finalResponse,measured,start,dispatch})));
  }
  try {captured=await captureNative(start.handle,tool,{reviewTriageFile});}
  catch(error) {
    if(captureOnly) return {start,dispatch,captureError:error,finalResponse};
    throw error;
  }
  if(captureOnly) return {start,dispatch,captured,finalResponse};
  if(beforePublish) await beforePublish({start,dispatch,captured,tool,reviewTriageFile,finalResponse});
  let repaired=null;
  if(partial) {
    try {await publish(start.handle,{checkpoint:async phase=>{
      if(phase==='after-candidate-file')
        throw Object.assign(new Error('controlled partial candidate'),{code:'CONTROLLED_CANDIDATE_FAILURE'});
    }});throw new Error('controlled candidate failure did not occur');}
    catch(error) {if(error.code!=='CONTROLLED_CANDIDATE_FAILURE') throw error;}
    const status=await resume(start.handle);
    if(status.nextAction!=='normalize') throw new Error('identified partial candidate was not classified');
    try {await publish(start.handle);throw new Error('direct publish bypassed partial normalization');}
    catch(error) {if(error.code!=='NORMALIZATION_NOT_ELIGIBLE') throw error;}
    if(candidateMutation) {
      const namespaceRoot=path.join(fixture.root,'tmp','sentinel');
      const namespaces=await fs.readdir(namespaceRoot);
      if(namespaces.length!==1) throw new Error('mechanical fixture namespace differs');
      await candidateMutation(path.join(namespaceRoot,namespaces[0],start.handle.operationId,'candidate'));
    }
    repaired=await normalize(start.handle);
  }
  if(terminalFault) {
    try {await publish(start.handle,{checkpoint:async phase=>{
      if(phase==='after-terminal-activation')
        throw Object.assign(new Error('controlled terminal fault'),{code:'CONTROLLED_TERMINAL_FAILURE'});
    }});throw new Error('controlled terminal failure did not occur');}
    catch(error) {if(error.code!=='CONTROLLED_TERMINAL_FAILURE') throw error;}
    if((await resume(start.handle)).phase!=='activation_written')
      throw new Error('terminal activation was not retained');
  }
  return {start,dispatch,captured,finalResponse,repaired,published:await publish(start.handle)};
}
