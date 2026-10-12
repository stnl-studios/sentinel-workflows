#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveExecutionWorkspace, validateExecutionCandidate, readExecutionActivation, preparationAuthorityAt, retainOperationalWork } from './execution-state.mjs';
import { assertOperationalTaskHistory, parsePreparationArtifact } from './execution-preparation.mjs';
import { assertManagedAgreement } from './managed-slice-context.mjs';

import { withExecutionPublicationLock, publishExecutionUpdate, captureExecutionTree, assertExecutionAttempt, readOperationOwner, registerOwnedAllocation, acknowledgePublishedCandidate } from './execution-publication.mjs';

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
  assertManagedAgreement({ specPath, slice });
  const resolved = await resolveExecutionWorkspace(specPath);
  const executionRoot = await fs.realpath(resolved.executionRoot);
  const specRoot = resolved.specRoot === null ? null : await fs.realpath(resolved.specRoot);
  const parent = await fs.realpath(path.dirname(specRoot ?? executionRoot));
  const taskRelative = path.join('tasks', `${slice}.md`);
  const task = path.join(executionRoot, taskRelative);
  if (!(await fs.stat(task)).isFile()) throw new Error('selected task is not a regular file');
  return { resolved, executionRoot, specRoot, parent, taskRelative, task };
}

async function prepareExecutionCopyLocked({ specPath, slice, owner }) {
  const details = await context(specPath, slice);
  const admitted = await readExecutionActivation(specPath);
  assertExecutionAttempt(admitted.activation, owner);
  if (!["EXECUTE_SLICE", "APPLY_FINDINGS"].includes(owner.operation) || owner.slice !== slice) throw new Error("execution copy requires the selected implementation owner");
  const tree = await captureExecutionTree(details.executionRoot);
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
    await fs.writeFile(`${candidateRoot}.copy.json`, JSON.stringify({
      specPath: await fs.realpath(specPath), slice, executionRoot: details.executionRoot,
      source, tree, owner, producer:'execution-copy',allocationId:randomUUID(),retentionRoot:candidateRoot,candidate:candidateRoot, expectedActivationId: admitted.activation.activationId,
    }), { flag: 'wx' });
    await registerOwnedAllocation(owner.workCapture,`${candidateRoot}.copy.json`);
    return Object.freeze({ candidateRoot, candidateExecutionRoot,
      candidateTaskArtifact: path.join(candidateExecutionRoot, details.taskRelative),
      liveTaskArtifact: details.task, entries: source.length });
  } catch (error) {
    error.retainedCandidate=candidateRoot;error.message+=`; partial owned candidate retained: ${candidateRoot}`;
    throw error;
  }
}

export async function publishExecutionCopy({ specPath, slice, candidateRoot, owner = null, terminal = true, checkpoint = null }) {
  const details = await context(specPath, slice);
  const root = await fs.realpath(candidateRoot);
  if (path.dirname(root) !== details.parent || !path.basename(root).startsWith('.stnl-execution-copy-')
    || inside(root, details.executionRoot) || (details.specRoot !== null && inside(root, details.specRoot))) {
    throw new Error('candidate root is not an owned same-depth sibling');
  }
  const marker = JSON.parse(await fs.readFile(`${root}.copy.json`, 'utf8'));
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
  const selectedPlan = path.join('plans', `${slice}.md`);
  const assertScope = async proposedRoot => {
    const proposed = await manifest(proposedRoot); const proposedMap = new Map(proposed.map(entry => [entry.path, entry]));
    const changes = [...new Set([...before.keys(), ...proposedMap.keys()])].filter(key => JSON.stringify(before.get(key)) !== JSON.stringify(proposedMap.get(key)));
    if (changes.some(relative => ![details.taskRelative, selectedPlan].includes(relative)) || !changes.includes(details.taskRelative)) throw new Error('execution candidate changes artifacts outside selected operational delivery');
    if (changes.includes(selectedPlan)) {
      const old = parsePreparationArtifact(await fs.readFile(path.join(details.executionRoot, selectedPlan), 'utf8'), selectedPlan);
      const next = parsePreparationArtifact(await fs.readFile(path.join(proposedRoot, selectedPlan), 'utf8'), selectedPlan);
      delete old.sections['Expected Files']; delete next.sections['Expected Files'];
      if (JSON.stringify(old) !== JSON.stringify(next)) throw new Error('execution changed protected detailed Plan');
    }
    assertOperationalTaskHistory(await fs.readFile(details.task, 'utf8'), await fs.readFile(path.join(proposedRoot, details.taskRelative), 'utf8'), marker.owner, marker.owner.operation);
  };
  await assertScope(candidateExecutionRoot);
  const validation = await validateExecutionCandidate(specPath, candidateExecutionRoot);
  if (!['EXECUTE_SLICE', 'APPLY_FINDINGS'].includes(marker.owner.operation)) throw new Error('execution publisher requires implementation ownership');
  if (['RUNNER_INITIALIZATION_BLOCKED', 'RUNNER_RESULT_BLOCKED'].includes(validation.state)) terminal = false;
  if (terminal) {
    const text = await fs.readFile(path.join(candidateExecutionRoot, details.taskRelative), 'utf8');
    const heading = marker.owner.operation === 'EXECUTE_SLICE' ? 'Implementation Test Evidence' : 'Findings Test Evidence';
    const sections = parsePreparationArtifact(text, details.taskRelative).sections;
    const body = sections[heading];
    const latest = body.split(/(?=^### )/mu).filter(value => value.trim()).at(-1) ?? '';
    const status = latest.match(/^- Status: (TESTS_FAIL|TESTS_PASS|TESTS_NOT_APPLICABLE|BLOCKED)$/mu)?.[1];
    const round = latest.match(/^- Automatic check round: ([123])\/3$/mu)?.[1];
    // A validated active blocking divergence ends this operation and hands
    // authority to REPLAN/RESUME, including interruptions before round 3.
    // Advisory records and a checklist-only update cannot release the owner.
    const interrupted = validation.state === 'DIVERGENCE_BLOCKED'
      && sections.Divergences.split(/(?=^### )/mu).some(record => /^- Severity: blocking$/mu.test(record) && /^- State: active$/mu.test(record));
    if (!interrupted && (!status || (status === 'TESTS_FAIL' && round !== '3'))) throw new Error('terminal publication requires the bounded operation result; checklist-only update must keep ownership');
  }
  if (validation.status === 'BLOCKED') throw new Error(`candidate validation blocked: ${validation.reason ?? 'unknown'}`);
  const managed = assertManagedAgreement({ specPath, slice });
  if (managed?.operation === 'EXECUTE_SLICE' && validation.state === 'EXECUTION_STARTED') {
    const taskText = await fs.readFile(path.join(candidateExecutionRoot, details.taskRelative), 'utf8');
    const sectionStart = taskText.indexOf('## Implementation Test Evidence\n');
    const sectionEnd = sectionStart < 0 ? -1 : taskText.indexOf('\n## ', sectionStart + 1);
    const section = sectionStart < 0 ? '' : taskText.slice(sectionStart, sectionEnd < 0 ? undefined : sectionEnd);
    const headers = [...section.matchAll(/^### implementation-check-[0-9]{2,}\s*$/gmu)];
    const latest = headers.length === 0 ? '' : section.slice(headers.at(-1).index);
    const status = latest.match(/^- Status: (TESTS_FAIL|TESTS_PASS|TESTS_NOT_APPLICABLE|BLOCKED)$/mu)?.[1];
    const round = latest.match(/^- Automatic check round: ([123])\/3$/mu)?.[1];
    if (!(status === 'TESTS_FAIL' && (round === '1' || round === '2'))) {
      throw new Error(`EXECUTE_SLICE candidate remains EXECUTION_STARTED without publishable runner evidence (${status ?? 'missing status'}); refusing publication`);
    }
  }
  if (owner && JSON.stringify(owner) !== JSON.stringify(marker.owner)) throw new Error('copy owner differs');
  const disposableTree=await captureExecutionTree(root);
  const publication = await publishExecutionUpdate({ workspace: details.resolved, candidateExecutionRoot,
    expectedTree: marker.tree, expectedActivationId: marker.expectedActivationId, owner: marker.owner, terminal, checkpoint,
    readActivated: () => readExecutionActivation(specPath),
    prepareRetention: details => retainOperationalWork({specPath,...details,owner:marker.owner}),
    validateCandidate: async root => { await validateExecutionCandidate(specPath, root); return preparationAuthorityAt(root); },
    authorizeDiff: async staged => {
      await assertScope(staged);
      if (JSON.stringify(await manifest(details.executionRoot)) !== JSON.stringify(marker.source)) throw new Error('live source changed under lock');
    } });
  try {await acknowledgePublishedCandidate({workspace:details.resolved,marker:`${root}.copy.json`,candidateTree:disposableTree,publication,readActivated:()=>readExecutionActivation(specPath)});}
  catch(error) {publication.candidateCleanupDiagnostic=error.message;}
  // Confirmed publication is independent of temporary candidate cleanup.
  // Keep the selected candidate until its producer proves that no receipt,
  // history or uncertain result depends on it. Publication is already confirmed.
  return { status: 'PASS', state: validation.state, liveTaskArtifact: details.task, retainedCandidate:root, ...publication };
}

export async function prepareExecutionCopy({ specPath, slice, owner = null }) {
  const workspace = await resolveExecutionWorkspace(specPath);
  const managed = assertManagedAgreement({ specPath, slice });
  const admittedOwner = owner ?? managed?.owner ?? await readOperationOwner(specPath);
  return withExecutionPublicationLock(workspace, () => prepareExecutionCopyLocked({ specPath, slice, owner: admittedOwner }));
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
