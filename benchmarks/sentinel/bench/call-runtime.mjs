#!/usr/bin/env node
// Structured adapter around public official exports; no stack parsing or runtime rewriting.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {confined,sha256} from './core.mjs';
const allowed=new Set(['capturePreparationDraft','preparationDraftPaths','revisePreparationDraft']);
try{
 const [home,operation,serialized,guardJson]=process.argv.slice(2);
 const guard=guardJson===undefined?null:JSON.parse(guardJson);
 if(guard!==null&&(operation!=='revisePreparationDraft'||Object.keys(guard).join(',')!=='rejectedCaptureSha256'||!/^sha256:[0-9a-f]{64}$/.test(guard.rejectedCaptureSha256)))throw Error('invalid revision guard');
 if(!allowed.has(operation))throw Object.assign(Error('unsupported public export'),{code:'WRAPPER_OPERATION_BLOCKED'});
 const options=JSON.parse(serialized);
 if(!options||Object.keys(options).sort().join(',')!=='candidateExecutionRoot,specPath')throw Error('invalid public export options');
 const workspace=fs.realpathSync.native(process.cwd());
 options.specPath=confined(workspace,options.specPath);options.candidateExecutionRoot=confined(workspace,options.candidateExecutionRoot);
 const modulePath=confined(home,'.codex/skills/stnl-execution-planner/runtime/preparation-draft.mjs');
 const module=await import(pathToFileURL(modulePath));
 if(typeof module[operation]!=='function')throw Error('official public export missing');
 if(operation==='revisePreparationDraft'){
  const paths=await module.preparationDraftPaths(options);
  for(const key of ['capture','approval']){const file=confined(workspace,paths[key]);if(key==='capture'&&guard){if('sha256:'+sha256(fs.readFileSync(file))!==guard.rejectedCaptureSha256)throw Object.assign(Error('rejected capture changed'),{code:'REJECTED_CAPTURE_CHANGED'});continue;}try{fs.lstatSync(file);throw Object.assign(Error('Existing '+key+' cannot be revised by recovery'),{code:'RECOVERY_CONTROL_PRESENT'});}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 const result=await module[operation](options);
 process.stdout.write(JSON.stringify({ok:true,result})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,error:{code:typeof error.code==='string'?error.code:'RUNTIME_EXPORT_ERROR',message:String(error.message),...(typeof error.reasonCode==='string'?{reasonCode:error.reasonCode}:{})}})+'\n');process.exitCode=1;}
