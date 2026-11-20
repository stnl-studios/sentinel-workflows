/** Every planned cell remains visible. Classification strata are never pooled. */
const FIELDS=['inputTokens','cachedInputTokens','newInputTokens','outputTokens','reasoningOutputTokens','totalTokens'];
const PUBLIC_TERMINATIONS=new Set(['TURN_DEADLINE','CASE_DEADLINE','CAMPAIGN_DEADLINE','TURN_LIMIT','NO_PROGRESS','OBSERVED_TOKEN_LIMIT','CAMPAIGN_OBSERVED_TOKEN_LIMIT']);
const PUBLIC_STATUSES=new Set(['PASS','FAIL','BLOCKED','TIMEOUT','INTERRUPTED','PREPARATION_FAILED','HARNESS_FAILED']);
const DIFFICULTY={rename:'pequena',query:'média',import:'transversal'};
const known=value=>Number.isSafeInteger(value)&&value>=0;
function observation(row,field){
 if(field==='newInputTokens'){
  const input=observation(row,'inputTokens'),cached=observation(row,'cachedInputTokens');
  if(input.value===null||cached.value===null||cached.value>input.value)return {value:null,complete:false,gap:cached.value!==null&&input.value!==null?'CACHE_EXCEEDS_INPUT':'INPUT_OR_CACHE_UNKNOWN'};
  return {value:input.value-cached.value,complete:input.complete&&cached.complete,gap:null};
 }
 const metric=row.tokenMetrics?.[field];
 if(metric&&known(metric.value))return {value:metric.value,complete:metric.complete===true&&row.unreportedUsagePossible!==true,gap:null};
 if(field==='totalTokens'&&!metric&&known(row.observedTokens))return {value:row.observedTokens,complete:false,gap:'LEGACY_TOTAL_ONLY'};
 return {value:null,complete:false,gap:'UNREPORTED'};
}
function tokenSummary(rows){return Object.fromEntries(FIELDS.map(field=>{
 const values=rows.map(r=>observation(r,field)),present=values.filter(v=>v.value!==null);
 return [field,{value:present.length?present.reduce((sum,v)=>sum+v.value,0):null,knownRuns:present.length,missingRuns:values.length-present.length,partialRuns:present.filter(v=>!v.complete).length,complete:values.length>0&&values.every(v=>v.complete),gaps:[...new Set(values.map(v=>v.gap).filter(Boolean))]}];
}));}
function latency(rows){const successes=rows.filter(r=>r.status==='PASS'),durations=successes.map(r=>r.durationMs).filter(v=>Number.isFinite(v)&&v>=0).sort((a,b)=>a-b),n=durations.length;return {value:n?{median:n%2?durations[(n-1)/2]:(durations[n/2-1]+durations[n/2])/2,min:durations[0],max:durations.at(-1),n}:null,unknownRuns:successes.length-n};}
function stats(rows){const time=latency(rows);return {started:rows.length,passed:rows.filter(r=>r.status==='PASS').length,failed:rows.filter(r=>r.status==='FAIL').length,blocked:rows.filter(r=>r.status==='BLOCKED').length,invalid:rows.filter(r=>['PREPARATION_FAILED','HARNESS_FAILED'].includes(r.status)).length,otherOutcomes:rows.filter(r=>!['PASS','FAIL','BLOCKED','PREPARATION_FAILED','HARNESS_FAILED'].includes(r.status)).length,successLatencyMs:time.value,latencyUnknownRuns:time.unknownRuns,tokens:tokenSummary(rows)};}
function classification(row){return row.measurement==='official'&&row.harnessValid!==false?'official':'diagnostic';}
export function summarizeCampaign(campaign){
 const original=campaign.results??[],latest=new Map(original.map((r,i)=>[Number.isSafeInteger(r.repetition)?`${r.caseId}-${r.repetition}`:`${r.caseId}-unidentified-${i}`,r]));
 for(const recovery of campaign.recoveries??[])if(latest.has(recovery.cell)&&recovery.result){const updated={...latest.get(recovery.cell),...recovery.result};if(Object.hasOwn(recovery.result,'observedTokens')&&!Object.hasOwn(recovery.result,'tokenMetrics'))updated.tokenMetrics=undefined;latest.set(recovery.cell,updated);}
 const rows=[...latest.values()],cases={};
 for(const id of campaign.caseIds??[...new Set(rows.map(r=>r.caseId))]){
  const rs=rows.filter(r=>r.caseId===id),all=stats(rs),official=stats(rs.filter(r=>classification(r)==='official')),diagnostic=stats(rs.filter(r=>classification(r)==='diagnostic'));
  cases[id]={...all,planned:campaign.repetitions??campaign.profile?.repetitions??null,difficulty:DIFFICULTY[id]??'não informada',officialCount:official.started,diagnosticCount:diagnostic.started,classificationMissingRuns:rs.filter(r=>!['official','diagnostic'].includes(r.measurement)).length,classificationConflicts:rs.filter(r=>r.measurement==='official'&&r.harnessValid===false).length,measurements:{official,diagnostic},successLatencyMs:official.started&&diagnostic.started?null:all.successLatencyMs,latencyScope:official.started&&diagnostic.started?'separate-classifications-only':official.started?'official':'diagnostic',allObservedTokens:all.tokens.totalTokens.value,tokenUnknownRuns:all.tokens.totalTokens.missingRuns};
 }
 return {id:campaign.id,mode:campaign.mode,recoveries:(campaign.recoveries??[]).length,originalStops:original.filter(r=>r.status!=='PASS').length,providerStarted:rows.filter(r=>(r.turns??0)>0).length,terminated:rows.length,completedWorkflow:rows.filter(r=>r.closed===true).length,planned:campaign.planned,started:rows.length,notStarted:Math.max(0,campaign.planned-rows.length),finished:rows.filter(r=>r.status==='PASS'||r.status==='FAIL').length,officialCount:rows.filter(r=>classification(r)==='official').length,diagnosticCount:rows.filter(r=>classification(r)==='diagnostic').length,cases,limitations:['Official and diagnostic latency/token summaries are separate; overall observed totals are labeled all observations.','Rows lacking measurement classification default to diagnostic, never inferred official from campaign mode.','Latency summaries cover successes only; failures stay in denominators.','Token sums cover reported responses, not billing or guaranteed complete consumption. Unknown is null, never fabricated zero.','New input equals reported input minus cached input only when both are known and cache does not exceed input.','Different difficulties are not repetitions of one task; small samples do not establish ranking.']};
}
const display=metric=>metric.value===null?'sem dado':String(metric.value)+(metric.complete?'':' + lacunas');
const label=value=>String(value).replaceAll('|','\\|').replace(/[\r\n]/g,' ');

/** Requested configuration only; actual acknowledgments remain in per-cell usage/cycle proofs. */
export function requestedConfigurationRows(campaign){
 const rows=[];const stages=['INIT','READINESS','PLAN','REVIEW_PLAN','EXECUTE_SLICE','APPLY_FINDINGS','VALIDATE_SLICE','CLOSE'];
 for(const [caseId,entry]of Object.entries(campaign.caseProfiles??{})){
  const p=entry.profile;if(!p?.roles)continue;
  for(const stage of stages){const role=p.stageRoles?.[stage]??'coordinator',config=p.roles[role];if(config)rows.push({caseId,stage,actor:'coordinator',role,...config});}
  for(const [stage,actor,role]of [['APPROVE_PLAN','independent-approver','plan_approver'],['REVIEW_PLAN','native-child','plan_review'],['EXECUTE_SLICE','native-child','execute_check'],['APPLY_FINDINGS','native-child','execute_check'],['VALIDATE_SLICE','native-child','formal_validate'],['CLOSE','native-child-if-needed','formal_validate']])if(p.roles[role])rows.push({caseId,stage,actor,role,...p.roles[role]});
 }
 return rows;
}
export function renderReport(campaign){
 const report=summarizeCampaign(campaign),lines=[`# Bancada Sentinel: ${label(report.id)}`,'',`Modo solicitado: **${label(report.mode)}**. Planejadas: ${report.planned}; iniciadas: ${report.started}; não iniciadas: ${report.notStarted}. Observações oficiais: ${report.officialCount}; diagnósticas: ${report.diagnosticCount}.`,'','| Tarefa / dificuldade | Oficiais | Diagnósticas | Não iniciadas |','|---|---:|---:|---:|'];
 for(const [id,c]of Object.entries(report.cases))lines.push(`| ${label(id)} / ${c.difficulty} | ${c.officialCount} | ${c.diagnosticCount} | ${c.planned===null?'sem dado':Math.max(0,c.planned-c.started)} |`);
 lines.push('','| Tarefa | Classificação | PASS | FAIL | Bloqueadas | Inválidas/preparo | Outros | Mediana dos sucessos (ms) |','|---|---|---:|---:|---:|---:|---:|---:|');
 for(const [id,c]of Object.entries(report.cases))for(const [kind,s]of Object.entries(c.measurements))if(s.started)lines.push(`| ${label(id)} | ${kind} | ${s.passed} | ${s.failed} | ${s.blocked} | ${s.invalid} | ${s.otherOutcomes} | ${s.successLatencyMs?.median??'sem dado'}${s.latencyUnknownRuns?' + lacunas':''} |`);
 lines.push('','### Tokens reportados por classificação','', '| Tarefa | Classificação | Input | Cache (subconjunto) | Input novo | Output | Reasoning (subconjunto) | Total |','|---|---|---:|---:|---:|---:|---:|---:|');
 for(const [id,c]of Object.entries(report.cases))for(const [kind,s]of Object.entries(c.measurements))if(s.started)lines.push(`| ${label(id)} | ${kind} | ${FIELDS.map(f=>display(s.tokens[f])).join(' | ')} |`);
 const missing=Object.values(report.cases).reduce((sum,c)=>sum+c.classificationMissingRuns,0),conflicts=Object.values(report.cases).reduce((sum,c)=>sum+c.classificationConflicts,0);
 lines.push('',`Retomadas: ${report.recoveries}; paradas originais preservadas: ${report.originalStops}. Usa-se o último resultado cumulativo de cada célula, sem somar snapshots.`,missing?`${missing} observação(ões) sem classificação explícita ficam diagnósticas.`:'',conflicts?`${conflicts} declaração(ões) official com harness inválido foram separadas como diagnósticas.`:'','Não há seleção da melhor repetição nem média misturando official e diagnostic. Falhas oficiais válidas continuam observações oficiais; sucessos diagnósticos não viram oficiais. Latência cobre sucessos; tokens incluem também tentativas malsucedidas.',`Sentinel: ${label(campaign.profile?.sentinelRevision??'desconhecido')}; CLI: ${label(campaign.profile?.cliVersion??'desconhecido')}.`,'','Cache é subconjunto de input, reasoning é subconjunto de output: não somar novamente. Input novo é input reportado menos cache, não estimativa de cobrança. “+ lacunas” indica observação parcial ou completude não comprovada; uso em voo pode faltar. Tarefas de dificuldades diferentes não são agrupadas. Amostra pequena não sustenta ranking estatístico.','');
 if(campaign.profile?.limits?.tokenPolicy==='observe-only')lines.push('','Tokens: somente telemetria, sem teto de tokens por tarefa ou campanha. Prazos e guardas de progresso continuam ativos.');
 const config=requestedConfigurationRows(campaign);if(config.length){lines.push('','### Configuração solicitada por tarefa, etapa e ator','','Esta tabela não afirma execução. ACKs e uso por ciclo comprovam a configuração efetivamente observada.','', '| Tarefa | Etapa | Ator | Papel | Modelo | Esforço |','|---|---|---|---|---|---|');for(const row of config)lines.push(`| ${[row.caseId,row.stage,row.actor,row.role,row.model,row.effort].map(label).join(' | ')} |`);}
 const affected=(campaign.results??[]).filter(row=>Array.isArray(row.failure?.childAvailabilityObservations)&&row.failure.childAvailabilityObservations.length);
 if(affected.length){
  lines.push('','### Capacidade do provedor nas tentativas originais','', 'Somente tentativas originais da campanha; não inclui sessões de retomada. Os eventos podem ser observados até o encerramento do App Server; não atestam ocorrência antes do corte. A observação é separada do motivo da parada: não comprova causa exclusiva nem autoriza retomada.','', '| Caso | Término original | Turnos delegados com aviso |','|---|---|---:|');
  for(const row of affected){
   const id=typeof row.caseId==='string'&&Object.hasOwn(DIFFICULTY,row.caseId)&&Number.isSafeInteger(row.repetition)&&row.repetition>0?row.caseId+'-'+row.repetition:'não identificado';
   const termination=[row.stopReason,row.failure.code].find(code=>PUBLIC_TERMINATIONS.has(code))??(PUBLIC_STATUSES.has(row.status)?row.status:'não informado');
   lines.push(`| ${id} | ${termination} | ${row.failure.childAvailabilityObservations.length} |`);
  }
 }
 return lines.join('\n');
}
