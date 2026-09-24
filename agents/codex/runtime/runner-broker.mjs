import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const BROKER_DIRECTORY = 'stnl-runner-broker';
const BROKER_OPERATIONS = new Set(['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']);
const BROKER_RECEIPTS = new Set([
  'RUNNER_RESPONSE_CAPTURED', 'RUNNER_RESULT_BLOCKED', 'RUNNER_INITIALIZATION_BLOCKED',
]);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const POLL_INTERVAL_MS = 25;

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validIdentity({ operation, sequence, slice, workspace, tmpdir }) {
  return BROKER_OPERATIONS.has(operation)
    && Number.isSafeInteger(sequence) && sequence > 0
    && typeof slice === 'string' && /^slice-[0-9]{2,}$/u.test(slice)
    && typeof workspace === 'string' && path.isAbsolute(workspace) && path.resolve(workspace) === workspace
    && typeof tmpdir === 'string' && path.isAbsolute(tmpdir) && path.resolve(tmpdir) === tmpdir;
}

function validOfficialPreflight(preflight, identity) {
  return isRecord(preflight)
    && preflight.exitCode === 0
    && preflight.operation === identity.operation
    && preflight.slice === identity.slice
    && typeof preflight.inputSlice === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(preflight.inputSlice)
    && typeof preflight.specPath === 'string' && path.isAbsolute(preflight.specPath)
    && path.resolve(preflight.specPath) === preflight.specPath
    && typeof preflight.state === 'string' && preflight.state !== ''
    && typeof preflight.authority === 'string' && /^sha256:[a-f0-9]{64}$/u.test(preflight.authority)
    && Array.isArray(preflight.legalOperations)
    && preflight.legalOperations.some((target) => target?.operation === identity.operation && target?.slice === identity.slice)
    && (preflight.mandatoryRecovery === null
      || (isRecord(preflight.mandatoryRecovery)
        && preflight.mandatoryRecovery.operation === identity.operation
        && preflight.mandatoryRecovery.slice === identity.slice
        && preflight.mandatoryRecovery.sameOperationResumeRequired === true));
}

async function assertCanonicalDirectory(directory, label) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) {
    fail(`${label}_NOT_CANONICAL`);
  }
  const metadata = await fs.lstat(directory).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label}_UNSAFE`);
  if (await fs.realpath(directory) !== directory) fail(`${label}_NOT_CANONICAL`);
}

async function assertCanonicalWorkspaceEntry(entry, workspace, label) {
  if (typeof entry !== 'string' || !path.isAbsolute(entry) || path.resolve(entry) !== entry) {
    fail(`${label}_NOT_CANONICAL`);
  }
  const metadata = await fs.lstat(entry).catch(() => null);
  if (metadata === null || (!metadata.isFile() && !metadata.isDirectory()) || metadata.isSymbolicLink()) {
    fail(`${label}_UNSAFE`);
  }
  if (await fs.realpath(entry) !== entry) fail(`${label}_NOT_CANONICAL`);
  const relative = path.relative(workspace, entry);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label}_OUTSIDE_WORKSPACE`);
  }
}

async function readJsonFile(file) {
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) fail('BROKER_FILE_UNSAFE');
  if (await fs.realpath(file) !== file) fail('BROKER_FILE_NOT_CANONICAL');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    fail('BROKER_JSON_INVALID');
  }
}

async function writeAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}

function matchesIdentity(value, identity) {
  return isRecord(value)
    && value.operation === identity.operation
    && value.sequence === identity.sequence
    && value.slice === identity.slice
    && value.workspace === identity.workspace
    && value.tmpdir === identity.tmpdir;
}

export async function startOfficialRunnerBroker({
  workspace,
  tmpdir,
  operation,
  sequence,
  slice,
  officialPreflight,
  invoke,
  pollIntervalMs = POLL_INTERVAL_MS,
}) {
  const identity = { workspace, tmpdir, operation, sequence, slice };
  if (!validIdentity(identity) || !validOfficialPreflight(officialPreflight, identity) || typeof invoke !== 'function'
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) {
    fail('BROKER_CONFIGURATION_INVALID');
  }
  await Promise.all([
    assertCanonicalDirectory(workspace, 'BROKER_WORKSPACE'),
    assertCanonicalDirectory(tmpdir, 'BROKER_TMPDIR'),
    assertCanonicalWorkspaceEntry(officialPreflight.specPath, workspace, 'BROKER_SPEC_PATH'),
  ]);

  const directory = path.join(tmpdir, BROKER_DIRECTORY);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryMetadata = await fs.lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || await fs.realpath(directory) !== directory) {
    fail('BROKER_DIRECTORY_UNSAFE');
  }
  const activeFile = path.join(directory, 'active.json');
  try {
    await fs.writeFile(activeFile, `${JSON.stringify({ ...identity, officialPreflight })}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    fail('BROKER_ALREADY_ACTIVE');
  }

  let stopping = false;
  const seen = new Set();
  const errors = [];
  const run = async () => {
    while (!stopping) {
      const names = (await fs.readdir(directory)).filter((name) => /^request-[0-9a-f-]{36}\.json$/u.test(name)).sort();
      for (const name of names) {
        if (stopping) break;
        if (seen.has(name)) continue;
        seen.add(name);
        const requestFile = path.join(directory, name);
        const requestId = name.slice('request-'.length, -'.json'.length);
        let result;
        try {
          if (!REQUEST_ID.test(requestId)) fail('BROKER_REQUEST_ID_INVALID');
          const request = await readJsonFile(requestFile);
          const keys = isRecord(request) ? Object.keys(request).sort() : [];
          if (keys.join(',') !== 'operation,prompt,requestId,sequence,slice,tmpdir,workspace'
            || request.requestId !== requestId || !matchesIdentity(request, identity)
            || typeof request.prompt !== 'string' || request.prompt.trim() === '' || Buffer.byteLength(request.prompt) > 256 * 1024) {
            fail('BROKER_REQUEST_REJECTED');
          }
          result = await invoke({
            ...identity,
            specPath: officialPreflight.specPath,
            officialPreflight,
            prompt: request.prompt,
          });
          if (!isRecord(result)
            || result.sequence !== sequence || result.operation !== operation
            || result.slice !== slice || !BROKER_RECEIPTS.has(result.status)
            || !Number.isInteger(result.exitCode) || ![0, 1].includes(result.exitCode)) {
            fail('BROKER_RESULT_INVALID');
          }
          const { exitCode, ...receipt } = result;
          result = { receipt, exitCode };
        } catch (error) {
          errors.push(typeof error?.code === 'string' ? error.code : 'BROKER_DISPATCH_FAILED');
          result = { errorCode: typeof error?.code === 'string' ? error.code : 'BROKER_DISPATCH_FAILED', exitCode: 1 };
        }
        await writeAtomic(path.join(directory, `response-${requestId}.json`), { requestId, result });
      }
      if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };
  const loop = run();

  return {
    directory,
    errors,
    get requestsHandled() { return seen.size; },
    async close() {
      stopping = true;
      await fs.unlink(activeFile).catch(() => {});
      await loop;
    },
  };
}

export async function submitOfficialRunnerRequest({
  workspace,
  tmpdir,
  operation,
  sequence,
  slice,
  prompt,
  timeoutMs = 1_800_000,
  pollIntervalMs = POLL_INTERVAL_MS,
}) {
  const identity = { workspace, tmpdir, operation, sequence, slice };
  if (!validIdentity(identity) || typeof prompt !== 'string' || prompt.trim() === ''
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) {
    fail('BROKER_REQUEST_INVALID');
  }
  await Promise.all([
    assertCanonicalDirectory(workspace, 'BROKER_WORKSPACE'),
    assertCanonicalDirectory(tmpdir, 'BROKER_TMPDIR'),
  ]);

  const directory = path.join(tmpdir, BROKER_DIRECTORY);
  const active = await readJsonFile(path.join(directory, 'active.json'));
  if (!matchesIdentity(active, identity)) fail('BROKER_TARGET_MISMATCH');

  const requestId = randomUUID();
  const requestFile = path.join(directory, `request-${requestId}.json`);
  const responseFile = path.join(directory, `response-${requestId}.json`);
  await writeAtomic(requestFile, { ...identity, requestId, prompt });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const metadata = await fs.lstat(responseFile).catch(() => null);
      if (metadata !== null) {
        const response = await readJsonFile(responseFile);
        if (!isRecord(response) || response.requestId !== requestId || !isRecord(response.result)) {
          fail('BROKER_RESPONSE_INVALID');
        }
        if (response.result.errorCode !== undefined) fail(response.result.errorCode);
        const { receipt, exitCode } = response.result;
        if (!isRecord(receipt) || receipt.operation !== operation || receipt.sequence !== sequence
          || receipt.slice !== slice || !BROKER_RECEIPTS.has(receipt.status)
          || !Number.isInteger(exitCode) || ![0, 1].includes(exitCode)) {
          fail('BROKER_RESPONSE_INVALID');
        }
        return { ...receipt, exitCode };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    fail('BROKER_RESPONSE_TIMEOUT');
  } finally {
    await Promise.all([
      fs.unlink(requestFile).catch(() => {}),
      fs.unlink(responseFile).catch(() => {}),
    ]);
  }
}
