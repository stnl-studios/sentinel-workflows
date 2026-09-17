import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CONTRACT_VERSION = 1;
const SESSION_PREFIX = 'sentinel-benchmark-session-';
const ownedSessions = new WeakSet();
const CHECK_IDS = [
  'NODE_RUNTIME',
  'GIT_LOCAL',
  'GLOBAL_GIT_CONFIG',
  'OS_TEMP',
  'MANAGED_SESSION_TEMP',
  'MANAGED_TMPDIR',
  'CHILD_ENVIRONMENT',
  'SPACES_PATH',
  'UNICODE_PATH',
  'PLATFORM_CANONICALIZATION',
  'FILESYSTEM_OPERATIONS',
  'SYMLINK_SAFETY',
  'CHECKOUT_PRESERVATION',
  'SEED_PRESERVATION',
  'CLEANUP',
];

class DoctorInvocationError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

class EnvironmentError extends Error {
  constructor(code, check, message) {
    super(message);
    this.code = code;
    this.check = check;
  }
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function command(commandName, args, cwd, { environment = process.env, timeout = 60_000 } = {}) {
  return spawnSync(commandName, args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    shell: false,
    timeout,
  });
}

function sanitizedGitEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) delete environment[name];
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = os.devNull;
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function git(args, cwd) {
  return command('git', args, cwd, { environment: sanitizedGitEnvironment() });
}

function requireCommand(result, code, check, expectedStatus = 0) {
  if (result.error !== undefined || result.status !== expectedStatus) {
    throw new EnvironmentError(code, check, `${code}: command failed`);
  }
  return result;
}

async function fingerprintFile(file) {
  try {
    const metadata = await fs.lstat(file);
    const bytes = await fs.readFile(file);
    return {
      exists: true,
      kind: metadata.isSymbolicLink() ? 'symlink' : metadata.isFile() ? 'file' : 'other',
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function globalGitFingerprint() {
  const xdgRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return {
    home: await fingerprintFile(path.join(os.homedir(), '.gitconfig')),
    xdg: await fingerprintFile(path.join(xdgRoot, 'git', 'config')),
  };
}

async function treeFingerprint(root) {
  const digest = createHash('sha256');
  async function visit(directory, relative = '') {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => !['.DS_Store', '__MACOSX'].includes(entry.name) && !entry.name.startsWith('._'))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const child = path.join(directory, entry.name);
      const metadata = await fs.lstat(child);
      if (metadata.isSymbolicLink()) throw new EnvironmentError('WORKSPACE_MUTATED', 'SEED_PRESERVATION', 'seed contains a symlink');
      if (metadata.isDirectory()) await visit(child, childRelative);
      else if (metadata.isFile()) {
        const bytes = await fs.readFile(child);
        digest.update(childRelative.split(path.sep).join('/'));
        digest.update('\0');
        digest.update(bytes);
        digest.update('\0');
      }
    }
  }
  await visit(root);
  return digest.digest('hex');
}

async function validateScratchParent(scratchParent, repositoryRoot) {
  if (scratchParent === undefined) return null;
  if (typeof scratchParent !== 'string' || !path.isAbsolute(scratchParent)) {
    throw new DoctorInvocationError('--scratch-parent must be an absolute existing path');
  }
  const metadata = await fs.lstat(scratchParent).catch((error) => {
    if (error.code === 'ENOENT') throw new DoctorInvocationError('--scratch-parent must exist');
    throw error;
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new DoctorInvocationError('--scratch-parent must be a real directory, not a symlink');
  }
  const canonical = await fs.realpath(scratchParent);
  if (inside(canonical, repositoryRoot)) {
    throw new DoctorInvocationError('--scratch-parent must be outside the sentinel-workflows checkout');
  }
  return canonical;
}

async function validateOsTemp(repositoryRoot) {
  const candidate = os.tmpdir();
  const metadata = await fs.lstat(candidate).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new EnvironmentError('TEMP_PARENT_UNSAFE', 'OS_TEMP', 'OS temp is not a real directory');
  }
  const canonical = await fs.realpath(candidate).catch(() => null);
  if (canonical === null || inside(canonical, repositoryRoot)) {
    throw new EnvironmentError('TEMP_PARENT_UNSAFE', 'OS_TEMP', 'OS temp is inside the repository or cannot be canonicalized');
  }
  await fs.access(canonical, fs.constants.W_OK).catch(() => {
    throw new EnvironmentError('MANAGED_TMP_UNWRITABLE', 'OS_TEMP', 'OS temp is not writable');
  });
  return canonical;
}

export async function createManagedBenchmarkSession({ repositoryRoot, scratchParent }) {
  const canonicalRepository = await fs.realpath(repositoryRoot);
  const selectedParent = await validateScratchParent(scratchParent, canonicalRepository);
  const osTemp = await validateOsTemp(canonicalRepository);
  const parent = selectedParent ?? osTemp;
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, SESSION_PREFIX)));
  if (!inside(root, parent) || inside(root, canonicalRepository)) {
    await fs.rm(root, { recursive: true, force: true });
    throw new EnvironmentError('TEMP_PARENT_UNSAFE', 'MANAGED_SESSION_TEMP', 'managed session root is unsafe');
  }
  const session = Object.freeze({
    root,
    parent,
    repositoryRoot: canonicalRepository,
    workspaces: path.join(root, 'workspaces'),
    journals: path.join(root, 'journals'),
    results: path.join(root, 'results'),
    runnerTmp: path.join(root, 'runner-tmp'),
  });
  try {
    await Promise.all([
      session.workspaces,
      session.journals,
      session.results,
      session.runnerTmp,
    ].map((directory) => fs.mkdir(directory)));
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  ownedSessions.add(session);
  return session;
}

export async function cleanupManagedBenchmarkSession(session) {
  if (!session || !ownedSessions.has(session)) {
    throw new EnvironmentError('CLEANUP_FAILED', 'CLEANUP', 'session is not owned by this environment process');
  }
  const canonicalRoot = await fs.realpath(session.root).catch(() => null);
  if (canonicalRoot !== session.root
    || path.basename(canonicalRoot) === ''
    || !path.basename(canonicalRoot).startsWith(SESSION_PREFIX)
    || !inside(canonicalRoot, session.parent)
    || inside(canonicalRoot, session.repositoryRoot)) {
    throw new EnvironmentError('CLEANUP_FAILED', 'CLEANUP', 'managed session root is no longer safe');
  }
  await fs.rm(canonicalRoot, { recursive: true });
  if (await fs.lstat(canonicalRoot).catch(() => null) !== null) {
    throw new EnvironmentError('CLEANUP_FAILED', 'CLEANUP', 'managed session root remains after cleanup');
  }
  ownedSessions.delete(session);
}

async function filesystemChecks(workspaces) {
  const spaceRoot = path.join(workspaces, 'path with spaces');
  const unicodeRoot = path.join(workspaces, 'path ü 漢字');
  await fs.mkdir(spaceRoot);
  await fs.mkdir(unicodeRoot);
  const initial = Buffer.from([0, 1, 2, 3, 255]);
  const original = path.join(spaceRoot, 'bytes.bin');
  const renamed = path.join(unicodeRoot, 'renamed bytes.bin');
  await fs.writeFile(original, initial);
  const stat = await fs.stat(original);
  const lstat = await fs.lstat(original);
  if (!stat.isFile() || !lstat.isFile() || !(await fs.readFile(original)).equals(initial)) {
    throw new EnvironmentError('PATH_CANONICALIZATION_FAILED', 'FILESYSTEM_OPERATIONS', 'filesystem readback failed');
  }
  await fs.rename(original, renamed);
  await fs.writeFile(renamed, Buffer.from('overwritten', 'utf8'));
  if ((await fs.readFile(renamed, 'utf8')) !== 'overwritten') {
    throw new EnvironmentError('PATH_CANONICALIZATION_FAILED', 'FILESYSTEM_OPERATIONS', 'filesystem overwrite failed');
  }
  const nodeSpace = requireCommand(
    command(process.execPath, ['-e', "if (!process.cwd().includes(' ')) process.exit(9)"], spaceRoot),
    'NODE_TEST_FAILED',
    'SPACES_PATH',
  );
  const nodeUnicode = requireCommand(
    command(process.execPath, ['-e', "if (!/[^\\x00-\\x7F]/u.test(process.cwd())) process.exit(9)"], unicodeRoot),
    'NODE_TEST_FAILED',
    'UNICODE_PATH',
  );
  if (nodeSpace.stdout !== '' || nodeUnicode.stdout !== '') {
    throw new EnvironmentError('NODE_TEST_FAILED', 'NODE_RUNTIME', 'child Node emitted unexpected output');
  }
  await fs.rm(renamed);
  return { spaceRoot, unicodeRoot };
}

async function gitChecks(workspaces) {
  const repository = path.join(workspaces, 'git path ü with spaces');
  await fs.mkdir(repository);
  const operations = [
    [['init', '--initial-branch=main'], 'GIT_LOCAL_FAILED'],
    [['config', '--local', 'user.name', 'Sentinel Benchmark'], 'GIT_LOCAL_FAILED'],
    [['config', '--local', 'user.email', 'benchmark@sentinel.invalid'], 'GIT_LOCAL_FAILED'],
    [['config', '--local', 'commit.gpgSign', 'false'], 'GIT_LOCAL_FAILED'],
    [['config', '--local', 'core.hooksPath', '.git/benchmark-empty-hooks'], 'GIT_LOCAL_FAILED'],
  ];
  for (const [args, code] of operations) requireCommand(git(args, repository), code, 'GIT_LOCAL');
  await fs.mkdir(path.join(repository, '.git', 'benchmark-empty-hooks'));
  const tracked = path.join(repository, 'tracked ü file.txt');
  const baseline = 'baseline\n';
  await fs.writeFile(tracked, baseline, 'utf8');
  requireCommand(git(['add', '--all'], repository), 'GIT_LOCAL_FAILED', 'GIT_LOCAL');
  requireCommand(git(['commit', '-m', 'benchmark environment probe'], repository), 'GIT_LOCAL_FAILED', 'GIT_LOCAL');
  const status = requireCommand(git(['status', '--porcelain=v1'], repository), 'GIT_LOCAL_FAILED', 'GIT_LOCAL');
  if (status.stdout !== '') throw new EnvironmentError('GIT_LOCAL_FAILED', 'GIT_LOCAL', 'local Git tree is not clean');
  const revision = requireCommand(git(['rev-parse', 'HEAD'], repository), 'GIT_LOCAL_FAILED', 'GIT_LOCAL').stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new EnvironmentError('GIT_LOCAL_FAILED', 'GIT_LOCAL', 'local Git revision is invalid');
  await fs.writeFile(tracked, 'changed\n', 'utf8');
  const diff = requireCommand(git(['diff', '--', path.basename(tracked)], repository), 'GIT_LOCAL_FAILED', 'GIT_LOCAL');
  if (diff.stdout === '') throw new EnvironmentError('GIT_LOCAL_FAILED', 'GIT_LOCAL', 'local Git diff was empty');
  await fs.writeFile(tracked, baseline, 'utf8');
  if (requireCommand(git(['status', '--porcelain=v1'], repository), 'GIT_LOCAL_FAILED', 'GIT_LOCAL').stdout !== '') {
    throw new EnvironmentError('GIT_LOCAL_FAILED', 'GIT_LOCAL', 'local Git restoration failed');
  }
}

async function managedTmpChecks(runnerTmp) {
  const script = String.raw`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const expected = fs.realpathSync(process.argv[1]);
    const inherited = fs.realpathSync(process.env.TMPDIR) === expected;
    const osMatch = fs.realpathSync(os.tmpdir()) === expected;
    const created = fs.mkdtempSync(path.join(os.tmpdir(), 'child-'));
    const first = path.join(created, 'first.txt');
    const second = path.join(created, 'second.txt');
    fs.writeFileSync(first, 'managed tmp', 'utf8');
    const readback = fs.readFileSync(first, 'utf8') === 'managed tmp';
    fs.renameSync(first, second);
    fs.rmSync(second);
    fs.rmdirSync(created);
    process.stdout.write(JSON.stringify({ inherited, osMatch, readback, removed: !fs.existsSync(created) }));
  `;
  const environment = { ...process.env, TMPDIR: runnerTmp };
  const child = requireCommand(
    command(process.execPath, ['-e', script, runnerTmp], runnerTmp, { environment }),
    'TMPDIR_NOT_INHERITED',
    'CHILD_ENVIRONMENT',
  );
  let facts;
  try {
    facts = JSON.parse(child.stdout);
  } catch {
    throw new EnvironmentError('TMPDIR_NOT_INHERITED', 'CHILD_ENVIRONMENT', 'managed TMPDIR child output was invalid');
  }
  if (facts.inherited !== true || facts.osMatch !== true) {
    throw new EnvironmentError('TMPDIR_NOT_INHERITED', 'CHILD_ENVIRONMENT', 'managed TMPDIR was not inherited canonically');
  }
  if (facts.readback !== true || facts.removed !== true) {
    throw new EnvironmentError('MKDTEMP_FAILED', 'MANAGED_TMPDIR', 'managed TMPDIR operations failed');
  }
}

async function symlinkSafety(sessionRoot, workspaces) {
  const externalTarget = path.join(sessionRoot, 'controlled symlink target');
  const cleanupRoot = path.join(workspaces, 'symlink cleanup');
  await fs.mkdir(externalTarget);
  await fs.writeFile(path.join(externalTarget, 'sentinel.txt'), 'preserve', 'utf8');
  await fs.mkdir(cleanupRoot);
  await fs.symlink(externalTarget, path.join(cleanupRoot, 'unexpected-link'), 'dir');
  await fs.rm(cleanupRoot, { recursive: true });
  if ((await fs.readFile(path.join(externalTarget, 'sentinel.txt'), 'utf8')) !== 'preserve') {
    throw new EnvironmentError('CLEANUP_FAILED', 'SYMLINK_SAFETY', 'cleanup followed an unexpected symlink');
  }
}

function markPass(checks, ...ids) {
  for (const id of ids) checks[id] = 'PASS';
}

export async function runDoctor({ repositoryRoot, benchmarkRoot, scratchParent }) {
  const canonicalRepository = await fs.realpath(repositoryRoot);
  await validateScratchParent(scratchParent, canonicalRepository);
  const checks = Object.fromEntries(CHECK_IDS.map((id) => [id, 'NOT_RUN']));
  const blockers = [];
  const report = {
    status: 'ENVIRONMENT_BLOCKED',
    contractVersion: CONTRACT_VERSION,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    gitVersion: 'unavailable',
    checks,
    globalGitConfigPreserved: false,
    blockers,
  };
  let session = null;
  let globalBefore;
  let repositoryBefore;
  let seedBefore;
  let primaryError = null;

  try {
    globalBefore = await globalGitFingerprint();
    repositoryBefore = requireCommand(
      git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], canonicalRepository),
      'WORKSPACE_MUTATED',
      'CHECKOUT_PRESERVATION',
    ).stdout;
    seedBefore = await treeFingerprint(path.join(benchmarkRoot, 'seed'));

    const childVersion = requireCommand(command(process.execPath, ['--version'], canonicalRepository), 'NODE_UNAVAILABLE', 'NODE_RUNTIME');
    if (childVersion.stdout.trim() !== process.version) {
      throw new EnvironmentError('NODE_UNAVAILABLE', 'NODE_RUNTIME', 'child Node version differs from parent');
    }
    requireCommand(command(process.execPath, ['-e', 'process.exit(7)'], canonicalRepository), 'NODE_UNAVAILABLE', 'NODE_RUNTIME', 7);
    markPass(checks, 'NODE_RUNTIME');

    const gitVersion = requireCommand(command('git', ['--version'], canonicalRepository), 'GIT_UNAVAILABLE', 'GIT_LOCAL').stdout.trim();
    if (!/^git version \S+/u.test(gitVersion)) throw new EnvironmentError('GIT_UNAVAILABLE', 'GIT_LOCAL', 'Git version is invalid');
    report.gitVersion = gitVersion.replace(/^git version /u, '');

    const osTemp = await validateOsTemp(canonicalRepository);
    markPass(checks, 'OS_TEMP');
    session = await createManagedBenchmarkSession({
      repositoryRoot: canonicalRepository,
      scratchParent,
    });
    const {
      root: sessionRoot,
      parent,
      workspaces,
      runnerTmp,
    } = session;
    markPass(checks, 'MANAGED_SESSION_TEMP');

    const { spaceRoot, unicodeRoot } = await filesystemChecks(workspaces);
    markPass(checks, 'FILESYSTEM_OPERATIONS', 'SPACES_PATH', 'UNICODE_PATH');

    const nodeTest = path.join(spaceRoot, 'environment.test.mjs');
    await fs.writeFile(nodeTest, "import test from 'node:test'; import assert from 'node:assert/strict'; test('environment', () => assert.equal(1, 1));\n", 'utf8');
    requireCommand(command(process.execPath, ['--test', nodeTest], unicodeRoot), 'NODE_TEST_FAILED', 'NODE_RUNTIME');

    await gitChecks(workspaces);
    markPass(checks, 'GIT_LOCAL');

    await managedTmpChecks(runnerTmp);
    markPass(checks, 'MANAGED_TMPDIR', 'CHILD_ENVIRONMENT');

    const canonicalOsTemp = await fs.realpath(os.tmpdir());
    const canonicalParent = await fs.realpath(parent);
    if (process.platform === 'darwin') {
      if (!inside(sessionRoot, canonicalParent)
        || inside(sessionRoot, canonicalRepository)
        || (!inside(canonicalParent, canonicalOsTemp) && scratchParent === undefined)) {
        throw new EnvironmentError('PATH_CANONICALIZATION_FAILED', 'PLATFORM_CANONICALIZATION', 'macOS canonical temp relationship failed');
      }
      checks.PLATFORM_CANONICALIZATION = 'PASS';
    } else {
      checks.PLATFORM_CANONICALIZATION = 'NOT_APPLICABLE';
    }

    await symlinkSafety(sessionRoot, workspaces);
    markPass(checks, 'SYMLINK_SAFETY');
  } catch (error) {
    primaryError = error instanceof EnvironmentError
      ? error
      : new EnvironmentError('PATH_CANONICALIZATION_FAILED', 'MANAGED_SESSION_TEMP', 'unexpected environment failure');
    if (Object.hasOwn(checks, primaryError.check)) checks[primaryError.check] = 'BLOCKED';
    blockers.push(primaryError.code);
  } finally {
    if (session !== null) {
      try {
        await cleanupManagedBenchmarkSession(session);
        checks.CLEANUP = 'PASS';
      } catch {
        checks.CLEANUP = 'BLOCKED';
        if (!blockers.includes('CLEANUP_FAILED')) blockers.push('CLEANUP_FAILED');
      }
    } else if (primaryError !== null) {
      checks.CLEANUP = 'PASS';
    }

    try {
      const repositoryAfter = requireCommand(
        git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], canonicalRepository),
        'WORKSPACE_MUTATED',
        'CHECKOUT_PRESERVATION',
      ).stdout;
      checks.CHECKOUT_PRESERVATION = repositoryBefore === repositoryAfter ? 'PASS' : 'BLOCKED';
      if (checks.CHECKOUT_PRESERVATION === 'BLOCKED' && !blockers.includes('WORKSPACE_MUTATED')) blockers.push('WORKSPACE_MUTATED');
    } catch {
      checks.CHECKOUT_PRESERVATION = 'BLOCKED';
      if (!blockers.includes('WORKSPACE_MUTATED')) blockers.push('WORKSPACE_MUTATED');
    }

    try {
      checks.SEED_PRESERVATION = seedBefore === await treeFingerprint(path.join(benchmarkRoot, 'seed')) ? 'PASS' : 'BLOCKED';
      if (checks.SEED_PRESERVATION === 'BLOCKED' && !blockers.includes('WORKSPACE_MUTATED')) blockers.push('WORKSPACE_MUTATED');
    } catch {
      checks.SEED_PRESERVATION = 'BLOCKED';
      if (!blockers.includes('WORKSPACE_MUTATED')) blockers.push('WORKSPACE_MUTATED');
    }

    try {
      report.globalGitConfigPreserved = JSON.stringify(globalBefore) === JSON.stringify(await globalGitFingerprint());
      checks.GLOBAL_GIT_CONFIG = report.globalGitConfigPreserved ? 'PASS' : 'BLOCKED';
      if (!report.globalGitConfigPreserved && !blockers.includes('GLOBAL_GIT_CHANGED')) blockers.push('GLOBAL_GIT_CHANGED');
    } catch {
      checks.GLOBAL_GIT_CONFIG = 'BLOCKED';
      if (!blockers.includes('GLOBAL_GIT_CHANGED')) blockers.push('GLOBAL_GIT_CHANGED');
    }
  }

  const mandatoryPassed = Object.values(checks).every((value) => value === 'PASS' || value === 'NOT_APPLICABLE');
  if (mandatoryPassed && blockers.length === 0) report.status = 'ENVIRONMENT_READY';
  return { report, exitCode: report.status === 'ENVIRONMENT_READY' ? 0 : 1 };
}

export async function runProbeDoctor({ workspace, expectedTmpdir }) {
  for (const [value, label] of [[workspace, '--probe-workspace'], [expectedTmpdir, '--expect-tmpdir']]) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new DoctorInvocationError(`${label} must be absolute`);
  }
  const canonicalWorkspace = await fs.realpath(workspace).catch(() => {
    throw new DoctorInvocationError('--probe-workspace must exist');
  });
  const canonicalExpectedTmp = await fs.realpath(expectedTmpdir).catch(() => {
    throw new DoctorInvocationError('--expect-tmpdir must exist');
  });
  const facts = {
    workspace: false,
    managedTmpdirInherited: false,
    osTmpdirCanonicalMatch: false,
    mkdtemp: false,
    writeRead: false,
    renameRemove: false,
    nodeTest: false,
    gitTreePreserved: false,
    unexpectedEffects: 'none',
  };
  let tempChild = null;
  try {
    facts.workspace = await fs.realpath(process.cwd()) === canonicalWorkspace;
    facts.managedTmpdirInherited = typeof process.env.TMPDIR === 'string'
      && await fs.realpath(process.env.TMPDIR).catch(() => null) === canonicalExpectedTmp;
    facts.osTmpdirCanonicalMatch = await fs.realpath(os.tmpdir()).catch(() => null) === canonicalExpectedTmp;
    const before = requireCommand(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], canonicalWorkspace), 'WORKSPACE_MUTATED', 'CHECKOUT_PRESERVATION').stdout;
    const tests = command(process.execPath, ['--test'], canonicalWorkspace, { environment: process.env });
    facts.nodeTest = tests.status === 0 && tests.error === undefined;
    tempChild = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-probe-'));
    facts.mkdtemp = inside(await fs.realpath(tempChild), canonicalExpectedTmp);
    const first = path.join(tempChild, 'first.txt');
    const second = path.join(tempChild, 'second.txt');
    await fs.writeFile(first, 'sandbox probe', 'utf8');
    facts.writeRead = await fs.readFile(first, 'utf8') === 'sandbox probe';
    await fs.rename(first, second);
    await fs.rm(second);
    await fs.rmdir(tempChild);
    tempChild = null;
    facts.renameRemove = true;
    const after = requireCommand(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], canonicalWorkspace), 'WORKSPACE_MUTATED', 'CHECKOUT_PRESERVATION').stdout;
    facts.gitTreePreserved = before === '' && after === '';
  } catch {
    facts.unexpectedEffects = 'environment check failed';
  } finally {
    if (tempChild !== null) await fs.rm(tempChild, { recursive: true, force: true });
  }
  const passed = Object.entries(facts).every(([key, value]) => key === 'unexpectedEffects' ? value === 'none' : value === true);
  return { status: passed ? 'PASS' : 'BLOCKED', ...facts };
}

export { DoctorInvocationError };
