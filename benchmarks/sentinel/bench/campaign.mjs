import{resolveCaseProfile}from'./case-profile.mjs';
import{buildTrajectoryReport}from'./trajectory-report.mjs';
import{collectRunnerContractProof}from'./runner-contract-proof.mjs';
import{environmentPreflight}from'./environment-preflight.mjs';
import{admitOfficial}from'./qualification.mjs';
import{verifyQualificationEvidence}from'./qualification-store.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';
import{UsageBudgetMonitor}from'./budget-monitor.mjs';
import{collectCommunicationProof}from'./communication-proof.mjs';
import{buildCycleReport,toCycleCsv}from'./cycle-report.mjs';
import{renderReport}from'./report.mjs';
import{classifyFailure,assessHarnessObservation,failureObservation}from'./failures.mjs';
import{Ledger,atomicJson,writeOnce,treeHashes,digest,safeId,validateProfile,budgetDecision,acquireLock,classifyMeasurement,confined,sha256}from'./core.mjs';
import{materializeSourceSnapshot}from'./source-snapshot.mjs';
import{runPool}from'./pool.mjs';
import{prepareCase,configureRunner}from'./prepare.mjs';import{AppServer}from'./app-server.mjs';import{CASES,verifyCase}from'./scenarios.mjs';import{collectUsage}from'./telemetry.mjs';
import{inspectAuthority,nextOperation,allocatePlan,capturePlan,recoverUncapturedDraft,reviseRejectedPlan,approvePlan,stagePrompt,planApproverPrompt,parseApproval}from'./workflow.mjs';
export const BASE=fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
// Field completeness covers collected response records, not exhaustive consumption.
export function usageMayBeUnreported(usage,pending){
 if(pending||!usage?.observedTotals||!Array.isArray(usage.gaps))return true;
 const total=usage.observedTotals.totalTokens;if(!total||total.complete!==true||!Number.isSafeInteger(total.value)||total.value<0)return true;
 const coverageGaps=new Set(['IN_FLIGHT_OR_UNFLUSHED_USAGE_NOT_OBSERVABLE','NO_RESPONSE_USAGE','PARTIAL_TRAILING_LINE','INVALID_JSON','RESPONSE_IDENTITY_MISSING','CONFLICTING_USAGE','UNRELATED_OR_UNLINKED_RESPONSES_EXCLUDED']);
 return usage.gaps.some(g=>coverageGaps.has(g?.code))||Object.values(usage.observedTotals).some(metric=>metric?.complete!==true);
}
export const ADAPTER_PROTOCOL='sentinel-app-server-public-v1';
export const implementationHashes=(root=path.join(BASE,'bench'))=>treeHashes(root,{exclude:['profiles','cases','test','README.md']});
export function campaignIdentity(profile,sourceRoot=path.join(BASE,'source')){return{engine:digest(implementationHashes()),fixture:digest(treeHashes(path.join(BASE,'fixtures/todo'))),scenarioOracle:digest({cases:CASES,oracles:treeHashes(path.join(BASE,'bench/cases'))}),source:digest(treeHashes(sourceRoot)),profile:digest(profile),cliVersion:profile.cliVersion,sentinelRevision:profile.sentinelRevision,contextPolicy:profile.contextPolicy??'stage',adapterProtocol:ADAPTER_PROTOCOL};}
const roleRules=[{role:'plan_review',agentNamePrefix:'plan_review'},{role:'execute_check',agentNamePrefix:'execute_check'},{role:'formal_validate',agentNamePrefix:'formal_validate'}];
export function validateModels(roles,listing){const available=new Set((listing?.data??[]).flatMap(item=>[item.model,item.id]).filter(v=>typeof v==='string'));for(const [role,config]of Object.entries(roles)){if(!available.has(config.model))throw Error(`MODEL_UNAVAILABLE_${role}: ${config.model}`);const item=listing.data.find(x=>x.model===config.model||x.id===config.model);if(Array.isArray(item.supportedReasoningEfforts)&&!item.supportedReasoningEfforts.some(x=>x.reasoningEffort===config.effort))throw Error(`EFFORT_UNAVAILABLE_${role}: ${config.effort}`);}return true;}
export function effectiveThread(response){return {threadId:response.thread?.id??null,...Object.fromEntries(['model','modelProvider','reasoningEffort','cwd','approvalPolicy','sandbox'].map(k=>[k,response[k]??null]))};}
/** Provider acknowledgement must match before a role may dispatch any model turn. */
export function assertEffectiveThread(response,{model,effort,cwd,sandbox,tmpDir=null}){
 const actual=effectiveThread(response),mismatches=[];
 for(const [name,expected]of Object.entries({model,reasoningEffort:effort,cwd,approvalPolicy:'never'}))if(actual[name]!==expected)mismatches.push(name);
 if(typeof actual.threadId!=='string'||!actual.threadId)mismatches.push('threadId');
 if(actual.sandbox?.type!==sandbox)mismatches.push('sandbox.type');
 if(actual.sandbox?.networkAccess!==false)mismatches.push('sandbox.networkAccess');
 if(sandbox==='workspaceWrite'&&actual.sandbox?.excludeSlashTmp!==true)mismatches.push('sandbox.excludeSlashTmp');
 const writable=actual.sandbox?.writableRoots;
 if(sandbox==='workspaceWrite'){
  const allowed=[cwd,...(tmpDir?[tmpDir]:[])];
  if(!Array.isArray(writable)||writable.some(root=>typeof root!=='string'||!path.isAbsolute(root)||!allowed.some(base=>{try{return confined(base,root)===path.resolve(root);}catch{return false;}})))mismatches.push('sandbox.writableRoots');
 }else if(sandbox==='readOnly'&&writable!==undefined&&(!Array.isArray(writable)||writable.length))mismatches.push('sandbox.writableRoots');
 if(mismatches.length)throw Error('EFFECTIVE_THREAD_MISMATCH:'+mismatches.join(','));return actual;
}
/** Context is bound to accepted thread/turn identities, never the latest phase. */
export function eventContextRegistry(write) {
 const accepted=new Map(); let pending=null; const buffered=[];
 const key=(threadId,turnId)=>JSON.stringify([threadId,turnId]);
 const ids=p=>({threadId:p.params?.threadId,turnId:p.params?.turnId??p.params?.turn?.id});
 const emit=(payload,context={})=>write({at:new Date().toISOString(),context,payload});
 return {
  begin(threadId,context){pending={threadId,context};},
  event(payload){const {threadId,turnId}=ids(payload),context=accepted.get(key(threadId,turnId));if(context)return emit(payload,context);if(pending&&threadId===pending.threadId&&turnId){buffered.push(payload);return;}emit(payload);},
  accept({threadId,turnId}){if(!pending||threadId!==pending.threadId)throw Error('context acceptance identity mismatch');accepted.set(key(threadId,turnId),pending.context);emit({method:'benchmark/dispatch',params:{threadId,turnId}},pending.context);for(const payload of buffered.splice(0)){const p=ids(payload);emit(payload,accepted.get(key(p.threadId,p.turnId))??{});}pending=null;},
  finish(){for(const payload of buffered.splice(0))emit(payload);pending=null;}
 };
}
export function trajectoryProductHashes(workspace){
 const result={};for(const dir of ['src','test'])if(fs.existsSync(path.join(workspace,dir)))for(const [name,hash]of Object.entries(treeHashes(path.join(workspace,dir))))result[dir+'/'+name]=hash;
 for(const name of ['package.json','README.md'])if(fs.existsSync(path.join(workspace,name)))result[name]=sha256(fs.readFileSync(path.join(workspace,name)));return result;
}
export function semanticFingerprint(workspace,authority){
 const l=authority.lifecycle?.output,c=authority.current?.output;
 const semantics={lifecycle:l?.lifecycle_status??null,execution:l?.execution_state??null,lifecycleExit:authority.lifecycle?.exitCode??null,currentExit:authority.current?.exitCode??null,state:c?.state??null,handoff:c?.normalHandoff??null};
 return digest({semantics,src:treeHashes(path.join(workspace,'src')),package:fs.readFileSync(path.join(workspace,'package.json'),'utf8')});
}
export function observedBudgetTokens(usage,completedTurns){const value=usage?.observedTotals?.totalTokens?.value;if(Number.isSafeInteger(value)&&value>=0)return value;if(completedTurns>0)throw Error('BLOCKED_TELEMETRY_NO_REPORTED_TOTAL');return 0;}
export function admitDeadline(deadline){if(!Number.isFinite(deadline)||Date.now()>=deadline)throw Error('DEADLINE');}
export async function durableEffect({state,ledger,save,evidence,deadline},name,args,action){
 admitDeadline(deadline);if(state.pendingEffect)throw Error('UNSETTLED_EFFECT');
 const index=(state.effects??0)+1;state.effects=index;state.pendingEffect={index,name,args};ledger.append('effect-intent',state.pendingEffect);save();
 const result=await action();writeOnce(path.join(evidence,`effect-${index}-result.json`),{name,result});ledger.append('effect-result',{index,name,result});state.lastEffect={index,name,result};state.pendingEffect=null;save();admitDeadline(deadline);return result;
}
/** Latest cumulative observations replace prior snapshots; unknown is never fabricated as zero. */
export function createCampaignBudget(limit){
 if(!Number.isSafeInteger(limit)||limit<=0)throw Error('invalid campaign token limit');
 const cells=new Map();let stopReason=null;
 const snapshot=()=>({limit,knownReportedTokens:[...cells.values()].reduce((n,c)=>n+(c.lastKnown??0),0),missingReports:[...cells].filter(([,c])=>c.latest===null).map(([id])=>id),partialReports:[...cells].filter(([,c])=>c.complete===false).map(([id])=>id),cells:Object.fromEntries(cells),stopReason,hardCap:false,observationDelayed:true});
 return {
  register(id){if(!cells.has(id))cells.set(id,{latest:null,lastKnown:null,complete:false});},
  observe(id,usage){this.register(id);const metric=usage?.observedTotals?.totalTokens,value=metric?.value;const known=Number.isSafeInteger(value)&&value>=0;const previous=cells.get(id);cells.set(id,{latest:known?value:null,lastKnown:known?value:previous.lastKnown,complete:known&&metric.complete===true});if(snapshot().knownReportedTokens>=limit)stopReason='CAMPAIGN_OBSERVED_TOKEN_LIMIT';return snapshot();},
  admit(){if(snapshot().knownReportedTokens>=limit)stopReason='CAMPAIGN_OBSERVED_TOKEN_LIMIT';return stopReason===null;},
  snapshot
 };
}
export async function executeCase({manifest:m,campaignDeadline,requirements,campaignBudget,resumeState=null,resumeAuthorization=null,services={}}){
 const api={serverFactory:options=>new AppServer(options),collectUsage,inspectAuthority,verifyCase,allocatePlan,capturePlan,recoverUncapturedDraft,reviseRejectedPlan,approvePlan,configureRunner,...services};
 validateProfile(m.profile);const contextPolicy=m.profile.contextPolicy??'stage';
 const resuming=resumeState!==null;
 if(resuming&&(resumeState.contextPolicy??'persistent')!==contextPolicy)throw Error('RESUME_CONTEXT_POLICY_MISMATCH');
 if(resuming&&contextPolicy==='stage'&&(!resumeState.stageThreads||typeof resumeState.stageThreads!=='object'||Array.isArray(resumeState.stageThreads)))throw Error('RESUME_STAGE_THREADS_MISSING');
 if(resuming){if(resumeState.pending!=null||resumeState.pendingEffect!=null)throw Error('RESUME_UNSETTLED_EFFECT_OR_TURN');if(!resumeState.threadId||!Number.isFinite(resumeState.deadline)||!Number.isFinite(resumeState.startedAt)||!['turns','completedTurns','unchanged'].every(k=>Number.isSafeInteger(resumeState[k])&&resumeState[k]>=0)||!Array.isArray(resumeState.roots))throw Error('RESUME_CHECKPOINT_INVALID');}
 if(!Number.isFinite(campaignDeadline))throw Error('CAMPAIGN_DEADLINE_REQUIRED');
 const budgetCell=`${m.caseId}-${m.repetition}`;campaignBudget?.register(budgetCell);
 const stateFile=path.join(m.evidence,'checkpoint.json'),ledger=new Ledger(path.join(m.evidence,'ledger.jsonl')),eventsFile=path.join(m.evidence,'events.jsonl');
 if(resuming){if(!fs.existsSync(eventsFile))throw Error('RESUME_EVENT_HISTORY_MISSING');const text=fs.readFileSync(eventsFile,'utf8');if(text&&!text.endsWith('\n'))throw Error('RESUME_EVENT_HISTORY_TRUNCATED');}else fs.writeFileSync(eventsFile,'',{flag:'wx'});
 const state=resuming?structuredClone(resumeState):{status:'RUNNING',startedAt:Date.now(),deadline:Math.min(campaignDeadline,Date.now()+m.profile.limits.caseMs),campaignDeadline,turns:0,completedTurns:0,unchanged:0,pending:null,pendingEffect:null,threadId:null,plan:null,contextPolicy,stageThreads:{},threadOpenings:0};
 state.contextPolicy=contextPolicy;state.stageThreads??={};state.threadOpenings??=0;
 const roots=structuredClone(state.roots??[]);
 campaignDeadline=Math.min(campaignDeadline,state.campaignDeadline??state.deadline);
 const activeDeadline=Math.min(state.deadline,campaignDeadline);
 const recoveryIndex=resuming?(state.recoveryCount??0)+1:0,suffix=resuming?`-recovery-${recoveryIndex}`:'';
 if(resuming){state.recoveryHistory??=[];state.recoveryHistory.push({index:recoveryIndex,previousStatus:state.status,error:state.error??null,finishedAt:state.finishedAt??null,resumedAt:Date.now()});state.recoveryCount=recoveryIndex;state.status='RUNNING';delete state.error;delete state.errorCode;delete state.errorOperation;delete state.stopReason;delete state.finishedAt;delete state.telemetryError;}
 m={...m,deadline:activeDeadline};const save=()=>atomicJson(stateFile,{...state,roots});save();
 const assertCapture=()=>{const p=state.plan;if(!p?.captureSha256||!p.snapshotPath)throw Error('PLAN_CAPTURE_BINDING_MISSING');const bytes=fs.readFileSync(confined(m.workspace,p.snapshotPath));if('sha256:'+sha256(bytes)!==p.captureSha256||p.snapshot&&digest(JSON.parse(bytes))!==digest(p.snapshot))throw Error('PLAN_CAPTURE_CHANGED');if(['APPROVED','REVIEWED'].includes(p.phase)&&(p.approvedCaptureSha256!==p.captureSha256||!p.approvalResult))throw Error('PLAN_APPROVAL_BINDING_MISSING');};
 const contexts=eventContextRegistry(row=>{fs.appendFileSync(eventsFile,JSON.stringify(row)+'\n');ledger.append('provider-event',row);});
 let activeAbort=null,activeStopReason=null;const observedFailures=[];const monitor=new UsageBudgetMonitor({limit:m.profile.limits.maxReportedTokens,onLimit:()=>{if(activeAbort){activeStopReason??='OBSERVED_TOKEN_LIMIT';activeAbort.abort();}}});
 const server=api.serverFactory({cli:m.profile.cli,cwd:m.workspace,home:m.codexHome,tmpDir:m.tmpDir,onEvent:payload=>{contexts.event(payload);monitor.observe(payload);const observation=failureObservation(payload);if(observation)observedFailures.push(observation);}});
 let usage=null,oracle=null,closedObserved=false,completeProof=state.preCloseComplete??null;
 const effect=(name,args,action)=>durableEffect({state,ledger,save,evidence:m.evidence,deadline:activeDeadline},name,args,action);
 async function measure(){const threadConfigurations=fs.readdirSync(m.evidence).filter(name=>/^(coordinator|plan-approver)-thread-effective.*\.json$/.test(name)).map(name=>{const file=confined(m.evidence,name),bytes=fs.readFileSync(file);return{...JSON.parse(bytes),source:{file,sha256:sha256(bytes),kind:'observed-app-server-thread-configuration'}};});usage=await api.collectUsage({roleAuthority:'native',authorizedTempRoots:[m.tmpDir],threadConfigurations,sessionRoot:path.join(m.codexHome,'sessions'),eventFiles:[eventsFile],rootThreads:roots,roleRules,expectedProfile:{roles:Object.fromEntries(Object.entries(m.profile.roles).map(([role,config])=>[role,{...config,sandbox:role==='plan_approver'?'read-only':'workspace-write',approval:'never',network:false}]))}});usage.observedAt=new Date().toISOString();usage.freshness={collectedAt:usage.observedAt,refreshPolicy:'between-turns-and-finalization',inFlightUsageMayBeMissing:true,hardTokenCap:false};atomicJson(path.join(m.evidence,'usage.json'),usage);if(campaignBudget)atomicJson(path.join(m.evidence,'campaign-budget-observed.json'),campaignBudget.observe(budgetCell,usage));}
 const authorityNow=()=>{admitDeadline(activeDeadline);const a=api.inspectAuthority(m);admitDeadline(activeDeadline);return a;};
 async function oracleAt(name){admitDeadline(activeDeadline);const r=await api.verifyCase({caseId:m.caseId,workspace:m.workspace,evidenceDir:path.join(m.evidence,name+suffix),deadline:activeDeadline,engineRoot:m.engineRoot});admitDeadline(activeDeadline);return r;}
 const loadedStageThreads=new Set();
 async function ensureStageThread(stage,authority){
  if(contextPolicy==='persistent')return{threadId:state.threadId,role:'coordinator'};
  const slice=['EXECUTE_SLICE','APPLY_FINDINGS','VALIDATE_SLICE'].includes(stage)?authority.current?.output?.normalHandoff?.slice:null;
  if(['EXECUTE_SLICE','APPLY_FINDINGS','VALIDATE_SLICE'].includes(stage)&&(typeof slice!=='string'||!slice))throw Error('STAGE_SLICE_IDENTITY_MISSING');
  const key=JSON.stringify([stage,slice]),role=m.profile.stageRoles?.[stage]??'coordinator',requested=m.profile.roles[role];
  let entry=state.stageThreads[key];
  if(entry&&(entry.role!==role||entry.model!==requested.model||entry.effort!==requested.effort||entry.cwd!==m.workspace||entry.stage!==stage||entry.slice!==slice||!entry.threadId))throw Error('STAGE_THREAD_CONFIGURATION_MISMATCH');
  if(entry&&!roots.some(r=>r.threadId===entry.threadId&&r.role===role&&r.stage===stage&&r.slice===slice))throw Error('STAGE_ROOT_HISTORY_MISSING');
  if(!entry||!loadedStageThreads.has(entry.threadId)){
   admitDeadline(activeDeadline);const opening=++state.threadOpenings;save();
   const options={model:requested.model,config:{model_reasoning_effort:requested.effort},sandbox:'workspace-write'};
   const ack=entry?await server.resumeThread({...options,threadId:entry.threadId}):await server.startThread(options);
   writeOnce(path.join(m.evidence,`coordinator-thread-effective-stage-${opening}.json`),{...effectiveThread(ack),stage,slice,role,contextPolicy});
   assertEffectiveThread(ack,{...requested,cwd:m.workspace,sandbox:'workspaceWrite',tmpDir:m.tmpDir});
   if(entry&&ack.thread.id!==entry.threadId)throw Error('RESUME_STAGE_THREAD_IDENTITY_MISMATCH');
   if(!entry){if(roots.some(r=>r.threadId===ack.thread.id))throw Error('STAGE_THREAD_ID_REUSED');entry={threadId:ack.thread.id,role,model:requested.model,effort:requested.effort,cwd:m.workspace,stage,slice};state.stageThreads[key]=entry;roots.push({threadId:entry.threadId,caseId:m.caseId,role,stage,slice});}
   loadedStageThreads.add(entry.threadId);
  }
  state.threadId=entry.threadId;save();return entry;
 }
 async function turn(stage,prompt,role='coordinator',threadId=null){
  const coordinated=threadId===null;
  await measure();if(campaignBudget&&!campaignBudget.admit())throw Error('CAMPAIGN_OBSERVED_TOKEN_LIMIT');const reportedTokens=observedBudgetTokens(usage,state.completedTurns);
  const decision=budgetDecision({campaignDeadline,caseDeadline:activeDeadline,turns:state.turns,unchanged:state.unchanged,reportedTokens},m.profile.limits);if(decision!=='ALLOW')throw Error(decision);
  const authorityBefore=authorityNow();if(coordinated){const selected=await ensureStageThread(stage,authorityBefore);threadId=selected.threadId;role=selected.role;}
  const productBefore=coordinated?trajectoryProductHashes(m.workspace):null;const before=semanticFingerprint(m.workspace,authorityBefore),context={caseId:m.caseId,stage,role,slice:authorityBefore.current?.output?.normalHandoff?.slice??null,contextPolicy};const index=++state.turns;
  writeOnce(path.join(m.evidence,`turn-${index}-request.json`),{stage,prompt,role,threadId,model:m.profile.roles[role],before});state.pending={index,stage,threadId,before,authorityBefore,turnId:null,...(coordinated?{trajectoryBefore:{productBefore,slice:context.slice}}:{})};ledger.append('dispatch-intent',state.pending);save();contexts.begin(threadId,context);
  let result,turnStopReason=null;activeAbort=new AbortController();activeStopReason=null;if(monitor.triggered)throw Object.assign(Error('OBSERVED_TOKEN_LIMIT'),{code:'OBSERVED_TOKEN_LIMIT',operation:stage});
  const turnDeadline=Math.min(activeDeadline,Date.now()+m.profile.limits.turnMs);
  const deadlineTimer=setTimeout(()=>{activeStopReason??=turnDeadline===activeDeadline?'CASE_DEADLINE':'TURN_DEADLINE';activeAbort?.abort();},Math.max(0,turnDeadline-Date.now()));
  try{result=await server.runTurn({threadId,input:[{type:'text',text:prompt}],...m.profile.roles[role],deadline:turnDeadline,signal:activeAbort.signal,onAccepted:accepted=>{state.pending={...state.pending,...accepted};ledger.append('dispatch-accepted',state.pending);save();contexts.accept(accepted);}});}finally{clearTimeout(deadlineTimer);turnStopReason=activeStopReason;contexts.finish();activeAbort=null;activeStopReason=null;atomicJson(path.join(m.evidence,'operational-budget-monitor.json'),monitor.snapshot());}
  if(result.status==='interrupted'&&turnStopReason)result={...result,stopReason:turnStopReason};
  writeOnce(path.join(m.evidence,`turn-${index}-result.json`),result);ledger.append('dispatch-result',result);await measure();if(result.status!=='completed'){state.status='BLOCKED';state.stopReason=result.stopReason??null;save();const reason=result.stopReason??('UNCERTAIN_TRANSPORT_'+result.status);throw Object.assign(Error(reason),{code:result.stopReason??null,operation:stage});}
  state.completedTurns++;const afterAuthority=authorityNow();const after=semanticFingerprint(m.workspace,afterAuthority);if(coordinated){const snapshot={index,stage,slice:context.slice,threadId,turnId:result.turnId,beforeAuthority:authorityBefore,afterAuthority,productBefore,productAfter:trajectoryProductHashes(m.workspace)};writeOnce(path.join(m.evidence,`turn-${index}-authority-after.json`),snapshot);state.trajectorySnapshots??=[];state.trajectorySnapshots.push(snapshot);ledger.append('authority-after',snapshot);}if(coordinated)state.unchanged=before===after?state.unchanged+1:0;state.pending=null;save();return result;
 }
 try{
  admitDeadline(activeDeadline);await server.start();admitDeadline(activeDeadline);const models=await server.modelList();writeOnce(path.join(m.evidence,'models'+suffix+'.json'),models);validateModels(m.profile.roles,models);admitDeadline(activeDeadline);
  if(contextPolicy==='persistent'){
  const threadOptions={model:m.profile.roles.coordinator.model,config:{model_reasoning_effort:m.profile.roles.coordinator.effort}};
  const started=resuming?await server.resumeThread({...threadOptions,threadId:state.threadId}):await server.startThread(threadOptions);
  if(resuming&&started.thread?.id!==state.threadId)throw Error('RESUME_THREAD_IDENTITY_MISMATCH');
  writeOnce(path.join(m.evidence,'coordinator-thread-effective'+suffix+'.json'),effectiveThread(started));assertEffectiveThread(started,{...m.profile.roles.coordinator,cwd:m.workspace,sandbox:'workspaceWrite',tmpDir:m.tmpDir});state.threadId=started.thread.id;
  if(!resuming)roots.push({threadId:state.threadId,caseId:m.caseId,role:'coordinator'});else if(!roots.some(r=>r.threadId===state.threadId&&r.role==='coordinator'))throw Error('RESUME_ROOT_HISTORY_MISSING');save();
  }
  while(true){const authority=authorityNow(),operation=nextOperation(authority);ledger.append('authority',{operation,authority});atomicJson(path.join(m.evidence,'authority-latest.json'),authority);
   if(operation==='CLOSED'){closedObserved=true;if(!completeProof||nextOperation(completeProof)!=='CLOSE'||completeProof.specPath!==authority.specPath)throw Error('CLOSED_WITHOUT_COMPLETE_PROOF');oracle=await oracleAt('oracle-final');state.status=oracle.status==='PASS'?'PASS':'FAIL';break;}
   if(operation==='BLOCKED')throw Error('SENTINEL_AUTHORITY_BLOCKED');
   if(operation==='PLAN'){
    if(!state.plan){if(resuming)throw Error('RESUME_PLAN_ALLOCATION_NOT_AUTHORIZED');await effect('allocate-plan',{specPath:authority.specPath},async()=>{const allocated=await api.allocatePlan(m,authority.specPath);state.plan={...allocated,phase:'AUTHOR'};return allocated;});}
    if(!['AUTHOR','CAPTURED','APPROVED','REVIEWED'].includes(state.plan.phase))throw Error('PLAN_PHASE_REQUIRES_RECONCILIATION');
    if(state.plan.phase==='AUTHOR'){
     if(state.plan.captureSha256||state.plan.snapshotPath||state.lastEffect?.name==='capture-plan')throw Error('AUTHOR_HAS_IMMUTABLE_CAPTURE');
     if(resuming&&(resumeAuthorization?.authorPlan!==true||resumeAuthorization.candidateExecutionRoot!==state.plan.candidateExecutionRoot))throw Error('RESUME_AUTHOR_NOT_AUTHORIZED');
     const authored=await turn('PLAN',stagePrompt({manifest:m,operation,authority,plan:state.plan})+(state.plan.feedback?'\nCorreção limitada do draft: '+state.plan.feedback:''));
     try{await effect('capture-plan',{specPath:authority.specPath,root:state.plan.candidateExecutionRoot},async()=>{const captured=await api.capturePlan(m,authority.specPath,state.plan.candidateExecutionRoot);state.plan={...state.plan,...captured,phase:'CAPTURED'};return captured;});}
     catch(error){
      ledger.append('capture-refused',{pendingEffect:state.pendingEffect,code:error.code??null,operation:error.operation??null,reasonCode:error.reasonCode??null,message:error.message});
      if(error.code!=='INVALID_CURRENT_IMAGE'||error.operation!=='capturePreparationDraft'||(state.plan.corrections??0)>=2)throw error;
      const rejected=structuredClone(state.pendingEffect);ledger.append('draft-recovery-intent',{rejected,turnId:authored.turnId,threadId:authored.threadId});
      const recovered=api.recoverUncapturedDraft(m,authority.specPath,state.plan.candidateExecutionRoot,error,{providerTurnCompleted:authored.status==='completed',transportIdle:server.active==null});
      ledger.append('draft-recovery-confirmed',{rejected,recovered});state.resolvedEffects??=[];state.resolvedEffects.push({rejected,recovered,reason:error.message});state.pendingEffect=null;state.plan.corrections=(state.plan.corrections??0)+1;state.plan.feedback=`Erro oficial de capturePreparationDraft (${error.code}): ${JSON.stringify(error.message)}. Corrija a classe de erro apontada em todos os artefatos de Plan/Tasks globais e detalhados da mesma alocação existente, não somente a primeira ocorrência indicada. Confira ocorrências equivalentes preservando os requisitos, critérios e significado técnico; não amplie o escopo nem crie outra alocação. Não substitua a validação oficial por parser próprio, não edite controles/capturas/aprovações e não publique nada. A próxima captura oficial continua obrigatória; o limite original de duas correções e os prazos/orçamentos não mudam.`;state.unchanged=0;save();continue;
     }
     state.unchanged=0;save();writeOnce(path.join(m.evidence,'plan-capture'+suffix+'-'+(state.plan.corrections??0)+'.json'),state.plan);
    }
    if(state.plan.phase==='CAPTURED'){
     assertCapture();const capture=state.plan,reviewSuffix=suffix+'-plan-'+(state.plan.corrections??0);
     let delegated=state.plan.delegatedApproval;
     if(delegated&&delegated.captureSha256!==capture.captureSha256)throw Error('DELEGATED_APPROVAL_CAPTURE_MISMATCH');
     if(!delegated){
      admitDeadline(activeDeadline);const reviewThread=await server.startThread({model:m.profile.roles.plan_approver.model,config:{model_reasoning_effort:m.profile.roles.plan_approver.effort},sandbox:'read-only'});
      writeOnce(path.join(m.evidence,'plan-approver-thread-effective'+reviewSuffix+'.json'),effectiveThread(reviewThread));assertEffectiveThread(reviewThread,{...m.profile.roles.plan_approver,cwd:m.workspace,sandbox:'readOnly'});roots.push({threadId:reviewThread.thread.id,caseId:m.caseId,role:'plan_approver'});save();
      const approval=await turn('APPROVE_PLAN',planApproverPrompt({requirements,capture,trajectory:m.trajectory}),'plan_approver',reviewThread.thread.id);
      admitDeadline(activeDeadline);const read=await server.readThread(reviewThread.thread.id);if(read.thread?.id!==reviewThread.thread.id)throw Error('APPROVAL_THREAD_IDENTITY_MISMATCH');const actualTurn=read.thread.turns.find(t=>t.id===approval.turnId),messages=actualTurn?.items?.filter(i=>i.type==='agentMessage')??[],text=messages.at(-1)?.text;if(!text)throw Error('APPROVAL_MESSAGE_MISSING');
      const decision=parseApproval(text);delegated={provenance:'DELEGATED_AUTONOMY',threadId:reviewThread.thread.id,turnId:approval.turnId,completionStatus:approval.status,captureSha256:capture.captureSha256,decision};state.plan.delegatedApproval=delegated;save();writeOnce(path.join(m.evidence,'delegated-approval'+reviewSuffix+'.json'),delegated);
     }
     if(delegated.decision.decision==='BLOCKED')throw Error('APPROVAL_OPERATIONALLY_BLOCKED');
     if(delegated.decision.decision==='REJECT'){
      if((state.plan.corrections??0)>=2)throw Error('PLAN_REJECTION_LIMIT');
      await effect('revise-rejected-plan',{captureSha256:capture.captureSha256,decision:delegated.decision},()=>{const revised=api.reviseRejectedPlan(m,authority.specPath,capture.candidateExecutionRoot,capture,delegated.decision,{providerTurnCompleted:delegated.completionStatus==='completed',transportIdle:server.active==null});state.planHistory??=[];state.planHistory.push(state.plan);state.plan={candidateExecutionRoot:capture.candidateExecutionRoot,draftRoot:revised.draftRoot,phase:'AUTHOR',corrections:(capture.corrections??0)+1,feedback:JSON.stringify(delegated.decision)};state.unchanged=0;return revised;});continue;
     }
     assertCapture();await effect('approve-plan',{specPath:authority.specPath,root:state.plan.candidateExecutionRoot,captureSha256:capture.captureSha256,decision:delegated.decision},async()=>{const approved=await api.approvePlan(m,authority.specPath,state.plan.candidateExecutionRoot,capture,delegated.decision);state.plan={...state.plan,phase:'APPROVED',approvalResult:approved,approvedCaptureSha256:capture.captureSha256};return approved;});
    }
    if(state.plan.phase==='APPROVED'){
     assertCapture();await turn('REVIEW_PLAN',stagePrompt({manifest:m,operation:'REVIEW_PLAN',authority,plan:state.plan}));state.plan.phase='REVIEWED';save();continue;
    }
    throw Error('REVIEWED_PLAN_NOT_ACTIVATED');
   }
   if(state.plan?.phase==='REVIEWED')assertCapture();
   if(state.plan?.phase==='APPROVED'&&['EXECUTE_SLICE','VALIDATE_SLICE','APPLY_FINDINGS','CLOSE'].includes(operation)){assertCapture();state.plan.phase='REVIEWED';save();}
   admitDeadline(activeDeadline);if(operation==='VALIDATE_SLICE')api.configureRunner(m.home,m.profile.roles.formal_validate);else if(['EXECUTE_SLICE','APPLY_FINDINGS'].includes(operation))api.configureRunner(m.home,m.profile.roles.execute_check);
   if(operation==='CLOSE'){if(authority.current.output.state!=='COMPLETE')throw Error('CLOSE_REQUIRES_COMPLETE');completeProof=authority;state.preCloseComplete=authority;save();writeOnce(path.join(m.evidence,'pre-close-authority'+suffix+'.json'),authority);oracle=await oracleAt('oracle-pre-close');if(oracle.status!=='PASS'){state.status='FAIL';break;}}
   await turn(operation,stagePrompt({manifest:m,operation,authority,plan:state.plan}));
  }
 }catch(error){state.status=state.status==='FAIL'?'FAIL':'BLOCKED';state.error=error.message;state.errorCode=error.code??null;state.errorOperation=error.operation??null;ledger.append('stop',{error:error.message,errorCode:state.errorCode,errorOperation:state.errorOperation,pending:state.pending,pendingEffect:state.pendingEffect});}finally{contexts.finish();await server.stop();await measure().catch(error=>{state.telemetryError=error.message;});state.finishedAt=Date.now();save();if(usage){const cycles=buildCycleReport({usage,events:fs.readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)});atomicJson(path.join(m.evidence,'cycle-report'+suffix+'.json'),cycles);fs.writeFileSync(path.join(m.evidence,'cycles'+suffix+'.csv'),toCycleCsv(cycles),{flag:'wx'});try{const communications=await collectCommunicationProof({events:fs.readFileSync(eventsFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),workspace:m.workspace,tmpDir:m.tmpDir,home:m.home,sessionRoot:path.join(m.codexHome,'sessions')});atomicJson(path.join(m.evidence,'communication-proof'+suffix+'.json'),communications);}catch(error){atomicJson(path.join(m.evidence,'communication-proof'+suffix+'.json'),{status:'INCOMPLETE',error:error.message});}}}
 const trajectory=buildTrajectoryReport({caseId:m.caseId,trajectory:m.trajectory??{minSlices:1},snapshots:state.trajectorySnapshots??[]});writeOnce(path.join(m.evidence,'trajectory-report'+suffix+'.json'),trajectory);
 const result={effectiveProfileDigest:digest(m.profile),trajectoryStatus:trajectory.status,sharedFileChange:trajectory.sharedFileChange,caseId:m.caseId,repetition:m.repetition,status:state.status,error:state.error??null,errorCode:state.errorCode??null,errorOperation:state.errorOperation??null,stopReason:state.stopReason??null,durationMs:state.finishedAt-state.startedAt,turns:state.turns,measurement:'diagnostic',oracle:oracle?.status??null,complete:!!completeProof,pending:state.pending,pendingEffect:state.pendingEffect,observedTokens:usage?.observedTotals?.totalTokens?.value??null,tokenMetrics:usage?.observedTotals??null,usageScope:'reported-responses-only',unreportedUsagePossible:usageMayBeUnreported(usage,state.pending),tokenBudgetIsHardCap:false,failure:classifyFailure({error:state.error,errorCode:state.errorCode,stopReason:state.stopReason,status:state.status,oracle:oracle?.status,providerEvents:observedFailures,terminalAttempt:state.pending}),closed:closedObserved,usage};writeOnce(path.join(m.evidence,resuming?`recovery-${recoveryIndex}-result.json`:'result.json'),result);atomicJson(path.join(m.evidence,'result-latest.json'),result);return result;
}
export async function runCampaign({id,profile,caseIds=profile.suiteCases??CASES.map(c=>c.id),repetitions=profile.repetitions,admission=null}){
 safeId(id);if(!Number.isSafeInteger(repetitions)||repetitions<1)throw Error('invalid repetitions');
 profile={...profile,repetitions,suiteCases:Array.isArray(caseIds)?[...caseIds]:caseIds};validateProfile(profile);
 if(!Array.isArray(caseIds)||!caseIds.length||new Set(caseIds).size!==caseIds.length||caseIds.some(id=>!CASES.some(c=>c.id===id)))throw Error('invalid cases');
 const cells=Array.from({length:repetitions},(_,i)=>caseIds.map(caseId=>({caseId,repetition:i+1}))).flat();
 const cap=profile.limits.maxCampaignReportedTokens??profile.limits.maxReportedTokens*cells.length;
 const source=await materializeSourceSnapshot({base:BASE,repository:path.resolve(BASE,'../..'),revision:profile.sentinelRevision});
 const budget=createCampaignBudget(cap),identity=campaignIdentity(profile,source.sourceRoot),directory=path.join(BASE,'evidence/campaigns',id);
 let mode='diagnostic',verifiedAdmission=null;
 if(admission){const verification=verifyQualificationEvidence({base:BASE,qualification:admission.qualification,targetProof:admission.targetProof});const decision=admitOfficial({qualification:admission.qualification,identity,harnessIdentity:admission.harnessIdentity,targetProof:admission.targetProof});if(verification.status!=='PASS'||!decision.allowed){throw Error('OFFICIAL_ADMISSION_REFUSED:'+JSON.stringify({verification,decision}));}mode='official';verifiedAdmission={decision,verification};}
 if(fs.existsSync(directory))throw Error('campaign ID already exists');
 fs.mkdirSync(directory,{recursive:true});const release=acquireLock(directory);
 const startedAt=Date.now(),deadline=startedAt+profile.limits.campaignMs;

 const caseProfiles=Object.fromEntries(caseIds.map(caseId=>{const effective=resolveCaseProfile(profile,caseId);return[caseId,{profile:effective,profileDigest:digest(effective)}]}));
 const campaign={schemaVersion:1,id,mode,identity,profile,caseProfiles,startedAt,deadline,planned:cells.length,started:0,notStarted:cells.length,stopReason:null,caseIds,repetitions,results:[],tokenBudget:budget.snapshot()};
 const save=()=>{campaign.tokenBudget=budget.snapshot();campaign.stopReason??=campaign.tokenBudget.stopReason;if(Date.now()>=deadline)campaign.stopReason??='CAMPAIGN_DEADLINE';atomicJson(path.join(directory,'summary.json'),campaign);fs.writeFileSync(path.join(directory,'report.md'),renderReport(campaign));};
 try{
  if(verifiedAdmission)writeOnce(path.join(directory,'admission.json'),{...admission,reverified:verifiedAdmission});
  writeOnce(path.join(directory,'campaign.json'),campaign);fs.cpSync(path.join(BASE,'bench'),path.join(directory,'engine-snapshot'),{recursive:true});if(digest(implementationHashes(path.join(directory,'engine-snapshot')))!==identity.engine)throw Error('engine changed during snapshot');
  const pool=await runPool(cells,profile.concurrency,async({caseId,repetition})=>{
   campaign.started++;campaign.notStarted=campaign.planned-campaign.started;save();
   const scenario=CASES.find(c=>c.id===caseId),requirements=`# ${scenario.title}\n\n${scenario.requirements.map((r,i)=>`${i+1}. ${r}`).join('\n')}`;
   let manifest;
   try{
    manifest=await prepareCase({base:BASE,campaignId:id,caseId,repetition,profile:caseProfiles[caseId].profile,requestedProfile:profile,requirements,trajectory:scenario.trajectory??{minSlices:1},deadline,sourceRoot:source.sourceRoot,engineRoot:path.join(directory,'engine-snapshot')});
    if(manifest.fixtureDigest!==identity.fixture||manifest.sourceProof.sha256TreeDigest!==identity.source)throw Error('campaign immutable snapshot drift');
    await environmentPreflight({manifest,deadline});
   }catch(error){return {caseId,repetition,status:'PREPARATION_FAILED',measurement:'diagnostic',error:String(error.message),evidence:path.join(directory,`${caseId}-${repetition}`)};}
   const result=await executeCase({manifest,campaignDeadline:deadline,requirements,campaignBudget:budget});
   const observedIdentity=campaignIdentity(profile,source.sourceRoot);
   const snapshotIntegrity={engine:digest(implementationHashes(manifest.engineRoot)),scenarioOracle:digest({cases:CASES,oracles:treeHashes(path.join(manifest.engineRoot,'cases'))})};
   const integrity=digest(observedIdentity)===digest(identity)&&snapshotIntegrity.engine===identity.engine&&snapshotIntegrity.scenarioOracle===identity.scenarioOracle;
   const runnerContractProof=collectRunnerContractProof({manifest,usage:result.usage,events:path.join(manifest.evidence,'events.jsonl')});writeOnce(path.join(manifest.evidence,'runner-contract-proof.json'),runnerContractProof);
   const harness=assessHarnessObservation({result,integrity,configuration:result.usage?.configuration,runnerContractProof,trajectoryStatus:result.trajectoryStatus});
   const classification=classifyMeasurement({mode,qualificationMatches:!!verifiedAdmission,harnessValid:harness.harnessValid,outcome:result.status,closed:result.closed,oracle:result.oracle});
   const observation={...classification,...harness,identityAtStart:identity,identityAtEnd:observedIdentity,snapshotIntegrity,runnerContractProofStatus:runnerContractProof.status,classificationIsProspective:true};writeOnce(path.join(manifest.evidence,'measurement-admission.json'),observation);
   return{...result,...classification,...harness,runnerContractProofStatus:runnerContractProof.status};
  },{
   admit:()=>{if(Date.now()>=deadline){campaign.stopReason??='CAMPAIGN_DEADLINE';return false;}if(!budget.admit()){campaign.stopReason??=budget.snapshot().stopReason;return false;}return true;},
   onResult:result=>{campaign.results.push({...result,usage:undefined});save();}
  });
  campaign.started=pool.started;campaign.notStarted=pool.notStarted;campaign.stopped=pool.stopped;
 }catch(error){campaign.stopReason??='HARNESS_FAILED';campaign.error=String(error.message);throw error;}
 finally{campaign.finishedAt=Date.now();try{save();}finally{release();}}
 return campaign;
}
