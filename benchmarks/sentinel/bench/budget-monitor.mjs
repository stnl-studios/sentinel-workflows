/** Operational guard only. Cumulative thread counters are alternative observations,
 * not reconciled response totals, and never establish billed consumption. */
export class UsageBudgetMonitor {
 constructor({limit,onLimit=()=>{}}={}){
  if(limit!==null&&(!Number.isSafeInteger(limit)||limit<=0))throw new TypeError('limit must be a positive safe integer');
  if(typeof onLimit!=='function')throw new TypeError('onLimit must be a function');
  this.limit=limit;this.onLimit=onLimit;this.threads=new Map();this.gaps=[];this.triggered=false;this.ignoredRawResponses=0;
 }
 observe(payload){
  if(payload?.method==='rawResponse/completed'){this.ignoredRawResponses++;return this.snapshot();}
  if(payload?.method!=='thread/tokenUsage/updated')return this.snapshot();
  const threadId=payload.params?.threadId,total=payload.params?.tokenUsage?.total?.totalTokens;
  if(typeof threadId!=='string'||!threadId.trim()){this.gaps.push({code:'MISSING_THREAD_ID'});return this.snapshot();}
  if(!Number.isSafeInteger(total)||total<0){this.gaps.push({code:'INVALID_OR_MISSING_COUNTER',threadId});return this.snapshot();}
  const previous=this.threads.get(threadId);
  if(previous!==undefined&&total<previous)this.gaps.push({code:'COUNTER_REGRESSION',threadId,previous,observed:total});
  this.threads.set(threadId,Math.max(previous??0,total));
  // Saturate overflow rather than wrapping or pretending precision.
  let observed=0;for(const value of this.threads.values()){if(value>Number.MAX_SAFE_INTEGER-observed){observed=Number.MAX_SAFE_INTEGER;if(!this.gaps.some(x=>x.code==='SUM_SATURATED'))this.gaps.push({code:'SUM_SATURATED'});break}observed+=value;}
  if(this.limit!==null&&!this.triggered&&observed>=this.limit){this.triggered=true;this.onLimit(this.snapshot());}
  return this.snapshot();
 }
 snapshot(){
  let sum=0;for(const value of this.threads.values())sum=Math.min(Number.MAX_SAFE_INTEGER,sum+value);
  return{limit:this.limit,triggered:this.triggered,operationalObservedTokens:this.threads.size?sum:null,threads:[...this.threads].map(([threadId,maxObservedTotalTokens])=>({threadId,maxObservedTotalTokens})),ignoredRawResponses:this.ignoredRawResponses,gaps:this.gaps.map(x=>({...x})),semantics:{purpose:this.limit===null?'observation only':'additional conservative in-turn guard',billingTotal:false,reportTotal:false,rawAndCumulativeCombined:false,parentChildCounterInclusion:'unknown',assumption:'Thread counters treated as distinct for this guard; parent-inclusive counters can cause early conservative stop.',inFlightOrUnreportedUsageMayBeMissing:true,notHardSpendingCeiling:true}};
 }
}
