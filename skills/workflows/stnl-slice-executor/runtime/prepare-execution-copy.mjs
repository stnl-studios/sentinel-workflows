#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveExecutionWorkspace, validateExecutionCandidate } from './execution-state.mjs';

const markerName = '.stnl-execution-copy.json';

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function manifest(root) {
  const entries = [];
  async function walk(directory, prefix = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(prefix, entry.name);
      const physical = path.join(directory, entry.name);
      const metadata = await fs.lstat(physical);
      if (metadata.isSymbolicLink()) throw new Error(`execution tree contains a symlink: ${relative}`);
      if (metadata.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        await walk(physical, relative);
      } else if (metadata.isFile()) {
        entries.push({ path: relative, type: 'file', hash: createHash('sha256').update(await fs.readFile(physical)).digest('hex') });
      } else throw new Error(`execution tree contains an unsupported entry: ${relative}`);
    }
  }
  await walk(root);
  return entries;
}

async function context(specPath, slice) {
  if (!path.isAbsolute(specPath) || !/^slice-[0-9]{2,}$/u.test(slice)) throw new Error('spec path and slice are invalid');
  const resolved = await resolveExecutionWorkspace(specPath);
  const executionRoot = await fs.realpath(resolved.executionRoot);
  const specRoot = resolved.specRoot === null ? null : await fs.realpath(resolved.specRoot);
  const parent = await fs.realpath(path.dirname(specRoot ?? executionRoot));
  const taskRelative = path.join('tasks', `${slice}.md`);
  const task = path.join(executionRoot, taskRelative);
  if (!(await fs.stat(task)).isFile()) throw new Error('selected task is not a regular file');
  return { resolved, executionRoot, specRoot, parent, taskRelative, task };
}

export async function prepareExecutionCopy({ specPath, slice }) {
  const details = await context(specPath, slice);
  const source = await manifest(details.executionRoot);
  const candidateRoot = await fs.mkdtemp(path.join(details.parent, '.stnl-execution-copy-'));
  const candidateExecutionRoot = details.specRoot === null ? candidateRoot : path.join(candidateRoot, 'execution');
  try {
    if (details.specRoot !== null) await fs.mkdir(candidateExecutionRoot);
    for (const entry of await fs.readdir(details.executionRoot)) {
      await fs.cp(path.join(details.executionRoot, entry), path.join(candidateExecutionRoot, entry), {
        recursive: true, dereference: false, force: false, errorOnExist: true,
      });
    }
    if (JSON.stringify(await manifest(candidateExecutionRoot)) !== JSON.stringify(source)) {
      throw new Error('candidate copy differs from live execution tree');
    }
    await fs.writeFile(path.join(candidateRoot, markerName), JSON.stringify({
      specPath: await fs.realpath(specPath), slice, executionRoot: details.executionRoot,
      source,
    }), { flag: 'wx' });
    return Object.freeze({ candidateRoot, candidateExecutionRoot,
      candidateTaskArtifact: path.join(candidateExecutionRoot, details.taskRelative),
      liveTaskArtifact: details.task, entries: source.length });
  } catch (error) {
    await fs.rm(candidateRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function publishExecutionCopy({ specPath, slice, candidateRoot }) {
  const details = await context(specPath, slice);
  const root = await fs.realpath(candidateRoot);
  if (path.dirname(root) !== details.parent || !path.basename(root).startsWith('.stnl-execution-copy-')
    || inside(root, details.executionRoot) || (details.specRoot !== null && inside(root, details.specRoot))) {
    throw new Error('candidate root is not an owned same-depth sibling');
  }
  const marker = JSON.parse(await fs.readFile(path.join(root, markerName), 'utf8'));
  if (marker.specPath !== await fs.realpath(specPath) || marker.slice !== slice || marker.executionRoot !== details.executionRoot) {
    throw new Error('candidate identity differs from the selected live execution');
  }
  if (JSON.stringify(await manifest(details.executionRoot)) !== JSON.stringify(marker.source)) {
    throw new Error('live execution tree changed since candidate preparation');
  }
  const candidateExecutionRoot = details.specRoot === null ? root : path.join(root, 'execution');
  const candidate = await manifest(candidateExecutionRoot);
  const before = new Map(marker.source.map((entry) => [entry.path, entry]));
  const after = new Map(candidate.map((entry) => [entry.path, entry]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((key) => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)));
  if (changed.length !== 1 || changed[0] !== details.taskRelative) {
    throw new Error(`candidate must change only the selected task artifact; changed: ${changed.join(', ') || 'none'}`);
  }
  const validation = await validateExecutionCandidate(specPath, candidateExecutionRoot);
  if (validation.status === 'BLOCKED') throw new Error(`candidate validation blocked: ${validation.reason ?? 'unknown'}`);
  const candidateTask = path.join(candidateExecutionRoot, details.taskRelative);
  const temporary = `${details.task}.stnl-publish-${process.pid}.tmp`;
  try {
    await fs.copyFile(candidateTask, temporary, fs.constants.COPYFILE_EXCL);
    await fs.rename(temporary, details.task);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  await fs.rm(root, { recursive: true, force: true });
  return Object.freeze({ status: 'PASS', liveTaskArtifact: details.task, state: validation.state });
}

async function main(argv) {
  if (argv.length === 5 && argv[0] === '--prepare' && argv[1] === '--spec-path' && argv[3] === '--slice') {
    return prepareExecutionCopy({ specPath: argv[2], slice: argv[4] });
  }
  if (argv.length === 7 && argv[0] === '--publish' && argv[1] === '--spec-path' && argv[3] === '--slice' && argv[5] === '--candidate-root') {
    return publishExecutionCopy({ specPath: argv[2], slice: argv[4], candidateRoot: argv[6] });
  }
  throw new Error('usage: prepare-execution-copy.mjs --prepare|--publish --spec-path <absolute> --slice <slice-NN> [--candidate-root <absolute>]');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
