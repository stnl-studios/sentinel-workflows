/** Keep only public failure/progress metadata, never reasoning, auth or command output. */
export function failureObservation(payload){
 const p=payload?.params??{},method=payload?.method,threadId=p.threadId,turnId=p.turnId??p.turn?.id;
 if(typeof threadId!=='string'||!threadId||typeof turnId!=='string'||!turnId)return null;
 const params={threadId,turnId};
 if(method==='error'){
  const e=p.error??{};
  params.error={capacityObserved:e.capacityObserved===true||/selected model is at capacity/i.test(String(e.additionalDetails??'')+' '+String(e.message??'')),streamDisconnected:e.streamDisconnected===true||!!e.codexErrorInfo?.responseStreamDisconnected};
  params.willRetry=p.willRetry===true;
 }else if(method==='turn/completed')params.turn={id:turnId,status:p.turn?.status??null};
 else if(method==='item/completed'&&['commandExecution','agentMessage'].includes(p.item?.type)){
  const i=p.item;params.item={type:i.type,exitCode:i.exitCode??null,sandboxDenied:i.sandboxDenied===true||i.exitCode===71&&String(i.aggregatedOutput??'').includes('sandbox_apply: Operation not permitted'),hasOutput:i.hasOutput===true||i.type==='agentMessage'&&typeof i.text==='string'&&i.text.trim().length>0};
 }else if(method==='item/agentMessage/delta')params.progress=typeof p.delta==='string'&&p.delta.length>0||p.progress===true;
 else return null;
 return{method,params};
}
function availabilityFor(events,terminalAttempt){
 if(typeof terminalAttempt?.threadId!=='string'||!terminalAttempt.threadId||typeof terminalAttempt?.turnId!=='string'||!terminalAttempt.turnId)return{events:[],availability:null};
 const scoped=events.map(failureObservation).filter(e=>e&&e.params.threadId===terminalAttempt.threadId&&e.params.turnId===terminalAttempt.turnId);
 const last=scoped.findLastIndex(e=>e.method==='error'&&e.params.error.capacityObserved);
 if(last<0)return{events:scoped,availability:null};
 const subsequent=scoped.slice(last+1),resolved=terminalAttempt.status==='completed'||subsequent.some(e=>e.method==='turn/completed'&&e.params.turn.status==='completed');
 const progress=subsequent.some(e=>e.params.progress||e.method==='item/completed'&&(e.params.item.type==='commandExecution'&&e.params.item.exitCode===0||e.params.item.type==='agentMessage'&&e.params.item.hasOutput));
 return{events:scoped,availability:{code:'MODEL_CAPACITY_OBSERVED',status:resolved?'RESOLVED':progress?'PROGRESS_AFTER_ERROR':'UNRESOLVED',threadId:terminalAttempt.threadId,turnId:terminalAttempt.turnId,willRetry:scoped[last].params.willRetry,causality:'Observed provider condition; not proof of exclusive cause.'}};
}
/** Classification preserves the evidence and does not turn model prose into formal authority. */
export function classifyFailure({error,errorCode,stopReason,status,oracle,providerEvents=[],terminalAttempt=null}){
 if(status==='PASS')return{domain:null,code:null};
 if(oracle==='FAIL')return{domain:'product',code:'INDEPENDENT_ACCEPTANCE_FAILED'};
 const text=String(errorCode??error??'');
 const scoped=availabilityFor(providerEvents,terminalAttempt),availability=scoped.availability;
 const budgetCode=/DEADLINE|TURN_LIMIT|NO_PROGRESS|OBSERVED_TOKEN_LIMIT/.test(String(stopReason??''))?stopReason:/DEADLINE|TURN_LIMIT|NO_PROGRESS|OBSERVED_TOKEN_LIMIT/.test(text)?text:null;
 const termination=budgetCode?{domain:'budget',code:budgetCode}:null;
 if(availability?.status==='UNRESOLVED')return{domain:'provider-availability',code:'MODEL_CAPACITY_OBSERVED_UNRESOLVED',availability,termination};
 const context=availability?{availability,termination}:{};

 if(scoped.events.some(e=>e.params?.item?.sandboxDenied))return{domain:'infrastructure',code:'NESTED_SANDBOX_UNAVAILABLE'};
 if(/DEADLINE|TURN_LIMIT|NO_PROGRESS|OBSERVED_TOKEN_LIMIT/.test(String(stopReason??'')))return{domain:'budget',code:stopReason,...context};
 if(/^UNCERTAIN_TRANSPORT_/.test(text))return{domain:'transport',code:'UNCERTAIN_DISPATCH',...context};
 if(/DEADLINE|TURN_LIMIT|NO_PROGRESS|OBSERVED_TOKEN_LIMIT/.test(text))return{domain:'budget',code:text,...context};
 if(/TELEMETRY|MODEL_UNAVAILABLE|capture digest|CAPTURE|APPROVAL_MESSAGE|engine changed|invalid JSON/.test(text))return{domain:'harness',code:text};
 if(/INVALID_CURRENT_IMAGE|PLAN_REJECTION_LIMIT/.test(text))return{domain:'model-output',code:text,rejectedBy:'Sentinel-or-independent-plan-review',defectAttribution:'not-established'};
 if(/SENTINEL_AUTHORITY|PLAN_NOT_ACTIVATED|official approval refused|PLAN .*blocked/.test(text))return{domain:'sentinel-boundary',code:text,defectAttribution:'not-established',note:'A guard rejection is not evidence that Sentinel itself is defective.'};
 return{domain:'unclassified',code:text||status||'UNKNOWN',...context};
}

/** Product/agent failure is an observation; unknown harness health is not official. */
export function assessHarnessObservation({result,integrity=true,configuration=[],runnerContractProof,trajectoryStatus}){
 const reasons=[];
 if(!integrity)reasons.push('IMMUTABLE_IDENTITY_DRIFT');
 if(result?.closed===true&&trajectoryStatus!=='PASS')reasons.push('REQUIRED_TRAJECTORY_UNPROVEN');
 if(!runnerContractProof||!['MATCH','NOT_APPLICABLE'].includes(runnerContractProof.status)||result?.closed===true&&runnerContractProof.status!=='MATCH')reasons.push('RUNNER_CONTRACT_PROVENANCE_UNPROVEN');
 if(!Array.isArray(configuration)||!configuration.length||configuration.some(c=>c.status!=='MATCH'))reasons.push('EFFECTIVE_CONFIGURATION_UNPROVEN');
 if(!['PASS','FAIL','BLOCKED','TIMEOUT','INTERRUPTED'].includes(result?.status))reasons.push('INVALID_TERMINAL_OUTCOME');
 if(result?.status==='PASS'&&!(result.closed===true&&result.oracle==='PASS'&&result.complete===true))reasons.push('PASS_WITHOUT_CLOSE_ACCEPTANCE');
 const domain=result?.failure?.domain;
 if(result?.status!=='PASS'&&!['product','model-output','sentinel-boundary','budget'].includes(domain))reasons.push('HARNESS_HEALTH_UNPROVEN');
 return {harnessValid:reasons.length===0,reasons,tokenGapsAllowed:true,taskOutcomeIsNotAdmissionCriterion:true};
}
