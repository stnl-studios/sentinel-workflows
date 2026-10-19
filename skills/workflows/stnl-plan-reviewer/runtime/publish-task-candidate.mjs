#!/usr/bin/env node
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {preparePlanCandidate,assertPreparationCandidate,capturePreparationSource} from './prepare-plan-candidate.mjs';
import {serializePlanPathClaims} from './serialize-plan-paths.mjs';
import {installCurrentInitial} from './install-current-initial.mjs';
import {finalizeCurrentSetReplacement,validateCurrentPreparation} from './execution-preparation-current.mjs';
import {validateCurrentReviewCandidate,captureCurrentExecution,observeCurrentDeliveryWork} from './execution-current-reader.mjs';
import {completedEvidenceContext} from './current-evidence-state.mjs';
import {resolveCurrentExecutionContext,projectCurrentRequirements} from './execution-workspace.mjs';
import {validateCurrentActivation} from './execution-current.mjs';
import {captureExecutionTree,readOwnedFile,publishExecutionUpdate,recoverCurrentReplacementPublication,
 assertRegisteredPreparationAllocation,parseStrictJson,syncLockParent} from './execution-publication.mjs';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fail(code,message){throw Object.assign(new Error(message),{code});}
async function activated(specPath){const image=await captureCurrentExecution(specPath);return {activation:parseStrictJson(Buffer.from(image.activationBytes).toString('utf8'))};}
async function exactCandidate(root,expected) {
 const tree=await captureExecutionTree(root);
 if(!tree||tree.files.some(item=>item.type==='directory'?!['plans','tasks','evidence'].includes(item.path):!expected.has(item.path)))
  fail('STALE_APPROVAL','Registered replacement candidate has foreign paths');
 const files=new Map();for(const entry of tree.files)if(entry.type==='file')files.set(entry.path,(await readOwnedFile(path.join(root,entry.path))).bytes);
 if(files.size!==expected.size||[...expected].some(([name,bytes])=>!files.get(name)?.equals(bytes)))
  fail('STALE_APPROVAL','Registered replacement bytes differ from the reviewed candidate');
 return files;
}
export async function recoverPreparationPublication({specPath,allocation,checkpoint=null}) {
 const {workspace}=await resolveCurrentExecutionContext(specPath);
 try{return await recoverCurrentReplacementPublication({workspace,marker:allocation,readActivated:()=>activated(specPath),
  validateInstalledActivation:validateCurrentActivation,registeredPreparation:true,checkpoint});}
 catch(error){error.allocation=allocation;throw error;}
}
export async function publishPreparationCandidate({specPath,candidateExecutionRoot,reviewDecision=null,checkpoint=null}) {
 const owned=await assertPreparationCandidate(candidateExecutionRoot,specPath);
 if(owned.marker.operation==='REPLAN') {
  await preparePlanCandidate({candidateExecutionRoot:owned.root});
  const prepared=await serializePlanPathClaims({specPath,candidateExecutionRoot:owned.root});
  const reviewed=reviewDecision===null?null:finalizeCurrentSetReplacement({proposal:prepared.proposal,review:reviewDecision});
  if(reviewed)await validateCurrentReviewCandidate({specPath,files:reviewed.files});
  await capturePreparationSource(await assertPreparationCandidate(owned.root,specPath));
  try {
   for(const [name,bytes] of reviewed?.files??prepared.proposal.files) {
    const target=path.join(owned.root,name);await fs.mkdir(path.dirname(target),{recursive:true});
    if(reviewed){const handle=await fs.open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o644);
     try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}await syncLockParent(path.dirname(target));}
    else await fs.writeFile(target,bytes);
   }
   if(reviewed){await syncLockParent(owned.root);await syncLockParent(path.dirname(owned.root));}
  }catch(error){error.candidateRoot=owned.root;throw error;}
  await capturePreparationSource(await assertPreparationCandidate(owned.root,specPath));
  if(!reviewed)return {status:'AWAITING_REVIEW',candidateExecutionRoot:owned.root,expectedActivationId:owned.marker.expectedActivationId,
   authority:prepared.authority,reviewRequest:prepared.proposal.reviewRequest,reviewValidated:false,publication:'not-started'};
  const {workspace}=await resolveCurrentExecutionContext(specPath),source=prepared.proposal.input.previous,context=prepared.proposal.input.context;
  const snapshot=parseStrictJson(Buffer.from(source.files.get('approved-preparation.json')).toString('utf8'));
  const continuity=parseStrictJson(Buffer.from(source.files.get('continuity.json')).toString('utf8'));
  const {retainedEvidence}=await completedEvidenceContext({context,snapshotBytes:source.files.get('approved-preparation.json'),continuity,files:source.files});
  const origin=validateCurrentPreparation({context,requirementsAuthority:prepared.proposal.input.requirementsAuthority,
   snapshotBytes:source.files.get('approved-preparation.json'),artifacts:new Map([...source.files].filter(([name])=>name.endsWith('.md'))),
   profile:continuity.completed.length?'completed-current':snapshot.preparationRevision===1?'initial':'converted-current',retainedEvidence});
  const products=[];
  for(const current of [...continuity.deliveries,...continuity.completed]) {
   const delivery=[...snapshot.normativeProjection.deliveries,...snapshot.normativeProjection.completed].find(item=>item.deliveryId===current.deliveryId);
   const sections=origin.currentArtifacts.deliveries.find(item=>item.deliveryId===current.deliveryId)?.sections??{'Expected Files':'- none'};
   const bundle=current.evidence?parseStrictJson(Buffer.from(source.files.get(current.evidence.path)).toString('utf8')):null;
   const input={context,delivery,sections,current,bundle};
   products.push({input,manifest:(await observeCurrentDeliveryWork(input)).manifest});
  }
  const recheckProducts=async()=>{
   for(const {input,manifest} of products)if(!same((await observeCurrentDeliveryWork(input)).manifest,manifest))
    fail('EVIDENCE_STALE','Approved source product or input changed before replacement promotion');
  };
  const authorize=async()=>{
   const current=await capturePreparationSource(await assertPreparationCandidate(owned.root,specPath));
   if(!Buffer.from(current.activationBytes).equals(Buffer.from(source.activationBytes))
     ||current.files.size!==source.files.size||[...source.files].some(([name,bytes])=>!Buffer.from(current.files.get(name)??[]).equals(Buffer.from(bytes))))
    fail('STALE_BASE','Reviewed replacement predecessor changed');
   // Anchor the captured domains in the same still-current source proof. The
   // later rechecks need only these approved observations, even after backup.
   await recheckProducts();
  };
  const recheckRequirements=async()=>{
   await assertRegisteredPreparationAllocation(workspace,owned.marker);
   if(!same(parseStrictJson((await readOwnedFile(`${owned.root}.owner.json`)).bytes.toString('utf8')),owned.marker))
    fail('OWNER_UNCERTAIN','Preparation owner changed during publication');
   const documents=new Map([[workspace.authorityPath,await fs.readFile(workspace.authorityPath)]]);
   if(workspace.kind==='lifecycle') {
    const shared=path.join(workspace.specRoot,'shared');let entries=[];
    try{entries=await fs.readdir(shared,{withFileTypes:true});}catch(error){if(error.code!=='ENOENT')throw error;}
    for(const entry of entries){if(!entry.isFile()||!entry.name.endsWith('.md'))fail('REQUIREMENTS_CHANGED','Replacement shared authority changed');documents.set(path.join(shared,entry.name),await fs.readFile(path.join(shared,entry.name)));}
   }
   if(projectCurrentRequirements({workspace,files:documents}).requirementsAuthority!==prepared.proposal.input.requirementsAuthority)
    fail('REQUIREMENTS_CHANGED','Replacement documentary authority changed');
   await recheckProducts();
  };
  let result;
  try {
   result=await publishExecutionUpdate({workspace,candidateExecutionRoot:owned.root,
    expectedTree:owned.marker.source,expectedActivationId:owned.marker.expectedActivationId,currentReplacement:true,
    preparationRecord:owned.marker,checkpoint,readActivated:()=>activated(specPath),recheckRequirements,
    authorizeDiff:authorize,validateCandidate:async root=>{
     const files=await exactCandidate(root,reviewed.files);await validateCurrentReviewCandidate({specPath,files});return reviewed.authority;
    }});
   const current=await activated(specPath);
   if(result.publication!=='confirmed'||!same(current.activation,result.activation))fail('OWNER_UNCERTAIN','Replacement publication readback differs');
  }catch(error){error.candidateRoot=owned.root;if(result?.allocation)error.allocation=result.allocation;throw error;}
  return {...result,candidateExecutionRoot:owned.root,
   preparationDisposition:result.cleanup==='complete'?'retired':'pending',reviewValidated:true};
 }
 if(owned.marker.source!==null||owned.marker.expectedActivationId!==null)throw Object.assign(new Error('Current replacement-set publication is not available; Initial cannot replace execution'),{code:'REPLAN_REQUIRED'});
 await preparePlanCandidate({candidateExecutionRoot:owned.root});
 const prepared=await serializePlanPathClaims({specPath,candidateExecutionRoot:owned.root});
 if(reviewDecision===null)return {status:'AWAITING_REVIEW',candidateExecutionRoot:owned.root,authority:prepared.authority,publication:'not-started'};
 // The v3 review schema is validated by the existing Initial producer. A former
 // reviewDecision object is not an equivalent authority and cannot activate it.
 const publication=await installCurrentInitial({specPath,preparationRoot:owned.root,review:reviewDecision,checkpoint});
 return {...publication,candidateExecutionRoot:owned.root,preparationDisposition:'diagnostic',preparationCleanup:'not-supported; retain this positively owned reviewed source without replaying publication'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const a=process.argv.slice(2);if(a.length===4&&a[0]==='--spec-path'&&a[2]==='--recover-allocation')process.stdout.write(JSON.stringify(await recoverPreparationPublication({specPath:a[1],allocation:a[3]}))+'\n');else{if(![4,6].includes(a.length)||a[0]!=='--spec-path'||a[2]!=='--candidate-execution-root'||a.length===6&&a[4]!=='--review-decision-file')throw new Error('Usage: publish-task-candidate.mjs --spec-path SPEC --candidate-execution-root ROOT [--review-decision-file FILE] | --spec-path SPEC --recover-allocation MARKER');const reviewDecision=a.length===6?JSON.parse(await fs.readFile(a[5],'utf8')):null;process.stdout.write(JSON.stringify(await publishPreparationCandidate({specPath:a[1],candidateExecutionRoot:a[3],reviewDecision}))+'\n');}}
