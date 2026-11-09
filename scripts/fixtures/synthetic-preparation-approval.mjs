// Synthetic test-only human approval setup. Never import this from production runtime.
import fs from 'node:fs/promises';
import path from 'node:path';
import {publishPreparationCandidate as publishRuntime} from '../../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {installCurrentInitial as installRuntime} from '../../skills/workflows/stnl-execution-planner/runtime/install-current-initial.mjs';
import {preparePreparationCandidate} from '../../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {inspectCurrentExecution} from '../../skills/workflows/stnl-execution-planner/runtime/execution-current-reader.mjs';
import {createPreparationDraft,capturePreparationDraft,approvePreparationDraft,preparationDraftPaths} from '../../skills/workflows/stnl-execution-planner/runtime/preparation-draft.mjs';
import {persistAllocation} from '../../skills/workflows/stnl-execution-planner/runtime/execution-publication.mjs';
const registered=new Map();
export async function approveSyntheticPreparation(options){
 const root=options.candidateExecutionRoot,controls=await preparationDraftPaths(options);
 if(await fs.stat(controls.approval).catch(()=>null))return;
 if(!await fs.stat(controls.binding).catch(()=>null))await createPreparationDraft(options);
 // Imported synthetic legacy fixtures have fixed identities already used by their review.
 const marker=JSON.parse(await fs.readFile(root+'.owner.json','utf8'));
 if(marker.operation==='PLAN'){
  for(const name of await fs.readdir(path.join(root,'plans'))){
   const id=(await fs.readFile(path.join(root,'plans',name),'utf8')).match(/^- Delivery ID: ([a-f0-9-]{36})$/mu)?.[1];
   if(id&&!marker.deliveryIds[name])marker.deliveryIds[name]=id;
  }
  await persistAllocation(root+'.owner.json',marker);
 }
 const capture=await capturePreparationDraft(options);
 await approvePreparationDraft({...options,approvedCaptureSha256:capture.captureSha256});
}
export async function publishPreparationCandidate(options){
 if(options.reviewDecision!==null&&options.reviewDecision!==undefined)await approveSyntheticPreparation(options);
 return publishRuntime(options);
}
export async function installCurrentInitial(options){
 if((await inspectCurrentExecution(options.specPath)).state!=='NO_EXECUTION')return installRuntime(options);
 let root=options.preparationRoot;
 if(!await fs.stat(root+'.owner.json').catch(()=>null)){
  const cached=registered.get(root);
  // A publisher may have moved/retired its candidate. Forget only our locator;
  // the official allocator still owns the pending-publication/registry gate.
  if(cached&&!await fs.lstat(cached+'.owner.json').catch(error=>{if(error.code==='ENOENT')return null;throw error;}))registered.delete(root);
  if(!registered.has(root)){
   const allocation=await preparePreparationCandidate({specPath:options.specPath,operation:'PLAN',filesystemContext:options.filesystemContext});
   registered.set(root,allocation.candidateExecutionRoot);
  }
  const candidate=registered.get(root);await fs.cp(root,candidate,{recursive:true});root=candidate;
 }
 await approveSyntheticPreparation({...options,candidateExecutionRoot:root});
 return installRuntime({...options,preparationRoot:root});
}
