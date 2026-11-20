import {effectiveRoleBindings} from './case-profile.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {AppServer} from './app-server.mjs';import {verifySourceSnapshot} from './prepare.mjs';
import {confined,validateProfile,digest,sha256,writeOnce} from './core.mjs';
import {qualificationDigest,REQUIRED_TARGET_CAPABILITIES,harnessBinds} from './qualification.mjs';
const runCommand=(cmd,args,options)=>{const r=spawnSync(cmd,args,{...options,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});if(r.error||r.status!==0)throw Error('PREFLIGHT_COMMAND_FAILED: '+(r.error?.message??r.stderr));return r.stdout};
const runtimeFiles={
 'skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs':['export async function inspectCurrentExecution','normalHandoff'],
 'skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs':['export async function begin','export async function reserveDispatch','export async function bindNative','export async function captureNative','export async function publish','export async function resume'],
 'skills/workflows/stnl-execution-planner/runtime/preparation-draft.mjs':['stnl-draft-capture-v1','export async function capturePreparationDraft','export async function approvePreparationDraft'],
 'skills/workflows/stnl-spec-lifecycle-manager/runtime/publish-spec-lifecycle.mjs':['publishCandidate','CLOSE'],
 'agents/codex/.codex/agents/stnl_validation_runner.toml':['model = ','model_reasoning_effort = ']
};
function inspectRuntime(sourceRoot){const files=[];for(const [name,markers]of Object.entries(runtimeFiles)){const bytes=fs.readFileSync(confined(sourceRoot,name)),text=bytes.toString('utf8');if(markers.some(m=>!text.includes(m)))throw Error('SENTINEL_INTERFACE_INCOMPATIBLE: '+name);files.push({path:name,sha256:sha256(bytes)})}return{files,contractDigest:digest(files),level:'static interface markers only; not runtime behavioral proof'};}
function configuration(ack,expected,cwd,tmp){const actual={threadId:ack.thread?.id,model:ack.model,reasoningEffort:ack.reasoningEffort,cwd:ack.cwd,approvalPolicy:ack.approvalPolicy,sandbox:ack.sandbox};if(!actual.threadId||actual.model!==expected.model||actual.reasoningEffort!==expected.effort||path.resolve(actual.cwd??'')!==path.resolve(cwd)||actual.approvalPolicy!=='never')throw Error('THREAD_CONFIG_MISMATCH');const sandbox=actual.sandbox;if(sandbox?.type!==(expected.readOnly?'readOnly':'workspaceWrite')||sandbox.networkAccess!==false)throw Error('THREAD_SECURITY_MISMATCH');if(!expected.readOnly){if(sandbox.excludeSlashTmp!==true)throw Error('UNRESTRICTED_SYSTEM_TMP');if(!Array.isArray(sandbox.writableRoots)||sandbox.writableRoots.some(r=>!([cwd,tmp].some(root=>path.resolve(r)===root||path.resolve(r).startsWith(root+path.sep)))))throw Error('UNEXPECTED_WRITABLE_ROOT')}return actual;}
/** Real no-model preflight. Injected services ALWAYS mark proof SIMULATED, inadmissible. */
export async function targetPreflight({base,evidenceDir,profile,identity,harnessIdentity,sourceRoot,repository,services}={}){
 base=fs.realpathSync.native(base);evidenceDir=confined(base,evidenceDir);sourceRoot=confined(base,sourceRoot);const simulated=services!==undefined,scope=simulated?'SIMULATED':'REAL';
 const api={verifySource:verifySourceSnapshot,runCommand,createServer:o=>new AppServer(o),inspectRuntime,...services};validateProfile(profile);
 if(digest(profile)!==identity?.profile||profile.sentinelRevision!==identity?.sentinelRevision||profile.cliVersion!==identity?.cliVersion||!harnessBinds(harnessIdentity,identity))throw Error('PREFLIGHT_IDENTITY_MISMATCH');
 fs.mkdirSync(evidenceDir,{recursive:true});const work=confined(evidenceDir,'preflight-temp');if(fs.existsSync(work))throw Error('PREFLIGHT_ALREADY_EXISTS');fs.mkdirSync(work);const home=path.join(work,'home'),tmp=path.join(work,'tmp'),cwd=path.join(work,'workspace'),schemaDir=path.join(work,'schema');for(const d of [home,tmp,cwd,schemaDir])fs.mkdirSync(d);
 const env={...process.env,CODEX_HOME:home,TMPDIR:tmp};let server;const refs={};const proof=(name,value)=>{const file=confined(evidenceDir,name+'.json');writeOnce(file,{schemaVersion:1,scope,...value});const ref={ref:path.relative(base,file).split(path.sep).join('/'),sha256:sha256(fs.readFileSync(file))};refs[name]=ref;return ref};
 try{
 const source=await api.verifySource({source:sourceRoot,repository,revision:profile.sentinelRevision});if(source.sha256TreeDigest!==identity.source||source.revision!==profile.sentinelRevision)throw Error('SOURCE_PROOF_MISMATCH');const gitRef=proof('gitSnapshot',{sourceRoot,source});const profileRef=proof('profile',{profile,profileDigest:identity.profile});
 const version=(await api.runCommand(profile.cli,['--version'],{cwd,env})).trim();if(version!==`codex-cli ${profile.cliVersion}`)throw Error('CLI_VERSION_MISMATCH');
 const runtime=await api.inspectRuntime(sourceRoot);
 let capabilities,schemaProof;
 if(api.schemaCapabilities){const result=await api.schemaCapabilities({cli:profile.cli,schemaDir,cwd,env});capabilities=result.capabilities;schemaProof=result.files??[];}else{await api.runCommand(profile.cli,['app-server','generate-json-schema','--out',schemaDir],{cwd,env});const file=confined(schemaDir,'ClientRequest.json'),bytes=fs.readFileSync(file),s=JSON.parse(bytes);capabilities=s.oneOf?.flatMap(x=>x.properties?.method?.enum??[])??[];schemaProof=[{file:path.relative(base,file),sha256:sha256(bytes)}]}
 if(!Array.isArray(capabilities)||REQUIRED_TARGET_CAPABILITIES.some(c=>!capabilities.includes(c)))throw Error('ADVERTISED_PROTOCOL_INCOMPATIBLE');
 if(!simulated){const auth=path.join(process.env.HOME,'.codex/auth.json');if(!fs.existsSync(auth))throw Error('EXISTING_AUTH_REQUIRED');fs.symlinkSync(auth,path.join(home,'auth.json'));}
 fs.writeFileSync(path.join(home,'config.toml'),'cli_auth_credentials_store = "file"\n[features]\nmulti_agent = true\n');
 server=api.createServer({cli:profile.cli,cwd,home,tmpDir:tmp,onEvent:()=>{}});await server.start();const listed=[],seenCursors=new Set();let cursor;do{if(seenCursors.size>=100||cursor&&seenCursors.has(cursor))throw Error('MODEL_LIST_PAGINATION_LOOP');if(cursor)seenCursors.add(cursor);const page=await server.request('model/list',cursor?{cursor}:{});listed.push(...(page.data??[]));if(page.nextCursor===cursor&&cursor)throw Error('MODEL_LIST_PAGINATION_LOOP');cursor=page.nextCursor;}while(cursor);
 const models=effectiveRoleBindings(profile).map(binding=>{const found=listed.find(x=>x.model===binding.model||x.id===binding.model);if(!found||!Array.isArray(found.supportedReasoningEfforts)||!found.supportedReasoningEfforts.some(x=>x.reasoningEffort===binding.effort))throw Error('MODEL_OR_EFFORT_UNAVAILABLE: '+binding.role);return binding});const modelRef=proof('modelSupport',{roles:models,listing:listed.map(x=>({id:x.id,model:x.model,supportedReasoningEfforts:x.supportedReasoningEfforts}))});
 const observed=[],history=[];const combinations=new Map();for(const role of models){const key=JSON.stringify([role.model,role.effort,(role.logicalRole??role.role)==='plan_approver']);if(!combinations.has(key))combinations.set(key,{...role,roles:[],readOnly:(role.logicalRole??role.role)==='plan_approver'});combinations.get(key).roles.push(role.role)}
 for(const c of combinations.values()){
  const params={model:c.model,cwd,approvalPolicy:'never',sandbox:c.readOnly?'read-only':'workspace-write',config:{model_reasoning_effort:c.effort,'sandbox_workspace_write.exclude_slash_tmp':true,'sandbox_workspace_write.network_access':false}};
  const start=configuration(await server.startThread(params),c,cwd,tmp);
  observed.push({roles:c.roles,phase:'thread/start',...start});
  const entry={threadId:start.threadId};history.push(entry);
  try{
   const read=await server.request('thread/read',{threadId:start.threadId,includeTurns:false});
   if(read.thread?.id!==start.threadId)throw Error('THREAD_READ_IDENTITY_MISMATCH');
   entry.read='confirmed';
  }catch(e){
   if(!/not found|not materialized|no persisted/i.test(e.message))throw e;
   Object.assign(entry,{read:'empty-thread-not-materialized',resume:'not-attempted',readError:{code:e.code??null,message:e.message},limitation:'Metadata unavailable for empty thread; resume not exercised without model turn'});
   continue;
  }
  try{
   const resumed=configuration(await server.resumeThread({...params,threadId:start.threadId}),c,cwd,tmp);
   if(resumed.threadId!==start.threadId)throw Error('THREAD_RESUME_IDENTITY_MISMATCH');
   observed.push({roles:c.roles,phase:'thread/resume',...resumed});entry.resume='confirmed';
  }catch(e){
   // Exact observed zero-turn provider condition only. Other errors remain blocking.
   if(e.code!==-32600||e.message!==`no rollout found for thread id ${start.threadId}`)throw e;
   Object.assign(entry,{resume:'unavailable-empty-thread',resumeError:{code:e.code,message:e.message},limitation:'Metadata read confirmed; zero-turn thread has no persisted rollout. Resume is advertised but persistence/recovery was not exercised.'});
  }
 }
 const securityRef=proof('securityContext',{observed,contextPolicyDigest:harnessIdentity.contextPolicy,profileDigest:identity.profile});const protocolRef=proof('protocolCompatibility',{cliVersion:profile.cliVersion,capabilities:REQUIRED_TARGET_CAPABILITIES,schemaProof,runtime,history,limitation:'Schema/interface and zero-turn acknowledgments only; no task execution or end-to-end proof.'});
 await server.stop();server=null;const status=real=>simulated?'SIMULATED':real;const targetProof={schemaVersion:1,scope,targetIdentityDigest:qualificationDigest(identity),harnessIdentityDigest:qualificationDigest(harnessIdentity),checks:{gitSnapshot:{status:status('VERIFIED'),revision:identity.sentinelRevision,treeDigest:identity.source,gitTree:source.tree,proof:gitRef},profile:{status:status('VERIFIED'),profileDigest:identity.profile,proof:profileRef},modelSupport:{status:status('SUPPORTED'),profileDigest:identity.profile,roles:models,proof:modelRef},securityContext:{status:status('MATCH'),contextPolicyDigest:harnessIdentity.contextPolicy,profileDigest:identity.profile,proof:securityRef},protocolCompatibility:{status:status('SUPPORTED'),adapterProtocolDigest:harnessIdentity.adapterProtocol,cliVersion:identity.cliVersion,sourceDigest:identity.source,sentinelRuntimeContractDigest:runtime.contractDigest,requiredCapabilities:REQUIRED_TARGET_CAPABILITIES,proof:protocolRef}}};proof('targetProof',{targetProof});return{scope,targetProof,modelTurnsStarted:0,limitations:['No billing/model request, task PASS, or end-to-end Sentinel compatibility claimed.','Pure admission still requires reference harness qualification.']};
 }catch(error){proof('failure',{status:'BLOCKED',error:String(error.message),proofRefs:refs});throw error;}finally{if(server)await server.stop()}
}
