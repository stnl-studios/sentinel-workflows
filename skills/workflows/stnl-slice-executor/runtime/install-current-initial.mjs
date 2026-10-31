#!/usr/bin/env node

// First EC-1 Initial installation. The reviewed preparation is external to the
// absent official execution; the existing publisher owns the common lock/swap.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolveCurrentExecutionContext,executionWorkspaceFromContext} from './execution-workspace.mjs';
import {inspectCurrentExecution,captureCurrentExecution,observeCurrentDeliveryWork} from './execution-current-reader.mjs';
import {approveInitialPreparation,validateCurrentPreparation} from './execution-preparation-current.mjs';
import {validateCurrentCandidate,validateCurrentActivation} from './execution-current.mjs';
import {captureExecutionTree,readOwnedFile,writeNew,publishExecutionUpdate,recoverCurrentReplacementPublication} from './execution-publication.mjs';

import {preparePreparationCandidate} from './prepare-task-candidate.mjs';
import {assertPreparationCandidate} from './prepare-plan-candidate.mjs';

const text=value=>Buffer.from(JSON.stringify(value)+'\n','utf8');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fail(code,message) {throw Object.assign(new Error(message),{code});}
const preparationFile=name=>/^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(name);
async function filesAt(root,tree,{allowGenerated=false}={}) {
  if(!tree || tree.files.some(item=>item.type==='directory'?!['plans','tasks'].includes(item.path)
    :item.type!=='file' || !(preparationFile(item.path)||allowGenerated&&['approved-preparation.json','continuity.json'].includes(item.path))))
    fail('INVALID_CURRENT_IMAGE','reviewed Initial source has foreign paths');
  const files=new Map();
  for(const entry of tree.files) if(entry.type==='file'&&preparationFile(entry.path))
    files.set(entry.path,(await readOwnedFile(path.join(root,...entry.path.split('/')))).bytes);
  return files;
}
async function candidateFiles(root) {
  const tree=await captureExecutionTree(root);
  if(!tree || tree.files.some(item=>item.type==='directory'?!['plans','tasks'].includes(item.path)
    :item.type!=='file' || !(preparationFile(item.path)
      || ['approved-preparation.json','continuity.json'].includes(item.path))))
    fail('INVALID_CURRENT_IMAGE','Initial candidate has foreign paths');
  const files=new Map();
  for(const entry of tree.files) if(entry.type==='file')
    files.set(entry.path,(await readOwnedFile(path.join(root,...entry.path.split('/')))).bytes);
  return files;
}
async function readActivated(specPath) {
  const image=await captureCurrentExecution(specPath);
  return {activation:JSON.parse(Buffer.from(image.activationBytes).toString('utf8'))};
}

export async function installCurrentInitial({specPath,preparationRoot,review,checkpoint=null,filesystemContext=null}) {
  const {workspace,context}=await resolveCurrentExecutionContext(specPath,{filesystemContext});
  const initial=await inspectCurrentExecution(specPath);
  if(initial.state!=='NO_EXECUTION' || initial.activationId!==null)
    fail('STALE_BASE','Initial installation requires an absent official execution');
  const root=await fs.realpath(preparationRoot);
  const ownerPresent=await fs.lstat(`${root}.owner.json`).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  const ownSource=ownerPresent?await assertPreparationCandidate(root,specPath,{filesystemContext}):null;
  if(ownSource&&(ownSource.marker.operation!=='PLAN'||ownSource.marker.source!==null))
    fail('STALE_BASE','Initial requires a registered PLAN without predecessor');
  const sourceTree=await captureExecutionTree(root);
  const artifacts=await filesAt(root,sourceTree,{allowGenerated:ownSource!==null});
  if(!same(sourceTree,await captureExecutionTree(root))) fail('STALE_APPROVAL','reviewed source changed during capture');
  const approved=approveInitialPreparation({context,requirementsAuthority:initial.requirementsAuthority,artifacts,review});
  const snapshot=approved.snapshot;
  const prepared=validateCurrentPreparation({context,requirementsAuthority:initial.requirementsAuthority,
    snapshotBytes:approved.bytes,artifacts});
  const baselines=[];
  for(const [index,item] of snapshot.deliveries.entries()) {
    const observed=await observeCurrentDeliveryWork({context,
      delivery:snapshot.normativeProjection.deliveries[index],
      sections:prepared.currentArtifacts.deliveries[index].sections,
      current:{slice:item.slice,baseline:{format:'stnl-current-work-v1',entries:[]}},bundle:null,initial:true});
    baselines.push(observed.manifest);
  }
  const ordinal=Number(snapshot.deliveries.at(-1)?.slice.slice(6));
  const continuity={format:'stnl-delivery-continuity-v2',nextSliceOrdinal:ordinal+1,
    deliveries:snapshot.deliveries.map((item,index)=>({slice:item.slice,deliveryId:item.deliveryId,localRevision:1,
      authoritySha256:item.review.authoritySha256,validation:'unvalidated',evidence:null,
      counters:{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0},
      baseline:baselines[index],normalization:null,lastDiagnostic:null})),completed:[]};
  const candidate=ownSource?.root??(await preparePreparationCandidate({specPath,operation:'PLAN',filesystemContext})).candidateExecutionRoot;
  const owned=ownSource??await assertPreparationCandidate(candidate,specPath,{filesystemContext});
  const generated=new Map([['approved-preparation.json',Buffer.from(approved.bytes)],['continuity.json',text(continuity)]]);
  try {
    // A pre-publisher interruption may leave only these deterministic files on
    // the registered PLAN. Reuse exact bytes; foreign/stale files never grant authority.
    const existing=new Set();
    for(const [name,bytes] of generated) {
      const file=path.join(candidate,name);
      const present=await fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
      if(present){const held=await readOwnedFile(file);if(!held.bytes.equals(bytes))fail('STALE_APPROVAL','Initial generated bytes differ from the exact reviewed preparation');existing.add(name);}
    }
    for(const [name,bytes] of [...artifacts,...generated]) {
      if(ownSource&&preparationFile(name)||existing.has(name))continue;
      const target=path.join(candidate,...name.split('/'));
      await fs.mkdir(path.dirname(target),{recursive:true});
      await writeNew(target,bytes,0o644);
    }
  }catch(error){error.candidateRoot=candidate;error.publication='not-started';throw error;}
  const expected=await candidateFiles(candidate);
  validateCurrentCandidate({files:expected});
  if(!same(prepared.snapshot,snapshot)) fail('STALE_APPROVAL','Initial reviewed authority changed');
  const assertProduct=async()=>{
    for(const [index,item] of snapshot.deliveries.entries()) {
      const current=await observeCurrentDeliveryWork({context,
        delivery:snapshot.normativeProjection.deliveries[index],
        sections:prepared.currentArtifacts.deliveries[index].sections,
        current:{slice:item.slice,baseline:baselines[index]},bundle:null,initial:true});
      if(!same(current.manifest,baselines[index])) fail('EVIDENCE_STALE','Initial product changed before installation');
    }
  };
  const currentWorkspace=executionWorkspaceFromContext(context,workspace);
  const sourceStillApproved=async()=>{
    const now=await captureExecutionTree(root);
    // Generated approval files are separate from the exact reviewed authored projection.
    const authored=ownSource&&now?{...now,files:now.files.filter(item=>!['approved-preparation.json','continuity.json'].includes(item.path))}:now;
    const reviewed=ownSource?{...sourceTree,files:sourceTree.files.filter(item=>!['approved-preparation.json','continuity.json'].includes(item.path))}:sourceTree;
    return same(authored,reviewed);
  };
  const result=await publishExecutionUpdate({workspace:currentWorkspace,candidateExecutionRoot:candidate,
    expectedTree:null,expectedActivationId:null,currentInitial:true,preparationRecord:owned.marker,checkpoint,
    readActivated:()=>readActivated(specPath),
    authorizeDiff:async()=>{
      const now=await inspectCurrentExecution(specPath);
      if(now.state!=='NO_EXECUTION' || now.requirementsAuthority!==initial.requirementsAuthority
        || !await sourceStillApproved())
        fail('STALE_APPROVAL','reviewed source, requirements or absent target changed');
      await assertProduct();
    },
    validateCandidate:async stage=>{
      const files=await candidateFiles(stage);
      if(files.size!==expected.size || [...expected].some(([name,bytes])=>!files.get(name)?.equals(bytes)))
        fail('EVIDENCE_STALE','Initial staged bytes differ from approved preparation');
      validateCurrentCandidate({files});
      const now=await inspectCurrentExecution(specPath);
      if(now.state!=='NO_EXECUTION' || now.requirementsAuthority!==initial.requirementsAuthority)
        fail('REQUIREMENTS_CHANGED','Initial authority changed before installation');
      return validateCurrentPreparation({context,requirementsAuthority:initial.requirementsAuthority,
        snapshotBytes:files.get('approved-preparation.json'),
        artifacts:new Map([...files].filter(([name])=>preparationFile(name)))}).authority;
    }});
  return {...result,candidateRoot:candidate,reviewedSourceRoot:root,
    preparationDisposition:result.cleanup==='complete'?'retired':'pending',
    approvedSnapshotSha256:approved.sha256};
}

export async function recoverCurrentInitialPublication({specPath,allocation,checkpoint=null,filesystemContext=null}) {
  const {workspace}=await resolveCurrentExecutionContext(specPath,{filesystemContext});
  return recoverCurrentReplacementPublication({workspace,marker:allocation,registeredPreparation:true,checkpoint,
    readActivated:()=>readActivated(specPath),validateInstalledActivation:validateCurrentActivation});
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href) {
  const args=process.argv.slice(2);
  if(args.length===4 && args[0]==='--spec-path' && args[2]==='--recover-allocation') {
    process.stdout.write(JSON.stringify(await recoverCurrentInitialPublication({specPath:args[1],allocation:args[3]}))+'\n');
  } else {
  if(args.length!==6 || args[0]!=='--spec-path' || args[2]!=='--preparation-root'
    || args[4]!=='--review-file') throw new Error('usage: install-current-initial.mjs --spec-path SPEC --preparation-root DIR --review-file JSON | --spec-path SPEC --recover-allocation MARKER');
  const review=JSON.parse(await fs.readFile(args[5],'utf8'));
  process.stdout.write(JSON.stringify(await installCurrentInitial({specPath:args[1],preparationRoot:args[3],review}))+'\n');
  }
}
