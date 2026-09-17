#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runDoctor, runProbeDoctor } from './benchmark-environment.mjs';

const RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK_ROOT = path.resolve(RUNTIME_ROOT, '..');
const REPOSITORY_ROOT = path.resolve(BENCHMARK_ROOT, '../..');
const MANIFEST_PATH = path.join(BENCHMARK_ROOT, 'benchmark.json');
const LIFECYCLE_VALIDATOR = path.join(
  REPOSITORY_ROOT,
  'skills', 'workflows', 'stnl-spec-lifecycle-manager', 'runtime', 'validate-spec-lifecycle.mjs',
);
const EXECUTION_VALIDATOR = path.join(
  REPOSITORY_ROOT,
  'skills', 'workflows', 'stnl-execution-planner', 'runtime', 'validate-execution-state.mjs',
);
const MODELS = new Set(['GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const PROFILE_IDS = new Set(['production-v1', 'production-v2']);
const RUN_MODES = new Set(['focal', 'case', 'full']);
const OPERATIONS = new Set([
  'SPEC_INIT', 'SPEC_READINESS', 'PLAN', 'REVIEW_PLAN', 'MATERIALIZE_TASKS',
  'REVIEW_TASKS', 'EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS', 'REPLAN', 'SPEC_CLOSE',
]);
const RESULTS = new Set(['PASS', 'FAIL', 'BLOCKED', 'NEEDS_FIX', 'REJECTED', 'COMPLETE']);
const PHASES = ['SPEC', 'PLAN', 'TASKS', 'EXECUTE', 'REVIEW_VALIDATE'];
const OPERATION_PHASE = new Map([
  ['SPEC_INIT', 'SPEC'], ['SPEC_READINESS', 'REVIEW_VALIDATE'], ['SPEC_CLOSE', 'SPEC'],
  ['PLAN', 'PLAN'], ['REPLAN', 'PLAN'],
  ['MATERIALIZE_TASKS', 'TASKS'],
  ['EXECUTE_SLICE', 'EXECUTE'], ['APPLY_FINDINGS', 'EXECUTE'],
  ['REVIEW_PLAN', 'REVIEW_VALIDATE'], ['REVIEW_TASKS', 'REVIEW_VALIDATE'], ['VALIDATE_SLICE', 'REVIEW_VALIDATE'],
]);
const IGNORED_NAMES = new Set(['.DS_Store', '__MACOSX']);
const BUDGET_EXIT = 3;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function ignored(name) {
  return IGNORED_NAMES.has(name) || name.startsWith('._');
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new CliError(`${label} must be an absolute path`, 2);
  return path.resolve(value);
}

function requireInteger(value, label, { minimum = 0 } = {}) {
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value) || Number(value) < minimum) {
    throw new CliError(`${label} must be an integer >= ${minimum}`, 2);
  }
  return Number(value);
}

function optionalInteger(value, label) {
  return value === undefined ? undefined : requireInteger(value, label);
}

function optionalBoolean(value, label) {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new CliError(`${label} must be true or false`, 2);
  return value === 'true';
}

function parseOptions(tokens, allowed, required = []) {
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.has(name) || value === undefined || value.startsWith('--')) {
      throw new CliError(`invalid or missing option value near ${name ?? '<end>'}`, 2);
    }
    if (Object.hasOwn(options, name)) throw new CliError(`duplicate option: ${name}`, 2);
    options[name] = value;
  }
  for (const name of required) if (!Object.hasOwn(options, name)) throw new CliError(`missing required option: ${name}`, 2);
  return options;
}

async function readJson(file, label) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    throw new CliError(`${label} is unreadable: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${label} is invalid JSON: ${error.message}`);
  }
}

async function atomicJson(file, value, { exclusive = false } = {}) {
  const target = path.resolve(file);
  if (exclusive) {
    await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      .catch((error) => { throw new CliError(`cannot create output: ${error.message}`); });
    return;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(temporary, target);
}

async function manifest() {
  return readJson(MANIFEST_PATH, 'benchmark manifest');
}

function caseConfig(configuration, caseId) {
  const found = configuration.cases.find((entry) => entry.id === caseId);
  if (!found) throw new CliError(`unknown case: ${caseId}`, 2);
  return found;
}

function assertManifest(configuration) {
  if (configuration.benchmarkId !== 'sentinel-todo' || configuration.benchmarkVersion !== 1) {
    throw new CliError('manifest benchmark identity is invalid');
  }
  if (configuration.seedPath !== 'seed' || configuration.productionProfile?.id !== 'production-v2') {
    throw new CliError('manifest seed or profile identity is invalid');
  }
  if (JSON.stringify(configuration.supportedRunModes) !== JSON.stringify(['focal', 'case', 'full'])) {
    throw new CliError('manifest run modes are invalid');
  }
  const ids = configuration.cases?.map((entry) => entry.id) ?? [];
  if (JSON.stringify(ids) !== JSON.stringify(['A', 'B', 'C']) || new Set(ids).size !== ids.length) {
    throw new CliError('manifest must define unique A/B/C cases');
  }
  for (const item of configuration.cases) {
    if (!/^specs\/benchmark-case-[a-c]$/u.test(item.specPath)) throw new CliError(`invalid SPEC_PATH for case ${item.id}`);
    if (!/^sha256:[0-9a-f]{64}$/u.test(item.requirementsHash)
      || !/^sha256:[0-9a-f]{64}$/u.test(item.fixtureContentHash)) {
      throw new CliError(`integrity hashes are invalid for case ${item.id}`);
    }
    for (const [name, value] of Object.entries(item.budgets ?? {})) {
      if (!Number.isInteger(value) || value <= 0 || value > 100) throw new CliError(`invalid budget ${name} for case ${item.id}`);
    }
    const expectedBudgets = [
      'maxReviewPlanEvents', 'maxReviewTasksEvents', 'maxReplans',
      'maxExecuteSliceAttemptsPerSlice', 'maxApplyFindingsPerSlice', 'maxWorkflowEvents',
    ];
    if (JSON.stringify(Object.keys(item.budgets ?? {})) !== JSON.stringify(expectedBudgets)) {
      throw new CliError(`budget contract is incomplete for case ${item.id}`);
    }
    const profile = configuration.productionProfile.cases?.[item.id];
    if (JSON.stringify(Object.keys(profile ?? {})) !== JSON.stringify(PHASES)) {
      throw new CliError(`profile phases are incomplete for case ${item.id}`);
    }
    for (const phase of PHASES) {
      if (!MODELS.has(profile[phase].model) || !EFFORTS.has(profile[phase].effort)) {
        throw new CliError(`invalid profile dispatch for case ${item.id} phase ${phase}`);
      }
    }
  }
  if (configuration.schemaVersions?.journal !== 1 || configuration.schemaVersions?.result !== 1) {
    throw new CliError('schema versions are invalid');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(configuration.integrity?.seedContentHash)) {
    throw new CliError('seed integrity hash is invalid');
  }
}

async function verify() {
  const configuration = await manifest();
  assertManifest(configuration);
  const paths = [
    configuration.seedPath,
    ...configuration.cases.map((entry) => entry.sourcePath),
    configuration.schemas.journal,
    configuration.schemas.result,
  ];
  for (const relative of paths) {
    const metadata = await fs.lstat(path.join(BENCHMARK_ROOT, relative)).catch(() => null);
    if (metadata === null || metadata.isSymbolicLink()) throw new CliError(`required benchmark path is missing or unsafe: ${relative}`);
  }
  const seedPackage = await readJson(path.join(BENCHMARK_ROOT, configuration.seedPath, 'package.json'), 'seed package');
  for (const dependencyField of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (seedPackage[dependencyField] && Object.keys(seedPackage[dependencyField]).length > 0) {
      throw new CliError(`seed must not declare ${dependencyField}`);
    }
  }
  for (const schemaPath of Object.values(configuration.schemas)) {
    const schema = await readJson(path.join(BENCHMARK_ROOT, schemaPath), schemaPath);
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new CliError(`${schemaPath} has an invalid dialect`);
  }
  if (await contentHash(path.join(BENCHMARK_ROOT, configuration.seedPath)) !== configuration.integrity.seedContentHash) {
    throw new CliError('seed content hash does not match the manifest');
  }
  for (const item of configuration.cases) {
    if (await sha256File(path.join(BENCHMARK_ROOT, item.sourcePath)) !== item.requirementsHash) {
      throw new CliError(`requirements hash does not match for case ${item.id}`);
    }
  }
  process.stdout.write('PASS: Sentinel Benchmark v1 structure verified\n');
}

async function walkFiles(root, relative = '') {
  const directory = path.join(root, relative);
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => !ignored(entry.name) && !(relative === '' && entry.name === '.git'))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    const metadata = await fs.lstat(child);
    if (metadata.isSymbolicLink()) throw new CliError(`symlink is not supported in fixture content: ${childRelative}`);
    if (metadata.isDirectory()) files.push(...await walkFiles(root, childRelative));
    else if (metadata.isFile()) files.push(childRelative.split(path.sep).join('/'));
    else throw new CliError(`unsupported fixture entry: ${childRelative}`);
  }
  return files;
}

export async function contentHash(root) {
  const digest = createHash('sha256');
  for (const relative of await walkFiles(root)) {
    const content = await fs.readFile(path.join(root, ...relative.split('/')));
    digest.update('file\0');
    digest.update(relative, 'utf8');
    digest.update('\0');
    digest.update(String(content.length), 'utf8');
    digest.update('\0');
    digest.update(content);
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

async function copyTree(source, destination) {
  await fs.mkdir(destination);
  const entries = (await fs.readdir(source, { withFileTypes: true }))
    .filter((entry) => !ignored(entry.name))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const metadata = await fs.lstat(from);
    if (metadata.isSymbolicLink()) throw new CliError(`seed contains a symlink: ${entry.name}`);
    if (metadata.isDirectory()) await copyTree(from, to);
    else if (metadata.isFile()) await fs.copyFile(from, to);
    else throw new CliError(`seed contains an unsupported entry: ${entry.name}`);
  }
}

function run(command, args, cwd, { environment = {}, inheritEnvironment = true, timeout = 60_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...(inheritEnvironment ? process.env : {}), ...environment },
    shell: false,
    timeout,
  });
  if (result.error) throw new CliError(`${command} failed to start: ${result.error.message}`);
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function gitRun(args, cwd, { environment = {} } = {}) {
  const cleanEnvironment = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    delete cleanEnvironment[name];
  }
  cleanEnvironment.GIT_CONFIG_NOSYSTEM = '1';
  cleanEnvironment.GIT_CONFIG_GLOBAL = os.devNull;
  cleanEnvironment.GIT_TERMINAL_PROMPT = '0';
  return run('git', args, cwd, { environment: { ...cleanEnvironment, ...environment }, inheritEnvironment: false });
}

function currentSentinelSha() {
  const inspected = gitRun(['rev-parse', 'HEAD'], REPOSITORY_ROOT);
  if (inspected.exitCode !== 0 || !/^[0-9a-f]{40}$/u.test(inspected.stdout.trim())) {
    throw new CliError(`cannot resolve sentinel-workflows HEAD: ${inspected.stderr}`);
  }
  return inspected.stdout.trim();
}

async function assertOutsideRepository(target, label) {
  const repository = await fs.realpath(REPOSITORY_ROOT);
  const parent = await fs.realpath(path.dirname(target)).catch((error) => {
    throw new CliError(`${label} parent must already exist: ${error.message}`, 2);
  });
  const resolved = path.join(parent, path.basename(target));
  if (inside(resolved, repository)) throw new CliError(`${label} must be outside the sentinel-workflows checkout`, 2);
}

async function prepare(options) {
  const configuration = await manifest();
  assertManifest(configuration);
  const item = caseConfig(configuration, options['--case']);
  const output = requireAbsolute(options['--output'], '--output');
  await assertOutsideRepository(output, 'prepare target');
  if (await fs.lstat(output).catch(() => null) !== null) throw new CliError('prepare target must not exist', 2);
  const stageParent = await fs.mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.prepare-`));
  const stage = path.join(stageParent, 'workspace');
  try {
    await copyTree(path.join(BENCHMARK_ROOT, configuration.seedPath), stage);
    await fs.copyFile(path.join(BENCHMARK_ROOT, item.sourcePath), path.join(stage, 'requirements.md'));
    const specPath = path.join(stage, ...item.specPath.split('/'));
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    if (await fs.lstat(specPath).catch(() => null) !== null) {
      throw new CliError('prepared SPEC_PATH must be absent');
    }
    const tests = run(process.execPath, ['--test'], stage);
    if (tests.exitCode !== 0) throw new CliError(`seed tests failed during prepare: ${tests.stderr || tests.stdout}`);
    const fixtureHash = await contentHash(stage);
    if (fixtureHash !== item.fixtureContentHash) throw new CliError(`fixture content hash does not match for case ${item.id}`);

    for (const [args, label] of [
      [['init', '--initial-branch=main'], 'git init'],
      [['config', '--local', 'user.name', 'Sentinel Benchmark'], 'git local user.name'],
      [['config', '--local', 'user.email', 'benchmark@sentinel.invalid'], 'git local user.email'],
      [['config', '--local', 'commit.gpgSign', 'false'], 'git local signing policy'],
      [['config', '--local', 'core.hooksPath', '.git/benchmark-empty-hooks'], 'git local hooks policy'],
    ]) {
      const command = gitRun(args, stage);
      if (command.exitCode !== 0) throw new CliError(`${label} failed: ${command.stderr}`);
    }
    await fs.mkdir(path.join(stage, '.git', 'benchmark-empty-hooks'));
    const indexed = gitRun(['add', '--all'], stage);
    if (indexed.exitCode !== 0) throw new CliError(`git baseline index failed: ${indexed.stderr}`);
    const commit = gitRun(['commit', '-m', `benchmark: seed case ${item.id}`], stage, {
      environment: {
        GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      },
    });
    if (commit.exitCode !== 0) throw new CliError(`git baseline commit failed: ${commit.stderr}`);
    const status = gitRun(['status', '--porcelain=v1'], stage);
    if (status.exitCode !== 0 || status.stdout !== '') throw new CliError('prepared git working tree is not clean');
    const localName = gitRun(['config', '--local', '--get', 'user.name'], stage);
    const localEmail = gitRun(['config', '--local', '--get', 'user.email'], stage);
    if (await fs.lstat(output).catch(() => null) !== null) throw new CliError('prepare target appeared during staging', 2);
    await fs.rename(stage, output);
    await fs.rmdir(stageParent);
    process.stdout.write(`${JSON.stringify({
      caseId: item.id,
      workspace: output,
      requirementsPath: path.join(output, 'requirements.md'),
      specPath: path.join(output, ...item.specPath.split('/')),
      contentHash: fixtureHash,
      testsPassed: true,
      gitWorkingTreeClean: true,
      gitConfigLocal: localName.stdout.trim() === 'Sentinel Benchmark' && localEmail.stdout.trim() === 'benchmark@sentinel.invalid',
    })}\n`);
  } catch (error) {
    await fs.rm(stageParent, { recursive: true, force: true });
    throw error;
  }
}

function assertJournal(value, configuration) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CliError('journal must be an object');
  const journalKeys = ['abortReason', 'benchmarkId', 'benchmarkVersion', 'caseId', 'events', 'productionProfileId', 'runMode', 'schemaVersion', 'sentinelSha', 'status'];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(journalKeys)) throw new CliError('journal has unknown or missing fields');
  if (value.schemaVersion !== 1 || value.benchmarkVersion !== configuration.benchmarkVersion
    || value.benchmarkId !== configuration.benchmarkId) throw new CliError('journal identity is invalid');
  caseConfig(configuration, value.caseId);
  if (!RUN_MODES.has(value.runMode) || !/^[0-9a-f]{40}$/u.test(value.sentinelSha)
    || value.productionProfileId !== configuration.productionProfile.id) throw new CliError('journal run identity is invalid');
  if (!['ACTIVE', 'ABORTED_BUDGET'].includes(value.status) || !Array.isArray(value.events)) throw new CliError('journal state is invalid');
  value.events.forEach((event, index) => {
    const required = ['childDispatches', 'effort', 'index', 'model', 'operation', 'phase', 'result'];
    const optional = [
      'durationMs', 'escalation', 'handoffBytes', 'inputBytes', 'inputTokens', 'mechanicalRejection',
      'observableReads', 'outputBytes', 'outputTokens', 'resultingState', 'retry', 'round', 'slice',
    ];
    if (Object.keys(event).some((key) => !required.includes(key) && !optional.includes(key))
      || required.some((key) => !Object.hasOwn(event, key))) throw new CliError(`journal event ${index + 1} has unknown or missing fields`);
    if (event.index !== index + 1 || !OPERATIONS.has(event.operation)
      || event.phase !== OPERATION_PHASE.get(event.operation) || !MODELS.has(event.model)
      || !EFFORTS.has(event.effort) || !RESULTS.has(event.result) || !Array.isArray(event.childDispatches)) {
      throw new CliError(`journal event ${index + 1} is invalid`);
    }
    for (const field of ['durationMs', 'handoffBytes', 'inputBytes', 'inputTokens', 'observableReads', 'outputBytes', 'outputTokens']) {
      if (event[field] !== undefined && (!Number.isInteger(event[field]) || event[field] < 0)) throw new CliError(`journal event ${index + 1} has invalid ${field}`);
    }
    if (event.round !== undefined && (!Number.isInteger(event.round) || event.round < 1)) throw new CliError(`journal event ${index + 1} has invalid round`);
    if (event.slice !== undefined && !/^slice-[0-9]{2,}$/u.test(event.slice)) throw new CliError(`journal event ${index + 1} has invalid slice`);
    if (event.resultingState !== undefined && (typeof event.resultingState !== 'string' || event.resultingState === '')) throw new CliError(`journal event ${index + 1} has invalid resultingState`);
    for (const field of ['escalation', 'mechanicalRejection', 'retry']) {
      if (event[field] !== undefined && typeof event[field] !== 'boolean') throw new CliError(`journal event ${index + 1} has invalid ${field}`);
    }
    for (const child of event.childDispatches) {
      if (JSON.stringify(Object.keys(child).sort()) !== JSON.stringify(['effort', 'model', 'role'])
        || typeof child.role !== 'string' || child.role === '' || !MODELS.has(child.model) || !EFFORTS.has(child.effort)) {
        throw new CliError(`journal child dispatch at event ${index + 1} is invalid`);
      }
    }
  });
  if (value.status === 'ACTIVE' && value.abortReason !== null) throw new CliError('active journal must not have abortReason');
  if (value.status === 'ABORTED_BUDGET' && value.abortReason?.code !== 'BUDGET_EXCEEDED') {
    throw new CliError('aborted journal must have a machine-readable budget reason');
  }
  if (value.abortReason !== null) {
    const abortKeys = ['budget', 'code', 'eventIndex', 'limit', 'observed'];
    if (JSON.stringify(Object.keys(value.abortReason).sort()) !== JSON.stringify(abortKeys)
      || typeof value.abortReason.budget !== 'string' || value.abortReason.budget === ''
      || !Number.isInteger(value.abortReason.limit) || value.abortReason.limit < 1
      || !Number.isInteger(value.abortReason.observed) || value.abortReason.observed < 1
      || !Number.isInteger(value.abortReason.eventIndex) || value.abortReason.eventIndex < 1) {
      throw new CliError('journal abortReason is invalid');
    }
  }
}

async function journalInit(options) {
  const configuration = await manifest();
  assertManifest(configuration);
  const output = requireAbsolute(options['--output'], '--output');
  const item = caseConfig(configuration, options['--case']);
  if (!/^[0-9a-f]{40}$/u.test(options['--sentinel-sha'])) throw new CliError('--sentinel-sha must be a lowercase 40-character SHA', 2);
  if (options['--sentinel-sha'] !== currentSentinelSha()) throw new CliError('--sentinel-sha does not match the benchmark checkout HEAD');
  if (!RUN_MODES.has(options['--run-mode'])) throw new CliError('unsupported --run-mode', 2);
  if (options['--production-profile'] !== configuration.productionProfile.id) throw new CliError('unsupported production profile', 2);
  const journal = {
    schemaVersion: configuration.schemaVersions.journal,
    benchmarkVersion: configuration.benchmarkVersion,
    benchmarkId: configuration.benchmarkId,
    caseId: item.id,
    runMode: options['--run-mode'],
    sentinelSha: options['--sentinel-sha'],
    productionProfileId: options['--production-profile'],
    status: 'ACTIVE',
    abortReason: null,
    events: [],
  };
  await atomicJson(output, journal, { exclusive: true });
  process.stdout.write(`${JSON.stringify({ journal: output, status: journal.status })}\n`);
}

function budgetViolation(events, budgets) {
  const count = (operation) => events.filter((event) => event.operation === operation).length;
  const checks = [
    ['maxReviewPlanEvents', count('REVIEW_PLAN')],
    ['maxReviewTasksEvents', count('REVIEW_TASKS')],
    ['maxReplans', count('REPLAN')],
  ];
  for (const [budget, observed] of checks) if (observed > budgets[budget]) return { budget, limit: budgets[budget], observed };
  for (const operation of ['EXECUTE_SLICE', 'APPLY_FINDINGS']) {
    const budget = operation === 'EXECUTE_SLICE' ? 'maxExecuteSliceAttemptsPerSlice' : 'maxApplyFindingsPerSlice';
    const slices = new Set(events.filter((event) => event.operation === operation).map((event) => event.slice));
    for (const slice of slices) {
      const observed = events.filter((event) => event.operation === operation && event.slice === slice).length;
      if (observed > budgets[budget]) return { budget, limit: budgets[budget], observed };
    }
  }
  if (events.length > budgets.maxWorkflowEvents) {
    return { budget: 'maxWorkflowEvents', limit: budgets.maxWorkflowEvents, observed: events.length };
  }
  return null;
}

function optionalEventFields(options, event) {
  for (const [option, field] of [
    ['--round', 'round'], ['--duration-ms', 'durationMs'], ['--input-tokens', 'inputTokens'],
    ['--output-tokens', 'outputTokens'], ['--input-bytes', 'inputBytes'], ['--output-bytes', 'outputBytes'],
    ['--handoff-bytes', 'handoffBytes'], ['--observable-reads', 'observableReads'],
  ]) {
    const value = optionalInteger(options[option], option);
    if (value !== undefined) event[field] = value;
  }
  for (const [option, field] of [
    ['--mechanical-rejection', 'mechanicalRejection'], ['--retry', 'retry'], ['--escalation', 'escalation'],
  ]) {
    const value = optionalBoolean(options[option], option);
    if (value !== undefined) event[field] = value;
  }
  if (options['--slice'] !== undefined) {
    if (!/^slice-[0-9]{2,}$/u.test(options['--slice'])) throw new CliError('--slice must match slice-NN', 2);
    event.slice = options['--slice'];
  }
  if (options['--resulting-state'] !== undefined) event.resultingState = options['--resulting-state'];
}

async function journalEvent(options) {
  const configuration = await manifest();
  assertManifest(configuration);
  const journalPath = requireAbsolute(options['--journal'], '--journal');
  const journal = await readJson(journalPath, 'journal');
  assertJournal(journal, configuration);
  if (journal.status !== 'ACTIVE') throw new CliError('journal is terminal after budget abort', BUDGET_EXIT);
  const operation = options['--operation'];
  if (!OPERATIONS.has(operation)) throw new CliError('unsupported operation', 2);
  if (options['--phase'] !== OPERATION_PHASE.get(operation)) throw new CliError(`phase must be ${OPERATION_PHASE.get(operation)} for ${operation}`, 2);
  if (!MODELS.has(options['--model'])) throw new CliError('unsupported model', 2);
  if (!EFFORTS.has(options['--effort'])) throw new CliError('unsupported effort', 2);
  if (!RESULTS.has(options['--result'])) throw new CliError('unsupported result', 2);
  const event = {
    index: journal.events.length + 1,
    operation,
    phase: options['--phase'],
    model: options['--model'],
    effort: options['--effort'],
    result: options['--result'],
    childDispatches: [],
  };
  optionalEventFields(options, event);
  if (['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS'].includes(operation) && event.slice === undefined) {
    throw new CliError(`${operation} requires --slice`, 2);
  }
  const childOptions = [options['--child-role'], options['--child-model'], options['--child-effort']];
  if (childOptions.some((value) => value !== undefined)) {
    if (childOptions.some((value) => value === undefined) || !MODELS.has(options['--child-model']) || !EFFORTS.has(options['--child-effort'])) {
      throw new CliError('child dispatch requires valid --child-role, --child-model, and --child-effort', 2);
    }
    event.childDispatches.push({ role: options['--child-role'], model: options['--child-model'], effort: options['--child-effort'] });
  }
  journal.events.push(event);
  const item = caseConfig(configuration, journal.caseId);
  const violation = budgetViolation(journal.events, item.budgets);
  if (violation !== null) {
    journal.status = 'ABORTED_BUDGET';
    journal.abortReason = { code: 'BUDGET_EXCEEDED', ...violation, eventIndex: event.index };
  }
  await atomicJson(journalPath, journal);
  if (violation !== null) throw new CliError(`budget exceeded: ${violation.budget}`, BUDGET_EXIT);
  process.stdout.write(`${JSON.stringify({ index: event.index, status: journal.status })}\n`);
}

function countWords(text) {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length;
}

async function readArtifactSet(files) {
  let bytes = 0;
  let words = 0;
  for (const file of files) {
    const content = await fs.readFile(file);
    bytes += content.length;
    words += countWords(content.toString('utf8'));
  }
  return { bytes, words };
}

async function existingFiles(directory, pattern) {
  const metadata = await fs.lstat(directory).catch(() => null);
  if (metadata === null) return [];
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CliError(`artifact path must be a real directory: ${directory}`);
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && pattern.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

async function artifactMetrics(specPath) {
  const execution = path.join(specPath, 'execution');
  const planFiles = await existingFiles(path.join(execution, 'plans'), /^slice-[0-9]{2,}\.md$/u);
  const taskFiles = await existingFiles(path.join(execution, 'tasks'), /^slice-[0-9]{2,}\.md$/u);
  const rootPlan = path.join(execution, 'plan.md');
  const rootTasks = path.join(execution, 'tasks.md');
  const planInputs = (await fs.lstat(rootPlan).catch(() => null))?.isFile() ? [rootPlan, ...planFiles] : planFiles;
  const taskInputs = (await fs.lstat(rootTasks).catch(() => null))?.isFile() ? [rootTasks, ...taskFiles] : taskFiles;
  const tasksPerSlice = {};
  let tasks = 0;
  let terminal = taskFiles.length > 0;
  for (const file of taskFiles) {
    const text = await fs.readFile(file, 'utf8');
    const count = [...text.matchAll(/^- \[(?: |x)\] \S.*$/gmu)].length;
    const slice = path.basename(file, '.md');
    tasksPerSlice[slice] = count;
    tasks += count;
    if (!/^## Final Result\n\n- (?:PASS|SUPERSEDED)(?:\n|$)/gmu.test(text)) terminal = false;
  }
  return {
    slices: new Set([...planFiles, ...taskFiles].map((file) => path.basename(file, '.md'))).size,
    tasks,
    tasksPerSlice,
    plan: await readArtifactSet(planInputs),
    tasksArtifacts: await readArtifactSet(taskInputs),
    structurallyTerminal: terminal,
  };
}

function operationMetrics(events) {
  const count = (operation) => events.filter((event) => event.operation === operation).length;
  const cycles = new Set(events.filter((event) => event.operation === 'APPLY_FINDINGS')
    .map((event) => `${event.slice ?? 'none'}:${event.round ?? event.index}`));
  return {
    total: events.length,
    reviewPlanRounds: count('REVIEW_PLAN'),
    reviewTasksRounds: count('REVIEW_TASKS'),
    replans: count('REPLAN'),
    executeCalls: count('EXECUTE_SLICE'),
    validateCalls: count('VALIDATE_SLICE'),
    applyFindingsCalls: count('APPLY_FINDINGS'),
    findingsCycles: cycles.size,
    mechanicalRejections: events.filter((event) => event.mechanicalRejection === true).length,
    retries: events.filter((event) => event.retry === true).length,
  };
}

function modelMetrics(events, expectedProfile) {
  const actualModelsByPhase = {};
  const actualEffortsByPhase = {};
  for (const phase of PHASES) {
    actualModelsByPhase[phase] = [...new Set(events.filter((event) => event.phase === phase).map((event) => event.model))];
    actualEffortsByPhase[phase] = [...new Set(events.filter((event) => event.phase === phase).map((event) => event.effort))];
  }
  const profileMismatches = events.flatMap((event) => {
    const expected = expectedProfile[event.phase];
    if (event.model === expected.model && event.effort === expected.effort) return [];
    return [{
      eventIndex: event.index,
      operation: event.operation,
      phase: event.phase,
      expectedModel: expected.model,
      actualModel: event.model,
      expectedEffort: expected.effort,
      actualEffort: event.effort,
    }];
  });
  const childDispatches = events.flatMap((event) => event.childDispatches.map((child) => ({
    parentEventIndex: event.index,
    parentOperation: event.operation,
    ...child,
  })));
  return {
    expectedProfile,
    actualModelsByPhase,
    actualEffortsByPhase,
    childDispatches,
    profileMismatches,
    solEscalations: events.filter((event) => event.escalation === true && event.model === 'GPT-5.6-Sol').length,
  };
}

function optionalSum(events, field) {
  const values = events.filter((event) => Number.isInteger(event[field])).map((event) => event[field]);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function contextMetrics(events, artifacts) {
  const telemetry = events.length > 0 && events.every((event) => Number.isInteger(event.inputTokens) && Number.isInteger(event.outputTokens));
  return {
    planBytes: artifacts.plan.bytes,
    planWords: artifacts.plan.words,
    tasksBytes: artifacts.tasksArtifacts.bytes,
    tasksWords: artifacts.tasksArtifacts.words,
    handoffBytes: optionalSum(events, 'handoffBytes'),
    observableReads: optionalSum(events, 'observableReads'),
    actualTokenTelemetryAvailable: telemetry,
    inputTokens: telemetry ? events.reduce((sum, event) => sum + event.inputTokens, 0) : null,
    outputTokens: telemetry ? events.reduce((sum, event) => sum + event.outputTokens, 0) : null,
  };
}

async function gitWorkspaceMetrics(workspace) {
  const status = gitRun(['status', '--porcelain=v1', '-z', '--untracked-files=all'], workspace);
  if (status.exitCode !== 0) throw new CliError(`cannot inspect workspace git status: ${status.stderr}`);
  const records = status.stdout.split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const statusCode = record.slice(0, 2);
    const file = record.slice(3);
    if (!ignored(path.basename(file))) paths.push(file);
    if ((statusCode.includes('R') || statusCode.includes('C')) && records[index + 1] !== undefined) index += 1;
  }
  const diff = gitRun(['diff', '--binary', 'HEAD', '--'], workspace);
  if (diff.exitCode !== 0) throw new CliError(`cannot inspect workspace diff: ${diff.stderr}`);
  let untrackedBytes = 0;
  for (const record of records) {
    if (!record.startsWith('?? ')) continue;
    const relative = record.slice(3);
    if (ignored(path.basename(relative))) continue;
    const metadata = await fs.lstat(path.join(workspace, relative)).catch(() => null);
    if (metadata?.isFile()) untrackedBytes += metadata.size;
  }
  return { changedFileCount: paths.length, finalDiffBytes: Buffer.byteLength(diff.stdout, 'utf8') + untrackedBytes };
}

async function sha256File(file) {
  return `sha256:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
}

function validateResult(value) {
  if (value?.schemaVersion !== 1 || value?.benchmarkVersion !== 1 || value?.benchmarkId !== 'sentinel-todo') {
    throw new CliError('result identity is invalid');
  }
  const topKeys = [
    'benchmarkId', 'benchmarkVersion', 'caseId', 'contextCost', 'decomposition', 'finalExecutionState',
    'finalTests', 'finalTestsPassed', 'modelUse', 'operations', 'productionProfileId', 'runMode',
    'schemaVersion', 'sentinelSha', 'specClosed', 'status', 'workspace',
  ];
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(topKeys)) throw new CliError('result has unknown or missing fields');
  if (!['A', 'B', 'C'].includes(value.caseId) || !RUN_MODES.has(value.runMode)
    || !['PASS', 'FAIL', 'BLOCKED', 'ABORTED_BUDGET'].includes(value.status)
    || !/^[0-9a-f]{40}$/u.test(value.sentinelSha) || !PROFILE_IDS.has(value.productionProfileId)
    || (value.finalExecutionState !== null && typeof value.finalExecutionState !== 'string')
    || typeof value.specClosed !== 'boolean' || typeof value.finalTestsPassed !== 'boolean') throw new CliError('result outcome is invalid');
  for (const section of ['decomposition', 'operations', 'modelUse', 'contextCost', 'workspace', 'finalTests']) {
    if (value[section] === null || typeof value[section] !== 'object' || Array.isArray(value[section])) throw new CliError(`result ${section} is invalid`);
  }
  const numericObject = (object, keys, label) => {
    if (JSON.stringify(Object.keys(object).sort()) !== JSON.stringify([...keys].sort())
      || keys.some((key) => !Number.isInteger(object[key]) || object[key] < 0)) throw new CliError(`result ${label} is invalid`);
  };
  if (JSON.stringify(Object.keys(value.decomposition).sort()) !== JSON.stringify(['slices', 'tasks', 'tasksPerSlice'])
    || !Number.isInteger(value.decomposition.slices) || value.decomposition.slices < 0
    || !Number.isInteger(value.decomposition.tasks) || value.decomposition.tasks < 0
    || value.decomposition.tasksPerSlice === null || typeof value.decomposition.tasksPerSlice !== 'object'
    || Array.isArray(value.decomposition.tasksPerSlice)
    || Object.values(value.decomposition.tasksPerSlice).some((count) => !Number.isInteger(count) || count < 0)) {
    throw new CliError('result decomposition is invalid');
  }
  numericObject(value.operations, [
    'total', 'reviewPlanRounds', 'reviewTasksRounds', 'replans', 'executeCalls', 'validateCalls',
    'applyFindingsCalls', 'findingsCycles', 'mechanicalRejections', 'retries',
  ], 'operations');
  const modelUseKeys = ['actualEffortsByPhase', 'actualModelsByPhase', 'childDispatches', 'expectedProfile', 'profileMismatches', 'solEscalations'];
  if (JSON.stringify(Object.keys(value.modelUse).sort()) !== JSON.stringify(modelUseKeys)
    || !Number.isInteger(value.modelUse.solEscalations) || value.modelUse.solEscalations < 0
    || !Array.isArray(value.modelUse.childDispatches) || !Array.isArray(value.modelUse.profileMismatches)) throw new CliError('result modelUse is invalid');
  for (const phase of PHASES) {
    const expected = value.modelUse.expectedProfile?.[phase];
    const models = value.modelUse.actualModelsByPhase?.[phase];
    const efforts = value.modelUse.actualEffortsByPhase?.[phase];
    if (!MODELS.has(expected?.model) || !EFFORTS.has(expected?.effort)
      || !Array.isArray(models) || models.some((model) => !MODELS.has(model))
      || !Array.isArray(efforts) || efforts.some((effort) => !EFFORTS.has(effort))) throw new CliError(`result profile phase ${phase} is invalid`);
  }
  if (Object.keys(value.modelUse.expectedProfile).length !== PHASES.length
    || Object.keys(value.modelUse.actualModelsByPhase).length !== PHASES.length
    || Object.keys(value.modelUse.actualEffortsByPhase).length !== PHASES.length) throw new CliError('result profile has unknown phases');
  for (const child of value.modelUse.childDispatches) {
    if (!Number.isInteger(child.parentEventIndex) || child.parentEventIndex < 1
      || typeof child.parentOperation !== 'string' || typeof child.role !== 'string'
      || !MODELS.has(child.model) || !EFFORTS.has(child.effort)) throw new CliError('result child dispatch is invalid');
  }
  for (const mismatch of value.modelUse.profileMismatches) {
    if (!Number.isInteger(mismatch.eventIndex) || mismatch.eventIndex < 1 || typeof mismatch.operation !== 'string'
      || !PHASES.includes(mismatch.phase) || !MODELS.has(mismatch.expectedModel) || !MODELS.has(mismatch.actualModel)
      || !EFFORTS.has(mismatch.expectedEffort) || !EFFORTS.has(mismatch.actualEffort)) throw new CliError('result profile mismatch is invalid');
  }
  const contextKeys = ['actualTokenTelemetryAvailable', 'handoffBytes', 'inputTokens', 'observableReads', 'outputTokens', 'planBytes', 'planWords', 'tasksBytes', 'tasksWords'];
  if (JSON.stringify(Object.keys(value.contextCost).sort()) !== JSON.stringify(contextKeys)
    || typeof value.contextCost.actualTokenTelemetryAvailable !== 'boolean') throw new CliError('result contextCost is invalid');
  for (const key of ['planBytes', 'planWords', 'tasksBytes', 'tasksWords']) {
    if (!Number.isInteger(value.contextCost[key]) || value.contextCost[key] < 0) throw new CliError(`result ${key} is invalid`);
  }
  for (const key of ['handoffBytes', 'observableReads', 'inputTokens', 'outputTokens']) {
    const metric = value.contextCost[key];
    if (metric !== null && (!Number.isInteger(metric) || metric < 0)) throw new CliError(`result ${key} is invalid`);
  }
  if (value.contextCost.actualTokenTelemetryAvailable
    ? value.contextCost.inputTokens === null || value.contextCost.outputTokens === null
    : value.contextCost.inputTokens !== null || value.contextCost.outputTokens !== null) throw new CliError('result token telemetry consistency is invalid');
  if (JSON.stringify(Object.keys(value.workspace).sort()) !== JSON.stringify([
    'changedFileCount', 'finalDiffBytes', 'observedSentinelSha', 'requirementsHash',
    'requirementsHashMatches', 'seedContentHash', 'sentinelShaMatchesCheckout',
  ])
    || !Number.isInteger(value.workspace.changedFileCount) || value.workspace.changedFileCount < 0
    || !Number.isInteger(value.workspace.finalDiffBytes) || value.workspace.finalDiffBytes < 0
    || !/^sha256:[0-9a-f]{64}$/u.test(value.workspace.seedContentHash)
    || !/^sha256:[0-9a-f]{64}$/u.test(value.workspace.requirementsHash)
    || !/^[0-9a-f]{40}$/u.test(value.workspace.observedSentinelSha)
    || typeof value.workspace.requirementsHashMatches !== 'boolean'
    || typeof value.workspace.sentinelShaMatchesCheckout !== 'boolean') throw new CliError('result workspace is invalid');
  if (JSON.stringify(Object.keys(value.finalTests).sort()) !== JSON.stringify(['command', 'exitCode', 'passed'])
    || value.finalTests.command !== 'node --test' || !Number.isInteger(value.finalTests.exitCode)
    || typeof value.finalTests.passed !== 'boolean') throw new CliError('result finalTests is invalid');
}

async function finalize(options) {
  const configuration = await manifest();
  assertManifest(configuration);
  const item = caseConfig(configuration, options['--case']);
  const workspace = requireAbsolute(options['--workspace'], '--workspace');
  const specPath = requireAbsolute(options['--spec'], '--spec');
  const journalPath = requireAbsolute(options['--journal'], '--journal');
  const output = requireAbsolute(options['--output'], '--output');
  await assertOutsideRepository(workspace, 'workspace');
  const realWorkspace = await fs.realpath(workspace).catch(() => { throw new CliError('workspace must exist'); });
  const expectedSpec = path.join(realWorkspace, ...item.specPath.split('/'));
  const realSpec = await fs.realpath(specPath).catch(() => { throw new CliError('SPEC path must exist'); });
  if (realSpec !== expectedSpec) throw new CliError(`SPEC path must equal the configured path for case ${item.id}`);
  const realJournal = await fs.realpath(journalPath).catch(() => { throw new CliError('journal must exist'); });
  if (inside(realJournal, realWorkspace) || inside(output, realWorkspace)) throw new CliError('journal and result output must stay outside the prepared workspace');
  if (await fs.lstat(output).catch(() => null) !== null) throw new CliError('result output must not exist', 2);

  const journal = await readJson(realJournal, 'journal');
  assertJournal(journal, configuration);
  if (journal.caseId !== item.id || journal.productionProfileId !== configuration.productionProfile.id) {
    throw new CliError('journal does not match case/profile');
  }
  const budget = budgetViolation(journal.events, item.budgets);
  if (budget !== null && journal.status !== 'ABORTED_BUDGET') throw new CliError('journal exceeds a budget without terminal abort state');

  const artifacts = await artifactMetrics(realSpec);
  const operationalEvents = journal.events.filter((event) => !event.operation.startsWith('SPEC_'));
  const reportedExecutionEvents = operationalEvents.filter((event) => event.resultingState !== undefined);
  const reportedExecutionState = reportedExecutionEvents.at(-1)?.resultingState ?? null;
  const completeEvent = operationalEvents.findLast((event) => (
    event.operation === 'VALIDATE_SLICE' && event.result === 'PASS' && event.resultingState === 'COMPLETE'
  ));
  const readinessEventsAfterComplete = completeEvent === undefined ? [] : journal.events.filter((event) => (
    event.operation === 'SPEC_READINESS' && event.index > completeEvent.index
  ));
  const terminalReadiness = readinessEventsAfterComplete[0];
  const closeEvents = journal.events.filter((event) => event.operation === 'SPEC_CLOSE');
  const closeEvent = closeEvents[0];
  const terminalSequence = completeEvent !== undefined
    && operationalEvents.at(-1) === completeEvent
    && readinessEventsAfterComplete.length === 1
    && terminalReadiness.result === 'PASS'
    && terminalReadiness.resultingState === 'GLOBAL_READY'
    && terminalReadiness.index === completeEvent.index + 1
    && closeEvents.length === 1
    && closeEvent.result === 'PASS'
    && closeEvent.index === terminalReadiness.index + 1
    && closeEvent.index === journal.events.length;
  const lifecycleValidation = run(process.execPath, [LIFECYCLE_VALIDATOR, 'workspace', realSpec], REPOSITORY_ROOT);
  const specClosed = lifecycleValidation.exitCode === 0 && / status=closed ids=[0-9]+\n?$/u.test(lifecycleValidation.stdout);
  const requirementsHash = await sha256File(path.join(realWorkspace, 'requirements.md'));
  const requirementsHashMatches = requirementsHash === item.requirementsHash;
  const observedSentinelSha = currentSentinelSha();
  const sentinelShaMatchesCheckout = journal.sentinelSha === observedSentinelSha;
  const tests = run(process.execPath, ['--test'], realWorkspace);
  const finalTestsPassed = tests.exitCode === 0;
  const needsClosure = journal.runMode === 'case' || journal.runMode === 'full';
  const executionValidation = needsClosure
    ? run(process.execPath, [EXECUTION_VALIDATOR, realSpec], REPOSITORY_ROOT)
    : null;
  const officialStateMatch = executionValidation?.exitCode === 0
    ? /^PASS: execution state=([A-Z][A-Z0-9_]*) authority=sha256:[0-9a-f]{64}\n?$/u.exec(executionValidation.stdout)
    : null;
  const finalExecutionState = needsClosure ? officialStateMatch?.[1] ?? null : reportedExecutionState;
  const officialExecutionBlocked = needsClosure && executionValidation.exitCode !== 0
    && /^(?:BLOCKED|RECOVERY_TARGETS):/mu.test(executionValidation.stderr);
  const lastOperationalEvent = operationalEvents.at(-1);
  const lastLifecycleEvent = journal.events.filter((event) => event.operation.startsWith('SPEC_')).at(-1);
  const effectiveBlocked = lastOperationalEvent?.result === 'BLOCKED'
    || lastLifecycleEvent?.result === 'BLOCKED'
    || officialExecutionBlocked;
  const terminalEvidence = terminalSequence
    && finalExecutionState === 'COMPLETE'
    && artifacts.structurallyTerminal;
  const commonPass = requirementsHashMatches && sentinelShaMatchesCheckout && finalTestsPassed;
  const passed = commonPass && (needsClosure ? terminalEvidence && specClosed : !effectiveBlocked);

  let status;
  if (journal.status === 'ABORTED_BUDGET') status = 'ABORTED_BUDGET';
  else if (passed) status = 'PASS';
  else if (effectiveBlocked) status = 'BLOCKED';
  else status = 'FAIL';

  const workspaceMetrics = await gitWorkspaceMetrics(realWorkspace);
  const result = {
    schemaVersion: configuration.schemaVersions.result,
    benchmarkVersion: configuration.benchmarkVersion,
    benchmarkId: configuration.benchmarkId,
    caseId: item.id,
    runMode: journal.runMode,
    sentinelSha: journal.sentinelSha,
    productionProfileId: journal.productionProfileId,
    status,
    finalExecutionState,
    specClosed,
    finalTestsPassed,
    decomposition: { slices: artifacts.slices, tasks: artifacts.tasks, tasksPerSlice: artifacts.tasksPerSlice },
    operations: operationMetrics(journal.events),
    modelUse: modelMetrics(journal.events, configuration.productionProfile.cases[item.id]),
    contextCost: contextMetrics(journal.events, artifacts),
    workspace: {
      ...workspaceMetrics,
      seedContentHash: await contentHash(path.join(BENCHMARK_ROOT, configuration.seedPath)),
      requirementsHash,
      requirementsHashMatches,
      observedSentinelSha,
      sentinelShaMatchesCheckout,
    },
    finalTests: { command: 'node --test', exitCode: tests.exitCode, passed: finalTestsPassed },
  };
  validateResult(result);
  await atomicJson(output, result, { exclusive: true });
  process.stdout.write(`${JSON.stringify({ output, status })}\n`);
  if (status !== 'PASS') throw new CliError(`finalized with status ${status}`);
}

function getPath(value, dotted) {
  return dotted.split('.').reduce((current, key) => current?.[key], value);
}

function display(value) {
  if (value === null || value === undefined) return 'unavailable';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function delta(before, after) {
  return typeof before === 'number' && typeof after === 'number' ? after - before : 'unavailable';
}

function compareMarkdown(before, after) {
  const metrics = [
    ['slices', 'decomposition.slices'], ['tasks', 'decomposition.tasks'],
    ['reviewPlanRounds', 'operations.reviewPlanRounds'], ['reviewTasksRounds', 'operations.reviewTasksRounds'],
    ['replans', 'operations.replans'], ['executeCalls', 'operations.executeCalls'],
    ['validateCalls', 'operations.validateCalls'], ['applyFindingsCalls', 'operations.applyFindingsCalls'],
    ['findingsCycles', 'operations.findingsCycles'], ['retries', 'operations.retries'],
    ['mechanicalRejections', 'operations.mechanicalRejections'], ['planBytes', 'contextCost.planBytes'],
    ['planWords', 'contextCost.planWords'], ['tasksBytes', 'contextCost.tasksBytes'],
    ['tasksWords', 'contextCost.tasksWords'], ['changedFileCount', 'workspace.changedFileCount'],
  ];
  for (const [label, key] of [
    ['handoffBytes', 'contextCost.handoffBytes'], ['observableReads', 'contextCost.observableReads'],
  ]) if (getPath(before, key) !== null && getPath(after, key) !== null) metrics.push([label, key]);
  if (before.contextCost.actualTokenTelemetryAvailable === true && after.contextCost.actualTokenTelemetryAvailable === true) {
    metrics.push(['inputTokens', 'contextCost.inputTokens'], ['outputTokens', 'contextCost.outputTokens']);
  }
  const lines = [
    `# Sentinel Benchmark comparison — Case ${before.caseId}`,
    '',
    '| Metric | Before | After | Delta |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const [label, key] of metrics) {
    const left = getPath(before, key);
    const right = getPath(after, key);
    lines.push(`| ${label} | ${display(left)} | ${display(right)} | ${display(delta(left, right))} |`);
  }
  lines.push('', '## Model and effort dispatches', '', '| Phase | Expected before | Actual before | Expected after | Actual after |', '| --- | --- | --- | --- | --- |');
  for (const phase of PHASES) {
    const expectedBefore = before.modelUse.expectedProfile[phase];
    const expectedAfter = after.modelUse.expectedProfile[phase];
    const actualBefore = `${before.modelUse.actualModelsByPhase[phase].join(', ') || 'none'} / ${before.modelUse.actualEffortsByPhase[phase].join(', ') || 'none'}`;
    const actualAfter = `${after.modelUse.actualModelsByPhase[phase].join(', ') || 'none'} / ${after.modelUse.actualEffortsByPhase[phase].join(', ') || 'none'}`;
    lines.push(`| ${phase} | ${expectedBefore.model} / ${expectedBefore.effort} | ${actualBefore} | ${expectedAfter.model} / ${expectedAfter.effort} | ${actualAfter} |`);
  }
  lines.push(
    '',
    `Profile mismatches before: ${before.modelUse.profileMismatches.length}`,
    '',
    `Profile mismatches after: ${after.modelUse.profileMismatches.length}`,
    '',
    '## Outcome facts',
    '',
    '| Fact | Before | After |',
    '| --- | --- | --- |',
    `| Status | ${before.status} | ${after.status} |`,
    `| Final execution state | ${display(before.finalExecutionState)} | ${display(after.finalExecutionState)} |`,
    `| SPEC closed | ${display(before.specClosed)} | ${display(after.specClosed)} |`,
    `| Final tests passed | ${display(before.finalTestsPassed)} | ${display(after.finalTestsPassed)} |`,
    '',
  );
  return lines.join('\n');
}

async function compare(options) {
  const before = await readJson(requireAbsolute(options['--before'], '--before'), 'before result');
  const after = await readJson(requireAbsolute(options['--after'], '--after'), 'after result');
  const incompatible = [
    ['benchmark id', before?.benchmarkId, after?.benchmarkId],
    ['benchmark version', before?.benchmarkVersion, after?.benchmarkVersion],
    ['case', before?.caseId, after?.caseId],
    ['production profile', before?.productionProfileId, after?.productionProfileId],
    ['seed content hash', before?.workspace?.seedContentHash, after?.workspace?.seedContentHash],
    ['requirements hash', before?.workspace?.requirementsHash, after?.workspace?.requirementsHash],
  ].filter(([, left, right]) => left !== right).map(([label]) => label);
  if (incompatible.length > 0) {
    throw new CliError(`results are not comparable; mismatched ${incompatible.join(', ')}`);
  }
  validateResult(before);
  validateResult(after);
  const markdown = compareMarkdown(before, after);
  process.stdout.write(markdown);
  if (options['--output'] !== undefined) {
    const output = requireAbsolute(options['--output'], '--output');
    await fs.writeFile(output, markdown, { encoding: 'utf8', flag: 'wx' })
      .catch((error) => { throw new CliError(`cannot create comparison output: ${error.message}`); });
  }
}

const EVENT_OPTIONS = new Set([
  '--journal', '--operation', '--phase', '--model', '--effort', '--result', '--slice', '--round',
  '--resulting-state', '--duration-ms', '--input-tokens', '--output-tokens', '--input-bytes', '--output-bytes',
  '--handoff-bytes', '--observable-reads', '--mechanical-rejection', '--retry', '--escalation',
  '--child-role', '--child-model', '--child-effort',
]);

export async function main(argv) {
  const [command, ...tokens] = argv;
  if (command === 'verify' && tokens.length === 0) return verify();
  if (command === 'doctor') {
    const options = parseOptions(tokens, new Set(['--scratch-parent', '--probe-workspace', '--expect-tmpdir']));
    const probeRequested = options['--probe-workspace'] !== undefined || options['--expect-tmpdir'] !== undefined;
    if (probeRequested) {
      if (options['--scratch-parent'] !== undefined
        || options['--probe-workspace'] === undefined
        || options['--expect-tmpdir'] === undefined) {
        throw new CliError('doctor probe mode requires --probe-workspace and --expect-tmpdir only', 2);
      }
      const report = await runProbeDoctor({
        workspace: requireAbsolute(options['--probe-workspace'], '--probe-workspace'),
        expectedTmpdir: requireAbsolute(options['--expect-tmpdir'], '--expect-tmpdir'),
      });
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return report.status === 'PASS' ? 0 : 1;
    }
    const result = await runDoctor({
      repositoryRoot: REPOSITORY_ROOT,
      benchmarkRoot: BENCHMARK_ROOT,
      scratchParent: options['--scratch-parent'],
    });
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
    return result.exitCode;
  }
  if (command === 'prepare') return prepare(parseOptions(tokens, new Set(['--case', '--output']), ['--case', '--output']));
  if (command === 'journal-init') return journalInit(parseOptions(tokens,
    new Set(['--output', '--case', '--sentinel-sha', '--run-mode', '--production-profile']),
    ['--output', '--case', '--sentinel-sha', '--run-mode', '--production-profile']));
  if (command === 'journal-event') return journalEvent(parseOptions(tokens, EVENT_OPTIONS,
    ['--journal', '--operation', '--phase', '--model', '--effort', '--result']));
  if (command === 'finalize') return finalize(parseOptions(tokens,
    new Set(['--workspace', '--case', '--spec', '--journal', '--output']),
    ['--workspace', '--case', '--spec', '--journal', '--output']));
  if (command === 'compare') return compare(parseOptions(tokens,
    new Set(['--before', '--after', '--output']), ['--before', '--after']));
  throw new CliError('usage: benchmark.mjs {verify|doctor|prepare|journal-init|journal-event|finalize|compare} ...', 2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const exitCode = await main(process.argv.slice(2));
    if (Number.isInteger(exitCode)) process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}
