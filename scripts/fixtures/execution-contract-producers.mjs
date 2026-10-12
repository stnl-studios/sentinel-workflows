import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { native, capture } from '../test-p1b-continuity.mjs';
import { inspectExecutionState, readExecutionActivation, validateExecutionCandidate } from '../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { prepareExecutionCopy, publishExecutionCopy } from '../../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import { serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate } from '../../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { prepareValidationCopy } from '../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import { prepareValidationCandidate } from '../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import { publishValidationCandidate } from '../../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import { verificationCommand } from '../../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';
import { startNativeRunnerCapture, bindNativeRunnerIdentity } from '../../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';

const runtime = new URL('../../skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs', import.meta.url);
const section = (text, heading, body) => {
  const pattern = new RegExp(`(## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, 'u');
  assert.match(text, pattern);
  return text.replace(pattern, `$1${body}\n`);
};
const context = f => ({ specPath: f.requirements, root: f.root });
const claim = (f, slice) => path.relative(path.join(f.execution, 'tasks'), path.join(f.root, 'src/example.txt')).split(path.sep).join('/');
const retain = (f, resource) => { f.test?.after(() => fs.rm(resource, { recursive: true, force: true })); return resource; };

// The CLI owns the owner-file allocation. Every operation starts from the
// actual activation; these helpers never reconstruct an owner or receipt.
export async function beginExample(f, operation, slice = 'slice-01') {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.STNL_OPERATION_OWNER_FILE;
  const started = spawnSync(process.execPath, [runtime.pathname, f.requirements, '--begin', operation, BigInt(slice.slice(6)).toString()], { env, encoding: 'utf8' });
  assert.equal(started.status, 0, started.stderr);
  const admission = JSON.parse(started.stdout);
  retain(f, admission.ownerFile);
  assert.deepEqual((await readExecutionActivation(f.requirements)).activation.activeAttempt.operationAttemptId, admission.owner.operationAttemptId);
  return admission;
}

export async function withExampleOwner(admission, action) {
  const previous = process.env.STNL_OPERATION_OWNER_FILE;
  process.env.STNL_OPERATION_OWNER_FILE = admission.ownerFile;
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.STNL_OPERATION_OWNER_FILE; else process.env.STNL_OPERATION_OWNER_FILE = previous; }
}

// Failure controls are ordinary typed product files admitted by the same
// reviewed recipe as every other check. Their exits are observed by the native
// producer, never transcribed into receipt or SDK-event lookalikes.
export async function exampleHistoryRecipe(f, count) {
  await fs.mkdir(path.join(f.root, 'src'), { recursive: true });
  const state = path.join(f.root, 'src/history-state.json');
  await fs.writeFile(state, JSON.stringify(Array(count).fill(true)));
  const checks = [];
  for (let index = 0; index < count; index++) {
    const name = `src/history-${index + 1}.mjs`;
    await fs.writeFile(path.join(f.root, name), `import assert from 'node:assert/strict';import fs from 'node:fs';assert.equal(JSON.parse(fs.readFileSync('src/history-state.json','utf8'))[${index}],true,'prepared history check ${index + 1}');\n`);
    checks.push({ id: `verification-${String(index + 1).padStart(2, '0')}`, executable: { literal: 'node' }, args: [{ file: { kind: 'product', path: name } }], inputs: [{ kind: 'product', path: 'src/history-state.json' }] });
  }
  f.verificationRecipe = '- Recipe: ' + JSON.stringify({ format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.', checks,
    dependencyReview: 'Each prepared assertion reads the explicitly typed product history-state.json; source and control files are contained in the authorized src directory.' });
  return { set: exits => fs.writeFile(state, JSON.stringify(exits.map(exit => exit === 0))) };
}

export async function captureExample(f, operation, response, { admission = null, slice = 'slice-01' } = {}) {
  const admitted = admission ?? await beginExample(f, operation, slice);
  const start = await native(context(f), admitted.owner);
  const captured = await capture(start, response, operation === 'VALIDATE_SLICE' ? null : [claim(f, slice)]);
  return { ...captured, admission: admitted, start };
}

export async function implementExample(f, { slice = 'slice-01', publish = true, failFirst = false, filelessReason = null } = {}) {
  assert.ok(!failFirst || !publish, 'an intermediate failure stays private');
  const admission = await beginExample(f, 'EXECUTE_SLICE', slice);
  const start = await native(context(f), admission.owner);
  const copy = await prepareExecutionCopy({ specPath: f.requirements, slice, owner: admission.owner });
  retain(f, copy.candidateRoot);
  const changed = filelessReason === null ? [claim(f, slice)] : [];
  if (failFirst) await fs.writeFile(path.join(f.root, 'src/example.txt'), 'wrong example bytes\n');
  let task = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  task = task.replace(`- [ ] ${BigInt(slice.slice(6))}.1`, `- [x] ${BigInt(slice.slice(6))}.1`);
  task = section(task, 'Changed Areas', changed.map(p => '- `' + p + '`').join('\n') || '- none');
  task = section(task, 'Diff Summary', '- Implemented the approved example bytes and exercised their prepared assertion.');
  await fs.writeFile(copy.candidateTaskArtifact, task);
  const command = verificationCommand(start.verification.checks[0]);
  const response = { status: failFirst ? 'TESTS_FAIL' : 'TESTS_PASS', automaticCheckRound: '1/3', head: 'offline-example',
    discoverySources: 'Reviewed example byte assertion', discoveryActions: 'Inspected its file read and exact expected bytes',
    verificationTypesConsidered: 'Prepared Node assertion', nonApplicabilityRationale: 'none', noVerificationCommandConfirmation: 'none',
    commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: failFirst ? 1 : 0 })), resultOfEachCommandAndExitCode: `Prepared byte assertion exit ${failFirst ? 1 : 0}`, selectedChecks: command,
    selectionRationale: 'Observe AC-001 exact bytes', coverage: 'AC-001 example bytes', failures: failFirst ? 'Prepared byte assertion failed on wrong bytes' : 'none', priorRoundFailure: 'none',
    correctionApplied: 'none', inSliceRationale: 'none', evidenceOrFailureSummary: failFirst ? 'Real reviewed Node assertion failed on wrong bytes' : 'Real reviewed Node assertion passed',
    affectedFilesOrBehaviors: 'src/example.txt', blockers: 'none', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'Preserve observed example result' };
  if (filelessReason !== null) response.filelessReason = filelessReason;
  const captured = await capture(start, response, changed);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', response: JSON.stringify(response), workspace: f.root, taskArtifact: copy.candidateTaskArtifact, ...captured });
  await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation: 'EXECUTE_SLICE', bundle,
    validateProspectiveTask: text => validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot, [text], failFirst ? { privateAutomaticCheck: { operation: 'EXECUTE_SLICE', slice, round: 1 } } : {}) });
  if (!failFirst) assert.equal((await validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot)).state, 'IMPLEMENTED_AWAITING_VALIDATION');
  if (publish) {
    await publishExecutionCopy({ specPath: f.requirements, slice, candidateRoot: copy.candidateRoot });
    assert.equal((await inspectExecutionState(f.requirements)).tasks.get(slice).implementationChecks.at(-1).status, 'TESTS_PASS');
    assert.equal((await readExecutionActivation(f.requirements)).activation.activeAttempt, null);
  }
  return { admission, copy, start, response, captured, bundle };
}

export async function retryExample(f, first, content, { status = 'TESTS_PASS', publish = true } = {}) {
  const round = Number(first.response.automaticCheckRound[0]) + 1;
  assert.ok(round <= 3);
  assert.ok(!publish || status !== 'TESTS_FAIL' || round === 3);
  const slice = first.admission.owner.slice;
  assert.equal(first.response.status, 'TESTS_FAIL');
  const started = await startNativeRunnerCapture({ ...context(f), owner: first.admission.owner, workspace: f.root, captureParent: f.root, candidateTaskArtifact: first.copy.candidateTaskArtifact });
  const agentId = 'example-corrected-' + randomUUID(); await bindNativeRunnerIdentity({ ...started, agentId });
  const start = { ...started, agentId };
  const previousBytes = await fs.readFile(path.join(f.root, 'src/example.txt'));
  if (content !== undefined) {
    await fs.writeFile(path.join(f.root, 'src/example.txt'), content);
    assert.notDeepEqual(await fs.readFile(path.join(f.root, 'src/example.txt')), previousBytes, 'the correction changes actual authorized bytes');
  }
  const taskFile = first.copy.candidateTaskArtifact;
  await fs.writeFile(taskFile, section(await fs.readFile(taskFile, 'utf8'), 'Corrections Applied', '- `' + claim(f, slice) + '`'));
  const response = { ...first.response, status, automaticCheckRound: `${round}/3`, commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: status === 'TESTS_PASS' ? 0 : 1 })),
    resultOfEachCommandAndExitCode: `Unchanged prepared byte assertion exit ${status === 'TESTS_PASS' ? 0 : 1}`, failures: status === 'TESTS_PASS' ? 'none' : `Prepared byte assertion still failed at round ${round}`, priorRoundFailure: first.response.failures,
    correctionApplied: content === undefined ? 'Rechecked the verification environment; cumulative corrected product paths remain unchanged' : 'Attempted a bounded example byte correction', inSliceRationale: 'Same AC-001 result and authorized example file', evidenceOrFailureSummary: `Real unchanged assertion observed ${status}` };
  const captured = await capture(start, response, [claim(f, slice)]);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'EXECUTE_SLICE', response: JSON.stringify(response), workspace: f.root, taskArtifact: taskFile, ...captured });
  await insertExecutionEvidenceInCandidate({ taskArtifact: taskFile, operation: 'EXECUTE_SLICE', bundle,
    validateProspectiveTask: text => validateExecutionCandidate(f.requirements, first.copy.candidateExecutionRoot, [text], status === 'TESTS_FAIL' && round < 3 ? { privateAutomaticCheck: { operation: 'EXECUTE_SLICE', slice, round } } : {}) });
  assert.ok((await fs.readFile(taskFile, 'utf8')).includes(first.bundle), 'the real failed round stays byte-identical');
  if (publish) {
    await publishExecutionCopy({ specPath: f.requirements, slice, candidateRoot: first.copy.candidateRoot });
    const checks = (await inspectExecutionState(f.requirements)).tasks.get(slice).implementationChecks;
    assert.equal(checks.length, round); assert.equal(checks.at(-1).status, status);
  }
  return { admission: first.admission, copy: first.copy, start, response, captured, bundle };
}

export async function validateExample(f, { slice = 'slice-01', status = 'PASS', findings = null, publish = true, dispositions = null, explanation = null } = {}) {
  const admission = await beginExample(f, 'VALIDATE_SLICE', slice);
  return withExampleOwner(admission, async () => {
    const start = await native(context(f), admission.owner);
    const parent = retain(f, path.join(f.root, 'formal-' + randomUUID())); await fs.mkdir(parent);
    const copy = await prepareValidationCopy({ specPath: f.requirements, slice, candidateParent: parent, owner: admission.owner });
    const refs = findings ? [...findings.matchAll(/^### (finding-\d+)$/gmu)].map(m => m[1]) : [];
    if (findings) {
      const file = path.join(copy.candidateExecutionRoot, 'tasks', slice + '.md');
      await fs.writeFile(file, section(await fs.readFile(file, 'utf8'), 'Validation Findings', findings));
    }
    const response = { status, head: 'offline-example', commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: 0 })),
      evidence: explanation ?? 'Real prepared byte assertion passed; the independent semantic judgment is simulated for this workflow fixture.',
      findingReferences: refs.join(', ') || 'none', findingDispositions: dispositions ?? (refs.map(id => id + '=active').join(', ') || 'none'),
      blockers: status === 'BLOCKED' ? 'Controlled unavailable semantic prerequisite' : 'none', unexpectedWorkspaceEffects: explanation ?? 'none', persistenceSummary: 'Preserve concluded formal result' };
    const captured = await capture(start, response);
    const prepared = await prepareValidationCandidate({ specPath: f.requirements, slice, workspace: f.root, candidateExecutionRoot: copy.candidateExecutionRoot, ...captured });
    assert.equal(prepared.formalStatus, status, JSON.stringify(prepared));
    if (publish) {
      await publishValidationCandidate({ specPath: f.requirements, slice, candidateExecutionRoot: copy.candidateExecutionRoot, owner: admission.owner });
      assert.equal((await inspectExecutionState(f.requirements)).tasks.get(slice).attempts.at(-1).status, status);
      assert.equal((await readExecutionActivation(f.requirements)).activation.activeAttempt, null);
    }
    return { admission, copy, start, response, captured, prepared };
  });
}

export async function correctExample(f, { slice = 'slice-01', content, filelessReason = null, verified = 'finding-01', unsupported = 'none', fail = false, publish = true, explanation = null } = {}) {
  const admission = await beginExample(f, 'APPLY_FINDINGS', slice);
  const start = await native(context(f), admission.owner);
  const copy = await prepareExecutionCopy({ specPath: f.requirements, slice, owner: admission.owner });
  retain(f, copy.candidateRoot);
  const changed = filelessReason === null ? [claim(f, slice)] : [];
  if (content !== undefined) await fs.writeFile(path.join(f.root, 'src/example.txt'), content);
  let text = await fs.readFile(copy.candidateTaskArtifact, 'utf8');
  text = section(text, 'Corrections Applied', changed.map(p => '- `' + p + '`').join('\n') || '- none'); await fs.writeFile(copy.candidateTaskArtifact, text);
  const cycle = (await inspectExecutionState(f.requirements)).tasks.get(slice).attempts.at(-1).id;
  const response = { ...f.exampleImplementation.response, findingsCycle: cycle, findingsVerified: verified,
    correctionsCovered: explanation ?? (filelessReason === null ? 'Corrected the actual approved example file and reran its unchanged byte assertion' : 'Reconciled the accepted observation without changing repository files and reran the existing assertion'), regressionsSelected: explanation ?? 'Prepared exact byte assertion', unsupportedActiveFindings: unsupported };
  for (const key of ['priorRoundFailure', 'correctionApplied', 'inSliceRationale']) delete response[key];
  response.status = fail ? 'TESTS_FAIL' : 'TESTS_PASS';
  response.failures = fail ? 'The unchanged prepared assertion failed after the attempted correction' : 'none';
  response.resultOfEachCommandAndExitCode = `Prepared assertion exit ${fail ? 1 : 0}`;
  response.evidenceOrFailureSummary = explanation ?? `Real unchanged assertion observed ${response.status}`;
  response.commands = start.verification.checks.map(check => ({ command: verificationCommand(check), exit: fail ? 1 : 0 }));
  if (filelessReason !== null) response.filelessReason = filelessReason;
  const captured = await capture(start, response, changed);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'APPLY_FINDINGS', response: JSON.stringify(response), workspace: f.root, taskArtifact: copy.candidateTaskArtifact, ...captured });
  await insertExecutionEvidenceInCandidate({ taskArtifact: copy.candidateTaskArtifact, operation: 'APPLY_FINDINGS', bundle,
    validateProspectiveTask: text => validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot, [text], fail ? { privateAutomaticCheck: { operation: 'APPLY_FINDINGS', slice, round: 1 } } : {}) });
  if (publish) {
    assert.ok(!fail, 'an intermediate failure stays private');
    assert.equal((await validateExecutionCandidate(f.requirements, copy.candidateExecutionRoot)).state, 'FINDINGS_CORRECTED');
    await publishExecutionCopy({ specPath: f.requirements, slice, candidateRoot: copy.candidateRoot });
    assert.equal((await inspectExecutionState(f.requirements)).state, 'FINDINGS_CORRECTED');
  }
  return { admission, copy, start, response, captured, bundle };
}

export async function retryFindingsExample(f, first, { content, fail = false, publish = true } = {}) {
  const slice = first.admission.owner.slice;
  const round = Number(first.response.automaticCheckRound[0]) + 1;
  assert.equal(first.response.status, 'TESTS_FAIL'); assert.ok(round <= 3);
  const started = await startNativeRunnerCapture({ ...context(f), owner: first.admission.owner, workspace: f.root, captureParent: f.root, candidateTaskArtifact: first.copy.candidateTaskArtifact });
  const agentId = 'example-findings-retry-' + randomUUID(); await bindNativeRunnerIdentity({ ...started, agentId });
  const start = { ...started, agentId };
  if (content !== undefined) await fs.writeFile(path.join(f.root, 'src/example.txt'), content);
  const fileless = Boolean(first.response.filelessReason);
  const response = { ...first.response, automaticCheckRound: `${round}/3`, status: fail ? 'TESTS_FAIL' : 'TESTS_PASS',
    failures: fail ? `The prepared assertion still fails at round ${round}` : 'none',
    resultOfEachCommandAndExitCode: `Prepared assertion exit ${fail ? 1 : 0}`,
    evidenceOrFailureSummary: `Real unchanged assertion observed ${fail ? 'TESTS_FAIL' : 'TESTS_PASS'}`,
    correctionsCovered: fileless ? 'Corrected the observation without repository writes' : 'Corrected the authorized example bytes and preserved the assertion',
    commands: start.verification.checks.map(check => ({ command: verificationCommand(check), exit: fail ? 1 : 0 })) };
  const captured = await capture(start, response, fileless ? [] : [claim(f, slice)]);
  const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: 'APPLY_FINDINGS', response: JSON.stringify(response), workspace: f.root, taskArtifact: first.copy.candidateTaskArtifact, ...captured });
  await insertExecutionEvidenceInCandidate({ taskArtifact: first.copy.candidateTaskArtifact, operation: 'APPLY_FINDINGS', bundle,
    validateProspectiveTask: text => validateExecutionCandidate(f.requirements, first.copy.candidateExecutionRoot, [text], fail && round < 3 ? { privateAutomaticCheck: { operation: 'APPLY_FINDINGS', slice, round } } : {}) });
  assert.ok((await fs.readFile(first.copy.candidateTaskArtifact, 'utf8')).includes(first.bundle));
  if (publish) await publishExecutionCopy({ specPath: f.requirements, slice, candidateRoot: first.copy.candidateRoot });
  return { admission: first.admission, copy: first.copy, start, response, captured, bundle };
}
