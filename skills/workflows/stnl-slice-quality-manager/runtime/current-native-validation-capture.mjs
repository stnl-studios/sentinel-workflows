import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captureCurrentExecution,observeCurrentDeliveryWork} from './execution-current-reader.mjs';
import {verifyWorkObservation,restoreCaptureSources} from './execution-evidence-proof.mjs';
import {executeRunnerVerification,verificationCommand} from './runner-verification.mjs';
import {parseCurrentJson} from './execution-current.mjs';

const raw=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fail(code,message) {const error=new Error(message);error.code=code;throw error;}
const order=(a,b)=>a<b?-1:a>b?1:0;
function rejectBlockedImage(inspection) {
  const blocked=inspection.deliveries.filter(item=>item.formalStatus==='BLOCKED'
    || item.observedValidation==='uncertain');
  if(!blocked.length) return;
  const slices=new Set(blocked.map(item=>item.slice));
  const diagnostics=inspection.diagnostics.filter(item=>slices.has(item.artifact))
    .map(item=>`${item.artifact}.${item.field}: ${item.reason}`).join('; ');
  fail('UNSUPPORTED_FORMAT',`offline formal capture is blocked by ${blocked.map(item=>
    `${item.slice} ${item.formalStatus==='BLOCKED'?'BLOCKED':'uncertain'}`).join(', ')}${diagnostics?`; ${diagnostics}`:''}`);
}
const copyCapture=value=>Object.fromEntries(Object.entries(value).map(([key,item])=>
  [key,Array.isArray(item)?item.map(bytes=>Uint8Array.from(bytes))
    :item instanceof Uint8Array?Uint8Array.from(item):item]));

// This is a single offline measurement session. It neither leases the official
// image nor adopts a session after restart.
export async function createCurrentNativeValidationCapture({specPath,deliveryId,captureParent}) {
  const previous=await captureCurrentExecution(specPath);
  rejectBlockedImage(previous.inspection);
  const activation=parseCurrentJson(Buffer.from(previous.activationBytes).toString('utf8'));
  const snapshot=parseCurrentJson(Buffer.from(previous.files.get('approved-preparation.json')).toString('utf8'));
  const continuity=parseCurrentJson(Buffer.from(previous.files.get('continuity.json')).toString('utf8'));
  const index=continuity.deliveries.findIndex(item=>item.deliveryId===deliveryId);
  if(index<0 || activation.activeAttempt!==null) fail('OWNER_UNCERTAIN','offline validation needs a quiet approved delivery');
  const current=continuity.deliveries[index],leaf=snapshot.normativeProjection.deliveries[index];
  const facts=previous.inspection.deliveries.find(item=>item.deliveryId===deliveryId);
  const priorBundle=current.evidence?parseCurrentJson(Buffer.from(previous.files.get(current.evidence.path)).toString('utf8')):null;
  // This factory emits the offline post-conversion v3 contract. Native Initial
  // sources keep their literal closure and use the official leased controller.
  const record=priorBundle?.validation??priorBundle?.findingsChecks.at(-1)??priorBundle?.implementation.at(-1);
  let initialSource=snapshot.preparationRevision===1;
  if(record?.recordFormat==='stnl-task-record-v2') {
    if(record.origin.operation==='EXECUTE_SLICE')initialSource=true;
    else {
      const findings=record.origin.operation==='APPLY_FINDINGS';
      const capture=restoreCaptureSources(findings?'current-findings':'current-validation',record,
        new Map(priorBundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')])));
      const request=parseCurrentJson(Buffer.from(capture[findings?'applyRequest':'validationRequest']).toString('utf8'));
      initialSource=!['stnl-current-validation-request-v3','stnl-current-validation-request-v4',
        'stnl-current-findings-request-v2','stnl-current-findings-request-v3'].includes(request.format);
    }
  }
  if(initialSource)fail('UNSUPPORTED_FORMAT','offline v3 capture excludes native Initial sources; use the official controller');
  if(priorBundle?.validation?.recordFormat==='stnl-task-record-v2'
    && (facts?.formalStatus!=='PASS' || priorBundle.openFindings.length))
    fail('UNSUPPORTED_FORMAT','another offline formal requires a clean PASS');
  if(!facts || current.localRevision!==1 || continuity.completed.length
    || !(['closed-formal-boundary','closed-boundary-not-resumable'].includes(
      current.evidence? 'closed-formal-boundary':current.lastDiagnostic?.code==='EVIDENCE_INCOMPLETE'
        ?'closed-boundary-not-resumable':'unsupported'))
    || !['current','revalidation-required'].includes(current.validation))
    fail('UNSUPPORTED_FORMAT','offline validation predecessor is outside S1/S2');
  const context=previous.context;
  const authority={preparationRevision:snapshot.preparationRevision,localRevision:current.localRevision,
    normativeSha256:current.authoritySha256,delivery:leaf,
    context:{requirementsAuthority:previous.requirementsAuthority,
      objective:snapshot.normativeProjection.global.objective,
      strategy:snapshot.normativeProjection.global.strategy,
      risks:snapshot.normativeProjection.global.risks}};
  const approved=verifyWorkObservation('initial-implementation',{context,delivery:leaf,slice:current.slice});
  const observed=previous.observedByDelivery.get(deliveryId);
  if(!observed) fail('EVIDENCE_INCOMPLETE','current delivery observation is absent');
  const output=name=>approved.areas.some(area=>area.path===name || area.kind==='directory' && name.startsWith(area.path+'/'));
  const paths=manifest=>manifest.entries.filter(item=>item.kind!=='directory' && output(item.path))
    .map(item=>item.path).sort(order);
  const priorScopePaths=paths(current.baseline),scopePaths=paths(observed.manifest);
  if(scopePaths.some(name=>observed.manifest.entries.find(item=>item.path===name)?.kind==='absent'))
    fail('EVIDENCE_INCOMPLETE','offline validation cannot create removal proof');
  const suppliedParent=await fs.lstat(captureParent);
  if(suppliedParent.isSymbolicLink()) fail('UNSAFE_PATH','captureParent must not be a symlink');
  const parent=await fs.realpath(captureParent);
  const parentMetadata=await fs.lstat(parent);
  if(!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()
    || parent===context.logicalExecutionRoot || parent.startsWith(context.logicalExecutionRoot+path.sep)
    || parent===context.logicalSpecRoot || context.logicalSpecRoot && parent.startsWith(context.logicalSpecRoot+path.sep))
    fail('UNSAFE_PATH','captureParent is not an isolated real directory');
  const root=await fs.mkdtemp(path.join(parent,'stnl-current-native-'));
  const owner={operationAttemptId:randomUUID(),ownershipToken:randomUUID(),deliveryId,slice:current.slice,
    operation:'VALIDATE_SLICE',preparationRevision:snapshot.preparationRevision,
    localRevision:current.localRevision,normativeSha256:current.authoritySha256,
    originActivationId:activation.activationId};
  const request={format:'stnl-current-validation-request-v3',owner,authority,
    base:{approvedSnapshotSha256:raw(previous.files.get('approved-preparation.json')),
      evidenceSha256:current.evidence?.sha256??null,counters:structuredClone(current.counters),
      baseline:structuredClone(current.baseline),validation:current.validation,
      lastDiagnostic:structuredClone(current.lastDiagnostic),priorScopePaths,openFindings:[]},
    attemptId:`attempt-${String(current.counters.validationAttempts+1).padStart(2,'0')}`,
    scope:{paths:scopePaths,filelessReason:scopePaths.length?null:
      'No approved product output paths were present in the captured domain.'}};
  const validationRequest=encode(request);
  const originFile=path.join(root,'round-1.origin.json'),agentFile=path.join(root,'round-1.agent.json');
  const origin={transport:'native',specPath:context.logicalAuthorityPath,workspace:context.productRoot,
    owner,verification:approved.resolved,dispatchId:randomUUID(),attempt:1};
  await fs.writeFile(originFile,encode(origin),{flag:'wx',mode:0o600});
  let bound=null,measurement=null,verificationStarted=false,finished=null;
  const copies={previous:{activationBytes:Uint8Array.from(previous.activationBytes),
    files:new Map([...previous.files].map(([name,bytes])=>[name,Uint8Array.from(bytes)]))},
    context:structuredClone(context),requirementsAuthority:previous.requirementsAuthority,
    owner:structuredClone(owner),validationRequest:Uint8Array.from(validationRequest),origin:Uint8Array.from(encode(origin))};
  const task=Buffer.from(previous.files.get(`tasks/${current.slice}.md`)).toString('utf8');
  const expected=/(?:^|\n)## Expected Files\n\n([\s\S]*?)(?=\n## |$)/u.exec(task)?.[1]?.trim();
  if(!expected) fail('INVALID_CURRENT_IMAGE','approved Task has no Expected Files section');
  const observe=async()=>observeCurrentDeliveryWork({context,delivery:leaf,
    sections:{'Expected Files':expected},current,bundle:null});
  const assertCurrentBase=async phase=>{
    const reread=await captureCurrentExecution(specPath);
    rejectBlockedImage(reread.inspection);
    if(!Buffer.from(reread.activationBytes).equals(Buffer.from(previous.activationBytes))
      || reread.files.size!==previous.files.size
      || [...previous.files].some(([name,bytes])=>!Buffer.from(reread.files.get(name)??[]).equals(Buffer.from(bytes)))
      || !same(reread.observedByDelivery.get(deliveryId)?.manifest,observed.manifest))
      fail('EVIDENCE_STALE',`official base or product changed ${phase}`);
  };
  return {...copies,
    async bindAgent({agentId}) {
      if(bound || typeof agentId!=='string' || !agentId.trim()) fail('OWNER_MISMATCH','agent must bind once before verification');
      bound=agentId;
      await fs.writeFile(agentFile,encode({agentId,originFile}),{flag:'wx',mode:0o600});
      return {agentId,originFile};
    },
    async runVerification() {
      if(!bound || verificationStarted) fail('OWNER_UNCERTAIN','verification requires one bound agent and one invocation');
      verificationStarted=true;
      const before=await observe();
      if(!same(before.manifest,observed.manifest) || !same([...before.identities],[...observed.identities]))
        fail('EVIDENCE_STALE','product changed before verification');
      await assertCurrentBase('before verification');
      const result=await executeRunnerVerification({verification:approved.resolved,
        outputFile:path.join(root,'round-1.verification.json'),
        observeState:async()=>(await observe()).manifest});
      const after=await observe();
      if(!same(before.manifest,after.manifest) || !same([...before.identities],[...after.identities]))
        fail('EVIDENCE_STALE','product changed during verification');
      measurement={before,after,result};
      return {status:result.status,commands:result.checks.map(check=>({command:verificationCommand(check.request),exit:check.exit}))};
    },
    async finish({agentId,status,finalResponse}) {
      if(!bound || !measurement || agentId!==bound) fail('OWNER_MISMATCH','conclusion lacks bound measured agent');
      if(typeof finalResponse!=='string' || !['PASS','NEEDS_FIX','BLOCKED'].includes(status))
        fail('INVALID_CURRENT_IMAGE','invalid offline semantic conclusion');
      if(finished) {
        if(finished.agentId===agentId && finished.status===status && finished.finalResponse===finalResponse)
          return copyCapture(finished.capture);
        fail('OWNER_MISMATCH','same owner has different conclusion bytes');
      }
      const response=parseCurrentJson(finalResponse);
      if(response.requestSha256!==raw(validationRequest) || response.result?.status!==status)
        fail('EVIDENCE_STALE','semantic conclusion differs from captured request');
      const after=await observe();
      if(!same(after.manifest,measurement.after.manifest) || !same([...after.identities],[...measurement.after.identities]))
        fail('EVIDENCE_STALE','product changed before conclusion');
      await assertCurrentBase('before conclusion');
      const work=measurement.after.manifest;
      const taskRoot=path.dirname(path.join(context.logicalExecutionRoot,`tasks/${current.slice}.md`));
      const testedState={workspace:context.productRoot,sourceTaskPath:path.join(context.logicalExecutionRoot,`tasks/${current.slice}.md`),
        entries:scopePaths.map(name=>({path:path.relative(taskRoot,path.join(context.productRoot,name)).split(path.sep).join('/'),
          value:work.entries.find(item=>item.path===name).sha256}))};
      const observation={format:'stnl-runner-verification-v2',status:'completed',owner,round:1,
        recipe:approved.recipe,resolved:approved.resolved,before:measurement.before.manifest,
        after:measurement.after.manifest,checks:measurement.result.checks};
      const receipt={transport:'native',originFile,owner,operation:'VALIDATE_SLICE',slice:current.slice,
        workspace:context.productRoot,attempt:1,threadId:agentId,
        receiptFile:path.join(root,'round-1.receipt.json'),semanticResponseFile:path.join(root,'round-1.response.json'),
        semanticResponseSha256:hex(Buffer.from(finalResponse)),semanticResponseStatus:status,
        status:'RUNNER_RESPONSE_CAPTURED',captureFailure:null,error:null,testedState,verification:observation};
      const capture={transport:'native',validationRequest:Uint8Array.from(validationRequest),
        rawResponse:Buffer.from(finalResponse),receipt:encode(receipt),
        baselineCapture:encode({format:'stnl-current-baseline-v1',owner,round:1,context,manifest:measurement.before.manifest}),
        verificationObservation:encode(observation),removalProofs:[],origin:encode(origin),dispatch:encode(origin),
        agentBinding:encode({agentId,originFile}),agentClaim:encode({agentId,originFile,owner}),
        concludedToolResult:encode({agentId,status:'completed',finalResponse})};
      finished={agentId,status,finalResponse,capture};
      return copyCapture(capture);
    },
  };
}
