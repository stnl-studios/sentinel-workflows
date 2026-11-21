import {executionOverlap} from './report.mjs';
import {effectiveRoleBindings} from './case-profile.mjs';
import fs from 'node:fs';import path from 'node:path';
import{confined,sha256,writeOnce,digest,validateProfile}from'./core.mjs';
import{buildQualification,qualificationDigest,checkBindingReasons,campaignConcurrency}from'./qualification.mjs';
/** Identity of the reusable harness, separate from target source/profile. */
export function harnessIdentityFromCampaign(identity){if(!identity||typeof identity.contextPolicy!=='string'||!identity.contextPolicy||typeof identity.adapterProtocol!=='string'||!identity.adapterProtocol)throw Error('CAMPAIGN_POLICY_IDENTITY_REQUIRED');const out=Object.fromEntries(['engine','fixture','scenarioOracle','cliVersion'].map(k=>[k,identity[k]]));return{...out,contextPolicy:qualificationDigest(identity.contextPolicy),adapterProtocol:qualificationDigest(identity.adapterProtocol)};}
function refs(value,label,out,seen=new Set(),requiresLive=false){if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);requiresLive=requiresLive||value.scope==='live';if(Object.hasOwn(value,'ref')&&Object.hasOwn(value,'sha256'))out.push({proof:value,label,requiresLive});for(const[k,v]of Object.entries(value))refs(v,label+'/'+k,out,seen,requiresLive)}
const hashPattern=/^(?:sha256:)?[a-f0-9]{64}$/;
/** A requested setting is not evidence of actual simultaneous execution. */
function verifiedParallelSchedule(saved,campaign,slots,doc){
 const {caseIds,repetitions,startedAt,finishedAt,dispatches}=saved;
 if(saved.profile?.concurrency!==slots||digest(saved.profile)!==campaign.identity.profile||
    !Array.isArray(caseIds)||!caseIds.length||!Number.isSafeInteger(repetitions)||repetitions<1||
    repetitions*caseIds.length!==campaign.results.length||![startedAt,finishedAt].every(Number.isFinite)||
    finishedAt<startedAt||!Array.isArray(dispatches)||dispatches.length!==campaign.results.length)return false;
 const slotEnds=new Map(),usedTurns=new Set();
 const refs=campaign.turnProofs;
 if(!refs||Object.keys(refs).length!==dispatches.length)return false;
 for(const [i,d] of dispatches.entries()){
  if(d?.queueIndex!==i||d.caseId!==caseIds[i%caseIds.length]||d.repetition!==Math.floor(i/caseIds.length)+1||
     !Number.isSafeInteger(d.slot)||d.slot<1||d.slot>slots||
     ![d.startedAt,d.executionStartedAt,d.executionFinishedAt,d.finishedAt].every(Number.isFinite)||
     !(startedAt<=d.startedAt&&d.startedAt<=d.executionStartedAt&&d.executionStartedAt<d.executionFinishedAt&&
       d.executionFinishedAt<=d.finishedAt&&d.finishedAt<=finishedAt)||
     (i>0&&d.startedAt<dispatches[i-1].startedAt)||(slotEnds.get(d.slot)??startedAt)>d.startedAt||
     !Array.isArray(d.providerWindows)||!d.providerWindows.length)return false;
  let previous=d.executionStartedAt,previousIndex=0;
  const cell=d.caseId+'-'+d.repetition,proofs=refs[cell];
  if(!Array.isArray(proofs)||proofs.length!==d.providerWindows.length)return false;
  for(const [j,w] of d.providerWindows.entries()){
   if(!Number.isSafeInteger(w?.index)||w.index<=previousIndex||typeof w.threadId!=='string'||!w.threadId||
      typeof w.turnId!=='string'||!w.turnId||!Number.isFinite(w.startedAt)||!Number.isFinite(w.finishedAt)||
      !(previous<=w.startedAt&&w.startedAt<w.finishedAt&&w.finishedAt<=d.executionFinishedAt))return false;
   const root='evidence/campaigns/'+campaign.id+'/'+cell+'/turn-'+w.index;
   const pair=proofs[j],request=doc(pair?.request),result=doc(pair?.result);
   const turnKey=JSON.stringify([w.threadId,w.turnId]);
   if(pair?.request?.ref!==root+'-request.json'||pair?.result?.ref!==root+'-result.json'||
      request?.threadId!==w.threadId||result?.threadId!==w.threadId||result?.turnId!==w.turnId||
      result?.status!=='completed'||!result.providerWindow||qualificationDigest(result.providerWindow)!==qualificationDigest(w)||
      usedTurns.has(turnKey))return false;
   usedTurns.add(turnKey);previous=w.finishedAt;previousIndex=w.index;
  }
  slotEnds.set(d.slot,d.finishedAt);
 }
 return executionOverlap(dispatches)===slots;
}
/** Hash actual bytes through pinned file descriptor. Every ancestor must be owned,
 * non-symlink, under BASE/evidence. No providers, credentials, or external I/O. */
export function verifyQualificationEvidence({base,qualification,targetProof}={}){
 const reasons=[],verified=[],all=[],documents=new Map();let evidence;
 try{base=fs.realpathSync.native(base);evidence=confined(base,'evidence');if(!fs.statSync(evidence).isDirectory())throw Error('EVIDENCE_ROOT_INVALID')}catch(e){return{status:'BLOCKED',reasons:[String(e.message)],verified}}
 if(!qualification&&!targetProof)reasons.push('PROOF_INPUT_REQUIRED');refs(qualification,'qualification',all);refs(targetProof,'targetProof',all);
 if(targetProof&&(targetProof.scope==='SIMULATED'||Object.values(targetProof.checks??{}).some(c=>c.status==='SIMULATED')))reasons.push('TARGET_SIMULATED_NOT_ADMISSIBLE');
 const observed=new Map();
 for(const{proof,label,requiresLive}of all){let fd;try{
  if(typeof proof.ref!=='string'||!proof.ref.startsWith('evidence/')||proof.ref.includes('\\')||proof.ref.split('/').some(x=>!x||x==='.'||x==='..')||/[\x00-\x1f\x7f]/.test(proof.ref)||!hashPattern.test(proof.sha256??''))throw Error('INVALID_PROOF_REF');
  const expected=proof.sha256.replace(/^sha256:/,''),previous=observed.get(proof.ref);if(previous&&previous!==expected)throw Error('PROOF_HASH_CONFLICT');observed.set(proof.ref,expected);
  const file=confined(evidence,path.relative(evidence,path.resolve(base,proof.ref))),before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink())throw Error('PROOF_NOT_REGULAR_FILE');
  fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const opened=fs.fstatSync(fd);if(opened.dev!==before.dev||opened.ino!==before.ino)throw Error('PROOF_IDENTITY_CHANGED');const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(file);if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||named.ino!==opened.ino||named.dev!==opened.dev)throw Error('PROOF_CHANGED_DURING_READ');const actual=sha256(bytes);if(actual!==expected)throw Error('PROOF_BYTES_MISMATCH');
  if(requiresLive){let document;try{document=JSON.parse(bytes)}catch{}if(['SIMULATED','simulated'].includes(document?.scope)||document?.status==='SIMULATED')throw Error('LIVE_PROOF_IS_SIMULATED');}
  if(label.startsWith('targetProof')){let document;try{document=JSON.parse(bytes)}catch{throw Error('TARGET_PROOF_NOT_JSON')}if(document.scope==='SIMULATED'||document.status==='SIMULATED'||document.targetProof?.scope==='SIMULATED')throw Error('TARGET_SIMULATED_NOT_ADMISSIBLE');if(document.scope!=='REAL')throw Error('TARGET_REAL_SCOPE_UNPROVEN');}
  try{documents.set(proof.ref,JSON.parse(bytes))}catch{}
  verified.push({ref:proof.ref,sha256:actual,label,bytes:bytes.length});
 }catch(e){reasons.push(`${e.message}:${label}:${String(proof.ref)}`)}finally{if(fd!==undefined)fs.closeSync(fd)}}
 const eq=(a,b)=>qualificationDigest(a??null)===qualificationDigest(b??null);
 const doc=proof=>proof?.ref?documents.get(proof.ref):null;
 const fields=(a,b,keys)=>keys.every(k=>a&&b&&Object.hasOwn(a,k)&&Object.hasOwn(b,k)&&eq(a[k],b[k]));
 for(const campaign of qualification?.campaigns??[]){const saved=doc(campaign.proof)?.campaign??doc(campaign.proof);if(!fields(saved,campaign,['id','mode','identity'])){reasons.push('CAMPAIGN_PROOF_BINDING:'+campaign.id);continue}
  const declared=saved.plannedCells??(Array.isArray(saved.caseIds)&&Number.isSafeInteger(saved.repetitions)?saved.caseIds.flatMap(caseId=>Array.from({length:saved.repetitions},(_,i)=>({caseId,repetition:i+1}))):null);
  const cells=a=>Array.isArray(a)?a.map(r=>`${r.caseId}/${r.repetition}`).sort():null;
  if(!eq(cells(declared),cells(campaign.plannedCells))||!eq(cells(saved.results),cells(campaign.results)))reasons.push('CAMPAIGN_CELL_BINDING:'+campaign.id);
  const parallelism=campaignConcurrency(campaign.identity);
  if(saved.profile&&(digest(saved.profile)!==campaign.identity.profile||saved.profile.concurrency!==parallelism))reasons.push('CAMPAIGN_CONCURRENCY_PROFILE_BINDING:'+campaign.id);
  if(parallelism>1&&!verifiedParallelSchedule(saved,campaign,parallelism,doc))reasons.push('PARALLEL_EXECUTION_UNPROVEN:'+campaign.id);
  for(const result of campaign.results??[]){const row=saved.results?.find(r=>r.caseId===result.caseId&&r.repetition===result.repetition),bytes=doc(result.proof)?.result??doc(result.proof);const core=['caseId','repetition','status','closed','oracle','measurement'];
   if(!fields(row,result,[...core,'harnessValid'])||!fields(bytes,result,core))reasons.push(`RESULT_PROOF_BINDING:${campaign.id}/${result.caseId}/${result.repetition}`);
   if(result.admissionProof){const admission=doc(result.admissionProof);if(!admission||admission.harnessValid!==result.harnessValid||!eq(admission.identityAtStart,campaign.identity)||!eq(admission.identityAtEnd,campaign.identity))reasons.push('RESULT_ADMISSION_BINDING:'+result.proof?.ref)}
  }
 }
 for(const check of qualification?.checks??[]){
  reasons.push(...checkBindingReasons(check,qualification.harnessIdentity));
  const saved=doc(check.proof),matches=Array.isArray(saved?.checks)?saved.checks.filter(x=>x?.id===check.id):null;
  const observed=saved?.check??(matches?.length===1?matches[0]:matches?null:saved);
  if(!fields(observed,check,['id','pass','scope','harnessIdentity','dependencies']))reasons.push('CHECK_PROOF_BINDING:'+check.id);
  // Dependencies are declared in the descriptor, so the confined byte-verifier above
  // reads every one. Exact wrapper equality forbids silently omitted dependencies.
 }
 if(targetProof){const c=targetProof.checks??{},g=doc(c.gitSnapshot?.proof),p=doc(c.profile?.proof),m=doc(c.modelSupport?.proof),s=doc(c.securityContext?.proof),r=doc(c.protocolCompatibility?.proof);
  if(!g?.source||g.source.revision!==c.gitSnapshot?.revision||g.source.tree!==c.gitSnapshot?.gitTree||g.source.sha256TreeDigest!==c.gitSnapshot?.treeDigest)reasons.push('TARGET_GIT_CONTENT_BINDING');
  try{validateProfile(p?.profile)}catch{reasons.push('TARGET_PROFILE_INVALID')}
  if(!p?.profile||p.profileDigest!==c.profile?.profileDigest||digest(p.profile)!==c.profile?.profileDigest)reasons.push('TARGET_PROFILE_CONTENT_BINDING');
  let profileRoles=[];try{profileRoles=effectiveRoleBindings(p?.profile)}catch{reasons.push('TARGET_EFFECTIVE_ROLE_PROFILE_INVALID')}const sortedRoles=roles=>Array.isArray(roles)?[...roles].sort((a,b)=>String(a.role).localeCompare(String(b.role))):null;
  if(!eq(sortedRoles(profileRoles),sortedRoles(c.modelSupport?.roles)))reasons.push('TARGET_ROLE_PROFILE_BINDING');
  if(!eq(m?.roles,c.modelSupport?.roles)||!Array.isArray(m?.listing)||c.modelSupport?.roles?.some(role=>!m.listing.some(item=>(item.model===role.model||item.id===role.model)&&item.supportedReasoningEfforts?.some(e=>e.reasoningEffort===role.effort))))reasons.push('TARGET_MODEL_CONTENT_BINDING');
  if(s?.contextPolicyDigest!==c.securityContext?.contextPolicyDigest||s?.profileDigest!==c.securityContext?.profileDigest||!Array.isArray(s?.observed)||!s.observed.length)reasons.push('TARGET_SECURITY_CONTENT_BINDING');
  else for(const role of c.modelSupport?.roles??[]){const observations=s.observed.filter(o=>o.roles?.includes(role.role));if(!observations.length||observations.some(o=>o.model!==role.model||o.reasoningEffort!==role.effort||o.approvalPolicy!=='never'||o.sandbox?.networkAccess!==false||o.sandbox?.type!==((role.logicalRole??role.role)==='plan_approver'?'readOnly':'workspaceWrite')||(role.logicalRole??role.role)!=='plan_approver'&&o.sandbox.excludeSlashTmp!==true))reasons.push('TARGET_SECURITY_ROLE_BINDING:'+role.role)}
  if(r?.cliVersion!==c.protocolCompatibility?.cliVersion||!eq(r?.capabilities,c.protocolCompatibility?.requiredCapabilities)||r?.runtime?.contractDigest!==c.protocolCompatibility?.sentinelRuntimeContractDigest||!Array.isArray(r?.schemaProof)||!r.schemaProof.length)reasons.push('TARGET_PROTOCOL_CONTENT_BINDING');
  if(Array.isArray(r?.schemaProof)&&r.schemaProof.length){const schemaRefs=r.schemaProof.map(s=>({ref:s.file,sha256:s.sha256})),checked=verifyQualificationEvidence({base,qualification:{schemaRefs}});if(checked.status!=='PASS')reasons.push('TARGET_PROTOCOL_SCHEMA_BYTES',...checked.reasons);else{const client=schemaRefs.find(p=>p.ref.endsWith('/ClientRequest.json'));if(!client)reasons.push('TARGET_PROTOCOL_SCHEMA_REQUESTS_MISSING');else{try{const schema=JSON.parse(fs.readFileSync(confined(evidence,path.relative(evidence,path.resolve(base,client.ref))))),advertised=schema.oneOf?.flatMap(x=>x.properties?.method?.enum??[])??[];if(c.protocolCompatibility.requiredCapabilities.some(m=>!advertised.includes(m)))reasons.push('TARGET_PROTOCOL_SCHEMA_CAPABILITY_MISMATCH')}catch{reasons.push('TARGET_PROTOCOL_SCHEMA_INVALID')}}}}

 }
 if(!all.length)reasons.push('PROOF_REFS_REQUIRED');
 return{status:reasons.length?'BLOCKED':'PASS',reasons:[...new Set(reasons)],verified,limitations:['Checks actual referenced bytes and scope, not truth of every claim inside them.','Does not execute models, certify task outcomes, or promote diagnostics.']};
}
/** Writes a certificate only after reference decision and real byte verification pass. */
export function createQualification({base,identity,harnessIdentity,campaigns,checks,evidenceDir}={}){
 const qualification=buildQualification({identity,harnessIdentity:harnessIdentity??harnessIdentityFromCampaign(identity),campaigns,checks});
 const evidenceVerification=verifyQualificationEvidence({base,qualification});
 if(qualification.status!=='QUALIFIED'||evidenceVerification.status!=='PASS')return{status:'BLOCKED',reasons:[...qualification.reasons,...evidenceVerification.reasons],qualification:null,evidenceVerification,file:null};
 base=fs.realpathSync.native(base);const evidence=confined(base,'evidence'),directory=confined(evidence,path.relative(evidence,path.resolve(base,evidenceDir)));fs.mkdirSync(directory,{recursive:true});const file=confined(directory,'qualification.json');writeOnce(file,qualification);
 return{status:'QUALIFIED',file,qualification,evidenceVerification};
}
