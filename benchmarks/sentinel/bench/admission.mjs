import fs from 'node:fs';
import path from 'node:path';
import {confined,safeId,validateProfile,writeOnce} from './core.mjs';
import {CASES} from './scenarios.mjs';
import {campaignIdentity} from './campaign.mjs';
import {materializeSourceSnapshot} from './source-snapshot.mjs';
import {targetPreflight} from './target-preflight.mjs';
import {admitOfficial,campaignConcurrency} from './qualification.mjs';
import {harnessIdentityFromCampaign,verifyQualificationEvidence,createQualification} from './qualification-store.mjs';

export function effectiveRunProfile(profile,{caseIds,repetitions}={}){
 const result={...profile,suiteCases:[...(caseIds??profile.suiteCases??CASES.map(c=>c.id))],repetitions:repetitions??profile.repetitions};
 validateProfile(result);
 if(!result.suiteCases.length||new Set(result.suiteCases).size!==result.suiteCases.length||result.suiteCases.some(id=>!CASES.some(c=>c.id===id)))throw Error('invalid suite cases');
 return result;
}
export function requirePublicCampaignProfile(profile){
 if(profile?.concurrency!==3)throw Error('PUBLIC_BENCHMARK_REQUIRES_THREE_SLOTS: profile.concurrency must be 3');
 if(profile.repetitions!==2||JSON.stringify(profile.suiteCases)!==JSON.stringify(['rename','query','import']))throw Error('PUBLIC_BENCHMARK_REQUIRES_FULL_MATRIX: rename,query,import in order with two repetitions');
 return profile;
}
function evidenceJson(base,file){
 const absolute=confined(base,file),evidence=path.join(fs.realpathSync.native(base),'evidence');
 if(!absolute.startsWith(evidence+path.sep))throw Error('qualification input must be below evidence');
 const stat=fs.lstatSync(absolute);if(!stat.isFile()||stat.size>16*1024*1024)throw Error('qualification input must be a bounded regular JSON file');
 return JSON.parse(fs.readFileSync(absolute,'utf8'));
}
/** Admission starts no model turns. The campaign independently rechecks this receipt. */
export async function prepareOfficialAdmission({base,id,profile,qualificationFile,repository=path.resolve(base,'../..')}){
 safeId(id);validateProfile(profile);
 const evidenceDir=confined(base,`evidence/admissions/${id}`);
 if(fs.existsSync(evidenceDir))throw Error('admission ID already exists');
 fs.mkdirSync(path.dirname(evidenceDir),{recursive:true});fs.mkdirSync(evidenceDir);
 const receiptFile=path.join(evidenceDir,'admission.json');
 try{
  if(!qualificationFile)throw Error('QUALIFICATION_REQUIRED');
  const qualification=evidenceJson(base,qualificationFile);
  const initial=await verifyQualificationEvidence({base,qualification});
  if(initial.status!=='PASS')throw Error('QUALIFICATION_EVIDENCE_BLOCKED: '+initial.reasons.join('; '));
  if(qualification.status!=='QUALIFIED')throw Error('QUALIFICATION_NOT_READY');
  if(profile.concurrency!==campaignConcurrency(qualification.identity))throw Error('CONCURRENCY_REQUALIFICATION_REQUIRED');
  const referenceDecision=admitOfficial({qualification,identity:qualification.identity,harnessIdentity:qualification.harnessIdentity});
  if(!referenceDecision.allowed)throw Error('QUALIFICATION_NOT_READY: '+referenceDecision.reasons.join('; '));
  const source=await materializeSourceSnapshot({base,repository,revision:profile.sentinelRevision});
  const identity=campaignIdentity(profile,source.sourceRoot),harnessIdentity=harnessIdentityFromCampaign(identity);
  const target=await targetPreflight({base,evidenceDir:path.join(evidenceDir,'target-preflight'),profile,identity,harnessIdentity,sourceRoot:source.sourceRoot,repository});
  if(target.scope!=='REAL'||target.modelTurnsStarted!==0)throw Error('REAL_ZERO_MODEL_PREFLIGHT_REQUIRED');
  const targetProof=target.targetProof,evidenceVerification=await verifyQualificationEvidence({base,qualification,targetProof});
  if(evidenceVerification.status!=='PASS')throw Error('TARGET_EVIDENCE_BLOCKED: '+evidenceVerification.reasons.join('; '));
  const decision=admitOfficial({qualification,identity,harnessIdentity,targetProof});
  if(!decision.allowed)throw Error('OFFICIAL_ADMISSION_BLOCKED: '+decision.reasons.join('; '));
  const receipt={schemaVersion:1,mode:'official',requestedMode:'official',qualification,targetProof,harnessIdentity,identity,decision,evidenceVerification,receiptFile,evidenceDir,classification:'Future harness-valid observations only; diagnostics are never promoted.'};
  writeOnce(receiptFile,receipt);return receipt;
 }catch(error){
  writeOnce(receiptFile,{schemaVersion:1,mode:'diagnostic',requestedMode:'official',allowed:false,error:String(error.message),modelCampaignStarted:false});
  throw Object.assign(Error(String(error.message)),{code:'OFFICIAL_ADMISSION_BLOCKED',receiptFile});
 }
}
export async function qualifyFromInput({base,id,inputFile}){
 safeId(id);const input=evidenceJson(base,inputFile);
 if(!input||Object.keys(input).sort().join(',')!=='campaigns,checks,harnessIdentity,identity')throw Error('qualification input requires exactly identity, harnessIdentity, campaigns and checks');
 const evidenceDir=confined(base,`evidence/qualifications/${id}`);
 if(fs.existsSync(evidenceDir))throw Error('qualification ID already exists');
 const result=await createQualification({base,...input,evidenceDir});
 if(result.status!=='QUALIFIED'){fs.mkdirSync(evidenceDir,{recursive:true});writeOnce(path.join(evidenceDir,'refusal.json'),{status:'BLOCKED',reasons:result.reasons,evidenceVerification:result.evidenceVerification,certificateCreated:false});}
 return result;
}
