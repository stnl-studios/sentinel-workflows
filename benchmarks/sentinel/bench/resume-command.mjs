import{resolveCaseProfile}from'./case-profile.mjs';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {confined,safeId,digest,sha256,treeHashes,atomicJson,writeOnce,acquireLock,Ledger,validateProfile} from './core.mjs';
import {executeCase,createCampaignBudget,campaignTokenLimit,implementationHashes,trajectoryProductHashes} from './campaign.mjs';
import {inspectCaseRecovery} from './resume.mjs';
import {CASES} from './scenarios.mjs';
const read=f=>JSON.parse(fs.readFileSync(f,'utf8'));
const same=(a,b)=>digest(a)===digest(b);
const block=reason=>({outcome:'BLOCKED',reason,executed:false});
function takeLock(directory){const file=confined(directory,'.lock');let archived=null;if(fs.existsSync(file)){const stat=fs.lstatSync(file),owner=read(file);if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.id!=='string')throw Error('LOCK_OWNER_INVALID');try{process.kill(owner.pid,0);throw Error('CAMPAIGN_LOCK_ACTIVE')}catch(e){if(e.code!=='ESRCH')throw Error(e.code==='EPERM'?'LOCK_OWNER_LIVENESS_UNKNOWN':e.message)}const check=fs.lstatSync(file);if(check.dev!==stat.dev||check.ino!==stat.ino||!same(read(file),owner))throw Error('LOCK_IDENTITY_CHANGED');archived=confined(directory,`.lock-stale-${randomUUID()}.json`);fs.renameSync(file,archived);const saved=fs.lstatSync(archived);if(saved.dev!==stat.dev||saved.ino!==stat.ino)throw Error('LOCK_ARCHIVE_IDENTITY_CHANGED')}
 return{release:acquireLock(directory),archived};}
// Mutable summary counters are structural observations only, never recovery authority.
function restoreObservedCampaign(budget,summary,campaign){
 const {caseIds,repetitions,planned,profile}=campaign;
 const known=n=>Number.isSafeInteger(n)&&n>=0,record=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
 const note=(code,cell)=>budget.noteRestore({code,...(cell?{cell}:{})});
 budget.noteRestore();
 if(!Array.isArray(caseIds)||!caseIds.length||new Set(caseIds).size!==caseIds.length||caseIds.some(id=>!CASES.some(c=>c.id===id))||
    !Number.isSafeInteger(repetitions)||repetitions<1||caseIds.length*repetitions!==planned){note('ORIGINAL_PLAN_UNAVAILABLE');return;}
 const cellOf=r=>record(r)&&caseIds.includes(r.caseId)&&Number.isSafeInteger(r.repetition)&&r.repetition>0&&r.repetition<=repetitions?`${r.caseId}-${r.repetition}`:null;
 const observeResult=(id,r)=>{
  const metric=r.tokenMetrics?.totalTokens;
  const value=metric===undefined?r.observedTokens:metric?.value;
  budget.observe(id,{observedTotals:{totalTokens:{value:known(value)?value:null,complete:metric?.complete===true&&r.unreportedUsagePossible!==true}}});
 };
 const rows=new Map(),duplicates=new Set();
 if(!Array.isArray(summary.results))note('ORIGINAL_RESULTS_UNAVAILABLE');
 for(const r of Array.isArray(summary.results)?summary.results:[]){
  const id=cellOf(r);if(!id){note('ORIGINAL_ROW_UNSCOPED');continue;}
  if(rows.has(id)){duplicates.add(id);continue;}rows.set(id,r);
 }
 const savedCells=record(summary.tokenBudget?.cells)?summary.tokenBudget.cells:{};
 for(const [id,r] of rows){
  budget.register(id);
  if(duplicates.has(id)){note('DUPLICATE_ORIGINAL_ROW',id);continue;}
  if(Object.hasOwn(savedCells,id)){
   if(!budget.restoreObservation(id,savedCells[id]))note('INVALID_SAVED_CELL',id);
  }else observeResult(id,r);
 }
 for(const row of Array.isArray(summary.recoveries)?summary.recoveries:[]){
  if(!record(row)){note('RECOVERY_ROW_UNSCOPED');continue;}
  const {cell,result:r}=row;
  if(!rows.has(cell)){note('RECOVERY_ROW_UNSCOPED');continue;}
  if(duplicates.has(cell))continue;
  if(cellOf(r)!==cell||r.usageScope!=='reported-responses-only'||r.effectiveProfileDigest!==digest(resolveCaseProfile(profile,r.caseId))){
   budget.observe(cell,null);note('RECOVERY_SCOPE_UNPROVEN',cell);continue;
  }
  observeResult(cell,r);
 }
}
/** Conservative resume admission; uncertain authoring/effects never replay. */
export async function resumeCampaignCase({base,id,cell,requireParallel=false,execute=executeCase,inspect=inspectCaseRecovery}={}){
 let lock;try{safeId(id);safeId(cell);base=fs.realpathSync.native(base);const directory=confined(base,`evidence/campaigns/${id}`),campaignFile=confined(directory,'campaign.json');
 if(requireParallel){const campaign=read(campaignFile);if(campaign.profile?.concurrency!==3||campaign.identity?.concurrency!==3)return block('HISTORICAL_NON_C3_CAMPAIGN_READ_ONLY');}
 lock=takeLock(directory);const evidence=confined(directory,cell),campaign=read(campaignFile),summaryFile=confined(directory,'summary.json'),summary=read(summaryFile),manifest=read(confined(evidence,'manifest.json')),checkpointFile=confined(evidence,'checkpoint.json'),state=read(checkpointFile);
 if(requireParallel&&(campaign.profile?.concurrency!==3||campaign.identity?.concurrency!==3))return block('HISTORICAL_NON_C3_CAMPAIGN_READ_ONLY');
 if(campaign.id!==id||manifest.campaignId!==id||cell!==`${manifest.caseId}-${manifest.repetition}`||summary.id!==id)throw Error('CAMPAIGN_IDENTITY_MISMATCH');
 const work=confined(base,`work/campaigns/${id}/${cell}`);for(const [key,expected]of Object.entries({workspace:path.join(work,'workspace'),home:path.join(work,'home'),codexHome:path.join(work,'home/.codex'),tmpDir:path.join(work,'temp'),evidence})){if(confined(base,manifest[key])!==confined(base,expected))throw Error('MANIFEST_PATH_MISMATCH_'+key)}
 validateProfile(campaign.profile);validateProfile(manifest.profile);const expectedProfile=resolveCaseProfile(campaign.profile,manifest.caseId);if(digest(campaign.profile)!==campaign.identity.profile||!same(manifest.profile,expectedProfile)||digest(manifest.profile)!==manifest.profileDigest)throw Error('PROFILE_DRIFT');if(manifest.requestedProfile&&(!same(manifest.requestedProfile,campaign.profile)||manifest.requestedProfileDigest!==campaign.identity.profile))throw Error('REQUESTED_PROFILE_DRIFT');if(campaign.caseProfiles&&(!same(campaign.caseProfiles[manifest.caseId]?.profile,expectedProfile)||campaign.caseProfiles[manifest.caseId]?.profileDigest!==manifest.profileDigest))throw Error('CASE_PROFILE_DRIFT');
 const sourceDigest=digest(treeHashes(confined(base,manifest.sourceRoot??'source')));if(sourceDigest!==campaign.identity.source||sourceDigest!==manifest.sourceProof?.sha256TreeDigest||manifest.sourceProof?.revision!==manifest.profile.sentinelRevision||manifest.sourceProof?.proof!=='git-tree-and-blob-verification')throw Error('SOURCE_DRIFT');
 const contract=manifest.runnerContract;
 if(!contract)throw Error('RUNNER_CONTRACT_DESCRIPTOR_MISSING');
 const expectedContract=confined(base,path.join(manifest.sourceRoot??'source','agents/codex/.codex/agents/stnl_validation_runner.toml'));
 if(typeof contract.path!=='string'||contract.path!==expectedContract||fs.realpathSync.native(confined(base,contract.path))!==expectedContract)throw Error('RUNNER_CONTRACT_PATH_MISMATCH');
 if(contract.sourceRevision!==manifest.profile.sentinelRevision)throw Error('RUNNER_CONTRACT_REVISION_MISMATCH');
 if(contract.selection!=='immutable-candidate-distribution-not-personal-installation')throw Error('RUNNER_CONTRACT_SELECTION_MISMATCH');
 if(!/^[a-f0-9]{64}$/.test(contract.sha256??'')||sha256(fs.readFileSync(expectedContract))!==contract.sha256)throw Error('RUNNER_CONTRACT_HASH_MISMATCH');
 if(digest(treeHashes(confined(base,'fixtures/todo')))!==campaign.identity.fixture||manifest.fixtureDigest!==campaign.identity.fixture)throw Error('FIXTURE_DRIFT');
 if(!/^[a-f0-9]{64}$/.test(campaign.identity.scenarioOracle??''))throw Error('SCENARIO_ORACLE_IDENTITY_MISSING');
 const expectedEngineRoot=confined(directory,'engine-snapshot');
 if(!manifest.engineRoot||confined(base,manifest.engineRoot)!==expectedEngineRoot)throw Error('ENGINE_SNAPSHOT_PATH_MISMATCH');
 if(digest(implementationHashes(expectedEngineRoot))!==campaign.identity.engine)throw Error('ENGINE_SNAPSHOT_DRIFT');
 const snapshotCases=(await import(pathToFileURL(confined(expectedEngineRoot,'scenarios.mjs')).href)).CASES;
 const selectedScenario=snapshotCases.find(item=>item.id===manifest.caseId);
 if(!selectedScenario||!Object.hasOwn(manifest,'trajectory')||!selectedScenario.trajectory||!same(manifest.trajectory,selectedScenario.trajectory))throw Error('TRAJECTORY_CONTRACT_MISMATCH');
 const scenarioOracleNow=digest({cases:snapshotCases,oracles:treeHashes(confined(expectedEngineRoot,'cases'))});if(scenarioOracleNow!==campaign.identity.scenarioOracle)throw Error('SCENARIO_ORACLE_DRIFT');
 const installed={skills:treeHashes(confined(manifest.codexHome,'skills')),agents:treeHashes(confined(manifest.codexHome,'agents'))};
 if(!manifest.installed||digest(manifest.installed)!==manifest.installedDigest||!same(installed.skills,manifest.installed.skills))throw Error('INSTALLED_DRIFT');
 const runnerName='stnl_validation_runner.toml',actualAgents={...installed.agents},originalAgents={...manifest.installed.agents};
 if(Object.hasOwn(actualAgents,runnerName)||Object.hasOwn(originalAgents,runnerName)){
  if(!Object.hasOwn(actualAgents,runnerName)||!Object.hasOwn(originalAgents,runnerName))throw Error('INSTALLED_RUNNER_FILESET_DRIFT');
  const official=fs.readFileSync(confined(base,path.join(manifest.sourceRoot??'source','agents/codex/.codex/agents',runnerName)),'utf8');
  if((official.match(/^model = .*$/gm)??[]).length!==1||(official.match(/^model_reasoning_effort = .*$/gm)??[]).length!==1)throw Error('OFFICIAL_RUNNER_CONFIG_AMBIGUOUS');
  const actual=fs.readFileSync(confined(manifest.codexHome,path.join('agents',runnerName)));
  const permitted=['execute_check','formal_validate'].map(role=>{const config=manifest.profile.roles[role];return Buffer.from(official.replace(/^model = .*$/m,()=>`model = ${JSON.stringify(config.model)}`).replace(/^model_reasoning_effort = .*$/m,()=>`model_reasoning_effort = ${JSON.stringify(config.effort)}`))});
  if(!permitted.some(bytes=>bytes.equals(actual)))throw Error('INSTALLED_RUNNER_UNAUTHORIZED_BYTES');
  delete actualAgents[runnerName];delete originalAgents[runnerName];
 }
 if(!same(actualAgents,originalAgents))throw Error('INSTALLED_DRIFT');
 const cli=spawnSync(manifest.profile.cli,['--version'],{cwd:manifest.workspace,env:{...process.env,CODEX_HOME:manifest.codexHome,TMPDIR:manifest.tmpDir},encoding:'utf8',timeout:10000,maxBuffer:8192});if(cli.error||cli.status!==0||cli.stdout.trim()!==manifest.cliVersion||manifest.cliVersion!==`codex-cli ${manifest.profile.cliVersion}`)throw Error('CLI_DRIFT');
 if(!Number.isFinite(campaign.deadline)||!Number.isFinite(state.deadline)||state.campaignDeadline!==campaign.deadline||state.deadline>campaign.deadline)throw Error('ORIGINAL_DEADLINE_UNPROVEN');if(Date.now()>=Math.min(state.deadline,campaign.deadline))return block('ORIGINAL_DEADLINE_EXPIRED');
 if(state.pendingEffect)return block('PENDING_EFFECT_UNCERTAIN');if(state.plan?.phase==='AUTHOR'||state.plan?.phase==='REJECTED')return block('AUTHOR_REQUIRES_ADDITIONAL_PROOF');
 const engineNow=digest(implementationHashes(confined(base,'bench'))),engineDrift=engineNow!==campaign.identity.engine;const ledger=new Ledger(confined(evidence,'ledger.jsonl'));const originalStateDigest=digest(state),report=await inspect({manifest,checkpoint:structuredClone(state),identityMatches:true});if(digest(read(checkpointFile))!==originalStateDigest)throw Error('CHECKPOINT_CHANGED_DURING_INSPECTION');const decision=report.decision;
 if(!['SETTLE','NO_PENDING'].includes(decision?.outcome))return {...block(decision?.reason??'RECOVERY_NOT_ADMITTED'),inspection:report};
 if(!['EXECUTE_SLICE','VALIDATE_SLICE','APPLY_FINDINGS','CLOSE','CLOSED'].includes(decision.nextStage)&&!(decision.nextStage==='PLAN'&&state.plan?.phase==='APPROVED'))return block('NEXT_STAGE_REQUIRES_ADDITIONAL_PROOF');
 // Seed non-authoritative telemetry before any settlement write.
 let budget;
 if(manifest.profile.limits.tokenPolicy==='observe-only'){
  if(summary.recoveries!=null&&!Array.isArray(summary.recoveries))return block('RECOVERY_HISTORY_CONTAINER_INVALID');
  budget=createCampaignBudget(null);restoreObservedCampaign(budget,summary,campaign);
 }
 if(decision.outcome==='SETTLE'){const p=decision.proof,a=state.pending;if(!a||!p||digest(p)!==decision.proofDigest||p.attempt!==a.index||p.threadId!==a.threadId||p.turnId!==a.turnId||p.stage!==a.stage||p.beforeFingerprint!==a.before||p.authorityDigest!==digest(report.authority)||p.providerTurnDigest!==digest(report.providerTurn)||p.beforeAuthorityDigest!==digest(a.authorityBefore)||p.deadline!==Math.min(state.deadline,campaign.deadline)||p.nextStage!==decision.nextStage||report.providerTurn?.status!=='completed')throw Error('SETTLEMENT_PROOF_MISMATCH');
 const receipt={kind:'resume-settlement',proof:p,proofDigest:decision.proofDigest,inspection:report,originalCheckpointDigest:originalStateDigest};const receiptFile=confined(evidence,`settlement-${a.index}-${randomUUID()}.json`);writeOnce(receiptFile,receipt);ledger.append('resume-settlement',{receipt:receiptFile,proofDigest:decision.proofDigest});state.settledAttempts??=[];state.settledAttempts.push({index:a.index,threadId:a.threadId,turnId:a.turnId,proofDigest:decision.proofDigest,receipt:receiptFile});const persistedBefore=a.trajectoryBefore;
 const snapshot={index:a.index,stage:a.stage,slice:persistedBefore?.slice??a.authorityBefore?.current?.output?.normalHandoff?.slice??null,threadId:a.threadId,turnId:a.turnId,beforeAuthority:a.authorityBefore,afterAuthority:report.authority,productBefore:persistedBefore?.productBefore??null,productAfter:trajectoryProductHashes(manifest.workspace),...(!persistedBefore?.productBefore?{trajectoryRecovery:{status:'INCOMPLETE',reason:'PRE_DISPATCH_PRODUCT_HASHES_NOT_PERSISTED'}}:{})};
 const snapshotFile=confined(evidence,`turn-${a.index}-authority-after.json`);
 if(fs.existsSync(snapshotFile)){if(!same(read(snapshotFile),snapshot))throw Error('RECOVERY_TRAJECTORY_SNAPSHOT_MISMATCH');}else writeOnce(snapshotFile,snapshot);
 state.trajectorySnapshots??=[];const existingSnapshot=state.trajectorySnapshots.find(row=>row.index===a.index);
 if(existingSnapshot&&!same(existingSnapshot,snapshot))throw Error('RECOVERY_TRAJECTORY_STATE_MISMATCH');
 if(!existingSnapshot){state.trajectorySnapshots.push(snapshot);ledger.append('authority-after',snapshot);}
 state.completedTurns=Math.max(state.completedTurns??0,a.index);state.pending=null;atomicJson(checkpointFile,state);
 }else if(state.pending)throw Error('NO_PENDING_WITH_PENDING_ATTEMPT');
 const authorization={kind:'verified-resume',decision,originalDeadline:state.deadline,campaignDeadline:campaign.deadline,engineDrift,originalEngine:campaign.identity.engine,currentEngine:engineNow,measurement:'diagnostic'};ledger.append('resume-admission',authorization);
 if(!budget){
  budget=createCampaignBudget(campaignTokenLimit(manifest.profile.limits,campaign.planned));
  for(const r of summary.results??[]){budget.register(`${r.caseId}-${r.repetition}`);if(Number.isFinite(r.observedTokens))budget.observe(`${r.caseId}-${r.repetition}`,{observedTotals:{totalTokens:{value:r.observedTokens,complete:false}}})}
  for(const [key,value]of Object.entries(summary.tokenBudget?.cells??{})){if(Number.isSafeInteger(value.lastKnown))budget.observe(key,{observedTotals:{totalTokens:{value:Math.max(value.lastKnown,budget.snapshot().cells[key]?.lastKnown??0),complete:value.complete===true}}})}
 }
 if(!budget.admit())return block('CAMPAIGN_OBSERVED_TOKEN_LIMIT');
 const requirements=fs.readFileSync(confined(manifest.workspace,'OS.md'),'utf8');const result=await execute({manifest,campaignDeadline:campaign.deadline,requirements,campaignBudget:budget,resumeState:state,resumeAuthorization:authorization});
 const latest=read(summaryFile);latest.recoveries??=[];latest.recoveries.push({cell,at:new Date().toISOString(),engineDrift,originalEngine:campaign.identity.engine,currentEngine:engineNow,result:{...result,usage:undefined,measurement:'diagnostic'}});atomicJson(summaryFile,latest);return{outcome:'RESUMED',executed:true,result,engineDrift,measurement:'diagnostic',staleLockArchive:lock.archived};
 }catch(e){return block(String(e.message));}finally{lock?.release();}
}
