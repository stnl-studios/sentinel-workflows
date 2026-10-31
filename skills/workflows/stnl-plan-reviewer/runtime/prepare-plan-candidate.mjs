#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolveCurrentExecutionContext,resolveExecutionWorkspace} from './execution-workspace.mjs';
import {assertOwnedPreparationCandidate,readOwnedFile,persistAllocation} from './execution-publication.mjs';
import {captureCurrentSetReplacementSource} from './execution-state.mjs';
export async function assertPreparationCandidate(root,specPath=null,{filesystemContext=null}={}){return assertOwnedPreparationCandidate({candidateExecutionRoot:root,specPath,resolveWorkspace:spec=>resolveExecutionWorkspace(spec,{filesystemContext})});}
function fail(code,message){throw Object.assign(new Error(message),{code});}
export function setPreparationMembers(source,ids,{terminalValidation=false}={}) {
 const continuity=JSON.parse(Buffer.from(source.files.get('continuity.json'))),members=[...continuity.deliveries,...continuity.completed];
 if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!members.some(item=>item.deliveryId===id)))
  fail('INVALID_CURRENT_IMAGE','Completed selection differs from the captured source');
 const active=members.filter(item=>!ids.includes(item.deliveryId));
 if(typeof terminalValidation!=='boolean')fail('INVALID_CURRENT_IMAGE','Terminal validation selection must be boolean');
 if(terminalValidation) {
  const snapshot=JSON.parse(Buffer.from(source.files.get('approved-preparation.json')));
  if(continuity.deliveries.length!==0||active.length!==1||source.inspection.state!=='VALIDATION_BLOCKED'
    ||!source.inspection.diagnostics.some(item=>item.field==='terminal')
    ||!snapshot.normativeProjection.completed.find(item=>item.deliveryId===active[0].deliveryId)?.obligations
      .some(item=>item.contribution==='complete'&&item.fullOwner==='delivery:'+active[0].deliveryId))
   fail('REPLAN_REQUIRED','Terminal reentry requires an empty queue without current integral proof and its same integral owner');
 }
 if(!(continuity.deliveries.length>0&&active.length===0)
   &&!(continuity.deliveries.length===0&&active.length===1&&(ids.length>0||terminalValidation)&&active[0].normalization===null))
  fail('UNSUPPORTED_FORMAT','Preparation supports Q18 retirement, Q19 private reopening or explicit Q20 terminal reentry');
 return active;
}
export async function capturePreparationSource(owned) {
 if(owned.marker.operation!=='REPLAN')fail('REPLAN_REQUIRED','Expected a registered REPLAN allocation');
 const source=await captureCurrentSetReplacementSource(owned.marker.specPath);
 if(owned.marker.expectedActivationId!==source.inspection.activationId
   ||owned.marker.preparationRevision!==source.inspection.preparationRevision+1)
  fail('STALE_BASE','Preparation activation or revision differs from its official source');
 setPreparationMembers(source,owned.marker.completedDeliveryIds,{terminalValidation:owned.marker.terminalValidation??false});
 return source;
}
export async function preparePlanCandidate({candidateExecutionRoot,filesystemContext=null}) {
 const owned=await assertPreparationCandidate(candidateExecutionRoot,null,{filesystemContext}),{context}=await resolveCurrentExecutionContext(owned.marker.specPath,{filesystemContext});
 if(owned.marker.operation==='REPLAN') {
  const source=await capturePreparationSource(owned),active=setPreparationMembers(source,owned.marker.completedDeliveryIds,
   {terminalValidation:owned.marker.terminalValidation??false});
  const continuity=JSON.parse(Buffer.from(source.files.get('continuity.json')));
  for(const member of [...continuity.deliveries,...continuity.completed].filter(item=>!active.some(value=>value.deliveryId===item.deliveryId)))
   for(const group of ['plans','tasks']) {
    const name=`${group}/${member.slice}.md`;
    if(source.files.has(name))await fs.rm(path.join(owned.root,name),{force:true});
   }
  const revision=owned.marker.preparationRevision;
  const writeRevision=(text,previous)=>{
   const supplied=text.match(/^- Plan revision: (.+)$/mu)?.[1];
   const prior=previous?Buffer.from(previous).toString('utf8').match(/^- Plan revision: (.+)$/mu)?.[1]:null;
   if(![prior,String(revision),'runtime'].includes(supplied))fail('STALE_BASE','Plan revision differs from the captured preparation');
   return text.replace(/^- Plan revision: .+$/mu,'- Plan revision: '+revision);
  };
  const global=path.join(owned.root,'plan.md');
  await fs.writeFile(global,writeRevision((await readOwnedFile(global)).bytes.toString('utf8'),source.files.get('plan.md')));
  for(const member of active)for(const group of ['plans','tasks']) {
   const localRevision=member.localRevision+(owned.marker.terminalValidation?0:1);
   const target=path.join(owned.root,group,`${member.slice}.md`),before=(await readOwnedFile(target)).bytes.toString('utf8');
   const supplied=before.match(/^- Delivery ID: (.+)$/mu)?.[1],local=before.match(/^- Local revision: (.+)$/mu)?.[1];
   if(supplied&&supplied!=='runtime'&&supplied!==member.deliveryId)fail('OWNER_UNCERTAIN','Delivery identity differs from its official source');
   if(local&&local!=='runtime'&&local!==String(localRevision))fail('STALE_BASE','Local revision differs from its official source');
   let text=supplied?before.replace(/^- Delivery ID: .+$/mu,'- Delivery ID: '+member.deliveryId):before.replace('## References\n\n','## References\n\n- Delivery ID: '+member.deliveryId+'\n');
   text=writeRevision(text,source.files.get(`${group}/${member.slice}.md`));
   text=local?text.replace(/^- Local revision: .+$/mu,'- Local revision: '+localRevision):text.replace(/^- Plan revision: .+$/mu,line=>line+'\n- Local revision: '+localRevision);
   await fs.writeFile(target,text);
  }
  await capturePreparationSource(await assertPreparationCandidate(owned.root,owned.marker.specPath,{filesystemContext}));
  return {status:'DRAFT',candidateExecutionRoot:owned.root,logicalAuthorityPath:context.logicalAuthorityPath};
 }
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
