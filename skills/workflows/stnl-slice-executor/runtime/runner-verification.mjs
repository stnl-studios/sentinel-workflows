// Producer-owned observation of the reviewed direct-exec recipe. No shell parser.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readOwnedFile, parseStrictJson, persistAllocation, syncLockParent } from './execution-publication.mjs';

const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(`runner verification: ${message}`); };
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const quote = value => /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
export const verificationCommand = check => [check.executable, ...check.args].map(quote).join(' ');

// Same-operation replay binding only. This does not authorize cross-phase reuse
// or claim that arbitrary commands are deterministic/hermetic.
async function executionContext(verification, env, outputFile, invocationBinding) {
  const executables=[];
  for(const check of verification.checks) {
    const candidates=check.executable.includes('/')?[path.resolve(check.cwd,check.executable)]
      :(env.PATH??'/usr/bin:/bin').split(path.delimiter).map(dir=>path.resolve(check.cwd,dir||'.',check.executable));
    let selected=null;
    for(const candidate of candidates) {
      try {await fs.access(candidate,constants.X_OK);const metadata=await fs.stat(candidate);if(metadata.isFile()){selected=await fs.realpath(candidate);break;}}
      catch(error) {if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error;}
    }
    if(!selected)fail('executable cannot be fingerprinted before verification');
    const before=await fs.stat(selected),bytes=await fs.readFile(selected),after=await fs.stat(selected);
    if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes.length!==after.size)
      fail('executable changed while fingerprinting');
    executables.push({path:selected,sha256:hash(bytes),mode:after.mode&0o777});
  }
  return {format:'stnl-same-operation-context-v1',platform:process.platform,architecture:process.arch,
    invocation:{outputFile:path.resolve(outputFile),binding:structuredClone(invocationBinding)},
    invocationSha256:hash(canonical({outputFile:path.resolve(outputFile),binding:invocationBinding})),
    environmentSha256:hash(JSON.stringify(Object.fromEntries(Object.entries(env).sort(([a],[b])=>a<b?-1:a>b?1:0)))),executables};
}

export function assertRunnerVerification(observation, verification) {
  if (!observation || !['stnl-runner-verification-v1','stnl-runner-execution-v2'].includes(observation.format) || observation.status !== 'completed'
    || !equal(observation.verification, verification) || !Array.isArray(observation.checks)
    || observation.checks.length !== verification.checks.length) fail('receipt recipe binding differs or did not conclude');
  for (const [index, check] of observation.checks.entries()) {
    if (!equal(check.request, verification.checks[index]) || check.command !== verificationCommand(check.request)
      || !Number.isSafeInteger(check.exit) || check.stdoutSha256 !== hash(check.stdout)
      || check.stderrSha256 !== hash(check.stderr)) fail('receipt observed command differs from recipe');
  }
  return observation.checks.map(({command,exit}) => ({command,exit}));
}

// A pending/uncertain saved observation is never rerun. Completed observations
// are reusable only for the exact recipe, inside the same runner-origin directory.
export async function executeRunnerVerification({ verification, outputFile, observeState = null, startGuard = action => action(), captureChangedState = null, invocationBinding = null }) {
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  // Host tool-call identity changes between verify and draft-validation calls.
  // It is transport metadata, not a recipe input: exclude it from BOTH the
  // child environment and its fingerprint; all functional inputs remain bound.
  delete env.CODEX_TOOL_CALL_ID;
  const existing = await fs.lstat(outputFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    const observation = parseStrictJson((await readOwnedFile(outputFile)).bytes.toString('utf8'));
    assertRunnerVerification(observation, verification);
    // Existing v1 retains its original same-operation behavior, without a
    // retroactive fingerprint or a claim of context-bound replay.
    if(observation.format==='stnl-runner-execution-v2'&&!equal(observation.executionContext,await executionContext(verification,env,outputFile,invocationBinding)))
      fail('completed recipe context is stale; preserve it without another execution');
    if (observeState && observation.workStateSha256 !== hash(JSON.stringify(await observeState()))) fail('completed recipe observation is stale; never replay it');
    return observation;
  }
  const contextBefore=await executionContext(verification,env,outputFile,invocationBinding);
  const observation=await startGuard(async()=>{
    const workStateBefore=captureChangedState?await captureChangedState():null;
    const workStateSha256 = observeState ? hash(JSON.stringify(await observeState())) : null;
    const started = { format:'stnl-runner-execution-v2', status:'started', verification, workStateSha256, executionContext:contextBefore, checks:[],
      ...(captureChangedState?{workStateBefore}:{}) };
    const handle = await fs.open(outputFile, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(started)+'\n'); await handle.sync(); } finally { await handle.close(); }
    await syncLockParent(path.dirname(outputFile));
    return started;
  });
  const workStateSha256=observation.workStateSha256;
  for (const request of verification.checks) {
    const result = await new Promise((resolve,reject) => execFile(request.executable, request.args,
      {cwd:request.cwd,env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024}, (error,stdout,stderr) => {
        if (error && !Number.isSafeInteger(error.code)) { reject(error); return; }
        resolve({exit:error?.code ?? 0,stdout,stderr});
      }));
    observation.checks.push({request,command:verificationCommand(request),...result,
      stdoutSha256:hash(result.stdout),stderrSha256:hash(result.stderr)});
  }
  if(!equal(await executionContext(verification,env,outputFile,invocationBinding),contextBefore)) {
    observation.status='context-changed';await persistAllocation(outputFile,observation);
    fail('executable context changed during verification; preserve observation without replay');
  }
  const workStateAfter=observeState?await observeState():null;
  if (observeState && workStateSha256 !== hash(JSON.stringify(workStateAfter))) {
    observation.status = 'inputs-changed';
    if(captureChangedState)observation.workStateAfter=await captureChangedState();
    await persistAllocation(outputFile, observation);
    fail('product/verification inputs changed while the recipe ran; preserve pending observation');
  }
  observation.status = 'completed';
  if(captureChangedState)delete observation.workStateBefore;
  await persistAllocation(outputFile, observation);
  assertRunnerVerification(observation, verification); return observation;
}
