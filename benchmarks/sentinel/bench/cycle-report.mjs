/** Pure projection of reported cycle usage and exact-identity provider observations.
 * Times measure locally observed event boundaries, not model CPU time or billing.
 */
const TOKEN_FIELDS=['inputTokens','cachedInputTokens','cacheWriteInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const key=(threadId,turnId)=>JSON.stringify([threadId,turnId]);
const identity=(threadId,turnId)=>typeof threadId==='string'&&threadId.length>0&&typeof turnId==='string'&&turnId.length>0;
const unique=values=>[...new Set(values)];
function timestamp(value){
 if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value))return null;
 const ms=Date.parse(value);return Number.isFinite(ms)?ms:null;
}
function selectTime(rows,label,gaps){
 if(!rows.length){gaps.push({code:`MISSING_${label}`});return null;}
 const values=rows.map(row=>timestamp(row.at));
 if(values.includes(null)){gaps.push({code:`INVALID_${label}_TIMESTAMP`});return null;}
 if(unique(values).length!==1){gaps.push({code:`CONFLICTING_${label}_TIMESTAMPS`});return null;}
 return values[0];
}
function metric(value){
 const valid=Number.isSafeInteger(value?.value)&&value.value>=0;
 return {value:valid?value.value:null,knownResponses:Number.isSafeInteger(value?.knownResponses)&&value.knownResponses>=0?value.knownResponses:null,missingResponses:Number.isSafeInteger(value?.missingResponses)&&value.missingResponses>=0?value.missingResponses:null,complete:valid&&value?.complete===true};
}
export function buildCycleReport({usage,events=[]}={}){
 const groups=new Map(),gaps=[];
 const get=(threadId,turnId)=>{const k=key(threadId,turnId);if(!groups.has(k))groups.set(k,{threadId,turnId,usage:[],events:[]});return groups.get(k);};
 for(const [index,cycle]of (usage?.cycles??[]).entries()){
  if(!identity(cycle?.threadId,cycle?.turnId)){gaps.push({code:'USAGE_CYCLE_IDENTITY_MISSING',index});continue;}
  get(cycle.threadId,cycle.turnId).usage.push(cycle);
 }
 for(const [index,row]of events.entries()){
  const p=row?.payload,q=p?.params;
  if(!['turn/started','turn/completed','benchmark/dispatch'].includes(p?.method))continue;
  const threadId=q?.threadId,turnId=q?.turnId??q?.turn?.id;
  if(!identity(threadId,turnId)){gaps.push({code:'EVENT_CYCLE_IDENTITY_MISSING',index,method:p.method});continue;}
  if(q.turnId&&q.turn?.id&&q.turnId!==q.turn.id){gaps.push({code:'EVENT_CYCLE_IDENTITY_CONFLICT',index});continue;}
  get(threadId,turnId).events.push(row);
 }
 const cycles=[...groups.values()].map(group=>{
  const issues=[],started=group.events.filter(r=>r.payload.method==='turn/started'),completed=group.events.filter(r=>r.payload.method==='turn/completed');
  const start=selectTime(started,'START',issues),end=selectTime(completed,'COMPLETION',issues);
  const statuses=unique(completed.map(r=>r.payload.params.turn?.status??r.payload.params.status??null));
  let status=null;
  if(statuses.length===1&&typeof statuses[0]==='string'&&statuses[0].length)status=statuses[0];
  else issues.push({code:statuses.length>1?'CONFLICTING_PROVIDER_COMPLETION_STATUS':'MISSING_PROVIDER_COMPLETION_STATUS'});
  let durationMs=null;
  if(start!==null&&end!==null){if(end<start)issues.push({code:'NEGATIVE_OBSERVED_DURATION'});else if(status!==null)durationMs=end-start;}
  const context={};
  for(const field of ['caseId','stage','role']){
   const explicit=group.events.filter(r=>r.payload.method==='benchmark/dispatch').map(r=>r.payload.params.context??r.context??{});
   const candidates=[...group.usage,...(explicit.length?explicit:group.events.map(r=>r.context??{}))];
   const values=unique(candidates.map(c=>c[field]).filter(v=>typeof v==='string'&&v.length));
   context[field]=values.length===1?values[0]:null;
   if(values.length!==1)issues.push({code:values.length?'CONFLICTING_CYCLE_CONTEXT':'MISSING_CYCLE_CONTEXT',field});
  }
  const tokens={};
  for(const field of TOKEN_FIELDS){
   const metrics=group.usage.map(c=>metric(c.usage?.[field]));
   const distinct=unique(metrics.map(m=>JSON.stringify(m)));
   tokens[field]=distinct.length===1?metrics[0]:metric(null);
   if(distinct.length>1)issues.push({code:'CONFLICTING_CYCLE_USAGE',field});
   else if(tokens[field].value===null)issues.push({code:'MISSING_CYCLE_USAGE',field});
   else if(!tokens[field].complete)issues.push({code:'PARTIAL_CYCLE_USAGE',field});
  }
  const reportedCompleteness=TOKEN_FIELDS.every(f=>tokens[f].complete)?'complete':TOKEN_FIELDS.some(f=>tokens[f].value!==null)?'partial':'missing';
  const completeness=status==='completed'?reportedCompleteness:reportedCompleteness==='missing'?'missing':'partial';if(status!=='completed'&&reportedCompleteness!=='missing')issues.push({code:'UNFINISHED_TURN_USAGE_MAY_BE_UNREPORTED'});
  return {...context,threadId:group.threadId,turnId:group.turnId,status,statusSource:status===null?null:'provider-turn-completion',sentinelPass:null,startedAt:start===null?null:new Date(start).toISOString(),completedAt:end===null?null:new Date(end).toISOString(),durationMs,usage:tokens,reportedCompleteness,completeness,usageScope:'reported-records-only-not-billing',gaps:issues};
 });
 return {schemaVersion:1,cycles,gaps,semantics:{timeBasis:'local-event-observation',completionIsSentinelPass:false,tokenValues:'reported-cycle-values-no-snapshot-addition',pricingEstimate:false}};
}
function csvCell(value){
 if(value===null||value===undefined)return '';
 let text=String(value);
 // Quoting alone does not prevent spreadsheet formula evaluation.
 if(typeof value==='string'&&(/^[\t\r\n]/.test(text)||/^\s*[=+\-@]/.test(text)))text="'"+text;
 return /[",\r\n]/.test(text)?'"'+text.replaceAll('"','""')+'"':text;
}
export function toCycleCsv(report){
 const header=['case','stage','role','thread','turn','status','durationMs','inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens','completeness'];
 const rows=(report?.cycles??[]).map(c=>[c.caseId,c.stage,c.role,c.threadId,c.turnId,c.status,c.durationMs,c.usage?.inputTokens?.value,c.usage?.cachedInputTokens?.value,c.usage?.outputTokens?.value,c.usage?.reasoningOutputTokens?.value,c.usage?.totalTokens?.value,c.completeness]);
 return [header,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
