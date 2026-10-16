#!/usr/bin/env node

// EC-1 native/manual S2 controller. The current-image, evidence and publication
// modules own their respective parsers and validators; this file only binds
// their existing contracts to one durable operation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolveCurrentExecutionContext} from './execution-state.mjs';
import {captureCurrentExecution,captureCurrentActiveExecution,observeCurrentDeliveryWork} from './execution-current-reader.mjs';
import {parseCurrentJson,validateCurrentCandidate,currentOperationBindingSha256} from './execution-current.mjs';
import {verifyWorkObservation,findingsRoundCaptureSha256,NATIVE_JUDGMENT_VARIANT,restoreCaptureSources,
  projectNativeJudgment} from './execution-evidence-proof.mjs';
import {composePostConversionValidation,composePostConversionFindings,
  inspectPostConversionEvidence,inspectPostConversionFindingsPrefix,
  parseCurrentValidationResponse,currentEvidenceValueSha256,inspectCurrentEvidence,
  composeCurrentFindingsEvidence,
  composeInitialCurrentOperation} from './current-evidence-state.mjs';
import {composeInitialImplementationEvidence} from './execution-evidence-current.mjs';
import {executeRunnerVerification,verificationCommand} from './runner-verification.mjs';
import {withExecutionPublicationLock,readOwnedFile,writeNew,persistAllocation,captureExecutionTree,
  reserveCurrentExecutionOperation,publishCurrentExecutionOperation,copyCurrentCandidateTree,
  recoverCurrentExecutionOperation,finishCurrentExecutionCleanup,syncLockParent} from './execution-publication.mjs';

const run=promisify(execFile);
const sha=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hex=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(JSON.stringify(value)+'\n','utf8');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const order=(a,b)=>a<b?-1:a>b?1:0;
const here=path.resolve(fileURLToPath(import.meta.url));
function fail(code,message) {throw Object.assign(new Error(message),{code});}
async function maybe(file) {try {return await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function readJson(file) {return parseCurrentJson((await readOwnedFile(file)).bytes.toString('utf8'));}
async function put(file,value) {await writeNew(file,json(value));await syncLockParent(path.dirname(file));}
async function active(specPath,owner) {
  const image=await captureCurrentActiveExecution(specPath,owner);
  return {...image,activation:parseCurrentJson(Buffer.from(image.activationBytes).toString('utf8'))};
}
async function quiet(specPath) {
  const image=await captureCurrentExecution(specPath);
  return {...image,activation:parseCurrentJson(Buffer.from(image.activationBytes).toString('utf8'))};
}
function baseFiles(image) {return new Map([...image.files].map(([name,bytes])=>[name,Buffer.from(bytes)]));}
function identity(metadata) {return {dev:String(metadata.dev),ino:String(metadata.ino)};}
async function realDirectory(directory) {
  const metadata=await fs.lstat(directory);
  if(!metadata.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(directory)!==directory)
    fail('TEMP_ROOT_UNPROVEN',`real directory required: ${directory}`);
  return metadata;
}
function workspaceFrom(context,workspace) {return {executionRoot:context.logicalExecutionRoot,specRoot:context.logicalSpecRoot??null,...workspace};}
async function namespaceFor(context,{create=false}={}) {
  const productRoot=context.productRoot;
  const key=createHash('sha256').update(context.logicalExecutionRoot,'utf8').digest('hex');
  const tmp=path.join(productRoot,'tmp'),sentinel=path.join(tmp,'sentinel'),namespace=path.join(sentinel,key);
  const product=await realDirectory(productRoot);
  for(const directory of [tmp,sentinel,namespace]) {
    if(create && !await maybe(directory)) {
      try {await fs.mkdir(directory,{mode:0o700});}
      catch(error) {if(error.code!=='EEXIST') throw error;}
    }
    const state=await maybe(directory);
    if(!state) return {namespace,registry:path.join(namespace,'registry.json'),key,exists:false};
    if(!state.isDirectory() || state.isSymbolicLink() || await fs.realpath(directory)!==directory
      || state.dev!==product.dev) fail('TEMP_ROOT_UNPROVEN',`operation namespace is unsafe: ${directory}`);
  }
  if(create) {
    let ignored=false;
    try {await run('git',['-C',productRoot,'check-ignore','-q',path.relative(productRoot,namespace)],{timeout:10000});ignored=true;}
    catch {}
    if(!ignored) fail('TEMP_ROOT_UNPROVEN',`operation namespace is not Git-ignored: ${namespace}`);
  }
  return {namespace,registry:path.join(namespace,'registry.json'),key,exists:true,
    identity:identity(await realDirectory(namespace)),device:String(product.dev)};
}
export async function allocateCurrentLocalReviewCandidate(context) {
  const {namespace}=await namespaceFor(context,{create:true});
  return fs.realpath(await fs.mkdtemp(path.join(namespace,'local-review-')));
}
async function registryAt(location,executionRoot) {
  const exists=await maybe(location.registry);
  if(!exists) return {format:'stnl-current-operation-registry-v1',executionRoot,operations:[]};
  const registry=await readJson(location.registry);
  if(registry.format!=='stnl-current-operation-registry-v1' || registry.executionRoot!==executionRoot
    || !Array.isArray(registry.operations)) fail('OWNER_UNCERTAIN','current operation registry differs');
  for(const entry of registry.operations) {
    if(!entry || typeof entry.operationId!=='string' || typeof entry.marker!=='string'
      || entry.marker!==path.join(location.namespace,entry.operationId,'owner.json'))
      fail('OWNER_UNCERTAIN','current operation registry has a foreign entry');
  }
  return registry;
}
async function saveRegistry(location,current) {
  if(await maybe(location.registry)) await persistAllocation(location.registry,current);
  else await put(location.registry,current);
}
function usesCurrentChecks(image,owner) {
  if(owner.preparationRevision===1 || owner.operation==='EXECUTE_SLICE')return true;
  const continuity=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
  const current=continuity.deliveries.find(item=>item.deliveryId===owner.deliveryId);
  if(!current?.evidence)return false;
  const bundle=parseCurrentJson(Buffer.from(image.files.get(current.evidence.path)).toString('utf8'));
  if(bundle.implementation.some(item=>item.recordFormat==='stnl-task-record-v2'))return true;
  if(!bundle.validation || bundle.validation.recordFormat!=='stnl-task-record-v2')return false;
  const captured=restoreCaptureSources('current-validation',bundle.validation,new Map(bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')])));
  return ['stnl-current-validation-request-v1','stnl-current-validation-request-v2'].includes(parseCurrentJson(Buffer.from(captured.validationRequest).toString('utf8')).format);
}
function requireS2(image,slice,operation,{successor=false}={}) {
  const activation=image.activation;
  if(activation.preparationRevision<=1 || activation.activeAttempt!==null
    || !['EXECUTE_SLICE','VALIDATE_SLICE','APPLY_FINDINGS'].includes(operation)
    || image.inspection.normalHandoff?.operation!==operation
    || image.inspection.normalHandoff?.slice!==slice)
    fail('UNSUPPORTED_FORMAT','EC-1 native profile requires an exact converted S2 handoff');
  const continuity=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
  const pristine=continuity.deliveries.find(item=>item.slice===slice);
  if(operation==='EXECUTE_SLICE') {
    if(successor || pristine?.evidence!==null || pristine.validation!=='unvalidated'
      || pristine.normalization!==null || pristine.lastDiagnostic!==null
      || Object.values(pristine.counters).some(value=>value!==0)
      || currentEvidenceValueSha256(pristine.baseline)!==currentEvidenceValueSha256(image.observedByDelivery.get(pristine.deliveryId)?.manifest))
      fail('EVIDENCE_STALE','current EXECUTE requires an unconsumed pristine delivery');
    return pristine;
  }
  if(usesCurrentChecks(image,{deliveryId:pristine?.deliveryId,operation,preparationRevision:activation.preparationRevision})) {
    if(successor || !pristine?.evidence || pristine.normalization!==null
      || image.inspection.deliveries.some(item=>item.formalStatus==='BLOCKED'||item.observedValidation==='uncertain'))
      fail('OWNER_UNCERTAIN','current implementation predecessor is not eligible');
    if(operation==='APPLY_FINDINGS') {
      const bundle=parseCurrentJson(Buffer.from(image.files.get(pristine.evidence.path)).toString('utf8'));
      if(image.inspection.deliveries.find(item=>item.slice===slice)?.formalStatus!=='NEEDS_FIX'
        || !bundle.openFindings.some(item=>item.severity==='blocking')
        || currentEvidenceValueSha256(bundle.validation.testedWork)!==currentEvidenceValueSha256(image.observedByDelivery.get(pristine.deliveryId)?.manifest))
        fail('EVIDENCE_STALE','current APPLY requires a sealed blocking formal and unchanged product');
    }
    return pristine;
  }
  const reviewed=continuity.deliveries.filter(item=>item.localRevision!==1);
  if(continuity.completed.length && (reviewed.length || successor&&operation!=='APPLY_FINDINGS')
    || reviewed.length>1 || reviewed.some(item=>item.localRevision!==2
    || item.slice!==slice || operation!=='VALIDATE_SLICE' || successor)
    || continuity.deliveries.some(item=>item.localRevision!==1 && item.localRevision!==2
    || item.normalization!==null && !(successor && item.slice===slice
      && item.normalization.status==='settled' && item.normalization.round===1)
    || item.validation==='uncertain'))
    fail('UNSUPPORTED_FORMAT','EC-1 native profile excludes completed, local review and uncertain delivery');
  const current=continuity.deliveries.find(item=>item.slice===slice);
  const inspected=image.inspection.deliveries.find(item=>item.slice===slice);
  if(continuity.completed.length) {
    const bundle=current?.evidence?parseCurrentJson(Buffer.from(image.files.get(current.evidence.path)).toString('utf8')):null;
    if(bundle?.validation?.recordFormat!=='stnl-task-record-v2'
      || bundle.validation.origin.transport!=='native' || bundle.implementation.length
      || bundle.openDivergences.length)
      fail('UNSUPPORTED_FORMAT','completed native profile requires a verified native formal base');
    const captured=restoreCaptureSources('current-validation',bundle.validation,
      new Map(bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')])));
    const origin=parseCurrentJson(Buffer.from(captured.origin).toString('utf8'));
    if(!origin.admission)fail('UNSUPPORTED_FORMAT','completed native base lacks official A0/A1 admission');
    if(operation==='VALIDATE_SLICE'
      && !(inspected.formalStatus==='PASS'&&current.validation==='current'&&!bundle.openFindings.length)
      && !['TESTS_PASS','TESTS_FAIL'].includes(inspected.auxiliaryStatus))
      fail('UNSUPPORTED_FORMAT','completed formal requires a closed PASS or concluded findings checks');
  }
  if(!current || !inspected || current.counters.validationAttempts<1
    || (current.evidence===null && current.lastDiagnostic?.code!=='EVIDENCE_INCOMPLETE')
    || inspected.formalStatus==='BLOCKED')
    fail('UNSUPPORTED_FORMAT','EC-1 S2 proof boundary is not eligible');
  if(image.inspection.deliveries.some(item=>item.formalStatus==='BLOCKED' || item.observedValidation==='uncertain'))
    fail('OWNER_UNCERTAIN','another delivery blocks current execution');
  if(successor && (current.normalization?.operation!==operation
    || current.normalization?.status!=='settled' || current.normalization.round!==1
    || operation==='APPLY_FINDINGS' && current.normalization.consumedInvocations>=3
    || image.activation.lastAttempt?.outcome!=='rejected'
    || image.activation.lastAttempt?.operationAttemptId!==current.lastDiagnostic?.operationAttemptId
    || (operation==='VALIDATE_SLICE'?inspected.formalStatus!==null
      :inspected.formalStatus!=='NEEDS_FIX') || !current.evidence))
    fail('NORMALIZATION_NOT_ELIGIBLE','official first rejection is not settled for one successor');
  if(operation==='APPLY_FINDINGS') {
    const bundle=parseCurrentJson(Buffer.from(image.files.get(current.evidence.path)).toString('utf8'));
    const observed=image.observedByDelivery.get(current.deliveryId)?.manifest;
    if(inspected.formalStatus!=='NEEDS_FIX' || current.validation!=='revalidation-required'
      || bundle.validation?.recordFormat!=='stnl-task-record-v2'
      || !bundle.openFindings.some(item=>item.severity==='blocking')
      || currentEvidenceValueSha256(current.baseline)!==currentEvidenceValueSha256(observed))
      fail('EVIDENCE_STALE','APPLY requires a sealed blocking formal and unchanged pre-edit product');
  }
  return current;
}
function requireInitial(image,slice,operation) {
  if(image.activation.preparationRevision!==1 || image.activation.activeAttempt!==null
    || !['EXECUTE_SLICE','VALIDATE_SLICE','APPLY_FINDINGS'].includes(operation)
    || image.inspection.normalHandoff?.operation!==operation
    || image.inspection.normalHandoff?.slice!==slice)
    fail('UNSUPPORTED_FORMAT','EC-1 Initial requires the exact official handoff');
  const continuity=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
  const current=continuity.deliveries.find(item=>item.slice===slice);
  if(continuity.completed.length || continuity.deliveries.some(item=>item.localRevision!==1
    || item.normalization!==null || item.validation==='uncertain') || !current)
    fail('UNSUPPORTED_FORMAT','Initial excludes completed, local review and uncertain delivery');
  if(image.inspection.deliveries.some(item=>item.formalStatus==='BLOCKED'
    || item.observedValidation==='uncertain')) fail('OWNER_UNCERTAIN','another delivery blocks Initial');
  if(operation==='EXECUTE_SLICE' && (current.evidence!==null
    || Object.values(current.counters).some(value=>value!==0)
    || !same(current.baseline,image.observedByDelivery.get(current.deliveryId)?.manifest)))
    fail('EVIDENCE_STALE','Initial EXECUTE requires pristine baseline and zero consumption');
  if(operation!=='EXECUTE_SLICE' && !current.evidence)
    fail('EVIDENCE_INCOMPLETE','Initial formal or APPLY requires captured evidence');
  if(operation==='APPLY_FINDINGS') {
    const snapshot=parseCurrentJson(Buffer.from(image.files.get('approved-preparation.json')).toString('utf8'));
    const leaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===current.deliveryId);
    const authority={preparationRevision:1,localRevision:1,normativeSha256:snapshot.normativeSha256,
      delivery:leaf,context:{requirementsAuthority:image.requirementsAuthority,
        objective:snapshot.normativeProjection.global.objective,strategy:snapshot.normativeProjection.global.strategy,
        risks:snapshot.normativeProjection.global.risks}};
    const facts=inspectCurrentEvidence({context:image.context,authority,
      bundleBytes:image.files.get(current.evidence.path),counters:current.counters,
      baseline:current.baseline,observedWork:image.observedByDelivery.get(current.deliveryId).manifest});
    if(facts.formalStatus!=='NEEDS_FIX' || !facts.openFindings.some(item=>item.severity==='blocking'))
      fail('EVIDENCE_STALE','Initial APPLY requires a sealed blocking formal');
  }
  return current;
}

export async function begin({specPath,slice,expectedActivationId,operation='VALIDATE_SLICE',successor=false}) {
  const first=await quiet(specPath);
  const initial=first.activation.preparationRevision===1;
  if(initial && successor) fail('UNSUPPORTED_FORMAT','Initial successor normalization is outside this profile');
  const current=initial?requireInitial(first,slice,operation):requireS2(first,slice,operation,{successor});
  if(first.activation.activationId!==expectedActivationId) fail('STALE_BASE','begin expectedActivationId differs');
  const {workspace,context}=await resolveCurrentExecutionContext(specPath);
  const location=await namespaceFor(context,{create:true});
  const operationId=randomUUID(),operationRoot=path.join(location.namespace,operationId);
  await fs.mkdir(operationRoot,{mode:0o700});
  const operationMetadata=await realDirectory(operationRoot);
  if(operationMetadata.dev!==Number(location.device)) fail('CROSS_FILESYSTEM','operation controls cross filesystem');
  const owner={operationAttemptId:randomUUID(),ownershipToken:randomUUID(),deliveryId:current.deliveryId,
    slice,operation,preparationRevision:first.activation.preparationRevision,
    localRevision:current.localRevision,normativeSha256:initial?first.activation.normativeSha256:current.authoritySha256,
    originActivationId:expectedActivationId};
  const binding={operationId,specKey:location.key,logicalExecutionRoot:context.logicalExecutionRoot,
    logicalSpecRoot:context.logicalSpecRoot,producer:operation==='EXECUTE_SLICE'?'implementation'
      :operation==='APPLY_FINDINGS'?'findings':'validation',owner,
    baseActivationId:expectedActivationId,baseTree:await captureExecutionTree(context.logicalExecutionRoot),
    candidatePath:'candidate',previousPath:'previous',namespaceIdentity:location.identity,
    filesystemDevice:location.device,
    ...(successor?{normalization:{...current.normalization,
      sourceEvidenceSha256:current.evidence.sha256,sourceActivationId:expectedActivationId}}:{})};
  const marker=path.join(operationRoot,'owner.json');
  await writeNew(path.join(operationRoot,'base.activation.json'),Buffer.from(first.activationBytes));
  if(operation!=='VALIDATE_SLICE') await put(path.join(operationRoot,'base.work.json'),
    first.observedByDelivery.get(current.deliveryId).manifest);
  const reserved=await reserveCurrentExecutionOperation({workspace:workspaceFrom(context,workspace),
    expectedActivationId,expectedBaseActivation:first.activation,owner,binding,marker,
    bindingSha256:currentOperationBindingSha256(binding),
    readQuiet:()=>quiet(specPath),readActive:expected=>active(specPath,expected),
    registryReservation:async()=>{
      const registry=await registryAt(location,context.logicalExecutionRoot);
      if(registry.operations.length) fail('OWNER_ACTIVE','another current operation or cleanup is pending');
      registry.operations.push({operationId,marker});await saveRegistry(location,registry);
    }});
  const handle={format:'stnl-current-operation-handle-v1',specPath:context.logicalAuthorityPath,
    operationId,ownershipToken:owner.ownershipToken};
  return {handle,owner:reserved.owner,activationA0:reserved.baseActivation.activationId,
    activationA1:reserved.reservedActivation.activationId,phase:'working',nextAction:'reserve-dispatch'};
}

async function load(handle,{requireRegistry=true}={}) {
  if(!handle || handle.format!=='stnl-current-operation-handle-v1'
    || typeof handle.specPath!=='string' || typeof handle.operationId!=='string'
    || typeof handle.ownershipToken!=='string') fail('OWNER_MISMATCH','invalid operation handle');
  const {workspace,context}=await resolveCurrentExecutionContext(handle.specPath);
  const location=await namespaceFor(context);
  if(!location.exists || location.key!==createHash('sha256').update(context.logicalExecutionRoot).digest('hex'))
    fail('OWNER_UNCERTAIN','operation namespace is absent');
  const root=path.join(location.namespace,handle.operationId);
  const metadata=await realDirectory(root);
  if(metadata.dev!==Number(location.device)) fail('CROSS_FILESYSTEM','operation root moved');
  const marker=path.join(root,'owner.json');
  const record=await readJson(marker);
  const binding=record.binding;
  if(record.format!=='stnl-execution-publication-owner-v2'
    || binding?.operationId!==handle.operationId
    || binding?.specKey!==location.key
    || binding?.logicalExecutionRoot!==context.logicalExecutionRoot
    || binding?.logicalSpecRoot!==context.logicalSpecRoot
    || binding?.owner?.ownershipToken!==handle.ownershipToken
    || !same(binding.namespaceIdentity,location.identity)
    || binding.filesystemDevice!==location.device
    || binding.candidatePath!=='candidate' || binding.previousPath!=='previous')
    fail('OWNER_MISMATCH','operation binding or physical namespace differs');
  const registry=await registryAt(location,context.logicalExecutionRoot);
  const entry=registry.operations.find(item=>item.operationId===handle.operationId);
  if(requireRegistry && (!entry || entry.marker!==marker)) fail('OWNER_UNCERTAIN','operation registry association is absent');
  return {handle,workspace:workspaceFrom(context,workspace),context,location,root,marker,record,binding,
    owner:binding.owner,registry};
}
async function requireA1(operation) {
  const image=await active(operation.handle.specPath,{
    ...operation.owner,operationRef:{operationId:operation.binding.operationId,
      allocationSha256:currentOperationBindingSha256(operation.binding)}});
  if(image.activation.activeAttempt?.operationRef?.allocationSha256!==currentOperationBindingSha256(operation.binding)
    || image.activation.activeAttempt.originActivationId!==operation.binding.baseActivationId)
    fail('OWNER_MISMATCH','active owner does not bind this operation');
  return image;
}
async function requestInputs(image,operation,dispatchId,round=1,previous=null) {
  const snapshot=parseCurrentJson(Buffer.from(image.files.get('approved-preparation.json')).toString('utf8'));
  const continuity=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
  const current=continuity.deliveries.find(item=>item.deliveryId===operation.owner.deliveryId);
  const leaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===operation.owner.deliveryId);
  if(!current || !leaf || current.slice!==operation.owner.slice
    || (operation.owner.preparationRevision===1?snapshot.normativeSha256:current.authoritySha256)
      !==operation.owner.normativeSha256)
    fail('EVIDENCE_STALE','selected delivery authority changed');
  const info=verifyWorkObservation('initial-implementation',{context:operation.context,delivery:leaf,slice:current.slice});
  const observed=image.observedByDelivery.get(current.deliveryId);
  if(!observed) fail('EVIDENCE_INCOMPLETE','selected product observation is absent');
  const output=name=>info.areas.some(area=>area.path===name || area.kind==='directory' && name.startsWith(area.path+'/'));
  const paths=manifest=>manifest.entries.filter(item=>item.kind!=='directory' && output(item.path)).map(item=>item.path);
  const priorScopePaths=paths(current.baseline).sort(order);
  const scopePaths=[...new Set([...priorScopePaths,...(previous?.scopePaths??[]),...paths(observed.manifest),
    ...info.refs.filter(item=>item.kind==='product').map(item=>item.path)])].sort(order);
  if(operation.owner.preparationRevision>1
    && scopePaths.some(name=>observed.manifest.entries.find(item=>item.path===name)?.kind==='absent'))
    fail('UNSUPPORTED_FORMAT','EC-1 S2 does not admit output removals');
  const authority={preparationRevision:snapshot.preparationRevision,localRevision:current.localRevision,
    normativeSha256:operation.owner.preparationRevision===1?snapshot.normativeSha256:current.authoritySha256,delivery:leaf,
    context:{requirementsAuthority:image.requirementsAuthority,
      objective:snapshot.normativeProjection.global.objective,
      strategy:snapshot.normativeProjection.global.strategy,
      risks:snapshot.normativeProjection.global.risks}};
  if(usesCurrentChecks(image,operation.owner)) {
    if(operation.owner.operation==='EXECUTE_SLICE') {
      const request={format:'stnl-current-initial-dispatch-v1',owner:operation.owner,authority,
        round,checkId:`implementation-check-${String(current.counters.implementationChecks+round).padStart(2,'0')}`,
        scopePaths,previousCheck:null};
      return {request,info,observed,dispatchId,current};
    }
    const bundleBytes=Buffer.from(image.files.get(current.evidence.path));
    const bundle=parseCurrentJson(bundleBytes.toString('utf8'));
    const facts=inspectCurrentEvidence({context:operation.context,authority,bundleBytes,
      counters:current.counters,baseline:current.baseline,observedWork:observed.manifest});
    if(operation.owner.operation==='APPLY_FINDINGS') {
      if(facts.formalStatus!=='NEEDS_FIX' || !facts.latest
        || !facts.openFindings.some(item=>item.severity==='blocking'))
        fail('UNSUPPORTED_FORMAT','Initial APPLY predecessor no longer requires correction');
      const formalScope=facts.latest.request.scope.paths;
      const applyScope=[...new Set([...formalScope,...(previous?.scopePaths??[]),...paths(observed.manifest),
        ...info.refs.filter(item=>item.kind==='product').map(item=>item.path)])].sort(order);
      const request={format:'stnl-current-findings-request-v1',owner:operation.owner,authority,
        base:{evidenceSha256:sha(bundleBytes),counters:structuredClone(current.counters),
          validation:{id:bundle.validation.id,recordSha256:currentEvidenceValueSha256(bundle.validation)},
          openFindings:structuredClone(bundle.openFindings),priorScopePaths:formalScope},
        round,checkId:`findings-check-${String(current.counters.findingsChecks+round).padStart(2,'0')}`,
        previousCheck:previous?{id:previous.request.checkId,
          roundCaptureSha256:findingsRoundCaptureSha256(previous.cap)}:null,scopePaths:applyScope};
      return {request,info,observed,dispatchId,current};
    }
    const formalPrior=facts.cycle?.lastScope??facts.latest?.request.scope.paths??priorScopePaths;
    const auxiliary=facts.cycle?{kind:'findings',operationAttemptId:facts.cycle.owner.operationAttemptId,
      cycle:facts.cycle.admissionId,firstCheckId:facts.cycle.checks[0].id,
      lastCheckId:facts.cycle.checks.at(-1).id,
      recordsSha256:currentEvidenceValueSha256(facts.cycle.checks)}:null;
    const formalScope=[...new Set([...formalPrior,...paths(observed.manifest),
      ...info.refs.filter(item=>item.kind==='product').map(item=>item.path)])].sort(order);
    const request={format:auxiliary?'stnl-current-validation-request-v2':'stnl-current-validation-request-v1',
      owner:operation.owner,authority,
      base:{evidenceSha256:sha(bundleBytes),counters:structuredClone(current.counters),
        openFindings:structuredClone(bundle.openFindings),priorScopePaths:formalPrior,
        ...(auxiliary?{auxiliary}:{})},
      attemptId:`attempt-${String(current.counters.validationAttempts+1).padStart(2,'0')}`,
      scope:{paths:formalScope,filelessReason:formalScope.length?null:
        'No approved product output paths were present in the captured domain.'}};
    return {request,info,observed,dispatchId,current};
  }
  if(operation.owner.operation==='APPLY_FINDINGS') {
    const snapshotBytes=Buffer.from(image.files.get('approved-preparation.json'));
    const bundleBytes=Buffer.from(image.files.get(current.evidence.path));
    const bundle=parseCurrentJson(bundleBytes.toString('utf8'));
    const facts=await inspectPostConversionEvidence({context:operation.context,snapshotBytes,current,
      bundleBytes,observedWork:current.baseline,lastAttempt:image.activation.lastAttempt,
      admissionRef:image.activation.lastAttempt?.operationRef??null});
    const successor=operation.binding.normalization!==undefined;
    if(facts.formalStatus!=='NEEDS_FIX' || (bundle.validation.id===facts.cycle?.admissionId
      && !(successor && facts.rejection?.origin.operation==='APPLY_FINDINGS'
        && facts.consumption?.kind==='bounded-findings-rejection')))
      fail('UNSUPPORTED_FORMAT','APPLY predecessor no longer requires correction');
    const formalScope=successor?facts.cycle.lastScope:facts.latest.request.scope.paths;
    const applyScope=[...new Set([...formalScope,...(previous?.scopePaths??[]),...paths(observed.manifest),
      ...info.refs.filter(item=>item.kind==='product').map(item=>item.path)])].sort(order);
    const request={format:successor?'stnl-current-findings-request-v2':'stnl-current-findings-request-v1',
      owner:operation.owner,authority,
      base:{evidenceSha256:sha(bundleBytes),counters:structuredClone(current.counters),
        validation:{id:bundle.validation.id,recordSha256:currentEvidenceValueSha256(bundle.validation)},
        openFindings:structuredClone(bundle.openFindings),priorScopePaths:formalScope},
      round:(successor?operation.binding.normalization.consumedInvocations:0)+round,
      ...(successor?{invocation:round}:{}),
      checkId:`findings-check-${String(current.counters.findingsChecks+round).padStart(2,'0')}`,
      previousCheck:previous?{id:previous.request.checkId,
        roundCaptureSha256:findingsRoundCaptureSha256(previous.cap)}:null,scopePaths:applyScope};
    return {request,info,observed,dispatchId,current};
  }
  let formalPrior=priorScopePaths,openFindings=[],auxiliary=null;
  if(current.evidence) {
    const bundleBytes=Buffer.from(image.files.get(current.evidence.path));
    const bundle=parseCurrentJson(bundleBytes.toString('utf8'));
    if(bundle.findingsChecks.length) {
      const facts=await inspectPostConversionEvidence({context:operation.context,
        snapshotBytes:Buffer.from(image.files.get('approved-preparation.json')),current,bundleBytes,
        observedWork:current.baseline,lastAttempt:image.activation.lastAttempt,
        admissionRef:image.activation.lastAttempt?.operationRef??null});
      formalPrior=bundle.validation.id===facts.cycle.admissionId
        ?facts.cycle.lastScope:facts.latest.request.scope.paths;
      openFindings=bundle.openFindings;
      auxiliary={kind:'findings',operationAttemptId:facts.cycle.owner.operationAttemptId,
        cycle:facts.cycle.admissionId,firstCheckId:facts.cycle.checks[0].id,
        lastCheckId:facts.cycle.checks.at(-1).id,
        recordsSha256:currentEvidenceValueSha256(facts.cycle.checks)};
    }
  }
  const formalScope=[...new Set([...formalPrior,...paths(observed.manifest),
    ...info.refs.filter(item=>item.kind==='product').map(item=>item.path)])].sort(order);
  const request={format:auxiliary?'stnl-current-validation-request-v4':'stnl-current-validation-request-v3',
    owner:operation.owner,authority,
    base:{approvedSnapshotSha256:sha(image.files.get('approved-preparation.json')),
      evidenceSha256:current.evidence?.sha256??null,counters:structuredClone(current.counters),
      baseline:structuredClone(current.baseline),validation:current.validation,
      lastDiagnostic:structuredClone(current.lastDiagnostic),priorScopePaths:formalPrior,openFindings,
      ...(auxiliary?{auxiliary}:{})},
    attemptId:`attempt-${String(current.counters.validationAttempts+1).padStart(2,'0')}`,
    scope:{paths:formalScope,filelessReason:formalScope.length?null:
      'No approved product output paths were present in the captured domain.'}};
  return {request,info,observed,dispatchId,current};
}
export async function reserveDispatch(handle,{responseVariant=null}={}) {
  if(responseVariant!==null && responseVariant!==NATIVE_JUDGMENT_VARIANT)
    fail('UNSUPPORTED_FORMAT','native response variant is not supported');
  const op=await load(handle);
  return withExecutionPublicationLock(op.workspace,async()=>{
    const now=await load(handle);
    const auxiliary=now.owner.operation!=='VALIDATE_SLICE';
    const previousRound=now.record.runner?.round??0;
    if(previousRound && (now.record.responseVariant??null)!==responseVariant)
      fail('OWNER_MISMATCH','native response variant changed within the operation');
    const productDrift=now.record.runner?.productDrift??null;
    if(now.record.phase!=='working' || (!auxiliary && now.record.runner!==null)
      || auxiliary && previousRound && (now.record.runner.status!=='captured'
        || !['TESTS_FAIL',...(productDrift?['TESTS_PASS']:[])].includes(now.record.runner.resultStatus)
        || now.record.runner.resultStatus==='TESTS_PASS'
          && productDrift.sourceRound!==previousRound
        || previousRound+(now.binding.normalization?.consumedInvocations??0)>=3))
      fail('OWNER_UNCERTAIN','dispatch is already reserved, terminal or uncertain');
    const round=auxiliary?previousRound+1:1;
    if(await maybe(path.join(now.root,`round-${round}.origin.json`)))
      fail('OWNER_UNCERTAIN','this round already has an origin');
    const image=await requireA1(now);
    if(image.activation.activationId!==now.record.binding.baseActivationId &&
      image.activation.previousActivationId!==now.record.binding.baseActivationId)
      fail('STALE_BASE','A1 no longer descends from admitted A0');
    let previous=null;
    if(auxiliary && previousRound) {
      const rounds=[];
      for(let index=1;index<=previousRound;index+=1) rounds.push(await capturedSources(now,index));
      const continuity=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
      const current=continuity.deliveries.find(item=>item.deliveryId===now.owner.deliveryId);
      if(usesCurrentChecks(image,now.owner)) {
        const request=await readJson(path.join(now.root,`round-${previousRound}.request.json`));
        const authority=request.authority;
        const result=now.owner.operation==='EXECUTE_SLICE'
          ?composeInitialImplementationEvidence({context:now.context,authority,owner:now.owner,
            currentEvidence:null,counters:current.counters,rounds})
          :composeCurrentFindingsEvidence({context:now.context,authority,owner:now.owner,
            previous:{bundleBytes:image.files.get(current.evidence.path),counters:current.counters},rounds});
        if(result.outcome!=='recorded'
          || (now.owner.operation==='EXECUTE_SLICE'
            ?(parseCurrentJson(Buffer.from(rounds.at(-1).rawResponse).toString('utf8')).result?.status??parseCurrentJson(Buffer.from(rounds.at(-1).rawResponse).toString('utf8')).status)
            :result.auxiliaryStatus)!=='TESTS_FAIL'
          && !(productDrift&&parseCurrentJson(Buffer.from(rounds.at(-1).rawResponse).toString('utf8')).result?.status==='TESTS_PASS')
          || result.consumedInvocations!==previousRound)
          fail('OWNER_UNCERTAIN','previous Initial prefix is not an eligible failed check');
        const prior=await readJson(path.join(now.root,`round-${previousRound}.observation.json`));
        previous={cap:rounds.at(-1),request,scopePaths:request.scopePaths,lastWork:prior.after};
      } else {
      const summary=await inspectPostConversionFindingsPrefix({context:now.context,
        snapshotBytes:Buffer.from(image.files.get('approved-preparation.json')),current,
        bundleBytes:Buffer.from(image.files.get(current.evidence.path)),owner:now.owner,rounds});
      if(!['TESTS_FAIL',...(productDrift?['TESTS_PASS']:[])].includes(summary.status)
        || summary.status==='TESTS_PASS' && productDrift.sourceRound!==previousRound
        || summary.rounds!==previousRound
        +(now.binding.normalization?.consumedInvocations??0))
        fail('OWNER_UNCERTAIN','previous findings prefix is not an eligible validated result');
      previous={cap:rounds.at(-1),request:await readJson(path.join(now.root,`round-${previousRound}.request.json`)),
        scopePaths:summary.lastScope,lastWork:summary.lastWork};
      }
    }
    const dispatchId=previousRound?now.record.runner.dispatchId:randomUUID();
    const {request,info,observed}=await requestInputs(image,now,dispatchId,round,previous);
    if(productDrift) {
      if(now.binding.normalization || !previous || productDrift.class!=='product-drift'
        || productDrift.sourceOperationAttemptId!==now.owner.operationAttemptId
        || productDrift.used!==1 || productDrift.sourceRound>=round
        || productDrift.sourceCaptureSha256!==findingsRoundCaptureSha256(
          await capturedSources(now,productDrift.sourceRound))
        || round===productDrift.sourceRound+1
          && productDrift.expectedWorkSha256!==currentEvidenceValueSha256(observed.manifest))
        fail('EVIDENCE_STALE','reserved product drift witness differs');
      if(round===productDrift.sourceRound+1) {
        const prior=await readJson(path.join(now.root,`round-${productDrift.sourceRound}.observation.json`));
        await checkedProductDrift(now,image,prior);
      }
    }
    const baseActivation=await readJson(path.join(now.root,'base.activation.json'));
    if(baseActivation.activationId!==now.binding.baseActivationId
      || !same(baseActivation.artifacts,image.activation.artifacts))
      fail('STALE_BASE','A0 artifacts differ from A1');
    const allDeliveries=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8')).deliveries;
    const origin={transport:'native',specPath:now.context.logicalAuthorityPath,
      workspace:now.context.productRoot,owner:now.owner,verification:info.resolved,
      dispatchId,attempt:round,
      ...(responseVariant?{responseVariant,requestSha256:sha(json(request))}:{}),
      admission:{binding:now.binding,baseActivation,reservedActivation:image.activation},
      otherDeliveryWork:[...image.observedByDelivery]
        .filter(([deliveryId])=>deliveryId!==now.owner.deliveryId)
        .map(([deliveryId,value])=>({deliveryId,
          slice:allDeliveries.find(item=>item.deliveryId===deliveryId).slice,manifest:value.manifest})),
      ...(productDrift?{productDrift}:{})};
    const baseline={format:'stnl-current-baseline-v1',owner:now.owner,round,
      context:now.context,manifest:auxiliary
        ?previous?.lastWork??await readJson(path.join(now.root,'base.work.json')):observed.manifest};
    const originFile=path.join(now.root,`round-${round}.origin.json`);
    await put(path.join(now.root,`round-${round}.request.json`),request);
    await put(path.join(now.root,`round-${round}.baseline.json`),baseline);
    await put(originFile,origin);
    now.record.runner={dispatchId,agentId:null,status:'reserved',round,consumedInvocations:round,
      ...(productDrift?{productDrift}:{}),
      originFile,requestFile:path.join(now.root,`round-${round}.request.json`),
      responseFile:path.join(now.root,`round-${round}.response.json`)};
    if(!previousRound && responseVariant) now.record.responseVariant=responseVariant;
    await persistAllocation(now.marker,now.record);
    return {phase:'dispatch-reserved',nextAction:'spawn-and-bind',owner:now.owner,
      originFile,requestFile:now.record.runner.requestFile,requestSha256:sha(json(request)),
      verificationHelper:here,dispatchId,round,
      ...(responseVariant?{responseVariant}:{})};
  });
}

export async function bindNative(handle,agentId) {
  if(typeof agentId!=='string' || !agentId.trim()) fail('OWNER_MISMATCH','official agent identity required');
  const op=await load(handle);
  return withExecutionPublicationLock(op.workspace,async()=>{
    const now=await load(handle);
    const round=now.record.runner?.round;
    if(now.record.phase!=='working' || now.record.runner?.status!=='reserved'
      || now.record.runner.agentId!==null || await maybe(path.join(now.root,`round-${round}.agent.json`)))
      fail('OWNER_UNCERTAIN','native binding already exists or is uncertain');
    for(let index=1;index<round;index+=1)
      if((await readJson(path.join(now.root,`round-${index}.agent.json`))).agentId===agentId)
        fail('OWNER_MISMATCH','a fresh native agent is required for each findings round');
    await requireA1(now);
    await put(path.join(now.root,`round-${round}.agent.json`),{agentId,originFile:now.record.runner.originFile});
    await put(path.join(now.root,`round-${round}.claim.json`),{agentId,originFile:now.record.runner.originFile,owner:now.owner});
    now.record.runner.agentId=agentId;now.record.runner.status='running';
    await persistAllocation(now.marker,now.record);
    return {phase:'running',agentId,originFile:now.record.runner.originFile,nextAction:'await-same-agent'};
  });
}

async function opFromOrigin(originFile) {
  const match=typeof originFile==='string' && /^round-([1-3])\.origin\.json$/u.exec(path.basename(originFile));
  if(!match)
    fail('OWNER_MISMATCH','noncanonical native origin path');
  const round=Number(match[1]);
  const origin=await readJson(originFile);
  const operationId=origin.admission?.binding?.operationId;
  const handle={format:'stnl-current-operation-handle-v1',specPath:origin.specPath,
    operationId,ownershipToken:origin.owner?.ownershipToken};
  const op=await load(handle);
  if(originFile!==path.join(op.root,`round-${round}.origin.json`) || !same(origin.owner,op.owner)
    || !same(origin.admission?.binding,op.binding)
    || origin.dispatchId!==op.record.runner?.dispatchId || origin.attempt!==round
    || (origin.responseVariant??null)!==(op.record.responseVariant??null)
    || op.record.runner?.round!==round)
    fail('OWNER_MISMATCH','native origin does not belong to reserved dispatch');
  return {op,origin,round};
}
async function boundAgent(op,originFile,round) {
  const deadline=Date.now()+30000;
  while(true) {
    const current=await load(op.handle);
    const agentFile=path.join(current.root,`round-${round}.agent.json`);
    if(current.record.runner?.agentId && await maybe(agentFile)) {
      const agent=await readJson(agentFile);
      if(agent.agentId!==current.record.runner.agentId || agent.originFile!==originFile
        || current.record.runner.status!=='running')
        fail('OWNER_MISMATCH','native agent binding differs');
      return current.record.runner.agentId;
    }
    if(Date.now()>=deadline) fail('OWNER_UNCERTAIN','native bind did not complete within 30 seconds');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}
function preflightCorrection(baseline,current,info,{initial=false}={}) {
  const old=new Map(baseline.entries.map(item=>[item.path,item]));
  const next=new Map(current.entries.map(item=>[item.path,item]));
  const allowed=name=>info.areas.some(area=>area.path===name
    || area.kind==='directory' && name.startsWith(`${area.path}/`));
  for(const name of new Set([...old.keys(),...next.keys()])) {
    const before=old.get(name),after=next.get(name);
    if(same(before??null,after??null)) continue;
    if(before?.kind==='directory' || after?.kind==='directory') continue;
    if(!allowed(name) || before?.kind==='file' && after?.kind!=='file'
      || after?.kind==='absent' || initial && [...info.inputs,...info.refs].some(item=>item.path===name))
      fail('EVIDENCE_STALE',`unauthorized correction before recipe: ${name}`);
  }
}
function assertOtherInitialWork(image,origin) {
  if(origin.otherDeliveryWork===undefined && origin.owner.preparationRevision!==1)return;
  if(!Array.isArray(origin.otherDeliveryWork)) fail('OWNER_MISMATCH','Initial other-delivery witness is absent');
  const snapshot=parseCurrentJson(Buffer.from(image.files.get('approved-preparation.json')).toString('utf8'));
  const selectedLeaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===origin.owner.deliveryId);
  if(!selectedLeaf) fail('OWNER_MISMATCH','Initial selected delivery is absent');
  const selectedInfo=verifyWorkObservation('initial-implementation',{
    context:image.context,delivery:selectedLeaf,slice:origin.owner.slice});
  for(const frozen of origin.otherDeliveryWork) {
    const current=image.observedByDelivery.get(frozen.deliveryId)?.manifest;
    const leaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===frozen.deliveryId);
    if(!current || !leaf || frozen.deliveryId===origin.owner.deliveryId)
      fail('OWNER_MISMATCH','Initial other-delivery witness differs');
    const other=verifyWorkObservation('initial-implementation',{
      context:image.context,delivery:leaf,slice:frozen.slice});
    const prior=new Map(frozen.manifest.entries.map(item=>[item.path,item]));
    const now=new Map(current.entries.map(item=>[item.path,item]));
    for(const name of new Set([...prior.keys(),...now.keys()])) {
      if(same(prior.get(name)??null,now.get(name)??null)) continue;
      if(prior.get(name)?.kind==='directory' || now.get(name)?.kind==='directory') continue;
      const selected=selectedInfo.areas.some(area=>area.path===name
        || area.kind==='directory' && name.startsWith(`${area.path}/`));
      if(!selected || [...other.inputs,...other.refs].some(item=>item.path===name))
        fail('EVIDENCE_STALE',`another Initial delivery changed outside selected output: ${name}`);
    }
  }
}
function privateProductDrift(before,after,info) {
  const old=new Map(before.entries.map(item=>[item.path,item]));
  const next=new Map(after.entries.map(item=>[item.path,item]));
  const changed=[...new Set([...old.keys(),...next.keys()])].filter(name=>
    !same(old.get(name)??null,next.get(name)??null));
  const leaves=changed.filter(name=>old.get(name)?.kind!=='directory'
    && next.get(name)?.kind!=='directory');
  if(!leaves.length) fail('NORMALIZATION_NOT_ELIGIBLE','no changed private output exists');
  for(const name of changed) {
    const prior=old.get(name),current=next.get(name);
    if(prior?.kind==='directory' || current?.kind==='directory') {
      if(prior?.kind!=='directory' || current?.kind!=='directory'
        || !same(prior.children,current.children))
        fail('EVIDENCE_STALE',`product structure changed: ${name}`);
      continue;
    }
    if(prior?.kind!=='file' || current?.kind!=='file'
      || !info.areas.some(area=>area.path===name
        || area.kind==='directory' && name.startsWith(`${area.path}/`))
      || [...info.inputs,...info.refs].some(item=>item.path===name))
      fail('EVIDENCE_STALE',`drift is not an existing private output: ${name}`);
  }
  return leaves.sort(order);
}
async function checkedProductDrift(op,image,observation) {
  const snapshot=parseCurrentJson(Buffer.from(image.files.get('approved-preparation.json')).toString('utf8'));
  const continuity=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
  const current=continuity.deliveries.find(item=>item.deliveryId===op.owner.deliveryId);
  const leaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===op.owner.deliveryId);
  const info=verifyWorkObservation('initial-implementation',{
    context:op.context,delivery:leaf,slice:op.owner.slice});
  const observed=image.observedByDelivery.get(op.owner.deliveryId);
  if(!current || !observed || current.validation==='uncertain'
    || !same(image.activation.activeAttempt?.operationAttemptId,op.owner.operationAttemptId))
    fail('NORMALIZATION_NOT_ELIGIBLE','current APPLY owner is not eligible');
  const paths=privateProductDrift(observation.after,observed.manifest,info);
  for(const other of continuity.deliveries.filter(item=>item.deliveryId!==op.owner.deliveryId)) {
    const otherLeaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===other.deliveryId);
    const otherInfo=verifyWorkObservation('initial-implementation',{
      context:op.context,delivery:otherLeaf,slice:other.slice});
    if(!same(image.observedByDelivery.get(other.deliveryId)?.manifest,other.baseline)
      || paths.some(name=>[...otherInfo.areas,...otherInfo.inputs,...otherInfo.refs].some(claim=>
        claim.path===name || claim.kind==='directory' && name.startsWith(`${claim.path}/`))))
      fail('EVIDENCE_STALE','drift affects another delivery');
  }
  return {observed,paths};
}
export async function verifyNative(originFile) {
  const {op,origin,round}=await opFromOrigin(originFile);
  const agentId=await boundAgent(op,originFile,round);
  const image=await requireA1(op);
  if(!same(image.activation,origin.admission.reservedActivation))
    fail('STALE_BASE','native reservation changed before recipe');
  const baseline=await readJson(path.join(op.root,`round-${round}.baseline.json`));
  const before=image.observedByDelivery.get(op.owner.deliveryId);
  if(!before) fail('EVIDENCE_INCOMPLETE','product observation is absent');
  const leaf=parseCurrentJson(Buffer.from(image.files.get('approved-preparation.json')).toString('utf8'))
    .normativeProjection.deliveries.find(item=>item.deliveryId===op.owner.deliveryId);
  const recipe=verifyWorkObservation('initial-implementation',{
    context:op.context,delivery:leaf,slice:op.owner.slice});
  assertOtherInitialWork(image,origin);
  if(origin.productDrift && round===origin.productDrift.sourceRound+1) {
    if(!same(origin.productDrift,op.record.runner?.productDrift)
      || currentEvidenceValueSha256(before.manifest)!==origin.productDrift.expectedWorkSha256)
      fail('EVIDENCE_STALE','product differs from reserved recheck state');
    const prior=await readJson(path.join(op.root,`round-${origin.productDrift.sourceRound}.observation.json`));
    await checkedProductDrift(op,image,prior);
  }
  if(op.owner.operation!=='VALIDATE_SLICE') preflightCorrection(baseline.manifest,before.manifest,recipe,
    {initial:op.owner.preparationRevision===1});
  else if(!same(before.manifest,baseline.manifest))
    fail('EVIDENCE_STALE','product changed before native recipe');
  const observeState=async()=>{
    const current=await requireA1(op);
    if(!same(current.activation,origin.admission.reservedActivation))
      fail('STALE_BASE','native owner or activation changed during recipe');
    return current.observedByDelivery.get(op.owner.deliveryId)?.manifest;
  };
  const measuredHead=async()=>{
    const {stdout}=await run('git',['-C',op.context.productRoot,'rev-parse','HEAD'],{timeout:10000});
    const head=stdout.endsWith('\n')?stdout.slice(0,-1):null;
    if(!/^[a-f0-9]{40}$/u.test(head??'')) fail('EVIDENCE_INCOMPLETE','product Git HEAD unavailable');
    return head;
  };
  const headBefore=origin.responseVariant===NATIVE_JUDGMENT_VARIANT?await measuredHead():null;
  const result=await executeRunnerVerification({verification:origin.verification,
    outputFile:path.join(op.root,`round-${round}.verification.json`),observeState});
  const after=await requireA1(op);
  assertOtherInitialWork(after,origin);
  const final=after.observedByDelivery.get(op.owner.deliveryId);
  if(!final || !same(before.manifest,final.manifest)
    || !same([...before.identities],[...final.identities]))
    fail('EVIDENCE_STALE','product changed during native recipe');
  const requestBytes=(await readOwnedFile(path.join(op.root,`round-${round}.request.json`))).bytes;
  if(origin.responseVariant===NATIVE_JUDGMENT_VARIANT && origin.requestSha256!==sha(requestBytes))
    fail('EVIDENCE_STALE','native request changed before observation');
  const head=origin.responseVariant===NATIVE_JUDGMENT_VARIANT?await measuredHead():null;
  if(headBefore!==head) fail('EVIDENCE_STALE','product Git HEAD changed during native recipe');
  const observation={format:'stnl-runner-verification-v2',status:'completed',owner:op.owner,round,
    recipe:recipe.recipe,
    resolved:origin.verification,before:before.manifest,after:final.manifest,checks:result.checks};
  if(origin.responseVariant===NATIVE_JUDGMENT_VARIANT) {
    observation.format='stnl-runner-verification-v3';
    observation.binding={head,requestSha256:origin.requestSha256,dispatchId:origin.dispatchId,agentId};
  }
  const observationFile=path.join(op.root,`round-${round}.observation.json`);
  if(await maybe(observationFile)) {
    if(!same(await readJson(observationFile),observation)) fail('OWNER_UNCERTAIN','native recipe observation differs on replay');
  } else await put(observationFile,observation);
  return {status:'completed',agentId,commands:result.checks.map(item=>({command:verificationCommand(item.request),exit:item.exit})),
    observationFile};
}

async function capturedSources(op,round=1) {
  const root=op.root;
  const get=async suffix=>(await readOwnedFile(path.join(root,`round-${round}.${suffix}.json`))).bytes;
  const agent=await get('agent');
  const tool=await get('tool-result');
  return {transport:'native',
    ...(op.owner.operation==='EXECUTE_SLICE'?{}
      :{[op.owner.operation==='APPLY_FINDINGS'?'applyRequest':'validationRequest']:await get('request')}),
    rawResponse:await get('response'),receipt:await get('receipt'),
    baselineCapture:await get('baseline'),
    verificationObservation:await get('observation'),removalProofs:[],
    origin:await get('origin'),dispatch:await get('origin'),
    agentBinding:agent,agentClaim:await get('claim'),concludedToolResult:tool};
}
export async function captureNative(handle,toolResultFile) {
  const op=await load(handle);
  const tool=await readJson(toolResultFile);
  if(typeof tool.agentId!=='string' || tool.status!=='completed' || typeof tool.finalResponse!=='string')
    fail('OWNER_UNCERTAIN','official concluded tool result is required');
  return withExecutionPublicationLock(op.workspace,async()=>{
    const now=await load(handle);
    const round=now.record.runner?.round;
    const auxiliary=now.owner.operation!=='VALIDATE_SLICE';
    const agent=await readJson(path.join(now.root,`round-${round}.agent.json`));
    if(!['running','captured'].includes(now.record.runner?.status) || now.record.runner.agentId!==tool.agentId
      || agent.agentId!==tool.agentId) fail('OWNER_MISMATCH','concluded agent differs from bound dispatch');
    const responseFile=now.record.runner.responseFile;
    const raw=Buffer.from(tool.finalResponse,'utf8');
    if(await maybe(responseFile)) {
      const previous=(await readOwnedFile(responseFile)).bytes;
      if(!previous.equals(raw)) fail('OWNER_MISMATCH','same owner supplied different final bytes');
      if(now.record.runner.status==='captured') return {phase:'captured',rawResponseSha256:sha(previous),replayed:true};
      fail('OWNER_UNCERTAIN','partial native capture exists; preserve it');
    }
    const image=await requireA1(now);
    const origin=await readJson(path.join(now.root,`round-${round}.origin.json`));
    if((origin.responseVariant??null)!==(now.record.responseVariant??null))
      fail('OWNER_MISMATCH','native response variant differs from reserved dispatch');
    if(!same(image.activation,origin.admission.reservedActivation))
      fail('STALE_BASE','A1 changed before native conclusion');
    assertOtherInitialWork(image,origin);
    const observation=await readJson(path.join(now.root,`round-${round}.observation.json`));
    if(observation.status!=='completed') fail('OWNER_UNCERTAIN','native recipe did not complete');
    const observed=image.observedByDelivery.get(now.owner.deliveryId);
    if(!observed || !same(observed.manifest,observation.after))
      fail('EVIDENCE_STALE','product changed before native conclusion');
    await writeNew(responseFile,raw);
    await put(path.join(now.root,`round-${round}.tool-result.json`),tool);
    let parsed=null,parseFailure=null;
    const initialExecute=now.owner.operation==='EXECUTE_SLICE';
    const requestBytes=(await readOwnedFile(path.join(now.root,`round-${round}.request.json`))).bytes;
    let projected=tool.finalResponse,projectionFailure=false;
    if(origin.responseVariant===NATIVE_JUDGMENT_VARIANT) {
      try {projected=projectNativeJudgment({origin,observation,requestBytes,agentId:tool.agentId,
        rawText:tool.finalResponse,operation:now.owner.operation});}
      catch(error) {parseFailure=error.message;projectionFailure=true;}
    }
    if(auxiliary && !parseFailure) {
      try {parsed=parseCurrentJson(projected);}
      catch(error) {parseFailure=error.message;}
    } else if(!auxiliary && !parseFailure) {
      const semantic=parseCurrentValidationResponse(projected);
      parsed=semantic.response??semantic.loose??null;
      parseFailure=semantic.error?.message??null;
    }
    const request=parseCurrentJson(requestBytes.toString('utf8'));
    const status=initialExecute?parsed?.status:parsed?.result?.status;
    const requestSha256=sha(requestBytes);
    const bindingFailure=parsed?.requestSha256!==undefined && parsed.requestSha256!==requestSha256;
    if((!initialExecute && (parsed?.format!==(auxiliary?'stnl-current-findings-response-v1':'stnl-current-validation-response-v1')
      || parsed?.requestSha256!==requestSha256))
      || !(auxiliary?['TESTS_PASS','TESTS_FAIL','BLOCKED']:['PASS','NEEDS_FIX','BLOCKED']).includes(status))
      parseFailure??='native final response envelope/status differs';
    let productHead=null;
    if(!parseFailure || (initialExecute?parsed?.head:parsed?.result?.head)!==undefined) {
      try {
        const result=await run('git',['-C',now.context.productRoot,'rev-parse','HEAD'],{timeout:10000});
        productHead=result.stdout.endsWith('\n')?result.stdout.slice(0,-1):null;
      } catch {productHead=null;}
      if(!parseFailure && (!/^[a-f0-9]{40}$/u.test(productHead??'')
        || (initialExecute?parsed.head:parsed.result.head)!==productHead))
        parseFailure='native result HEAD differs from verified product Git HEAD';
    }
    const headBindingFailure=(initialExecute?parsed?.head:parsed?.result?.head)!==undefined
      && (!/^[a-f0-9]{40}$/u.test(productHead??'')
        || (initialExecute?parsed.head:parsed.result.head)!==productHead);
    const taskRoot=path.dirname(path.join(now.context.logicalExecutionRoot,`tasks/${now.owner.slice}.md`));
    const byPath=new Map(observation.after.entries.map(item=>[item.path,item]));
    const testedState=parseFailure?null:{workspace:now.context.productRoot,
      sourceTaskPath:path.join(now.context.logicalExecutionRoot,`tasks/${now.owner.slice}.md`),
      entries:(auxiliary?request.scopePaths:request.scope.paths).map(name=>({path:path.relative(taskRoot,path.join(now.context.productRoot,name)).split(path.sep).join('/'),
        value:byPath.get(name)?.sha256??'REMOVED'})).sort((a,b)=>order(a.path,b.path))};
    const receipt={transport:'native',originFile:path.join(now.root,`round-${round}.origin.json`),owner:now.owner,
      operation:now.owner.operation,slice:now.owner.slice,workspace:now.context.productRoot,attempt:round,
      threadId:tool.agentId,receiptFile:path.join(now.root,`round-${round}.receipt.json`),
      semanticResponseFile:responseFile,semanticResponseSha256:hex(raw),
      semanticResponseStatus:parseFailure?null:status,
      status:parseFailure?'RUNNER_RESULT_BLOCKED':'RUNNER_RESPONSE_CAPTURED',
      captureFailure:parseFailure,error:null,testedState,verification:observation};
    await put(path.join(now.root,`round-${round}.receipt.json`),receipt);
    let initialRejection=false;
    if(!parseFailure && auxiliary) {
      try {
        const rounds=[];
        for(let index=1;index<=round;index+=1) rounds.push(await capturedSources(now,index));
        const continuity=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
        const current=continuity.deliveries.find(item=>item.deliveryId===now.owner.deliveryId);
        if(usesCurrentChecks(image,now.owner)) {
          const authority=request.authority;
          const composed=initialExecute?composeInitialImplementationEvidence({context:now.context,authority,
            owner:now.owner,currentEvidence:null,counters:current.counters,rounds})
            :composeCurrentFindingsEvidence({context:now.context,authority,owner:now.owner,
              previous:{bundleBytes:image.files.get(current.evidence.path),counters:current.counters},rounds});
          initialRejection=composed.outcome==='rejected';
        } else {
          const verified=await inspectPostConversionFindingsPrefix({context:now.context,
            snapshotBytes:Buffer.from(image.files.get('approved-preparation.json')),current,
            bundleBytes:Buffer.from(image.files.get(current.evidence.path)),owner:now.owner,rounds});
          if(verified.status!==status || verified.rounds!==round
            +(now.binding.normalization?.consumedInvocations??0))
            fail('EVIDENCE_STALE','captured findings prefix differs from native response');
        }
      } catch(error) {
        if(error.code==='RUNNER_RESULT_REJECTED' && !bindingFailure && !headBindingFailure) {
          now.record.runner.status='captured';
          now.record.runner.captureClass='findings-rejection';
          await persistAllocation(now.marker,now.record);
          return {phase:'captured',rawResponseSha256:sha(raw),status:null,
            nextAction:'publish',captureClass:'findings-rejection',replayed:false};
        }
        now.record.runner.status='uncertain';
        await persistAllocation(now.marker,now.record);
        throw error;
      }
    }
    const completedProfile=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8')).completed.length>0;
    const concludedFormalRejection=!completedProfile && !auxiliary && Boolean(parseFailure) && !projectionFailure && !bindingFailure
      && !headBindingFailure
      && parseFailure!=='native result HEAD differs from verified product Git HEAD';
    const concludedFindingsRejection=auxiliary && Boolean(parseFailure) && !projectionFailure && !bindingFailure
      && !headBindingFailure
      && parseFailure!=='native result HEAD differs from verified product Git HEAD';
    now.record.runner.status=parseFailure && !concludedFormalRejection && !concludedFindingsRejection
      ?'uncertain':'captured';
    now.record.runner.captureClass=initialRejection?'initial-rejection':concludedFormalRejection?'formal-rejection'
      :concludedFindingsRejection?'findings-rejection':parseFailure?'uncertain':'formal-response';
    if(!parseFailure) now.record.runner.resultStatus=status;
    await persistAllocation(now.marker,now.record);
    if(parseFailure && !concludedFormalRejection && !concludedFindingsRejection)
      fail('RUNNER_RESULT_REJECTED',`native final response preserved but rejected: ${parseFailure}`);
    // Syntax alone cannot establish a completed-profile judgment. In particular
    // NEEDS_FIX must carry its active blocker before this capture can publish.
    if(completedProfile && !parseFailure && !auxiliary)await capturedComposition(now);
    return {phase:'captured',rawResponseSha256:sha(raw),status,
      nextAction:initialRejection?'publish'
        :initialExecute && parseFailure?'blocked':auxiliary && status==='TESTS_FAIL'
        && round+(now.binding.normalization?.consumedInvocations??0)<3?'reserve-dispatch':'publish',
      captureClass:now.record.runner.captureClass,replayed:false};
  });
}

async function candidateFiles(root,names) {
  const entries=new Map();
  for(const name of names) entries.set(name,(await readOwnedFile(path.join(root,...name.split('/')))).bytes);
  return entries;
}
async function preparedCandidate(op,composed,image,{checkpoint=null}={}) {
  const candidatePath=path.join(op.root,op.binding.candidatePath);
  const previous=op.record.preparation?.candidateComposition??null;
  if(!await maybe(candidatePath)) {
    if(previous) fail('OWNER_UNCERTAIN','identified candidate disappeared before completion');
    await copyCurrentCandidateTree(op.context.logicalExecutionRoot,candidatePath);
    const copied=await captureExecutionTree(candidatePath);
    if(!copied || !same(copied.files,(await captureExecutionTree(op.context.logicalExecutionRoot)).files))
      fail('EVIDENCE_STALE','candidate base copy differs before composition');
    op.record.preparation={...(op.record.preparation??{}),candidateComposition:{identity:copied.identity,
      baseTree:copied.files}};
    await persistAllocation(op.marker,op.record);
  } else if(!previous) fail('OWNER_UNCERTAIN','unidentified candidate cannot be completed');
  const proof=op.record.preparation.candidateComposition;
  const tree=await captureExecutionTree(candidatePath);
  if(!tree || !same(tree.identity,proof.identity)) fail('OWNER_MISMATCH','candidate physical identity differs');
  const base=new Map(proof.baseTree.map(item=>[item.path,item]));
  const allowed=new Set([...base.keys(),...composed.files.keys()]);
  for(const name of composed.files.keys()) {
    for(let parent=path.posix.dirname(name);parent!=='.';parent=path.posix.dirname(parent)) allowed.add(parent);
  }
  for(const entry of tree.files) {
    if(!allowed.has(entry.path)) fail('EVIDENCE_STALE',`foreign candidate path: ${entry.path}`);
    const original=base.get(entry.path);
    if(entry.type==='directory') {
      if(original && !same(entry,original)) fail('EVIDENCE_STALE',`candidate directory changed: ${entry.path}`);
      continue;
    }
    if(entry.type!=='file' || original && original.type!=='file')
      fail('EVIDENCE_STALE',`candidate path changed type: ${entry.path}`);
    const target=composed.files.get(entry.path);
    if(target===undefined && !same(entry,original))
      fail('EVIDENCE_STALE',`candidate base file changed: ${entry.path}`);
    if(target!==undefined && !same(entry,original)
      && (entry.sha256!==sha(target) || entry.mode!==(original?.mode??0o644)))
      fail('EVIDENCE_STALE',`candidate file has ambiguous bytes: ${entry.path}`);
  }
  let writes=0;
  for(const [name,bytes] of composed.files) {
    const current=await maybe(path.join(candidatePath,...name.split('/')));
    if(!current || !(await readOwnedFile(path.join(candidatePath,...name.split('/')))).bytes.equals(bytes)) {
      const target=path.join(candidatePath,...name.split('/'));
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,bytes);
      writes+=1;
      if(checkpoint && writes===1) await checkpoint('after-candidate-file');
    }
  }
  for(const entry of [...proof.baseTree].sort((a,b)=>b.path.length-a.path.length)) {
    if(entry.path==='activation.json' || composed.files.has(entry.path)) continue;
    const target=path.join(candidatePath,...entry.path.split('/'));
    if(entry.type==='file' && tree.files.some(item=>item.path===entry.path)) await fs.unlink(target);
    else if(entry.type==='directory' && tree.files.some(item=>item.path===entry.path)
      && ![...composed.files.keys()].some(name=>name.startsWith(`${entry.path}/`)))
      await fs.rmdir(target);
  }
  const finalTree=await captureExecutionTree(candidatePath);
  const required=new Set(['activation.json',...composed.files.keys()]);
  for(const name of composed.files.keys())
    for(let parent=path.posix.dirname(name);parent!=='.';parent=path.posix.dirname(parent))
      required.add(parent);
  if(!finalTree || finalTree.files.length!==required.size
    || finalTree.files.some(entry=>!required.has(entry.path)))
    fail('EVIDENCE_STALE','candidate has material outside captured composition');
  const actual=await candidateFiles(candidatePath,[...composed.files.keys()]);
  if(actual.size!==composed.files.size || [...composed.files].some(([name,bytes])=>!actual.get(name)?.equals(bytes)))
    fail('EVIDENCE_STALE','owned candidate differs from captured composition');
  const marker=(await readOwnedFile(path.join(candidatePath,'activation.json'))).bytes;
  if(!marker.equals(Buffer.from(image.activationBytes)))
    fail('OWNER_MISMATCH','candidate activation is not admitted A1');
  validateCurrentCandidate({files:actual});
  return candidatePath;
}

async function completeRegistry(op) {
  const registry=await registryAt(op.location,op.context.logicalExecutionRoot);
  if(registry.operations.length>1 || registry.operations.length===1
    && registry.operations[0].marker!==op.marker)
    fail('OWNER_UNCERTAIN','operation registry changed before cleanup');
  const names=['base.activation.json',...(op.owner.operation!=='VALIDATE_SLICE'?['base.work.json']:[])];
  for(let round=1;round<=op.record.runner.round;round+=1)
    names.push(...['request','baseline','origin','agent','claim','verification','observation',
      'response','tool-result','receipt'].map(name=>`round-${round}.${name}.json`));
  for(const name of names) await readOwnedFile(path.join(op.root,name));
  if(registry.operations.length) {
    registry.operations=[];
    await saveRegistry(op.location,registry);
  }
}

export async function cleanup(handle) {
  const op=await load(handle,{requireRegistry:false});
  if(op.record.phase!=='committed' || op.record.cleanup?.status!=='pending')
    fail('CLEANUP_PENDING','this operation has no confirmed pending cleanup');
  return finishCurrentExecutionCleanup({workspace:op.workspace,marker:op.marker,binding:op.binding,
    previousPath:path.join(op.root,op.binding.previousPath),owner:op.owner,
    readQuiet:()=>quiet(handle.specPath),registryCompletion:()=>completeRegistry(op)});
}

async function capturedComposition(op) {
  const auxiliary=op.owner.operation!=='VALIDATE_SLICE';
  if(op.owner.preparationRevision===1 && ['EXECUTE_SLICE','APPLY_FINDINGS'].includes(op.owner.operation)
    && op.record.runner?.captureClass==='findings-rejection')
    fail('RUNNER_RESULT_REJECTED','Initial schema refusal is outside the concluded semantic profile');
  if(op.owner.preparationRevision===1 && op.owner.operation==='VALIDATE_SLICE'
    && op.record.runner?.captureClass==='initial-rejection')
    fail('RUNNER_RESULT_REJECTED','Initial VALIDATE refusal normalization is outside this profile');
  const round=op.record.runner?.round;
  if(op.record.runner?.status!=='captured'
    || auxiliary && op.record.runner.resultStatus==='TESTS_FAIL'
      && round+(op.binding.normalization?.consumedInvocations??0)<3)
    fail('OWNER_UNCERTAIN','native terminal result has not been captured');
  const image=await requireA1(op);
  const origin=await readJson(path.join(op.root,'round-1.origin.json'));
  if(!same(image.activation,origin.admission.reservedActivation))
    fail('STALE_BASE','official A1 differs before composition');
  assertOtherInitialWork(image,origin);
  const observation=await readJson(path.join(op.root,`round-${round}.observation.json`));
  if(!same(image.observedByDelivery.get(op.owner.deliveryId)?.manifest,observation.after))
    fail('EVIDENCE_STALE','product changed after native capture');
  const baseActivationBytes=(await readOwnedFile(path.join(op.root,'base.activation.json'))).bytes;
  const previous={activationBytes:baseActivationBytes,files:baseFiles(image)};
  const rounds=[];
  for(let index=1;index<=round;index+=1) rounds.push(await capturedSources(op,index));
  const inputs={context:op.context,requirementsAuthority:image.requirementsAuthority,previous,
    admission:{activationBytes:image.activationBytes,files:baseFiles(image)},
    deliveryId:op.owner.deliveryId};
  let composed;
  try {
    composed=usesCurrentChecks(image,op.owner)
      ?composeInitialCurrentOperation({...inputs,owner:op.owner,rounds,
        observedByDelivery:image.observedByDelivery})
      :auxiliary?await composePostConversionFindings({...inputs,rounds})
        :await composePostConversionValidation({...inputs,capture:rounds[0]});
  } catch(error) {
    const completed=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8')).completed.length;
    if(completed && ['INVALID_CURRENT_IMAGE','RUNNER_RESULT_REJECTED','EVIDENCE_INCOMPLETE','OWNER_MISMATCH'].includes(error.code)) {
      op.record.runner.status='uncertain';op.record.runner.captureClass='uncertain';
      await persistAllocation(op.marker,op.record);
      fail('RUNNER_RESULT_REJECTED',`native final bytes preserved; completed judgment cannot incorporate: ${error.message}`);
    }
    throw error;
  }
  return {image,observation,composed};
}

export async function normalize(handle) {
  const op=await load(handle);
  if(op.owner.preparationRevision===1 && !op.record.preparation?.candidateComposition)
    fail('NORMALIZATION_NOT_ELIGIBLE','Initial excludes product-drift and rejected-result normalization');
  if(['EXECUTE_SLICE','APPLY_FINDINGS'].includes(op.owner.operation) && op.record.phase==='working'
    && op.record.runner?.status==='captured'
    && op.record.runner.resultStatus==='TESTS_PASS'
    && !op.record.preparation?.candidateComposition) {
    if(op.binding.normalization || op.record.runner.productDrift
      || op.record.runner.round>=3)
      fail('NORMALIZATION_EXHAUSTED','product drift episode or invocation budget is exhausted');
    const round=op.record.runner.round;
    const image=await requireA1(op);
    const observation=await readJson(path.join(op.root,`round-${round}.observation.json`));
    const {observed}=await checkedProductDrift(op,image,observation);
    const rounds=[];
    for(let index=1;index<=round;index+=1) rounds.push(await capturedSources(op,index));
    const continuity=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'));
    const current=continuity.deliveries.find(item=>item.deliveryId===op.owner.deliveryId);
    const implementation=op.owner.operation==='EXECUTE_SLICE';
    const request=await readJson(path.join(op.root,'round-1.request.json'));
    const summary=implementation?composeInitialImplementationEvidence({context:op.context,authority:request.authority,
      owner:op.owner,currentEvidence:null,counters:current.counters,rounds})
      :await inspectPostConversionFindingsPrefix({context:op.context,
        snapshotBytes:Buffer.from(image.files.get('approved-preparation.json')),current,
        bundleBytes:Buffer.from(image.files.get(current.evidence.path)),owner:op.owner,rounds});
    if(implementation){
      if(summary.outcome!=='recorded')fail('NORMALIZATION_NOT_ELIGIBLE','rejected implementation cannot grant a drift episode');
      summary.status='TESTS_PASS';summary.rounds=summary.consumedInvocations;
    }
    if(summary.status!=='TESTS_PASS' || summary.rounds!==round)
      fail('NORMALIZATION_NOT_ELIGIBLE','prior PASS is not a valid captured prefix');
    const sourceCaptureSha256=findingsRoundCaptureSha256(rounds.at(-1));
    const expectedWorkSha256=currentEvidenceValueSha256(observed.manifest);
    const episodeId=sha(json({class:'product-drift',owner:op.owner.operationAttemptId,
      sourceRound:round,sourceCaptureSha256,expectedWorkSha256}));
    const witness={class:'product-drift',episodeId,
      sourceOperationAttemptId:op.owner.operationAttemptId,sourceRound:round,
      sourceCaptureSha256,expectedWorkSha256,used:1};
    return withExecutionPublicationLock(op.workspace,async()=>{
      const now=await load(handle);
      if(now.record.phase!=='working' || now.record.runner?.status!=='captured'
        || now.record.runner.round!==round || now.record.runner.resultStatus!=='TESTS_PASS'
        || now.record.runner.productDrift || now.record.preparation?.candidateComposition)
        fail('NORMALIZATION_EXHAUSTED','product drift episode is no longer available');
      const latest=await requireA1(now);
      if(!same(latest.activation,image.activation)
        || !same((await checkedProductDrift(now,latest,observation)).observed.manifest,observed.manifest))
        fail('EVIDENCE_STALE','product changed before drift reservation');
      now.record.runner.productDrift=witness;
      await persistAllocation(now.marker,now.record);
      return {phase:'captured',owner:now.owner,episodeId,expectedWorkSha256,
        nextAction:'reserve-dispatch'};
    });
  }
  if(op.record.phase!=='working' || op.record.runner?.status!=='captured'
    || !op.record.preparation?.candidateComposition)
    fail('NORMALIZATION_NOT_ELIGIBLE','no identified partial composition belongs to this captured owner');
  const {image,composed}=await capturedComposition(op);
  const response=(await readOwnedFile(op.record.runner.responseFile)).bytes;
  const proof=op.record.preparation.candidateComposition;
  const causeSha256=sha(json({class:'private-composition',operationAttemptId:op.owner.operationAttemptId,
    responseSha256:sha(response),candidateIdentity:proof.identity}));
  const candidatePath=await withExecutionPublicationLock(op.workspace,async()=>{
    const now=await load(handle);
    if(now.record.phase!=='working' || now.record.runner?.status!=='captured'
      || !same(now.record.preparation?.candidateComposition,proof))
      fail('OWNER_UNCERTAIN','partial composition changed before normalization reservation');
    const existing=now.record.normalization;
    if(existing && (existing.class!=='private-composition' || existing.causeSha256!==causeSha256
      || existing.operationAttemptId!==op.owner.operationAttemptId))
      fail('OWNER_MISMATCH','normalization reservation differs');
    if(!existing) {
      now.record.normalization={class:'private-composition',causeSha256,
        operationAttemptId:op.owner.operationAttemptId,responseSha256:sha(response),status:'reserved'};
      await persistAllocation(now.marker,now.record);
    }
    const candidate=await preparedCandidate(now,composed,image);
    now.record.normalization.status='settled';
    await persistAllocation(now.marker,now.record);
    return candidate;
  });
  return {phase:'prepared',owner:op.owner,causeSha256,candidatePath,
    rawResponseSha256:sha(response),nextAction:'publish'};
}
export async function normalizeSuccessor({specPath,slice,expectedActivationId}) {
  const image=await quiet(specPath);
  if(image.activation.activationId!==expectedActivationId) fail('STALE_BASE','normalization activation differs');
  const current=parseCurrentJson(Buffer.from(image.files.get('continuity.json')).toString('utf8'))
    .deliveries.find(item=>item.slice===slice);
  if(!current?.normalization || !['VALIDATE_SLICE','APPLY_FINDINGS'].includes(current.normalization.operation))
    fail('NORMALIZATION_NOT_ELIGIBLE','current slice has no supported normalization successor');
  return begin({specPath,slice,expectedActivationId,operation:current.normalization.operation,successor:true});
}

export async function publish(handle,{checkpoint=null}={}) {
  const op=await load(handle);
  const auxiliary=op.owner.operation!=='VALIDATE_SLICE';
  const round=op.record.runner?.round;
  if(op.record.runner?.status!=='captured'
    || auxiliary && op.record.runner.resultStatus==='TESTS_FAIL'
      && round+(op.binding.normalization?.consumedInvocations??0)<3)
    fail('OWNER_UNCERTAIN','native terminal result has not been captured');
  if(op.record.phase==='activation_written') {
    const result=await recoverCurrentExecutionOperation({workspace:op.workspace,marker:op.marker,
      binding:op.binding,previousPath:path.join(op.root,op.binding.previousPath),
      expectedActivationId:(await readJson(path.join(op.root,'round-1.origin.json'))).admission.reservedActivation.activationId,
      owner:{...op.owner,operationRef:{operationId:op.binding.operationId,
        allocationSha256:currentOperationBindingSha256(op.binding)}},
      readActive:expected=>active(handle.specPath,expected),readQuiet:()=>quiet(handle.specPath),
      registryCompletion:()=>completeRegistry(op)});
    return {...result,nextAction:result.cleanup==='complete'?'inspect':'resume-cleanup'};
  }
  const {image,observation,composed}=await capturedComposition(op);
  const candidatePath=await withExecutionPublicationLock(op.workspace,async()=>{
    const now=await load(handle);
    const transition={operationAttemptId:now.owner.operationAttemptId,
      outcome:composed.transition.outcome,
      normalization:composed.transition.normalization??null};
    if(!['recorded','rejected'].includes(transition.outcome)
      || transition.outcome==='rejected' && !transition.normalization)
      fail('INVALID_CURRENT_IMAGE','composed terminal transition is invalid');
    if(now.record.terminalTransition && !same(now.record.terminalTransition,transition))
      fail('OWNER_MISMATCH','terminal transition changed before publication');
    if(!now.record.terminalTransition) {
      now.record.terminalTransition=transition;
      await persistAllocation(now.marker,now.record);
    }
    const proof=now.record.preparation?.candidateComposition;
    if(proof && now.record.normalization?.status!=='settled') {
      const tree=await captureExecutionTree(path.join(now.root,now.binding.candidatePath));
      const base=new Map(proof.baseTree.map(item=>[item.path,item]));
      const required=new Set(['activation.json',...composed.files.keys()]);
      for(const name of composed.files.keys())
        for(let parent=path.posix.dirname(name);parent!=='.';parent=path.posix.dirname(parent))
          required.add(parent);
      const complete=tree && same(tree.identity,proof.identity)
        && tree.files.length===required.size && tree.files.every(entry=>{
          if(!required.has(entry.path)) return false;
          if(entry.type==='directory') return true;
          const target=entry.path==='activation.json'?image.activationBytes:composed.files.get(entry.path);
          return entry.type==='file' && target!==undefined && entry.sha256===sha(target)
            && entry.mode===(base.get(entry.path)?.mode??0o644);
        });
      if(!complete) fail('NORMALIZATION_NOT_ELIGIBLE',
        'identified partial candidate requires normalize --handle before publication');
    }
    return preparedCandidate(now,composed,image,{checkpoint});
  });
  const previousPath=path.join(op.root,op.binding.previousPath);
  const result=await publishCurrentExecutionOperation({workspace:op.workspace,marker:op.marker,
    binding:op.binding,candidatePath,previousPath,
    expectedActivationId:image.activation.activationId,
    owner:image.activation.activeAttempt,
    readActive:expected=>active(handle.specPath,expected),readQuiet:()=>quiet(handle.specPath),
    validateCandidate:async root=>{
      const actual=await candidateFiles(root,[...composed.files.keys()]);
      if([...composed.files].some(([name,bytes])=>!actual.get(name)?.equals(bytes)))
        fail('EVIDENCE_STALE','publication candidate differs from captured composition');
      validateCurrentCandidate({files:actual});
    },
    authorizeCandidate:async current=>{
      if(!same(current.activation,image.activation)
        || current.files.size!==image.files.size
        || [...image.files].some(([name,bytes])=>!Buffer.from(current.files.get(name)??[]).equals(Buffer.from(bytes))))
        fail('STALE_BASE','publication base changed after capture');
      if(!same(current.observedByDelivery.get(op.owner.deliveryId)?.manifest,observation.after))
        fail('EVIDENCE_STALE','product changed before publication swap');
      assertOtherInitialWork(current,await readJson(path.join(op.root,'round-1.origin.json')));
    },
    registryCompletion:()=>completeRegistry(op),checkpoint});
  return {...result,transition:composed.transition,
    counters:composed.transition.counters,
    nextAction:result.cleanup==='complete'?'inspect':'resume-cleanup'};
}

export async function resume(handle) {
  const op=await load(handle,{requireRegistry:false});
  const phase=op.record.phase;
  const runner=op.record.runner;
  if(phase==='committed' && op.record.confirmation) {
    const current=await quiet(handle.specPath);
    if(current.activation.activationId!==op.record.confirmation.activationId)
      fail('PUBLICATION_UNCERTAIN','confirmed terminal activation differs');
    return {phase:'committed',nextAction:op.record.cleanup.status==='complete'?'none':'cleanup',
      activationId:current.activation.activationId};
  }
  if(['candidate_promoted','activation_written','backup_created'].includes(phase))
    return {phase,nextAction:'classify-publication',owner:op.owner};
  if(runner?.status==='captured') return {phase:'captured',nextAction:op.owner.preparationRevision===1
      && (op.owner.operation==='VALIDATE_SLICE' && runner.captureClass==='initial-rejection'
        || ['EXECUTE_SLICE','APPLY_FINDINGS'].includes(op.owner.operation)
          && runner.captureClass==='findings-rejection')
      ?'blocked':op.record.preparation?.candidateComposition
        && op.record.normalization?.status!=='settled'?'normalize':'publish',owner:op.owner,
    responseSha256:sha((await readOwnedFile(runner.responseFile)).bytes),
    ...(['EXECUTE_SLICE','APPLY_FINDINGS'].includes(op.owner.operation) && runner.resultStatus==='TESTS_FAIL'
      && runner.round+(op.binding.normalization?.consumedInvocations??0)<3
      ?{nextAction:'reserve-dispatch'}:{}),
    ...(['EXECUTE_SLICE','APPLY_FINDINGS'].includes(op.owner.operation) && runner.productDrift
      && runner.resultStatus==='TESTS_PASS' && runner.round===runner.productDrift.sourceRound
      ?{nextAction:'reserve-dispatch'}:{})};
  if(runner?.status==='running') return {phase:'running',nextAction:'await-same-agent',agentId:runner.agentId};
  if(runner?.status==='reserved') return {phase:'dispatch-reserved',nextAction:'bind-same-agent-or-block'};
  if(runner?.status==='uncertain') return {phase:'uncertain',nextAction:'stop-and-diagnose'};
  return {phase,nextAction:'reserve-dispatch'};
}

export async function inspect(specPath) {return captureCurrentExecution(specPath).then(value=>value.inspection);}

function flag(argv,name) {
  const index=argv.indexOf(name);
  return index<0?null:argv[index+1]??null;
}
export async function main(argv=process.argv.slice(2)) {
  const [command]=argv;
  try {
    const handleFile=flag(argv,'--handle');
    const handle=handleFile?await readJson(handleFile):null;
    let result;
    if(command==='inspect') result=await inspect(flag(argv,'--spec-path'));
    else if(command==='begin') result=await begin({specPath:flag(argv,'--spec-path'),
      slice:flag(argv,'--slice'),expectedActivationId:flag(argv,'--expected-activation-id'),
      operation:flag(argv,'--operation')??'VALIDATE_SLICE'});
    else if(command==='reserve-dispatch') result=await reserveDispatch(handle,
      {responseVariant:flag(argv,'--response-variant')});
    else if(command==='bind-native') result=await bindNative(handle,flag(argv,'--agent-id'));
    else if(command==='verify-native') result=await verifyNative(flag(argv,'--origin-file'));
    else if(command==='capture-native') result=await captureNative(handle,flag(argv,'--tool-result-file'));
    else if(command==='normalize' && handle) result=await normalize(handle);
    else if(command==='normalize') result=await normalizeSuccessor({specPath:flag(argv,'--spec-path'),
      slice:flag(argv,'--slice'),expectedActivationId:flag(argv,'--expected-activation-id')});
    else if(command==='publish') result=await publish(handle);
    else if(command==='cleanup') result=await cleanup(handle);
    else if(command==='resume') result=await resume(handle);
    else {process.stderr.write('Usage: execution-current-operation.mjs inspect|begin|reserve-dispatch|bind-native|verify-native|capture-native|normalize|publish|cleanup|resume ...\n');return 2;}
    process.stdout.write(JSON.stringify(result)+'\n');return 0;
  } catch(error) {
    process.stdout.write(JSON.stringify({code:error.code??'CURRENT_OPERATION_BLOCKED',reason:error.message})+'\n');
    return 1;
  }
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
  process.exitCode=await main();
