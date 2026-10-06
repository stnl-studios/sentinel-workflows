#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManagedSliceContext, assertManagedRunnerReceipt, assertManagedRuntimeIdentity }
  from '../../../skills/workflows/stnl-slice-executor/runtime/managed-slice-context.mjs';
import { assertManagedSliceFreshness } from './managed-slice-preflight.mjs';
import { bindManagedFindingsCycle, findingsEvidenceFingerprint, prepareManagedFindingsRequest, assertManagedFindingsOwnership, findingsOwnershipFingerprint, captureManagedSourceTestsHash } from './managed-findings-cycle.mjs';
import { prepareExecutionCopy, publishExecutionCopy } from '../../../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import { prepareValidationCopy } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import { prepareValidationCandidate } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import { publishValidationCandidate } from '../../../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import { serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate,
  recoverableRunnerResultDiagnostic, persistMalformedRunnerResultInCandidate, captureRunnerTestedState }
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
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
async function tree(root) {
  if (await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) throw new Error('managed candidate root is unsafe');
  const entries = [];
  async function walk(relative) {
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
      const key = path.join(relative, name), file = path.join(root, key), metadata = await fs.lstat(file);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        entries.push({ path: key, type: 'directory' }); await walk(key);
      } else entries.push({ path: key, type: 'file', mode: metadata.mode & 0o777, hash: hash(await regular(file)) });
    }
  }
  await walk(''); return entries;
}
async function replaceTask(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, bytes, { flag: 'wx', mode: (await fs.stat(file)).mode & 0o777 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

// Read-only identity/ownership guard shared by the pre-dispatch execution handoff.
export async function inspectManagedApplyCandidate({ context, active, tmpdir }) {
  if (!['EXECUTE_SLICE', 'APPLY_FINDINGS'].includes(context.operation) || active.protocol !== 3
    || active.operation !== context.operation || active.slice !== context.slice
    || active.workspace !== context.workspace || active.tmpdir !== tmpdir
    || active.officialPreflight.specPath !== context.specPath
    || active.officialPreflight.authority !== context.authority
    || !Number.isSafeInteger(active.sequence) || active.sequence < 1) throw new Error('managed candidate active identity disagrees');
  const directory = path.join(tmpdir, 'stnl-runner-broker');
  const stem = String(active.sequence).padStart(3, '0');
  const binding = await read(path.join(directory, `${stem}.candidate.json`));
  const ownerFile = binding.ownerFile;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(binding.nonce ?? '')
    || ![`${stem}.candidate-owner.json`, `${stem}.candidate-owner-${binding.nonce}.json`].some(name => path.join(directory, name) === ownerFile)
    || !same(binding, await read(ownerFile))
    || ['protocol', 'operation', 'sequence', 'slice', 'workspace'].some(key => binding[key] !== active[key])
    || binding.authority !== context.authority || binding.specPath !== context.specPath) throw new Error('managed candidate binding disagrees');
  const official = await resolveExecutionWorkspace(context.specPath);
  const root = binding.candidateRoot;
  if (path.dirname(root) !== path.dirname(official.specRoot ?? official.executionRoot)
    || !path.basename(root).startsWith('.stnl-execution-copy-') || await fs.realpath(root) !== root
    || binding.candidateExecutionRoot !== (official.specRoot === null ? root : path.join(root, 'execution'))
    || binding.candidateTaskArtifact !== path.join(binding.candidateExecutionRoot, 'tasks', `${context.slice}.md`)) throw new Error('managed candidate path/source identity disagrees');
  const marker = await read(path.join(root, '.stnl-execution-copy.json'));
  const liveTask = path.join(official.executionRoot, 'tasks', `${context.slice}.md`);
  if (marker.specPath !== context.specPath || marker.slice !== context.slice || marker.executionRoot !== official.executionRoot
    || !same(binding.sourceTree, await tree(official.executionRoot))
    || binding.sourceTaskSha256 !== hash(await regular(liveTask))) throw new Error('managed candidate source changed');
  return { binding, official, liveTask };
}

export { tree as captureManagedTree, regular as readManagedRegular };

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
  const createCopy = () => context.operation === 'VALIDATE_SLICE'
    ? prepareValidationCopy({ specPath: context.specPath, slice: context.slice, candidateParent: tmpdir })
    : prepareExecutionCopy({ specPath: context.specPath, slice: context.slice });
  const preparationFile = (binding, attempt) => metadataFile(`preparation-${binding.nonce}-attempt-${attempt}`);
  const ownerFile = (binding) => binding.ownerFile ?? metadataFile('candidate-owner');
  const checkBinding = async (binding) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(binding.nonce ?? '')
      || ![metadataFile('candidate-owner'), metadataFile(`candidate-owner-${binding.nonce}`)].includes(ownerFile(binding))
      || !same(binding, await read(ownerFile(binding)))
      || Object.entries(owner).some(([key, value]) => binding[key] !== value)) throw new Error('managed candidate binding disagrees');
    await checkCopy(binding);
  };
  const checkCopy = async (copy) => {
    const candidateRoot = copy.candidateExecutionRoot;
    const root = context.operation === 'VALIDATE_SLICE' ? candidateRoot : copy.candidateRoot;
    const expectedParent = context.operation === 'VALIDATE_SLICE' ? tmpdir : path.dirname(official.specRoot ?? official.executionRoot);
    if (typeof root !== 'string' || path.dirname(root) !== expectedParent || (context.operation === 'VALIDATE_SLICE'
      ? !path.basename(root).startsWith(`validation-${context.slice}-`)
      : !path.basename(root).startsWith('.stnl-execution-copy-') || candidateRoot !== (official.specRoot === null ? root : path.join(root, 'execution')))
      || copy.candidateTaskArtifact !== path.join(candidateRoot, taskRelative)) throw new Error('managed candidate path/source identity disagrees');
  };
  if (mode === '--prepare') {
    await assertManagedSliceFreshness(environment);
    const previous = await optional(bindingFile);
    if (previous !== null) {
      await checkBinding(previous);
      const latest = await read(metadataFile('latest'));
      const rejected = await optional(preparationFile(previous, latest.receipt?.attempt));
      if (!rejected || !['REJECTED', 'PREPARING'].includes(rejected.status)) throw new Error('managed candidate already prepared; retain its canonical identity');
      await checkCopy(rejected.stage);
      if (rejected.association?.bindingSha256 !== hash(JSON.stringify(previous))
        || rejected.association.receiptFile !== latest.receipt.receiptFile) throw new Error('managed rejected preparation identity disagrees');
      if (rejected.status === 'PREPARING') {
        rejected.status = 'REJECTED'; rejected.failure = 'interrupted preparation retained';
        rejected.stageTree = await tree(rejected.stage.candidateExecutionRoot);
        await write(preparationFile(previous, latest.receipt.attempt), rejected);
      }
      if (!same(rejected.inputTree, await tree(previous.candidateExecutionRoot))
        || !same(rejected.liveBefore, await tree(official.executionRoot))
        || !same(rejected.stageTree, await tree(rejected.stage.candidateExecutionRoot))) throw new Error('managed rejected candidate changed; preserve evidence and stop');
    } else {
      // The immutable owner survives failure between allocation and binding.
      const allocated = await optional(metadataFile('candidate-owner'));
      if (allocated !== null) {
        await checkBinding(allocated);
        if (!same(allocated.sourceTree, await tree(official.executionRoot))
          || !same(allocated.sourceTree, await tree(allocated.candidateExecutionRoot))) throw new Error('managed unbound allocation changed');
        await write(bindingFile, allocated);
        return { status: 'PREPARED', candidateExecutionRoot: allocated.candidateExecutionRoot, candidateTaskArtifact: allocated.candidateTaskArtifact };
      }
    }
    const copy = await createCopy(), nonce = randomUUID();
    const binding = { ...owner, nonce, ...copy,
      ownerFile: previous === null ? metadataFile('candidate-owner') : metadataFile(`candidate-owner-${nonce}`),
      candidateTaskArtifact: path.join(copy.candidateExecutionRoot, taskRelative),
      sourceTaskSha256: hash(await regular(liveTask)), sourceTree: await tree(official.executionRoot) };
    await fs.writeFile(ownerFile(binding), JSON.stringify(binding) + '\n', { flag: 'wx', mode: 0o600 });
    await write(bindingFile, binding);
    return { status: 'PREPARED', candidateExecutionRoot: binding.candidateExecutionRoot,
      candidateTaskArtifact: binding.candidateTaskArtifact };
  }
  const binding = await read(bindingFile);
  await checkBinding(binding);
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
  const admittedRound = context.operation === 'VALIDATE_SLICE' ? null : sealed.automaticCheckRound;
  if (admittedRound !== null && (!['1/3', '2/3', '3/3'].includes(admittedRound)
    || admittedRound !== sealed.managedPayload?.automaticCheckRound || admittedRound !== receipt.automaticCheckRound)) {
    throw new Error('managed admitted round binding disagrees');
  }
  const diskReceipt = await read(receipt.receiptFile);
  if (JSON.stringify(diskReceipt) !== JSON.stringify(receipt)) throw new Error('managed receipt changed after broker settlement');
  const executionState = await inspectExecutionState(context.specPath);
  const selected = executionState.tasks.get(context.slice);
  const expectedEntries = context.operation === 'VALIDATE_SLICE'
    ? selected.currentAuxiliaryCheck?.testedState ?? selected.base.entries : receipt.testedState?.entries;
  const testedState = expectedEntries == null ? null : await captureRunnerTestedState({ workspace: context.workspace,
    taskArtifact: liveTask, changedAreas: expectedEntries.map(entry => entry.path) });
  if (testedState !== null && !same(testedState.entries, expectedEntries.map(entry => ({ path: entry.path, value: entry.value ?? entry.expected })))) throw new Error('managed receipt tested source changed');
  const prior = await optional(finalizedFile);
  if (prior?.receiptFile === receipt.receiptFile) {
    const task = prior.state === 'PRIVATE_TESTS_FAIL' ? binding.candidateTaskArtifact : liveTask;
    if (JSON.stringify(Object.keys(prior.evidenceSha256 ?? {}).sort()) !== JSON.stringify([...evidenceFiles].sort())) throw new Error('managed finalized evidence paths disagree');
    if (Object.entries(owner).some(([key, value]) => prior[key] !== value)
      || (await inspectExecutionState(context.specPath)).state !== (prior.state === 'PRIVATE_TESTS_FAIL' ? context.state : prior.state)
      || `sha256:${await computeRequirementsAuthority(context.specPath)}` !== owner.authority
      || hash(await regular(task)) !== prior.taskSha256 || hash(await regular(path.join(official.executionRoot, 'tasks.md'))) !== prior.indexSha256
      || !same(prior.liveTree, await tree(official.executionRoot))
      || !same(prior.candidateTree, await tree(binding.candidateExecutionRoot))
      || !same(prior.testedState, testedState)
      || await Promise.all(Object.entries(prior.evidenceSha256).map(async ([file, expectedHash]) =>
        hash(await regular(file)) === expectedHash)).then((matches) => matches.some((matchesHash) => !matchesHash))) throw new Error('managed finalization readback conflict');
    return prior;
  }
  const evidenceSha256 = Object.fromEntries(await Promise.all(evidenceFiles.map(async (file) => [file, hash(await regular(file))])));
  const association = { ...owner, bindingSha256: hash(JSON.stringify(binding)), receiptFile: receipt.receiptFile,
    requestId: latest.requestId, payloadSha256: latest.payloadSha256, sealedRequestSha256: hash(await regular(path.join(directory, `sealed-${latest.requestId}.json`))), evidenceSha256 };
  const preparedFile = preparationFile(binding, receipt.attempt);
  let prepared = await optional(preparedFile);
  const inputTree = await tree(binding.candidateExecutionRoot);
  const liveTree = await tree(official.executionRoot);
  if (`sha256:${await computeRequirementsAuthority(context.specPath)}` !== owner.authority) throw new Error('managed preparation authority is stale');
  if (prepared !== null) {
    if (!same(prepared.association, association)) throw new Error('managed preparation receipt/hash identity disagrees');
    if (!same(prepared.testedState, testedState)) throw new Error('managed preparation tested source changed');
    if (!same(prepared.liveBefore, binding.sourceTree)) throw new Error('managed preparation source identity disagrees');
    if (prepared.status === 'PREPARED') {
      // PREPARED owns its verified pre/post images. Recomputing from the old
      // preflight would reject a legitimate replay after installation succeeded.
      if (context.operation === 'APPLY_FINDINGS') {
        const ownership = sealed.findingsOwnership;
        if (ownership === null || typeof ownership !== 'object' || Array.isArray(ownership)
          || receipt.findingsOwnershipSha256 !== findingsOwnershipFingerprint(ownership)) throw new Error('managed prepared findings ownership seal disagrees');
        assertManagedFindingsOwnership(ownership, Object.fromEntries(Object.keys(ownership).map(key => [key, prepared.findingsCycleBinding?.[key]])));
        if (ownership.candidateTreeSha256 !== hash(JSON.stringify(prepared.inputTree))
          || ownership.candidateInputSha256 !== prepared.inputTree.find(entry => entry.path === taskRelative)?.hash
          || ownership.testedStateSha256 !== hash(JSON.stringify(testedState.entries))
          || ownership.sourceTestsSha256 !== await captureManagedSourceTestsHash(context.workspace)) throw new Error('managed prepared findings input/source hashes changed');
      }
      const expectedPrivate = receipt.semanticResponseStatus === 'TESTS_FAIL'
        && admittedRound !== '3/3';
      if (prepared.privateFailure !== expectedPrivate
        || !same(prepared.liveAfter, expectedPrivate ? prepared.liveBefore : prepared.stageTree)) throw new Error('managed preparation outcome/image disagrees');
    }
    await checkCopy(prepared.stage);
    if (!same(prepared.inputTree, inputTree) && !(prepared.privateFailure && same(prepared.stageTree, inputTree))) throw new Error('managed preparation input candidate changed');
    if (!same(prepared.liveBefore, liveTree) && !(prepared.status === 'PREPARED' && same(prepared.liveAfter, liveTree))) throw new Error('managed preparation live source changed');
    const stageExists = await fs.lstat(prepared.stage.candidateExecutionRoot).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (stageExists && !same(prepared.stageTree, await tree(prepared.stage.candidateExecutionRoot))) throw new Error('managed prepared candidate changed');
    for (const rejected of prepared.rejectedStages ?? []) {
      await checkCopy(rejected.stage);
      if (!same(rejected.tree, await tree(rejected.stage.candidateExecutionRoot))) throw new Error('managed rejected stage changed');
    }
    if (!stageExists && !(prepared.status === 'PREPARED' && !prepared.privateFailure && same(prepared.liveAfter, liveTree))) throw new Error('managed prepared candidate is missing');
    if (prepared.status !== 'PREPARED' && !(prepared.status === 'REJECTED' && prepared.failureCode === 'EIO'
      && !prepared.failure.includes('preserved'))) throw new Error('managed preparation rejected; retain candidate and use --prepare for a fresh proposal');
  }
  if (prepared?.status !== 'PREPARED') {
  if (context.operation === 'APPLY_FINDINGS') {
    assertManagedFindingsOwnership(await prepareManagedFindingsRequest({ request: sealed, environment }), sealed.findingsOwnership);
  }
    await assertManagedSliceFreshness(environment);
    await assertManagedRunnerReceipt({ operation: owner.operation, slice: owner.slice, workspace: owner.workspace,
      receiptFile: receipt.receiptFile, semanticResponseFile: receipt.semanticResponseFile, allowRejected: true, environment });
    if (!same(binding.sourceTree, liveTree) || binding.sourceTaskSha256 !== hash(await regular(liveTask))) throw new Error('managed candidate path/source identity disagrees');
    const stage = { ...await createCopy() };
    stage.candidateTaskArtifact = path.join(stage.candidateExecutionRoot, taskRelative);
    await checkCopy(stage);
    await fs.cp(binding.candidateExecutionRoot, stage.candidateExecutionRoot, { recursive: true });
    if (!same(inputTree, await tree(stage.candidateExecutionRoot)) || !same(inputTree, await tree(binding.candidateExecutionRoot))) throw new Error('managed candidate changed while staging');
    const rejectedStages = [...(prepared?.rejectedStages ?? []), ...(prepared ? [{ stage: prepared.stage, tree: prepared.stageTree, reason: prepared.failure }] : [])];
    prepared = { association, testedState, status: 'PREPARING', stage, inputTree, liveBefore: liveTree,
      stageTree: inputTree, rejectedStages };
    await write(preparedFile, prepared);
    try {
      let privateFailure = false;
      let prospective = null;
      if (context.operation === 'VALIDATE_SLICE') {
        await prepareValidationCandidate({ specPath: context.specPath, slice: context.slice, workspace: context.workspace,
          candidateExecutionRoot: stage.candidateExecutionRoot, semanticResponseFile: receipt.semanticResponseFile, receiptFile: receipt.receiptFile });
      } else {
        try {
          const response = (await regular(receipt.semanticResponseFile)).toString('utf8');
          let findingsCycleBinding = null;
          const bundle = await serializeRunnerExecutionBundleFromResponse({ operation: context.operation,
            response, workspace: context.workspace, taskArtifact: stage.candidateTaskArtifact,
            receiptFile: receipt.receiptFile, semanticResponseFile: receipt.semanticResponseFile, automaticCheckRound: admittedRound,
            resolveManagedFindingsCycle: context.operation !== 'APPLY_FINDINGS' ? undefined : async payload => {
              if (prior?.state === 'PRIVATE_TESTS_FAIL') {
                for (const [file, expectedHash] of Object.entries(prior.evidenceSha256)) {
                  if (hash(await regular(file)) !== expectedHash) throw new Error('managed prior findings captured evidence changed');
                }
              }
              findingsCycleBinding = bindManagedFindingsCycle({ context, binding, selected, sealed, receipt,
                response: payload, fingerprint: executionState.currentFingerprint, prior,
                candidateText: (await regular(binding.candidateTaskArtifact)).toString('utf8'),
                liveText: (await regular(liveTask)).toString('utf8') });
              prepared = { ...prepared, findingsCycleBinding };
              await write(preparedFile, prepared);
              return findingsCycleBinding.canonicalCycle;
            } });
          await insertExecutionEvidenceInCandidate({ taskArtifact: stage.candidateTaskArtifact, operation: context.operation, bundle,
            validateProspectiveTask: async task => {
              prospective = await validateExecutionCandidate(context.specPath, stage.candidateExecutionRoot, [task], {
                privateAutomaticCheck: receipt.semanticResponseStatus === 'TESTS_FAIL' && admittedRound !== '3/3'
                  ? { operation: context.operation, slice: context.slice, round: Number(admittedRound.slice(0, 1)) } : null,
              });
              await assertManagedSliceFreshness(environment);
              const current = await captureRunnerTestedState({ workspace: context.workspace, taskArtifact: liveTask,
                changedAreas: testedState.entries.map(entry => entry.path) });
              if (!same(current, testedState)) throw new Error('managed prospective execution tested source changed');
              if (findingsCycleBinding !== null) findingsCycleBinding.findingsEvidenceSha256 = findingsEvidenceFingerprint(task.text);
            } });
          const parsed = JSON.parse(response);
          privateFailure = parsed.status === 'TESTS_FAIL' && admittedRound !== '3/3';
        } catch (error) {
          const diagnostic = recoverableRunnerResultDiagnostic(error);
          if (diagnostic === null) throw error;
          await persistMalformedRunnerResultInCandidate({ taskArtifact: stage.candidateTaskArtifact,
            operation: context.operation, workspace: context.workspace, receiptFile: receipt.receiptFile,
            semanticResponseFile: receipt.semanticResponseFile, diagnostic, error });
        }
      }
      // Execution records passed prospective validation before their append.
      // Intermediate failures stay private; publication retries reuse the receipt.
      const validated = privateFailure ? null : prospective ?? await validateExecutionCandidate(context.specPath, stage.candidateExecutionRoot);
      prepared = { ...prepared, status: 'PREPARED', privateFailure, state: privateFailure ? 'PRIVATE_TESTS_FAIL' : validated.state,
        stageTree: await tree(stage.candidateExecutionRoot) };
      prepared.liveAfter = privateFailure ? liveTree : prepared.stageTree;
      await write(preparedFile, prepared);
    } catch (error) {
      await write(preparedFile, { ...prepared, status: 'REJECTED', stageTree: await tree(stage.candidateExecutionRoot),
        failure: error.message, failureCode: error.code ?? null });
      throw error;
    }
  }
  const privateFailure = prepared.privateFailure;
  if (privateFailure) {
    await assertManagedSliceFreshness(environment);
    const currentInput = await tree(binding.candidateExecutionRoot);
    if (!same(prepared.stageTree, currentInput)) {
      if (!same(prepared.inputTree, currentInput)) throw new Error('managed private candidate changed');
      await replaceTask(binding.candidateTaskArtifact, await regular(prepared.stage.candidateTaskArtifact));
    }
  } else if (!same(prepared.liveAfter, await tree(official.executionRoot))) {
    await assertManagedSliceFreshness(environment);
    if (!same(prepared.liveBefore, await tree(official.executionRoot))
      || !same(prepared.inputTree, await tree(binding.candidateExecutionRoot))) throw new Error('managed publication source conflict');
    if (context.operation === 'VALIDATE_SLICE') await publishValidationCandidate({ specPath: context.specPath, slice: context.slice, candidateExecutionRoot: prepared.stage.candidateExecutionRoot });
    else await publishExecutionCopy({ specPath: context.specPath, slice: context.slice, candidateRoot: prepared.stage.candidateRoot });
  }
  const readback = await inspectExecutionState(context.specPath);
  if ((!privateFailure && readback.state !== prepared.state) || !same(prepared.liveAfter, await tree(official.executionRoot))) throw new Error('managed publication/readback conflict');
  if (!same(privateFailure ? prepared.stageTree : prepared.inputTree, await tree(binding.candidateExecutionRoot))
    || `sha256:${await computeRequirementsAuthority(context.specPath)}` !== owner.authority
    || (testedState !== null && !same(testedState, await captureRunnerTestedState({ workspace: context.workspace,
      taskArtifact: liveTask, changedAreas: testedState.entries.map(entry => entry.path) })))
    || !same(evidenceSha256, Object.fromEntries(await Promise.all(evidenceFiles.map(async (file) => [file, hash(await regular(file))]))))) throw new Error('managed finalization input/evidence conflict');
  const result = { ...owner, receiptFile: receipt.receiptFile, state: privateFailure ? 'PRIVATE_TESTS_FAIL' : readback.state,
    evidenceSha256,
    ...(prepared.findingsCycleBinding === undefined ? {} : { findingsCycleBinding: prepared.findingsCycleBinding }),
    liveTree: await tree(official.executionRoot), candidateTree: await tree(binding.candidateExecutionRoot),
    testedState,
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
