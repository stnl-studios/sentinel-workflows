// Experimental synthetic Python/SQLite campaign. A presentation is historical
// evidence, NEVER a new execution receipt, cached PASS, or formal acceptance.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash,createHmac,randomUUID,randomBytes,timingSafeEqual} from 'node:crypto';
import {performance} from 'node:perf_hooks';

const driver=fileURLToPath(new URL('./python-sql-check-driver.py',import.meta.url));
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
export const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const relative=name=>{if(typeof name!=='string'||!name||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'))fail('UNSAFE_PATH','exact relative fixture path required');return name;};
async function owned(file) {
 const stat=await fs.lstat(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||process.getuid&&stat.uid!==process.getuid())fail('UNTRUSTED_PROOF','producer-owned regular proof required');
 const bytes=await fs.readFile(file),after=await fs.lstat(file);
 if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs)fail('INPUT_CHANGED','file changed during capture');
 return bytes;
}
async function snapshot(root) {
 const entries=[];
 async function walk(name) {
  const file=path.join(root,name),before=await fs.lstat(file);
  if(before.isSymbolicLink())fail('UNSAFE_PATH','fixture symlinks are unsupported');
  if(before.isDirectory()) {
   const children=(await fs.readdir(file)).sort();entries.push({path:name||'.',kind:'directory',children});
   for(const child of children)await walk(name?name+'/'+child:child);
   if(canonical(children)!==canonical((await fs.readdir(file)).sort()))fail('INPUT_CHANGED','fixture membership changed during snapshot');
  } else if(before.isFile()) {
   const bytes=await owned(file);entries.push({path:name,kind:'file',sha256:sha(bytes),mode:before.mode&0o777});
  } else fail('UNSAFE_PATH','fixture contains unsupported entry');
 }
 await walk('');return entries;
}
async function runtimeBytes(file) {const stat=await fs.stat(file);if(!stat.isFile())fail('INVALID_RUNTIME','regular runtime file required');const bytes=await fs.readFile(file),after=await fs.stat(file);if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs)fail('INPUT_CHANGED','runtime changed during fingerprint');return bytes;}
async function saveNew(file,value,mode=0o600) {await fs.writeFile(file,typeof value==='string'?value:canonical(value)+'\n',{flag:'wx',mode});}
const sign=(key,payload)=>createHmac('sha256',Buffer.from(key,'hex')).update(canonical(payload)).digest('hex');
function verifySigned(key,envelope) {
 const expected=Buffer.from(sign(key,envelope.payload),'hex'),actual=Buffer.from(envelope.signature??'','hex');
 if(expected.length!==actual.length||!timingSafeEqual(expected,actual))fail('UNTRUSTED_PROOF','campaign signature does not authenticate the original producer observation');
 return envelope.payload;
}
function validateCheck(check) {
 if(!check||typeof check.id!=='string'||!/^[a-z][a-z0-9-]*$/u.test(check.id))fail('INVALID_RECIPE','check id required');
 relative(check.script);
 if(!check.script.startsWith('checks/')||!check.script.endsWith('.py'))fail('INVALID_RECIPE','synthetic Python check required');
 if(!Array.isArray(check.declaredInputs)||check.declaredInputs.some(name=>relative(name)!==name))fail('INVALID_RECIPE','exact declared inputs required');
 if(check.args?.length)fail('UNSUPPORTED_RECIPE','arguments are not supported by this bounded synthetic profile');
 if(Object.keys(check).some(key=>!['id','script','declaredInputs','args'].includes(key)))fail('INVALID_RECIPE','unknown check field');
}
function pythonProcess(python,args,{cwd,timeoutMs=30000,onSpawn=null}={}) {
 return new Promise(resolve=>{
  const started=performance.now(),chunks=[[],[],[]];let bytes=0,timedOut=false,spawned=false,spawnError=null;
  const child=spawn(python,args,{cwd,env:{PATH:path.dirname(python),LANG:'C.UTF-8',LC_ALL:'C.UTF-8'},stdio:['ignore','pipe','pipe','pipe']});
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
  child.once('spawn',()=>{spawned=true;onSpawn?.();});
  child.once('error',error=>{spawnError={code:error.code,message:error.message};});
  for(const [index,stream] of [child.stdout,child.stderr,child.stdio[3]].entries())stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){timedOut=true;child.kill('SIGKILL');}else chunks[index].push(chunk);});
  child.once('close',(exit,signal)=>{clearTimeout(timer);resolve({spawned,exit,signal,timedOut,spawnError,durationMs:performance.now()-started,stdout:Buffer.concat(chunks[0]).toString(),stderr:Buffer.concat(chunks[1]).toString(),report:Buffer.concat(chunks[2]).toString()});});
 });
}
export async function runSyntheticCampaign({fixtureRoot,campaignRoot,python,checks,database={kind:'fresh-sqlite-memory'},timeoutMs=30000}) {
 fixtureRoot=await fs.realpath(fixtureRoot);campaignRoot=path.resolve(campaignRoot);campaignRoot=path.join(await fs.realpath(path.dirname(campaignRoot)),path.basename(campaignRoot));python=await fs.realpath(python);
 if(database?.kind!=='fresh-sqlite-memory'||Object.keys(database).length!==1)fail('LIVE_STATE_UNSUPPORTED','persistent/external database needs a separately approved disposable adapter and verified state identity');
 if(campaignRoot===fixtureRoot||campaignRoot.startsWith(fixtureRoot+path.sep))fail('UNSAFE_PATH','campaign controls must be outside fixture');
 if(!Array.isArray(checks)||!checks.length||new Set(checks.map(check=>check.id)).size!==checks.length)fail('INVALID_RECIPE','distinct checks required');
 checks.forEach(validateCheck);
 const original=await snapshot(fixtureRoot),campaignId=randomUUID(),key=randomBytes(32).toString('hex');
 await fs.mkdir(campaignRoot,{mode:0o700});
 const source=path.join(campaignRoot,'source');await fs.cp(fixtureRoot,source,{recursive:true,preserveTimestamps:true});
 if(canonical(await snapshot(source))!==canonical(original)||canonical(await snapshot(fixtureRoot))!==canonical(original))fail('INPUT_CHANGED','fixture changed while freezing source');
 const identity={campaignId,campaignRoot,fixtureRoot,python,pythonSha256:sha(await runtimeBytes(python)),driverSha256:sha(await owned(driver)),fixtureSha256:sha(canonical(original)),database};
 await saveNew(path.join(campaignRoot,'.producer-authority.json'),{...identity,key});
 let physicalInvocations=0;const observations=[];
 for(const check of checks) {
  const requestId=randomUUID();
  const request={...identity,requestId,check,source};
  const process=await pythonProcess(python,['-I','-S','-B',driver,source,check.script,requestId],{cwd:source,timeoutMs,onSpawn:()=>{physicalInvocations++;}});
  let measured=null;try {measured=JSON.parse(process.report);}catch{}
  const concluded=process.spawned&&!process.timedOut&&!process.signal&&!process.spawnError&&measured?.requestId===requestId&&measured.exit===process.exit;
  const status=concluded?measured.status:'infrastructure-error';
  const observation={format:'stnl-isolated-python-check-v1',request,status,physicalExecution:process.spawned,concluded,
   execution:{exit:process.exit,signal:process.signal,spawnError:process.spawnError,timedOut:process.timedOut,durationMs:process.durationMs,stdout:process.stdout,stderr:process.stderr,stdoutSha256:sha(process.stdout),stderrSha256:sha(process.stderr)},
   measured:concluded?measured:null,
   undeclaredInputs:concluded?measured.reads.filter(item=>!check.declaredInputs.includes(item.path)).map(item=>item.path):[],
   claim:'historical-observation-only; no determinism or fresh-execution claim'};
  if(canonical(await snapshot(source))!==canonical(original))fail('INPUT_CHANGED','check mutated isolated source snapshot');
  const name=check.id+'.observation.json';await saveNew(path.join(campaignRoot,name),{payload:observation,signature:sign(key,observation)});
  observations.push({id:check.id,path:name,sha256:sha(canonical(observation)),status,physicalExecution:process.spawned});
 }
 const campaign={format:'stnl-isolated-python-sql-campaign-v1',...identity,checks:observations,physicalInvocations,
  physicalDatabasePublications:0,databaseConnectionCount:0,sqlServerCertified:false,formalAcceptance:false};
 for(const item of observations){const envelope=JSON.parse(await owned(path.join(campaignRoot,item.path)));campaign.databaseConnectionCount+=envelope.payload.measured?.databases.length??0;}
 await saveNew(path.join(campaignRoot,'campaign.json'),{payload:campaign,signature:sign(key,campaign)});
 return campaign;
}
export async function inspectHistoricalCampaign({campaignRoot,fixtureRoot,checks,database={kind:'fresh-sqlite-memory'}}) {
 if(database?.kind!=='fresh-sqlite-memory'||Object.keys(database).length!==1)fail('LIVE_STATE_UNSUPPORTED','historical memory-database evidence cannot stand for live/external database state');
 campaignRoot=await fs.realpath(campaignRoot);fixtureRoot=await fs.realpath(fixtureRoot);checks.forEach(validateCheck);
 const authority=JSON.parse(await owned(path.join(campaignRoot,'.producer-authority.json')));
 if(authority.campaignRoot!==campaignRoot||authority.fixtureRoot!==fixtureRoot)fail('OWNER_MISMATCH','campaign belongs to another source path or workspace');
 const campaign=verifySigned(authority.key,JSON.parse(await owned(path.join(campaignRoot,'campaign.json'))));
 if(campaign.campaignId!==authority.campaignId||campaign.campaignRoot!==campaignRoot||campaign.fixtureRoot!==fixtureRoot)fail('OWNER_MISMATCH','campaign identity differs');
 if(sha(canonical(await snapshot(path.join(campaignRoot,'source'))))!==campaign.fixtureSha256)fail('INPUT_CHANGED','original frozen source snapshot changed');
 const current=await snapshot(fixtureRoot),byPath=new Map(current.map(item=>[item.path,item]));
 const decisions=[],runtimeFiles=new Map(),runtimeDirectories=new Map();
 // Reuse measurements only within this one read-only presentation pass, then
 // verify filesystem identities again before returning. This is not a cache
 // of check results or a lasting assumption that the runtime is unchanged.
 const measureRuntime=async file=>{
  if(!runtimeFiles.has(file)) {
   const before=await fs.stat(file),bytes=await runtimeBytes(file),after=await fs.stat(file);
   const identity=metadata=>[metadata.dev,metadata.ino,metadata.size,metadata.mode,metadata.mtimeMs,metadata.ctimeMs];
   if(canonical(identity(before))!==canonical(identity(after)))fail('INPUT_CHANGED','runtime changed during presentation');
   runtimeFiles.set(file,{sha256:sha(bytes),mode:after.mode&0o777,identity:identity(after)});
  }
  return runtimeFiles.get(file);
 };
 const measureRuntimeDirectory=async directory=>{
  if(!runtimeDirectories.has(directory))runtimeDirectories.set(directory,(await fs.readdir(directory)).sort());
  return runtimeDirectories.get(directory);
 };
 for(const check of checks) {
  const entry=campaign.checks.find(item=>item.id===check.id);
  if(!entry){decisions.push({id:check.id,action:'execute',reason:'no-original-observation'});continue;}
  const observation=verifySigned(authority.key,JSON.parse(await owned(path.join(campaignRoot,relative(entry.path)))));
  if(sha(canonical(observation))!==entry.sha256||observation.request.campaignId!==campaign.campaignId||observation.request.campaignRoot!==campaignRoot)fail('OWNER_MISMATCH','check does not belong to the authenticated campaign');
  const reasons=[];
  if(canonical(observation.request.check)!==canonical(check))reasons.push('recipe-changed');
  if(!observation.concluded||observation.status!=='passed')reasons.push('check-not-concluded-successfully');
  if(observation.undeclaredInputs.length)reasons.push('indirect-input-not-declared');
  if(observation.measured?.ambientInputs.length)reasons.push('temporal-random-or-concurrent-input');
  if(observation.measured?.unclosedInputs.length)reasons.push('unobserved-or-dynamic-dependency');
  if(authority.pythonSha256!==(await measureRuntime(authority.python)).sha256||authority.driverSha256!==(await measureRuntime(driver)).sha256)reasons.push('runtime-or-driver-changed');
  for(const input of observation.measured?.runtimeReads??[]) {
   try {const measured=await measureRuntime(input.path);if(measured.sha256!==input.sha256||measured.mode!==input.mode)reasons.push('runtime-module-changed:'+input.path);}catch{reasons.push('runtime-module-missing:'+input.path);}
  }
  for(const listing of observation.measured?.runtimeListings??[]) {
   try {if(canonical(await measureRuntimeDirectory(listing.path))!==canonical(listing.children))reasons.push('runtime-membership-changed:'+listing.path);}catch{reasons.push('runtime-directory-missing:'+listing.path);}
  }
  for(const input of observation.measured?.reads??[]) {
   const value=byPath.get(input.path);
   if(value?.kind!=='file'||value.sha256!==input.sha256||value.mode!==input.mode)reasons.push('input-changed:'+input.path);
  }
  for(const absent of observation.measured?.absentReads??[]) {
   try {await fs.lstat(path.join(fixtureRoot,relative(absent)));reasons.push('absent-input-materialized:'+absent);}catch(error){if(error.code!=='ENOENT')reasons.push('absent-input-path-changed:'+absent);}
  }
  for(const absent of observation.measured?.runtimeAbsentReads??[]) {
   try {await fs.lstat(absent);reasons.push('runtime-absence-changed:'+absent);}catch(error){if(error.code!=='ENOENT')reasons.push('runtime-absence-path-changed:'+absent);}
  }
  for(const listing of observation.measured?.listings??[]) {
   const value=byPath.get(listing.path);
   if(value?.kind!=='directory'||canonical(value.children)!==canonical(listing.children))reasons.push('membership-changed:'+listing.path);
  }
  decisions.push({id:check.id,action:reasons.length?'execute':'present-for-independent-review',reasons,
   source:{campaignId:campaign.campaignId,campaignRoot,observationPath:entry.path,observationSha256:entry.sha256},
   currentInputSha256:sha(canonical({reads:(observation.measured?.reads??[]).map(item=>byPath.get(item.path)),listings:(observation.measured?.listings??[]).map(item=>byPath.get(item.path))})),
   sourceElapsedMs:observation.execution.durationMs,
   notice:'This is the original isolated synthetic observation. No new check execution or formal PASS is asserted.'});
 }
 for(const [file,measured] of runtimeFiles) {
  const metadata=await fs.stat(file);
  if(canonical([metadata.dev,metadata.ino,metadata.size,metadata.mode,metadata.mtimeMs,metadata.ctimeMs])!==canonical(measured.identity))fail('INPUT_CHANGED','runtime changed during presentation');
 }
 for(const [directory,children] of runtimeDirectories)if(canonical((await fs.readdir(directory)).sort())!==canonical(children))fail('INPUT_CHANGED','runtime membership changed during presentation');
 return {format:'stnl-historical-campaign-review-v1',campaignId:campaign.campaignId,fixtureRoot,decisions,
  physicalInvocations:0,sqlServerCertified:false,formalAcceptance:false,automaticReuseAllowed:false,
  closureAssurance:'Audit events are incomplete for arbitrary Python/native code; independent review must not infer hermeticity or determinism.',
  reviewObligations:['Confirm whether earlier isolated evidence is sufficient for the current question.','Execute any required current check; unknown live/temporal state requires execution; this interface supplies no waiver.']};
}
export async function presentHistoricalCampaign({campaignRoot,fixtureRoot,checks,presentationFile,operationIdentity,reviewerIdentity,database={kind:'fresh-sqlite-memory'}}) {
 if(typeof operationIdentity!=='string'||!operationIdentity||typeof reviewerIdentity!=='string'||!reviewerIdentity)fail('MISSING_REVIEW_IDENTITY','new operation and independent reviewer identity required');
 const absoluteTarget=path.resolve(presentationFile),target=path.join(await fs.realpath(path.dirname(absoluteTarget)),path.basename(absoluteTarget)),sourceRoot=await fs.realpath(campaignRoot),currentRoot=await fs.realpath(fixtureRoot);
 if([sourceRoot,currentRoot].some(root=>target===root||target.startsWith(root+path.sep)))fail('UNSAFE_PATH','presentation must not mutate the original campaign or fixture');
 const report=await inspectHistoricalCampaign({campaignRoot,fixtureRoot,checks,database});
 if(operationIdentity===report.campaignId)fail('OWNER_MISMATCH','presentation must have a new operation identity');
 const presentation={...report,presentationId:randomUUID(),operationIdentity,reviewerIdentity,
  status:'historical-evidence-awaiting-independent-review',createdAt:new Date().toISOString(),
  priorInvocationsReferenced:report.decisions.filter(item=>item.action==='present-for-independent-review').length,
  warning:'Presentation is not execution, cache validity, determinism certification, formal acceptance, or permission to skip required current checks.'};
 await saveNew(presentationFile,presentation);return presentation;
}
