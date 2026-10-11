#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertExecutionAttempt, assertOwnedOperationalCandidate, bindExecutionBroker, readOwnedFile, withExecutionPublicationLock, executionLockIdentity, parseStrictJson, registerRunnerAllocation, persistAllocation } from './execution-publication.mjs';
import { preflightExecutionOperation, readExecutionActivation, resolveExecutionWorkspace, validateExecutionCandidate } from './execution-state.mjs';

const nativeJson = async file => parseStrictJson((await readOwnedFile(file)).bytes.toString('utf8'));
const nativeHash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const nativeWrite = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

async function nativeOrigin(originFile) {
  const origin = await nativeJson(originFile);
  const root = path.dirname(originFile);
  const dispatch = await nativeJson(path.join(root, 'owner.json'));
  if (origin.transport !== 'native' || JSON.stringify(origin.owner) !== JSON.stringify(dispatch.owner)
    || origin.specPath !== dispatch.specPath || origin.dispatchId !== dispatch.dispatchId
    || originFile !== path.join(root, `round-${origin.attempt}.origin.json`)) fail('native runner origin differs');
  const activation = (await readExecutionActivation(origin.specPath)).activation;
  const owner = assertExecutionAttempt(activation, origin.owner);
  if (owner.runner?.dispatchId !== dispatch.dispatchId
    || owner.runner.receiptFile !== path.join(root, 'owner.json')) fail('native runner dispatch belongs to another owner');
  return { origin, root, workspace: await resolveExecutionWorkspace(origin.specPath) };
}

// Reserve before the native spawn call. Pending/uncertain dispatches cannot be
// adopted or retried; only a concluded TESTS_FAIL allows the next bounded round.
export async function startNativeRunnerCapture({ specPath, owner, workspace, captureParent, candidateTaskArtifact = null }) {
  const official = await resolveExecutionWorkspace(specPath);
  await preflightExecutionOperation(specPath, owner.operation, BigInt(owner.slice.slice(6)).toString(), { owner });
  const current = assertExecutionAttempt((await readExecutionActivation(specPath)).activation, owner);
  if (current.runner !== null) {
    const root = path.dirname(current.runner.receiptFile);
    return withExecutionPublicationLock(official, async () => {
      await nativeOrigin(path.join(root, 'round-1.origin.json'));
      const origins = (await fs.readdir(root)).filter(name => /^round-[1-3]\.origin\.json$/u.test(name));
      const previous = await nativeJson(path.join(root, `round-${origins.length}.receipt.json`));
      await verifyNativeRunnerReceipt({ receiptFile: previous.receiptFile, semanticResponseFile: previous.semanticResponseFile,
        operation: owner.operation, slice: owner.slice, workspace });
      if (owner.operation === 'VALIDATE_SLICE' || previous.semanticResponseStatus !== 'TESTS_FAIL' || origins.length >= 3) fail('native runner cannot dispatch another round');
      if (!candidateTaskArtifact || path.basename(candidateTaskArtifact) !== `${owner.slice}.md`) fail('native next round requires its finalized private check');
      const candidateRoot = path.dirname(path.dirname(candidateTaskArtifact));
      await assertOwnedOperationalCandidate({ candidateExecutionRoot: candidateRoot, slice: owner.slice,
        resolveWorkspace: resolveExecutionWorkspace, readActivated: readExecutionActivation });
      const text = (await readOwnedFile(candidateTaskArtifact)).bytes.toString('utf8');
      const heading = owner.operation === 'EXECUTE_SLICE' ? 'Implementation Test Evidence' : 'Findings Test Evidence';
      const section = text.split(`## ${heading}\n\n`)[1]?.split('\n## ')[0];
      const check = section?.split(/(?=^### (?:implementation|findings)-check-[0-9]+$)/mu).at(-1);
      if (!check?.includes(`- Automatic check round: ${previous.attempt}/3\n`) || !check.includes('- Status: TESTS_FAIL\n')
        || !check.includes(`- Operation attempt ID: ${owner.operationAttemptId}\n`)
        || !check.includes(`- Origin activation ID: ${owner.originActivationId}\n`)) fail('native next round lacks the same finalized failed check');
      await validateExecutionCandidate(specPath, candidateRoot, [{ slice: owner.slice, text }], { privateAutomaticCheck: { operation: owner.operation, slice: owner.slice, round: previous.attempt } });
      const origin = { ...await nativeJson(path.join(root, 'round-1.origin.json')), attempt: origins.length + 1 };
      const originFile = path.join(root, `round-${origin.attempt}.origin.json`);
      await nativeWrite(originFile, origin);
      return { originFile, owner, attempt: origin.attempt };
    });
  }
  const parent = await fs.realpath(captureParent);
  if (!(await fs.lstat(captureParent)).isDirectory() || (await fs.lstat(captureParent)).isSymbolicLink()) fail('native capture parent must be a real directory');
  const within = (a, b) => a === b || a.startsWith(b + path.sep);
  if (within(parent, official.executionRoot) || (official.specRoot && within(parent, official.specRoot))) fail('native capture must be outside SPEC/execution');
  const root = await fs.mkdtemp(path.join(parent, '.stnl-native-runner-'));
  await registerRunnerAllocation({workspace:official,owner,root,producer:'native-runner'});
  const origin = { transport: 'native', specPath: await fs.realpath(specPath), workspace: await fs.realpath(workspace),
    owner, dispatchId: crypto.randomUUID(), attempt: 1 };
  await nativeWrite(path.join(root, 'owner.json'), origin);
  const originFile = path.join(root, 'round-1.origin.json');
  await nativeWrite(originFile, origin);
  await bindExecutionBroker({ workspace: official, owner, runner: { dispatchId: origin.dispatchId,
    receiptFile: path.join(root, 'owner.json'), threadId: null, status: 'pending' }, readActivated: () => readExecutionActivation(specPath) });
  return { originFile, owner, attempt: 1 };
}

// agentId must come from the actual native spawn result, before waiting for its
// final response. This is invocation provenance, not a claim of independence.
export async function bindNativeRunnerIdentity({ originFile, agentId }) {
  const { origin, root, workspace } = await nativeOrigin(originFile);
  if (typeof agentId !== 'string' || !agentId.trim()) fail('native spawn result must identify the agent');
  return withExecutionPublicationLock(workspace, async () => {
    await nativeOrigin(originFile);
    const file = path.join(root, `round-${origin.attempt}.agent.json`);
    const { lockPath } = await executionLockIdentity(workspace);
    // Native identities are single-use for this official root, including after
    // terminal ownership closes. Never adopt a previously concluded agent.
    const claimFile = `${lockPath}.native-agent-${nativeHash(agentId)}.json`;
    await nativeWrite(claimFile, { agentId, originFile, owner: origin.owner });
    const marker=`${root}.publication.json`;const allocation=await nativeJson(marker);
    await persistAllocation(marker,{...allocation,controlFiles:[...(allocation.controlFiles ?? []),claimFile]});
    await nativeWrite(file, { agentId, originFile });
    return { originFile, agentId };
  });
}

// Consume the concluded result of the previously bound native agent. There is
// deliberately no API that stamps an arbitrary raw response file with an owner.
export async function captureNativeRunnerResult({ originFile, result, changedAreas = null }) {
  const { origin, root, workspace } = await nativeOrigin(originFile);
  let testedState = null;
  if (origin.owner.operation !== 'VALIDATE_SLICE' && !await fs.lstat(path.join(root, `round-${origin.attempt}.receipt.json`)).catch(error => { if (error.code === 'ENOENT') return null; throw error; })) {
    const { captureRunnerTestedState } = await import('./serialize-runner-evidence.mjs');
    testedState = await captureRunnerTestedState({ workspace: origin.workspace, taskArtifact: path.join(workspace.executionRoot, 'tasks', `${origin.owner.slice}.md`), changedAreas });
  }
  return withExecutionPublicationLock(workspace, async () => {
    await nativeOrigin(originFile);
    const agent = await nativeJson(path.join(root, `round-${origin.attempt}.agent.json`));
    if (result?.agentId !== agent.agentId || result.status !== 'completed'
      || typeof result.finalResponse !== 'string') fail('native result is not from the bound concluded agent');
    const receiptFile = path.join(root, `round-${origin.attempt}.receipt.json`);
    const semanticResponseFile = path.join(root, `round-${origin.attempt}.response.json`);
    const existing = await fs.lstat(receiptFile).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing) {
      const previous = await nativeJson(path.join(root, `round-${origin.attempt}.tool-result.json`));
      if (JSON.stringify(previous) !== JSON.stringify(result)) fail('native result changed after capture');
      await verifyNativeRunnerReceipt({ receiptFile, semanticResponseFile, operation: origin.owner.operation,
        slice: origin.owner.slice, workspace: origin.workspace });
      return { receiptFile, semanticResponseFile };
    }
    const payload = JSON.parse(result.finalResponse);
    await nativeWrite(path.join(root, `round-${origin.attempt}.tool-result.json`), result);
    await fs.writeFile(semanticResponseFile, result.finalResponse, { flag: 'wx', mode: 0o600 });
    const receipt = { transport: 'native', originFile, owner: origin.owner, operation: origin.owner.operation,
      slice: origin.owner.slice, workspace: origin.workspace, attempt: origin.attempt, threadId: agent.agentId,
      receiptFile, semanticResponseFile, semanticResponseSha256: nativeHash(result.finalResponse),
      semanticResponseStatus: payload.status, status: 'RUNNER_RESPONSE_CAPTURED', captureFailure: null, error: null, testedState };
    await nativeWrite(receiptFile, receipt);
    return { receiptFile, semanticResponseFile };
  });
}

export async function verifyNativeRunnerReceipt({ receiptFile, semanticResponseFile, operation, slice, workspace }) {
  if (!receiptFile || !semanticResponseFile) fail('native runner requires origin-bound receipt and response');
  const receipt = await nativeJson(receiptFile);
  const { origin, root, workspace: official } = await nativeOrigin(receipt.originFile);
  const agent = await nativeJson(path.join(root, `round-${origin.attempt}.agent.json`));
  const { lockPath } = await executionLockIdentity(official);
  const claim = await nativeJson(`${lockPath}.native-agent-${nativeHash(agent.agentId)}.json`);
  const result = await nativeJson(path.join(root, `round-${origin.attempt}.tool-result.json`));
  const bytes = (await readOwnedFile(semanticResponseFile)).bytes;
  const canonicalSlice = `slice-${BigInt(String(slice).replace(/^slice-/u, '')).toString().padStart(2, '0')}`;
  if (receipt.transport !== 'native' || receipt.operation !== operation || receipt.slice !== canonicalSlice
    || origin.owner.operation !== operation || origin.owner.slice !== canonicalSlice
    || origin.workspace !== await fs.realpath(workspace) || receipt.workspace !== origin.workspace
    || JSON.stringify(receipt.owner) !== JSON.stringify(origin.owner) || receipt.attempt !== origin.attempt
    || receiptFile !== path.join(root, `round-${origin.attempt}.receipt.json`)
    || semanticResponseFile !== path.join(root, `round-${origin.attempt}.response.json`)
    || receipt.receiptFile !== receiptFile || receipt.semanticResponseFile !== semanticResponseFile
    || result.agentId !== agent.agentId || result.status !== 'completed' || receipt.threadId !== agent.agentId
    || agent.originFile !== receipt.originFile || claim.originFile !== receipt.originFile || claim.agentId !== agent.agentId
    || JSON.stringify(claim.owner) !== JSON.stringify(origin.owner)
    || result.finalResponse !== bytes.toString('utf8') || receipt.semanticResponseSha256 !== nativeHash(bytes)
    || receipt.semanticResponseStatus !== JSON.parse(bytes.toString('utf8')).status
    || receipt.status !== 'RUNNER_RESPONSE_CAPTURED' || receipt.error !== null) fail('native receipt/result/origin binding differs');
  return receipt;
}

function fail(message) {
  throw new Error(message);
}

async function requireRegularFile(file, label) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail(`${label} must be absolute`);
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be an existing regular file`);
  }
  return path.resolve(file);
}

async function requireAbsentOutput(file) {
  if (typeof file !== "string" || !path.isAbsolute(file)) fail("output file must be absolute");
  const resolved = path.resolve(file);
  if (await fs.lstat(resolved).catch(() => null) !== null) fail("output file already exists");
  const parent = path.dirname(resolved);
  const metadata = await fs.lstat(parent).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail("output parent must be an existing non-symlink directory");
  }
  const canonicalParent = await fs.realpath(parent);
  if (canonicalParent !== parent) fail("output parent must be canonical");
  return resolved;
}

function parseStructuredOutput(text) {
  const messages = [];
  const lines = text.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length === 0) fail("structured runner output is empty");
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail(`structured runner output line ${index + 1} is invalid JSON`);
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)
      || typeof event.type !== "string") {
      fail(`structured runner output line ${index + 1} is not a typed event`);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message"
      && typeof event.item.text === "string") {
      messages.push(event.item.text);
    }
  }
  const response = messages.at(-1);
  if (response === undefined) fail("structured runner output has no final agent message");
  let semantic;
  try {
    semantic = JSON.parse(response);
  } catch {
    throw Object.assign(new Error("final runner message is not valid JSON"), { code: "RUNNER_RESPONSE_SCHEMA_INVALID" });
  }
  if (semantic === null || typeof semantic !== "object" || Array.isArray(semantic)) {
    throw Object.assign(new Error("final runner message must be one JSON object, not a JSON string or array"),
      { code: "RUNNER_RESPONSE_SCHEMA_INVALID" });
  }
  return response;
}

export async function captureRunnerResponse({ structuredOutputFile, outputFile, validateResponse = null }) {
  const source = await requireRegularFile(structuredOutputFile, "structured output file");
  const destination = await requireAbsentOutput(outputFile);
  const response = parseStructuredOutput(await fs.readFile(source, "utf8"));
  if (validateResponse !== null) {
    try { validateResponse(response); }
    catch (cause) {
      throw Object.assign(new Error(`runner response schema is invalid: ${cause.message}`, { cause }),
        { code: "RUNNER_RESPONSE_SCHEMA_INVALID" });
    }
  }
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, response, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { status: "PASS", outputFile: destination };
}

function parseArgs(argv) {
  if (argv.length !== 4) fail("usage: capture-runner-response.mjs --structured-output-file <absolute> --output <absolute>");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--structured-output-file", "--output"]).has(name)
      || value === undefined || value.startsWith("--") || Object.hasOwn(values, name)) {
      fail("invalid capture-runner-response arguments");
    }
    values[name] = value;
  }
  return {
    structuredOutputFile: values["--structured-output-file"],
    outputFile: values["--output"],
  };
}

export async function main(argv) {
  if (['start-native', 'bind-native', 'capture-native'].includes(argv[0])) {
    const mode = argv[0], values = {};
    const keys = mode === 'start-native' ? ['--spec-path', '--owner-file', '--workspace', '--capture-parent', '--candidate-task-artifact']
      : mode === 'bind-native' ? ['--origin-file', '--agent-id'] : ['--origin-file', '--tool-result-file', '--changed-areas-file'];
    for (let index = 1; index < argv.length; index += 2) {
      const key = argv[index];
      if (!keys.includes(key) || Object.hasOwn(values, key) || !argv[index + 1]) fail('invalid native capture arguments');
      values[key] = argv[index + 1];
    }
    let result;
    if (mode === 'start-native') {
      const record = await nativeJson(values['--owner-file']);
      if (record.specPath !== await fs.realpath(values['--spec-path'])) fail('native owner file belongs to another requirements source');
      result = await startNativeRunnerCapture({ specPath: record.specPath, owner: record.owner, workspace: values['--workspace'], captureParent: values['--capture-parent'], candidateTaskArtifact: values['--candidate-task-artifact'] });
    } else if (mode === 'bind-native') {
      result = await bindNativeRunnerIdentity({ originFile: values['--origin-file'], agentId: values['--agent-id'] });
    } else {
      result = await captureNativeRunnerResult({ originFile: values['--origin-file'], result: await nativeJson(values['--tool-result-file']),
        changedAreas: values['--changed-areas-file'] ? await nativeJson(values['--changed-areas-file']) : null });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`); return 0;
  }
  const result = await captureRunnerResponse(parseArgs(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
