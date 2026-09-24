import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNS_ROOT = path.join(REPOSITORY_ROOT, 'benchmark-temp');
const SOURCE_ROOTS = ['skills', 'agents', 'templates', 'scripts', 'benchmarks/sentinel-todo'];
const OWNERSHIP = 'sentinel-todo-run-v2\n';

function ignored(name) {
  return name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._');
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function git(args) {
  const result = spawnSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

async function assertOwnedRun(runRoot) {
  const runs = await fs.realpath(RUNS_ROOT);
  const run = await fs.realpath(runRoot);
  if (path.dirname(run) !== runs || !/^[a-z0-9][a-z0-9-]{7,}$/u.test(path.basename(run))) {
    throw new Error('run must be a direct child of benchmark-temp');
  }
  const marker = path.join(run, '.sentinel-benchmark-owned');
  const metadata = await fs.lstat(marker);
  if (!metadata.isFile() || metadata.isSymbolicLink() || await fs.readFile(marker, 'utf8') !== OWNERSHIP) {
    throw new Error('run ownership marker is invalid');
  }
  return run;
}

async function listFiles(root, relative = '', { dependencies = false } = {}) {
  const files = [];
  const directory = path.join(root, relative);
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ignored(entry.name) || entry.name === '.git' || entry.name === 'benchmark-temp'
      || (!dependencies && entry.name === 'node_modules') || (dependencies && entry.name === '.bin')) continue;
    const child = path.join(relative, entry.name);
    const metadata = await fs.lstat(path.join(root, child));
    if (metadata.isSymbolicLink()) throw new Error(`snapshot source contains a symlink: ${child}`);
    if (metadata.isDirectory()) files.push(...await listFiles(root, child, { dependencies }));
    else if (metadata.isFile()) files.push(child);
    else throw new Error(`snapshot source contains an unsupported entry: ${child}`);
  }
  return files;
}

async function hashFiles(root, files) {
  const hash = createHash('sha256').update('sentinel-functional-snapshot-v1\0');
  for (const relative of [...files].sort()) {
    const bytes = await fs.readFile(path.join(root, relative));
    hash.update(relative.split(path.sep).join('/')).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function sourceFiles() {
  const files = [];
  for (const root of SOURCE_ROOTS) files.push(...await listFiles(REPOSITORY_ROOT, root));
  return files;
}

async function copyFiles(source, destination, files) {
  for (const relative of files) {
    const target = path.join(destination, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, relative), target);
    const mode = (await fs.stat(path.join(source, relative))).mode;
    await fs.chmod(target, mode & 0o777);
  }
}

async function freeze(root) {
  const directories = [root];
  const files = await listFiles(root, '', { dependencies: true });
  for (const relative of files) {
    const file = path.join(root, relative);
    const mode = (await fs.stat(file)).mode;
    await fs.chmod(file, mode & 0o111 ? 0o555 : 0o444);
    let parent = path.dirname(file);
    while (inside(parent, root) && parent !== root) {
      directories.push(parent);
      parent = path.dirname(parent);
    }
  }
  for (const directory of new Set(directories)) await fs.chmod(directory, 0o555);
  return files;
}

export async function currentFunctionalIdentity() {
  const files = await sourceFiles();
  return { sha256: await hashFiles(REPOSITORY_ROOT, files), fileCount: files.length };
}

export async function createSnapshot(runRoot) {
  const run = await assertOwnedRun(runRoot);
  const snapshot = path.join(run, 'snapshot');
  await fs.mkdir(snapshot);
  const baseSha = git(['rev-parse', 'HEAD']).trim();
  const gitStatus = git(['status', '--porcelain=v1', '--untracked-files=all']).trimEnd();
  const functionalDiff = git(['diff', '--binary', 'HEAD', '--', ...SOURCE_ROOTS]);
  const source = await currentFunctionalIdentity();
  const files = await sourceFiles();
  await copyFiles(REPOSITORY_ROOT, snapshot, files);

  const dependencyRoot = path.join('agents', 'codex', 'node_modules');
  const sourceDependencies = path.join(REPOSITORY_ROOT, dependencyRoot);
  const sdkVersion = JSON.parse(await fs.readFile(path.join(sourceDependencies, '@openai/codex-sdk/package.json'), 'utf8')).version;
  const cliVersion = JSON.parse(await fs.readFile(path.join(sourceDependencies, '@openai/codex/package.json'), 'utf8')).version;
  if (sdkVersion !== '0.154.0' || cliVersion !== '0.154.0') throw new Error('local Codex SDK/CLI version differs from the pinned adapter');
  const dependencies = (await listFiles(sourceDependencies, '', { dependencies: true }))
    .map((relative) => path.join(dependencyRoot, relative));
  await copyFiles(REPOSITORY_ROOT, snapshot, dependencies);
  const snapshotFiles = await freeze(snapshot);
  const metadata = {
    protocol: 'sentinel-sdk-context-v1',
    baseSha,
    dirty: gitStatus !== '',
    gitStatus,
    functionalDiffSha256: `sha256:${createHash('sha256').update(functionalDiff).digest('hex')}`,
    sourceFunctionalSha256: source.sha256,
    snapshotSha256: await hashFiles(snapshot, snapshotFiles),
    sourceFileCount: source.fileCount,
    snapshotFileCount: snapshotFiles.length,
    sdkVersion,
    cliVersion,
    createdAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(run, 'snapshot.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
  return metadata;
}

export async function assertSnapshotIntegrity(runRoot, { checkSource = true } = {}) {
  const run = await assertOwnedRun(runRoot);
  const snapshot = path.join(run, 'snapshot');
  const metadata = JSON.parse(await fs.readFile(path.join(run, 'snapshot.json'), 'utf8'));
  const snapshotFiles = await listFiles(snapshot, '', { dependencies: true });
  const actual = await hashFiles(snapshot, snapshotFiles);
  if (actual !== metadata.snapshotSha256 || snapshotFiles.length !== metadata.snapshotFileCount) {
    throw new Error('snapshot content changed');
  }
  if (checkSource && (await currentFunctionalIdentity()).sha256 !== metadata.sourceFunctionalSha256) {
    throw new Error('functional source changed during the run');
  }
  return metadata;
}
