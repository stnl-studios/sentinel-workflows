#!/usr/bin/env node
// Editable documentary source and exact-byte approval. Neither is execution authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assertPreparationCandidate,preparePlanCandidate} from './prepare-plan-candidate.mjs';
import {serializePlanPathClaims} from './serialize-plan-paths.mjs';
import {resolveCurrentExecutionContext} from './execution-workspace.mjs';
import {captureExecutionTree,readOwnedFile,writeNew,parseStrictJson,withExecutionPublicationLock,assertNoPendingExecutionPublication,syncLockParent} from './execution-publication.mjs';
const artifact=name=>/^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(name);
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const fail=(message)=>{throw Object.assign(new Error(message),{code:'STALE_APPROVAL'});};
const identity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const draftPath=owned=>path.join(path.dirname(owned.workspace.authorityPath),path.parse(owned.workspace.authorityPath).name+'-planning',path.basename(owned.root));
const legacyDraftPath=owned=>path.join(path.dirname(owned.workspace.authorityPath),path.parse(owned.workspace.authorityPath).name+'-planning-draft-'+path.basename(owned.root));
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
export async function preparationDraftPaths(options){
 const {workspace}=await resolveCurrentExecutionContext(options.specPath,{filesystemContext:options.filesystemContext??null});
 const candidateRoot=await fs.realpath(options.candidateExecutionRoot);
 const legacy=path.join(path.dirname(workspace.authorityPath),path.parse(workspace.authorityPath).name+'-planning-draft-'+path.basename(candidateRoot));
 // Read existing approvals in place. New controls live with their technical allocation.
 const legacyExists=await fs.lstat(legacy+'.owner.json').then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
 const base=legacyExists?legacy:path.join(path.dirname(candidateRoot)+'-drafts',path.basename(candidateRoot)+'.draft');
 return {binding:base+'.owner.json',capture:base+'.capture.json',approval:base+'.approval.json'};
}
const linkPath=async options=>(await preparationDraftPaths(options)).binding;
const capturePath=async options=>(await preparationDraftPaths(options)).capture;
const approvalPath=async options=>(await preparationDraftPaths(options)).approval;
async function read(file){return parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));}
async function artifactsAt(root,{technical=false}={}) {
 const tree=await captureExecutionTree(root);if(!tree)fail('Draft is absent');
 const files=new Map();
 for(const entry of tree.files){
  if(entry.type==='directory'){if(!['plans','tasks',...(technical?['evidence']:[])].includes(entry.path))fail('Foreign draft directory');continue;}
  if(!artifact(entry.path)){if(technical)continue;fail('Foreign draft artifact');}
  files.set(entry.path,(await readOwnedFile(path.join(root,entry.path))).bytes);
 }
 return files;
}
const manifest=files=>[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([name,bytes])=>({path:name,sha256:hash(bytes),utf8:bytes.toString('utf8')}));
async function directoryIdentity(directory){
 let cursor=path.parse(directory).root;
 for(const segment of directory.slice(cursor.length).split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,segment);const stat=await fs.lstat(cursor);
  if(!stat.isDirectory()||stat.isSymbolicLink())fail('Unsafe draft directory');
 }
 return identity(await fs.lstat(directory));
}
async function copy(files,root){
 const owner=await directoryIdentity(root);
 for(const [name,bytes] of files){
  const target=path.join(root,name),directory=path.dirname(target);
  if(directory!==root){try{await fs.mkdir(directory);}catch(error){if(error.code!=='EEXIST')throw error;}}
  const parent=await directoryIdentity(directory);
  if(!equal(owner,await directoryIdentity(root)))fail('Draft root changed');
  const previous=await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(previous)await readOwnedFile(target);
  const temporary=path.join(directory,'.draft-write-'+randomUUID());
  await writeNew(temporary,bytes,0o644);
  if(!equal(owner,await directoryIdentity(root))||!equal(parent,await directoryIdentity(directory)))fail('Draft destination changed');
  const current=await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(previous?!current||!equal(identity(previous),identity(current)):current!==null)fail('Draft target changed');
  // Rename never follows or writes through a destination symlink/hardlink.
  await fs.rename(temporary,target);
  if(!equal(parent,await directoryIdentity(directory))||!(await readOwnedFile(target)).bytes.equals(bytes))fail('Draft copy changed');
 }
}
async function draftBinding(owned,{allowInitializing=false}={}){
 const binding=await read(await linkPath({specPath:owned.marker.specPath,candidateExecutionRoot:owned.root}));
 const keys=['format','draftRoot','draftIdentity','candidateExecutionRoot','specPath',...(binding.initializing===true?['initializing']:[])];
 if(binding.initializing===true&&!allowInitializing)fail('Draft initialization is incomplete; retry create before editing or capture');
 if(!equal(Object.keys(binding).sort(),keys.sort())||binding.format!=='stnl-editable-draft-v1'
  ||binding.draftRoot!==((await linkPath({specPath:owned.marker.specPath,candidateExecutionRoot:owned.root})).endsWith('.draft.owner.json')?draftPath(owned):legacyDraftPath(owned))||binding.candidateExecutionRoot!==owned.root||binding.specPath!==owned.marker.specPath
  ||!equal(binding.draftIdentity,await directoryIdentity(binding.draftRoot)))fail('Draft allocation or physical identity differs');
 return binding;
}
export async function createPreparationDraft(options){
 const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options);
 return withExecutionPublicationLock(owned.workspace,()=>createPreparationDraftLocked(options));
}
async function createPreparationDraftLocked(options){
 const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options);
 const file=await linkPath(options);
 const existing=await fs.lstat(file).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
 let binding;
 if(existing){
  binding=await draftBinding(owned,{allowInitializing:true});
  if(!binding.initializing)return {status:'EDITABLE_DRAFT',...binding,reused:true,executionAuthority:false};
 }else{
  const draftRoot=draftPath(owned),parent=path.dirname(draftRoot);
  try{await fs.mkdir(parent,{mode:0o755});}catch(error){if(error.code!=='EEXIST')throw error;}
  await directoryIdentity(parent);
  // Exclusive allocation: never adopt an unowned folder after interruption.
  await fs.mkdir(draftRoot,{mode:0o755});
  const controls=path.dirname(file);
  try{await fs.mkdir(controls,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  await directoryIdentity(controls);
  binding={format:'stnl-editable-draft-v1',draftRoot,draftIdentity:await directoryIdentity(draftRoot),candidateExecutionRoot:owned.root,specPath:owned.marker.specPath,initializing:true};
  await writeNew(file,json(binding));
 }
 // Until every source document exists byte-exactly, capture must not interpret
 // a partial draft as intentional slice removal. Retry fills only missing files.
 const source=await artifactsAt(owned.root,{technical:true}),partial=await artifactsAt(binding.draftRoot);
 for(const [name,bytes] of partial)if(!source.has(name)||!source.get(name).equals(bytes))fail('Incomplete draft contains changed content; preserve and recover it before create');
 for(const [name,bytes] of source)if(!partial.has(name)){
  const target=path.join(binding.draftRoot,name),parent=path.dirname(target);
  if(parent!==binding.draftRoot)try{await fs.mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
  await directoryIdentity(parent);await writeNew(target,bytes,0o644);
 }
 if(!equal(binding.draftIdentity,await directoryIdentity(binding.draftRoot))
   ||!equal(manifest(source),manifest(await artifactsAt(binding.draftRoot))))fail('Draft initialization changed');
 const pending=await readOwnedFile(file),complete={...binding};delete complete.initializing;
 if(!pending.bytes.equals(json(binding)))fail('Draft binding changed during initialization');
 const temporary=file+'.initializing-'+randomUUID();await writeNew(temporary,json(complete));
 const current=await readOwnedFile(file);
 if(!current.bytes.equals(pending.bytes)||!equal(current.identity,pending.identity))fail('Draft binding changed during initialization');
 await fs.rename(temporary,file);await syncLockParent(path.dirname(file));
 return {status:'EDITABLE_DRAFT',...complete,...(existing?{reused:true}:{}),executionAuthority:false};
}
export async function capturePreparationDraft(options){
 const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options);
 return withExecutionPublicationLock(owned.workspace,()=>capturePreparationDraftLocked(options));
}
async function capturePreparationDraftLocked(options){
 const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options),binding=await draftBinding(owned);
 if(binding.candidateExecutionRoot!==owned.root||binding.specPath!==owned.marker.specPath)fail('Draft allocation differs');
 // Captures are write-once. A stale capture cannot silently inherit approval.
 try{await fs.lstat(await capturePath(options));fail('Draft already captured; use revise for changes or resume its review/publication');}catch(error){if(error.code!=='ENOENT')throw error;}
 const source=await artifactsAt(binding.draftRoot);
 // The editable set is authoritative for this unapproved capture, including removals.
 // Only disposable plan/task copies may be pruned; evidence and foreign paths are untouched.
 const previous=await artifactsAt(owned.root,{technical:true});
 for(const name of previous.keys())if(!source.has(name)){await readOwnedFile(path.join(owned.root,name));await fs.unlink(path.join(owned.root,name));}
 await copy(source,owned.root);
 await preparePlanCandidate({...options,candidateExecutionRoot:owned.root});
 const prepared=await serializePlanPathClaims({...options,candidateExecutionRoot:owned.root});
 if(prepared.proposal)await copy(prepared.proposal.files,owned.root);
 const final=await artifactsAt(owned.root,{technical:true});
 if(JSON.stringify(manifest(source))!==JSON.stringify(manifest(await artifactsAt(binding.draftRoot))))fail('Draft changed during capture');
 // Runtime identity/canonical carriers become visible before the user approves.
 await copy(final,binding.draftRoot);
 const snapshot={...binding,format:'stnl-draft-capture-v1',requirementsAuthority:prepared.authority.requirementsAuthority,artifacts:manifest(final)};
 const bytes=json(snapshot);await writeNew(await capturePath(options),bytes,0o444);
 return {status:'AWAITING_USER_APPROVAL',draftRoot:binding.draftRoot,candidateExecutionRoot:owned.root,captureSha256:hash(bytes),snapshotPath:await capturePath(options),executionAuthority:false};
}
// Explicit revision invalidates approval; prior captures remain byte-exact in technical history.
// It reuses the same editable workspace, never a published preparation or an active publication.
export async function revisePreparationDraft(options){
 const initial=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options);
 return withExecutionPublicationLock(initial.workspace,async()=>{
  await assertNoPendingExecutionPublication(initial.workspace);
  const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options);
  const binding=await draftBinding(owned),paths=await preparationDraftPaths(options);
  if(owned.marker.operation==='PLAN')for(const name of ['approved-preparation.json','continuity.json']){
   const present=await fs.lstat(path.join(owned.root,name)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
   if(present)throw Object.assign(new Error('Initial installation has started; resume the original installation/publication before revising, preserving its approval'),{code:'PREPARATION_INSTALL_PENDING'});
  }
  let captured;try{captured=await readOwnedFile(paths.capture);}catch(error){if(error.code!=='ENOENT')throw error;}
  let approved;try{approved=await readOwnedFile(paths.approval);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!captured){if(approved)fail('Approval without capture must be recovered, not revised');return {status:'EDITABLE_DRAFT',draftRoot:binding.draftRoot,executionAuthority:false};}
  const snapshot=parseStrictJson(captured.bytes.toString('utf8'));
  if(snapshot.format!=='stnl-draft-capture-v1'||snapshot.draftRoot!==binding.draftRoot
    ||snapshot.specPath!==binding.specPath||snapshot.candidateExecutionRoot!==owned.root
    ||!equal(snapshot.draftIdentity,binding.draftIdentity)||!Array.isArray(snapshot.artifacts))fail('Capture allocation differs');
  if(approved){const approval=parseStrictJson(approved.bytes.toString('utf8'));
   if(approval.format!=='stnl-user-draft-approval-v1'||approval.captureSha256!==hash(captured.bytes))fail('Approval differs from archived capture');}
  const history=paths.capture+'.history';
  try{await fs.mkdir(history,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  await directoryIdentity(history);
  const archive=path.join(history,hash(captured.bytes).slice(7));
  try{await fs.mkdir(archive,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const archiveIdentity=await directoryIdentity(archive);
  for(const [name,item] of [['capture.json',captured],['approval.json',approved]])if(item){
   const destination=path.join(archive,name);
   try{await writeNew(destination,item.bytes,0o444);}catch(error){if(error.code!=='EEXIST')throw error;}
   if(!(await readOwnedFile(destination)).bytes.equals(item.bytes))fail('Revision history differs');
  }
  if(!equal(archiveIdentity,await directoryIdentity(archive)))fail('Revision history identity changed');
  await syncLockParent(archive);await syncLockParent(history);await syncLockParent(path.dirname(history));
  // Approval is removed first: interruption can never lend it to a new capture.
  for(const [file,item] of [[paths.approval,approved],[paths.capture,captured]])if(item){
   const current=await readOwnedFile(file);
   if(!current.bytes.equals(item.bytes)||!equal(current.identity,item.identity))fail('Draft control changed during revision');
   await fs.unlink(file);await syncLockParent(path.dirname(file));
  }
  return {status:'EDITABLE_DRAFT',draftRoot:binding.draftRoot,archivedCapture:archive,approvalRequired:true,executionAuthority:false};
 });
}
export async function approvePreparationDraft(options){
 const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options);
 return withExecutionPublicationLock(owned.workspace,()=>approvePreparationDraftLocked(options));
}
async function approvePreparationDraftLocked(options){
 if(typeof options.approvedCaptureSha256!=='string')fail('Explicit approval of the exact capture digest is required');
 const captured=await assertDraftCapture(options);
 if(options.approvedCaptureSha256!==captured.captureSha256)fail('User approved a different capture');
 await writeNew(await approvalPath(options),json({format:'stnl-user-draft-approval-v1',captureSha256:captured.captureSha256}),0o444);
 return {status:'AWAITING_INDEPENDENT_REVIEW',...captured,executionAuthority:false};
}
async function assertDraftCapture(options){
 const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options);
 const binding=await draftBinding(owned),bytes=(await readOwnedFile(await capturePath(options))).bytes,snapshot=parseStrictJson(bytes.toString('utf8'));
 if(!equal(Object.keys(snapshot).sort(),['format','draftRoot','draftIdentity','candidateExecutionRoot','specPath','requirementsAuthority','artifacts'].sort())||snapshot.format!=='stnl-draft-capture-v1'||!equal(snapshot.draftIdentity,binding.draftIdentity)||snapshot.candidateExecutionRoot!==owned.root||snapshot.draftRoot!==binding.draftRoot||snapshot.specPath!==owned.marker.specPath)fail('Capture allocation differs');
 const expected=JSON.stringify(snapshot.artifacts);
 if(expected!==JSON.stringify(manifest(await artifactsAt(binding.draftRoot)))||expected!==JSON.stringify(manifest(await artifactsAt(owned.root,{technical:true}))))fail('Draft or technical snapshot changed after capture');
 return {candidateExecutionRoot:owned.root,captureSha256:hash(bytes),snapshotPath:await capturePath(options),artifacts:snapshot.artifacts};
}
export async function assertPreparationDraftApproval(options,{required=false}={}){
 try{await fs.lstat(await linkPath(options));}catch(error){if(error.code==='ENOENT'&&!required)return null;throw Object.assign(new Error('Editable draft approval is required'),{code:'STALE_APPROVAL'});}
 const captured=await assertDraftCapture(options);let approval;
 try{approval=await read(await approvalPath(options));}catch{fail('Explicit user approval is absent');}
 if(!equal(Object.keys(approval).sort(),['format','captureSha256'].sort())||approval.format!=='stnl-user-draft-approval-v1'||approval.captureSha256!==captured.captureSha256)fail('User approval is stale');
 return captured;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [operation,...args]=process.argv.slice(2),options={};
 for(let i=0;i<args.length;i+=2){const key={'--spec-path':'specPath','--candidate-execution-root':'candidateExecutionRoot','--approved-capture-sha256':'approvedCaptureSha256'}[args[i]];if(!key||!args[i+1])throw new Error('Invalid draft arguments');options[key]=args[i+1];}
 const actions={create:createPreparationDraft,capture:capturePreparationDraft,revise:revisePreparationDraft,approve:approvePreparationDraft,review:options=>assertPreparationDraftApproval(options,{required:true})};
 if(!actions[operation])throw new Error('Expected create, capture, revise, approve or review');
 process.stdout.write(JSON.stringify(await actions[operation](options))+'\n');
}
