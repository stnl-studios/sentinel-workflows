import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { captureRunnerTestedState, validateManagedChangedAreas } from '../../../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { assertManagedSliceFreshness } from './managed-slice-preflight.mjs';
import { inspectManagedApplyCandidate, captureManagedTree, readManagedRegular } from './managed-slice-finalize.mjs';
import { assertManagedRunnerReceipt } from '../../../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const read = async file => JSON.parse(await readManagedRegular(file));
async function optional(file) {
  try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function fail(message) { throw Object.assign(new Error(message), { code: 'MANAGED_APPLY_SCOPE_BLOCKED' }); }

export function nextFinalizedPrivateRound({ round, previousRound, latest, finalized, context }) {
  const previous = latest?.receipt;
  return Number.isSafeInteger(round) && round >= 2 && round <= 3
    && previous?.semanticResponseStatus === 'TESTS_FAIL' && previous.status === 'RUNNER_RESPONSE_CAPTURED'
    && previous.authority === context.authority && finalized?.authority === context.authority
    && Number.isSafeInteger(previousRound) && round === previousRound + 1 && finalized?.state === 'PRIVATE_TESTS_FAIL'
    && finalized.receiptFile === previous.receiptFile && finalized.operation === context.operation
    && finalized.slice === context.slice;
}

async function inputs(context, active, tmpdir) {
  const { binding, official, liveTask } = await inspectManagedApplyCandidate({ context, active, tmpdir });
  const candidate = await captureRunnerTestedState({ workspace: context.workspace, taskArtifact: binding.candidateTaskArtifact });
  const claims = await validateManagedChangedAreas({ workspace: context.workspace, taskArtifact: liveTask,
    changedAreas: candidate.entries.map(entry => entry.path) });
  const liveScope = await captureRunnerTestedState({ workspace: context.workspace, taskArtifact: liveTask });
  const text = (await readManagedRegular(binding.candidateTaskArtifact)).toString('utf8');
  const correctionBody = /(?:^|\n)## Corrections Applied\n([\s\S]*?)(?=\n## |$)/u.exec(text)?.[1]?.trim();
  if (correctionBody === undefined) fail('bound APPLY candidate lacks Corrections Applied');
  const correctionAreas = correctionBody === '- none' ? [] : correctionBody.split('\n').filter(Boolean).map(line => {
    const claim = /^- `([^`\n]+)`$/u.exec(line)?.[1];
    if (!claim || !claims.includes(claim)) fail('bound APPLY correction path disagrees with canonical scope');
    return claim;
  });
  const sourceTests = {};
  for (const name of ['src', 'test']) {
    const directory = path.join(context.workspace, name);
    const present = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    sourceTests[name] = present === null ? null : await captureManagedTree(directory);
  }
  return { claims, correctionAreas, liveClaims: liveScope.entries.map(entry => entry.path), proof: { binding, candidate: await captureManagedTree(binding.candidateExecutionRoot),
    live: await captureManagedTree(official.executionRoot), testedState: candidate,
    sourceTestsSha256: hash(JSON.stringify(sourceTests)) } };
}

// The invalid request never reaches the broker. One immutable repair record
// binds its replacement to the existing candidate and fresh official authority.
export async function prepareManagedApplyScope({ context, active, tmpdir, payload, originalPrompt,
  environment, verifyFreshness = assertManagedSliceFreshness }) {
  const captured = await inputs(context, active, tmpdir);
  if (same(payload.changedAreas, captured.claims)) return payload;
  if (payload.changedAreas.length === 0 || captured.claims.length === 0
    || payload.changedAreas.some(claim => !captured.claims.includes(claim))
    || captured.claims.some(claim => !captured.liveClaims.includes(claim))) fail('APPLY scope mismatch is not a nonempty subset of unchanged official scope');
  const directory = path.join(tmpdir, 'stnl-runner-broker');
  const stem = String(active.sequence).padStart(3, '0');
  if (await optional(path.join(directory, `${stem}.latest.json`)) !== null
    || (await fs.readdir(tmpdir)).some(name => name.startsWith(`${stem}-apply_findings-${context.slice}-attempt-`) && name.endsWith('.started.json'))) {
    fail('APPLY scope cannot be repaired after runner allocation or captured receipt');
  }
  const corrected = { ...payload, changedAreas: captured.claims,
    corrections: [...(payload.corrections ?? []), `Correction paths from the bound candidate (context only): ${captured.correctionAreas.join(', ') || 'none'}`] };
  const canonicalPrompt = JSON.stringify(corrected);
  const record = { status: 'READY', operation: context.operation, slice: context.slice, sequence: active.sequence,
    failureCode: 'MANAGED_APPLY_SCOPE_MISMATCH', repairNumber: 1,
    authority: context.authority, originalPrompt, originalPromptSha256: hash(originalPrompt),
    rejectedBeforeDispatch: true, invalidRequestDispatches: 0, canonicalPromptSha256: hash(canonicalPrompt),
    canonicalChangedAreas: captured.claims, correctionAreas: captured.correctionAreas,
    originalChangedAreas: payload.changedAreas, proof: captured.proof };
  const file = path.join(directory, `${stem}.scope-repair.json`);
  const handle = await fs.open(file, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') fail('APPLY scope repair already consumed'); throw error;
  });
  try { await handle.writeFile(JSON.stringify(record, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await verifyFreshness(environment);
  if (!same((await inputs(context, active, tmpdir)).proof, captured.proof)) fail('APPLY scope repair authority, candidate or source/tests changed');
  return corrected;
}

export async function assertManagedApplyScopeFresh({ context, active, tmpdir, prompt, environment,
  verifyFreshness = assertManagedSliceFreshness }) {
  if (context?.operation !== 'APPLY_FINDINGS') return;
  const record = await optional(path.join(tmpdir, 'stnl-runner-broker', `${String(active.sequence).padStart(3, '0')}.scope-repair.json`));
  if (record === null) return;
  const round = Number(JSON.parse(prompt).automaticCheckRound?.slice(0, 1));
  const firstRound = Number(JSON.parse(record.originalPrompt).automaticCheckRound?.slice(0, 1));
  // A later correction round owns new source bytes under the existing finalized
  // TESTS_FAIL protocol. It never grants another mechanical scope repair.
  if (round > firstRound) {
    const directory = path.join(tmpdir, 'stnl-runner-broker'), stem = String(active.sequence).padStart(3, '0');
    const latest = await optional(path.join(directory, `${stem}.latest.json`));
    const finalized = await optional(path.join(directory, `${stem}.finalization.json`));
    if (!/^[0-9a-f-]{36}$/u.test(latest?.requestId ?? '')) fail('APPLY previous request identity is invalid');
    const sealed = await read(path.join(directory, `sealed-${latest.requestId}.json`));
    const previousRound = Number(sealed.managedPayload?.automaticCheckRound?.slice(0, 1));
    if (sealed.sequence !== active.sequence || sealed.operation !== context.operation || sealed.slice !== context.slice
      || sealed.workspace !== context.workspace || hash(sealed.prompt) !== latest.payloadSha256
      || !nextFinalizedPrivateRound({ round, previousRound, latest, finalized, context })
      || record.authority !== context.authority) fail('APPLY scope repair does not authorize another check round');
    await assertManagedRunnerReceipt({ operation: context.operation, slice: context.slice, workspace: context.workspace,
      receiptFile: latest.receipt.receiptFile, semanticResponseFile: latest.receipt.semanticResponseFile, environment });
    await verifyFreshness(environment);
    const current = await inputs(context, active, tmpdir);
    if (!same(JSON.parse(prompt).changedAreas, current.claims)) fail('APPLY next round scope disagrees with bound candidate');
    return;
  }
  if (record.operation !== context.operation || record.slice !== context.slice || record.sequence !== active.sequence
    || record.authority !== context.authority || record.canonicalPromptSha256 !== hash(prompt)
    || record.originalPromptSha256 !== hash(record.originalPrompt)) fail('APPLY scope repair identity disagrees');
  await verifyFreshness(environment);
  if (!same((await inputs(context, active, tmpdir)).proof, record.proof)) fail('APPLY scope repair authority, candidate or source/tests changed');
}
