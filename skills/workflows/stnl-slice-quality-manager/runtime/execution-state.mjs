// Public execution access is current EC-1 only. Physical workspace/requirements
// utilities are independent of any execution interpreter.
export * from './execution-workspace.mjs';
import {captureCurrentExecution,inspectCurrentExecution} from './execution-current-reader.mjs';
import {ExecutionContractError} from './execution-workspace.mjs';
export const EXECUTION_WORKFLOW_SKILLS=Object.freeze({PLAN:'stnl-execution-planner',REVIEW_PLAN:'stnl-plan-reviewer',REPLAN:'stnl-execution-planner',EXECUTE_SLICE:'stnl-slice-executor',APPLY_FINDINGS:'stnl-slice-executor',VALIDATE_SLICE:'stnl-slice-quality-manager'});
export const inspectExecutionState=inspectCurrentExecution;
// This is a quiet source gate, not terminal judgment or replacement admission.
export async function captureCurrentSetReplacementSource(specPath) {
 const source=await captureCurrentExecution(specPath),image=source.inspection;
 const members=[...image.deliveries,...image.completed];
 if(!source.activationBytes||!members.length||image.normalHandoff!==null
   ||members.some(item=>item.persistedValidation!=='current'||item.observedValidation!=='current'||item.formalStatus!=='PASS'))
  throw Object.assign(new ExecutionContractError('Set preparation requires a quiet inspected current PASS for every member'),{code:'REPLAN_REQUIRED'});
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
