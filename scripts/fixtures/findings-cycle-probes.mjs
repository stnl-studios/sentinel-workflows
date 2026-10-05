// TEST-ONLY probes within the owned fake APPLY; no captured file is edited.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readManagedSliceContext } from '../../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';
import { inspectExecutionState, validateExecutionCandidate } from '../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import { serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate } from '../../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { finalizeManagedSlice } from '../../agents/codex/runtime/managed-slice-finalize.mjs';
import { bindManagedFindingsCycle } from '../../agents/codex/runtime/managed-findings-cycle.mjs';
import { initializeTurnBudget, reserveExtraRunner } from '../../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file));
const context = readManagedSliceContext(process.env), directory = path.join(process.env.TMPDIR, 'stnl-runner-broker');
const active = await read(path.join(directory, 'active.json')), stem = String(active.sequence).padStart(3, '0');
const binding = await read(path.join(directory, stem + '.candidate.json'));
const latest = await read(path.join(directory, stem + '.latest.json'));
const sealed = await read(path.join(directory, 'sealed-' + latest.requestId + '.json'));
const receipt = latest.receipt, raw = await fs.readFile(receipt.semanticResponseFile, 'utf8'), response = JSON.parse(raw);
const candidateText = await fs.readFile(binding.candidateTaskArtifact, 'utf8'), liveText = await fs.readFile(binding.liveTaskArtifact, 'utf8');
const selected = (await inspectExecutionState(context.specPath)).tasks.get(context.slice);
const input = { context, binding, selected, sealed, receipt, response, candidateText, liveText };
if (process.argv[2] === '--private-history') {
  const prior = await read(path.join(directory, stem + '.finalization.json'));
  const next = { ...input, prior, response: { ...response, automaticCheckRound: '2/3', findingsCycle: 'finding-01' },
    sealed: { ...sealed, managedPayload: { ...sealed.managedPayload, automaticCheckRound: '2/3' } } };
  assert.equal(bindManagedFindingsCycle(next).canonicalCycle, 'attempt-01');
  assert.throws(() => bindManagedFindingsCycle({ ...next, candidateText: candidateText.replace('- Findings verified: none', '- Findings verified: finding-01') }),
    { code: 'MANAGED_FINDINGS_BINDING_INVALID' });
  assert.throws(() => bindManagedFindingsCycle({ ...next, prior: { ...prior, state: 'FINDINGS_CORRECTED' } }),
    { code: 'MANAGED_FINDINGS_BINDING_INVALID' });
  const offline = await read(process.env.STNL_OFFLINE_PROVIDER_CONTEXT);
  await fs.writeFile(path.join(offline.root, '.offline-findings-private-history-probes.json'), JSON.stringify({ privateHistoryChangedRejected: true,
    wrongPriorVerdictRejected: true, candidateUnchanged: candidateText === await fs.readFile(binding.candidateTaskArtifact, 'utf8') }));
  process.exit(0);
}
const bound = bindManagedFindingsCycle(input);
const blocked = [];
for (const [name, override] of [
  ['otherCanonicalCycle', { response: { ...response, findingsCycle: 'attempt-99' } }],
  ['unobservedLiteral', { response: { ...response, findingsCycle: 'guess' } }],
  ['sealedRoundMismatch', { response: { ...response, automaticCheckRound: '2/3' } }],
  ['changedCanonicalCycle', { selected: { ...selected, attempts: [...selected.attempts, { id: 'attempt-02', status: 'NEEDS_FIX' }] }, response: { ...response, findingsCycle: 'attempt-01' } }],
  ['findingOutsideActiveSet', { sealed: { ...sealed, managedPayload: { ...sealed.managedPayload, activeFindings: ['finding-99'] } } }],
  ['changedCandidateHistory', { candidateText: candidateText.replace('### attempt-01', '### attempt-99') }],
]) {
  assert.throws(() => bindManagedFindingsCycle({ ...input, ...override }), { code: 'MANAGED_FINDINGS_BINDING_INVALID' }); blocked.push(name);
}
assert.equal(bindManagedFindingsCycle({ ...input, selected: { ...selected, attempts: [...selected.attempts,
  { id: 'attempt-02', status: 'NEEDS_FIX' }] }, response: { ...response, findingsCycle: 'attempt-02' } }).canonicalCycle, 'attempt-02',
  'current NEEDS_FIX owns the cycle even when the active finding has an older origin');
const originalContext = process.env.STNL_MANAGED_CONTEXT;
try {
  process.env.STNL_MANAGED_CONTEXT = JSON.stringify({ ...context, authority: 'sha256:' + 'b'.repeat(64) });
  await assert.rejects(finalizeManagedSlice('--finalize'), /identity|authority|disagrees|stale/); blocked.push('changedAuthority');
} finally { process.env.STNL_MANAGED_CONTEXT = originalContext; }
for (const target of ['src/cli.mjs', 'test/offline-case.json']) {
  const file = path.join(context.workspace, target), bytes = await fs.readFile(file);
  try { await fs.writeFile(file, Buffer.concat([bytes, Buffer.from('\n')]));
    await assert.rejects(finalizeManagedSlice('--finalize'), /tested source changed/); blocked.push(target);
  } finally { await fs.writeFile(file, bytes); }
}
const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: context.operation, response: raw,
  workspace: context.workspace, taskArtifact: binding.candidateTaskArtifact, receiptFile: receipt.receiptFile,
  semanticResponseFile: receipt.semanticResponseFile, resolveManagedFindingsCycle: () => bound.canonicalCycle });
const before = await fs.readFile(binding.candidateTaskArtifact);
for (const [name, malformed] of [
  ['conflictingFindings', bundle.replace('- Findings verified: none', '- Findings verified: finding-01')],
  ['undeclaredFinding', bundle.replace('- Unsupported active findings: finding-01', '- Unsupported active findings: finding-99')],
  ['missingActiveFinding', bundle.replace('- Unsupported active findings: finding-01', '- Unsupported active findings: none')],
  ['missingPriorFailure', bundle.replace('- Automatic check round: 1/3', '- Automatic check round: 2/3')],
]) {
  await assert.rejects(insertExecutionEvidenceInCandidate({ taskArtifact: binding.candidateTaskArtifact, operation: context.operation,
    bundle: malformed, validateProspectiveTask: task => validateExecutionCandidate(context.specPath, binding.candidateExecutionRoot, [task]) }));
  assert.deepEqual(await fs.readFile(binding.candidateTaskArtifact), before); blocked.push(name);
}
const offline = await read(process.env.STNL_OFFLINE_PROVIDER_CONTEXT);
const budgetRoot = path.join(offline.root, '.offline-findings-budget'); await fs.mkdir(budgetRoot);
await initializeTurnBudget(budgetRoot, 1);
const budgetArgs = { runRoot: budgetRoot, runId: 'TEST-ONLY', caseId: 'B', operation: 'APPLY_FINDINGS', limit: 1 };
await reserveExtraRunner(budgetArgs);
const ledgerBefore = await fs.readFile(path.join(budgetRoot, '.turn-ledger.json'));
await assert.rejects(reserveExtraRunner(budgetArgs), { code: 'PAUSED_BUDGET_OR_QUOTA' });
assert.deepEqual(await fs.readFile(path.join(budgetRoot, '.turn-ledger.json')), ledgerBefore);
assert.deepEqual(await fs.readFile(binding.candidateTaskArtifact), before); blocked.push('budgetDenied');
await fs.writeFile(path.join(offline.root, '.offline-findings-cycle-probes.json'), JSON.stringify({ blocked,
  invalidAppends: 0, extraProviderStarts: 0, candidateSha256: hash(before), budgetLedgerUnchanged: true }));
