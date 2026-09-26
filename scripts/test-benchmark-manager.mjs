import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertManagedValidationLauncher, decideOutcome, nextHandoff } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'benchmark-temp');
const MANAGER = path.join(ROOT, 'benchmarks/sentinel-todo/runtime/benchmark-manager.mjs');

test('managed launcher disagreement stops before SDK and runner dispatch', () => {
  const context = { operation: 'VALIDATE_SLICE', slice: 'slice-01', specPath: '/run-XYZ/case-c/workspace/specs/case-c' };
  const prompt = `Use stnl-slice-quality-manager.\nOPERATION=VALIDATE_SLICE\nSPEC_PATH=${context.specPath}\nSLICE=1\n`;
  assert.doesNotThrow(() => assertManagedValidationLauncher(prompt, context, '1'));
  assert.throws(() => assertManagedValidationLauncher(prompt.replace('/run-XYZ/', '/run-XYZ-c-AbCd12/'), context, '1'),
    /managed launcher SPEC_PATH disagrees/u);
  assert.throws(() => assertManagedValidationLauncher(prompt.replace('SLICE=1', 'SLICE=2'), context, '1'),
    /managed launcher SLICE disagrees/u);
  assert.throws(() => assertManagedValidationLauncher(prompt.replace('OPERATION=VALIDATE_SLICE', 'OPERATION=EXECUTE_SLICE'), context, '1'),
    /managed launcher OPERATION disagrees/u);
});

function invoke(...args) {
  return spawnSync(process.execPath, [MANAGER, ...args], { cwd: ROOT, encoding: 'utf8' });
}

async function ownedRun(t) {
  const id = `run-test-${randomUUID()}`;
  const root = path.join(RUNS, id);
  await fs.mkdir(root, { recursive: true });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify({ status: 'PASS', cases: { A: { status: 'PASS' } } }));
  await fs.writeFile(path.join(root, 'run.json'), JSON.stringify({ status: 'PASS', mode: 'case', snapshot: {
    snapshotSha256: 'snapshot', sourceFunctionalSha256: 'source',
  } }));
  return { id, root };
}

test('INIT ready advances directly and COMPLETE closes without terminal readiness', () => {
  const readback = { lifecycle: { status: 'ready' }, execution: { state: 'COMPLETE' },
    executionRaw: { state: 'COMPLETE' } };
  assert.deepEqual(nextHandoff('VALIDATE_SLICE', readback), { operation: 'SPEC_CLOSE', slice: null });
  assert.equal(nextHandoff('SPEC_CLOSE', readback), null);
  const initial = {
    lifecycle: { status: 'ready' }, execution: { state: 'EMPTY' }, executionRaw: { state: 'EMPTY' },
  };
  assert.deepEqual(decideOutcome('SPEC_INIT', initial, true), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_INIT', initial), { operation: 'PLAN', slice: null });
});

test('documentary maturation advances through global findings, RESUME, and status-only promotion', () => {
  const draft = { lifecycle: { status: 'draft' }, execution: { state: 'EMPTY' }, executionRaw: { state: 'EMPTY' } };
  const findings = { verdict: 'FINDINGS', findings: [{ action: 'REFINE_FROM_EVIDENCE' }] };
  const ready = { verdict: 'READY', findings: [] };
  assert.deepEqual(decideOutcome('SPEC_INIT', draft, true), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_INIT', draft), { operation: 'SPEC_READINESS', slice: null });
  assert.deepEqual(decideOutcome('SPEC_READINESS', draft, true, findings), { result: 'NEEDS_FIX', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_READINESS', draft, findings), { operation: 'SPEC_RESUME', slice: null });
  assert.deepEqual(nextHandoff('SPEC_RESUME', draft), { operation: 'SPEC_READINESS', slice: null });
  assert.deepEqual(decideOutcome('SPEC_READINESS', draft, true, ready), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('SPEC_READINESS', draft, ready), { operation: 'SPEC_PROMOTE', slice: null });
  assert.deepEqual(nextHandoff('SPEC_PROMOTE', { ...draft, lifecycle: { status: 'ready' } }), { operation: 'PLAN', slice: null });
  const decision = { verdict: 'FINDINGS', findings: [{ action: 'DECISION_REQUIRED' }] };
  assert.deepEqual(decideOutcome('SPEC_READINESS', draft, true, decision), { result: 'BLOCKED', blocker: 'BLOCKED_REQUIRED_DECISION' });
});

test('READINESS output schema gives every field a provider-valid type', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(ROOT,
    'skills/workflows/stnl-spec-lifecycle-manager/runtime/readiness-result.schema.json'), 'utf8'));
  function check(node) {
    assert.ok(node.type, 'each generated field needs an explicit type');
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      for (const property of Object.values(node.properties)) check(property);
    }
    if (node.type === 'array') check(node.items);
  }
  check(schema);
});

test('status and inspect are read only and clean removes only the selected owned run', async (t) => {
  const { id, root } = await ownedRun(t);
  const other = await ownedRun(t);
  const caseRoot = path.join(root, 'case-a');
  await fs.mkdir(caseRoot);
  await fs.writeFile(path.join(caseRoot, 'case-state.json'), JSON.stringify({
    status: 'PASS', privateHomeRemoved: true, operations: [], terminal: { result: 'PASS' },
  }));
  const status = invoke('status', '--run', id, '--json');
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).status, 'PASS');
  const inspected = invoke('inspect', '--run', id, '--case', 'A', '--json');
  assert.equal(inspected.status, 0);
  assert.equal(JSON.parse(inspected.stdout).cases.A.status, 'PASS');
  assert.equal((await fs.readdir(root)).includes('summary.json'), true);
  const cleaned = invoke('clean', '--run', id);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' });
  assert.equal((await fs.lstat(other.root)).isDirectory(), true);
});

test('clean refuses a symlink in an owned run and leaves evidence intact', async (t) => {
  const { id, root } = await ownedRun(t);
  await fs.symlink(path.join(ROOT, 'README.md'), path.join(root, 'escape'));
  const cleaned = invoke('clean', '--run', id);
  assert.equal(cleaned.status, 1);
  assert.match(cleaned.stderr, /contains a symlink/u);
  assert.equal((await fs.lstat(path.join(root, 'summary.json'))).isFile(), true);
});
