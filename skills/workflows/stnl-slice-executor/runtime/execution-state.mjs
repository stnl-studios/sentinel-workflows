// Public execution access is current EC-1 only. Physical workspace/requirements
// utilities are independent of any execution interpreter.
export * from './execution-workspace.mjs';
import {captureCurrentExecution,captureCompletedRevalidationSource,inspectCurrentExecution} from './execution-current-reader.mjs';
import {createHash} from 'node:crypto';
import {ExecutionContractError} from './execution-workspace.mjs';
export const EXECUTION_WORKFLOW_SKILLS=Object.freeze({PLAN:'stnl-execution-planner',REVIEW_PLAN:'stnl-plan-reviewer',REPLAN:'stnl-execution-planner',EXECUTE_SLICE:'stnl-slice-executor',APPLY_FINDINGS:'stnl-slice-executor',VALIDATE_SLICE:'stnl-slice-quality-manager'});
export const inspectExecutionState=inspectCurrentExecution;
// Exact physical observations only; this digest grants no evidence validity.
export function currentObservedWorkBasisSha256(observedByDelivery) {
 const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)
  ?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
 const basis=[...observedByDelivery].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([deliveryId,value])=>({deliveryId,manifest:value.manifest}));
 return 'sha256:'+createHash('sha256').update('stnl-completed-revalidation-basis-v1\0'+canonical(basis)).digest('hex');
}
// This is a quiet source gate, not terminal judgment or replacement admission.
export async function captureCurrentSetReplacementSource(specPath,{revalidateCompletedIds=null}={}) {
 const source=revalidateCompletedIds===null?await captureCurrentExecution(specPath)
  :await captureCompletedRevalidationSource(specPath,revalidateCompletedIds),image=source.inspection;
 const members=[...image.deliveries,...image.completed];
 // The authenticated reader can offer a future integral judgment even when
 // every local proof is current. That offer is not an active operation and
 // must not prevent explicitly requested Q18 preparation. Admit only its exact
 // missing-terminal diagnosis; stale terminal or local work still blocks here.
 const missingTerminalHandoff=image.normalHandoff?.operation==='VALIDATE_SLICE'
  &&image.deliveries.some(item=>item.slice===image.normalHandoff.slice
   &&item.deliveryId===image.normalHandoff.deliveryId)
  &&image.diagnostics.length===1
  &&image.diagnostics[0].kind==='evidence'
  &&image.diagnostics[0].artifact==='continuity.json'
  &&image.diagnostics[0].field==='terminal'
  &&image.diagnostics[0].reason==='EVIDENCE_INCOMPLETE: local PASS has no terminal judgment';
 if(!source.activationBytes||!members.length||image.normalHandoff!==null&&!missingTerminalHandoff
   ||members.some(item=>item.persistedValidation!=='current'||item.formalStatus!=='PASS'
    ||item.observedValidation!=='current'&&!revalidateCompletedIds?.includes(item.deliveryId)))
  throw Object.assign(new ExecutionContractError('Set preparation requires a quiet inspected current PASS for every member'),{code:'REPLAN_REQUIRED'});
 if(revalidateCompletedIds!==null) {
  source.revalidationBasisSha256=currentObservedWorkBasisSha256(source.observedByDelivery);
 }
 return source;
}
export async function readExecutionActivation(specPath) {
 const image=await captureCurrentExecution(specPath);
 if(!image.activationBytes)throw Object.assign(new ExecutionContractError('No approved current execution'),{code:'EVIDENCE_INCOMPLETE'});
 return {...image,activation:JSON.parse(Buffer.from(image.activationBytes)),snapshot:JSON.parse(Buffer.from(image.files.get('approved-preparation.json')))};
}
export async function preflightExecutionOperation(specPath,operation,slice=null) {
 if(operation==='REPLAN') {
  if(slice!==null)throw Object.assign(new ExecutionContractError('REPLAN prepares the captured set without a slice handoff'),{code:'OWNER_UNCERTAIN'});
  return {...(await captureCurrentSetReplacementSource(specPath)).inspection,operation,slice:null};
 }
 const image=await inspectCurrentExecution(specPath);
 if(operation==='PLAN'&&image.state==='NO_EXECUTION')return {...image,operation,slice:null};
 if(!EXECUTION_WORKFLOW_SKILLS[operation]||image.normalHandoff?.operation!==operation||(slice!==null&&image.normalHandoff?.slice!==slice))throw Object.assign(new ExecutionContractError('Operation is not the exact current EC-1 handoff'),{code:'OWNER_UNCERTAIN'});
 return {...image,operation,slice:image.normalHandoff.slice};
}
export function workflowSkillForOperation(operation){return EXECUTION_WORKFLOW_SKILLS[operation]??null;}
export function deriveNormalHandoff(result){return result.normalHandoff??null;}
