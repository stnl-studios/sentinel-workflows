import fs from 'node:fs';
import path from 'node:path';
import {confined,safeId,validateProfile,digest,sha256,treeHashes,writeOnce} from './core.mjs';
import {buildComparisonReport} from './comparison.mjs';
import {qualificationDigest} from './qualification.mjs';
const equal=(a,b)=>qualificationDigest(a??null)===qualificationDigest(b??null);
const CORE=['caseId','repetition','status','closed','oracle','measurement','durationMs','tokenMetrics','unreportedUsagePossible'];
/** Read existing observations only. Never executes models, or rewrites campaign outcomes. */
export function compareFromInput({base,id,inputFile}={}){
 base=fs.realpathSync.native(base);safeId(id);
 const refs=[],gaps=[],read=(file,{optional=false}={})=>{
  file=confined(base,file);if(!fs.existsSync(file)){if(optional)return null;throw Error('COMPARISON_FILE_MISSING:'+path.relative(base,file));}
  const stat=fs.lstatSync(file);if(!stat.isFile()||stat.size>128*1024*1024)throw Error('COMPARISON_INVALID_FILE');
  const bytes=fs.readFileSync(file),after=fs.lstatSync(file);if(stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs)throw Error('COMPARISON_FILE_CHANGED');
  refs.push({ref:path.relative(base,file),sha256:sha256(bytes),bytes:bytes.length});return JSON.parse(bytes);
 };
 const input=read(inputFile);
 if(!input||Object.keys(input).sort().join(',')!=='baselineId,candidateId,contract')throw Error('COMPARISON_INPUT_SHAPE');
 safeId(input.baselineId);safeId(input.candidateId);
 const destination=confined(base,'evidence/comparisons/'+id);
 if(fs.existsSync(destination))throw Error('COMPARISON_ID_EXISTS');
 function load(campaignId){
  const root=confined(base,'evidence/campaigns/'+campaignId),s=read(path.join(root,'summary.json'));
  if(s.id!==campaignId)throw Error('COMPARISON_CAMPAIGN_ID_BINDING');
  validateProfile(s.profile);
  if(digest(s.profile)!==s.identity?.profile||s.identity?.sentinelRevision!==s.profile.sentinelRevision||s.identity?.cliVersion!==s.profile.cliVersion)throw Error('COMPARISON_PROFILE_IDENTITY_BINDING:'+campaignId);
  if((s.profile.contextPolicy??'stage')!==s.identity.contextPolicy)throw Error('COMPARISON_POLICY_BINDING:'+campaignId);
  const snapshot=confined(base,path.join(root,'engine-snapshot'));
  if(fs.existsSync(snapshot)){
   const hashes=treeHashes(snapshot,{exclude:['profiles','cases','test','README.md']});
   if(digest(hashes)!==s.identity.engine)throw Error('COMPARISON_FROZEN_ENGINE_MISMATCH:'+campaignId);
   refs.push({kind:'frozen-engine-tree',ref:path.relative(base,snapshot),sha256:digest(hashes),files:hashes});
  }else gaps.push('FROZEN_ENGINE_MISSING:'+campaignId);
  const campaign=structuredClone(s);campaign.results=[];campaign.cycleReports=[];
  if(s.recoveries?.length){gaps.push('RECOVERY_OVERLAYS_NOT_VERIFIED:'+campaignId);campaign.unappliedRecoveries=campaign.recoveries;delete campaign.recoveries;}
  for(const row of s.results??[]){
   safeId(row.caseId);if(!Number.isSafeInteger(row.repetition)||row.repetition<1)throw Error('COMPARISON_RESULT_CELL_INVALID');
   const cell=confined(base,path.join(root,row.caseId+'-'+row.repetition)),result=read(path.join(cell,'result.json'),{optional:true});
   if(!result){gaps.push('ORIGINAL_RESULT_MISSING:'+campaignId+':'+row.caseId+'/'+row.repetition);campaign.results.push({...row,harnessValid:null,usage:undefined,tokenMetrics:undefined});continue;}
   for(const key of CORE)if(!equal(row[key],result[key]))throw Error('COMPARISON_SUMMARY_RESULT_BINDING:'+campaignId+':'+row.caseId+':'+key);
   const observation={...row,...result,usage:result.usage};
   const admission=read(path.join(cell,'measurement-admission.json'),{optional:true});
   if(admission){
    if(!equal(admission.identityAtStart,s.identity)||!equal(admission.identityAtEnd,s.identity)||admission.harnessValid!==row.harnessValid||admission.measurement!==row.measurement)throw Error('COMPARISON_MEASUREMENT_BINDING:'+campaignId);
    observation.harnessValid=admission.harnessValid;
   }else{gaps.push('MEASUREMENT_ADMISSION_MISSING:'+campaignId+':'+row.caseId+'/'+row.repetition);observation.harnessValid=null;}
   campaign.results.push(observation);
   const cycles=read(path.join(cell,'cycle-report.json'),{optional:true});
   if(cycles)campaign.cycleReports.push({caseId:row.caseId,repetition:row.repetition,report:cycles});
   else gaps.push('CYCLE_REPORT_MISSING:'+campaignId+':'+row.caseId+'/'+row.repetition);
  }
  return campaign;
 }
 const baseline=load(input.baselineId),candidate=load(input.candidateId);
 const report=buildComparisonReport({contract:input.contract,baseline,candidate});
 report.gaps=[...new Set([...(report.gaps??[]),...gaps])];
 if(report.status==='COMPARABLE'&&report.gaps.length)report.status='INCOMPLETE';
 report.provenance={baselineId:input.baselineId,candidateId:input.candidateId,contract:input.contract,inputs:refs};
 report.classification='Read-only descriptive comparison; diagnostic/official classifications unchanged.';
 report.observations={baseline:{id:baseline.id,mode:baseline.mode,results:baseline.results,notStarted:baseline.notStarted??null,stopReason:baseline.stopReason??null},candidate:{id:candidate.id,mode:candidate.mode,results:candidate.results,notStarted:candidate.notStarted??null,stopReason:candidate.stopReason??null}};
 report.unappliedRecoveries={baseline:baseline.unappliedRecoveries??[],candidate:candidate.unappliedRecoveries??[]};
 report.limitations.push('I/O validation binds original result and summary core fields, profile digest, frozen engine when present, and measurement receipt. It does not authenticate arbitrary locally forged evidence.','Unverified recovery overlays remain visible but are not applied. Missing upstream proofs cannot produce COMPARABLE.');
 fs.mkdirSync(path.dirname(destination),{recursive:true});
 fs.mkdirSync(destination,{recursive:false});
 writeOnce(path.join(destination,'report.json'),report);
 const md=['# Benchmark comparison','',`Status: ${report.status}`,`Baseline: ${input.baselineId}; candidate: ${input.candidateId}`,'',report.classification,'','## Reasons',...(report.reasons??[]).map(x=>'- '+x),'','## Evidence gaps',...report.gaps.map(x=>'- '+x),'','## Paired observations',...report.pairs.map(p=>`- ${p.caseId}/${p.repetition}: ${p.baseline?.status??'missing'} → ${p.candidate?.status??'missing'}; total token delta ${p.metrics.tokens.totalTokens.delta??'unknown'} (complete=${p.metrics.tokens.totalTokens.complete}).`),'','## Limits',...report.limitations.map(x=>'- '+x),''].join('\n');
 fs.writeFileSync(path.join(destination,'report.md'),md,{flag:'wx',mode:0o600});
 return{status:report.status,reportFile:path.join(destination,'report.json'),markdownFile:path.join(destination,'report.md'),report};
}
