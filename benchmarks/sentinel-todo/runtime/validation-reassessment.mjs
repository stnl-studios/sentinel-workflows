// Owner-authorized bounded reassessment, not a detector of an incorrect verdict.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const OPERATION = 'VALIDATE_SLICE';
export const REASSESSMENT_POLICY = 'OWNER_AUTHORIZED_VALIDATION_REASSESSMENT';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function regular(file) {
  const metadata = await fs.lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error('reassessment evidence must be a regular owned file: ' + file);
  return fs.readFile(file);
}
const read = async file => JSON.parse(await regular(file));

// Include additions/removals and seed checks as well as the prepared slice scope.
// These are the benchmark's source/test roots, not new implementation authority.
export async function captureValidationInputs({ product, workspace, taskArtifact }) {
  const files = [];
  async function tree(relative) {
    const file = path.join(workspace, relative);
    const metadata = await fs.lstat(file);
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      files.push({ path: relative, mode: metadata.mode & 0o777, directory: true });
      for (const name of (await fs.readdir(file)).sort()) await tree(path.join(relative, name));
    } else files.push({ path: relative, mode: metadata.mode & 0o777, sha256: hash(await regular(file)) });
  }
  for (const root of ['src', 'test']) await tree(root);
  const testedState = await product.captureRunnerTestedState({ workspace, taskArtifact });
  return { testedState, sourceTestsSha256: hash(JSON.stringify(files)) };
}

// Called while the original broker context is still active so the existing
// receipt guard proves identity, exact final bytes, conclusion and authority.
export async function captureReassessmentEvidence({ product, context, environment, directory, sequence, inputs }) {
  const stem = String(sequence).padStart(3, '0');
  try {
    const latest = await read(path.join(directory, stem + '.latest.json'));
    const receipt = latest.receipt;
    if (receipt?.status !== 'RUNNER_RESPONSE_CAPTURED' || receipt.semanticResponseStatus !== 'BLOCKED') return null;
    await product.assertManagedRunnerReceipt({ operation: OPERATION, slice: context.slice, workspace: context.workspace,
      receiptFile: receipt.receiptFile, semanticResponseFile: receipt.semanticResponseFile, environment });
    if (!same(receipt, await read(receipt.receiptFile))) throw new Error('settled receipt changed');
    const finalizationFile = path.join(directory, stem + '.finalization.json');
    const finalized = await read(finalizationFile);
    const commands = await product.resolveRunnerCommandEvents({ receiptFile: receipt.receiptFile,
      semanticResponseFile: receipt.semanticResponseFile, operation: OPERATION });
    const events = (await regular(receipt.eventsPath)).toString('utf8').split('\n').filter(Boolean).map(JSON.parse);
    const commandEvents = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution');
    const commandStarts = events.filter(event => event.type === 'item.started' && event.item?.type === 'command_execution');
    if (commandStarts.length !== commandEvents.length
      || commandEvents.some(event => event.item.status !== 'completed' || event.item.exit_code !== 0)) return null;
    if (commands.length === 0 || commands.some(command => command.exit !== 0)
      || finalized.published !== true || finalized.state !== 'VALIDATION_BLOCKED'
      || finalized.operation !== OPERATION || finalized.sequence !== sequence || finalized.slice !== context.slice
      || finalized.workspace !== context.workspace || finalized.authority !== context.authority
      || finalized.receiptFile !== receipt.receiptFile) return null;
    const taskArtifact = inputs.testedState.sourceTaskPath;
    const index = path.join(path.dirname(path.dirname(taskArtifact)), 'tasks.md');
    if (hash(await regular(taskArtifact)) !== finalized.taskSha256 || hash(await regular(index)) !== finalized.indexSha256
      || !same(await captureValidationInputs({ product, workspace: context.workspace, taskArtifact }), inputs)
      || !same(finalized.testedState?.entries, inputs.testedState.entries)) return null;
    const files = [receipt.receiptFile, receipt.semanticResponseFile, receipt.eventsPath,
      receipt.receiptFile.replace(/\.receipt\.json$/u, '.started.json')];
    if (!same(Object.keys(finalized.evidenceSha256 ?? {}).sort(), [...files].sort())) return null;
    const evidenceSha256 = {};
    for (const file of files) {
      evidenceSha256[file] = hash(await regular(file));
      if (evidenceSha256[file] !== finalized.evidenceSha256[file]) return null;
    }
    evidenceSha256[finalizationFile] = hash(await regular(finalizationFile));
    evidenceSha256[path.join(directory, stem + '.latest.json')] = hash(await regular(path.join(directory, stem + '.latest.json')));
    evidenceSha256[taskArtifact] = finalized.taskSha256;
    evidenceSha256[index] = finalized.indexSha256;
    return { receiptFile: receipt.receiptFile, responseSha256: receipt.semanticResponseSha256,
      sequence, authority: context.authority, inputs, commands, evidenceSha256 };
  } catch (error) {
    // Ineligible/uncertain evidence never authorizes another provider call.
    return { rejected: true, diagnostic: `${error.code ?? error.name}: ${error.message}` };
  }
}

export function eligibleValidationReassessment({ operation, slice, outcome, execution, proof, transportFailed,
  remainingTurns, budgetExceeded, caseActive, alreadyUsed }) {
  if (operation !== OPERATION || !/^slice-[0-9]{2,}$/u.test(slice ?? '') || caseActive !== true || alreadyUsed
    || outcome.result !== 'BLOCKED' || outcome.blocker !== 'OFFICIAL_VALIDATION_BLOCKED'
    || transportFailed || budgetExceeded || !Number.isSafeInteger(remainingTurns) || remainingTurns < 2
    || proof == null || proof.rejected || execution?.error || execution?.state !== 'VALIDATION_BLOCKED'
    || `sha256:${execution.currentFingerprint}` !== proof.authority
    || !execution.validationBlocked?.includes(slice)
    || !execution.legalOperations?.some(target => target.operation === OPERATION && target.slice === slice)
    || execution.mandatoryRecovery || execution.requiredRecoveryHandoff) return false;
  const latest = execution.tasks?.get(slice)?.attempts?.at(-1);
  // The canonical producer prepends its validated official preflight command.
  return latest?.status === 'BLOCKED' && latest.commands.length === proof.commands.length + 1
    && latest.commands.every(command => command.exit === 0) && same(latest.commands.slice(1), proof.commands);
}

export async function assertReassessmentUnchanged({ product, specPath, decision, execution }) {
  if (decision.claimFile) {
    const { claimFile, ...claimed } = decision;
    if (!same(await read(claimFile), claimed)) throw new Error('reassessment decision changed');
  }
  const proof = decision.proof;
  const current = execution ?? await product.preflightExecutionOperation(specPath, OPERATION, BigInt(decision.slice.slice(6)).toString(10));
  if (current.state !== 'VALIDATION_BLOCKED' || `sha256:${current.currentFingerprint}` !== proof.authority
    || !current.validationBlocked?.includes(decision.slice)
    || !current.legalOperations?.some(target => target.operation === OPERATION && target.slice === decision.slice)
    || current.mandatoryRecovery || current.requiredRecoveryHandoff
    || current.tasks?.get(decision.slice)?.attempts?.at(-1)?.id !== decision.originalAttempt
    || !same(await captureValidationInputs({ product, workspace: decision.workspace,
      taskArtifact: proof.inputs.testedState.sourceTaskPath }), proof.inputs)) throw new Error('reassessment authority or source/tests changed');
  for (const [file, expected] of Object.entries(proof.evidenceSha256)) {
    if (hash(await regular(file)) !== expected) throw new Error('reassessment original evidence changed: ' + file);
  }
  return current;
}

// This immutable claim is also the crash barrier. EEXIST includes an empty or
// partially written claim; no interrupted persistence releases another chance.
export async function claimValidationReassessment(caseRoot, decision) {
  if (!/^slice-[0-9]{2,}$/u.test(decision.slice ?? '')) throw new Error('reassessment claim requires a canonical slice');
  const claimFile = path.join(caseRoot, `validation-reassessment-${decision.slice}.json`);
  let handle;
  try { handle = await fs.open(claimFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  try { await handle.writeFile(JSON.stringify(decision) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  return { ...decision, claimFile };
}

export async function prepareValidationReassessment({ product, specPath, caseRoot, runId, caseId, workspace,
  input, readback, originalEvidencePath }) {
  if (!eligibleValidationReassessment(input)) return null;
  const fresh = await readback();
  if (fresh.lifecycle?.error || !eligibleValidationReassessment({ ...input, execution: fresh.executionRaw })) return null;
  const proof = { ...input.proof, evidenceSha256: { ...input.proof.evidenceSha256,
    [originalEvidencePath]: hash(await regular(originalEvidencePath)) } };
  const decision = { policy: REASSESSMENT_POLICY, runId, caseId, operation: OPERATION, slice: input.slice, workspace,
    originalAttempt: fresh.executionRaw.tasks.get(input.slice).attempts.at(-1).id, originalEvidencePath, proof };
  decision.id = hash(JSON.stringify(decision));
  await assertReassessmentUnchanged({ product, specPath, decision });
  return claimValidationReassessment(caseRoot, decision);
}
