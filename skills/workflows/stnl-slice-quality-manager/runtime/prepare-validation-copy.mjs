#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveExecutionWorkspace } from './execution-state.mjs';
import { assertManagedAgreement } from './managed-validation-context.mjs';

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function manifest(root) {
  const result = [];
  async function walk(directory, prefix = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.DS_Store' || entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
      const relative = path.join(prefix, entry.name);
      const file = path.join(directory, entry.name);
      const metadata = await fs.lstat(file);
      if (metadata.isSymbolicLink()) throw new Error(`candidate source contains a symlink: ${relative}`);
      if (metadata.isDirectory()) { result.push({ path: relative, type: 'directory' }); await walk(file, relative); }
      else if (metadata.isFile()) result.push({ path: relative, type: 'file', hash: createHash('sha256').update(await fs.readFile(file)).digest('hex') });
      else throw new Error(`candidate source contains an unsupported entry: ${relative}`);
    }
  }
  await walk(root);
  return result;
}

export async function prepareValidationCopy({ specPath, slice, candidateParent }) {
  assertManagedAgreement({ specPath, slice });
  if (typeof specPath !== 'string' || !path.isAbsolute(specPath)
    || !/^slice-[0-9]{2,}$/u.test(slice) || typeof candidateParent !== 'string'
    || !path.isAbsolute(candidateParent) || await fs.realpath(candidateParent) !== candidateParent) {
    throw new Error('validation candidate inputs are invalid');
  }
  const resolved = await resolveExecutionWorkspace(specPath);
  const source = await fs.realpath(resolved.executionRoot);
  if (inside(candidateParent, source) || inside(source, candidateParent)
    || (resolved.specRoot && (inside(candidateParent, resolved.specRoot) || inside(resolved.specRoot, candidateParent)))) {
    throw new Error('validation candidate parent overlaps official artifacts');
  }
  const original = await manifest(source);
  const candidate = await fs.mkdtemp(path.join(candidateParent, `validation-${slice}-`));
  try {
    await fs.cp(source, candidate, { recursive: true, force: false, errorOnExist: false,
      filter: (entry) => !['.DS_Store', '__MACOSX'].includes(path.basename(entry)) && !path.basename(entry).startsWith('._') });
    if (JSON.stringify(await manifest(candidate)) !== JSON.stringify(original)) {
      throw new Error('validation candidate differs from the official execution tree');
    }
    return { candidateExecutionRoot: candidate, executionRoot: source, entries: original.length };
  } catch (error) { await fs.rm(candidate, { recursive: true, force: true }); throw error; }
}

export async function main(argv) {
  if (argv.length !== 6 || argv[0] !== '--spec-path' || argv[2] !== '--slice' || argv[4] !== '--candidate-parent') {
    throw new Error('usage: prepare-validation-copy.mjs --spec-path <absolute> --slice <slice-NN> --candidate-parent <absolute>');
  }
  const result = await prepareValidationCopy({ specPath: argv[1], slice: argv[3], candidateParent: argv[5] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
