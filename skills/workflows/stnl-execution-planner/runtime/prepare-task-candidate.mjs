#!/usr/bin/env node
import fs from 'node:fs/promises';
import {assertPreparationDraftApproval} from './preparation-draft.mjs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolveCurrentExecutionContext} from './execution-workspace.mjs';
import {inspectCurrentExecution} from './execution-current-reader.mjs';
import {captureCurrentSetReplacementSource} from './execution-state.mjs';
import {capturePreparationSource,setPreparationMembers} from './prepare-plan-candidate.mjs';
import {allocatePreparationCandidate,withExecutionPublicationLock,assertNoPendingExecutionPublication,assertOwnedPreparationCandidate,
 preparationRegistryPath,readOwnedFile,parseStrictJson} from './execution-publication.mjs';
import {resolveExecutionFilesystemContext,ensureExecutionMaterialRoot} from './execution-publication.mjs';
import {resolveExecutionWorkspace} from './execution-workspace.mjs';
function fail(code,message){throw Object.assign(new Error(message),{code});}
export async function preparePreparationCandidate({specPath,operation,candidateExecutionRoot=null,revisionMode=null,completedDeliveryIds=null,terminalValidation=false,revalidateCompletedIds=null,filesystemContext=null}) {
 if(revalidateCompletedIds!==null&&(operation!=='REPLAN'||terminalValidation))fail('UNSUPPORTED_FORMAT','Completed revalidation requires its explicit non-terminal REPLAN selection');
 if(typeof terminalValidation!=='boolean'||terminalValidation&&operation!=='REPLAN')fail('UNSUPPORTED_FORMAT','Terminal validation requires an explicit REPLAN selection');
 if(revisionMode!==null)fail('UNSUPPORTED_FORMAT','Replacement modes from earlier execution formats are not supported');
 if(!['PLAN','REPLAN','REVIEW_PLAN'].includes(operation))fail('UNSUPPORTED_FORMAT','Expected PLAN, REPLAN or REVIEW_PLAN');
 const {workspace,context}=await resolveCurrentExecutionContext(specPath,{filesystemContext});
 if(operation==='REVIEW_PLAN') {
  if(!candidateExecutionRoot)fail('EVIDENCE_INCOMPLETE','REVIEW_PLAN requires the exact isolated preparation root returned by PLAN');
  const owned=await assertOwnedPreparationCandidate({candidateExecutionRoot,specPath,resolveWorkspace:spec=>resolveExecutionWorkspace(spec,{filesystemContext})});
  await assertPreparationDraftApproval({specPath,candidateExecutionRoot:owned.root,filesystemContext});
  if(owned.marker.operation==='REPLAN')await capturePreparationSource(owned);
  else if((await inspectCurrentExecution(specPath)).state!=='NO_EXECUTION'||owned.marker.source!==null||owned.marker.expectedActivationId!==null)fail('STALE_BASE','Initial review has an occupied predecessor');
  return {status:'AWAITING_REVIEW',candidateExecutionRoot:owned.root,expectedActivationId:owned.marker.expectedActivationId};
 }
 if(candidateExecutionRoot!==null)fail('OWNER_UNCERTAIN','Only REVIEW_PLAN may reuse an allocated preparation root');
 await assertNoPendingExecutionPublication(workspace);
 const replacement=operation==='REPLAN',source=replacement?await captureCurrentSetReplacementSource(specPath,{revalidateCompletedIds}):null;
 const image=source?.inspection??await inspectCurrentExecution(specPath);
 if(!replacement&&image.state!=='NO_EXECUTION')fail('REPLAN_REQUIRED','Initial preparation cannot replace an existing execution');
 if(replacement&&!Array.isArray(completedDeliveryIds))fail('EVIDENCE_INCOMPLETE','REPLAN requires an explicit completedDeliveryIds selection');
 if(replacement)setPreparationMembers(source,completedDeliveryIds,{terminalValidation,revalidateCompletedIds});
 if(!replacement&&completedDeliveryIds!==null)fail('UNSUPPORTED_FORMAT','Initial has no completed selection');
 const roots=await resolveExecutionFilesystemContext(workspace);
 if(roots.exclusion.kind==='git-ignore-unverified') {
  if(['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS'].some(name=>Object.hasOwn(process.env,name)))
   fail('TEMP_ROOT_UNPROVEN','Git repository/index/configuration overrides are not accepted');
  try{await promisify(execFile)('git',['-C',roots.productRoot,'check-ignore','-q','--',roots.temporaryRoot+path.sep],
   {shell:false,timeout:10000,maxBuffer:16384,encoding:'utf8',windowsHide:true});}
  catch{fail('TEMP_ROOT_UNPROVEN','Preparation temporary root must be ignored before allocation');}
 }
 const parent=(await ensureExecutionMaterialRoot(workspace,roots)).materialRoot;
 return withExecutionPublicationLock(workspace,async lease=>{
  const checkedSource=replacement?await captureCurrentSetReplacementSource(specPath,{revalidateCompletedIds}):null;
  const current=checkedSource?.inspection??await inspectCurrentExecution(specPath);
  if(revalidateCompletedIds!==null&&source.revalidationBasisSha256!==checkedSource.revalidationBasisSha256)fail('STALE_BASE','Revalidation observations changed before allocation');
  if(current.requirementsAuthority!==image.requirementsAuthority||current.activationId!==image.activationId
    ||!replacement&&current.state!=='NO_EXECUTION')fail('STALE_BASE','Preparation authority or target changed');
  if(replacement) {
   let registry=null;
   try{registry=parseStrictJson((await readOwnedFile(await preparationRegistryPath(workspace))).bytes.toString('utf8'));}
   catch(error){if(error.code!=='ENOENT')throw error;}
   // Refusal only: allocation still validates the existing registry itself.
   // The common lease makes this check serial with its registered creation.
   if(registry&&(!Array.isArray(registry.allocations)||registry.allocations.some(item=>item.operation==='REPLAN')))
    fail('OWNER_ACTIVE','A registered REPLAN preparation or uncertain registry blocks another allocation');
  }
  const root=await allocatePreparationCandidate({workspace,lease,captureParent:parent,metadata:{operation,specPath:workspace.authorityPath,expectedActivationId:current.activationId,preparationRevision:replacement?current.preparationRevision+1:1,deliveryIds:{},...(replacement?{completedDeliveryIds:[...completedDeliveryIds]}:{}),...(terminalValidation?{terminalValidation:true}:{}),...(revalidateCompletedIds!==null?{revalidateCompletedIds:[...revalidateCompletedIds],revalidationBasisSha256:checkedSource.revalidationBasisSha256}:{})}});
  if(replacement)await capturePreparationSource(await assertOwnedPreparationCandidate({candidateExecutionRoot:root,specPath,resolveWorkspace:spec=>resolveExecutionWorkspace(spec,{filesystemContext})}));
  return {status:'DRAFT',candidateExecutionRoot:root,expectedActivationId:current.activationId,requirementsAuthority:current.requirementsAuthority};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i+=2){const key={'--spec-path':'specPath','--operation':'operation','--candidate-execution-root':'candidateExecutionRoot','--completed-delivery-ids':'completedDeliveryIds','--terminal-validation':'terminalValidation','--revalidate-completed-ids':'revalidateCompletedIds'}[args[i]];if(!key||!args[i+1]||Object.hasOwn(options,key))throw new Error('Usage: prepare-task-candidate.mjs --spec-path SPEC --operation PLAN|REPLAN|REVIEW_PLAN [--candidate-execution-root ROOT] [--completed-delivery-ids JSON_ARRAY] [--terminal-validation true] [--revalidate-completed-ids JSON_ARRAY]');options[key]=['completedDeliveryIds','terminalValidation','revalidateCompletedIds'].includes(key)?JSON.parse(args[i+1]):args[i+1];}
 process.stdout.write(JSON.stringify(await preparePreparationCandidate(options))+'\n');
}
