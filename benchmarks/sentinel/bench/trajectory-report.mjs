import path from 'node:path';
/** Pure historical audit. Product acceptance and current source hashes do not
 * retroactively invalidate a slice's observed, hash-bound formal PASS. */
const hash=value=>typeof value==='string'&&/^(?:sha256:)?[a-f0-9]{64}$/.test(value);
const evidenceKey=d=>`${d.deliveryId}/${String(d.evidenceSha256).replace(/^sha256:/,'')}`;
const passEntries=a=>['deliveries','completed'].flatMap(k=>current(a)?.[k]??[]).filter(d=>d?.formalStatus==='PASS'&&hash(d.evidenceSha256));
function canonicalSpec(value){if(typeof value!=='string'||!path.isAbsolute(value)||path.normalize(value)!==value)return null;return path.basename(value)==='feature_spec.md'?path.dirname(value):value;}
const current=a=>a?.current?.exitCode===0?a.current.output:null;
function changed(before,after){
 if(!before||!after||typeof before!=='object'||typeof after!=='object'||Array.isArray(before)||Array.isArray(after))return null;
 if([...Object.values(before),...Object.values(after)].some(v=>!hash(v)))return null;
 return [...new Set([...Object.keys(before),...Object.keys(after)])].filter(p=>before[p]!==after[p]).sort();
}
export function buildTrajectoryReport({caseId,trajectory={},snapshots=[]}={}){
 const checks=[],histories=[],validationProofs=[],executions=[],mutations=[],rows=[],seen=new Map();
 const check=(name,status,details={})=>checks.push({name,status,...details});
 const minSlices=trajectory.minSlices??(caseId==='import'?2:1);
 if(!Number.isSafeInteger(minSlices)||minSlices<1){check('trajectory contract','MISMATCH');return{caseId,status:'MISMATCH',checks,productAcceptance:'SEPARATE',sharedFileChange:{status:'NOT_OBSERVED',paths:[]}};}
 for(const row of snapshots){
  if(!Number.isSafeInteger(row?.index)||row.index<0){check('snapshot index','INCOMPLETE');continue;}
  if(seen.has(row.index)){if(JSON.stringify(seen.get(row.index))!==JSON.stringify(row))check('duplicate snapshot index','MISMATCH',{index:row.index});continue;}
  seen.set(row.index,row);rows.push(row);
 }
 rows.sort((a,b)=>a.index-b.index);
 let specPath=null;
 for(const row of rows){
  const source={index:row.index,stage:row.stage,threadId:row.threadId??null,turnId:row.turnId??null};
  const bindings=[row.beforeAuthority?.specPath,row.afterAuthority?.specPath];
  const specs=bindings.map(canonicalSpec);
  if(specs.some(p=>p===null)){check('canonical SPEC identity',bindings.some(v=>v!=null&&canonicalSpec(v)===null)?'MISMATCH':'INCOMPLETE',source);continue;}
  specPath??=specs[0];
  if(specs.some(p=>p!==specPath)){check('single SPEC binding','MISMATCH',{...source,expected:specPath,observed:specs});continue;}
  source.specPath=specPath;
  if(row.trajectoryRecovery?.status==='INCOMPLETE')check('recovery trajectory evidence','INCOMPLETE',{...source,reason:row.trajectoryRecovery.reason??'RECOVERY_EVIDENCE_MISSING'});
  if(typeof row.threadId!=='string'||!row.threadId||typeof row.turnId!=='string'||!row.turnId)check('snapshot provider identity','INCOMPLETE',source);
  const after=current(row.afterAuthority);
  // Native reader exposes active deliveries and historical completed deliveries
  // with the same public {slice,deliveryId,formalStatus,evidenceSha256} fields.
  for(const collection of ['deliveries','completed'])for(const delivery of after?.[collection]??[]){
   if(delivery?.formalStatus!=='PASS')continue;
   if(typeof delivery.slice!=='string'||!delivery.slice||typeof delivery.deliveryId!=='string'||!delivery.deliveryId||!hash(delivery.evidenceSha256)){check('formal PASS evidence','INCOMPLETE',{...source,slice:delivery?.slice??null});continue;}
   if(histories.some(h=>h.deliveryId===delivery.deliveryId&&h.slice!==delivery.slice)){check('delivery identity conflicts with slice','MISMATCH',{...source,deliveryId:delivery.deliveryId});continue;}
   const existing=histories.find(h=>h.deliveryId===delivery.deliveryId&&h.evidenceSha256===delivery.evidenceSha256);
   if(existing){if(!existing.collections.includes(collection))existing.collections.push(collection);}
   else histories.push({slice:delivery.slice,deliveryId:delivery.deliveryId,evidenceSha256:delivery.evidenceSha256,observedAfter:row.index,source,collections:[collection]});
   const validationHandoff=current(row.beforeAuthority)?.normalHandoff;
   if(row.stage==='VALIDATE_SLICE'&&!passEntries(row.beforeAuthority).some(d=>evidenceKey(d)===evidenceKey(delivery))){
    const expected={operation:'VALIDATE_SLICE',slice:delivery.slice,deliveryId:delivery.deliveryId};
    const conflicts=Object.entries(expected).filter(([key,value])=>validationHandoff?.[key]!=null&&validationHandoff[key]!==value).map(([key])=>key);
    if(row.slice!=null&&row.slice!==delivery.slice)conflicts.push('snapshot.slice');
    if(row.deliveryId!=null&&row.deliveryId!==delivery.deliveryId)conflicts.push('snapshot.deliveryId');
    const missing=Object.keys(expected).filter(key=>typeof validationHandoff?.[key]!=='string'||!validationHandoff[key]);
    if(typeof row.slice!=='string'||!row.slice)missing.push('snapshot.slice');
    if(conflicts.length)check('formal validation delivery binding','MISMATCH',{...source,deliveryId:delivery.deliveryId,conflicts});
    else if(missing.length)check('formal validation delivery binding','INCOMPLETE',{...source,deliveryId:delivery.deliveryId,missing});
    else if(!validationProofs.some(p=>p.observedAfter===row.index&&evidenceKey(p)===evidenceKey(delivery)))validationProofs.push({slice:delivery.slice,deliveryId:delivery.deliveryId,evidenceSha256:delivery.evidenceSha256,observedAfter:row.index,source});
   }
  }
  if(['EXECUTE_SLICE','APPLY_FINDINGS'].includes(row.stage)){
   if(typeof row.slice!=='string'||!row.slice){check('execution slice identity','INCOMPLETE',source);continue;}
   const handoff=current(row.beforeAuthority)?.normalHandoff;
   const deliveryId=row.deliveryId??(handoff?.slice===row.slice?handoff.deliveryId:null);
   if(typeof deliveryId!=='string'||!deliveryId){check('execution delivery identity','INCOMPLETE',{...source,slice:row.slice});continue;}
   if(handoff?.deliveryId&&handoff.deliveryId!==deliveryId){check('execution delivery binding','MISMATCH',{...source,slice:row.slice});continue;}
   if(executions.some(e=>e.deliveryId===deliveryId&&e.slice!==row.slice))check('execution delivery slice conflict','MISMATCH',{...source,deliveryId});
   const preexistingEvidence=[...new Set([...passEntries(row.beforeAuthority),...histories.filter(h=>h.observedAfter<=row.index)].filter(d=>d.deliveryId===deliveryId).map(evidenceKey))];
   executions.push({...source,slice:row.slice,deliveryId,preexistingEvidence});
   const paths=changed(row.productBefore,row.productAfter);
   if(paths===null)check('product change observation','INCOMPLETE',{...source,slice:row.slice});else mutations.push({...source,slice:row.slice,deliveryId,paths,productBefore:row.productBefore,productAfter:row.productAfter});
  }
 }
 const deliveries=[...new Map(executions.map(e=>[e.deliveryId,{slice:e.slice,deliveryId:e.deliveryId}])).values()],slices=[...new Set(deliveries.map(d=>d.slice))];
 const freshPass=(execution,beforeIndex=Infinity)=>execution?validationProofs.find(p=>p.deliveryId===execution.deliveryId&&p.slice===execution.slice&&p.observedAfter>execution.index&&p.observedAfter<beforeIndex&&!execution.preexistingEvidence.includes(evidenceKey(p))):undefined;
 const lastExecution=(deliveryId,beforeIndex=Infinity)=>executions.filter(e=>e.deliveryId===deliveryId&&e.index<beforeIndex).at(-1);
 const passes=deliveries.filter(d=>freshPass(lastExecution(d.deliveryId))).map(d=>d.deliveryId);
 check('minimum distinct slices',slices.length>=minSlices?'PASS':'INCOMPLETE',{required:minSlices,observed:slices.length});
 check('minimum executed deliveries',deliveries.length>=minSlices?'PASS':'INCOMPLETE',{required:minSlices,observed:deliveries.length});
 check('minimum formally approved deliveries',passes.length>=minSlices?'PASS':'INCOMPLETE',{required:minSlices,observed:passes.length});
 for(let i=0;i<deliveries.length;i++){
  const d=deliveries[i],first=executions.find(e=>e.deliveryId===d.deliveryId),latest=lastExecution(d.deliveryId),pass=freshPass(latest);
  check('slice execution followed by formal PASS',pass?'PASS':latest.preexistingEvidence.length?'MISMATCH':'INCOMPLETE',{...d,executionIndex:latest.index,passIndex:pass?.observedAfter??null});
  if(i){const previous=deliveries[i-1],earlier=freshPass(lastExecution(previous.deliveryId,first.index),first.index);check('previous PASS before next execution',earlier?'PASS':validationProofs.some(h=>h.deliveryId===previous.deliveryId)?'MISMATCH':'INCOMPLETE',{previousSlice:previous.slice,previousDeliveryId:previous.deliveryId,...d,executionIndex:first.index,passIndex:earlier?.observedAfter??null});}
 }
 const closeRows=rows.filter(r=>r.stage==='CLOSE');
 if(!closeRows.length)check('real CLOSE boundary','INCOMPLETE');
 for(const close of closeRows){
  const before=current(close.beforeAuthority),after=current(close.afterAuthority),last=deliveries.at(-1),lastPass=freshPass(lastExecution(last?.deliveryId,close.index),close.index);
  check('COMPLETE before CLOSE',before?.state==='COMPLETE'?'PASS':before?'MISMATCH':'INCOMPLETE',{index:close.index});
  check('final slice PASS before CLOSE',lastPass?'PASS':validationProofs.some(h=>h.deliveryId===last?.deliveryId)?'MISMATCH':'INCOMPLETE',{index:close.index,slice:last?.slice??null,deliveryId:last?.deliveryId??null});
  const closed=after?.state==='SPEC_CLOSED'&&close.afterAuthority?.lifecycle?.exitCode===0&&close.afterAuthority.lifecycle.output?.lifecycle_status==='closed';
  check('official closed state after CLOSE',closed?'PASS':after?'MISMATCH':'INCOMPLETE',{index:close.index});
 }
 const overlaps=[];
 for(let i=1;i<deliveries.length;i++)for(let previous=0;previous<i;previous++){
  const prior=deliveries[previous],later=deliveries[i],laterFirst=executions.find(e=>e.deliveryId===later.deliveryId),pass=freshPass(lastExecution(prior.deliveryId,laterFirst.index),laterFirst.index);if(!pass)continue;
  const priorPaths=new Set(mutations.filter(m=>m.deliveryId===prior.deliveryId&&m.index<=pass.observedAfter).flatMap(m=>m.paths));
  for(const m of mutations.filter(m=>m.deliveryId===later.deliveryId&&m.index>pass.observedAfter))for(const file of m.paths)if(priorPaths.has(file))overlaps.push({path:file,priorSlice:prior.slice,priorDeliveryId:prior.deliveryId,laterSlice:later.slice,laterDeliveryId:later.deliveryId,priorPass:pass,changedAt:m.index,beforeHash:m.productBefore[file]??null,afterHash:m.productAfter[file]??null});
 }
 const status=checks.some(c=>c.status==='MISMATCH')?'MISMATCH':checks.some(c=>c.status==='INCOMPLETE')?'INCOMPLETE':'PASS';
 return {schemaVersion:1,caseId,specPath,minSlices,status,checks,slices,deliveries,formalPassHistory:histories,linkedValidationProofs:validationProofs,sharedFileChange:{status:overlaps.length?'OBSERVED':'NOT_OBSERVED',paths:[...new Set(overlaps.map(o=>o.path))].sort(),observations:overlaps},productAcceptance:'SEPARATE',limitations:['Formal PASS entries remain historical evidence even when a later slice changes shared files.','No shared-file change is required or fabricated; NOT_OBSERVED does not fail product acceptance.','This report audits supplied authority snapshots, not filesystem authenticity or feature behavior.']};
}
