#!/usr/bin/env node
// Editable documentary source and exact-byte approval. Neither is execution authority.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {assertPreparationCandidate,preparePlanCandidate} from './prepare-plan-candidate.mjs';
import {serializePlanPathClaims} from './serialize-plan-paths.mjs';
import {resolveCurrentExecutionContext} from './execution-workspace.mjs';
import {captureExecutionTree,readOwnedFile,writeNew,parseStrictJson} from './execution-publication.mjs';
const artifact=name=>/^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(name);
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
const fail=(message)=>{throw Object.assign(new Error(message),{code:'STALE_APPROVAL'});};
const identity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const draftPath=owned=>path.join(path.dirname(owned.workspace.authorityPath),path.parse(owned.workspace.authorityPath).name+'-planning-draft-'+path.basename(owned.root));
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
export async function preparationDraftPaths(options){
 const {workspace}=await resolveCurrentExecutionContext(options.specPath,{filesystemContext:options.filesystemContext??null});
 const base=path.join(path.dirname(workspace.authorityPath),path.parse(workspace.authorityPath).name+'-planning-draft-'+path.basename(options.candidateExecutionRoot));
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
async function draftBinding(owned){
 const binding=await read(await linkPath({specPath:owned.marker.specPath,candidateExecutionRoot:owned.root}));
 const keys=['format','draftRoot','draftIdentity','candidateExecutionRoot','specPath'];
 if(!equal(Object.keys(binding).sort(),keys.sort())||binding.format!=='stnl-editable-draft-v1'
  ||binding.draftRoot!==draftPath(owned)||binding.candidateExecutionRoot!==owned.root||binding.specPath!==owned.marker.specPath
  ||!equal(binding.draftIdentity,await directoryIdentity(binding.draftRoot)))fail('Draft allocation or physical identity differs');
 return binding;
}
export async function createPreparationDraft(options){
 const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options);
 const draftRoot=draftPath(owned);
 // Exclusive allocation: never adopt a directory or follow an existing link.
 await fs.mkdir(draftRoot,{mode:0o755});
 const binding={format:'stnl-editable-draft-v1',draftRoot,draftIdentity:await directoryIdentity(draftRoot),candidateExecutionRoot:owned.root,specPath:owned.marker.specPath};
 await writeNew(await linkPath(options),json(binding));
 await copy(await artifactsAt(owned.root,{technical:true}),draftRoot);
 return {status:'EDITABLE_DRAFT',...binding,executionAuthority:false};
}
export async function capturePreparationDraft(options){
 const owned=await assertPreparationCandidate(options.candidateExecutionRoot,options.specPath,options),binding=await draftBinding(owned);
 if(binding.candidateExecutionRoot!==owned.root||binding.specPath!==owned.marker.specPath)fail('Draft allocation differs');
 // Captures are write-once. A stale capture cannot silently inherit approval.
 try{await fs.lstat(await capturePath(options));fail('Draft already captured; preserve it and request a fresh preparation');}catch(error){if(error.code!=='ENOENT')throw error;}
 const source=await artifactsAt(binding.draftRoot);
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
export async function approvePreparationDraft(options){
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
 const actions={create:createPreparationDraft,capture:capturePreparationDraft,approve:approvePreparationDraft,review:options=>assertPreparationDraftApproval(options,{required:true})};
 if(!actions[operation])throw new Error('Expected create, capture, approve or review');
 process.stdout.write(JSON.stringify(await actions[operation](options))+'\n');
}
