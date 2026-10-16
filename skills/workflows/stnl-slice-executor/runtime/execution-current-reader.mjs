#!/usr/bin/env node

import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {resolveCurrentExecutionContext,projectCurrentRequirements} from './execution-state.mjs';
import {readOwnedFile} from './execution-publication.mjs';
import {parseCurrentJson,validateCurrentActivation,validateCurrentImage,resolveLogicalProductClaim} from './execution-current.mjs';
import {validateCurrentPreparation} from './execution-preparation-current.mjs';
import {inspectCurrentEvidence,inspectPostConversionEvidence,validateCurrentEvidenceCarriers,
  completedEvidenceContext} from './current-evidence-state.mjs';
import {restoreCaptureSources} from './execution-evidence-proof.mjs';

const ordinal=(a,b)=>a<b?-1:a>b?1:0;
const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fail(code,reason,kind='integrity',artifact=null,field=null) {
  const error=new Error(reason); error.code=code;
  error.diagnostics=[{kind,artifact,field,reason}]; throw error;
}
async function safeRead(file) {
  try {return await readOwnedFile(file);}
  catch (error) {
    if (error?.code==='EXECUTION_PUBLICATION_BLOCKED' || ['ELOOP','EMLINK'].includes(error?.code))
      fail('UNSAFE_PATH',`${file}: unsafe or unstable physical file`,'integrity',file);
    throw error;
  }
}
async function statOrNull(file) {
  try { return await fs.lstat(file); }
  catch (error) {if (['ENOENT','ENOTDIR'].includes(error?.code)) return null; throw error;}
}
function identity(metadata) {
  return {dev:String(metadata.dev),ino:String(metadata.ino),mode:metadata.mode & 0o777,
    size:metadata.size,mtimeMs:metadata.mtimeMs,ctimeMs:metadata.ctimeMs};
}
async function realDirectory(file,label) {
  const metadata=await statOrNull(file);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) fail('UNSAFE_PATH',`${label}: real directory required`,'integrity',file,label);
  return identity(metadata);
}
async function directoryNames(file,label) {
  const before=await realDirectory(file,label);
  const names=(await fs.readdir(file)).sort(ordinal);
  const after=await realDirectory(file,label);
  if (!equal(before,after)) fail('STALE_BASE',`${label}: directory changed during inventory`,'integrity',file,label);
  return names;
}
async function physicalBoundaries(context) {
  const roots=new Set([context.productRoot]);
  for(const endpoint of [context.logicalAuthorityPath,context.logicalExecutionRoot]) {
    let parent=path.dirname(endpoint);
    while(parent!==context.productRoot) {
      if(!parent.startsWith(context.productRoot+path.sep)) fail('UNSAFE_PATH','physical boundary escapes productRoot');
      roots.add(parent);parent=path.dirname(parent);
    }
  }
  const captured=[];
  for(const root of [...roots].sort(ordinal)) {
    const value=await realDirectory(root,'physical boundary');
    captured.push([root,{dev:value.dev,ino:value.ino,mode:value.mode}]);
  }
  return captured;
}
async function capturedDocuments(workspace) {
  const entries=new Map(), signatures=new Map();
  const add=async file=>{
    const captured=await safeRead(file);
    entries.set(file,captured.bytes);
    signatures.set(file,{identity:captured.identity,sha256:digest(captured.bytes),mode:captured.mode});
  };
  await add(workspace.authorityPath);
  let sharedNames=[],sharedIdentity=null;
  const status=workspace.kind==='lifecycle'
    ?projectCurrentRequirements({workspace,files:entries}).documentStatus:null;
  if (workspace.kind==='lifecycle' && status!=='closed') {
    const shared=path.join(workspace.specRoot,'shared');
    const directory=await statOrNull(shared);
    if (directory!==null) {
      if (!directory.isDirectory() || directory.isSymbolicLink()) fail('UNSAFE_PATH','shared is not a real directory','integrity',shared);
      sharedIdentity=identity(directory);
      const listed=await fs.readdir(shared,{withFileTypes:true});
      if (listed.some(item=>item.isSymbolicLink() || !item.isFile() || !item.name.endsWith('.md')))
        fail('INVALID_CURRENT_IMAGE','shared has a foreign entry','integrity',shared);
      sharedNames=listed.map(item=>item.name).sort(ordinal);
      for (const name of sharedNames) await add(path.join(shared,name));
      if (!equal(sharedIdentity,await realDirectory(shared,'shared')))
        fail('REQUIREMENTS_CHANGED','shared documentary directory changed during capture','integrity',shared);
    }
  }
  return {entries,signatures,sharedNames,sharedIdentity};
}
async function compareDocuments(workspace,before) {
  const after=await capturedDocuments(workspace);
  if (!equal(before.sharedNames,after.sharedNames) || !equal(before.sharedIdentity,after.sharedIdentity)
    || before.entries.size!==after.entries.size)
    fail('REQUIREMENTS_CHANGED','documentary inventory changed during inspection','integrity',workspace.authorityPath);
  for (const [file,bytes] of before.entries) {
    const current=after.entries.get(file);
    if (!current?.equals(bytes) || !equal(before.signatures.get(file),after.signatures.get(file)))
      fail('REQUIREMENTS_CHANGED',`document changed during inspection: ${file}`,'integrity',file);
  }
}
function activationFormat(bytes) {
  let value;
  try { value=parseCurrentJson(bytes.toString('utf8')); }
  catch { fail('INVALID_CURRENT_IMAGE','activation JSON is invalid','integrity','activation.json'); }
  if (!value || typeof value!=='object' || !Object.hasOwn(value,'format'))
    fail('CURRENT_FORMAT_REQUIRED','activation discriminator is absent','integrity','activation.json');
  if (value.format==='stnl-execution-activation-v1')
    fail('MIGRATION_REQUIRED','legacy activation requires explicit conversion','integrity','activation.json');
  if (value.format!=='stnl-execution-activation-v2')
    fail('UNSUPPORTED_FORMAT','unknown activation format','integrity','activation.json');
  return validateCurrentActivation(value);
}
async function capturedImage(root,activation) {
  const names=activation.artifacts.map(item=>item.path);
  const expectedRoot=new Set(['activation.json','approved-preparation.json','continuity.json','plan.md','tasks.md','plans','tasks']);
  if (names.some(name=>name.startsWith('evidence/'))) expectedRoot.add('evidence');
  const actualRoot=await directoryNames(root,'execution root');
  if (!equal(actualRoot,[...expectedRoot].sort(ordinal)))
    fail('INVALID_CURRENT_IMAGE','official execution root has missing or foreign entries','integrity',root,'layout');
  const groups=new Map([['plans',new Set()],['tasks',new Set()],['evidence',new Set()]]);
  const directories=new Map();
  for (const name of names) {
    const [group,child]=name.split('/');
    if (child) groups.get(group)?.add(child);
  }
  for (const [group,children] of groups) {
    if (!expectedRoot.has(group)) continue;
    directories.set(group,await realDirectory(path.join(root,group),group));
    const actual=await directoryNames(path.join(root,group),group);
    if (!equal(actual,[...children].sort(ordinal)))
      fail('INVALID_CURRENT_IMAGE',`${group}: missing or foreign artifact`,'integrity',group,'layout');
  }
  const files=new Map(),signatures=new Map();
  for (const item of activation.artifacts) {
    const file=path.join(root,...item.path.split('/'));
    const current=await safeRead(file);
    if (digest(current.bytes)!==item.sha256)
      fail('INVALID_CURRENT_IMAGE',`${item.path}: raw artifact hash differs`,'integrity',item.path,'sha256');
    files.set(item.path,current.bytes);
    signatures.set(item.path,{identity:current.identity,mode:current.mode,sha256:item.sha256});
  }
  return {files,signatures,directories};
}
async function compareImage(root,activation,before) {
  let after;
  try {after=await capturedImage(root,activation);}
  catch (error) {
    if (['INVALID_CURRENT_IMAGE','UNSAFE_PATH'].includes(error?.code))
      fail('STALE_BASE','official artifacts changed between image observations','integrity',root,'artifacts');
    throw error;
  }
  for (const [name,bytes] of before.files) if (!after.files.get(name)?.equals(bytes)
    || !equal(before.signatures.get(name),after.signatures.get(name)))
    fail('STALE_BASE',`${name}: artifact changed during inspection`,'integrity',name);
  if (!equal([...before.directories],[...after.directories]))
    fail('STALE_BASE','artifact directory changed during inspection','integrity',root);
}
function claimPaths(body,context,artifact,typedKind=false) {
  if (/^\s*[-*+]\s+none\s*$/u.test(body.trim())) return [];
  return body.replaceAll('\r\n','\n').trim().split('\n').map(line=>{
    const match=/^\s*[-*+]\s+(?:(file|directory)\s*:\s*)?(.+?)\s*$/u.exec(line);
    if (!match || Boolean(match[1])!==typedKind) fail('INVALID_CURRENT_IMAGE',`${artifact}: invalid product claim`,'carrier-syntax',artifact);
    let value=match[2].trim();
    if (/^`[^`]*`$/u.test(value)) value=value.slice(1,-1);
    const absolute=resolveLogicalProductClaim(context,artifact,value);
    return {path:path.relative(context.productRoot,absolute).split(path.sep).join('/'),kind:match[1]??null};
  });
}
function observationRoots(context,delivery,taskSections,continuity,bundle) {
  const artifact=`tasks/${continuity.slice}.md`;
  const targets=[...claimPaths(delivery.authorizedAreas,context,artifact,true),
    ...claimPaths(delivery.existingInputs,context,artifact),
    ...claimPaths(taskSections['Expected Files'],context,artifact)];
  for (const check of delivery.verificationRecipe.checks) {
    for (const reference of [check.executable,...check.args].filter(item=>item?.file).map(item=>item.file).concat(check.inputs)) {
      const absolute=resolveLogicalProductClaim(context,artifact,reference.path);
      targets.push({path:path.relative(context.productRoot,absolute).split(path.sep).join('/'),kind:null});
    }
  }
  // Retained bytes cannot enlarge filesystem authority, even before the pure
  // proof verifier runs. Ancestor entries are closure, never extra claims.
  const permitted=name=>targets.some(item=>item.path===name || item.path.startsWith(`${name}/`)
    || item.kind==='directory' && name.startsWith(`${item.path}/`));
  const retained=[];
  for (const entry of continuity.baseline.entries) retained.push({path:entry.path,kind:null});
  if (bundle) for (const record of [bundle.implementation.at(-1),bundle.findingsChecks.at(-1),bundle.validation].filter(Boolean))
    if (record.testedWork) for (const entry of record.testedWork.entries) retained.push({path:entry.path,kind:null});
  for (const item of retained) if (!permitted(item.path))
    fail('UNSAFE_PATH','retained product path is outside the approved observation domain','integrity',artifact,item.path);
  return [...targets,...retained];
}
function scopedObservation(observation,targets) {
  const within=name=>targets.some(target=>target.path===name
    || target.kind==='directory' && name.startsWith(`${target.path}/`));
  return {...observation,
    manifest:{format:'stnl-current-work-v1',entries:observation.manifest.entries.filter(entry=>within(entry.path))},
    identities:new Map([...observation.identities].filter(([name])=>within(name)))};
}
async function observeProduct(context,targets,limits,allowUnrelatedChildren=false) {
  const entries=new Map(),identities=new Map(),visiting=new Set();
  const root=context.productRoot;
  const control=context.logicalExecutionRoot;
  const rootIdentity=await realDirectory(root,'product root');
  const permitted=relative=>targets.some(item=>item.path===relative || item.path.startsWith(`${relative}/`)
    || item.kind==='directory' && relative.startsWith(`${item.path}/`));
  const visit=async relative=>{
    if (!relative || relative==='.' || relative.startsWith('../') || path.isAbsolute(relative))
      fail('UNSAFE_PATH','product target is outside productRoot','integrity',relative);
    if (entries.has(relative)) return;
    if (!permitted(relative))
      fail('UNSAFE_PATH','directory child is outside the approved observation domain','integrity',relative);
    if (visiting.has(relative)) fail('INVALID_CURRENT_IMAGE','product directory cycle','integrity',relative);
    const absolute=path.join(root,...relative.split('/'));
    if (absolute===control || absolute===context.logicalAuthorityPath)
      fail('UNSUPPORTED_FORMAT','approved product domain overlaps execution controls','integrity',relative);
    const metadata=await statOrNull(absolute);
    if (metadata===null) {
      limits.entries+=1;
      if (limits.entries>10000) fail('UNSUPPORTED_FORMAT','bounded product inventory exceeded','integrity',relative);
      entries.set(relative,{path:relative,kind:'absent'});return;
    }
    if (metadata.isSymbolicLink()) fail('UNSAFE_PATH','product symlink is not readable','integrity',relative);
    if (metadata.isFile()) {
      const captured=await safeRead(absolute);
      limits.bytes+=captured.bytes.length; limits.entries+=1;
      if (limits.bytes>128*1024*1024 || limits.entries>10000) fail('UNSUPPORTED_FORMAT','bounded product observation exceeded','integrity',relative);
      entries.set(relative,{path:relative,kind:'file',sha256:digest(captured.bytes),mode:captured.mode});
      identities.set(relative,captured.identity);
    } else if (metadata.isDirectory()) {
      visiting.add(relative);
      const children=await directoryNames(absolute,relative);
      if (children.length>10000) fail('UNSUPPORTED_FORMAT','bounded directory inventory exceeded','integrity',relative);
      const within=allowUnrelatedChildren?children.filter(child=>permitted(`${relative}/${child}`)):children;
      entries.set(relative,{path:relative,kind:'directory',children:within});
      identities.set(relative,identity(metadata));
      limits.entries+=1;
      if (limits.entries>10000) fail('UNSUPPORTED_FORMAT','bounded product inventory exceeded','integrity',relative);
      for (const child of within) await visit(`${relative}/${child}`);
      if (!equal(identity(metadata),await realDirectory(absolute,relative)))
        fail('EVIDENCE_STALE',`${relative}: directory changed while reading children`,'integrity',relative);
      visiting.delete(relative);
    } else fail('UNSAFE_PATH','product entry is neither file nor directory','integrity',relative);
  };
  for (const item of targets) {
    const segments=item.path.split('/');
    for (let i=1;i<=segments.length;i+=1) {
      const relative=segments.slice(0,i).join('/');await visit(relative);
      if(i<segments.length && entries.get(relative)?.kind!=='directory') break;
    }
    if (item.kind && entries.get(item.path)?.kind!==item.kind && entries.get(item.path)?.kind!=='absent')
      fail('EVIDENCE_STALE',`${item.path}: approved kind differs from product`,'integrity',item.path,'kind');
  }
  if (!equal(rootIdentity,await realDirectory(root,'product root')))
    fail('EVIDENCE_STALE','product root changed during observation','integrity',root);
  return {manifest:{format:'stnl-current-work-v1',entries:[...entries.values()].sort((a,b)=>ordinal(a.path,b.path))},identities,rootIdentity};
}
function authorityFor(snapshot,delivery) {
  const leaf=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===delivery.deliveryId);
  if (!leaf) fail('INVALID_CURRENT_IMAGE','approved delivery leaf is absent','integrity',delivery.slice);
  const global=snapshot.normativeProjection.global;
  return {preparationRevision:snapshot.preparationRevision,localRevision:delivery.localRevision,
    normativeSha256:snapshot.preparationRevision===1?snapshot.normativeSha256:delivery.authoritySha256,delivery:leaf,
    context:{requirementsAuthority:snapshot.requirementsAuthority,objective:global.objective,strategy:global.strategy,risks:global.risks}};
}
function retainedLocalAuthority(snapshot,current,record,leaf) {
  if(!leaf || !record || !record.contract || record.contract.terminal!==null
    || record.origin?.deliveryId!==current.deliveryId
    || record.origin?.slice!==current.slice || record.origin?.localRevision!==current.localRevision)
    fail('EVIDENCE_INCOMPLETE',`${current.slice}: retained local proof is absent or inconsistent`,
      'evidence','continuity.json',current.slice);
  return {preparationRevision:record.origin.preparationRevision,
    localRevision:record.origin.localRevision,normativeSha256:record.origin.normativeSha256,
    delivery:record.contract.delivery,context:record.contract.context};
}
const retainedRecords=bundle=>[...bundle.implementation,...bundle.findingsChecks,...bundle.support,
  ...(bundle.validation?[bundle.validation]:[])].filter(item=>item.kind!=='rejection');
const retainedWitnesses=item=>{
  const authority=item.retainedAuthority??item.identityAuthority;
  const rejection=item.facts.rejection?item.facts.bundle.support.findLast(record=>record.kind==='rejection'):null;
  return [...retainedRecords(item.facts.bundle),...(rejection&&authority?[{...rejection,
    contract:{delivery:authority.delivery,context:authority.context}}]:[])];
};
function historicalOrigin(record,bundle) {
  const operation=record.origin.operation;
  const key=[record.contract.context.requirementsAuthority,record.origin.preparationRevision,record.origin.normativeSha256];
  if(record.origin.transport!=='native'||record.recordFormat==='stnl-task-record-v1-imported')return {key:JSON.stringify(key),artifacts:[]};
  const profile=operation==='EXECUTE_SLICE'?'initial-implementation':operation==='APPLY_FINDINGS'?'current-findings':'current-validation';
  const captured=restoreCaptureSources(profile,record,new Map(bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')])));
  const origin=parseCurrentJson(Buffer.from(captured.origin).toString('utf8'));
  const base=origin.admission?.baseActivation;
  return base?{key:JSON.stringify([record.contract.context.requirementsAuthority,base.preparationRevision,
    base.approvedSnapshotSha256]),artifacts:base.artifacts}:{key:JSON.stringify(key),artifacts:[]};
}
function validateRetainedOwnership(snapshot,continuity,items) {
  const members=[...continuity.deliveries,...continuity.completed];
  const bySlice=new Map(members.map(item=>[item.slice,item.deliveryId])),ids=new Set(members.map(item=>item.deliveryId));
  const historical=new Map();
  const reviewed=new Map(snapshot.reviewedArtifacts.map(item=>[item.path,item.sha256]));
  for(const item of items) if(item.retainedAuthority||item.identityAuthority) for(const record of retainedWitnesses(item)) {
    const {key,artifacts}=historicalOrigin(record,item.facts.bundle),map=historical.get(key)??new Map();
    const bind=(selector,id)=>{
      const previous=map.get(selector);
      if(previous!==undefined&&previous!==id)map.set(selector,null);else if(!map.has(selector))map.set(selector,id);
    };
    bind(record.origin.slice,record.origin.deliveryId);
    // The current selector map is insufficient historical evidence. A carrier
    // can supply a binding only when its literal reviewed bytes are hash-bound
    // by this already verified original admission witness.
    for(const member of snapshot.deliveries) if(['plans','tasks'].every(group=>{
      const name=`${group}/${member.slice}.md`,hash=reviewed.get(name);
      return hash!==undefined&&artifacts.some(value=>value.path===name&&value.sha256===hash);
    }))bind(member.slice,member.deliveryId);
    historical.set(key,map);
  }
  const resolve=reference=>reference.startsWith('delivery:')?reference.slice(9):bySlice.get(reference);
  for(const item of items) {
    if(!item.retainedAuthority)continue;
    const current=members.find(value=>value.deliveryId===item.deliveryId);
    const leaf=[...snapshot.normativeProjection.deliveries,...snapshot.normativeProjection.completed]
      .find(value=>value.deliveryId===item.deliveryId),old=item.retainedAuthority.delivery;
    const global=snapshot.normativeProjection.global,expectedContext={requirementsAuthority:snapshot.requirementsAuthority,
      objective:global.objective,strategy:global.strategy,risks:global.risks};
    if(Object.entries(expectedContext).some(([key,value])=>item.retainedAuthority.context[key]!==value))
      fail('EVIDENCE_STALE',`${item.slice}: context changed since the verified local proof`,'evidence',item.slice,'context');
    const decision=snapshot.globalReview.evidenceDecisions.find(value=>value.deliveryId===item.deliveryId)
      ??snapshot.deliveries.find(value=>value.deliveryId===item.deliveryId)?.review.evidenceDecisions.find(value=>value.deliveryId===item.deliveryId);
    const reviewedHistorical=item.facts.consumption?.kind==='historical-local-review'
      &&decision?.disposition==='revalidate'&&current.validation==='revalidation-required';
    const strip=value=>({...value,obligations:value.obligations.map(({fullOwner,...rest})=>rest)});
    if(!isDeepStrictEqual(strip(old),strip(leaf))&&!reviewedHistorical)
      fail('EVIDENCE_STALE',`${item.slice}: normative contract changed; Q19 revalidation is required`,'evidence',item.slice,'ownership');
    const record=retainedWitnesses(item).findLast(value=>isDeepStrictEqual(value.contract.delivery,old));
    const bindings=record?historical.get(historicalOrigin(record,item.facts.bundle).key):null;
    for(let n=0;n<old.obligations.length;n++) {
      const prior=old.obligations[n].fullOwner,next=leaf.obligations[n].fullOwner;
      const target=resolve(next);
      if(!ids.has(target))fail('INVALID_CURRENT_IMAGE',`${item.slice}: owner is not a current member`);
      const proven=prior.startsWith('delivery:')?prior.slice(9):bindings?.get(prior);
      if(!proven||proven!==target)
        fail('EVIDENCE_STALE',`${item.slice}: historical owner binding is absent or reassociated; Q19 revalidation is required`,
          'evidence',item.slice,'ownership');
    }
    if(decision?.disposition==='revalidate'&&current.validation==='current')
      fail('EVIDENCE_STALE',`${item.slice}: reviewed revalidation is still required`,'evidence',item.slice,'validation');
  }
}
function retainedAnchor(bundle) {
  return bundle.validation??bundle.findingsChecks.at(-1)??bundle.implementation.at(-1)
    ??bundle.support.findLast(item=>item.kind!=='rejection');
}
function originalProfile(bundle) {
  const record=bundle.validation??bundle.findingsChecks.at(-1)??bundle.support.findLast(item=>item.kind==='rejection');
  if(!record)return 'initial';
  if(record.recordFormat==='stnl-task-record-v1-imported')return 'post';
  const operation=record.origin.operation;
  if(operation==='EXECUTE_SLICE')return 'initial';
  const capture=restoreCaptureSources(operation==='APPLY_FINDINGS'?'current-findings':'current-validation',record,
    new Map(bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')])));
  const request=parseCurrentJson(Buffer.from(capture[operation==='APPLY_FINDINGS'?'applyRequest':'validationRequest']).toString('utf8'));
  return ['stnl-current-validation-request-v3','stnl-current-validation-request-v4',
    'stnl-current-findings-request-v2','stnl-current-findings-request-v3'].includes(request.format)?'post':'initial';
}
function retainedPostRead(bundle) {
  const record=bundle.support.findLast(item=>item.kind==='rejection')??bundle.validation??bundle.findingsChecks.at(-1);
  if(record?.recordFormat==='stnl-task-record-v1-imported')return null;
  const operation=record.origin.operation;
  const captured=restoreCaptureSources(operation==='APPLY_FINDINGS'?'current-findings':'current-validation',record,
    new Map(bundle.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')])));
  const request=parseCurrentJson(Buffer.from(captured[operation==='APPLY_FINDINGS'?'applyRequest':'validationRequest']).toString('utf8'));
  return {authority:request.authority,snapshotDigest:request.base.approvedSnapshotSha256};
}
function validateInitialNormalization(current,facts) {
  const refusal=facts.rejection&&(facts.rejection.origin.operation==='EXECUTE_SLICE'
    || facts.rejection.origin.operation==='APPLY_FINDINGS'&&facts.rejection.consumedInvocations===1)?facts.rejection:null;
  if(refusal) {
    const normalization={episodeId:refusal.operationAttemptId,operation:refusal.origin.operation,
      causeSha256:current.evidence?.sha256,sourceOperationAttemptId:refusal.operationAttemptId,
      used:1,consumedInvocations:refusal.consumedInvocations,round:1,status:'exhausted'};
    const diagnostic={code:'RUNNER_RESULT_REJECTED',operationAttemptId:refusal.operationAttemptId,
      reason:refusal.diagnostic,affectedPaths:refusal.origin.operation==='APPLY_FINDINGS'?facts.cycle?.lastScope??[]:[],nextAction:'stop'};
    const sameObject=(actual,expected)=>actual!==null&&Object.keys(actual).length===Object.keys(expected).length
      &&Object.entries(expected).every(([name,value])=>equal(actual[name],value));
    if(!sameObject(current.normalization,normalization)||!sameObject(current.lastDiagnostic,diagnostic))
      fail('INVALID_CURRENT_IMAGE',`${current.slice}: Initial normalization/diagnostic differs`);
  } else if(['EXECUTE_SLICE','APPLY_FINDINGS'].includes(current.normalization?.operation))
    fail('INVALID_CURRENT_IMAGE',`${current.slice}: normalization lacks its concluded refusal`);
}
function verifyLastAttempt(activation,deliveries) {
  const last=activation.lastAttempt;
  if (last===null) return;
  if (activation.previousActivationId===null)
    fail('INVALID_CURRENT_IMAGE','first activation cannot contain an incorporated lastAttempt','integrity','activation.json','lastAttempt');
  if (last.outcome==='aborted') fail('UNSUPPORTED_FORMAT','aborted lastAttempt is outside quiet profile','integrity','activation.json','lastAttempt');
  const terminalId=activation.activeAttempt?.originActivationId??activation.activationId;
  if (last.terminalActivationId!==terminalId)
    fail('INVALID_CURRENT_IMAGE','lastAttempt terminal activation differs','integrity','activation.json','lastAttempt');
  const delivery=deliveries.find(item=>item.deliveryId===last.deliveryId && item.slice===last.slice);
  const facts=delivery?.facts,bundle=facts?.bundle;
  const matched=facts?.rejection ?? (activation.activeAttempt?.operation==='APPLY_FINDINGS'
    ?bundle?.validation
    :facts?.cycle && bundle?.validation?.id===facts.cycle.admissionId
      ?bundle.findingsChecks.at(-1):bundle?.validation??bundle?.findingsChecks.at(-1)??bundle?.implementation.at(-1));
  // During publication, the active owner's installed candidate can supersede
  // the prior validation record before the new terminal activation is written.
  // A1 still verifies the prior lastAttempt below; only an installed record
  // bound to this exact active owner permits the temporary supersession.
  if(activation.activeAttempt!==null && matched?.origin?.operationAttemptId!==last.operationAttemptId
    && bundle?.validation?.origin?.operationAttemptId===activation.activeAttempt.operationAttemptId
    && bundle.validation.origin.deliveryId===activation.activeAttempt.deliveryId
    && bundle.validation.origin.slice===activation.activeAttempt.slice) return;
  if(activation.activeAttempt!==null && facts?.rejection?.origin?.operationAttemptId
    ===activation.activeAttempt.operationAttemptId
    && bundle?.support?.filter(item=>item.kind==='rejection'
      && item.origin.operation==='VALIDATE_SLICE').at(-2)?.origin.operationAttemptId
      ===last.operationAttemptId && last.outcome==='rejected') return;
  if(activation.activeAttempt?.operation==='APPLY_FINDINGS'
    && facts?.rejection?.origin.operationAttemptId===activation.activeAttempt.operationAttemptId
    && bundle?.support?.filter(item=>item.kind==='rejection'
      && item.origin.operation==='APPLY_FINDINGS').at(-2)?.origin.operationAttemptId
      ===last.operationAttemptId && last.outcome==='rejected') return;
  if(activation.activeAttempt!==null && facts?.rejection?.origin?.operationAttemptId
    ===activation.activeAttempt.operationAttemptId && last.outcome==='recorded'
    && (bundle?.validation?.origin.operationAttemptId===last.operationAttemptId
      || bundle?.findingsChecks?.at(-1)?.origin.operationAttemptId===last.operationAttemptId)) return;
  if(activation.activeAttempt?.operation==='APPLY_FINDINGS' && last.outcome==='rejected'
    && bundle?.support?.some(item=>item.kind==='rejection'
      && item.origin.operation==='APPLY_FINDINGS'
      && item.origin.operationAttemptId===last.operationAttemptId)
    && bundle?.findingsChecks?.at(-1)?.origin.operationAttemptId
      ===activation.activeAttempt.operationAttemptId) return;
  if (!matched || matched.origin?.operationAttemptId!==last.operationAttemptId
    || matched.origin?.operation!==last.operation || matched.origin?.deliveryId!==last.deliveryId
    || matched.origin?.slice!==last.slice
    || last.outcome!==(facts?.rejection?'rejected':'recorded'))
    fail('EVIDENCE_INCOMPLETE','lastAttempt incorporation is not retained','integrity','activation.json','lastAttempt');
}

export async function observeCurrentDeliveryWork({context,delivery,sections,current,bundle}) {
  const targets=observationRoots(context,delivery,sections,current,bundle);
  return scopedObservation(await observeProduct(context,targets,{entries:0,bytes:0},true),targets);
}

async function readCurrentExecution(specPath,withCapture=false,expectedOwner=null) {
  const {workspace,context}=await resolveCurrentExecutionContext(specPath);
  const boundaries=await physicalBoundaries(context);
  const documents=await capturedDocuments(workspace);
  const projected=projectCurrentRequirements({workspace,files:documents.entries});
  const root=workspace.executionRoot;
  const rootBefore=await statOrNull(root);
  if (rootBefore===null) {
    if(withCapture) fail('CURRENT_FORMAT_REQUIRED','offline capture requires an official current image');
    await compareDocuments(workspace,documents);
    if (await statOrNull(root)!==null || !equal(boundaries,await physicalBoundaries(context)))
      fail('STALE_BASE','official root appeared or physical boundary changed during absence inspection');
    return {activationId:null,sequence:null,requirementsAuthority:projected.requirementsAuthority,
      preparationRevision:null,deliveries:[],completed:[],
      state:projected.documentStatus==='closed'?'SPEC_CLOSED':'NO_EXECUTION',normalHandoff:null,diagnostics:[]};
  }
  await realDirectory(root,'execution root');
  const activationFile=path.join(root,'activation.json');
  const activationA=await statOrNull(activationFile);
  if (activationA===null) fail('CURRENT_FORMAT_REQUIRED','execution exists without activation','integrity','activation.json');
  const a=await safeRead(activationFile);
  const activation=activationFormat(a.bytes);
  if (activation.activeAttempt!==null && (expectedOwner===null
    || !equal(activation.activeAttempt,expectedOwner)))
    fail('OWNER_UNCERTAIN','activeAttempt declares an unresolved or different owner','integrity','activation.json','activeAttempt');
  if (expectedOwner!==null && activation.activeAttempt===null)
    fail('OWNER_MISMATCH','expected active owner is absent','integrity','activation.json','activeAttempt');
  const image=await capturedImage(root,activation);
  for(const [name,legacy] of [['approved-preparation.json','stnl-preparation-v2'],['continuity.json','stnl-delivery-continuity-v1']])
    if(parseCurrentJson(image.files.get(name).toString('utf8'))?.format===legacy)
      fail('INVALID_CURRENT_IMAGE','mixed EC-1 activation and legacy artifact','integrity',name,'format');
  const checked=validateCurrentImage({activationBytes:a.bytes,files:image.files});
  const continuity=checked.continuity;
  const snapshot=parseCurrentJson(image.files.get('approved-preparation.json').toString('utf8'));
  const {retainedEvidence,fresh}=await completedEvidenceContext({context,
    snapshotBytes:image.files.get('approved-preparation.json'),continuity,files:image.files});
  const converted=activation.preparationRevision>1;
  for (const [unsupported,artifact,field] of [
    [!converted && activation.preparationRevision!==1,'activation.json','preparationRevision'],
    [continuity.completed.length>0 && !converted,'continuity.json','completed'],
    [continuity.deliveries.filter(item=>item.localRevision!==1).length>1
      || continuity.deliveries.some(item=>item.localRevision!==1 && !(converted && item.localRevision===2)),
      'continuity.json','localRevision'],
    [continuity.deliveries.some(item=>item.normalization!==null
      && !(converted && ['VALIDATE_SLICE','APPLY_FINDINGS'].includes(item.normalization.operation)
        && ['settled','exhausted'].includes(item.normalization.status))
      && !(!converted && item.normalization.operation==='EXECUTE_SLICE'
        && item.normalization.status==='exhausted')
      && !(!converted && item.normalization.operation==='APPLY_FINDINGS'
        && item.normalization.status==='exhausted'
        && item.normalization.consumedInvocations===1 && item.normalization.round===1)
      && !(continuity.completed.length && ['EXECUTE_SLICE','APPLY_FINDINGS'].includes(item.normalization.operation)
        && item.normalization.status==='exhausted' && item.normalization.round===1)),
      'continuity.json','normalization'],
    [!converted && [snapshot.globalReview,...snapshot.deliveries.map(item=>item.review)].some(item=>item.evidenceDecisions.length),
      'approved-preparation.json','evidenceDecisions'],
  ]) if (unsupported) fail('UNSUPPORTED_FORMAT',`${field} exceeds initial quiet profile`,'integrity',artifact,field);
  if (projected.requirementsAuthority!==activation.requirementsAuthority)
    fail('REQUIREMENTS_CHANGED','documentary authority differs from activation','authority-mismatch',workspace.authorityPath);
  const prepared=validateCurrentPreparation({context,requirementsAuthority:activation.requirementsAuthority,
    snapshotBytes:image.files.get('approved-preparation.json'),artifacts:new Map([...image.files].filter(([name])=>name.endsWith('.md'))),
    profile:continuity.completed.length?'completed-current':converted?'converted-current':'initial',
    retainedEvidence});
  const outputs=[];
  for (const current of continuity.deliveries) {
    const carrier=prepared.currentArtifacts.deliveries.find(item=>item.deliveryId===current.deliveryId);
    if (!carrier) fail('INVALID_CURRENT_IMAGE','delivery carrier is absent','integrity',current.slice);
    const authority=authorityFor(prepared.snapshot,current);
    const bundleBytes=current.evidence?image.files.get(current.evidence.path):null;
    const bundle=bundleBytes?parseCurrentJson(bundleBytes.toString('utf8')):null;
    const targets=observationRoots(context,authority.delivery,carrier.sections,current,bundle);
    const before=await observeProduct(context,targets,{entries:0,bytes:0},converted);
    if(converted) {
      outputs.push({slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
        targets,observation:before,carrier});
      continue;
    }
    const facts=inspectCurrentEvidence({context,authority,bundleBytes,counters:current.counters,
      baseline:current.baseline,observedWork:before.manifest});
    const initialRefusal=facts.rejection
      && (facts.rejection.origin.operation==='EXECUTE_SLICE'
        || facts.rejection.origin.operation==='APPLY_FINDINGS'
          && facts.rejection.consumedInvocations===1)?facts.rejection:null;
    if(initialRefusal) {
      const expectedNormalization={episodeId:initialRefusal.operationAttemptId,
        operation:initialRefusal.origin.operation,causeSha256:current.evidence?.sha256,
        sourceOperationAttemptId:initialRefusal.operationAttemptId,used:1,
        consumedInvocations:initialRefusal.consumedInvocations,round:1,status:'exhausted'};
      const expectedDiagnostic={code:'RUNNER_RESULT_REJECTED',
        operationAttemptId:initialRefusal.operationAttemptId,reason:initialRefusal.diagnostic,
        affectedPaths:initialRefusal.origin.operation==='APPLY_FINDINGS'
          ?facts.cycle?.lastScope??[]:[],nextAction:'stop'};
      const exact=(actual,expected)=>actual!==null
        && Object.keys(actual).length===Object.keys(expected).length
        && Object.entries(expected).every(([name,value])=>equal(actual[name],value));
      if(!exact(current.normalization,expectedNormalization)
        || !exact(current.lastDiagnostic,expectedDiagnostic))
        fail('INVALID_CURRENT_IMAGE',`${current.slice}: Initial refusal state differs`,
          'carrier-mismatch','continuity.json',current.slice);
    } else if(['EXECUTE_SLICE','APPLY_FINDINGS'].includes(current.normalization?.operation))
      fail('INVALID_CURRENT_IMAGE',`${current.slice}: Initial normalization lacks a concluded refusal`,
        'carrier-mismatch','continuity.json',current.slice);
    if (current.validation!==facts.persistedValidation)
      fail('INVALID_CURRENT_IMAGE',`${current.slice}: continuity sealed validation differs`,'carrier-mismatch','continuity.json',current.slice);
    validateCurrentEvidenceCarriers({facts,sections:carrier.sections,continuity:carrier.continuity,index:carrier.index,slice:current.slice,
      priorDeliveries:outputs.map(item=>({slice:item.slice,facts:item.facts}))});
    outputs.push({slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
      persistedValidation:facts.persistedValidation,observedValidation:facts.observedValidation,
      auxiliaryStatus:facts.auxiliaryStatus,formalStatus:facts.formalStatus,evidenceSha256:facts.evidenceSha256,
      diagnostics:!facts.observationMatches && !facts.rejection
        ?[{kind:'observation',artifact:current.slice,field:'observedWork',reason:'EVIDENCE_STALE'}]:[],
      facts,targets,observation:before});
  }
  const completedOutputs=[];
  for(const current of continuity.completed) {
    const leaf=snapshot.normativeProjection.completed.find(item=>item.deliveryId===current.deliveryId);
    const bundleBytes=image.files.get(current.evidence.path);
    const bundle=parseCurrentJson(bundleBytes.toString('utf8'));
    const record=bundle.validation;
    const post=originalProfile(bundle)==='post';
    const retainedRead=post?retainedPostRead(bundle):null;
    const authority=retainedRead?.authority??retainedLocalAuthority(snapshot,current,record,leaf);
    const targets=observationRoots(context,leaf,{'Expected Files':'- none'},current,bundle);
    const before=await observeProduct(context,targets,{entries:0,bytes:0},true);
    const facts=post?await inspectPostConversionEvidence({context,snapshotBytes:image.files.get('approved-preparation.json'),
      current,bundleBytes,observedWork:scopedObservation(before,targets).manifest,preparationProfile:'completed-current',
      retainedEvidence,retainedRead})
      :inspectCurrentEvidence({context,authority,bundleBytes,counters:current.counters,
        baseline:current.baseline,observedWork:scopedObservation(before,targets).manifest,
        currentAuthoritySha256:current.authoritySha256});
    if(facts.formalStatus!=='PASS' || facts.persistedValidation!=='current'
      || facts.openFindings.length || facts.openDivergences?.length)
      fail('EVIDENCE_INCOMPLETE',`${current.slice}: completed delivery lacks current local PASS`,
        'evidence',current.evidence.path,'validation');
    if(!facts.observationMatches || facts.observedValidation!=='current')
      fail('EVIDENCE_STALE',`${current.slice}: completed local proof no longer matches product`,
        'evidence',current.evidence.path,'observedWork');
    completedOutputs.push({slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
      persistedValidation:facts.persistedValidation,observedValidation:facts.observedValidation,
      formalStatus:facts.formalStatus,evidenceSha256:facts.evidenceSha256,
      facts,targets,observation:before,retainedAuthority:authority});
  }
  if(converted) {
    const reviewed=new Map(snapshot.reviewedArtifacts.map(item=>[item.path,item.utf8]));
    for(const item of outputs) {
      const current=continuity.deliveries.find(value=>value.deliveryId===item.deliveryId);
      const bundleBytes=current.evidence?image.files.get(current.evidence.path):null;
      const bundle=bundleBytes?parseCurrentJson(bundleBytes.toString('utf8')):null;
      const v3=bundle?.validation?.recordFormat==='stnl-task-record-v2';
      const latestFormalRejection=bundle?.support?.filter(entry=>entry.kind==='rejection'
        && entry.origin.operation==='VALIDATE_SLICE').at(-1);
      const latestAuxiliaryRejection=bundle?.support?.filter(entry=>entry.kind==='rejection'
        && entry.origin.operation==='APPLY_FINDINGS').at(-1);
      const lastAttempt=activation.lastAttempt?.deliveryId===current.deliveryId?activation.lastAttempt:null;
      const admissionRef=lastAttempt?.operation==='APPLY_FINDINGS' && latestFormalRejection
        && latestFormalRejection?.origin.operationAttemptId!==activation.activeAttempt?.operationAttemptId
        ?lastAttempt.operationRef
        :activation.activeAttempt!==null
          && [bundle?.validation?.origin?.operationAttemptId,
            ...(lastAttempt?.operation==='APPLY_FINDINGS'
              ?[bundle?.findingsChecks?.at(-1)?.origin?.operationAttemptId]:[]),
            latestFormalRejection?.origin.operationAttemptId,
            latestAuxiliaryRejection?.origin.operationAttemptId].includes(activation.activeAttempt.operationAttemptId)
          ?activation.activeAttempt.operationRef:lastAttempt?.operationRef??null;
      const observedWork=scopedObservation(item.observation,item.targets).manifest;
      const retained=continuity.completed.length>0 && bundleBytes!==null && !fresh.has(current.deliveryId);
      let retainedFacts=null;
      let retainedAuthority=null;
      let retainedPost=false;
      let identityAuthority=null;
      if(retained) {
        const anchor=retainedAnchor(bundle),leaf=snapshot.normativeProjection.deliveries.find(value=>value.deliveryId===current.deliveryId);
        if(originalProfile(bundle)==='post') {
          retainedPost=true;
          const retainedRead=retainedPostRead(bundle);
          retainedFacts=await inspectPostConversionEvidence({context,snapshotBytes:image.files.get('approved-preparation.json'),
            current,bundleBytes,observedWork,admissionRef,lastAttempt,
            preparationProfile:'completed-current',retainedEvidence,retainedRead});
          retainedAuthority=retainedRead?.authority??null;
        } else {
          const origin=bundle.support.findLast(value=>value.kind==='rejection')?.origin;
          const authority=anchor?retainedLocalAuthority(snapshot,current,anchor,leaf)
            :{...authorityFor(snapshot,current),preparationRevision:origin?.preparationRevision,
              localRevision:origin?.localRevision,normativeSha256:origin?.normativeSha256};
          retainedFacts=inspectCurrentEvidence({context,authority,bundleBytes,
            counters:current.counters,baseline:current.baseline,observedWork,currentAuthoritySha256:current.authoritySha256});
          validateInitialNormalization(current,retainedFacts);retainedAuthority=anchor?authority:null;identityAuthority=authority;
        }
      }
      const facts=retainedFacts
        ?{...retainedFacts,slice:current.slice,requiresFormalRevalidation:retainedFacts.observedValidation!=='current'}
        :continuity.completed.length && bundleBytes===null&&current.validation==='unvalidated'
          &&Object.values(current.counters).every(value=>value===0)&&current.lastDiagnostic===null
        ?{...inspectCurrentEvidence({context,authority:authorityFor(snapshot,current),bundleBytes:null,
          counters:current.counters,baseline:current.baseline,observedWork}),slice:current.slice}
        :await inspectPostConversionEvidence({context,snapshotBytes:image.files.get('approved-preparation.json'),
          current,bundleBytes,observedWork,admissionRef,lastAttempt,
          preparationProfile:continuity.completed.length?'completed-current':'converted-current',retainedEvidence});
      if(!facts || facts.slice!==item.slice || facts.persistedValidation!==continuity.deliveries.find(value=>value.deliveryId===item.deliveryId)?.validation)
        fail('INVALID_CURRENT_IMAGE',`${item.slice}: converted inspection differs`);
      const priorDeliveries=[...completedOutputs,...outputs.slice(0,outputs.indexOf(item))];
      if(retained&&!retainedPost) {
        validateCurrentEvidenceCarriers({facts,sections:item.carrier.sections,
          continuity:item.carrier.continuity,index:item.carrier.index,slice:item.slice,
          priorDeliveries});
      } else if(v3 || facts.rejection) {
        if(item.carrier.continuity.evidence!==current.evidence.sha256)
          fail('INVALID_CURRENT_IMAGE',`${item.slice}: converted evidence carrier digest differs`);
        validateCurrentEvidenceCarriers({facts,sections:item.carrier.sections,
          continuity:{...item.carrier.continuity,evidence:current.evidence.path},
          index:item.carrier.index,slice:item.slice,priorDeliveries});
      }
      else if(!Buffer.from(image.files.get(`tasks/${item.slice}.md`)).equals(Buffer.from(reviewed.get(`tasks/${item.slice}.md`))))
        fail('INVALID_CURRENT_IMAGE',`${item.slice}: converted operational carrier differs from reviewed bytes`);
      item.facts=facts;
      item.retainedAuthority=retainedAuthority;
      item.identityAuthority=identityAuthority;
      item.persistedValidation=facts.persistedValidation;
      item.observedValidation=facts.observedValidation;
      item.evidenceSha256=facts.evidenceSha256;
      item.formalStatus=facts.rejection?.origin.operation==='VALIDATE_SLICE'?null
        :facts.formalStatus??(facts.cycle?'PASS':null);
      item.auxiliaryStatus=facts.auxiliaryStatus??null;
      item.diagnostics=facts.observationMatches?[]:[{kind:'observation',artifact:item.slice,field:'observedWork',reason:'EVIDENCE_STALE'}];
    }
    validateRetainedOwnership(snapshot,continuity,[...outputs,...completedOutputs]);
    verifyLastAttempt(activation,[...outputs,...completedOutputs]);
  } else verifyLastAttempt(activation,[...outputs,...completedOutputs]);
  for (const item of [...outputs,...completedOutputs]) {
    const after=await observeProduct(context,item.targets,{entries:0,bytes:0},converted);
    if (!equal(item.observation.manifest,after.manifest) || !equal([...item.observation.identities],[...after.identities])
      || !equal(item.observation.rootIdentity,after.rootIdentity))
      fail('EVIDENCE_STALE',`${item.slice}: product changed during inspection`,'integrity',item.slice,'observedWork');
  }
  await compareImage(root,activation,image);
  await compareDocuments(workspace,documents);
  const b=await safeRead(activationFile);
  if (!equal(boundaries,await physicalBoundaries(context))) fail('STALE_BASE','official physical boundary changed between A and B');
  if (!a.bytes.equals(b.bytes) || !equal(a.identity,b.identity) || !equal(identity(rootBefore),identity(await realDirectoryMetadata(root))))
    fail('STALE_BASE','activation or official root changed between A and B','integrity','activation.json');
  if(continuity.completed.length) {
    const blocked=outputs.filter(({facts})=>facts.observedValidation==='uncertain'
      || facts.auxiliaryStatus==='BLOCKED'||facts.formalStatus==='BLOCKED'
      || facts.rejection&&facts.consumption?.resumable===false);
    const pending=blocked.length?null:outputs.find(({facts})=>facts.observedValidation!=='current');
    let state='VALIDATION_BLOCKED',normalHandoff=null;
    let diagnostics=blocked.map(item=>({kind:'evidence',artifact:item.slice,field:'status',
      reason:item.facts.observedValidation==='uncertain'?'uncertain incorporation'
        :item.facts.rejection&&item.facts.consumption?.resumable===false?'normalization exhausted':'blocked incorporation'}));
    if(pending) {
      const facts=pending.facts;
      if(facts.bundle===null)diagnostics=[{kind:'evidence',artifact:pending.slice,field:'validation',reason:'active delivery has no current local proof'}];
      else {
        const operation=facts.rejection?facts.rejection.origin.operation==='APPLY_FINDINGS'?'APPLY_FINDINGS':'VALIDATE_SLICE'
          :!facts.observationMatches?'VALIDATE_SLICE'
          :facts.formalStatus==='NEEDS_FIX'&&(!facts.cycle||facts.bundle.validation.id!==facts.cycle.admissionId)
            ?'APPLY_FINDINGS':'VALIDATE_SLICE';
        normalHandoff=fresh.has(pending.deliveryId)&&facts.formalStatus==='NEEDS_FIX'
          ?null:{operation,slice:pending.slice,deliveryId:pending.deliveryId};
        state=!facts.observationMatches?'EVIDENCE_STALE':operation==='APPLY_FINDINGS'?'VALIDATION_NEEDS_FIX'
          :facts.cycle?.status==='TESTS_PASS'?'FINDINGS_CORRECTED'
            :facts.cycle?.status==='TESTS_FAIL'?'FINDINGS_RETRY_EXHAUSTED'
              :facts.auxiliaryStatus==='TESTS_FAIL'?'IMPLEMENTATION_RETRY_EXHAUSTED':'IMPLEMENTED_AWAITING_VALIDATION';
        diagnostics=pending.diagnostics;
      }
    }
    if(!pending&&!blocked.length)diagnostics=[{kind:'evidence',artifact:'continuity.json',field:'terminal',
      reason:'EVIDENCE_INCOMPLETE: local PASS has no terminal judgment'}];
    const inspection={activationId:activation.activationId,sequence:activation.sequence,
      requirementsAuthority:projected.requirementsAuthority,preparationRevision:activation.preparationRevision,
      deliveries:outputs.map(({facts,targets,observation,carrier,retainedAuthority,identityAuthority,...item})=>item),
      completed:completedOutputs.map(({facts,targets,observation,retainedAuthority,...item})=>item),
      state,normalHandoff,diagnostics};
    return withCapture?{inspection:structuredClone(inspection),context:structuredClone(context),requirementsAuthority:projected.requirementsAuthority,
      activationBytes:Uint8Array.from(a.bytes),files:new Map([...image.files].map(([name,bytes])=>[name,Uint8Array.from(bytes)])),
      observedByDelivery:new Map(outputs.map(item=>[item.deliveryId,scopedObservation(item.observation,item.targets)]))}:inspection;
  }
  if(converted) {
    const blocked=outputs.filter(item=>item.facts.formalStatus==='BLOCKED'
      || item.facts.auxiliaryStatus==='BLOCKED'
      || item.facts.observedValidation==='uncertain');
    const pending=blocked.length?null:outputs.find(item=>item.facts.requiresFormalRevalidation);
    const post= pending?.facts.bundle?.validation?.recordFormat==='stnl-task-record-v2'
      || pending?.facts.rejection && pending.facts.consumption.kind==='bounded-formal-rejection';
    const hasPost=outputs.some(item=>item.facts.bundle?.validation?.recordFormat==='stnl-task-record-v2');
    const operation=pending?.facts.rejection
      ?pending.facts.rejection.origin.operation==='APPLY_FINDINGS'?'APPLY_FINDINGS':'VALIDATE_SLICE':post
      ?pending.facts.formalStatus==='NEEDS_FIX'
        && (!pending.facts.cycle?.admissionId || pending.facts.bundle.validation.id!==pending.facts.cycle.admissionId)
        ?'APPLY_FINDINGS':'VALIDATE_SLICE'
      :pending?.facts.formalStatus==='NEEDS_FIX'?'APPLY_FINDINGS'
        :['closed-formal-boundary','closed-boundary-not-resumable'].includes(pending?.facts.consumption.kind)
          ?'VALIDATE_SLICE':null;
    const handoff=operation?{operation,slice:pending.slice,deliveryId:pending.deliveryId}:null;
    const state=blocked.length?'VALIDATION_BLOCKED'
      :post?pending?.diagnostics.length?'EVIDENCE_STALE'
        :operation==='APPLY_FINDINGS'?'VALIDATION_NEEDS_FIX'
          :pending?.facts.cycle?.status==='TESTS_PASS'?'FINDINGS_CORRECTED'
            :pending?.facts.cycle?.status==='TESTS_FAIL'?'FINDINGS_RETRY_EXHAUSTED':'IMPLEMENTED_AWAITING_VALIDATION'
      :pending?.facts.formalStatus==='NEEDS_FIX'?'VALIDATION_NEEDS_FIX'
        :pending?.diagnostics.length?'EVIDENCE_STALE'
          :hasPost?'IMPLEMENTED_AWAITING_VALIDATION':'VALIDATION_BLOCKED';
    const awaiting=completedOutputs.length && outputs.find(item=>item.facts.persistedValidation!=='current');
    const inspection={activationId:activation.activationId,sequence:activation.sequence,
      requirementsAuthority:projected.requirementsAuthority,preparationRevision:activation.preparationRevision,
      deliveries:outputs.map(({facts,targets,observation,carrier,retainedAuthority,identityAuthority,...publicItem})=>publicItem),
      completed:completedOutputs.map(({facts,targets,observation,retainedAuthority,...publicItem})=>publicItem),
      state,normalHandoff:handoff,
      diagnostics:blocked.length?blocked.map(item=>({kind:'evidence',artifact:item.slice,
        field:'status',reason:item.facts.formalStatus==='BLOCKED'
          ?'blocked incorporation':'uncertain incorporation'}))
        :pending?pending.diagnostics.length?pending.diagnostics:pending.facts.diagnostics
        :awaiting?[{kind:'evidence',artifact:awaiting.slice,field:'validation',
          reason:'active delivery has no current local proof'}]
        :[{kind:'evidence',artifact:'continuity.json',field:'terminal',reason:'EVIDENCE_INCOMPLETE: local PASS has no terminal judgment'}]};
    return withCapture?{inspection:structuredClone(inspection),context:structuredClone(context),requirementsAuthority:projected.requirementsAuthority,
      activationBytes:Uint8Array.from(a.bytes),files:new Map([...image.files].map(([name,bytes])=>[name,Uint8Array.from(bytes)])),
      observedByDelivery:new Map(outputs.map(item=>[item.deliveryId,scopedObservation(item.observation,item.targets)]))}:inspection;
  }
  // A later concluded refusal or BLOCKED result owns recovery for the whole
  // image. A stale predecessor must not hide it by winning the serial scan.
  const blocked=outputs.filter(({facts})=>facts.observedValidation==='uncertain'
    || facts.auxiliaryStatus==='BLOCKED' || facts.formalStatus==='BLOCKED');
  let state='VALIDATION_BLOCKED',normalHandoff=null,diagnostics=blocked.map(item=>({
    kind:'evidence',artifact:item.slice,field:'status',reason:item.facts.observedValidation==='uncertain'
      ?'uncertain incorporation':'blocked incorporation'}));
  for (const item of blocked.length?[]:outputs) {
    const facts=item.facts;
    if (facts.observedValidation==='current') continue;
    const operation=!facts.observationMatches?'VALIDATE_SLICE':facts.bundle===null?'EXECUTE_SLICE'
      :facts.formalStatus==='NEEDS_FIX' && (!facts.cycle || facts.bundle.validation.id!==facts.cycle.admissionId)
        ?'APPLY_FINDINGS':'VALIDATE_SLICE';
    state=item.diagnostics.length?'EVIDENCE_STALE':operation==='EXECUTE_SLICE'?'MATERIALIZED_PRISTINE'
      :operation==='APPLY_FINDINGS'?'VALIDATION_NEEDS_FIX'
        :facts.cycle?.status==='TESTS_PASS'?'FINDINGS_CORRECTED'
          :facts.cycle?.status==='TESTS_FAIL'?'FINDINGS_RETRY_EXHAUSTED'
            :facts.auxiliaryStatus==='TESTS_FAIL'?'IMPLEMENTATION_RETRY_EXHAUSTED':'IMPLEMENTED_AWAITING_VALIDATION';
    normalHandoff={operation,slice:item.slice,deliveryId:item.deliveryId};
    diagnostics=item.diagnostics; break;
  }
  if (normalHandoff===null && diagnostics.length===0)
    diagnostics=[{kind:'evidence',artifact:'continuity.json',field:'terminal',reason:'EVIDENCE_INCOMPLETE: local PASS has no terminal judgment'}];
  const inspection={activationId:activation.activationId,sequence:activation.sequence,
    requirementsAuthority:projected.requirementsAuthority,preparationRevision:activation.preparationRevision,
    deliveries:outputs.map(({facts,targets,observation,retainedAuthority,identityAuthority,...publicItem})=>publicItem),
    completed:completedOutputs.map(({facts,targets,observation,retainedAuthority,...publicItem})=>publicItem),state,normalHandoff,diagnostics};
  return withCapture?{inspection:structuredClone(inspection),context:structuredClone(context),requirementsAuthority:projected.requirementsAuthority,
    activationBytes:Uint8Array.from(a.bytes),files:new Map([...image.files].map(([name,bytes])=>[name,Uint8Array.from(bytes)])),
    observedByDelivery:new Map(outputs.map(item=>[item.deliveryId,scopedObservation(item.observation,item.targets)]))}:inspection;
}

export async function inspectCurrentExecution(specPath) { return readCurrentExecution(specPath); }
export async function captureCurrentExecution(specPath) { return readCurrentExecution(specPath,true); }
// Active capture is only an image observation. The operation controller must
// separately prove its allocation and phase before treating this as admission.
export async function captureCurrentActiveExecution(specPath,expectedOwner) {
  return readCurrentExecution(specPath,true,expectedOwner);
}

async function realDirectoryMetadata(file) {
  const metadata=await fs.lstat(file);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('UNSAFE_PATH','official root replaced','integrity',file);
  return metadata;
}

export async function main(argv=process.argv.slice(2)) {
  if (argv.length===1 && argv[0]==='--help') {
    process.stdout.write('Usage: node execution-current-reader.mjs SPEC_PATH\nRead-only EC-1 quiet inspection. No operation is admitted.\n');
    return 0;
  }
  if (argv.length!==1 || argv[0].startsWith('--')) {
    process.stderr.write('Usage: node execution-current-reader.mjs SPEC_PATH\n'); return 2;
  }
  try {process.stdout.write(`${JSON.stringify(await inspectCurrentExecution(argv[0]))}\n`);return 0;}
  catch (error) {
    process.stdout.write(`${JSON.stringify({code:error?.code??'INVALID_CURRENT_IMAGE',reason:error?.message,
      diagnostics:error?.diagnostics??[]})}\n`);return 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url)
  process.exitCode=await main();
