#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolveCurrentExecutionContext,resolveExecutionWorkspace} from './execution-workspace.mjs';
import {assertOwnedPreparationCandidate,readOwnedFile,persistAllocation} from './execution-publication.mjs';
export async function assertPreparationCandidate(root,specPath=null){return assertOwnedPreparationCandidate({candidateExecutionRoot:root,specPath,resolveWorkspace:resolveExecutionWorkspace});}
export async function preparePlanCandidate({candidateExecutionRoot}) {
 const owned=await assertPreparationCandidate(candidateExecutionRoot),{context}=await resolveCurrentExecutionContext(owned.marker.specPath);
 if(owned.marker.source!==null||owned.marker.preparationRevision!==1)throw Object.assign(new Error('Only absent-target Initial preparation is supported'),{code:'REPLAN_REQUIRED'});
 const marker=owned.marker;
 const names=(await fs.readdir(path.join(owned.root,'plans'))).sort();
 if(!names.length||names.some(name=>!/^slice-[0-9]{2,}\.md$/u.test(name)))throw new Error('Expected current detailed plans');
 for(const name of names) {
  const identity=marker.deliveryIds[name]??randomUUID();
  if(!marker.deliveryIds[name]){marker.deliveryIds[name]=identity;await persistAllocation(`${owned.root}.owner.json`,marker);}
  for(const group of ['plans','tasks']) {
   const target=path.join(owned.root,group,name),before=(await readOwnedFile(target)).bytes.toString('utf8');
   const supplied=before.match(/^- Delivery ID: (.+)$/mu)?.[1];
   if(supplied&&supplied!=='runtime'&&supplied!==identity)throw new Error('Delivery identity differs from the owned producer');
   let text=supplied?before.replace(/^- Delivery ID: .+$/mu,'- Delivery ID: '+identity):before.replace('## References\n\n','## References\n\n- Delivery ID: '+identity+'\n');
   if(!/^- Local revision: /mu.test(text))text=text.replace(/^- Plan revision: .+$/mu,x=>x+'\n- Local revision: 1');
   await fs.writeFile(target,text);
  }
 }
 return {status:'DRAFT',candidateExecutionRoot:owned.root,logicalAuthorityPath:context.logicalAuthorityPath};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--candidate-execution-root')throw new Error('Usage: prepare-plan-candidate.mjs --candidate-execution-root ROOT');process.stdout.write(JSON.stringify(await preparePlanCandidate({candidateExecutionRoot:args[1]}))+'\n');}
