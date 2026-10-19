#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolveCurrentExecutionContext} from './execution-workspace.mjs';
import {inspectCurrentExecution} from './execution-current-reader.mjs';
import {captureCurrentSetReplacementSource} from './execution-state.mjs';
import {capturePreparationSource,setPreparationMembers} from './prepare-plan-candidate.mjs';
import {allocatePreparationCandidate,withExecutionPublicationLock,assertOwnedPreparationCandidate,
 preparationRegistryPath,readOwnedFile,parseStrictJson} from './execution-publication.mjs';
import {resolveExecutionWorkspace} from './execution-workspace.mjs';
function fail(code,message){throw Object.assign(new Error(message),{code});}
export async function preparePreparationCandidate({specPath,operation,candidateExecutionRoot=null,revisionMode=null,completedDeliveryIds=null}) {
 if(revisionMode!==null)fail('UNSUPPORTED_FORMAT','Replacement modes from earlier execution formats are not supported');
 if(!['PLAN','REPLAN','REVIEW_PLAN'].includes(operation))fail('UNSUPPORTED_FORMAT','Expected PLAN, REPLAN or REVIEW_PLAN');
 const {workspace,context}=await resolveCurrentExecutionContext(specPath);
 if(operation==='REVIEW_PLAN') {
  if(!candidateExecutionRoot)fail('EVIDENCE_INCOMPLETE','REVIEW_PLAN requires the exact isolated preparation root returned by PLAN');
  const owned=await assertOwnedPreparationCandidate({candidateExecutionRoot,specPath,resolveWorkspace:resolveExecutionWorkspace});
  if(owned.marker.operation==='REPLAN')await capturePreparationSource(owned);
  else if((await inspectCurrentExecution(specPath)).state!=='NO_EXECUTION'||owned.marker.source!==null||owned.marker.expectedActivationId!==null)fail('STALE_BASE','Initial review has an occupied predecessor');
  return {status:'AWAITING_REVIEW',candidateExecutionRoot:owned.root,expectedActivationId:owned.marker.expectedActivationId};
 }
 if(candidateExecutionRoot!==null)fail('OWNER_UNCERTAIN','Only REVIEW_PLAN may reuse an allocated preparation root');
 const replacement=operation==='REPLAN',source=replacement?await captureCurrentSetReplacementSource(specPath):null;
 const image=source?.inspection??await inspectCurrentExecution(specPath);
 if(!replacement&&image.state!=='NO_EXECUTION')fail('REPLAN_REQUIRED','Initial preparation cannot replace an existing execution');
 if(replacement&&!Array.isArray(completedDeliveryIds))fail('EVIDENCE_INCOMPLETE','REPLAN requires an explicit completedDeliveryIds selection');
 if(replacement)setPreparationMembers(source,completedDeliveryIds);
 if(!replacement&&completedDeliveryIds!==null)fail('UNSUPPORTED_FORMAT','Initial has no completed selection');
 const parent=path.join(context.productRoot,'tmp');await fs.mkdir(parent,{recursive:true});
 const metadata=await fs.lstat(parent);
 if(!metadata.isDirectory()||metadata.isSymbolicLink()||await fs.realpath(parent)!==parent)fail('OWNER_UNCERTAIN','Preparation parent must be a canonical directory');
 try{await promisify(execFile)('git',['-C',context.productRoot,'check-ignore','-q','--',path.join(parent,'stnl-preparation-probe')]);}
 catch{fail('OWNER_UNCERTAIN','Preparation parent must be ignored by the product Git repository');}
 return withExecutionPublicationLock(workspace,async lease=>{
  const current=replacement?(await captureCurrentSetReplacementSource(specPath)).inspection:await inspectCurrentExecution(specPath);
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
  const root=await allocatePreparationCandidate({workspace,lease,captureParent:parent,metadata:{operation,specPath:await fs.realpath(specPath),expectedActivationId:current.activationId,preparationRevision:replacement?current.preparationRevision+1:1,deliveryIds:{},...(replacement?{completedDeliveryIds:[...completedDeliveryIds]}:{})}});
  if(replacement)await capturePreparationSource(await assertOwnedPreparationCandidate({candidateExecutionRoot:root,specPath,resolveWorkspace:resolveExecutionWorkspace}));
  return {status:'DRAFT',candidateExecutionRoot:root,expectedActivationId:current.activationId,requirementsAuthority:current.requirementsAuthority};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i+=2){const key={'--spec-path':'specPath','--operation':'operation','--candidate-execution-root':'candidateExecutionRoot','--completed-delivery-ids':'completedDeliveryIds'}[args[i]];if(!key||!args[i+1]||Object.hasOwn(options,key))throw new Error('Usage: prepare-task-candidate.mjs --spec-path SPEC --operation PLAN|REPLAN|REVIEW_PLAN [--candidate-execution-root ROOT] [--completed-delivery-ids JSON_ARRAY]');options[key]=key==='completedDeliveryIds'?JSON.parse(args[i+1]):args[i+1];}
 process.stdout.write(JSON.stringify(await preparePreparationCandidate(options))+'\n');
}
