import fs from 'node:fs';
import path from 'node:path';
import {AppServer} from './app-server.mjs';
import {confined,writeOnce,sha256} from './core.mjs';

const CONTENT='sentinel-environment-heredoc-proof\n';
const SCRIPT=`set -eu
set -o noclobber
printf 'TMPDIR=%s\\nTMPPREFIX=%s\\n' "$TMPDIR" "$TMPPREFIX"
cat > "$TMPDIR/environment-preflight/heredoc.txt" <<'SENTINEL_ENV_PROOF'
sentinel-environment-heredoc-proof
SENTINEL_ENV_PROOF
`;
/** Zero-model operational sandbox probe; injected services can never produce REAL evidence. */
export async function environmentPreflight({manifest:m,deadline,services}={}) {
 const file=confined(m.evidence,'environment-preflight.json');
 if(fs.existsSync(file))throw Error('ENVIRONMENT_PREFLIGHT_ALREADY_ATTEMPTED');
 const scope=services===undefined?'REAL':'SIMULATED';
 const report={schemaVersion:1,scope,status:'BLOCKED',modelTurnsStarted:0,startedAt:Date.now()};
 let server,timer;
 const end=Math.min(Number(new Date(deadline)),Date.now()+10000);
 const remaining=()=>{const ms=end-Date.now();if(!Number.isFinite(ms)||ms<=0)throw Error('ENVIRONMENT_PREFLIGHT_DEADLINE');return ms;};
 const bounded=async fn=>{const ms=remaining();try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('ENVIRONMENT_PREFLIGHT_DEADLINE')),ms);})]);}finally{clearTimeout(timer);}};
 try {
  remaining();
  const workspace=fs.realpathSync.native(m.workspace),tmp=fs.realpathSync.native(m.tmpDir);
  const probe=confined(tmp,'environment-preflight');
  fs.mkdirSync(probe); // Exclusive identity: never replay a prior partially executed probe.
  const proofFile=confined(probe,'heredoc.txt');
  server=(services?.createServer??(o=>new AppServer(o)))({cli:m.profile.cli,cwd:workspace,home:m.codexHome,tmpDir:tmp,onEvent:()=>{}});
  await bounded(()=>server.start());
  const sandboxPolicy={type:'workspaceWrite',writableRoots:[workspace],excludeSlashTmp:true,excludeTmpdirEnvVar:false,networkAccess:false};
  report.sandboxPolicy=sandboxPolicy;
  const result=await bounded(()=>server.request('command/exec',{command:['/bin/zsh','-lc',SCRIPT],cwd:workspace,sandboxPolicy,timeoutMs:remaining(),outputBytesCap:8192},{timeoutMs:remaining()}));
  // Deliberately do not persist arbitrary shell output or stderr (startup files can print secrets).
  const expected='TMPDIR='+tmp+'\nTMPPREFIX='+tmp+'/zsh\n';
  report.command={exitCode:result.exitCode??null,environmentMatches:result.stdout===expected,stderrEmpty:result.stderr==='',stdoutSha256:sha256(String(result.stdout??'')),stderrSha256:sha256(String(result.stderr??''))};
  if(result.exitCode!==0||!report.command.environmentMatches||!report.command.stderrEmpty)throw Error('ENVIRONMENT_PREFLIGHT_COMMAND_MISMATCH');
  confined(probe,'heredoc.txt');
  const stat=fs.lstatSync(proofFile);if(!stat.isFile()||stat.size!==Buffer.byteLength(CONTENT))throw Error('ENVIRONMENT_PREFLIGHT_HEREDOC_MISMATCH');
  const bytes=fs.readFileSync(proofFile);if(bytes.toString('utf8')!==CONTENT)throw Error('ENVIRONMENT_PREFLIGHT_HEREDOC_MISMATCH');
  report.proof={rootIdentifier:'TMPDIR',file:path.relative(tmp,proofFile),sha256:sha256(bytes),contentMatches:true};
  report.environment={TMPDIR:tmp,TMPPREFIX:tmp+'/zsh'};
  report.status='PASS';
 }catch(error){report.error={message:String(error.message),code:error.code??null};}
 finally{
  if(server)try{await server.stop();}catch(error){report.status='BLOCKED';report.stopError=String(error.message);}
  report.finishedAt=Date.now();writeOnce(file,report);
 }
 if(report.status!=='PASS'){const error=Error(report.error?.message??'ENVIRONMENT_PREFLIGHT_STOP_FAILED');error.report=report;throw error;}
 return report;
}
