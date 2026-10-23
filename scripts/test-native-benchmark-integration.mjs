import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { allocateOfflineFixture, finishOfflineFixture } from './fixtures/offline-checkout.mjs';
import { describeOfflineSdk } from '../agents/codex/runtime/offline-provider-context.mjs';
import { offlineNativeWorkflow } from './fixtures/native-workflow-provider.mjs';

const repo = path.resolve(import.meta.dirname, '..');
for (const [regime, fault] of [['fresh', null], ['author-continuity', null], ['fresh', 'interrupt-execute'], ['fresh', 'interrupt-close'], ['fresh', 'findings-cycle']]) test(`normal manager ${regime}/${fault}: public preparation through closed/export without managed`, async t => {
  const fixture = await allocateOfflineFixture(repo);
  t.after(async () => { await finishOfflineFixture(fixture); });
  const configurationPath = path.join(fixture.root, 'benchmarks/sentinel-todo/benchmark.json');
  const configuration = JSON.parse(await fs.readFile(configurationPath));
  configuration.contextPolicy = { regime, authorContinuityOperations: regime === 'fresh' ? [] : ['PLAN', 'EXECUTE_SLICE', 'SPEC_CLOSE'] };
  await fs.writeFile(configurationPath, JSON.stringify(configuration));
  const runRoot = path.join(fixture.root, 'benchmark-temp/run-native-offline');
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  const url = name => pathToFileURL(path.join(fixture.root, name)).href;
  const snapshot = await import(url('benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs'));
  const manager = await import(url('benchmarks/sentinel-todo/runtime/benchmark-manager.mjs'));
  const sdk = await describeOfflineSdk(await fs.realpath(path.join(repo, 'agents/codex/node_modules')), fixture.root);
  const metadata = await snapshot.createSnapshot(runRoot, { executionMode: 'OFFLINE_TEST_ONLY', offlineSdk: sdk });
  const product = await manager.loadProduct(path.join(runRoot, 'snapshot'));
  let backend;
  const actualFactory = product.createNativeProvider;
  product.createNativeProvider = async args => {
    backend ??= offlineNativeWorkflow({ ...args, caseRoot: args.evidenceRoot, fault });
    return actualFactory({ ...args, rpc: backend.rpc, pollMs: 1 });
  };
  await manager.initializeTurnBudget(runRoot, configuration.turnBudget.maxTurnsPerRun);
  const inherited = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  let result;
  try {
    const args = { runRoot, caseId: 'A', configuration, snapshotMetadata: metadata,
      maxOperations: null, mode: 'case', product, signal: new AbortController().signal };
    result = await manager.runCase(args);
    if (fault?.startsWith('interrupt-')) {
      assert.equal(result.status, 'BLOCKED');
      const before = backend.calls.filter(call => call.method === 'turn/start').length;
      const prior = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/case-state.json')));
      assert.ok(prior.pendingObservation.dispatch.turnId);
      const firstEvidence = await fs.readFile(prior.operations.at(-1).evidencePath);
      const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
      assert.ok(ledger.turns.some(turn => turn.state === 'uncertain'));
      if (fault === 'interrupt-execute') assert.equal(ledger.reservations.length, 3);
      result = await manager.runCase({ ...args, resume: true });
      assert.ok(firstEvidence.equals(await fs.readFile(prior.operations.at(-1).evidencePath)), 'first failed observation stays byte-identical');
      assert.equal(backend.calls.filter(call => call.method === 'turn/start').length, 6,
        'observation resume must not start a replacement turn or rerun its recipe');
      assert.ok(before <= 6);
    }
  }
  finally { if (inherited !== undefined) process.env.NODE_TEST_CONTEXT = inherited; }
  const run = { runId: path.basename(runRoot), mode: 'case', cases: ['A'], profile: 'production-v3',
    status: result.status, snapshot: metadata, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
  await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ ...run, cases: { A: result } }));
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const starts = backend.calls.filter(call => call.method === 'turn/start');
  assert.ok(starts.length > 0);
  for (const { params } of starts) {
    const skill = params.input.filter(item => item.type === 'skill');
    const text = params.input.filter(item => item.type === 'text');
    assert.equal(skill.length, 1); assert.equal(text.length, 1);
    assert.equal(skill[0].path, path.join(runRoot, 'snapshot/skills/workflows', skill[0].name, 'SKILL.md'));
    assert.ok(text[0].text.startsWith(`$${skill[0].name}\n`), 'normal explicit mention agrees with native skill item');
  }
  const extra = fault === 'findings-cycle' ? 2 : 0;
  assert.equal(result.operations, 6 + extra); assert.equal(result.runnerTurns, 2 + extra); assert.equal(result.mainTurns, 6 + extra);
  const state = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/case-state.json')));
  for (const operation of state.operations) {
    // The manager persists the exact launcher it sends, including the mention.
    const evidence = JSON.parse(await fs.readFile(operation.evidencePath));
    const prompt = await fs.readFile(evidence.promptFile, 'utf8');
    assert.ok(starts.some(call => call.params.input.some(item => item.type === 'text' && item.text === prompt)));
    assert.ok(prompt.includes(`SPEC_PATH=${state.specPath}`));
    assert.equal(evidence.promptSha256, `sha256:${createHash('sha256').update(prompt).digest('hex')}`);
  }
  const raw = JSON.parse(await fs.readFile(state.finalizer.rawPath));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const v1 = JSON.parse(await fs.readFile(path.join(repo, 'benchmarks/sentinel-todo/schemas/result.schema.json')));
  ajv.addSchema(v1, 'https://sentinel.local/schemas/result.schema.json');
  const validator = ajv.compile(JSON.parse(await fs.readFile(path.join(repo, 'benchmarks/sentinel-todo/schemas/result-v2.schema.json'))));
  assert.equal(validator(raw), true, JSON.stringify(validator.errors));
  assert.equal(raw.finalExecutionState, 'SPEC_CLOSED'); assert.equal(raw.specClosed, true);
  assert.equal(raw.productAcceptance.passed, true); assert.equal(raw.nativeTerminal.sourceActivationId.length, 36);
  assert.deepEqual(raw.contextPolicy, configuration.contextPolicy);
  await assert.rejects(fs.lstat(path.join(state.specPath, 'execution')), { code: 'ENOENT' });
  assert.equal(backend.calls.some(call => /account|login|config\/value/.test(call.method)), false);
  const authors = backend.operations.filter(item => ['SPEC_INIT', 'PLAN', 'EXECUTE_SLICE', 'SPEC_CLOSE'].includes(item.operation));
  assert.equal(new Set(authors.map(item => item.threadId)).size, regime === 'fresh' ? 4 : 1);
  const reviews = backend.operations.filter(item => ['REVIEW_PLAN', 'VALIDATE_SLICE'].includes(item.operation));
  assert.equal(new Set(reviews.map(item => item.threadId)).size, 2 + (extra ? 1 : 0));
  assert.ok(reviews.every(item => !authors.some(author => author.threadId === item.threadId)));
  const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
  assert.equal(ledger.total, 8 + 2 * extra); assert.equal(ledger.reservations.length, 0);
  assert.ok(ledger.turns.every(turn => turn.state === 'completed'));
  const terminal = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/terminal-evidence.json')));
  assert.equal(terminal.source.inspection.state, 'COMPLETE'); assert.equal(terminal.state, 'SPEC_CLOSED');
  const consumer = await import(url('benchmarks/sentinel-todo/runtime/native-evidence.mjs'));
  await consumer.validateTerminalEvidence({ product, evidence: terminal, specPath: state.specPath, workspace: state.workspace });
  for (const mutate of [
    value => { value.disposition = { kind: 'absent' }; value.receipt.sourceExecutionDisposition = { kind: 'absent' }; },
    value => { value.workspace = path.dirname(value.workspace); },
    value => { value.source.files = []; },
    value => { value.source.manifests = []; },
    value => { value.receipt.closedSnapshotSha256 = `sha256:${'0'.repeat(64)}`; },
    ...['outcome', 'terminalActivationId', 'deliveryId'].map(field => value => {
      const activation = JSON.parse(Buffer.from(value.source.activationBase64, 'base64'));
      activation.lastAttempt[field] = field === 'outcome' ? 'rejected' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      value.source.activationBase64 = Buffer.from(JSON.stringify(activation)).toString('base64');
      value.sourceSha256 = `sha256:${createHash('sha256').update(JSON.stringify(value.source)).digest('hex')}`;
    }),
  ]) {
    const forged = structuredClone(terminal); mutate(forged);
    await assert.rejects(consumer.validateTerminalEvidence({ product, evidence: forged,
      specPath: state.specPath, workspace: state.workspace }));
  }
  const measurements = await import(url('benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs'));
  const report = await measurements.exportMeasurement(path.basename(runRoot));
  assert.equal(report.cases[0].execution, 'SPEC_CLOSED');
  assert.deepEqual(report.comparability.contextPolicy, configuration.contextPolicy);
  assert.equal(report.provenance.executionMode, 'OFFLINE_TEST_ONLY');
  assert.equal(measurements.compareMeasurements(report, report).directlyComparable, false,
    'mechanical provider evidence cannot be promoted to real benchmark savings');
  if (regime === 'fresh' && fault === null) {
    const ledgerFile = path.join(runRoot, '.turn-ledger.json'), ledgerBytes = await fs.readFile(ledgerFile);
    for (const invalid of [null, '{broken', JSON.stringify({ ...JSON.parse(ledgerBytes), total: 99 }),
      JSON.stringify({ ...JSON.parse(ledgerBytes), turns: JSON.parse(ledgerBytes).turns.map((turn, index) => index ? turn : { ...turn, state: 'unknown' }) })]) {
      if (invalid === null) await fs.unlink(ledgerFile); else await fs.writeFile(ledgerFile, invalid);
      await assert.rejects(manager.main(['clean', '--run', path.basename(runRoot)]));
      await assert.rejects(measurements.exportMeasurement(path.basename(runRoot)));
      assert.ok((await fs.lstat(runRoot)).isDirectory(), 'invalid consumption proof cannot clean the run');
      await fs.writeFile(ledgerFile, ledgerBytes);
    }
    const retained = path.join(fixture.root, 'benchmark-temp/.retained', path.basename(runRoot));
    // Interrupt the actual final rename after the normal exporter completed.
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      if (source === runRoot && target === retained) throw Object.assign(new Error('OFFLINE final retention interruption'), { code: 'EIO' });
      return rename(source, target);
    };
    try { await assert.rejects(manager.main(['clean', '--run', path.basename(runRoot)]), /OFFLINE final retention interruption/); }
    finally { fs.rename = rename; }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runRoot, 'measurement-retained.json'))), report);
    assert.equal(await manager.main(['clean', '--run', path.basename(runRoot)]), 0);
    await assert.rejects(fs.lstat(runRoot), { code: 'ENOENT' });
    assert.ok((await fs.lstat(path.join(retained, 'case-a/terminal-evidence.json'))).isFile());
  }
});

test('literal manager entry parses ordinary run --case A and retains its normal Node metadata', async t => {
  const fixture = await allocateOfflineFixture(repo);
  t.after(async () => { await finishOfflineFixture(fixture); });
  const url = relative => pathToFileURL(path.join(fixture.root, relative)).href;
  const manager = await import(url('benchmarks/sentinel-todo/runtime/benchmark-manager.mjs'));
  const actual = (await import(url('agents/codex/runtime/native-provider.mjs'))).createNativeProvider;
  const sdk = await describeOfflineSdk(await fs.realpath(path.join(repo,'agents/codex/node_modules')),fixture.root);
  const backends = [];
  const offline = { mode: 'OFFLINE_TEST_ONLY', sdk, createNativeProvider: async args => {
    const backend = offlineNativeWorkflow({ ...args, caseRoot: args.evidenceRoot }); backends.push(backend);
    return actual({ ...args, rpc: backend.rpc, pollMs: 1 });
  } };
  const context = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  let runId;
  try {
    assert.equal(await manager.main(['run','--case','A','--max-operations','3','--json'], { offline }), 0);
    runId = (await fs.readdir(path.join(fixture.root,'benchmark-temp'))).find(name => name.startsWith('run-'));
    const stopped = JSON.parse(await fs.readFile(path.join(fixture.root,'benchmark-temp',runId,'run.json')));
    assert.equal(stopped.status,'FOCAL_STOP');
    assert.equal(await manager.main(['run','--resume',runId,'--json'], { offline }),0);
  }
  finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
  const info = JSON.parse(await fs.readFile(path.join(fixture.root,'benchmark-temp',runId,'run.json')));
  assert.equal(info.status,'PASS'); assert.equal(info.mode,'case'); assert.deepEqual(info.cases,['A']);
  const measurement = await import(url('benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs'));
  const report = await measurement.exportMeasurement(runId);
  assert.equal(report.run.status,'PASS'); assert.equal(report.cases[0].execution,'SPEC_CLOSED');
  assert.equal(report.provenance.executionMode,'OFFLINE_TEST_ONLY');
  assert.equal(backends.length,2);
  assert.equal(backends.flatMap(backend => backend.calls).filter(call => call.method === 'turn/start').length,6);
  await assert.rejects(fs.lstat(path.join(fixture.root,'benchmark-temp/.active-run.json')),{code:'ENOENT'});
});

for (const fault of ['foreign-child','grandchildren','budget']) test(`normal entry blocks ${fault} without successor, refund or proof substitution`, async t => {
  const fixture = await allocateOfflineFixture(repo);
  t.after(async () => { await finishOfflineFixture(fixture); });
  const url = relative => pathToFileURL(path.join(fixture.root, relative)).href;
  const manager = await import(url('benchmarks/sentinel-todo/runtime/benchmark-manager.mjs'));
  const actual = (await import(url('agents/codex/runtime/native-provider.mjs'))).createNativeProvider;
  const sdk = await describeOfflineSdk(await fs.realpath(path.join(repo,'agents/codex/node_modules')),fixture.root);
  if (fault === 'budget') {
    const configPath = path.join(fixture.root,'benchmarks/sentinel-todo/benchmark.json');
    const configuration = JSON.parse(await fs.readFile(configPath)); configuration.turnBudget.maxTurnsPerRun = 4;
    await fs.writeFile(configPath,JSON.stringify(configuration));
  }
  let backend;
  const offline = { mode: 'OFFLINE_TEST_ONLY', sdk, createNativeProvider: async args => {
    backend ??= offlineNativeWorkflow({ ...args, caseRoot: args.evidenceRoot, fault });
    return actual({ ...args, rpc: backend.rpc, pollMs: 1 });
  } };
  const context = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.notEqual(await manager.main(['run','--case','A','--json'], { offline }),0);
    const runId = (await fs.readdir(path.join(fixture.root,'benchmark-temp'))).find(name => name.startsWith('run-'));
    const runRoot = path.join(fixture.root,'benchmark-temp',runId);
    const file = path.join(runRoot,'case-a/case-state.json'), state = JSON.parse(await fs.readFile(file));
    assert.notEqual(state.status,'PASS'); assert.ok(!backend.operations.some(item => item.operation === 'SPEC_CLOSE'));
    const ledger = JSON.parse(await fs.readFile(path.join(runRoot,'.turn-ledger.json')));
    assert.equal(backend.calls.filter(call => call.method === 'turn/start').length,fault === 'budget' ? 3 : 4);
    if (fault === 'budget') {
      assert.equal(ledger.total,3); assert.equal(ledger.reservations.length,0);
    } else {
      assert.ok(ledger.turns.some(turn => turn.state === 'uncertain'));
      assert.equal(ledger.reservations.length,2);
      await assert.rejects(manager.main(['clean','--run',runId]),/pending\/uncertain/);
      if (fault === 'grandchildren') {
        assert.equal(ledger.turns.filter(turn => turn.unadmitted).length,2);
        const firstFile = state.operations.at(-1).evidencePath, first = await fs.readFile(firstFile);
        assert.notEqual(await manager.main(['run','--resume',runId,'--json'],{offline}),0);
        const after = JSON.parse(await fs.readFile(path.join(runRoot,'.turn-ledger.json')));
        assert.equal(after.total,ledger.total); assert.equal(after.turns.filter(turn => turn.unadmitted).length,2);
        assert.equal(backend.calls.filter(call => call.method === 'turn/start').length,4);
        assert.ok(first.equals(await fs.readFile(firstFile)));
      }
    }
  } finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
});
