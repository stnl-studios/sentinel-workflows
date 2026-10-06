import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readManagedSliceContext } from '../../../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';
import { inspectExecutionState } from '../../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { captureRunnerTestedState } from '../../../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { inspectManagedApplyCandidate, captureManagedTree, readManagedRegular } from './managed-slice-finalize.mjs';
import { assertManagedSliceFreshness } from './managed-slice-preflight.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const section = (text, name) => text.match(new RegExp(`(?:^|\\n)## ${name}\\n\\n([\\s\\S]*?)(?=\\n## |$)`, 'u'))?.[1]?.trim();
export const findingsEvidenceFingerprint = text => hash(section(text, 'Findings Test Evidence'));
export const findingsOwnershipFingerprint = ownership => hash(JSON.stringify(ownership));
function fail(message) { throw Object.assign(new Error(message), { code: 'MANAGED_FINDINGS_BINDING_INVALID' }); }

// Ownership is derived before dispatch from the current formal validation state.
// Principal descriptions and the runner's legacy field are never parsed for IDs.
export function deriveManagedFindingsOwnership({ context, binding, selected, request, fingerprint,
  candidateText, liveText, candidateTreeSha256, sourceTestsSha256, testedStateSha256, prior }) {
  const attempt = selected?.attempts.at(-1);
  const activeFindings = selected?.findings.filter(finding => finding.state === 'active').map(finding => finding.id).sort();
  const automaticCheckRound = request.managedPayload?.automaticCheckRound;
  if (context.operation !== 'APPLY_FINDINGS' || attempt?.status !== 'NEEDS_FIX'
    || !/^attempt-[0-9]{2,}$/.test(attempt.id) || !activeFindings?.length
    || !['1/3', '2/3', '3/3'].includes(automaticCheckRound)
    || binding.operation !== context.operation || binding.slice !== context.slice || binding.authority !== context.authority
    || request.operation !== context.operation || request.slice !== context.slice || request.sequence !== binding.sequence
    || request.workspace !== context.workspace || binding.sourceTaskSha256 !== hash(liveText)) {
    fail('managed findings ownership identity or active cycle disagrees');
  }
  for (const name of ['Validation Attempts', 'Validation Findings']) {
    if (section(candidateText, name) !== section(liveText, name)) fail('managed findings candidate changed validation authority/history');
  }
  const round = Number(automaticCheckRound.slice(0, 1));
  if (round > 1) {
    const previous = prior?.findingsCycleBinding;
    if (prior?.state !== 'PRIVATE_TESTS_FAIL' || prior.operation !== context.operation
      || prior.slice !== context.slice || prior.sequence !== binding.sequence || prior.authority !== context.authority
      || previous?.canonicalCycle !== attempt.id || !same(previous.activeFindings, activeFindings)
      || Number(previous.automaticCheckRound?.slice(0, 1)) + 1 !== round
      || previous.findingsEvidenceSha256 !== findingsEvidenceFingerprint(candidateText)) {
      fail('managed findings prior private history or round ownership changed');
    }
  }
  return { operation: context.operation, slice: context.slice, sequence: binding.sequence, authority: context.authority,
    fingerprint, canonicalCycle: attempt.id, activeFindings, automaticCheckRound,
    candidateNonce: binding.nonce, candidateTaskArtifact: binding.candidateTaskArtifact,
    sourceTaskSha256: binding.sourceTaskSha256, candidateInputSha256: hash(candidateText),
    candidateTreeSha256, sourceTestsSha256, testedStateSha256 };
}

export async function prepareManagedFindingsRequest({ request, environment = process.env }) {
  const context = readManagedSliceContext(environment);
  if (context?.operation !== 'APPLY_FINDINGS') return null;
  await assertManagedSliceFreshness(environment);
  const tmpdir = await fs.realpath(environment.TMPDIR);
  const directory = path.join(tmpdir, 'stnl-runner-broker');
  const active = JSON.parse(await readManagedRegular(path.join(directory, 'active.json')));
  if (request.sequence !== active.sequence || request.tmpdir !== tmpdir
    || active.officialPreflight.authority !== context.authority) fail('managed findings request disagrees with active preflight');
  const { binding, liveTask } = await inspectManagedApplyCandidate({ context, active, tmpdir });
  const state = await inspectExecutionState(context.specPath);
  const candidateText = (await readManagedRegular(binding.candidateTaskArtifact)).toString('utf8');
  const liveText = (await readManagedRegular(liveTask)).toString('utf8');
  const tested = await captureRunnerTestedState({ workspace: context.workspace,
    taskArtifact: binding.candidateTaskArtifact, changedAreas: request.managedPayload.changedAreas });
  const sourceTestsSha256 = await captureManagedSourceTestsHash(context.workspace);
  const priorFile = path.join(directory, String(active.sequence).padStart(3, '0') + '.finalization.json');
  const prior = await readManagedRegular(priorFile).then(bytes => JSON.parse(bytes)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (prior?.state === 'PRIVATE_TESTS_FAIL') {
    for (const [file, expected] of Object.entries(prior.evidenceSha256)) {
      if (hash(await readManagedRegular(file)) !== expected) fail('managed prior findings captured evidence changed');
    }
  }
  return deriveManagedFindingsOwnership({ context, binding, selected: state.tasks.get(context.slice), request,
    fingerprint: state.currentFingerprint, candidateText, liveText, prior,
    candidateTreeSha256: hash(JSON.stringify(await captureManagedTree(binding.candidateExecutionRoot))),
    sourceTestsSha256, testedStateSha256: hash(JSON.stringify(tested.entries)) });
}

export function assertManagedFindingsOwnership(current, sealed) {
  if (!same(current, sealed)) fail('managed sealed findings ownership, candidate or source/tests changed');
}

export function bindManagedFindingsCycle({ context, binding, selected, sealed, receipt, response,
  candidateText, liveText, fingerprint, prior }) {
  const ownership = sealed.findingsOwnership;
  const expected = deriveManagedFindingsOwnership({ context, binding, selected, request: sealed,
    candidateText, liveText, fingerprint, prior, candidateTreeSha256: ownership?.candidateTreeSha256,
    sourceTestsSha256: ownership?.sourceTestsSha256, testedStateSha256: ownership?.testedStateSha256 });
  assertManagedFindingsOwnership(expected, ownership);
  if (receipt.sequence !== binding.sequence || receipt.slice !== context.slice || receipt.authority !== context.authority
    || receipt.findingsOwnershipSha256 !== findingsOwnershipFingerprint(ownership)
    || receipt.automaticCheckRound !== ownership.automaticCheckRound) fail('managed findings receipt or round differs from sealed ownership');
  return { ...ownership, requestId: sealed.requestId, receiptFile: receipt.receiptFile,
    responseSha256: receipt.semanticResponseSha256, method: 'sealed-state-ownership' };
}

export async function captureManagedSourceTestsHash(workspace) {
  const sourceTests = {};
  for (const name of ['src', 'test']) {
    const directory = path.join(workspace, name);
    const present = await fs.lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    sourceTests[name] = present === null ? null : await captureManagedTree(directory);
  }
  return hash(JSON.stringify(sourceTests));
}
