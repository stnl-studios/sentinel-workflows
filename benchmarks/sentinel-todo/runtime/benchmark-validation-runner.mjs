#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { captureRunnerResponse } from '../../../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { submitOfficialRunnerRequest } from './benchmark-runner-broker.mjs';
import {
  modelLabelForProviderId,
  runHarness,
} from './benchmark-agent-harness.mjs';
import {
  canonicalSliceInput,
  LONG_MODEL_OPERATION_TIMEOUT_MS,
  SEMANTIC_RESPONSE_SCHEMA_PATH_BY_OPERATION,
} from './benchmark-runner-contract.mjs';

const RUNNER_AGENT = 'stnl_validation_runner';
const RUNNER_CONFIG_RELATIVE = path.join('.codex', 'agents', `${RUNNER_AGENT}.toml`);
const SUPPORTED_OPERATIONS = new Set(['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']);

function fail(message) {
  throw new Error(message);
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be absolute`);
  const metadata = await fs.lstat(value).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) fail(`${label} must be a non-symlink directory`);
  const canonical = await fs.realpath(value);
  if (canonical !== path.resolve(value)) fail(`${label} must already be canonical`);
  return canonical;
}

async function canonicalWorkspaceEntry(value, workspace, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
    fail(`${label} must be absolute and canonical`);
  }
  const metadata = await fs.lstat(value).catch(() => null);
  if (metadata === null || (!metadata.isFile() && !metadata.isDirectory()) || metadata.isSymbolicLink()) {
    fail(`${label} must be an existing non-symlink file or directory`);
  }
  if (await fs.realpath(value) !== value || !inside(value, workspace)) {
    fail(`${label} must be canonical and inside the managed workspace`);
  }
  return value;
}

function validateOfficialPreflight({ operation, slice, specPath, officialPreflight }) {
  const legalTarget = isPlainRecord(officialPreflight)
    && Array.isArray(officialPreflight.legalOperations)
    && officialPreflight.legalOperations.some((target) => target?.operation === operation && target?.slice === slice);
  const recovery = officialPreflight?.mandatoryRecovery;
  const validRecovery = recovery === null
    || (isPlainRecord(recovery) && recovery.operation === operation && recovery.slice === slice
      && recovery.sameOperationResumeRequired === true);
  if (!isPlainRecord(officialPreflight)
    || officialPreflight.exitCode !== 0
    || officialPreflight.operation !== operation
    || officialPreflight.slice !== slice
    || officialPreflight.inputSlice !== canonicalSliceInput(slice)
    || officialPreflight.specPath !== specPath
    || !/^sha256:[a-f0-9]{64}$/u.test(officialPreflight.authority ?? '')
    || typeof officialPreflight.state !== 'string' || officialPreflight.state === ''
    || !legalTarget || !validRecovery) {
    fail('RUNNER_PREFLIGHT_INVALID');
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readRunnerConfiguration(workspace) {
  const file = path.join(workspace, RUNNER_CONFIG_RELATIVE);
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    fail('configured validation-runner file is missing or unsafe');
  }
  if (await fs.realpath(file) !== file) fail('configured validation-runner file must be canonical');

  const properties = new Map();
  const developerLines = [];
  let readingDeveloperInstructions = false;
  let developerInstructionsClosed = false;
  for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/u)) {
    if (readingDeveloperInstructions) {
      if (line === '"""') {
        readingDeveloperInstructions = false;
        developerInstructionsClosed = true;
      } else {
        developerLines.push(line);
      }
      continue;
    }
    if (line === 'developer_instructions = """') {
      if (developerInstructionsClosed || developerLines.length !== 0) fail('runner developer instructions are duplicated');
      readingDeveloperInstructions = true;
      continue;
    }
    const assignment = /^(name|model|model_reasoning_effort|sandbox_mode)\s*=\s*"([^"]*)"$/u.exec(line);
    if (assignment !== null) {
      if (properties.has(assignment[1])) fail(`runner configuration duplicates ${assignment[1]}`);
      properties.set(assignment[1], assignment[2]);
    }
  }
  if (readingDeveloperInstructions || !developerInstructionsClosed || developerLines.join('\n').trim() === '') {
    fail('runner developer instructions are missing or unterminated');
  }
  for (const name of ['name', 'model', 'model_reasoning_effort', 'sandbox_mode']) {
    if (!properties.has(name)) fail(`runner configuration is missing ${name}`);
  }
  if (properties.get('name') !== RUNNER_AGENT) fail('runner configuration identity does not match the registered agent');

  return {
    model: modelLabelForProviderId(properties.get('model')),
    effort: properties.get('model_reasoning_effort'),
    sandbox: properties.get('sandbox_mode'),
    developerInstructions: developerLines.join('\n').trim(),
  };
}

async function reserveInvocation({ tmpdir, sequence, operation, slice }) {
  const identity = `stnl-runner-${String(sequence).padStart(3, '0')}-${operation.toLowerCase()}-${slice}`;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const suffix = `attempt-${attempt}`;
    const invocationFile = path.join(tmpdir, `${identity}-${suffix}.invocation.json`);
    try {
      const handle = await fs.open(invocationFile, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ sequence, operation, slice, attempt, status: 'STARTED' })}\n`, 'utf8');
      await handle.close();
      return {
        attempt,
        invocationFile,
        structuredOutputFile: path.join(tmpdir, `${identity}-${suffix}.jsonl`),
        semanticResponseFile: path.join(tmpdir, `${identity}-${suffix}.response.json`),
        receiptFile: path.join(tmpdir, `${identity}-${suffix}.receipt.json`),
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  fail('configured runner invocation budget exhausted for this official operation event');
}

export async function invokeConfiguredValidationRunner({
  operation,
  sequence,
  slice,
  specPath,
  officialPreflight,
  prompt,
  workspace,
  tmpdir,
  providerCommand,
}) {
  if (!SUPPORTED_OPERATIONS.has(operation)) fail('unsupported validation-runner operation');
  if (!Number.isSafeInteger(sequence) || sequence < 1) fail('benchmark sequence must be a positive integer');
  if (typeof slice !== 'string' || !/^slice-[0-9]{2,}$/u.test(slice)) fail('slice must be canonical');
  if (typeof prompt !== 'string' || prompt.trim() === '') fail('runner request must be non-empty');

  const canonicalWorkspace = await canonicalDirectory(workspace, 'workspace');
  const canonicalTmpdir = await canonicalDirectory(tmpdir, 'runner-tmp');
  const canonicalSpecPath = await canonicalWorkspaceEntry(specPath, canonicalWorkspace, 'SPEC_PATH');
  validateOfficialPreflight({ operation, slice, specPath: canonicalSpecPath, officialPreflight });
  const sessionRoot = path.dirname(canonicalTmpdir);
  if (path.basename(canonicalTmpdir) !== 'runner-tmp'
    || !inside(canonicalWorkspace, path.join(sessionRoot, 'workspaces'))
    || inside(canonicalTmpdir, canonicalWorkspace)) {
    fail('workspace and runner-tmp must belong to one managed benchmark session');
  }

  const configuration = await readRunnerConfiguration(canonicalWorkspace);
  const outputSchema = SEMANTIC_RESPONSE_SCHEMA_PATH_BY_OPERATION[operation];
  if (typeof outputSchema !== 'string' || !path.isAbsolute(outputSchema)) fail('operation response schema is unavailable');
  const schemaMetadata = await fs.lstat(outputSchema).catch(() => null);
  if (schemaMetadata === null || !schemaMetadata.isFile() || schemaMetadata.isSymbolicLink()
    || await fs.realpath(outputSchema) !== outputSchema) {
    fail('operation response schema must be a canonical regular file');
  }
  const reservation = await reserveInvocation({ tmpdir: canonicalTmpdir, sequence, operation, slice });
  const runnerPrompt = [
    `You are the independent ${RUNNER_AGENT} session. Follow the exact configured developer instructions below.`,
    configuration.developerInstructions,
    'The production-v2 launcher already ran the exact official execution preflight for this managed SPEC_PATH, operation, and slice. Do not rerun or reconstruct that mechanical command. Use the trusted result below, compare its authority with the request and selected artifacts, and resume directly at the logical runner invocation when its mandatory recovery target matches.',
    `OFFICIAL_EXECUTION_PREFLIGHT=${JSON.stringify(officialPreflight)}`,
    'Current operation payload follows. It contains only the official operation context; do not rely on other conversation history.',
    prompt,
  ].join('\n\n');

  const harness = await runHarness({
    cwd: canonicalWorkspace,
    effort: configuration.effort,
    model: configuration.model,
    outputSchema,
    prompt: runnerPrompt,
    sandbox: configuration.sandbox,
    timeoutMs: LONG_MODEL_OPERATION_TIMEOUT_MS,
    tmpdir: canonicalTmpdir,
    structuredOutputFile: reservation.structuredOutputFile,
    disabledFeatures: ['multi_agent'],
  }, { providerCommand });

  let semanticResponseFile = null;
  let captureFailure = null;
  if (harness.status === 'HARNESS_COMPLETED') {
    try {
      await captureRunnerResponse({
        structuredOutputFile: reservation.structuredOutputFile,
        outputFile: reservation.semanticResponseFile,
      });
      semanticResponseFile = reservation.semanticResponseFile;
    } catch (error) {
      captureFailure = error.message;
    }
  }

  const resultStatus = semanticResponseFile !== null
    ? 'RUNNER_RESPONSE_CAPTURED'
    : harness.sessionStarted ? 'RUNNER_RESULT_BLOCKED' : 'RUNNER_INITIALIZATION_BLOCKED';
  const receipt = {
    status: resultStatus,
    sequence,
    operation,
    slice,
    attempt: reservation.attempt,
    runnerAgent: RUNNER_AGENT,
    requestedModel: harness.requestedModel ?? configuration.model,
    requestedEffort: harness.requestedEffort ?? configuration.effort,
    outputSchemaAttached: true,
    harnessStatus: harness.status,
    retryCount: harness.retryCount ?? 0,
    sessionStarted: harness.sessionStarted ?? false,
    structuredOutputFile: harness.structuredOutputFile ?? null,
    semanticResponseFile,
    providerErrorCategory: harness.providerErrorCategory ?? null,
    providerErrorDiagnosticCode: harness.providerErrorDiagnosticCode ?? null,
    captureFailure,
  };
  await fs.writeFile(reservation.receiptFile, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { ...receipt, exitCode: semanticResponseFile === null ? 1 : 0 };
}

function parseArguments(argv) {
  if (argv[0] !== '--official-broker') {
    fail('the official benchmark runner broker is required');
  }
  const valuesArgv = argv.slice(1);
  if (valuesArgv.length !== 6) fail('usage: benchmark-validation-runner.mjs --official-broker --operation <operation> --sequence <positive integer> --slice <slice-NN>');
  const values = {};
  for (let index = 0; index < valuesArgv.length; index += 2) {
    const name = valuesArgv[index];
    const value = valuesArgv[index + 1];
    if (!new Set(['--operation', '--sequence', '--slice']).has(name)
      || value === undefined || value.startsWith('--') || Object.hasOwn(values, name)) {
      fail('invalid benchmark-validation-runner arguments');
    }
    values[name] = value;
  }
  const sequence = Number(values['--sequence']);
  if (!Number.isSafeInteger(sequence) || String(sequence) !== values['--sequence']) fail('sequence must be a positive canonical integer');
  return { operation: values['--operation'], sequence, slice: values['--slice'] };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(argv) {
  const request = parseArguments(argv);
  const result = await submitOfficialRunnerRequest({
    ...request,
    prompt: await readStdin(),
    workspace: await fs.realpath(process.cwd()),
    tmpdir: process.env.TMPDIR,
  });
  process.stdout.write(`SENTINEL_RUNNER_RECEIPT ${JSON.stringify(result)}\n`);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    process.exitCode = 1;
  }
}
