// Isolated effect probe for the offline native formal producer. Product imports
// in the worker happen only after execFile is wrapped.
import fs from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';

const here=fileURLToPath(import.meta.url);
const raw=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export async function concludeSecond(image,status='BLOCKED') {
  const [{createCurrentNativeValidationCapture},{composePostConversionValidation},
    {installSuccessor}]=await Promise.all([
    import('../../skills/workflows/stnl-slice-executor/runtime/current-native-validation-capture.mjs'),
    import('../../skills/workflows/stnl-slice-executor/runtime/current-evidence-state.mjs'),
    import('./current-operational-consumption.mjs'),
  ]);
  const deliveries=JSON.parse(image.candidate.files.get('continuity.json')).deliveries;
  if(deliveries.length!==2) throw new Error('preflight fixture needs two converted deliveries');
  const deliveryId=deliveries[1].deliveryId;
  const session=await createCurrentNativeValidationCapture({specPath:image.f.specPath,
    deliveryId,captureParent:image.f.root});
  const agentId=`preflight-second-${status.toLowerCase()}`;
  await session.bindAgent({agentId});
  const measured=await session.runVerification();
  if(measured.status!=='completed' || measured.commands.some(item=>item.exit!==0))
    throw new Error('second delivery recipe did not complete');
  const response=JSON.stringify({format:'stnl-current-validation-response-v1',
    requestSha256:raw(session.validationRequest),result:{status,head:'offline-working-tree',
      commands:measured.commands,
      evidence:'The real recipe completed; semantic judgment is an explicit offline stimulus.',
      findingReferences:'none',findingDispositions:'none',
      blockers:status==='BLOCKED'?'The second delivery cannot receive an independent acceptance judgment.':'none',
      unexpectedWorkspaceEffects:'none',persistenceSummary:'Retain the concluded formal record.'},newFindings:[]});
  const capture=await session.finish({agentId,status,finalResponse:response});
  const composed=await composePostConversionValidation({context:session.context,
    requirementsAuthority:session.requirementsAuthority,previous:session.previous,deliveryId,capture});
  return installSuccessor(image,image.activation,composed);
}

export function probe({modulePath,specPath,deliveryId,captureParent,mode,onReady}) {
  return new Promise((resolve,reject)=>{
    const env={...process.env};delete env.NODE_TEST_CONTEXT;
    const child=childProcess.spawn(process.execPath,[here,'--worker',modulePath,specPath,
      deliveryId,captureParent,mode],{env,stdio:['ignore','pipe','pipe','ipc']});
    let stdout='',stderr='',result=null,callbackError=null;
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    const timer=setTimeout(()=>child.kill(),45000);
    child.on('message',message=>{
      if(message?.kind==='ready') Promise.resolve().then(()=>onReady?.(message))
        .then(()=>child.send({kind:'continue'})).catch(error=>{callbackError=error;child.kill();});
      if(message?.kind==='result') result=message;
    });
    child.on('error',error=>{callbackError=error;});
    child.on('close',code=>{
      clearTimeout(timer);
      if(callbackError) reject(callbackError);
      else if(code!==0 || !result) reject(new Error(`preflight worker exit ${code}: ${stderr} ${stdout}`));
      else resolve({...result,stdout,stderr});
    });
  });
}

async function worker() {
  const [modulePath,specPath,deliveryId,captureParent,mode]=process.argv.slice(3);
  const before=(await fs.readdir(captureParent)).filter(name=>name.startsWith('stnl-current-native-')).sort();
  const calls=[],original=childProcess.execFile;
  childProcess.execFile=function(...args) {
    calls.push({executable:String(args[0]),args:args[1]});
    return original.apply(this,args);
  };
  syncBuiltinESMExports();
  let accepted=false,error=null,measured=null,privateFiles=[];
  try {
    const {createCurrentNativeValidationCapture}=await import(pathToFileURL(modulePath).href);
    const session=await createCurrentNativeValidationCapture({specPath,deliveryId,captureParent});
    accepted=true;
    if(mode!=='factory') {
      const binding=await session.bindAgent({agentId:'preflight-probe-agent'});
      if(mode==='wait-run') {
        const continued=new Promise(resolve=>process.once('message',message=>{
          if(message?.kind==='continue') resolve();
        }));
        process.send({kind:'ready'});
        await continued;
      }
      measured=await session.runVerification();
      privateFiles=(await fs.readdir(path.dirname(binding.originFile))).sort();
    }
  } catch(cause) {
    accepted=false;
    error={code:cause.code??null,message:cause.message};
  }
  const after=(await fs.readdir(captureParent)).filter(name=>name.startsWith('stnl-current-native-')).sort();
  if(!privateFiles.length && after.length>before.length)
    privateFiles=(await fs.readdir(path.join(captureParent,after.find(name=>!before.includes(name))))).sort();
  process.send({kind:'result',accepted,error,measured,calls,privateAdded:after.filter(name=>!before.includes(name)),privateFiles});
}

if(process.argv[1] && path.resolve(process.argv[1])===here && process.argv[2]==='--worker')
  worker().catch(error=>{process.stderr.write(`${error.stack}\n`);process.exitCode=1;});
