#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {resolveCurrentExecutionContext} from './execution-workspace.mjs';
import {inspectCurrentExecution} from './execution-current-reader.mjs';
import {allocatePreparationCandidate,withExecutionPublicationLock,assertOwnedPreparationCandidate} from './execution-publication.mjs';
import {resolveExecutionWorkspace} from './execution-workspace.mjs';
function fail(code,message){throw Object.assign(new Error(message),{code});}
export async function preparePreparationCandidate({specPath,operation,candidateExecutionRoot=null,revisionMode=null}) {
 if(revisionMode!==null)fail('UNSUPPORTED_FORMAT','Replacement modes from earlier execution formats are not supported');
 if(operation==='REPLAN')fail('REPLAN_REQUIRED','Current replacement-set publication is not available; existing execution is preserved');
 if(!['PLAN','REVIEW_PLAN'].includes(operation))fail('UNSUPPORTED_FORMAT','Expected PLAN or REVIEW_PLAN');
 const {workspace,context}=await resolveCurrentExecutionContext(specPath);
 const image=await inspectCurrentExecution(specPath);
 if(image.state!=='NO_EXECUTION')fail('REPLAN_REQUIRED','Initial preparation cannot replace an existing execution');
 if(operation==='REVIEW_PLAN') {
  if(!candidateExecutionRoot)fail('EVIDENCE_INCOMPLETE','REVIEW_PLAN requires the exact isolated preparation root returned by PLAN');
  const owned=await assertOwnedPreparationCandidate({candidateExecutionRoot,specPath,resolveWorkspace:resolveExecutionWorkspace});
  if(owned.marker.source!==null||owned.marker.expectedActivationId!==null)fail('STALE_BASE','Initial review has an occupied predecessor');
  return {status:'AWAITING_REVIEW',candidateExecutionRoot:owned.root,expectedActivationId:null};
 }
 const parent=path.join(context.productRoot,'tmp');await fs.mkdir(parent,{recursive:true});
 const metadata=await fs.lstat(parent);
 if(!metadata.isDirectory()||metadata.isSymbolicLink()||await fs.realpath(parent)!==parent)fail('OWNER_UNCERTAIN','Preparation parent must be a canonical directory');
 try{await promisify(execFile)('git',['-C',context.productRoot,'check-ignore','-q','--',path.join(parent,'stnl-preparation-probe')]);}
 catch{fail('OWNER_UNCERTAIN','Preparation parent must be ignored by the product Git repository');}
 return withExecutionPublicationLock(workspace,async lease=>{
  const current=await inspectCurrentExecution(specPath);
  if(current.state!=='NO_EXECUTION'||current.requirementsAuthority!==image.requirementsAuthority)fail('STALE_BASE','Initial authority or target changed');
  const root=await allocatePreparationCandidate({workspace,lease,captureParent:parent,metadata:{operation:'PLAN',specPath:await fs.realpath(specPath),expectedActivationId:null,preparationRevision:1,deliveryIds:{}}});
  return {status:'DRAFT',candidateExecutionRoot:root,expectedActivationId:null,requirementsAuthority:current.requirementsAuthority};
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i+=2){const key={'--spec-path':'specPath','--operation':'operation','--candidate-execution-root':'candidateExecutionRoot'}[args[i]];if(!key||!args[i+1]||Object.hasOwn(options,key))throw new Error('Usage: prepare-task-candidate.mjs --spec-path SPEC --operation PLAN|REVIEW_PLAN [--candidate-execution-root ROOT]');options[key]=args[i+1];}
 process.stdout.write(JSON.stringify(await preparePreparationCandidate(options))+'\n');
}
