import {resolveCaseProfile,PROFILE_CASE_IDS} from './case-profile.mjs';
const STAGES=['INIT','READINESS','PLAN','REVIEW_PLAN','EXECUTE_SLICE','APPLY_FINDINGS','VALIDATE_SLICE','CLOSE'];
const TOKEN_FIELDS=['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const canonical=x=>JSON.stringify(x&&typeof x==='object'?Array.isArray(x)?x.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>[k,JSON.parse(canonical(x[k]))])):x);
const equal=(a,b)=>canonical(a)===canonical(b);
const selected=p=>p.suiteCases??PROFILE_CASE_IDS;
const bindingKey=b=>[b.caseId,b.stage,b.actor,b.logicalRole].join('/');
/** Configuration intent, not evidence that the provider applied it. */
export function resolveEffectiveComparisonConfig(profile){
 const cases=selected(profile);if(!Array.isArray(cases)||!cases.length||new Set(cases).size!==cases.length)throw Error('invalid suiteCases');
 const bindings=[];
 for(const caseId of cases){const p=resolveCaseProfile(profile,caseId);
  const add=(stage,actor,logicalRole,role)=>bindings.push({caseId,stage,actor,logicalRole,...p.roles[role]});
  for(const stage of STAGES)add(stage,'coordinator','coordinator',p.stageRoles?.[stage]??'coordinator');
  add('APPROVE_PLAN','independent-approver','plan_approver','plan_approver');
  add('REVIEW_PLAN','native-child','plan_review','plan_review');
  for(const stage of ['EXECUTE_SLICE','APPLY_FINDINGS'])add(stage,'native-child','execute_check','execute_check');
  for(const stage of ['VALIDATE_SLICE','CLOSE'])add(stage,'native-child','formal_validate','formal_validate');
 }
 const {id,roles,stageRoles,caseOverrides,sentinelRevision,...controls}=profile;
 return {controls,bindings};
}
function cells(c){return c.plannedCells??(c.caseIds??selected(c.profile)).flatMap(caseId=>Array.from({length:c.repetitions??c.profile.repetitions},(_,i)=>({caseId,repetition:i+1})));}
const key=x=>`${x.caseId}/${x.repetition}`;
function latest(c){const map=new Map();for(const r of c.results??[]){const k=key(r);if(map.has(k))throw Error('duplicate result '+k);map.set(k,r);}return map;}
function verifyObserved(campaign, rows, expected, missing, fail, label) {
 for(const [cellKey,row] of rows){
  const cycles=stageObservations(campaign,row);
  if(!cycles.length){missing('CYCLE_CONFIGURATION_EVIDENCE_MISSING:'+label+':'+cellKey);continue;}
  const seen=new Set();
  for(const cycle of cycles){
   const cycleKey=cycle.threadId+'/'+cycle.turnId;
   if(!cycle.threadId||!cycle.turnId||seen.has(cycleKey)){fail('CYCLE_IDENTITY_INVALID:'+label+':'+cellKey);continue;}seen.add(cycleKey);
   if(cycle.caseId!==row.caseId){fail('CYCLE_CASE_CONFLICT:'+label+':'+cellKey);continue;}
   const p=resolveCaseProfile(campaign.profile,row.caseId);
   let actor,logicalRole;
   if(cycle.role==='plan_approver'){actor='independent-approver';logicalRole='plan_approver';}
   else if(['plan_review','execute_check','formal_validate'].includes(cycle.role)){actor='native-child';logicalRole=cycle.role;}
   else if(cycle.role===(p.stageRoles?.[cycle.stage]??'coordinator')){actor='coordinator';logicalRole='coordinator';}
   const binding=expected.bindings.find(b=>b.caseId===row.caseId&&b.stage===cycle.stage&&b.actor===actor&&b.logicalRole===logicalRole);
   if(!binding){missing('CYCLE_ROLE_BINDING_UNKNOWN:'+label+':'+cellKey);continue;}
   const thread=(row.usage?.configuration??[]).filter(t=>t.threadId===cycle.threadId&&t.role===cycle.role);
   const turns=thread.flatMap(t=>t.turns??[]).filter(t=>t.turnId===cycle.turnId);
   if(turns.length!==1){missing('PROVIDER_CONFIG_MISSING_OR_AMBIGUOUS:'+label+':'+cellKey);continue;}
   const actual=turns[0].actual;
   const security={sandbox:actor==='independent-approver'?'read-only':'workspace-write',approval:'never',network:false};
   for(const [field,value] of Object.entries({...security,model:binding.model,effort:binding.effort})){
    if(actual?.[field]===undefined)missing('PROVIDER_CONFIG_FIELD_MISSING:'+label+':'+field);
    else if(actual[field]!==value)fail('PROVIDER_CONFIG_DIFFERS:'+label+':'+field);
   }
  }
 }
}
export function validateComparison({contract,baseline,candidate}={}){
 const reasons=[],gaps=[],differences=[];
 const fail=x=>reasons.push(x),missing=x=>gaps.push(x);
 for(const [label,c] of [['baseline',baseline],['candidate',candidate]])if(c?.recoveries?.length)missing('UNVERIFIED_RECOVERIES_PRESENT:'+label);
 if(!['sentinel-evolution','stage-model-effort'].includes(contract?.kind))fail('INVALID_COMPARISON_KIND');
 let left,right;
 try{left=resolveEffectiveComparisonConfig(baseline.profile);right=resolveEffectiveComparisonConfig(candidate.profile);}catch(e){fail('INVALID_CONFIGURATION:'+e.message);}
 if(left&&right){
  if(!equal(left.controls,right.controls))fail('GLOBAL_CONTROLS_DIFFER');
  for(const field of ['engine','fixture','scenarioOracle','cliVersion','contextPolicy','adapterProtocol']){
   if(!baseline.identity?.[field]||!candidate.identity?.[field])missing('IDENTITY_MISSING:'+field);
   else if(!equal(baseline.identity[field],candidate.identity[field]))fail('IDENTITY_DIFFERS:'+field);
  }
  for(const [label,c] of [['baseline',baseline],['candidate',candidate]])if(c.identity?.sentinelRevision!==c.profile.sentinelRevision)fail('PROFILE_SOURCE_BINDING_DIFFERS:'+label);
  for(const field of ['source','sentinelRevision']){
   if(!baseline.identity?.[field]||!candidate.identity?.[field])missing('IDENTITY_MISSING:'+field);
   else if(contract?.kind==='stage-model-effort'&&!equal(baseline.identity[field],candidate.identity[field]))fail('FIXED_SOURCE_DIFFERS:'+field);
  }
  const t=contract?.target;
  if(contract?.kind==='stage-model-effort'&&(!t||!Array.isArray(t.caseIds)||!t.caseIds.length||new Set(t.caseIds).size!==t.caseIds.length||t.caseIds.some(c=>!selected(baseline.profile).includes(c))||![...STAGES,'APPROVE_PLAN'].includes(t.stage)||!['coordinator','native-child','independent-approver'].includes(t.actor)||!Array.isArray(t.vary)||!t.vary.length||new Set(t.vary).size!==t.vary.length||t.vary.some(f=>!['model','effort'].includes(f))))fail('INVALID_TARGET');
  if(contract?.kind==='sentinel-evolution'&&t!=null)fail('EVOLUTION_TARGET_NOT_ALLOWED');
  const rm=new Map(right.bindings.map(b=>[bindingKey(b),b]));let targetCount=0;
  for(const a of left.bindings){const b=rm.get(bindingKey(a));if(!b){fail('BINDING_MISSING:'+bindingKey(a));continue;}
   const targeted=t?.caseIds?.includes(a.caseId)&&t.stage===a.stage&&t.actor===a.actor&&(!t.role||t.role===a.logicalRole);if(targeted)targetCount++;
   for(const field of ['model','effort'])if(a[field]!==b[field]){differences.push({binding:bindingKey(a),field,baseline:a[field],candidate:b[field]});if(contract?.kind!=='stage-model-effort'||!targeted||!t.vary?.includes(field))fail('UNDECLARED_DIFFERENCE:'+bindingKey(a)+':'+field);}
  }
  if(left.bindings.length!==right.bindings.length)fail('BINDING_SET_DIFFERS');
  if(contract?.kind==='stage-model-effort'&&!targetCount)fail('TARGET_BINDING_NOT_FOUND');
 }
 let planned=[];
 try{
  const a=cells(baseline),b=cells(candidate);planned=a;
  for(const [label,list] of [['baseline',a],['candidate',b]])if(new Set(list.map(key)).size!==list.length||list.some(c=>!PROFILE_CASE_IDS.includes(c.caseId)||!Number.isSafeInteger(c.repetition)||c.repetition<1))fail('INVALID_CELLS:'+label);
  if(!equal(a.map(key).sort(),b.map(key).sort()))fail('PAIRING_DIFFERS');
  for(const [label,c] of [['baseline',baseline],['candidate',candidate]]){const rows=latest(c);for(const cell of planned){const r=rows.get(key(cell));if(!r)missing('RESULT_MISSING:'+label+':'+key(cell));else if(r.harnessValid!==true)missing('HARNESS_NOT_CONFIRMED:'+label+':'+key(cell));}if([...rows.keys()].some(k=>!planned.some(p=>key(p)===k)))fail('UNPLANNED_RESULT:'+label);if(left&&right)verifyObserved(c,rows,label==='baseline'?left:right,missing,fail,label);}
 }catch(e){fail('INVALID_RESULTS:'+e.message);}
 return {status:reasons.length?'NOT_COMPARABLE':gaps.length?'INCOMPLETE':'COMPARABLE',reasons:[...new Set(reasons)],gaps:[...new Set(gaps)],differences,plannedCells:planned,configurationScope:'declared-effective-intent; provider evidence must be verified upstream',productPass:null};
}
const metric=x=>({value:Number.isFinite(x?.value)&&x.value>=0?x.value:null,complete:x?.complete===true&&Number.isFinite(x?.value)&&x.value>=0});
function delta(a,b){a=metric(a);b=metric(b);return {baseline:a,candidate:b,delta:a.value===null||b.value===null?null:b.value-a.value,complete:a.complete&&b.complete};}
function pairMetrics(a,b){const tokens=(r,f)=>({...r?.tokenMetrics?.[f],complete:r?.tokenMetrics?.[f]?.complete===true&&r?.unreportedUsagePossible!==true});return {durationMs:delta({value:a?.durationMs,complete:a?.durationMs!=null},{value:b?.durationMs,complete:b?.durationMs!=null}),tokens:Object.fromEntries(TOKEN_FIELDS.map(f=>[f,delta(tokens(a,f),tokens(b,f))]))};}
function stageObservations(c,cell){const reports=(c.cycleReports??[]).filter(r=>r.caseId===cell.caseId&&r.repetition===cell.repetition);return reports.flatMap(r=>r.report?.cycles??[]).map(c=>({caseId:c.caseId,stage:c.stage,role:c.role,threadId:c.threadId,turnId:c.turnId,status:c.status,durationMs:c.durationMs,usage:c.usage,completeness:c.completeness}));}
export function buildComparisonReport(args){
 const validation=validateComparison(args);let a,b;try{a=latest(args.baseline);b=latest(args.candidate);}catch{return {...validation,pairs:[],cases:[],limitations:['Invalid input: no descriptive comparison produced.']};}
 const pairs=validation.plannedCells.map(cell=>{const left=a.get(key(cell)),right=b.get(key(cell));
  const snapshots=c=>c?{status:c.status,closed:c.closed??null,oracle:c.oracle??null,measurement:c.measurement??'diagnostic',harnessValid:c.harnessValid??null}:null;
  return {...cell,baseline:snapshots(left),candidate:snapshots(right),metrics:pairMetrics(left,right),stages:{baseline:stageObservations(args.baseline,cell),candidate:stageObservations(args.candidate,cell)}};
 });
 return {...validation,pairs,cases:PROFILE_CASE_IDS.filter(id=>pairs.some(p=>p.caseId===id)).map(caseId=>({caseId,pairs:pairs.filter(p=>p.caseId===caseId)})),limitations:['Descriptive paired observations only; no significance, causal certainty or small-sample ranking.','Cycle arrays retain per-stage/provider identity; durations of overlapping children are not summed as wall time.','Missing values remain null; observed partial token deltas are not billing or complete consumption.','Measurements retain their classification; comparison never promotes diagnostic to official.','A changed stage can change later inputs and outcomes; downstream deltas are end-to-end effects, not isolated stage efficiency.','Configuration is requested intent; source files and provider configuration evidence require independent verification.','Child formal_validate includes possible CLOSE delegation; a single-stage claim must not hide shared role changes.']};
}
