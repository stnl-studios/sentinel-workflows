#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { allocateOfflineFixture, finishOfflineFixture } from './fixtures/offline-checkout.mjs';
import { describeOfflineSdk } from '../agents/codex/runtime/offline-provider-context.mjs';
import { offlineNativeWorkflow } from './fixtures/native-workflow-provider.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BENCHMARK = path.join(ROOT, 'benchmarks', 'sentinel-todo');
// The prepare CLI must run from an owned, isolated source checkout.
// TMPDIR remains inside the real repository; it is not an authorized workspace of ROOT.
const source = await allocateOfflineFixture(ROOT);
after(() => finishOfflineFixture(source));
const CLI_ROOT = source.root;
const RUNTIME = path.join(CLI_ROOT, 'benchmarks/sentinel-todo/runtime/benchmark.mjs');
const ENVIRONMENT_RUNTIME = path.join(BENCHMARK, 'runtime', 'benchmark-environment.mjs');
const SEED = path.join(BENCHMARK, 'seed');
const SHA = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: CLI_ROOT, encoding: 'utf8', shell: false }).stdout.trim();
const PHASES = ['SPEC', 'PLAN', 'TASKS', 'EXECUTE', 'REVIEW_VALIDATE'];
const CURRENT_PROFILE = 'production-v3';

function run(command, args, cwd = ROOT) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Nested Node tests must discover and execute the candidate suite.
  return spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: false, timeout: 60_000 });
}

function cli(args) {
  return run(process.execPath, [RUNTIME, ...args], CLI_ROOT);
}

function requireSuccess(result, label) {
  assert.equal(result.status, 0, `${label}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return result;
}

async function temporaryRoot(t, label) {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), `${label} ü `));
  const root = await fs.realpath(created);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function event(journal, operation, phase, model, effort, result = 'PASS', extra = []) {
  return cli([
    'journal-event', '--journal', journal, '--operation', operation, '--phase', phase,
    '--model', model, '--effort', effort, '--result', result, ...extra,
  ]);
}

async function initJournal(file, caseId = 'A', runMode = 'case') {
  requireSuccess(cli([
    'journal-init', '--output', file, '--case', caseId, '--sentinel-sha', SHA,
    '--run-mode', runMode, '--production-profile', CURRENT_PROFILE,
  ]), 'journal-init');
  const journal = await readJson(file);
  journal.schemaVersion = 1;
  await fs.writeFile(file, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
}

async function initV2Journal(file, caseId = 'C', runMode = 'case') {
  requireSuccess(cli([
    'journal-init', '--output', file, '--case', caseId, '--sentinel-sha', SHA,
    '--run-mode', runMode, '--production-profile', CURRENT_PROFILE,
  ]), 'v2 journal-init');
}

function readinessArgs(scope, hash = `sha256:${'a'.repeat(64)}`) {
  return ['--readiness-scope', scope, '--readiness-snapshot-sha256', hash];
}

// Existing scripted authors/judges exercise public current producers and receipts.
// This is structural offline evidence, never a claim about real model quality.
async function currentCase(t, { caseId = 'A', authoredCaseId = caseId, fault = null, maxOperations = null } = {}) {
  const manager = await import(pathToFileURL(path.join(CLI_ROOT, 'benchmarks/sentinel-todo/runtime/benchmark-manager.mjs')));
  const { createNativeProvider } = await import(pathToFileURL(path.join(CLI_ROOT, 'agents/codex/runtime/native-provider.mjs')));
  const sdk = await describeOfflineSdk(await fs.realpath(path.join(ROOT, 'agents/codex/node_modules')), CLI_ROOT);
  let backend;
  t.after(async () => { await backend?.settled(); backend = null; });
  const before = new Set(await fs.readdir(path.join(CLI_ROOT, 'benchmark-temp')).catch(e => { if(e.code === 'ENOENT') return []; throw e; }));
  const offline = { mode: 'OFFLINE_TEST_ONLY', sdk, createNativeProvider: async args => {
    backend = offlineNativeWorkflow({ ...args, caseRoot: args.evidenceRoot, caseId: authoredCaseId, fault });
    return createNativeProvider({ ...args, rpc: backend.rpc, pollMs: 1 });
  } };
  const context = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  try { await manager.main(['run', '--case', caseId, '--json', ...(maxOperations === null ? [] : ['--max-operations', String(maxOperations)])], { offline }); }
  finally { if(context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
  await backend.settled();
  const names = (await fs.readdir(path.join(CLI_ROOT, 'benchmark-temp'))).filter(n => n.startsWith('run-') && !before.has(n));
  assert.equal(names.length, 1);
  const caseRoot = path.join(CLI_ROOT, 'benchmark-temp', names[0], `case-${caseId.toLowerCase()}`);
  const state = await readJson(path.join(caseRoot, 'case-state.json'));
  const workspace = path.join(caseRoot, 'workspace'), spec = state.specPath, journal = path.join(caseRoot, 'journal.json');
  const terminal = path.join(caseRoot, 'terminal-evidence.json');
  return { caseRoot, state, workspace, spec, journal, raw: await readJson(path.join(caseRoot, 'raw.json')),
    finalize: (selectedJournal, output, terminalFile = terminal) => cli([
      'finalize', '--workspace', workspace, '--case', caseId, '--spec', spec,
      '--journal', selectedJournal, '--output', output, ...(terminalFile === null ? [] : ['--terminal-evidence', terminalFile]),
    ]) };
}

async function changedJournal(root, label, original, mutate) {
  const value = await readJson(original); mutate(value);
  value.events.forEach((entry, index) => { entry.index = index + 1; });
  // Keep native case-state/ledger adjacency: a missing neighbour is not the intended negative.
  const file = path.join(path.dirname(original), `${label}-journal.json`);
  await fs.writeFile(file, JSON.stringify(value)); return file;
}

async function refusesFinalization(image, journal, output, terminal) {
  const result = image.finalize(journal, output, terminal);
  assert.equal(result.error, undefined, 'spawn failure is not a contract refusal');
  assert.equal(result.signal, null, 'signal/OOM is not a contract refusal');
  assert.ok(Number.isInteger(result.status) && result.status !== 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /ENOENT|case state is unreadable|timed out/u, 'fixture failure is not the tested refusal');
  const document = await readJson(output).catch(e => { if(e.code === 'ENOENT') return null; throw e; });
  assert.notEqual(document?.status, 'PASS', 'invalid proof cannot create a PASS report');
  return document;
}

test('B01 — manifest has bounded cases, profiles, paths, and schemas', async () => {
  const configuration = await readJson(path.join(BENCHMARK, 'benchmark.json'));
  assert.equal(configuration.benchmarkId, 'sentinel-todo');
  assert.equal(configuration.benchmarkVersion, 1);
  assert.equal(configuration.productionProfile.id, CURRENT_PROFILE);
  assert.deepEqual(configuration.cases.map((entry) => entry.id), ['A', 'B', 'C']);
  assert.equal(new Set(configuration.cases.map((entry) => entry.id)).size, 3);
  for (const item of configuration.cases) {
    await fs.access(path.join(BENCHMARK, item.sourcePath));
    assert.deepEqual(Object.keys(configuration.productionProfile.cases[item.id]), PHASES);
    for (const dispatch of Object.values(configuration.productionProfile.cases[item.id])) {
      assert.match(dispatch.model, /^GPT-6(?:\.1-Sol|-(?:Astra|Luna))$/u);
      assert.ok(['low', 'medium', 'high', 'xhigh'].includes(dispatch.effort));
    }
    for (const budget of Object.values(item.budgets)) assert.ok(Number.isInteger(budget) && budget > 0 && budget <= 100);
  }
  for (const schema of Object.values(configuration.schemas)) await fs.access(path.join(BENCHMARK, schema));
  assert.equal(configuration.productionPilot.qualification.sandboxProbeEvidence,
    'benchmarks/sentinel-todo/qualification/sandbox-probe-v1.md');
  requireSuccess(cli(['verify']), 'benchmark verify');
});

test('B09 — production profile v3 is current and dispatch enforcement is deterministic', async (t) => {
  const configuration = await readJson(path.join(BENCHMARK, 'benchmark.json'));
  assert.equal(configuration.productionProfile.id, 'production-v3');
  for (const relative of ['schemas/journal.schema.json', 'schemas/result.schema.json']) {
    const schema = await readJson(path.join(BENCHMARK, relative));
    assert.deepEqual(schema.properties.productionProfileId.enum, ['production-v1', 'production-v2']);
  }
  for (const relative of ['schemas/journal-v2.schema.json', 'schemas/result-v2.schema.json']) {
    const schema = await readJson(path.join(BENCHMARK, relative));
    assert.deepEqual(schema.properties.productionProfileId.enum, ['production-v1', 'production-v2', 'production-v3']);
  }
  const journalSchema = await readJson(path.join(BENCHMARK, 'schemas/journal-v2.schema.json'));
  assert.deepEqual(journalSchema.$defs.event.properties.model.enum,
    ['GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-6-Luna', 'GPT-6.1-Sol', 'GPT-6-Astra']);
  assert.deepEqual(configuration.productionProfile.cases.A, {
    SPEC: { model: 'GPT-6.1-Sol', effort: 'medium' },
    PLAN: { model: 'GPT-6.1-Sol', effort: 'medium' },
    TASKS: { model: 'GPT-6-Luna', effort: 'high' },
    EXECUTE: { model: 'GPT-6.1-Sol', effort: 'medium' },
    REVIEW_VALIDATE: { model: 'GPT-6-Luna', effort: 'high' },
  });
  assert.deepEqual(configuration.productionProfile.cases.B, {
    SPEC: { model: 'GPT-6.1-Sol', effort: 'high' },
    PLAN: { model: 'GPT-6.1-Sol', effort: 'medium' },
    TASKS: { model: 'GPT-6.1-Sol', effort: 'medium' },
    EXECUTE: { model: 'GPT-6-Luna', effort: 'high' },
    REVIEW_VALIDATE: { model: 'GPT-6.1-Sol', effort: 'medium' },
  });
  assert.deepEqual(configuration.productionProfile.cases.C, {
    SPEC: { model: 'GPT-6-Astra', effort: 'high' },
    PLAN: { model: 'GPT-6.1-Sol', effort: 'high' },
    TASKS: { model: 'GPT-6.1-Sol', effort: 'high' },
    EXECUTE: { model: 'GPT-6.1-Sol', effort: 'high' },
    REVIEW_VALIDATE: { model: 'GPT-6-Astra', effort: 'high' },
  });
  for (const { budgets } of configuration.cases) assert.deepEqual(budgets, {
    maxReviewPlanEvents: 5, maxReviewTasksEvents: 2, maxReplans: 1,
    maxExecuteSliceAttemptsPerSlice: 5, maxApplyFindingsPerSlice: 4, maxWorkflowEvents: 48,
  });
  assert.deepEqual(configuration.cases.map(({ id, requirementsHash, fixtureContentHash }) => ({ id, requirementsHash, fixtureContentHash })), [
    { id: 'A', requirementsHash: 'sha256:e5934bc22267756c3c10b31c46b7a9cd894b78e961b11975b0f14f7085349a24', fixtureContentHash: 'sha256:e0c3233c14356e93accff61b334704a91fb8e4f82a60209768259144d88a10d5' },
    { id: 'B', requirementsHash: 'sha256:0388a84f8c5a9c45fcd5b1d0b59e7d376979e98717d8e028067701f00a16fc57', fixtureContentHash: 'sha256:107d1057e48506a20da4460ee33febca26280dd35c85f645b0de6b81ffb33e10' },
    { id: 'C', requirementsHash: 'sha256:a896026d591f06776ade1d88fde292c4e5f0d015e5e18374e9cf754ecce4efcb', fixtureContentHash: 'sha256:a9700e1844ce7106809491f924b0fea37d8bf15700afa14c920cc1ee139fdd44' },
  ]);
  assert.equal(configuration.integrity.seedContentHash, 'sha256:9d93fbfa52b2e20607452f43d0ecb21e74f1872bb7a2da1b94dc2c814e7552e8');

  const root = await temporaryRoot(t, 'sentinel production profile v3');
  const image = await currentCase(t);
  assert.equal(image.state.status, 'PASS');
  assert.equal(image.raw.productionProfileId, 'production-v3');
  assert.deepEqual(image.raw.modelUse.profileMismatches, []);
  const journal = await changedJournal(root, 'mismatch', image.journal, value => {
    for(const entry of value.events) if(entry.phase === 'SPEC') entry.model = 'GPT-5.6-Terra';
  });
  const output = path.join(root, 'mismatch.json');
  requireSuccess(image.finalize(journal, output), 'profile mismatch is measured, never invented as model use');
  const result = await readJson(output);
  assert.ok(result.modelUse.profileMismatches.length >= 2);
  assert.ok(result.modelUse.profileMismatches.every(entry => entry.actualModel === 'GPT-5.6-Terra'));
});

test('B10 — v2 maturation lifecycle records global readiness and promotion', async (t) => {
  const root = await temporaryRoot(t, 'sentinel-benchmark-v2');
  const journal = path.join(root, 'v2.json');
  await initV2Journal(journal);
  requireSuccess(event(journal, 'SPEC_INIT', 'SPEC', 'GPT-5.6-Sol', 'high', 'PASS', ['--resulting-state', 'SPEC_DRAFT']), 'v2 init');
  const finding = [...readinessArgs('GLOBAL'), '--resulting-state', 'GLOBAL_FINDINGS'];
  requireSuccess(event(journal, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'NEEDS_FIX', finding), 'v2 global findings');
  requireSuccess(event(journal, 'SPEC_RESUME', 'SPEC', 'GPT-5.6-Sol', 'high', 'PASS', ['--resulting-state', 'SPEC_DRAFT']), 'v2 resume');
  requireSuccess(event(journal, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'PASS', [...readinessArgs('GLOBAL'), '--resulting-state', 'GLOBAL_READY']), 'v2 global ready');
  requireSuccess(event(journal, 'SPEC_PROMOTE', 'SPEC', 'GPT-5.6-Sol', 'high', 'PASS', ['--resulting-state', 'SPEC_READY']), 'v2 promote');
  const parsed = await readJson(journal);
  assert.equal(parsed.schemaVersion, 2);
  assert.equal(parsed.events.at(-1).operation, 'SPEC_PROMOTE');
});

test('B11 — v2 rejects premature PLAN, LOCAL approval, promotion, terminal readiness, and early close', async (t) => {
  const root = await temporaryRoot(t, 'sentinel-benchmark-v2-invalid');
  const journal = path.join(root, 'v2.json');
  await initV2Journal(journal);
  requireSuccess(event(journal, 'SPEC_INIT', 'SPEC', 'GPT-5.6-Sol', 'high', 'PASS', ['--resulting-state', 'SPEC_DRAFT']), 'v2 init');
  assert.notEqual(event(journal, 'PLAN', 'PLAN', 'GPT-5.6-Terra', 'high').status, 0);
  assert.notEqual(event(journal, 'SPEC_PROMOTE', 'SPEC', 'GPT-5.6-Sol', 'high', 'PASS', ['--resulting-state', 'SPEC_READY']).status, 0);
  assert.notEqual(event(journal, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'PASS', [...readinessArgs('LOCAL'), '--resulting-state', 'GLOBAL_READY']).status, 0);
  requireSuccess(event(journal, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'NEEDS_FIX', [...readinessArgs('GLOBAL'), '--resulting-state', 'GLOBAL_FINDINGS']), 'v2 findings');
  requireSuccess(event(journal, 'SPEC_RESUME', 'SPEC', 'GPT-5.6-Sol', 'high', 'PASS', ['--resulting-state', 'SPEC_READY']), 'v2 resume');
  requireSuccess(event(journal, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'PASS', [...readinessArgs('GLOBAL'), '--resulting-state', 'GLOBAL_READY']), 'v2 ready');
  requireSuccess(event(journal, 'PLAN', 'PLAN', 'GPT-5.6-Terra', 'high'), 'v2 plan');
  assert.notEqual(event(journal, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high', 'PASS', [...readinessArgs('GLOBAL'), '--resulting-state', 'GLOBAL_READY']).status, 0);
  assert.notEqual(event(journal, 'SPEC_CLOSE', 'SPEC', 'GPT-5.6-Sol', 'high', 'PASS', ['--resulting-state', 'SPEC_CLOSED']).status, 0);
});

test('v2 journal records only marked Initial handoff re-delivery before independent review',async t=>{
  const root=await temporaryRoot(t,'sentinel-plan-redelivery-journal'),journal=path.join(root,'journal.json');
  await initV2Journal(journal);
  requireSuccess(event(journal,'SPEC_INIT','SPEC','GPT-6.1-Sol','medium','PASS',['--resulting-state','SPEC_READY']),'init');
  requireSuccess(event(journal,'PLAN','PLAN','GPT-6-Luna','high','NEEDS_FIX',['--resulting-state','NO_EXECUTION']),'missing delivery');
  const before=await fs.readFile(journal);
  for(const args of [
    ['PLAN','PLAN','PASS',['--resulting-state','NO_EXECUTION']],
    ['REVIEW_PLAN','REVIEW_VALIDATE','PASS',['--resulting-state','MATERIALIZED_PRISTINE']],
    ['EXECUTE_SLICE','EXECUTE','PASS',['--slice','slice-01']],
  ])assert.notEqual(event(journal,args[0],args[1],'GPT-6-Luna','high',args[2],args[3]).status,0);
  assert.deepEqual(await fs.readFile(journal),before,'no acceptance or phase advance from a missing handoff');
  requireSuccess(event(journal,'PLAN','PLAN','GPT-6-Luna','high','NEEDS_FIX',['--resulting-state','NO_EXECUTION','--retry','true']),'first correction');
  requireSuccess(event(journal,'PLAN','PLAN','GPT-6-Luna','high','PASS',['--resulting-state','NO_EXECUTION','--retry','true']),'literal delivery');
  requireSuccess(event(journal,'REVIEW_PLAN','REVIEW_VALIDATE','GPT-6-Luna','high','PASS',['--resulting-state','MATERIALIZED_PRISTINE']),'independent review');
  const saved=await readJson(journal);assert.equal(saved.events.filter(e=>e.retry===true).length,2);
  assert.equal(saved.events.filter(e=>e.result==='NEEDS_FIX').length,2);
});

test('v2 journal admits bounded contiguous refused Initial review corrections', async t => {
  const root = await temporaryRoot(t, 'sentinel-review-correction-journal'), journal = path.join(root, 'journal.json');
  await initV2Journal(journal);
  requireSuccess(event(journal, 'SPEC_INIT', 'SPEC', 'GPT-6.1-Sol', 'medium', 'PASS', ['--resulting-state', 'SPEC_READY']), 'init');
  requireSuccess(event(journal, 'PLAN', 'PLAN', 'GPT-6-Luna', 'high', 'PASS', ['--resulting-state', 'NO_EXECUTION']), 'initial plan');
  assert.notEqual(event(journal, 'PLAN', 'PLAN', 'GPT-6-Luna', 'high', 'PASS', ['--resulting-state', 'NO_EXECUTION']).status, 0,
    'a repeated PLAN without a refused review remains illegal');
  requireSuccess(event(journal, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-6-Luna', 'high', 'NEEDS_FIX', ['--resulting-state', 'NO_EXECUTION']), 'first refusal');
  const refusedBytes = await fs.readFile(journal);
  assert.notEqual(event(journal, 'EXECUTE_SLICE', 'EXECUTE', 'GPT-6-Luna', 'high', 'PASS', ['--slice', 'slice-01']).status, 0);
  assert.notEqual(event(journal, 'PLAN', 'PLAN', 'GPT-6-Luna', 'high', 'PASS', ['--resulting-state', 'EXECUTION_STARTED']).status, 0);
  assert.ok(refusedBytes.equals(await fs.readFile(journal)), 'invalid transitions preserve prior refusal bytes');
  requireSuccess(event(journal, 'PLAN', 'PLAN', 'GPT-6-Luna', 'high', 'PASS', ['--resulting-state', 'NO_EXECUTION']), 'author correction');
  for(let correction=2; correction<=4; correction++) {
    requireSuccess(event(journal, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-6-Luna', 'high', 'NEEDS_FIX', ['--resulting-state', 'NO_EXECUTION']), `refusal ${correction}`);
    requireSuccess(event(journal, 'PLAN', 'PLAN', 'GPT-6-Luna', 'high', 'PASS', ['--resulting-state', 'NO_EXECUTION']), `author correction ${correction}`);
  }
  requireSuccess(event(journal, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-6-Luna', 'high', 'PASS', ['--resulting-state', 'MATERIALIZED_PRISTINE']), 'new review');
  assert.notEqual(event(journal, 'PLAN', 'PLAN', 'GPT-6-Luna', 'high', 'PASS', ['--resulting-state', 'NO_EXECUTION']).status, 0);
  assert.equal((await readJson(journal)).events[2].result, 'NEEDS_FIX');
});

test('B12 — current v2 finalization requires immediate close and reports maturation cycles', async t => {
  const root = await temporaryRoot(t, 'sentinel-current-finalization');
  const image = await currentCase(t);
  assert.equal(image.raw.schemaVersion, 2);
  assert.equal(image.raw.operations.maturationCycles, 0);
  assert.equal(image.raw.status, 'PASS');
  const journal = await readJson(image.journal);
  assert.deepEqual(journal.events.map(entry => entry.operation),
    ['SPEC_INIT', 'PLAN', 'REVIEW_PLAN', 'EXECUTE_SLICE', 'VALIDATE_SLICE', 'SPEC_CLOSE']);
  const bytes = await fs.readFile(image.journal);
  for (const operation of ['SPEC_CLOSE', 'SPEC_READINESS', 'EXECUTE_SLICE']) {
    assert.notEqual(event(image.journal, operation, operation === 'SPEC_CLOSE' ? 'SPEC' : operation === 'EXECUTE_SLICE' ? 'EXECUTE' : 'REVIEW_VALIDATE',
      'GPT-6-Luna', 'high', 'PASS', operation === 'EXECUTE_SLICE' ? ['--slice', 'slice-01'] : ['--resulting-state', 'SPEC_CLOSED']).status, 0);
    assert.deepEqual(await fs.readFile(image.journal), bytes, 'terminal events cannot be followed or duplicated');
  }
  const late = await changedJournal(root, 'late', image.journal, value => value.events.push({ ...value.events[0] }));
  await refusesFinalization(image, late, path.join(root, 'late.json'));
});

test('B02 — seed is dependency-free, complete, and green', async () => {
  const packageDocument = await readJson(path.join(SEED, 'package.json'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(packageDocument[field], undefined);
  }
  for (const relative of [
    'README.md', 'src/todo-service.mjs', 'src/todo-store.mjs', 'src/validation.mjs', 'src/cli.mjs',
    'test/todo-service.test.mjs', 'test/todo-store.test.mjs', 'test/cli.test.mjs',
  ]) await fs.access(path.join(SEED, relative));
  requireSuccess(run(process.execPath, ['--test'], SEED), 'seed tests');
});

test('B03 — Cases are independent requirements sources without profile or rubric leakage', async () => {
  const configuration = await readJson(path.join(BENCHMARK, 'benchmark.json'));
  const sources = [];
  for (const item of configuration.cases) {
    const text = await fs.readFile(path.join(BENCHMARK, item.sourcePath), 'utf8');
    sources.push(text);
    assert.doesNotMatch(text, /GPT|Terra|Luna|Sol|production-v1|benchmark rubric|expected (?:slice|task)/iu);
  }
  assert.equal(new Set(sources).size, 3);
  assert.doesNotMatch(sources[1], /--completed|--pending|archive|unarchive/iu);
  assert.doesNotMatch(sources[2], /priority|--completed|--pending/iu);
});

test('B04 — prepare is reproducible, isolated, locally configured, and clean', async (t) => {
  const root = await temporaryRoot(t, 'sentinel benchmark prepare');
  const seedBefore = await import(`file://${RUNTIME}`).then((module) => module.contentHash(SEED));
  const outputs = {};
  for (const name of ['A-one', 'A-two', 'B-one', 'C-one']) {
    const caseId = name[0];
    const output = path.join(root, name);
    const prepared = requireSuccess(cli(['prepare', '--case', caseId, '--output', output]), `prepare ${name}`);
    outputs[name] = JSON.parse(prepared.stdout);
    assert.equal(outputs[name].gitWorkingTreeClean, true);
    assert.equal(outputs[name].gitConfigLocal, true);
    const specsParent = await fs.lstat(path.join(output, 'specs'));
    assert.equal(specsParent.isDirectory(), true);
    assert.equal(specsParent.isSymbolicLink(), false);
    assert.deepEqual(await fs.readdir(path.join(output, 'specs')), []);
    assert.equal((await fs.lstat(outputs[name].specPath).catch(() => null)), null);
    assert.deepEqual(
      await fs.readFile(path.join(output, 'requirements.md')),
      await fs.readFile(path.join(BENCHMARK, (await readJson(path.join(BENCHMARK, 'benchmark.json'))).cases.find((entry) => entry.id === caseId).sourcePath)),
    );
    assert.equal(run('git', ['status', '--porcelain=v1'], output).stdout, '');
    assert.equal(run('git', ['config', '--local', '--get', 'user.email'], output).stdout.trim(), 'benchmark@sentinel.invalid');
    for (const leaked of ['benchmark.json', 'schemas', 'cases', '.sentinel-benchmark']) {
      assert.equal(await fs.lstat(path.join(output, leaked)).catch(() => null), null);
    }
  }
  assert.equal(outputs['A-one'].contentHash, outputs['A-two'].contentHash);
  const seedAfter = await import(`file://${RUNTIME}`).then((module) => module.contentHash(SEED));
  assert.equal(seedBefore, seedAfter);
  assert.equal(cli(['prepare', '--case', 'A', '--output', path.join(CLI_ROOT, 'benchmarks', 'forbidden-workspace')]).status, 2);
  assert.equal(await fs.lstat(path.join(CLI_ROOT, 'benchmarks', 'forbidden-workspace')).catch(() => null), null);
  assert.equal(cli(['prepare', '--case', 'A', '--output', path.join(root, 'A-one')]).status, 2);
  assert.equal(cli(['prepare', '--case', 'A', '--output', path.join(CLI_ROOT, 'tmp/unowned-workspace')]).status, 2);
  assert.equal(await fs.lstat(path.join(CLI_ROOT, 'tmp/unowned-workspace')).catch(() => null), null);
});

test('B05 — journal persists actual dispatches, optional telemetry, children, and budget aborts', async (t) => {
  const root = await temporaryRoot(t, 'sentinel benchmark journal');
  const journal = path.join(root, 'journal.json');
  await initJournal(journal);
  assert.equal(cli([
    'journal-init', '--output', path.join(root, 'wrong-sha.json'), '--case', 'A',
    '--sentinel-sha', '0'.repeat(40), '--run-mode', 'case', '--production-profile', CURRENT_PROFILE,
  ]).status, 1);
  requireSuccess(event(journal, 'SPEC_INIT', 'SPEC', 'GPT-5.6-Terra', 'high', 'PASS', [
    '--input-tokens', '10', '--output-tokens', '5', '--child-role', 'spec-context-scout',
    '--child-model', 'GPT-5.6-Luna', '--child-effort', 'medium',
  ]), 'journal event with child');
  const invalid = event(journal, 'PLAN', 'PLAN', 'Unknown', 'high');
  assert.equal(invalid.status, 2);
  const persisted = await readJson(journal);
  assert.equal(persisted.events.length, 1);
  assert.equal(persisted.events[0].model, 'GPT-5.6-Terra');
  assert.equal(persisted.events[0].inputTokens, 10);
  assert.deepEqual(persisted.events[0].childDispatches[0], {
    role: 'spec-context-scout', model: 'GPT-5.6-Luna', effort: 'medium',
  });

  const mappingJournal = path.join(root, 'mapping.json');
  await initJournal(mappingJournal);
  requireSuccess(event(mappingJournal, 'SPEC_INIT', 'SPEC', 'GPT-5.6-Terra', 'high'), 'mapped SPEC_INIT');
  assert.equal(event(mappingJournal, 'SPEC_INIT', 'REVIEW_VALIDATE', 'GPT-5.6-Terra', 'high').status, 2);
  requireSuccess(event(mappingJournal, 'SPEC_READINESS', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), 'mapped SPEC_READINESS');
  assert.equal(event(mappingJournal, 'SPEC_READINESS', 'SPEC', 'GPT-5.6-Luna', 'high').status, 2);
  requireSuccess(event(mappingJournal, 'SPEC_CLOSE', 'SPEC', 'GPT-5.6-Terra', 'high'), 'mapped SPEC_CLOSE');
  assert.equal(event(mappingJournal, 'SPEC_CLOSE', 'REVIEW_VALIDATE', 'GPT-5.6-Terra', 'high').status, 2);

  const budgetJournal = path.join(root, 'budget.json');
  await initJournal(budgetJournal);
  for(let round=1; round<=5; round++) requireSuccess(event(budgetJournal, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high'), `review ${round}`);
  assert.equal(event(budgetJournal, 'REVIEW_PLAN', 'REVIEW_VALIDATE', 'GPT-5.6-Luna', 'high').status, 3);
  const aborted = await readJson(budgetJournal);
  assert.equal(aborted.status, 'ABORTED_BUDGET');
  assert.equal(aborted.abortReason.budget, 'maxReviewPlanEvents');
  assert.equal(aborted.events.length, 6);
  assert.equal(aborted.abortReason.limit, 5);
  assert.equal(aborted.abortReason.observed, 6);
  assert.equal(event(budgetJournal, 'PLAN', 'PLAN', 'GPT-5.6-Terra', 'high').status, 3);
});

test('B06 — finalize collects current raw facts and enforces official terminal semantics', async t => {
  const root = await temporaryRoot(t, 'sentinel-current-terminal');
  const image = await currentCase(t, { fault: 'findings-cycle' });
  const result = image.raw;
  assert.equal(result.status, 'PASS');
  assert.equal(result.finalExecutionState, 'SPEC_CLOSED');
  assert.equal(result.specClosed, true); assert.equal(result.finalTestsPassed, true);
  assert.equal(result.productAcceptance.passed, true);
  assert.equal(result.decomposition.slices, 1); assert.equal(result.decomposition.tasks, 1);
  assert.deepEqual(result.decomposition.tasksPerSlice, { 'slice-01': 1 });
  assert.equal(result.operations.applyFindingsCalls, 1);
  assert.equal(result.operations.validateCalls, 2);
  assert.equal(result.contextCost.actualTokenTelemetryAvailable, false);
  assert.equal(result.contextCost.inputTokens, null);
  assert.ok(result.contextCost.planBytes > 0 && result.contextCost.tasksWords > 0);
  assert.ok((await readJson(image.journal)).events.some(entry => entry.result === 'NEEDS_FIX'));
  // A valid product and closed SPEC do not replace the journal/terminal proof.
  for(const [name, mutate] of [
    ['missing-complete', value => { value.events.find(entry => entry.operation === 'VALIDATE_SLICE' && entry.result === 'PASS').resultingState = null; }],
    ['missing-close', value => { value.events.pop(); }],
    ['regressed-after-complete', value => { const close = value.events.pop(); value.events.push({ ...value.events.at(-1), result: 'NEEDS_FIX', resultingState: 'NEEDS_FIX' }, close); }],
    ['duplicate-close', value => { value.events.push({ ...value.events.at(-1) }); }],
    ['late-readiness', value => { value.events.push({ ...value.events[0], operation: 'SPEC_READINESS', phase: 'REVIEW_VALIDATE', resultingState: 'GLOBAL_READY' }); }],
    ['wrong-sha', value => { value.sentinelSha = '0'.repeat(40); }],
    ['budget', value => { value.status = 'ABORTED_BUDGET'; value.abortReason = { code: 'BUDGET_EXCEEDED', budget: 'maxReviewPlanEvents', limit: 5, observed: 6, eventIndex: 1 }; }],
    ['blocked', value => { value.events.at(-1).result = 'BLOCKED'; value.events.at(-1).resultingState = null; }],
  ]) {
    const journal = await changedJournal(root, name, image.journal, mutate);
    await refusesFinalization(image, journal, path.join(root, `${name}.json`));
  }
  await refusesFinalization(image, image.journal, path.join(root, 'no-terminal-proof.json'), null);
  const corrupt = path.join(root, 'corrupt-terminal.json'); await fs.writeFile(corrupt, '{}');
  await refusesFinalization(image, image.journal, path.join(root, 'corrupt-proof.json'), corrupt);
  const feature = path.join(image.spec, 'feature_spec.md'), featureBytes = await fs.readFile(feature);
  try {
    for(const status of ['ready', 'invalid']) {
      await fs.writeFile(feature, featureBytes.toString().replace('status: closed', `status: ${status}`));
      await refusesFinalization(image, image.journal, path.join(root, `not-closed-${status}.json`));
    }
  } finally { await fs.writeFile(feature, featureBytes); }
  const changedFile = path.join(image.workspace, 'src/cli.mjs'), sourceBytes = await fs.readFile(changedFile);
  try {
    await fs.appendFile(changedFile, '\n// post-PASS drift\n');
    await refusesFinalization(image, image.journal, path.join(root, 'post-pass-drift.json'));
  } finally { await fs.writeFile(changedFile, sourceBytes); }
  const requirements = path.join(image.workspace, 'requirements.md'), requirementBytes = await fs.readFile(requirements);
  try {
    await fs.appendFile(requirements, '\nAltered requirement.\n');
    const drift = await refusesFinalization(image, image.journal, path.join(root, 'requirements-drift.json'));
    if(drift) assert.equal(drift.workspace.requirementsHashMatches, false);
  } finally { await fs.writeFile(requirements, requirementBytes); }
  const prior = await fs.readFile(path.join(image.caseRoot, 'raw.json'));
  assert.deepEqual(JSON.parse(prior), result, 'negative exports do not rewrite the accepted report');
});

test('B13 — independent A/B product evidence complements internal tests and Sentinel gates', async t => {
  const root = await temporaryRoot(t, 'sentinel-product-oracle');
  // Deliberately author A in B: current mechanical receipts and green tests cannot prove B priority.
  const wrong = await currentCase(t, { caseId: 'B', authoredCaseId: 'A' });
  assert.equal(wrong.raw.finalTestsPassed, true);
  assert.equal(wrong.raw.specClosed, true);
  assert.equal(wrong.raw.productAcceptance.caseId, 'B');
  assert.equal(wrong.raw.productAcceptance.passed, false);
  assert.equal(wrong.raw.status, 'FAIL');
  // A fresh execution proves the correct version; no reuse of a pre-mutation PASS.
  const correct = await currentCase(t, { caseId: 'B' });
  assert.equal(correct.raw.status, 'PASS'); assert.equal(correct.raw.productAcceptance.passed, true);
  const compared = requireSuccess(cli(['compare', '--before', path.join(wrong.caseRoot, 'raw.json'),
    '--after', path.join(correct.caseRoot, 'raw.json')]), 'independent product facts');
  assert.match(compared.stdout, /\| Product acceptance passed \| false \| true \|/u);
  const before = await fs.readFile(path.join(correct.caseRoot, 'raw.json'));
  const failedTest = path.join(correct.workspace, 'test/failing.test.mjs');
  try {
    await fs.writeFile(failedTest, "import test from 'node:test'; test('failure', () => { throw new Error('fixture failure'); });\n");
    const failed = await refusesFinalization(correct, correct.journal, path.join(root, 'failing-test.json'));
    if(failed) assert.equal(failed.finalTestsPassed, false);
  } finally { await fs.rm(failedTest); }
  const unclosed = await changedJournal(root, 'missing-close', correct.journal, value => value.events.pop());
  await refusesFinalization(correct, unclosed, path.join(root, 'unclosed.json'));
  assert.deepEqual(await fs.readFile(path.join(correct.caseRoot, 'raw.json')), before);
  const partial = await currentCase(t, { caseId: 'B', maxOperations: 3 });
  assert.equal(partial.state.status, 'FOCAL_STOP');
  assert.equal(partial.raw.productAcceptance, null);
  assert.equal(partial.raw.runMode, 'focal');
  assert.equal(partial.raw.specClosed, false);
  const schema1 = await readJson(path.join(BENCHMARK, 'schemas/result.schema.json'));
  const schema2 = await readJson(path.join(BENCHMARK, 'schemas/result-v2.schema.json'));
  assert.equal(schema1.properties.productAcceptance.$ref, '#/$defs/productAcceptance');
  assert.equal(schema2.properties.productAcceptance.$ref, 'result.schema.json#/$defs/productAcceptance');
  assert.ok(!schema1.required.includes('productAcceptance'), 'historical absence is not positive product evidence');
});

function syntheticResult(caseId, offset, telemetry) {
  const expectedProfile = Object.fromEntries(PHASES.map((phase) => [phase, { model: 'GPT-5.6-Terra', effort: 'high' }]));
  const actualModelsByPhase = Object.fromEntries(PHASES.map((phase) => [phase, [offset === 0 ? 'GPT-5.6-Terra' : 'GPT-5.6-Luna']]));
  const actualEffortsByPhase = Object.fromEntries(PHASES.map((phase) => [phase, [offset === 0 ? 'high' : 'xhigh']]));
  return {
    schemaVersion: 1,
    benchmarkVersion: 1,
    benchmarkId: 'sentinel-todo',
    caseId,
    runMode: 'case',
    sentinelSha: SHA,
    productionProfileId: 'production-v1',
    status: 'FAIL', // Diagnostic comparison, deliberately unqualified without product evidence.
    finalExecutionState: 'COMPLETE',
    specClosed: true,
    finalTestsPassed: true,
    decomposition: { slices: 1 + offset, tasks: 2 + offset, tasksPerSlice: { 'slice-01': 2 + offset } },
    operations: {
      total: 8 + offset, reviewPlanRounds: 1 + offset, reviewTasksRounds: 1,
      replans: offset, executeCalls: 1 + offset, validateCalls: 1 + offset,
      applyFindingsCalls: offset, findingsCycles: offset, mechanicalRejections: offset, retries: offset,
    },
    modelUse: {
      expectedProfile, actualModelsByPhase, actualEffortsByPhase, childDispatches: [],
      profileMismatches: offset === 0 ? [] : [{
        eventIndex: 1,
        operation: 'PLAN',
        phase: 'PLAN',
        expectedModel: 'GPT-5.6-Terra',
        actualModel: 'GPT-5.6-Luna',
        expectedEffort: 'high',
        actualEffort: 'xhigh',
      }],
      solEscalations: 0,
    },
    contextCost: {
      planBytes: 100 + offset, planWords: 20 + offset, tasksBytes: 80 + offset,
      tasksWords: 15 + offset, handoffBytes: null, observableReads: null,
      actualTokenTelemetryAvailable: telemetry,
      inputTokens: telemetry ? 10 + offset : null,
      outputTokens: telemetry ? 5 + offset : null,
    },
    workspace: {
      changedFileCount: 3 + offset,
      finalDiffBytes: 200 + offset,
      seedContentHash: `sha256:${'a'.repeat(64)}`,
      requirementsHash: `sha256:${'b'.repeat(64)}`,
      requirementsHashMatches: true,
      observedSentinelSha: SHA,
      sentinelShaMatchesCheckout: true,
    },
    finalTests: { command: 'node --test', exitCode: 0, passed: true },
  };
}

test('B07 — compare reports deltas and dispatch changes without fabricated telemetry', async (t) => {
  const root = await temporaryRoot(t, 'sentinel benchmark compare');
  const beforePath = path.join(root, 'before.json');
  const afterPath = path.join(root, 'after.json');
  await fs.writeFile(beforePath, `${JSON.stringify(syntheticResult('A', 0, false), null, 2)}\n`, 'utf8');
  await fs.writeFile(afterPath, `${JSON.stringify(syntheticResult('A', 1, false), null, 2)}\n`, 'utf8');
  const compared = requireSuccess(cli(['compare', '--before', beforePath, '--after', afterPath]), 'compare');
  assert.match(compared.stdout, /\| slices \| 1 \| 2 \| 1 \|/u);
  assert.match(compared.stdout, /GPT-5\.6-Terra \/ high/u);
  assert.match(compared.stdout, /GPT-5\.6-Luna \/ xhigh/u);
  assert.doesNotMatch(compared.stdout, /inputTokens|outputTokens/iu);
  assert.doesNotMatch(compared.stdout, /score|winner/iu);
  assert.match(compared.stdout, /\| Product acceptance passed \| unavailable \| unavailable \|/u);
  const mismatchPath = path.join(root, 'other-case.json');
  await fs.writeFile(mismatchPath, `${JSON.stringify(syntheticResult('B', 1, true), null, 2)}\n`, 'utf8');
  assert.equal(cli(['compare', '--before', beforePath, '--after', mismatchPath]).status, 1);

  for (const [name, mutate, diagnosis] of [
    ['requirements', (result) => { result.workspace.requirementsHash = `sha256:${'c'.repeat(64)}`; }, /requirements hash/u],
    ['seed', (result) => { result.workspace.seedContentHash = `sha256:${'c'.repeat(64)}`; }, /seed content hash/u],
    ['profile', (result) => { result.productionProfileId = 'production-v2'; }, /production profile/u],
  ]) {
    const incompatible = syntheticResult('A', 1, false);
    mutate(incompatible);
    const incompatiblePath = path.join(root, `${name}-mismatch.json`);
    await fs.writeFile(incompatiblePath, `${JSON.stringify(incompatible, null, 2)}\n`, 'utf8');
    const rejected = cli(['compare', '--before', beforePath, '--after', incompatiblePath]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, diagnosis);
  }
});

test('B08 — doctor routing is offline and separate from benchmark definitions', async () => {
  const manifestPath = path.join(BENCHMARK, 'benchmark.json');
  const manifestBefore = await fs.readFile(manifestPath, 'utf8');
  assert.equal(cli(['doctor', '--unknown', 'value']).status, 2);
  assert.equal(cli(['doctor', '--scratch-parent']).status, 2);
  assert.equal(cli(['doctor', '--probe-workspace', ROOT]).status, 2);
  assert.equal(cli(['doctor', '--scratch-parent', path.join(CLI_ROOT, 'benchmarks')]).status, 2);

  const runtimeSource = await fs.readFile(RUNTIME, 'utf8');
  const source = await fs.readFile(ENVIRONMENT_RUNTIME, 'utf8');
  assert.match(runtimeSource, /command === 'doctor'/u);
  assert.match(runtimeSource, /runDoctor\(\{/u);
  for (const field of [
    'status', 'contractVersion', 'platform', 'arch', 'nodeVersion', 'gitVersion',
    'checks', 'globalGitConfigPreserved', 'blockers',
  ]) assert.match(source, new RegExp(`\\b${field}\\b`, 'u'));
  assert.match(source, /ENVIRONMENT_READY/u);
  assert.match(source, /ENVIRONMENT_BLOCKED/u);
  assert.doesNotMatch(source, /\b(?:fetch|https?|provider|openai)\b/iu);
  assert.doesNotMatch(source, /benchmark\.json|productionProfile|budgets|cases\//u);
  assert.equal(await fs.readFile(manifestPath, 'utf8'), manifestBefore);
});
