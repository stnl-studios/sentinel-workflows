#!/usr/bin/env node
// EC-1 paths are typed artifact-relative claims. Validate them with the existing
// current projector; do not reinterpret paths using a previous-format resolver.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertPreparationCandidate,capturePreparationSource} from './prepare-plan-candidate.mjs';
import {resolveCurrentExecutionContext} from './execution-workspace.mjs';
import {inspectCurrentExecution,validateCurrentReviewCandidate} from './execution-current-reader.mjs';
import {projectInitialPreparation,prepareCurrentSetReplacement} from './execution-preparation-current.mjs';
import {captureExecutionTree,readOwnedFile} from './execution-publication.mjs';
export async function serializePlanPathClaims({specPath,candidateExecutionRoot}) {
 const owned=await assertPreparationCandidate(candidateExecutionRoot,specPath),{context}=await resolveCurrentExecutionContext(specPath),image=await inspectCurrentExecution(specPath);
 if(owned.marker.operation==='REPLAN') {
  const source=await capturePreparationSource(owned),tree=await captureExecutionTree(owned.root),artifacts=new Map(),carriers=new Map();
  for(const entry of tree.files) {
   if(entry.type==='directory') {
    if(!['plans','tasks','evidence'].includes(entry.path))throw new Error('Foreign replacement directory');
    continue;
   }
   const bytes=(await readOwnedFile(path.join(owned.root,entry.path))).bytes;
   if(/^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(entry.path))artifacts.set(entry.path,bytes);
   else if(['continuity.json','approved-preparation.json'].includes(entry.path)||entry.path.startsWith('evidence/')&&source.files.has(entry.path))carriers.set(entry.path,bytes);
   else throw new Error('Foreign replacement artifact');
  }
  const proposal=prepareCurrentSetReplacement({context,requirementsAuthority:source.requirementsAuthority,
   previous:{activationBytes:source.activationBytes,files:source.files},artifacts,completedDeliveryIds:owned.marker.completedDeliveryIds,
   ...(owned.marker.terminalValidation?{terminalValidation:true}:{})});
  for(const [name,bytes] of carriers)if(name!=='approved-preparation.json'&&!bytes.equals(Buffer.from(source.files.get(name)??[]))&&!bytes.equals(Buffer.from(proposal.files.get(name)??[])))
   throw Object.assign(new Error('Candidate evidence or continuity differs from its official source and current proposal'),{code:'EVIDENCE_INCOMPLETE'});
  if(carriers.has('approved-preparation.json'))await validateCurrentReviewCandidate({specPath,
   files:new Map([...proposal.files,['approved-preparation.json',carriers.get('approved-preparation.json')]])});
  await capturePreparationSource(await assertPreparationCandidate(owned.root,specPath));
  return {status:'PASS',artifacts,authority:proposal.authority,proposal};
 }
 if(image.state!=='NO_EXECUTION')throw Object.assign(new Error('Initial preparation target is occupied'),{code:'REPLAN_REQUIRED'});
 const tree=await captureExecutionTree(owned.root),artifacts=new Map();
 for(const entry of tree.files) {
  if(entry.type==='directory'){if(!['plans','tasks'].includes(entry.path))throw new Error('Foreign preparation directory');continue;}
  if(!/^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(entry.path))throw new Error('Foreign preparation artifact');
  artifacts.set(entry.path,(await readOwnedFile(path.join(owned.root,entry.path))).bytes);
 }
 const authority=projectInitialPreparation({context,requirementsAuthority:image.requirementsAuthority,artifacts});
 return {status:'PASS',artifacts,authority};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const a=process.argv.slice(2);if(a.length!==4||a[0]!=='--spec-path'||a[2]!=='--candidate-execution-root')throw new Error('Usage: serialize-plan-paths.mjs --spec-path SPEC --candidate-execution-root ROOT');const result=await serializePlanPathClaims({specPath:a[1],candidateExecutionRoot:a[3]});process.stdout.write(JSON.stringify({status:result.status,authority:result.authority})+'\n');}
