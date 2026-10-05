#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManagedSliceContext, assertManagedRunnerReceipt, assertManagedRuntimeIdentity }
  from '../../../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';
import { assertManagedSliceFreshness } from './managed-slice-preflight.mjs';
import { prepareExecutionCopy, publishExecutionCopy } from '../../../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import { prepareValidationCopy } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import { prepareValidationCandidate } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import { publishValidationCandidate } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import { serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate,
  recoverableRunnerResultDiagnostic, persistMalformedRunnerResultInCandidate }
  from '../../../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import { inspectExecutionState, validateExecutionCandidate, resolveExecutionWorkspace, deriveNormalHandoff, computeRequirementsAuthority }
  from '../../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function regular(file) {
  const metadata = await fs.lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || await fs.realpath(file) !== file) throw new Error('managed finalizer file is unsafe');
  return fs.readFile(file);
}
async function read(file) { return JSON.parse(await regular(file)); }
async function write(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function optional(file) {
  try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function finalizeManagedSlice(mode) {
  const environment = process.env;
  if (!['--prepare', '--finalize'].includes(mode)) throw new Error('usage: managed-slice-finalize.mjs --prepare|--finalize');
  const context = readManagedSliceContext(environment);
  if (context === null) throw new Error('managed finalizer requires managed context');
  const expected = path.join(context.identity.snapshot.path, 'agents/codex/runtime/managed-slice-finalize.mjs');
  if (await fs.realpath(fileURLToPath(import.meta.url)) !== expected || environment.STNL_MANAGED_FINALIZER !== expected) throw new Error('managed finalizer must be snapshot-owned');
  await assertManagedRuntimeIdentity(context, environment);
  const tmpdir = await fs.realpath(environment.TMPDIR);
  const directory = path.join(tmpdir, 'stnl-runner-broker');
  const active = await read(path.join(directory, 'active.json'));
  if (active.protocol !== 3 || active.operation !== context.operation || active.slice !== context.slice
    || active.workspace !== context.workspace || active.tmpdir !== tmpdir || active.officialPreflight.authority !== context.authority
    || active.officialPreflight.specPath !== context.specPath || !Number.isSafeInteger(active.sequence)) throw new Error('managed finalizer active identity disagrees');
  const lockFile = path.join(directory, 'finalization.lock');
  const lock = await fs.open(lockFile, 'wx', 0o600);
  try {
  const metadataFile = (name) => path.join(directory, `${String(active.sequence).padStart(3, '0')}.${name}.json`);
  const bindingFile = metadataFile('candidate');
  const finalizedFile = metadataFile('finalization');
  const owner = { protocol: 3, operation: context.operation, slice: context.slice, sequence: active.sequence,
    authority: context.authority, specPath: context.specPath, workspace: context.workspace };
  const official = await resolveExecutionWorkspace(context.specPath);
  const taskRelative = path.join('tasks', `${context.slice}.md`);
  const liveTask = path.join(official.executionRoot, taskRelative);
  if (mode === '--prepare') {
    await assertManagedSliceFreshness(environment);
    if (await optional(bindingFile) !== null) throw new Error('managed candidate already prepared; retain its canonical identity');
    const copy = context.operation === 'VALIDATE_SLICE'
      ? await prepareValidationCopy({ specPath: context.specPath, slice: context.slice, candidateParent: tmpdir })
      : await prepareExecutionCopy({ specPath: context.specPath, slice: context.slice });
    const binding = { ...owner, nonce: randomUUID(), ...copy,
      candidateTaskArtifact: path.join(copy.candidateExecutionRoot, taskRelative),
      sourceTaskSha256: hash(await regular(liveTask)) };
    await fs.writeFile(metadataFile('candidate-owner'), JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 });
    await write(bindingFile, binding);
    return { status: 'PREPARED', candidateExecutionRoot: binding.candidateExecutionRoot,
      candidateTaskArtifact: binding.candidateTaskArtifact };
  }
  const binding = await read(bindingFile);
  if (JSON.stringify(binding) !== JSON.stringify(await read(metadataFile('candidate-owner')))
    || Object.entries(owner).some(([key, value]) => binding[key] !== value)) throw new Error('managed candidate binding disagrees');
  const latest = await read(metadataFile('latest'));
  if (latest.operation !== owner.operation || latest.slice !== owner.slice || latest.sequence !== owner.sequence
    || latest.authority !== owner.authority || latest.workspace !== owner.workspace || latest.tmpdir !== tmpdir) throw new Error('managed receipt association disagrees');
  const receipt = latest.receipt;
  if (!receipt || !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1 || receipt.attempt > 3) throw new Error('managed receipt attempt disagrees');
  const stem = `${String(owner.sequence).padStart(3, '0')}-${owner.operation.toLowerCase()}-${owner.slice}-attempt-${receipt.attempt}`;
  const evidenceFiles = ['receipt.json', 'response.json', 'events.jsonl', 'started.json'].map((suffix) => path.join(tmpdir, `${stem}.${suffix}`));
  if (receipt.receiptFile !== evidenceFiles[0] || receipt.semanticResponseFile !== evidenceFiles[1]
    || receipt.eventsPath !== evidenceFiles[2]) throw new Error('managed receipt paths disagree');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(latest.requestId ?? '')) throw new Error('managed sealed request identity disagrees');
  const sealed = await read(path.join(directory, `sealed-${latest.requestId}.json`));
  if (sealed.requestId !== latest.requestId || sealed.operation !== owner.operation || sealed.slice !== owner.slice
    || sealed.sequence !== owner.sequence || sealed.workspace !== owner.workspace || sealed.tmpdir !== tmpdir
    || typeof sealed.prompt !== 'string' || hash(sealed.prompt) !== latest.payloadSha256) throw new Error('managed sealed payload association disagrees');
  const diskReceipt = await read(receipt.receiptFile);
  if (JSON.stringify(diskReceipt) !== JSON.stringify(receipt)) throw new Error('managed receipt changed after broker settlement');
  const prior = await optional(finalizedFile);
  if (prior?.receiptFile === receipt.receiptFile) {
    const task = prior.state === 'PRIVATE_TESTS_FAIL' ? binding.candidateTaskArtifact : liveTask;
    if (JSON.stringify(Object.keys(prior.evidenceSha256 ?? {}).sort()) !== JSON.stringify([...evidenceFiles].sort())) throw new Error('managed finalized evidence paths disagree');
    if (`sha256:${await computeRequirementsAuthority(context.specPath)}` !== owner.authority
      || hash(await regular(task)) !== prior.taskSha256 || hash(await regular(path.join(official.executionRoot, 'tasks.md'))) !== prior.indexSha256
      || await Promise.all(Object.entries(prior.evidenceSha256).map(async ([file, expectedHash]) =>
        hash(await regular(file)) === expectedHash)).then((matches) => matches.some((matchesHash) => !matchesHash))) throw new Error('managed finalization readback conflict');
    return prior;
  }
  await assertManagedSliceFreshness(environment);
  await assertManagedRunnerReceipt({ operation: owner.operation, slice: owner.slice, workspace: owner.workspace,
    receiptFile: receipt.receiptFile, semanticResponseFile: receipt.semanticResponseFile, allowRejected: true, environment });
  const candidateRoot = await fs.realpath(binding.candidateExecutionRoot);
  const expectedParent = context.operation === 'VALIDATE_SLICE' ? tmpdir
    : path.dirname(official.specRoot ?? official.executionRoot);
  const root = context.operation === 'VALIDATE_SLICE' ? candidateRoot : await fs.realpath(binding.candidateRoot);
  if (path.dirname(root) !== expectedParent || (context.operation === 'VALIDATE_SLICE'
    ? !path.basename(root).startsWith(`validation-${context.slice}-`)
    : !path.basename(root).startsWith('.stnl-execution-copy-')
      || candidateRoot !== (official.specRoot === null ? root : path.join(root, 'execution')))
    || binding.candidateTaskArtifact !== path.join(candidateRoot, taskRelative)
    || binding.sourceTaskSha256 !== hash(await regular(liveTask))) throw new Error('managed candidate path/source identity disagrees');
  let privateFailure = false;
  if (context.operation === 'VALIDATE_SLICE') {
    await prepareValidationCandidate({ specPath: context.specPath, slice: context.slice, workspace: context.workspace,
      candidateExecutionRoot: candidateRoot, semanticResponseFile: receipt.semanticResponseFile, receiptFile: receipt.receiptFile });
  } else {
    try {
      const response = (await regular(receipt.semanticResponseFile)).toString('utf8');
      const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: context.operation,
        response, workspace: context.workspace, taskArtifact: binding.candidateTaskArtifact,
        receiptFile: receipt.receiptFile, semanticResponseFile: receipt.semanticResponseFile });
      await insertExecutionEvidenceInCandidate({ taskArtifact: binding.candidateTaskArtifact, operation: context.operation, bundle });
      const parsed = JSON.parse(response);
      privateFailure = parsed.status === 'TESTS_FAIL' && parsed.automaticCheckRound !== '3/3';
    } catch (error) {
      const diagnostic = recoverableRunnerResultDiagnostic(error);
      if (diagnostic === null) throw error;
      await persistMalformedRunnerResultInCandidate({ taskArtifact: binding.candidateTaskArtifact,
        operation: context.operation, workspace: context.workspace, receiptFile: receipt.receiptFile,
        semanticResponseFile: receipt.semanticResponseFile, diagnostic, error });
    }
  }
  // Intermediate failure is retained privately before correction. Publication
  // validation belongs to the existing terminal boundary, not to round 1/2.
  const validated = privateFailure ? null : await validateExecutionCandidate(context.specPath, candidateRoot);
  if (!privateFailure) {
    if (context.operation === 'VALIDATE_SLICE') await publishValidationCandidate({ specPath: context.specPath, slice: context.slice, candidateExecutionRoot: candidateRoot });
    else await publishExecutionCopy({ specPath: context.specPath, slice: context.slice, candidateRoot: root });
  }
  const readback = await inspectExecutionState(context.specPath);
  if (!privateFailure && readback.state !== validated.state) throw new Error('managed publication/readback conflict');
  const result = { ...owner, receiptFile: receipt.receiptFile, state: privateFailure ? 'PRIVATE_TESTS_FAIL' : readback.state,
    evidenceSha256: Object.fromEntries(await Promise.all(evidenceFiles.map(async (file) => [file, hash(await regular(file))]))),
    taskSha256: hash(await regular(privateFailure ? binding.candidateTaskArtifact : liveTask)),
    indexSha256: hash(await regular(path.join(official.executionRoot, 'tasks.md'))),
    mandatoryRecovery: readback.mandatoryRecovery ?? null, handoff: deriveNormalHandoff(readback),
    published: !privateFailure };
  await write(finalizedFile, result);
  return result;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    if (process.argv.length !== 3) throw new Error('managed finalizer takes only --prepare or --finalize');
    process.stdout.write(JSON.stringify(await finalizeManagedSlice(process.argv[2])) + '\n');
  } catch (error) { process.stderr.write(`BLOCKED: ${error.code ?? 'MANAGED_FINALIZATION_FAILED'}: ${error.message}\n`); process.exitCode = 1; }
}
