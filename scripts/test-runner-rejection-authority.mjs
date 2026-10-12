import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { implementedFixture, formal, native, capture, setSection } from './test-p1b-continuity.mjs';
import { beginPreparedExecutionOperation, beginRunnerResultRecovery, readExecutionActivation, readRunnerVerification,
  inspectExecutionState } from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { captureExecutionTree } from '../skills/workflows/stnl-slice-executor/runtime/execution-publication.mjs';
import { verificationCommand } from '../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';
import { prepareValidationCopy } from '../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import { prepareValidationCandidate } from '../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import { publishValidationCandidate } from '../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import { persistMalformedRunnerResultInCandidate, recoverableRunnerResultDiagnostic, RunnerSemanticResultError,
  RunnerVerdictEvidenceError } from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { persistRunnerRejection, readBoundRunnerRejection, recoverySection }
  from '../skills/workflows/stnl-slice-executor/runtime/runner-result-recovery.mjs';

const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
async function withCapturedResponse(responseOverride, run) {
  const previous = process.env.STNL_OPERATION_OWNER_FILE;
  const f = await implementedFixture();
  try {
    const activation = (await readExecutionActivation(f.specPath)).activation;
    const admitted = await beginPreparedExecutionOperation(f.specPath, 'VALIDATE_SLICE', '1', activation.activationId);
    const ownerFile = path.join(f.root, 'rejection-authority-owner.json');
    await fs.writeFile(ownerFile, JSON.stringify({ specPath: f.specPath, owner: admitted.owner }));
    process.env.STNL_OPERATION_OWNER_FILE = ownerFile;
    const start = await native(f, admitted.owner);
    const response = { status: 'PASS', head: 'offline-working-tree',
      commands: (await readRunnerVerification(f.specPath, 'slice-01')).checks.map(check => ({ command: verificationCommand(check), exit: 0 })),
      evidence: 'Reviewed greeting recipe completed.', findingReferences: 'none', findingDispositions: 'none',
      blockers: 'none', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'Preserve observed result', ...responseOverride };
    const captured = await capture(start, response);
    const parent = path.join(f.root, 'rejection-authority-candidates'); await fs.mkdir(parent);
    const copy = await prepareValidationCopy({ specPath: f.specPath, slice: 'slice-01', candidateParent: parent, owner: admitted.owner });
    const taskArtifact = path.join(copy.candidateExecutionRoot, 'tasks/slice-01.md');
    await run({ f, admitted, captured, copy, taskArtifact, parent, start });
  } finally {
    if (previous === undefined) delete process.env.STNL_OPERATION_OWNER_FILE; else process.env.STNL_OPERATION_OWNER_FILE = previous;
    await fs.rm(f.root, { recursive: true, force: true });
  }
}
async function evidence(name, result) {
  if (process.env.STNL_RECOVERY_EVIDENCE) await fs.writeFile(path.join(process.env.STNL_RECOVERY_EVIDENCE, `${name}.json`),
    JSON.stringify({ ...result, externalCalls: 0 }, null, 2) + '\n');
}

// Regression for independent-review false-rejection-probe: the same immutable
// response must not be both canonical PASS and authority for a fresh runner.
test('rejection authority refuses fabricated parser/verdict Errors over canonical PASS without mutation', async () => {
  await withCapturedResponse({}, async ({ f, admitted, captured, copy, taskArtifact, parent }) => {
    const good = await prepareValidationCopy({ specPath: f.specPath, slice: 'slice-01', candidateParent: parent, owner: admitted.owner });
    const valid = await prepareValidationCandidate({ specPath: f.specPath, slice: 'slice-01', workspace: f.root,
      candidateExecutionRoot: good.candidateExecutionRoot, ...captured });
    assert.equal(valid.formalStatus, 'PASS');
    const tree = await captureExecutionTree(f.workspace.executionRoot);
    const candidate = await captureExecutionTree(copy.candidateExecutionRoot);
    const receiptBytes = await fs.readFile(captured.receiptFile), responseBytes = await fs.readFile(captured.semanticResponseFile);
    const receipt = JSON.parse(receiptBytes);
    for (const error of [new RunnerSemanticResultError('VALIDATE_SLICE', new Error('fabricated parser failure')),
      new RunnerVerdictEvidenceError('VALIDATE_SLICE', 'PASS', [{ command: 'invented failure', exit: 1 }])]) {
      await assert.rejects(persistMalformedRunnerResultInCandidate({ taskArtifact, operation: 'VALIDATE_SLICE',
        workspace: f.root, ...captured, diagnostic: recoverableRunnerResultDiagnostic(error), error }), /no canonical recoverable rejection/);
      await assert.rejects(persistRunnerRejection({ receipt, context: null, taskText: await fs.readFile(taskArtifact, 'utf8'),
        blocker: 'fabricated blocker', diagnostic: recoverableRunnerResultDiagnostic(error) }), /no canonical recoverable rejection/);
      assert.deepEqual(await captureExecutionTree(copy.candidateExecutionRoot), candidate);
      assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), tree);
      assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBytes);
      assert.deepEqual(await fs.readFile(captured.semanticResponseFile), responseBytes);
      await assert.rejects(fs.access(`${captured.receiptFile}.rejection.json`), { code: 'ENOENT' });
    }
    await assert.rejects(beginRunnerResultRecovery(f.specPath, 'VALIDATE_SLICE', '1', {
      expectedActivationId: (await readExecutionActivation(f.specPath)).activation.activationId,
      rejectedOperationAttemptId: admitted.owner.operationAttemptId,
      rejection: { path: `${captured.receiptFile}.rejection.json`, sha256: digest('fabricated') },
    }), /published rejection proof required/);
    await publishValidationCandidate({ specPath: f.specPath, slice: 'slice-01', candidateExecutionRoot: good.candidateExecutionRoot, owner: admitted.owner });
    assert.equal((await inspectExecutionState(f.specPath)).state, 'COMPLETE');
    await evidence('false-rejection-after', { originalDeterministicStatus: valid.formalStatus,
      fabricatedErrors: ['parser', 'verdict'], publicApi: 'REFUSED', proofApi: 'REFUSED', successor: 'REFUSED',
      candidateAndCanonicalUnchanged: true, originalPassPublished: true, receiptSha256: digest(receiptBytes), responseSha256: digest(responseBytes) });
  });
});

test('rejection authority readback refuses a legacy forged proof and successor even when all evidence hashes match', async () => {
  await withCapturedResponse({}, async ({ f, admitted, captured, copy, taskArtifact }) => {
    const text = await fs.readFile(taskArtifact, 'utf8');
    const diagnostic = recoverableRunnerResultDiagnostic(new RunnerSemanticResultError('VALIDATE_SLICE', new Error('fabricated legacy failure')));
    const responseHash = digest(await fs.readFile(captured.semanticResponseFile));
    const blocker = ['- Operation: VALIDATE_SLICE', '- Kind: malformed-output', '- State: active', '- After record: none', '- Causes:',
      `  - Producer rejected captured response ${responseHash}: ${JSON.stringify(diagnostic)}`,
      `  - Captured response: ${captured.semanticResponseFile}; receipt: ${captured.receiptFile}`,
      '- Required action: Resume VALIDATE_SLICE slice-01 with a valid captured runner response.'].join('\n');
    const root = path.dirname(captured.receiptFile);
    const files = ['owner.json', 'round-1.origin.json', 'round-1.agent.json', 'round-1.tool-result.json', 'round-1.verification.json'].map(name => path.join(root, name));
    const record = { format: 'stnl-runner-rejection-v1', owner: admitted.owner, transport: 'native', ...captured,
      diagnostic, blocker, round: 1, consumedInvocations: 1,
      evidence: await Promise.all([...files, captured.receiptFile, captured.semanticResponseFile].map(async file => ({ path: file, sha256: digest(await fs.readFile(file)) }))),
      privateChecks: Object.fromEntries(['Implementation Test Evidence', 'Findings Test Evidence', 'Validation Attempts'].map(heading => [heading, recoverySection(text, heading)])) };
    // Test-only historical adversarial artifact, reproducing what the old public
    // API emitted. This is not produced by the repaired persistence boundary.
    const bytes = JSON.stringify(record, null, 2) + '\n';
    const reference = { path: `${captured.receiptFile}.rejection.json`, sha256: digest(bytes) };
    await fs.writeFile(reference.path, bytes, { flag: 'wx' });
    await assert.rejects(readBoundRunnerRejection(reference, admitted.owner), /no canonical recoverable rejection/);
    await fs.writeFile(taskArtifact, setSection(text, 'Delegation Blocker', `${blocker}\n- Recovery proof: ${reference.path} ${reference.sha256}`));
    await publishValidationCandidate({ specPath: f.specPath, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot, owner: admitted.owner });
    const state = await inspectExecutionState(f.specPath);
    assert.equal(state.state, 'RUNNER_RESULT_BLOCKED');
    const tree = await captureExecutionTree(f.workspace.executionRoot);
    await assert.rejects(beginRunnerResultRecovery(f.specPath, 'VALIDATE_SLICE', '1', {
      expectedActivationId: state.activation.activationId, rejectedOperationAttemptId: admitted.owner.operationAttemptId, rejection: reference,
    }), /no canonical recoverable rejection/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), tree);
    await evidence('legacy-forgery-after', { fixtureKind: 'synthetic legacy forged proof with matching hashes', readback: 'REFUSED', successor: 'REFUSED', canonicalUnchanged: true });
  });
});

test('rejection authority derives a real rejection despite unrelated caller Error and still requires authentic receipt bytes', async () => {
  await withCapturedResponse({ commands: 'malformed' }, async ({ f, admitted, captured, copy, taskArtifact }) => {
    const before = await fs.readFile(taskArtifact), receiptBytes = await fs.readFile(captured.receiptFile), responseBytes = await fs.readFile(captured.semanticResponseFile);
    const options = { taskArtifact, operation: 'VALIDATE_SLICE', workspace: f.root, ...captured,
      error: new Error('unrelated external failure'), diagnostic: 'invented external diagnostic' };
    for (const file of [captured.receiptFile, captured.semanticResponseFile]) {
      const bytes = await fs.readFile(file); await fs.writeFile(file, '{}');
      await assert.rejects(persistMalformedRunnerResultInCandidate(options));
      assert.deepEqual(await fs.readFile(taskArtifact), before);
      await assert.rejects(fs.access(`${captured.receiptFile}.rejection.json`), { code: 'ENOENT' });
      await fs.writeFile(file, bytes);
    }
    const rejected = await persistMalformedRunnerResultInCandidate(options);
    assert.match(rejected.diagnostic, /semantic validation payload commands must be a non-empty array/);
    assert.doesNotMatch(rejected.diagnostic, /external|invented/);
    const proof = JSON.parse(await fs.readFile(`${captured.receiptFile}.rejection.json`, 'utf8'));
    assert.equal(proof.diagnostic, rejected.diagnostic);
    await publishValidationCandidate({ specPath: f.specPath, slice: 'slice-01', candidateExecutionRoot: copy.candidateExecutionRoot, owner: admitted.owner });
    const state = await inspectExecutionState(f.specPath);
    const successor = await beginRunnerResultRecovery(f.specPath, 'VALIDATE_SLICE', '1', {
      expectedActivationId: state.activation.activationId, rejectedOperationAttemptId: admitted.owner.operationAttemptId,
      rejection: state.activeDelegationBlockers[0].recoveryProof,
    });
    const start = await native(f, successor.owner);
    await formal(f, { reuse: { admitted: successor, start } });
    assert.equal((await inspectExecutionState(f.specPath)).state, 'COMPLETE');
    assert.deepEqual(await fs.readFile(captured.receiptFile), receiptBytes);
    assert.deepEqual(await fs.readFile(captured.semanticResponseFile), responseBytes);
    await evidence('canonical-rejection-after', { canonicalDiagnostic: rejected.diagnostic, receiptAndResponseNegatives: 'REFUSED', legitimateRecovery: 'COMPLETE', predecessorEvidencePreserved: true });
  });
});

import { preflightExecutionOperation } from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { createManagedSliceContext, managedEnvironment, assertManagedRuntimeIdentity }
  from '../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';

test('rejection authority managed identity binds the extracted contract before dispatch', async () => {
  const f = await implementedFixture();
  const snapshot = await fs.mkdtemp(path.join(path.dirname(f.root), 'stnl-contract-identity-'));
  try {
    const relative = {
      adapter: 'agents/codex/runtime/validation-runner.mjs',
      bridge: 'agents/codex/runtime/managed-runner-bridge.mjs',
      preflight: 'agents/codex/runtime/managed-slice-preflight.mjs',
      evidenceSerializer: 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs',
      runnerResultContract: 'skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs',
    };
    const paths = {};
    for (const [key, file] of Object.entries(relative)) {
      paths[key] = path.join(snapshot, file);
      await fs.mkdir(path.dirname(paths[key]), { recursive: true });
      await fs.copyFile(path.resolve(import.meta.dirname, '..', file), paths[key]);
    }
    await fs.chmod(paths.adapter, 0o755);
    const preflight = await preflightExecutionOperation(f.specPath, 'VALIDATE_SLICE', '1');
    const officialPreflight = { exitCode: 0, operation: 'VALIDATE_SLICE', slice: 'slice-01', inputSlice: '1',
      specPath: f.specPath, state: preflight.state, authority: 'sha256:' + preflight.currentFingerprint,
      legalOperations: preflight.legalOperations, mandatoryRecovery: preflight.mandatoryRecovery,
      activationId: preflight.activation.activationId };
    const context = await createManagedSliceContext({ officialPreflight, workspace: f.root, snapshot,
      adapterPath: paths.adapter, bridgePath: paths.bridge, preflightPath: paths.preflight });
    const env = managedEnvironment({}, context);
    const bytes = await fs.readFile(paths.runnerResultContract);
    assert.equal(context.identity.runnerResultContract.sha256, digest(bytes));
    assert.equal(await assertManagedRuntimeIdentity(context, env), true);
    const tree = await captureExecutionTree(f.workspace.executionRoot);
    await fs.appendFile(paths.runnerResultContract, '\n// changed after admission\n');
    await assert.rejects(assertManagedRuntimeIdentity(context, env), /runnerResultContract identity changed/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), tree);
    await fs.writeFile(paths.runnerResultContract, bytes);
    assert.equal(await assertManagedRuntimeIdentity(context, env), true);
    await evidence('managed-contract-identity-after', { changedContract: 'REFUSED', restoredContract: 'PASS',
      canonicalUnchanged: true, providerCalls: 0, observation: 'Real prepared owner with copied runtime identity files; no runner dispatch' });
  } finally { await fs.rm(f.root, { recursive: true, force: true }); await fs.rm(snapshot, { recursive: true, force: true }); }
});
