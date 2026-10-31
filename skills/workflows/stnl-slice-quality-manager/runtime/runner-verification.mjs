// Producer-owned observation of the reviewed direct-exec recipe. No shell parser.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readOwnedFile, parseStrictJson, persistAllocation, syncLockParent } from './execution-publication.mjs';

const equal = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const fail = message => { throw new Error(`runner verification: ${message}`); };
const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const quote = value => /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";
export const verificationCommand = check => [check.executable, ...check.args].map(quote).join(' ');

export function assertRunnerVerification(observation, verification) {
  if (!observation || observation.format !== 'stnl-runner-verification-v1' || observation.status !== 'completed'
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
export async function executeRunnerVerification({ verification, outputFile, observeState = null, startGuard = action => action(), captureChangedState = null }) {
  const existing = await fs.lstat(outputFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing) {
    const observation = parseStrictJson((await readOwnedFile(outputFile)).bytes.toString('utf8'));
    assertRunnerVerification(observation, verification);
    if (observeState && observation.workStateSha256 !== hash(JSON.stringify(await observeState()))) fail('completed recipe observation is stale; never replay it');
    return observation;
  }
  const observation=await startGuard(async()=>{
    const workStateBefore=captureChangedState?await captureChangedState():null;
    const workStateSha256 = observeState ? hash(JSON.stringify(await observeState())) : null;
    const started = { format:'stnl-runner-verification-v1', status:'started', verification, workStateSha256, checks:[],
      ...(captureChangedState?{workStateBefore}:{}) };
    const handle = await fs.open(outputFile, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(started)+'\n'); await handle.sync(); } finally { await handle.close(); }
    await syncLockParent(path.dirname(outputFile));
    return started;
  });
  const workStateSha256=observation.workStateSha256;
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  for (const request of verification.checks) {
    const result = await new Promise((resolve,reject) => execFile(request.executable, request.args,
      {cwd:request.cwd,env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024}, (error,stdout,stderr) => {
        if (error && !Number.isSafeInteger(error.code)) { reject(error); return; }
        resolve({exit:error?.code ?? 0,stdout,stderr});
      }));
    observation.checks.push({request,command:verificationCommand(request),...result,
      stdoutSha256:hash(result.stdout),stderrSha256:hash(result.stderr)});
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
