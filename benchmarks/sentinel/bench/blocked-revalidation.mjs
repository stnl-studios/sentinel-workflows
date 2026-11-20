import fs from 'node:fs';
import path from 'node:path';
import {confined,sha256,budgetDecision} from './core.mjs';
import {qualificationDigest} from './qualification.mjs';

export const DEFAULT_BLOCKED_REVALIDATION_POLICY=Object.freeze({enabled:false,maxAttempts:1,allowedPrerequisites:Object.freeze(['stable-verification-launcher'])});
const equal=(a,b)=>qualificationDigest(a??null)===qualificationDigest(b??null);
const hash=s=>typeof s==='string'&&/^(?:sha256:)?[a-f0-9]{64}$/.test(s);
const normalized=s=>s?.replace(/^sha256:/,'');
/** Only reads pinned, regular files beneath the case workspace. No runtime invocation,
 * full environment, agent reasoning, credentials, writes or provider requests. */
export function collectBlockedRevalidationProof({manifest,authority,slice,receiptPath,requestPath,launcherProofPath}={}){
 const report={schemaVersion:1,kind:'benchmark-blocked-revalidation-observation',status:'BLOCKED',reasons:[],files:[]};
 try{
  const workspace=fs.realpathSync.native(manifest.workspace);
  const spec=confined(workspace,manifest.specPath);
  if(authority?.specPath!==spec||authority?.current?.exitCode!==0)throw Error('AUTHORITY_SPEC_BINDING');
  const read=(file,root=workspace)=>{
   file=confined(root,file);
   const before=fs.lstatSync(file);if(!before.isFile()||before.size>16*1024*1024)throw Error('PROOF_FILE_INVALID');
   const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
   try{
    const opened=fs.fstatSync(fd);if(opened.ino!==before.ino||opened.dev!==before.dev)throw Error('PROOF_IDENTITY_CHANGED');
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),named=fs.lstatSync(file);
    if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||named.ino!==opened.ino||named.dev!==opened.dev)throw Error('PROOF_CHANGED_DURING_READ');
    const proof={path:file,sha256:sha256(bytes)};report.files.push(proof);return{data:JSON.parse(bytes),proof};
   }finally{fs.closeSync(fd)}
  };
  const execution=confined(spec,'execution'),activationRead=read(path.join(execution,'activation.json')),activation=activationRead.data;
  const artifact=name=>{
   const entry=activation.artifacts?.find(x=>x.path===name);if(!entry||!hash(entry.sha256))throw Error('ACTIVATION_ARTIFACT_MISSING');
   const result=read(confined(execution,name));if(normalized(entry.sha256)!==result.proof.sha256)throw Error('ACTIVATION_ARTIFACT_HASH');return result.data;
  };
  const continuity=artifact('continuity.json'),snapshot=artifact('approved-preparation.json');
  const selected=continuity.deliveries?.find(x=>x.slice===slice),facts=authority.current.output.deliveries?.find(x=>x.slice===slice);
  if(!selected?.evidence||!facts||facts.deliveryId!==selected.deliveryId)throw Error('DELIVERY_BINDING');
  const bundle=artifact(selected.evidence.path);
  if(normalized(selected.evidence.sha256)!==normalized(facts.evidenceSha256)||normalized(selected.evidence.sha256)!==report.files.at(-1).sha256)throw Error('EVIDENCE_BINDING');
  const operation=confined(confined(workspace,'tmp/sentinel'),path.dirname(receiptPath));
  if(path.dirname(requestPath)!==operation||path.dirname(receiptPath)!==operation)throw Error('OPERATION_PATH_BINDING');
  const receipt=read(receiptPath).data,request=read(requestPath).data;
  const origin=bundle.validation?.origin;
  if(!origin||!equal(receipt.owner,request.owner)||receipt.owner?.operationAttemptId!==origin.operationAttemptId||receipt.owner?.deliveryId!==selected.deliveryId||receipt.owner?.slice!==slice||receipt.operation!=='VALIDATE_SLICE'||request.owner?.operation!=='VALIDATE_SLICE')throw Error('PREDECESSOR_OWNER_BINDING');
  if(activation.activationId!==authority.current.output.activationId)throw Error('ACTIVATION_BINDING');
  report.observation={
   specPath:spec,slice,deliveryId:selected.deliveryId,activationId:activation.activationId,
   activeAttempt:activation.activeAttempt,lastAttempt:activation.lastAttempt,
   normalization:selected.normalization,resumption:snapshot.resumption??null,
   evidenceSha256:selected.evidence.sha256,originOperationAttemptId:origin.operationAttemptId,
   supportKinds:bundle.support?.map(x=>x.kind)??null,
   receiptStatus:receipt.status,semanticStatus:receipt.semanticResponseStatus,captureFailure:receipt.captureFailure,error:receipt.error,
   verificationStatus:receipt.verification?.status,
   terminal:request.terminal!==null&&request.terminal!==undefined,
   authorityDigest:qualificationDigest(authority)
  };
  report.observation.workUnchanged=false;
  const entries=bundle.validation?.testedWork?.entries;
  if(Array.isArray(entries)&&entries.length){
   report.observation.workUnchanged=entries.every(entry=>{
    const file=confined(workspace,entry.path),stat=fs.lstatSync(file);
    if(entry.kind==='file')return stat.isFile()&&(stat.mode&0o777)===entry.mode&&normalized(entry.sha256)===sha256(fs.readFileSync(file));
    if(entry.kind==='directory')return stat.isDirectory()&&equal(fs.readdirSync(file).sort(),[...(entry.children??[])].sort());
    return false;
   });
  }
  if(launcherProofPath){
   const evidence=fs.realpathSync.native(manifest.evidence);
   const launcher=read(launcherProofPath,evidence);
   const p=launcher.data,observations=p.observations;
   report.launcher={
    proof:launcher.proof,
    status:p.kind==='stable-verification-launcher-probe'&&p.scope==='LOCAL_NO_RECIPE'&&p.predecessorEvidenceSha256===selected.evidence.sha256&&p.authorityDigest===report.observation.authorityDigest
     &&p.launcher==='direct-node-no-shell-tail'&&Array.isArray(observations)&&observations.length===2
     &&observations.every(x=>x.exitCode===0&&hash(x.environmentSha256)&&Array.isArray(x.argv)&&x.argv.length===2&&path.isAbsolute(x.argv[0])&&path.isAbsolute(x.argv[1]))
     &&equal(observations[0].argv,observations[1].argv)&&observations[0].environmentSha256===observations[1].environmentSha256?'STABLE_OBSERVED':'UNPROVEN',
    launcher:p.launcher
   };
  }
  report.status='OBSERVED';
 }catch(error){report.reasons.push(String(error.message))}
 report.digest=qualificationDigest(report);
 return report;
}

/** Pure fail-closed planner. A supplied observation is a claim; caller must use the
 * collector and preserve its bytes. No decision here is an official Sentinel receipt. */
export function decideBlockedRevalidation({policy=DEFAULT_BLOCKED_REVALIDATION_POLICY,authority,checkpoint,identity,delegation,proof,budget,now=Date.now(),prerequisite}={}){
 const reasons=[],c=authority?.current?.output,o=proof?.observation;
 if(policy?.enabled!==true)reasons.push('POLICY_DISABLED');
 if(policy?.maxAttempts!==1||!equal(policy?.allowedPrerequisites,['stable-verification-launcher']))reasons.push('POLICY_INVALID');
 if(!identity||!checkpoint?.identity||!equal(identity,checkpoint.identity))reasons.push('IDENTITY_BINDING');
 if(checkpoint?.pending!==null||checkpoint?.pendingEffect!==null)reasons.push('UNSETTLED_EFFECT');
 if(checkpoint?.blockedRevalidationAttempts!==0)reasons.push('RETRY_CREDIT_UNAVAILABLE');
 if(checkpoint?.lastCompletedAttempt?.stage!=='VALIDATE_SLICE'||checkpoint?.lastCompletedAttempt?.status!=='completed'||!checkpoint.lastCompletedAttempt.threadId||!checkpoint.lastCompletedAttempt.turnId)reasons.push('COMPLETED_VALIDATION_REQUIRED');
 if(!delegation||delegation.kind!=='explicit-user-delegation'||delegation.action!=='revalidate-concluded-formal-blocked'||!delegation.instructionRef||delegation.caseId!==checkpoint?.caseId||delegation.identityDigest!==qualificationDigest(identity??null))reasons.push('DELEGATED_AUTHORIZATION_REQUIRED');
 const budgetResult=budgetDecision({...budget,now},budget?.limits);
 if(budgetResult!=='ALLOW')reasons.push('BUDGET_'+budgetResult);
 if(!Number.isFinite(checkpoint?.originalCaseDeadline)||!Number.isFinite(checkpoint?.originalCampaignDeadline)||budget?.caseDeadline!==checkpoint?.originalCaseDeadline||budget?.campaignDeadline!==checkpoint?.originalCampaignDeadline)reasons.push('ORIGINAL_DEADLINE_BINDING');
 const {digest,...body}=proof??{};
 if(proof?.status!=='OBSERVED'||digest!==qualificationDigest(body)||!o||o.authorityDigest!==qualificationDigest(authority??null))reasons.push('COLLECTED_PROOF_REQUIRED');
 if(authority?.current?.exitCode!==0||c?.state!=='VALIDATION_BLOCKED'||c?.normalHandoff!==null)reasons.push('FORMAL_BLOCKED_STATE_REQUIRED');
 const delivery=c?.deliveries?.find(d=>d.deliveryId===o?.deliveryId&&d.slice===o?.slice);
 if(delivery?.formalStatus!=='BLOCKED'||delivery?.auxiliaryStatus==='BLOCKED'||delivery?.observedValidation==='uncertain'||!equal(delivery?.evidenceSha256,o?.evidenceSha256))reasons.push('BLOCKED_DELIVERY_BINDING');
 if([...(c?.deliveries??[]),...(c?.completed??[])].some(d=>d.deliveryId!==o?.deliveryId&&(d.formalStatus==='BLOCKED'||d.auxiliaryStatus==='BLOCKED'||d.observedValidation==='uncertain'||d.diagnostics?.length)))reasons.push('OTHER_UNRESOLVED_DELIVERY');
 if(!o||o.activeAttempt!==null||o.normalization!==null||o.resumption!==null||o.lastAttempt?.outcome!=='recorded'||o.lastAttempt?.operationAttemptId!==o.originOperationAttemptId||!Array.isArray(o.supportKinds)||o.supportKinds.includes('rejection')||o.receiptStatus!=='RUNNER_RESPONSE_CAPTURED'||o.semanticStatus!=='BLOCKED'||o.captureFailure!==null||o.error!==null||o.verificationStatus!=='completed')reasons.push('CONCLUDED_PUBLISHED_BLOCKED_REQUIRED');
 if(checkpoint?.lastCompletedAttempt?.operationAttemptId!==o?.originOperationAttemptId||checkpoint?.lastCompletedAttempt?.slice!==o?.slice||checkpoint?.lastCompletedAttempt?.deliveryId!==o?.deliveryId)reasons.push('TERMINAL_ATTEMPT_BINDING');
 if(prerequisite?.kind!=='stable-verification-launcher')reasons.push('PREREQUISITE_UNSUPPORTED');
 if(proof?.launcher?.status!=='STABLE_OBSERVED')reasons.push('STABLE_LAUNCHER_PROOF_REQUIRED');
 if(o?.workUnchanged!==true)reasons.push('UNCHANGED_PRODUCT_PROOF_REQUIRED');
 return{schemaVersion:1,kind:'benchmark-revalidation-decision-not-sentinel-receipt',status:reasons.length?'BLOCKED':'CONDITIONAL_REVALIDATION_REQUEST',mode:'diagnostic-manual',reasons:[...new Set(reasons)],target:o?{specPath:o.specPath,slice:o.slice,deliveryId:o.deliveryId,activationId:o.activationId,terminal:o.terminal,predecessorEvidenceSha256:o.evidenceSha256}:null,proofDigest:proof?.digest??null,dispatchAllowed:false,officialAdmissionRequired:true,limitations:['Stable launcher observations support a new controlled hypothesis test, not proof of historical causal resolution.','Explicit authorization does not replace official begin --retry-blocked admission.','No new owner, thread, recipe, publication or retry is executed.']};
}

export function blockedRevalidationPrompt({decision}={}){
 if(decision?.kind!=='benchmark-revalidation-decision-not-sentinel-receipt'||decision.dispatchAllowed!==false)throw Error('INVALID_REVALIDATION_DECISION');
 if(decision.status!=='CONDITIONAL_REVALIDATION_REQUEST')return 'STOP: diagnóstico apenas; condições não comprovadas. Não executar begin, recipe ou novo reviewer. Não inventar normalHandoff nem alterar recibos.';
 return 'Pedido condicional de NOVA revalidação, não PASS nem recibo Sentinel: '+JSON.stringify(decision.target)+'. Confirme autorização delegada, pré-requisitos, produto/autoridade inalterados, prazo e orçamento originais. Consuma a única oportunidade antes de agir. Use quality manager e begin --retry-blocked oficial; pare se recusado. Não inventar normalHandoff. Novo owner/origin e novo revisor independente; preserve alvo terminal/local anterior e todos os recibos BLOCKED. Use launcher direto Node sem comandos posteriores, capturando saída no transporte. Não repita o produtor ou receita anterior, nem altere controles. Contexto estável testa hipótese, não prova causa histórica; qualquer incerteza bloqueia.';
}
