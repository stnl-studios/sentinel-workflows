import fsSync from'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const USAGE_FIELDS=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const sha=s=>createHash('sha256').update(s).digest('hex');
const normalize=u=>Object.fromEntries(USAGE_FIELDS.map(k=>{const v=u?.[k]??u?.[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase())];return[k,Number.isSafeInteger(v)&&v>=0?v:null]}));
const sandboxName=x=>({readOnly:'read-only',workspaceWrite:'workspace-write',dangerFullAccess:'danger-full-access'}[x]??x);
const selectedConfig=p=>({model:p.model??null,effort:p.effort??p.reasoning_effort??p.reasoningEffort??null,sandbox:sandboxName(p.sandbox_policy?.type??p.sandbox?.type??(typeof p.sandbox==='string'?p.sandbox:null)),approval:p.approval_policy??p.approvalPolicy??null,network:p.sandbox_policy?.network_access??p.sandbox?.networkAccess??null});
function totals(rs){return Object.fromEntries(USAGE_FIELDS.map(k=>{const known=rs.filter(r=>r.usage[k]!==null);return[k,{value:known.length?known.reduce((n,r)=>n+r.usage[k],0):null,knownResponses:known.length,missingResponses:rs.length-known.length,complete:rs.length>0&&known.length===rs.length}]}))}
async function filesUnder(dir){if(!dir)return[];let entries;try{entries=await fs.readdir(dir,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return[];throw e}const out=[];for(const e of entries){if(e.isSymbolicLink())continue;const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await filesUnder(p));else if(e.isFile()&&e.name.endsWith('.jsonl'))out.push(p)}return out.sort()}
async function lines(file,gaps,accept){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Expected regular evidence file: '+file);const text=await fs.readFile(file,'utf8'),ls=text.split('\n');if(ls.at(-1)!=='')gaps.push({code:'PARTIAL_TRAILING_LINE',file});ls.pop();const rows=[];for(let i=0;i<ls.length;i++){const line=ls[i];if(!accept(line))continue;try{rows.push({row:JSON.parse(line),source:{file,line:i+1,sha256:sha(line)}})}catch{gaps.push({code:'INVALID_JSON',file,line:i+1})}}return rows}
/** agentNamePrefix matches exact final segment or a numeric _/- suffix, never arbitrary text. */
function resolveRole(agentPath,rules){
 if(typeof agentPath!=='string'||!agentPath.startsWith('/'))return null;
 const name=agentPath.split('/').at(-1),ranked=[];
 for(const r of rules){let rank=0,length=0;
  if(r.agentPath===agentPath){rank=4;length=agentPath.length}
  else if(r.agentName===name){rank=3;length=name.length}
  else if(typeof r.agentNamePrefix==='string'&&r.agentNamePrefix&&!r.agentNamePrefix.includes('/')){const suffix=name.slice(r.agentNamePrefix.length);if(name.startsWith(r.agentNamePrefix)&&/^(?:[_-][0-9]+|_slice_[0-9]+(?:_round_[0-9]+)?)?$/.test(suffix)){rank=2;length=r.agentNamePrefix.length}}
  if(!rank&&r.prefix?.startsWith('/')&&(agentPath===r.prefix||agentPath.startsWith(r.prefix.endsWith('/')?r.prefix:r.prefix+'/'))){rank=1;length=r.prefix.length}
  if(rank)ranked.push({role:r.role,rank,length});
 }
 ranked.sort((a,b)=>b.rank-a.rank||b.length-a.length);const best=ranked.filter(r=>r.rank===ranked[0]?.rank&&r.length===ranked[0]?.length);
 return new Set(best.map(r=>r.role)).size===1?best[0].role:null;
}
// Deliberately narrower than shell grammar. No evaluation, escapes, expansion or operators.
function literalTokens(command){
 if(typeof command!=='string'||/[\r\n;$|&<>`\\*?\[\]{}~]/.test(command))return null;
 const shell=/^\/bin\/(?:zsh|bash|sh) -lc (["'])(.*)\1$/.exec(command);if(shell)command=shell[2];
 const tokens=[];let token='',quote=null,started=false;
 for(const c of command){if(quote){if(c===quote)quote=null;else token+=c;started=true;}else if(c==='"'||c==="'"){quote=c;started=true;}else if(/\s/.test(c)){if(started){tokens.push(token);token='';started=false;}}else{token+=c;started=true;}}
 if(quote)return null;if(started)tokens.push(token);return tokens;
}
function allowedHandle(handle,cwd,authorizedTempRoots=[]){
 if(typeof handle!=='string'||handle.split('/').includes('..'))return false;
 const target=path.resolve(cwd,handle),roots=[cwd,...authorizedTempRoots];
 if(!roots.some(root=>path.isAbsolute(root)&&target.startsWith(path.resolve(root)+path.sep)))return false;
 let at=path.parse(target).root;for(const part of target.slice(at.length).split(path.sep)){at=path.join(at,part);try{if(fsSync.lstatSync(at).isSymbolicLink())return false;}catch(e){if(e.code!=='ENOENT')return false;break;}}
 return true;
}

function nativeRoleRecords(publicRows,sessionRoot,metadata,authorizedTempRoots){
 if(typeof sessionRoot!=='string'||!sessionRoot)return [];
 const home=path.dirname(path.resolve(sessionRoot)),runtimes=new Set(['stnl-slice-executor','stnl-slice-quality-manager'].map(skill=>path.join(home,'skills',skill,'runtime/execution-current-operation.mjs')));
 const out=[];
 for(const {row,source} of publicRows){
  const p=row.payload?.params,i=p?.item;
  if(row.payload?.method!=='item/completed'||i?.type!=='commandExecution'||i.exitCode!==0||!p.threadId||!p.turnId||typeof i.command!=='string')continue;
  const tokens=literalTokens(i.command);if(!tokens||!['node',process.execPath].includes(tokens[0])||!runtimes.has(tokens[1])||!['reserve-dispatch','bind-native'].includes(tokens[2]))continue;
  const allowed=tokens[2]==='reserve-dispatch'?new Set(['--handle','--response-variant','--terminal']):new Set(['--handle','--agent-id']);
  const args={};let valid=true;for(let n=3;n<tokens.length;){const flag=tokens[n++];if(!allowed.has(flag)||args[flag]!==undefined){valid=false;break;}if(flag==='--terminal'){args[flag]=true;continue;}const value=tokens[n++];if(!value||value.startsWith('--')){valid=false;break;}args[flag]=value;}
  if(!valid||!args['--handle']||(tokens[2]==='bind-native'&&!args['--agent-id']))continue;
  const cwds=[...new Set(metadata.filter(m=>m.threadId===p.threadId&&typeof m.cwd==='string').map(m=>m.cwd))];
  if(cwds.length!==1||!path.isAbsolute(cwds[0])||i.cwd!==cwds[0])continue;
  const cwd=path.resolve(cwds[0]),handle=path.resolve(cwd,args['--handle']);
  if(!allowedHandle(args['--handle'],cwd,authorizedTempRoots))continue;
  let data;try{data=JSON.parse(i.aggregatedOutput);}catch{continue;}
  if(typeof data.originFile!=='string'||!path.isAbsolute(data.originFile)||!/^.*\/round-[0-9]+\.origin\.json$/.test(data.originFile))continue;
  if(data.originFile.split('/').includes('..')||!path.resolve(data.originFile).startsWith(path.join(cwd,'tmp/sentinel')+path.sep))continue;
  const common={parentThreadId:p.threadId,parentTurnId:p.turnId,originFile:data.originFile,handle,source,itemId:i.id};
  if(tokens[2]==='reserve-dispatch'&&data.phase==='dispatch-reserved'&&typeof data.owner?.operationAttemptId==='string'&&typeof data.dispatchId==='string'&&/^sha256:[a-f0-9]{64}$/.test(data.requestSha256??'')&&typeof data.owner?.slice==='string')out.push({...common,kind:'reserve',operation:data.owner.operation,operationAttemptId:data.owner.operationAttemptId,dispatchId:data.dispatchId,requestSha256:data.requestSha256,slice:data.owner.slice});
  if(tokens[2]==='bind-native'&&data.phase==='running'&&data.agentId===args['--agent-id']&&/^\/root\/[a-zA-Z0-9_/-]+$/.test(data.agentId??''))out.push({...common,kind:'bind',agentPath:data.agentId});
 }
 return out;
}
function nativeRoleFor({parents,paths,metadata,records,roots}){
 if(parents.length!==1||paths.length!==1||!roots.has(parents[0]))return {role:null,evidence:[],conflict:false};
 const binds=records.filter(r=>r.kind==='bind'&&r.parentThreadId===parents[0]&&r.agentPath===paths[0]),evidence=[];
 const aliases=new Set(metadata.filter(m=>m.parentThreadId===parents[0]&&m.agentPath===paths[0]).map(m=>m.threadId));
 if(binds.length&&aliases.size!==1)return{role:null,evidence:binds,conflict:true};
 let incomplete=false;
 for(const bind of binds){
  const reservations=records.filter(r=>r.kind==='reserve'&&r.parentThreadId===bind.parentThreadId&&r.parentTurnId===bind.parentTurnId&&r.originFile===bind.originFile&&r.handle===bind.handle);
  const keys=new Set(reservations.map(r=>JSON.stringify([r.operation,r.slice,r.operationAttemptId,r.dispatchId,r.requestSha256])));
  if(keys.size!==1){incomplete=true;continue;}
  const r=reservations[0],role={EXECUTE_SLICE:'execute_check',APPLY_FINDINGS:'execute_check',VALIDATE_SLICE:'formal_validate'}[r.operation];
  if(!role){incomplete=true;continue;}
  evidence.push({role,operation:r.operation,slice:r.slice,operationAttemptId:r.operationAttemptId,dispatchId:r.dispatchId,requestSha256:r.requestSha256,originFile:r.originFile,reservation:r.source,binding:bind.source,agentPath:bind.agentPath,parentThreadId:bind.parentThreadId,parentTurnId:bind.parentTurnId});
 }
 const identities=new Set(evidence.map(e=>JSON.stringify([e.role,e.operationAttemptId,e.dispatchId,e.requestSha256,e.originFile]))),roles=new Set(evidence.map(e=>e.role));
 return{role:!incomplete&&identities.size===1&&roles.size===1?evidence[0].role:null,evidence,conflict:incomplete||identities.size>1};
}
function reviewRoleFor({threadId,parents,metadata,rootThreads,eventScopes}){
 if(parents.length!==1)return {role:null,evidence:[],conflict:false};
 const parent=parents[0],declared=rootThreads.filter(r=>r.threadId===parent),stages=[...new Set(declared.map(r=>r.stage))];
 if(!stages.includes('REVIEW_PLAN'))return {role:null,evidence:[],conflict:false};
 const siblings=new Set(metadata.filter(m=>m.parentThreadId===parent).map(m=>m.threadId));
 const dispatches=eventScopes.filter(e=>e.explicit&&e.threadId===parent);
 const conflict=stages.length!==1||siblings.size!==1||!siblings.has(threadId)||dispatches.some(e=>e.context.stage!=='REVIEW_PLAN');
 return {role:conflict?null:'plan_review',conflict,evidence:[{kind:'observed-parent-stage-and-unique-child',parentThreadId:parent,stage:'REVIEW_PLAN',childThreadId:threadId,rootDeclaration:declared,relationSources:metadata.filter(m=>m.threadId===threadId&&m.parentThreadId===parent).map(m=>m.source),dispatchSources:dispatches.map(e=>e.source),limitation:'Role attribution only; official plan approval and byte binding require a separate gate.'}]};
}
/** Read-only telemetry. Local CLI records are version-specific observations, not billing truth. */
export async function collectUsage({sessionRoot,eventFiles=[],rootThreads=[],roleRules=[],expectedProfile={},threadConfigurations=[],roleAuthority='name-fallback',authorizedTempRoots=[]}={}){
 if(!['native','name-fallback'].includes(roleAuthority))throw Error('INVALID_ROLE_AUTHORITY');
 const gaps=[],observations=[],metadata=[],contexts=[],snapshots=[],eventScopes=[],publicRows=[];const roots=new Map(rootThreads.map(r=>[r.threadId,r]));
 for(const file of await filesUnder(sessionRoot))for(const {row:r,source} of await lines(file,gaps,l=>/"type"\s*:\s*"(?:session_meta|token_usage_record|turn_context)"/.test(l))){const p=r.payload??{};source.ordinal=r.ordinal??null;if(r.type==='session_meta')metadata.push({threadId:p.id,parentThreadId:p.parent_thread_id??p.source?.subagent?.thread_spawn?.parent_thread_id??null,agentPath:p.agent_path??p.source?.subagent?.thread_spawn?.agent_path??null,cwd:p.cwd??null,cliVersion:p.cli_version??null,source});else if(r.type==='turn_context')contexts.push({turnId:p.turn_id,rootTurnId:p.root_turn_id??null,actual:selectedConfig(p),cwd:p.cwd??null,source});else if(r.type==='token_usage_record')observations.push({sourceKind:'local-rollout',threadId:p.thread_id,turnId:p.turn_id,rootTurnId:p.root_turn_id??null,responseId:p.response_id,at:r.timestamp??null,usage:normalize(p.usage),turnCumulative:normalize(p.turn_token_usage),threadCumulative:normalize(p.thread_token_usage),source});}
 for(const file of eventFiles){let threadId=null,turnId=null;for(const {row:r,source} of await lines(file,gaps,()=>true)){publicRows.push({row:r,source});const p=r.payload??{},q=p.params??{},ctx=p.method==='benchmark/dispatch'?(q.context??r.context??{}):(r.context??{});if(r.kind==='dispatch.intent')threadId=p.resumeThread??threadId;if(p.type==='thread.started')threadId=p.thread_id;if(r.kind==='thread.effective')threadId=p.threadId;if(r.kind==='dispatch.accepted')turnId=p.turnId;if(p.method==='benchmark/dispatch'){threadId=q.threadId??threadId;turnId=q.turnId??turnId;if(!q.threadId||!q.turnId)gaps.push({code:'DISPATCH_CONTEXT_IDENTITY_MISSING',source})}if(p.method==='turn/started'){threadId=q.threadId??threadId;turnId=q.turn?.id??turnId}if(Object.keys(ctx).length&&(q.threadId??threadId))eventScopes.push({threadId:q.threadId??threadId,turnId:q.turnId??q.turn?.id??turnId,context:ctx,explicit:p.method==='benchmark/dispatch',at:r.at??null,source});if(p.method==='rawResponse/completed')observations.push({sourceKind:'public-raw',threadId:q.threadId,turnId:q.turnId,rootTurnId:null,responseId:q.responseId,at:r.at??null,context:ctx,usage:normalize(q.usage),source});if(p.method==='thread/tokenUsage/updated')snapshots.push({kind:'thread-cumulative',threadId:q.threadId,turnId:q.turnId,at:r.at??null,usage:normalize(q.tokenUsage?.total),context:ctx,source});if(p.type==='turn.completed')snapshots.push({kind:'sdk-terminal-cumulative',threadId,turnId,at:r.at??null,usage:normalize(p.usage),context:ctx,source});}}
 const groups=new Map();for(const o of observations){if(!o.threadId||!o.responseId){gaps.push({code:'RESPONSE_IDENTITY_MISSING',source:o.source});continue}const key=o.threadId+'/'+o.responseId;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o)}
 const responses=[],sourceComparisons=[];for(const list of groups.values()){list.sort((a,b)=>Number(b.sourceKind==='local-rollout')-Number(a.sourceKind==='local-rollout'));const first=list[0],usage={...first.usage},conflicts=[];for(const k of USAGE_FIELDS){const vals=new Set(list.map(x=>x.usage[k]).filter(x=>x!==null));if(vals.size>1){usage[k]=null;conflicts.push(k)}else if(vals.size===1)usage[k]=[...vals][0]}if(conflicts.length)gaps.push({code:'CONFLICTING_USAGE',threadId:first.threadId,responseId:first.responseId,fields:conflicts});responses.push({...first,usage,sources:list.map(x=>({kind:x.sourceKind,...x.source})),context:list.find(x=>x.context&&Object.keys(x.context).length)?.context??null,conflicts});if(list.length>1)sourceComparisons.push({threadId:first.threadId,responseId:first.responseId,status:conflicts.length?'CONFLICT':'CONSISTENT',sources:list.map(x=>x.source),fields:conflicts});}
 const nativeRecords=nativeRoleRecords(publicRows,sessionRoot,metadata,authorizedTempRoots);
 const ids=new Set([...roots.keys(),...metadata.map(m=>m.threadId),...responses.map(r=>r.threadId)].filter(Boolean)),threadTree=[];
 for(const threadId of ids){
  const ms=metadata.filter(m=>m.threadId===threadId),parents=[...new Set(ms.map(m=>m.parentThreadId).filter(Boolean))],paths=[...new Set(ms.map(m=>m.agentPath).filter(Boolean))];
  if(parents.length>1||paths.length>1)gaps.push({code:'CONFLICTING_THREAD_RELATION',threadId});
  const root=roots.get(threadId),declaredRoles=[...new Set(eventScopes.filter(e=>e.explicit&&e.threadId===threadId&&typeof e.context.role==='string').map(e=>e.context.role))];
  const namedRole=paths.length===1?resolveRole(paths[0],roleRules):null,native=nativeRoleFor({parents,paths,metadata,records:nativeRecords,roots});
  const review=reviewRoleFor({threadId,parents,metadata,rootThreads,eventScopes}),roleConflict=parents.length>1||paths.length>1||native.conflict||review.conflict||(native.role&&review.role&&native.role!==review.role);
  const role=roleConflict?null:root?.role??(root&&declaredRoles.length===1?declaredRoles[0]:null)??native.role??review.role??(roleAuthority==='native'&&['execute_check','formal_validate','plan_review'].includes(namedRole)?null:namedRole);
  if(native.conflict)gaps.push({code:'CONFLICTING_NATIVE_ROLE_BINDING',threadId});
  if(review.conflict||(native.role&&review.role&&native.role!==review.role))gaps.push({code:'CONFLICTING_REVIEW_STAGE_ROLE_BINDING',threadId});
  threadTree.push({threadId,parentThreadId:parents.length===1?parents[0]:null,agentPath:paths.length===1?paths[0]:null,role:role??'unknown',roleEvidence:[...native.evidence,...review.evidence],roleProvenance:roleConflict?'conflicting-evidence':native.role?'observed-public-native-reservation-and-binding':review.role?'observed-parent-stage-and-unique-child':'root-or-name-rule',labelMismatch:Boolean((native.role??review.role)&&namedRole&&(native.role??review.role)!==namedRole),caseId:root?.caseId??null,stage:root?.stage??null,relationStatus:parents.length>1||paths.length>1?'CONFLICT':'OBSERVED',sources:ms.map(m=>m.source)});
  if(!role)gaps.push({code:'UNKNOWN_ROLE',threadId});
 }
 for(const t of threadTree){let at=t,seen=new Set();while(!t.caseId&&at.parentThreadId&&!seen.has(at.threadId)){seen.add(at.threadId);at=threadTree.find(x=>x.threadId===at.parentThreadId);if(!at)break;t.caseId=at.caseId}if(at&&seen.has(at.threadId))gaps.push({code:'THREAD_CYCLE',threadId:t.threadId})}
 const inScope=id=>{if(!roots.size)return true;const seen=new Set();while(id&&!seen.has(id)){if(roots.has(id))return true;seen.add(id);id=threadTree.find(t=>t.threadId===id)?.parentThreadId}return false};
 const excludedResponses=responses.filter(r=>!inScope(r.threadId)).map(r=>({threadId:r.threadId,responseId:r.responseId,reason:'Not linked to selected root threads'}));for(let i=responses.length-1;i>=0;i--)if(!inScope(responses[i].threadId))responses.splice(i,1);if(excludedResponses.length)gaps.push({code:'UNRELATED_OR_UNLINKED_RESPONSES_EXCLUDED',count:excludedResponses.length});
 const configuration=[];for(const t of threadTree){const ts=[...new Set(responses.filter(r=>r.threadId===t.threadId).map(r=>r.turnId))];const checks=[];for(const turnId of ts){const cs=contexts.filter(c=>c.turnId===turnId),expected=expectedProfile.roles?.[t.role]??null;const variants=[...new Set(cs.map(c=>JSON.stringify(c.actual)))];const actual=cs[0]?{...cs[0].actual}:null,fallbacks=[],fallbackConflicts=[];
 const acknowledgments=threadConfigurations.filter(x=>x.threadId===t.threadId&&x.source&&typeof x.source.file==='string'&&typeof x.source.sha256==='string').map(x=>({actual:selectedConfig(x),source:x.source}));
 if(actual)for(const field of Object.keys(actual)){if(actual[field]!==null&&actual[field]!==undefined)continue;const known=acknowledgments.filter(x=>x.actual[field]!==null&&x.actual[field]!==undefined),values=[...new Set(known.map(x=>x.actual[field]))];if(values.length===1){actual[field]=values[0];fallbacks.push({field,value:values[0],sources:known.map(x=>x.source),assumption:'Observed thread configuration remains immutable across turns; adapter must prohibit turn-level security/model overrides.'})}else if(values.length>1){fallbackConflicts.push(field);gaps.push({code:'CONFLICTING_THREAD_CONFIGURATION_FALLBACK',threadId:t.threadId,turnId,field,sources:known.map(x=>x.source)})}}
 const missing=actual&&expected?Object.keys(expected).filter(k=>actual[k]===null||actual[k]===undefined):[],mismatches=actual&&expected?Object.keys(expected).filter(k=>actual[k]!=null&&actual[k]!==expected[k]):[];checks.push({turnId,actual,expected,fallbacks,fallbackConflicts,status:variants.length>1?'CONFLICT':!actual?'MISSING':!expected?'UNKNOWN_ROLE_PROFILE':mismatches.length?'MISMATCH':fallbackConflicts.length?'UNKNOWN_THREAD_CONFIGURATION':missing.length?'MISSING':'MATCH',missing,mismatches,sources:cs.map(c=>c.source)})}configuration.push({threadId:t.threadId,role:t.role,status:!checks.length?'MISSING':checks.every(c=>c.status==='MATCH')?'MATCH':checks.some(c=>['CONFLICT','MISMATCH'].includes(c.status))?'MISMATCH':'UNKNOWN',turns:checks,equivalenceClaimAllowed:checks.length>0&&checks.every(c=>c.status==='MATCH')})}
 const byCycle=new Map(),byRole=new Map();for(const r of responses){const t=threadTree.find(t=>t.threadId===r.threadId),candidates=eventScopes.filter(e=>(e.threadId===r.threadId&&e.turnId===r.turnId)||(e.turnId&&e.turnId===r.rootTurnId)),direct=candidates.filter(e=>e.threadId===r.threadId&&e.turnId===r.turnId),preferred=direct.length?direct:candidates,explicit=preferred.filter(e=>e.explicit),scopes=explicit.length?explicit:preferred;const signatures=[...new Set(scopes.map(e=>JSON.stringify({caseId:e.context.caseId,stage:e.context.stage})))];const context=explicit.length?(signatures.length===1?scopes[0].context:{}):(r.context??(signatures.length===1?scopes[0].context:{}));if(signatures.length>1)gaps.push({code:'CONFLICTING_CYCLE_CONTEXT',threadId:r.threadId,turnId:r.turnId});const caseId=context.caseId??t?.caseId??null,stage=context.stage??roots.get(r.threadId)?.stage??null,role=t?.role??'unknown';r.attribution={caseId,stage,role};const key=JSON.stringify([caseId,r.threadId,r.turnId]);if(!byCycle.has(key))byCycle.set(key,{caseId,stage,role,threadId:r.threadId,turnId:r.turnId,rootTurnId:r.rootTurnId,rs:[]});byCycle.get(key).rs.push(r);const rk=JSON.stringify([caseId,role]);if(!byRole.has(rk))byRole.set(rk,{caseId,role,rs:[]});byRole.get(rk).rs.push(r)}
 for(const s of snapshots){const eligible=responses.filter(r=>r.threadId===s.threadId&&r.at&&s.at&&r.at<=s.at);const observed=totals(eligible);const fields=Object.fromEntries(USAGE_FIELDS.map(k=>[k,s.usage[k]===null||!observed[k].complete?'UNKNOWN':observed[k].value===s.usage[k]?'MATCH':'DIFFERENT']));sourceComparisons.push({kind:s.kind,threadId:s.threadId,source:s.source,fields,note:'Cumulative alternative observation; never added to response totals.'})}
 if(!responses.length)gaps.push({code:'NO_RESPONSE_USAGE'});gaps.push({code:'IN_FLIGHT_OR_UNFLUSHED_USAGE_NOT_OBSERVABLE'});
 return{schemaVersion:1,excludedResponses,provenance:'Selected local CLI session schema plus public events; local format version-specific, not public API guarantee.',observations,responses,threadTree,cycles:[...byCycle.values()].map(({rs,...x})=>({...x,responseCount:rs.length,usage:totals(rs)})),roles:[...byRole.values()].map(({rs,...x})=>({...x,responseCount:rs.length,usage:totals(rs)})),configuration,sourceComparisons,observedTotals:totals(responses),gaps,semantics:{billingEstimate:false,cumulativeSnapshotsAdded:false,cacheIsInputSubset:true,reasoningIsOutputSubset:true,budgetObservationDelayed:true,roleAuthority,unknownConfigurationInvalidatesUsage:false}};
}
