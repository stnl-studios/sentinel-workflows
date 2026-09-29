import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  captureRunnerTestedState,
  serializeRunnerExecutionBundleFromResponse,
} from '../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HISTORICAL = path.join(ROOT, 'benchmark-temp/run-20260928220422-63762e6f/case-b');
const A = 'ca4c3b7735150519702004b1f112ae325dd3b44e2cced440b761fc0dcf116269';
const B = 'e9b6c71cce44d6d8dd33b182696982b7d3eacf9cd9d340e5e96351805dfdedeb';
const CLI = '../../../../src/cli.mjs';
const TEST = '../../../../test/cli.test.mjs';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function section(text, heading, body) {
  const marker = `## ${heading}\n\n`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, heading);
  const from = start + marker.length;
  const next = text.indexOf('\n## ', from);
  assert.ok(next >= 0, heading);
  return `${text.slice(0, from)}${body}\n${text.slice(next + 1)}`;
}

async function fixture(t) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-tested-state-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const taskArtifact = path.join(workspace, 'specs/benchmark-case-b/execution/tasks/slice-02.md');
  const cli = path.join(workspace, 'src/cli.mjs');
  const cliTest = path.join(workspace, 'test/cli.test.mjs');
  await Promise.all([fs.mkdir(path.dirname(taskArtifact), { recursive: true }), fs.mkdir(path.dirname(cli)), fs.mkdir(path.dirname(cliTest))]);
  const events = (await fs.readFile(path.join(HISTORICAL, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const before = events.find((event) => event.operationId === 'B-08-EXECUTE_SLICE'
    && event.type === 'item.completed' && event.item?.command?.includes("sed -n '1,180p' src/cli.mjs"))?.item.aggregated_output;
  assert.equal(hash(before), A);
  const after = await fs.readFile(path.join(HISTORICAL, 'workspace/src/cli.mjs'));
  assert.equal(hash(after), B);
  await fs.writeFile(cli, before);
  await fs.copyFile(path.join(HISTORICAL, 'workspace/test/cli.test.mjs'), cliTest);
  let task = await fs.readFile(path.join(HISTORICAL, 'workspace/specs/benchmark-case-b/execution/tasks/slice-02.md'), 'utf8');
  for (const heading of ['Delegation Blocker', 'Implementation Test Evidence', 'Findings Test Evidence', 'Corrections Applied']) {
    task = section(task, heading, '- none');
  }
  await fs.writeFile(taskArtifact, task);
  const prior = task.match(/## Implementation Test Evidence\n\n([\s\S]*?)\n## /u)?.[1];
  assert.equal(prior, '- none');
  return { workspace, taskArtifact, cli, cliTest, before, after };
}

async function captured(t, fixtureValue, operation, attempt, payload, snapshot) {
  const root = path.join(fixtureValue.workspace, 'receipts');
  await fs.mkdir(root, { recursive: true });
  const stem = `008-${operation.toLowerCase()}-slice-02-attempt-${attempt}`;
  const semanticResponseFile = path.join(root, `${stem}.response.json`);
  const eventsPath = path.join(root, `${stem}.events.jsonl`);
  const receiptFile = path.join(root, `${stem}.receipt.json`);
  const response = JSON.stringify(payload);
  const events = payload.commands.flatMap(({ command, exit }, index) => [
    { operationId: `runner-${stem}`, type: 'item.started', item: { id: `item_${index}`, type: 'command_execution', command, status: 'in_progress', exit_code: null } },
    { operationId: `runner-${stem}`, type: 'item.completed', item: { id: `item_${index}`, type: 'command_execution', command, status: 'completed', exit_code: exit } },
  ]);
  const receipt = {
    status: 'RUNNER_RESPONSE_CAPTURED', operation, sequence: 8, slice: 'slice-02', attempt,
    eventsPath, semanticResponseFile, semanticResponseSha256: hash(response),
    captureFailure: null, error: null, exitCode: 0, testedState: snapshot,
  };
  await fs.writeFile(semanticResponseFile, response);
  await fs.writeFile(eventsPath, `${events.map(JSON.stringify).join('\n')}\n`);
  await fs.writeFile(receiptFile, JSON.stringify(receipt));
  return { receiptFile, semanticResponseFile, response, receipt };
}

async function produce(fixtureValue, operation, evidence) {
  return serializeRunnerExecutionBundleFromResponse({
    operation, response: evidence.response, workspace: fixtureValue.workspace,
    taskArtifact: fixtureValue.taskArtifact, receiptFile: evidence.receiptFile,
    semanticResponseFile: evidence.semanticResponseFile,
  });
}

async function historicalPayload(attempt) {
  const name = `008-execute_slice-slice-02-attempt-${attempt}.response.json`;
  const payload = JSON.parse(await fs.readFile(path.join(HISTORICAL, 'tmp', name), 'utf8'));
  payload.commands = payload.commands.map(({ command, exit }) => ({ command, exit }));
  return payload;
}

test('historical A survives mutation to B and round 2 derives only src/cli.mjs', async (t) => {
  const f = await fixture(t);
  const persisted = await fs.readFile(path.join(HISTORICAL, 'workspace/specs/benchmark-case-b/execution/tasks/slice-02.md'), 'utf8');
  assert.match(persisted, new RegExp(`### implementation-check-01[\\s\\S]*?${CLI.replaceAll('.', '\\.')}\x60 \\| sha256:${B}`, 'u'));
  const first = await captureRunnerTestedState({ workspace: f.workspace, taskArtifact: f.taskArtifact, changedAreas: [CLI, TEST] });
  assert.equal(first.entries.find((entry) => entry.path === CLI)?.value, `sha256:${A}`);
  await fs.writeFile(f.cli, f.after);
  assert.equal(hash(await fs.readFile(f.cli)), B);
  const one = await captured(t, f, 'EXECUTE_SLICE', 1, await historicalPayload(1), first);
  const round1 = await produce(f, 'EXECUTE_SLICE', one);
  assert.match(round1, new RegExp(`\x60${CLI.replaceAll('.', '\\.')}\x60 \\| sha256:${A}`, 'u'));
  assert.doesNotMatch(round1, new RegExp(`\x60${CLI.replaceAll('.', '\\.')}\x60 \\| sha256:${B}`, 'u'));
  await fs.writeFile(f.taskArtifact, section(await fs.readFile(f.taskArtifact, 'utf8'), 'Implementation Test Evidence', round1));
  const second = await captureRunnerTestedState({ workspace: f.workspace, taskArtifact: f.taskArtifact, changedAreas: [CLI, TEST] });
  const two = await captured(t, f, 'EXECUTE_SLICE', 2, await historicalPayload(2), second);
  const round2 = await produce(f, 'EXECUTE_SLICE', two);
  assert.match(round2, /### implementation-check-02\n- Automatic check round: 2\/3\n- Status: TESTS_PASS/u);
  assert.match(await fs.readFile(f.taskArtifact, 'utf8'), /## Corrections Applied\n\n- `\.\.\/\.\.\/\.\.\/\.\.\/src\/cli\.mjs`/u);
  assert.match(round2, /- Correction paths: \.\.\/\.\.\/\.\.\/\.\.\/src\/cli\.mjs/u);
  assert.equal(Object.hasOwn(JSON.parse(two.response), 'correctionPaths'), false);
});

test('no mutation and multiple targets derive the exact corrections set', async (t) => {
  for (const mutate of [[], ['cli'], ['cli', 'test']]) {
    const f = await fixture(t);
    const first = await captureRunnerTestedState({ workspace: f.workspace, taskArtifact: f.taskArtifact, changedAreas: [CLI, TEST] });
    const one = await captured(t, f, 'EXECUTE_SLICE', 1, await historicalPayload(1), first);
    const round1 = await produce(f, 'EXECUTE_SLICE', one);
    await fs.writeFile(f.taskArtifact, section(await fs.readFile(f.taskArtifact, 'utf8'), 'Implementation Test Evidence', round1));
    if (mutate.includes('cli')) await fs.writeFile(f.cli, f.after);
    if (mutate.includes('test')) await fs.appendFile(f.cliTest, '\n// corrected test\n');
    const second = await captureRunnerTestedState({ workspace: f.workspace, taskArtifact: f.taskArtifact, changedAreas: [CLI, TEST] });
    const two = await captured(t, f, 'EXECUTE_SLICE', 2, await historicalPayload(2), second);
    const round2 = await produce(f, 'EXECUTE_SLICE', two);
    const expected = mutate.length === 0 ? 'none' : mutate.map((name) => name === 'cli' ? CLI : TEST).join(', ');
    assert.match(round2, new RegExp(`- Correction paths: ${expected.replaceAll('.', '\\.').replaceAll('/', '\\/')}`, 'u'));
  }
});

test('removed target is captured as REMOVED and later bytes cannot rewrite it', async (t) => {
  const f = await fixture(t);
  await fs.rm(f.cli);
  const snapshot = await captureRunnerTestedState({ workspace: f.workspace, taskArtifact: f.taskArtifact, changedAreas: [CLI, TEST] });
  assert.deepEqual(snapshot.entries.find((entry) => entry.path === CLI), { path: CLI, value: 'REMOVED' });
  await fs.writeFile(f.cli, f.after);
  assert.equal(snapshot.entries.find((entry) => entry.path === CLI).value, 'REMOVED');
  const one = await captured(t, f, 'EXECUTE_SLICE', 1, await historicalPayload(1), snapshot);
  assert.match(await produce(f, 'EXECUTE_SLICE', one), /`\.\.\/\.\.\/\.\.\/\.\.\/src\/cli\.mjs` \| REMOVED/u);
});

test('receipt, operation, slice, workspace and source mismatch reject captured state', async (t) => {
  const f = await fixture(t);
  const snapshot = await captureRunnerTestedState({ workspace: f.workspace, taskArtifact: f.taskArtifact, changedAreas: [CLI, TEST] });
  const evidence = await captured(t, f, 'EXECUTE_SLICE', 1, await historicalPayload(1), snapshot);
  for (const altered of [
    { semanticResponseSha256: '0'.repeat(64) },
    { operation: 'APPLY_FINDINGS' },
    { slice: 'slice-03' },
    { attempt: 2 },
    { testedState: { ...snapshot, workspace: os.tmpdir() } },
    { testedState: { ...snapshot, sourceTaskPath: path.join(f.workspace, 'other.md') } },
  ]) {
    await fs.writeFile(evidence.receiptFile, JSON.stringify({ ...evidence.receipt, ...altered }));
    await assert.rejects(produce(f, 'EXECUTE_SLICE', evidence));
  }
});

test('APPLY_FINDINGS uses the same historical snapshot boundary', async (t) => {
  const f = await fixture(t);
  const execute = await historicalPayload(1);
  const apply = (round) => ({
    status: round === 1 ? 'TESTS_FAIL' : 'TESTS_PASS', automaticCheckRound: `${round}/3`, findingsCycle: 'attempt-01',
    head: execute.head, discoverySources: execute.discoverySources, discoveryActions: execute.discoveryActions,
    verificationTypesConsidered: execute.verificationTypesConsidered,
    nonApplicabilityRationale: execute.nonApplicabilityRationale,
    noVerificationCommandConfirmation: execute.noVerificationCommandConfirmation,
    commands: execute.commands.map(({ command }) => ({ command, exit: round === 1 ? 1 : 0 })),
    resultOfEachCommandAndExitCode: 'checked', selectedChecks: 'focused', selectionRationale: 'direct',
    coverage: 'finding', findingsVerified: 'none', correctionsCovered: 'corrected CLI error',
    regressionsSelected: 'focused', unsupportedActiveFindings: 'none',
    failures: round === 1 ? 'CLI error text' : 'none', evidenceOrFailureSummary: 'checked',
    affectedFilesOrBehaviors: 'CLI', blockers: 'none', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'none',
  });
  const first = await captureRunnerTestedState({ workspace: f.workspace, taskArtifact: f.taskArtifact, changedAreas: [CLI, TEST] });
  await fs.writeFile(f.cli, f.after);
  const one = await captured(t, f, 'APPLY_FINDINGS', 1, apply(1), first);
  const round1 = await produce(f, 'APPLY_FINDINGS', one);
  assert.match(round1, new RegExp(`\x60${CLI.replaceAll('.', '\\.')}\x60 \\| sha256:${A}`, 'u'));
  let task = section(await fs.readFile(f.taskArtifact, 'utf8'), 'Findings Test Evidence', round1);
  task = section(task, 'Corrections Applied', `- \`${CLI}\``);
  await fs.writeFile(f.taskArtifact, task);
  const second = await captureRunnerTestedState({ workspace: f.workspace, taskArtifact: f.taskArtifact, changedAreas: [CLI, TEST] });
  const two = await captured(t, f, 'APPLY_FINDINGS', 2, apply(2), second);
  const round2 = await produce(f, 'APPLY_FINDINGS', two);
  assert.match(round2, /### findings-check-02\n- Automatic check round: 2\/3\n- Status: TESTS_PASS/u);
  assert.match(round2, /- Correction paths: \.\.\/\.\.\/\.\.\/\.\.\/src\/cli\.mjs/u);
});
