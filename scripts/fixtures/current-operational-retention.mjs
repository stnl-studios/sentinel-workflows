// Synthetic responses exercise public producers offline; never native acceptance.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import * as api from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';
import * as reader from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import {currentImage} from './current-native-seed.mjs';
import {READY_FIXTURE} from '../../skills/workflows/stnl-spec-lifecycle-manager/runtime/test/publisher-fixtures.mjs';
import {prepareCurrentLocalReview} from '../../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
import {publishCurrentLocalReview} from '../../skills/workflows/stnl-slice-executor/runtime/current-local-review.mjs';
const decode=bytes=>JSON.parse(Buffer.from(bytes));
export async function retainedCase(t){const image=await currentImage(t,{kind:'managed-s2',behaviorCheck:true,documentarySource:READY_FIXTURE});
 const f={image,root:image.f.root,specPath:image.f.specPath,delivery:decode(await fs.readFile(path.join(image.f.execution,'continuity.json'))).deliveries[0],
 head:execFileSync('git',['-C',image.f.root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()};return f;}
export async function retainedOperation(f,{op='VALIDATE_SLICE',status,edit=null,newId=null,refs='none',dispositions='none',verified='none',terminal=false,terminalFault=false}) {
 if(edit!==null&&op!=='APPLY_FINDINGS')await fs.writeFile(path.join(f.root,'src/greeting.mjs'),`export const greeting=${JSON.stringify(edit)};\n`);
 const image=await reader.captureCurrentExecution(f.specPath);
 const started=await api.begin({specPath:f.specPath,slice:f.delivery.slice,operation:op,expectedActivationId:image.inspection.activationId});
 if(edit!==null&&op==='APPLY_FINDINGS')await fs.writeFile(path.join(f.root,'src/greeting.mjs'),`export const greeting=${JSON.stringify(edit)};\n`);
 const dispatch=await api.reserveDispatch(started.handle,{responseVariant:'stnl-current-native-judgment-v1',terminal});
 const agentId='diagnostic-'+randomUUID();await api.bindNative(started.handle,agentId);
 const measured=await api.verifyNative(dispatch.originFile),request=decode(await fs.readFile(dispatch.requestFile));
 const result=op==='VALIDATE_SLICE'?{status,commands:measured.commands,evidence:'Diagnostic authored semantic response over prepared greeting test, not model proof.',
 findingReferences:refs,findingDispositions:dispositions,blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'No runner edits.'}
 :{status,automaticCheckRound:'1/3',discoverySources:'Approved task and greeting source.',discoveryActions:'Inspected greeting and prepared check.',
 verificationTypesConsidered:'Prepared Node test.',nonApplicabilityRationale:'none',noVerificationCommandConfirmation:'Applicable check ran.',commands:measured.commands,
 resultOfEachCommandAndExitCode:'Prepared check exited zero.',selectedChecks:'Prepared greeting check.',selectionRationale:'Current authority.',coverage:'Greeting behavior.',
 findingsVerified:verified,correctionsCovered:'Greeting restored to hello.',regressionsSelected:'Prepared greeting check.',unsupportedActiveFindings:'none',failures:'none',
 evidenceOrFailureSummary:'Prepared Node check observed hello.',affectedFilesOrBehaviors:'src/greeting.mjs',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'No runner edits.'};
 const findings=newId?[{id:newId,originAttempt:request.attemptId,severity:'blocking',problem:'Greeting differs from hello.',
 evidence:'Prepared assertion observed broken.',impact:'AC-001 is unmet.',relatedAuthority:'AC-001; obligation-01',expectedCorrection:'Restore hello.'}]:[];
 const text=JSON.stringify({format:'stnl-current-native-judgment-v1',result,...(op==='VALIDATE_SLICE'?{newFindings:findings}:{})});
 const file=path.join(f.root,'tmp','diagnostic-'+randomUUID()+'.json');await fs.mkdir(path.dirname(file),{recursive:true});
 await fs.writeFile(file,JSON.stringify({agentId,status:'completed',finalResponse:text})+'\n');
 await api.captureNative(started.handle,file);
 if(terminalFault){
  const verificationFile=dispatch.originFile.replace(/\.origin\.json$/u,'.verification.json');
  const responseFile=dispatch.originFile.replace(/\.origin\.json$/u,'.response.json');
  const verifiedStat=await fs.stat(verificationFile,{bigint:true}),responseBytes=await fs.readFile(responseFile);
  try{await api.publish(started.handle,{checkpoint:phase=>{if(phase==='after-terminal-activation')throw Object.assign(new Error('controlled terminal fault'),{code:'CONTROLLED_TERMINAL_FAILURE'});}});throw new Error('terminal injection missed');}
  catch(error){if(error.code!=='CONTROLLED_TERMINAL_FAILURE')throw error;}
  const resumed=await api.resume(started.handle);
  if(resumed.phase!=='activation_written')throw new Error('unexpected retained phase');
  const published=await api.publish(started.handle);
  const afterStat=await fs.stat(verificationFile,{bigint:true});
  assert.equal(afterStat.ino,verifiedStat.ino);assert.equal(afterStat.mtimeNs,verifiedStat.mtimeNs,'recovery must not rerun the prepared recipe');
  assert.deepEqual(await fs.readFile(responseFile),responseBytes,'recovery publishes the same captured bytes');
  const owner=decode(await fs.readFile(path.join(path.dirname(dispatch.originFile),'owner.json')));
  assert.equal(owner.runner.consumedInvocations,1);assert.equal(owner.runner.round,1);
  return {started,dispatch,published};
 }
 const published=await api.publish(started.handle);return {started,dispatch,published};
}
export async function retainedLocalReview(f) {
 const image=await reader.captureCurrentExecution(f.specPath),snapshot=decode(image.files.get('approved-preparation.json'));
 const slice=f.delivery.slice,planName=`plans/${slice}.md`,taskName=`tasks/${slice}.md`,old=decode(image.files.get('continuity.json')).deliveries.find(d=>d.slice===slice);
 const revision=bytes=>Buffer.from(bytes).toString().replace('- Local revision: '+old.localRevision,'- Local revision: '+(old.localRevision+1));
 const input={context:image.context,requirementsAuthority:image.requirementsAuthority,previous:{activationBytes:image.activationBytes,files:image.files},slice,
  planBytes:Buffer.from(revision(image.files.get(planName)).replace(/(## Risks and Strategy\n\n)/u,'$1- Additional private check sequencing review.\n')),
  reviewedTaskBytes:Buffer.from(revision(Buffer.from(snapshot.reviewedArtifacts.find(a=>a.path===taskName).utf8))),currentTaskBytes:Buffer.from(revision(image.files.get(taskName)))};
 const proposal=prepareCurrentLocalReview(input);
 const review={...proposal.reviewRequest,decision:'approved',summary:'Diagnostic mechanical private review only.',
  evidenceDecisions:proposal.reviewRequest.evidenceDecisions.map(item=>({...item,reason:'Exact historical proof retained; new private strategy requires revalidation.'}))};
 return publishCurrentLocalReview({specPath:f.specPath,slice,planBytes:input.planBytes,reviewedTaskBytes:input.reviewedTaskBytes,currentTaskBytes:input.currentTaskBytes,review});
}
