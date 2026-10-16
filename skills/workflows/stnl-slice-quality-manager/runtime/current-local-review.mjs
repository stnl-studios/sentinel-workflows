#!/usr/bin/env node

// One converted EC-1 S2 local review. The preparation kernel owns projections
// and approval; the existing publisher owns the common lock and activation CAS.
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveCurrentExecutionContext,projectCurrentRequirements} from './execution-state.mjs';
import {captureCurrentExecution} from './execution-current-reader.mjs';
import {prepareCurrentLocalReview,finalizeCurrentLocalReview,validateCurrentPreparation} from './execution-preparation-current.mjs';
import {validateCurrentCandidate,validateCurrentActivation,parseCurrentJson} from './execution-current.mjs';
import {captureExecutionTree,readOwnedFile,writeNew,publishExecutionUpdate,
  recoverCurrentReplacementPublication} from './execution-publication.mjs';
import {allocateCurrentLocalReviewCandidate} from './execution-current-operation.mjs';

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fail(code,message) {throw Object.assign(new Error(message),{code});}
const preparationFile=name=>/^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(name);
async function candidateFiles(root) {
  const tree=await captureExecutionTree(root);
  if(!tree || tree.files.some(item=>item.type==='directory'
    ?!['plans','tasks','evidence'].includes(item.path)
    :item.type!=='file' || !(preparationFile(item.path)
      || ['approved-preparation.json','continuity.json'].includes(item.path)
      || /^evidence\/[a-f0-9-]+\.json$/u.test(item.path))))
    fail('INVALID_CURRENT_IMAGE','local review candidate has foreign paths');
  const files=new Map();
  for(const entry of tree.files) if(entry.type==='file')
    files.set(entry.path,(await readOwnedFile(path.join(root,...entry.path.split('/')))).bytes);
  return files;
}
async function activated(specPath) {
  const image=await captureCurrentExecution(specPath);
  return {activation:parseCurrentJson(Buffer.from(image.activationBytes).toString('utf8'))};
}
export async function publishCurrentLocalReview({specPath,slice,planBytes,reviewedTaskBytes,
  currentTaskBytes,review,checkpoint=null}) {
  const {context,workspace}=await resolveCurrentExecutionContext(specPath);
  const previous=await captureCurrentExecution(specPath);
  const sourceActivation=parseCurrentJson(Buffer.from(previous.activationBytes).toString('utf8'));
  const input={context,requirementsAuthority:previous.requirementsAuthority,
    previous:{activationBytes:previous.activationBytes,files:previous.files},slice,
    planBytes,reviewedTaskBytes,currentTaskBytes};
  const proposal=prepareCurrentLocalReview(input);
  const finalized=finalizeCurrentLocalReview({proposal,review});
  const before=await captureExecutionTree(context.logicalExecutionRoot);
  const candidate=await allocateCurrentLocalReviewCandidate(context);
  const created=await fs.lstat(candidate);
  let expected;
  try {
    for(const [name,bytes] of finalized.files) {
      const destination=path.join(candidate,...name.split('/'));
      await fs.mkdir(path.dirname(destination),{recursive:true});
      await writeNew(destination,Buffer.from(bytes),0o644);
    }
    expected=await candidateFiles(candidate);
  } catch(error) {
    try {
      const now=await fs.lstat(candidate);
      const held=await candidateFiles(candidate);
      if(now.dev!==created.dev || now.ino!==created.ino
        || [...held].some(([name,bytes])=>!finalized.files.get(name)?.equals(bytes)))
        throw new Error('candidate ownership or partial bytes differ');
      await fs.rm(candidate,{recursive:true});
    } catch(cleanupError) {
      error.candidateRoot=candidate;
      error.message+=`; owned candidate cleanup pending: ${cleanupError.message}`;
    }
    throw error;
  }
  const currentWorkspace={executionRoot:context.logicalExecutionRoot,specRoot:context.logicalSpecRoot};
  const recheckRequirements=async()=>{
    const documents=new Map([[workspace.authorityPath,await fs.readFile(workspace.authorityPath)]]);
    if(workspace.kind==='lifecycle') {
      const shared=path.join(workspace.specRoot,'shared');
      let listed=[];
      try {listed=await fs.readdir(shared,{withFileTypes:true});}
      catch(error) {if(error.code!=='ENOENT') throw error;}
      for(const entry of listed) {
        if(!entry.isFile() || !entry.name.endsWith('.md'))
          fail('REQUIREMENTS_CHANGED','local review shared source changed during publication');
        documents.set(path.join(shared,entry.name),await fs.readFile(path.join(shared,entry.name)));
      }
    }
    if(projectCurrentRequirements({workspace,files:documents}).requirementsAuthority
      !==previous.requirementsAuthority)
      fail('REQUIREMENTS_CHANGED','local review requirements changed during publication');
  };
  let result;
  try {result=await publishExecutionUpdate({workspace:currentWorkspace,candidateExecutionRoot:candidate,
    expectedTree:before,expectedActivationId:sourceActivation.activationId,
    currentReplacement:true,checkpoint,readActivated:()=>activated(specPath),
    recheckRequirements,
    authorizeDiff:async()=>{
      const now=await captureCurrentExecution(specPath);
      const activation=parseCurrentJson(Buffer.from(now.activationBytes).toString('utf8'));
      if(!same(activation,sourceActivation)
        || now.requirementsAuthority!==previous.requirementsAuthority
        || now.files.size!==previous.files.size
        || [...now.files].some(([name,bytes])=>!Buffer.from(bytes).equals(Buffer.from(previous.files.get(name)??[]))))
        fail('STALE_BASE','local review predecessor changed before publication');
    },
    validateCandidate:async stage=>{
      const files=await candidateFiles(stage);
      if(files.size!==expected.size || [...expected].some(([name,bytes])=>!files.get(name)?.equals(bytes)))
        fail('STALE_APPROVAL','local review staged bytes differ from approved proposal');
      validateCurrentCandidate({files});
      const now=await captureCurrentExecution(specPath);
      if(now.requirementsAuthority!==previous.requirementsAuthority)
        fail('REQUIREMENTS_CHANGED','local review requirements changed');
      return validateCurrentPreparation({context,requirementsAuthority:previous.requirementsAuthority,
        snapshotBytes:files.get('approved-preparation.json'),
        artifacts:new Map([...files].filter(([name])=>preparationFile(name))),profile:'converted-current'}).authority;
    }});}
  catch(error) {
    error.candidateRoot=candidate;
    try {
      let markerExists=false;
      if(error.allocation) {
        try {await fs.lstat(error.allocation);markerExists=true;}
        catch(markerError) {if(markerError.code!=='ENOENT') throw markerError;}
      }
      // Only pre-marker failures can release this exact candidate without the
      // allocation recovery path. A later missing marker stays uncertain.
      if(!markerExists && (!error.allocation || error.markerCreationFailed===true)) {
        const now=await fs.lstat(candidate);
        const held=await candidateFiles(candidate);
        if(now.dev!==created.dev || now.ino!==created.ino || held.size!==expected.size
          || [...held].some(([name,bytes])=>!expected.get(name)?.equals(bytes)))
          throw new Error('candidate ownership or bytes differ');
        await fs.rm(candidate,{recursive:true});
        delete error.allocation;
      }
    } catch(cleanupError) {
      error.message+=`; owned candidate cleanup pending: ${cleanupError.message}`;
    }
    throw error;
  }
  try {
    const confirmed=await captureCurrentExecution(specPath);
    if(result.publication!=='confirmed'
      || !same(parseCurrentJson(Buffer.from(confirmed.activationBytes).toString('utf8')),result.activation))
      fail('OWNER_UNCERTAIN','local review publication readback differs');
  } catch(error) {
    error.allocation=result.allocation;
    error.candidateRoot=candidate;
    throw error;
  }
  let ownedCleanup={cleanup:'pending',cleanupDiagnostics:['local review publication owner cleanup not attempted']};
  if(result.allocation) {
    try {ownedCleanup=await recoverCurrentLocalReview({specPath,allocation:result.allocation});}
    catch(error) {ownedCleanup={cleanup:'pending',cleanupDiagnostics:[error.message]};}
  }
  return {...result,cleanup:ownedCleanup.cleanup==='complete'?'complete':'pending',
    cleanupDiagnostics:ownedCleanup.cleanupDiagnostics??[],
    reviewedDeliveryId:finalized.selected.deliveryId};
}

export async function recoverCurrentLocalReview({specPath,allocation}) {
  const {context}=await resolveCurrentExecutionContext(specPath);
  return recoverCurrentReplacementPublication({workspace:{executionRoot:context.logicalExecutionRoot,
    specRoot:context.logicalSpecRoot},marker:allocation,readActivated:()=>activated(specPath),
    validateInstalledActivation:validateCurrentActivation});
}
