import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const sha=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const nonempty=value=>typeof value==='string'&&value.length>0;
/** Read-only byte-chain comparison. No sessions, reasoning, authentication or outside paths. */
export async function collectCommunicationProof({events=[],workspace,sessionRoot,home}){
 const root=await fs.realpath(workspace),gaps=[],envelopes=[],native=[],captures=[],relations=new Map();
 async function bounded(file){
  const absolute=path.resolve(root,file),rel=path.relative(root,absolute);
  if(!rel||rel==='..'||rel.startsWith('../')||path.isAbsolute(rel))throw Error('outside workspace');
  let at=root;for(const part of rel.split(path.sep)){at=path.join(at,part);if((await fs.lstat(at)).isSymbolicLink())throw Error('symlink refused');}return absolute;
 }
 const eventRef=(index,selected)=>({kind:'event',index,selectedSha256:sha(JSON.stringify(selected))});
 for(const [index,row]of events.entries()){
  const p=row?.payload,q=p?.params??{},item=q.item??p?.item;
  if(item?.type==='subAgentActivity'&&nonempty(item.agentThreadId)&&nonempty(item.agentPath)&&nonempty(q.threadId)){
   const entry={agentPath:item.agentPath,threadId:item.agentThreadId,parentThreadId:q.threadId,source:eventRef(index,{threadId:q.threadId,item:{type:item.type,agentThreadId:item.agentThreadId,agentPath:item.agentPath}})};
   const prior=relations.get(item.agentThreadId);if(prior&&(prior.agentPath!==entry.agentPath||prior.parentThreadId!==entry.parentThreadId)){relations.set(item.agentThreadId,null);gaps.push({code:'CONFLICTING_NATIVE_RELATION',index});}else if(prior!==null)relations.set(item.agentThreadId,entry);
  }
 }
 for(const [index,row]of events.entries()){
  const p=row?.payload,q=p?.params??{};
  const task=p?.type==='task_complete'?p:p?.type==='event_msg'&&p.payload?.type==='task_complete'?p.payload:p?.method==='codex/event/task_complete'?(q.msg??q):null;
  if(task?.type==='task_complete'&&typeof task.last_agent_message==='string'){
   const threadId=q.threadId??row.threadId??row.nativeIdentity?.threadId,turnId=task.turn_id??q.turnId??row.nativeIdentity?.turnId;
   const relation=relations.has(threadId)?relations.get(threadId):row.nativeIdentity;
   const selected={threadId,turnId,agentPath:relation?.agentPath,parentThreadId:relation?.parentThreadId,text:task.last_agent_message};
   if(![threadId,turnId,selected.agentPath,selected.parentThreadId].every(nonempty)){gaps.push({code:'NATIVE_IDENTITY_MISSING',index});continue;}
   native.push({...selected,source:eventRef(index,selected)});
  }
  const item=q.item??p?.item;
  if(p?.method!=='item/completed'||!['commandExecution','command_execution'].includes(item?.type)||(item.exitCode??item.exit_code)!==0)continue;
  const command=item.command??'';
  if(!/execution-current-operation\.mjs\s+capture-native\b/.test(command))continue;
  const match=/--tool-result-file\s+(?:"([^"]+)"|'([^']+)'|([^\s'"]+))/.exec(command);
  if(!match){gaps.push({code:'CAPTURE_TOOL_RESULT_PATH_UNOBSERVED',index});continue;}
  let toolResultFile;try{toolResultFile=await bounded(match[1]??match[2]??match[3]);}catch{gaps.push({code:'CAPTURE_TOOL_RESULT_PATH_UNSAFE_OR_MISSING',index});continue;}
  for(const line of (item.aggregatedOutput??item.aggregated_output??'').split('\n')){
   let result;try{result=JSON.parse(line);}catch{continue;}
   if(result?.phase!=='captured'||!/^sha256:[0-9a-f]{64}$/.test(result.rawResponseSha256??''))continue;
   const selected={threadId:q.threadId??null,turnId:q.turnId??null,itemId:item.id??null,toolResultFile:path.relative(root,toolResultFile),phase:result.phase,rawResponseSha256:result.rawResponseSha256,status:result.status??null,captureClass:result.captureClass??null};
   captures.push({...selected,source:eventRef(index,selected)});
  }
 }
 let sessionsRead=false;
 if(sessionRoot){
  // Session input is explicit and belongs to this case's isolated home, never global Codex.
  const base=await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));
  const selectedHome=path.resolve(home??path.join(path.dirname(root),'home'));
  const expected=path.join(selectedHome,'.codex/sessions'),requested=path.resolve(sessionRoot);
  const relativeHome=path.relative(base,selectedHome);
  if(![path.join(path.dirname(root),'home'),path.join(root,'home')].includes(selectedHome)||!relativeHome||relativeHome.startsWith('..')||path.isAbsolute(relativeHome)||requested!==expected)throw Error('sessionRoot must belong to isolated case home within benchmark base');
  let cursor=base;for(const part of path.relative(base,requested).split(path.sep)){cursor=path.join(cursor,part);try{if((await fs.lstat(cursor)).isSymbolicLink())throw Error('session symlink refused');}catch(e){if(e.code!=='ENOENT')throw e;}}
  let count=0;
  async function sessionFiles(dir){let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT'){gaps.push({code:'SESSION_DIRECTORY_MISSING'});return [];}throw e;}const out=[];for(const entry of entries){if(++count>10000)throw Error('session scan limit');const p=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('session symlink refused');if(entry.isDirectory())out.push(...await sessionFiles(p));else if(entry.isFile()&&entry.name.endsWith('.jsonl'))out.push(p);}return out;}
  for(const file of await sessionFiles(requested)){
   if((await fs.stat(file)).size>64*1024*1024){gaps.push({code:'SESSION_FILE_TOO_LARGE',path:path.relative(requested,file)});continue;}
   const lines=(await fs.readFile(file,'utf8')).split('\n'),metas=[],completions=[];
   for(let index=0;index<lines.length;index++){
    const line=lines[index];
    // Reject unrelated record kinds before JSON projection; never retain their content.
    if(!/"type"\s*:\s*"(?:session_meta|event_msg)"/.test(line)||(!/"type"\s*:\s*"session_meta"/.test(line)&&! /"type"\s*:\s*"task_complete"/.test(line)))continue;
    let record;try{record=JSON.parse(line);}catch{gaps.push({code:'SELECTED_SESSION_RECORD_INVALID',path:path.relative(requested,file),line:index+1});continue;}
    const p=record.payload,source={kind:'selected-session-record',path:path.relative(requested,file),line:index+1,recordSha256:sha(line)};
    if(record.type==='session_meta')metas.push({id:p?.id,cwd:p?.cwd,parentThreadId:p?.source?.subagent?.thread_spawn?.parent_thread_id??p?.parent_thread_id,agentPath:p?.source?.subagent?.thread_spawn?.agent_path??p?.agent_path});
    else if(record.type==='event_msg'&&p?.type==='task_complete'&&typeof p.last_agent_message==='string')completions.push({turnId:p.turn_id,text:p.last_agent_message,source});
   }
   const identities=[...new Set(metas.map(m=>JSON.stringify(m)))].map(v=>JSON.parse(v));
   if(identities.length!==1){gaps.push({code:'SESSION_IDENTITY_MISSING_OR_CONFLICTING',path:path.relative(requested,file)});continue;}
   const meta=identities[0];if(path.resolve(meta.cwd??'')!==root)continue;
   if(![meta.id,meta.parentThreadId,meta.agentPath].every(nonempty))continue;
   for(const completion of completions){if(!nonempty(completion.turnId)){gaps.push({code:'NATIVE_TURN_ID_MISSING',source:completion.source});continue;}native.push({...completion,threadId:meta.id,parentThreadId:meta.parentThreadId,agentPath:meta.agentPath});}
  }
  sessionsRead=true;
 }
 let scanned=0;
 async function walk(dir){
  let entries;try{entries=await fs.readdir(await bounded(dir),{withFileTypes:true});}catch(e){gaps.push({code:e.code==='ENOENT'?'CONTROL_DIRECTORY_MISSING':'CONTROL_DIRECTORY_UNSAFE',path:path.relative(root,dir)});return;}
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
   if(++scanned>5000)throw Error('communication control scan limit exceeded');
   const file=path.join(dir,entry.name);
   if(entry.isSymbolicLink()){gaps.push({code:'SYMLINK_SKIPPED',path:path.relative(root,file)});continue;}
   if(entry.isDirectory()){await walk(file);continue;}
   // Only delivery envelopes. Do not traverse arbitrary JSON content or session logs.
   if(!entry.isFile()||!entry.name.endsWith('.json')||/auth|credentials?|session/i.test(entry.name))continue;
   try{
    await bounded(file);if((await fs.stat(file)).size>2*1024*1024){gaps.push({code:'ENVELOPE_TOO_LARGE',path:path.relative(root,file)});continue;}
    const bytes=await fs.readFile(file),v=JSON.parse(bytes);
    if(v&&Object.keys(v).every(k=>['agentId','status','finalResponse','preVerificationContinuation'].includes(k))&&nonempty(v.agentId)&&v.status==='completed'&&typeof v.finalResponse==='string')envelopes.push({agentId:v.agentId,text:v.finalResponse,file:path.relative(root,file),fileSha256:sha(bytes)});
   }catch{gaps.push({code:'ENVELOPE_UNREADABLE',path:path.relative(root,file)});}
  }
 }
 await walk(path.join(root,'tmp/sentinel'));
 await walk(path.join(root,'.benchmark-temp'));
 const pairs=envelopes.map(envelope=>{
  const responseSha256=sha(envelope.text),sameAgent=native.filter(n=>n.agentPath===envelope.agentId),exact=sameAgent.filter(n=>n.text===envelope.text);
  const ids=new Set(exact.map(n=>JSON.stringify([n.parentThreadId,n.threadId,n.turnId])));
  const official=captures.filter(c=>c.toolResultFile===envelope.file),matching=official.filter(c=>c.rawResponseSha256===responseSha256&&exact.some(n=>n.parentThreadId===c.threadId));
  const issues=[];
  if(!sameAgent.length)issues.push('NATIVE_TASK_COMPLETE_NOT_OBSERVED');else if(!exact.length)issues.push('NATIVE_LITERAL_MISMATCH');else if(ids.size!==1)issues.push('AMBIGUOUS_NATIVE_IDENTITY');
  if(!official.length)issues.push('OFFICIAL_CAPTURE_NOT_OBSERVED');else if(official.some(c=>c.rawResponseSha256!==responseSha256))issues.push('OFFICIAL_CAPTURE_HASH_MISMATCH');else if(!exact.length)issues.push('CONTROLLER_IDENTITY_UNOBSERVED');else if(matching.length!==official.length)issues.push('CONTROLLER_IDENTITY_MISMATCH');
  const matched=ids.size===1&&matching.length>0&&matching.length===official.length;
  return {agentId:envelope.agentId,parentEnvelope:{path:envelope.file,sha256:envelope.fileSha256},responseSha256,bytes:Buffer.byteLength(envelope.text),nativeMatches:exact.map(({text,...rest})=>rest),officialCaptures:official,status:matched?'MATCH':issues.some(s=>s.includes('MISMATCH'))?'MISMATCH':'INCOMPLETE',gaps:issues};
 });
 if(!native.length)gaps.push({code:'NO_NATIVE_TASK_COMPLETE_OBSERVATIONS'});
 if(!pairs.length)gaps.push({code:'NO_COMPLETED_DELIVERY_ENVELOPES'});
 return {schemaVersion:1,pairs,gaps,capability:{scope:'provided sanitized events, workspace tmp/sentinel or .benchmark-temp delivery envelopes, and explicitly supplied isolated selected session records',nativeSource:'task_complete.last_agent_message with explicit child identity',officialCaptureSource:'successful public capture-native command output bound to exact tool-result file',meaning:'Observed literal byte/hash consistency, not authentication of arbitrary forged input, not Sentinel PASS.',sessionsRead,sessionRoot:sessionRoot?path.resolve(sessionRoot):null,reasoningRead:false,authRead:false}};
}
