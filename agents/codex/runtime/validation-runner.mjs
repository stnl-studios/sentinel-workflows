#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { captureRunnerResponse } from '../../../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import { runCodexTurn } from './sdk-transport.mjs';
import { submitOfficialRunnerRequest } from './runner-broker.mjs';

const OPERATIONS = new Set(['EXECUTE_SLICE', 'APPLY_FINDINGS', 'VALIDATE_SLICE']);
const RUNNER_NAME = 'stnl_validation_runner';

function fail(message) { throw new Error(message); }

export async function readRunnerConfiguration(snapshot) {
  const file = path.join(snapshot, 'agents', 'codex', '.codex', 'agents', `${RUNNER_NAME}.toml`);
  const value = await fs.readFile(file, 'utf8');
  const block = /^developer_instructions = """\n([\s\S]*?)\n"""/mu.exec(value);
  const model = /^model = "([^"]+)"$/mu.exec(value)?.[1];
  const effort = /^model_reasoning_effort = "([^"]+)"$/mu.exec(value)?.[1];
  if (!block || /^name = "([^"]+)"$/mu.exec(value)?.[1] !== RUNNER_NAME
    || model !== 'gpt-5.6-luna' || effort !== 'medium'
    || /^sandbox_mode\s*=/mu.test(value)) fail('independent runner configuration is invalid');
  return { model, effort, developerInstructions: block[1] };
}

export function composeRunnerRequest({ configuration, officialPreflight, operation, slice,
  workspace, serializer, prompt }) {
  for (const value of [workspace, serializer, officialPreflight?.specPath]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n\0]/u.test(value)) {
      fail('runner adapter context path is invalid');
    }
  }
  return [
    `You are the independent ${RUNNER_NAME} session. Follow its configured instructions.`,
    configuration.developerInstructions,
    `RUNNER_EVIDENCE_SERIALIZER=${serializer}`,
    `MANAGED_WORKSPACE=${workspace}`,
    `SPEC_PATH=${officialPreflight.specPath}`,
    `OPERATION=${operation}`,
    `SLICE=${slice}`,
    `OFFICIAL_EXECUTION_PREFLIGHT=${JSON.stringify(officialPreflight)}`,
    'Current operation payload follows. Do not use any prior conversation.',
    prompt,
  ].join('\n\n');
}

export async function invokeIndependentRunner({
  snapshot, workspace, tmpdir, env, operation, sequence, slice, officialPreflight, prompt,
  onBeforeTurn = () => {}, onTurn = () => {},
}) {
  const relativeSpec = typeof officialPreflight?.specPath === 'string'
    ? path.relative(workspace, officialPreflight.specPath) : '..';
  if (!OPERATIONS.has(operation) || !/^slice-[0-9]{2,}$/u.test(slice)
    || !Number.isSafeInteger(sequence) || sequence < 1
    || officialPreflight?.exitCode !== 0 || officialPreflight.operation !== operation
    || officialPreflight.slice !== slice || relativeSpec === '..' || relativeSpec.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeSpec) || relativeSpec === ''
    || typeof prompt !== 'string' || prompt.trim() === '') fail('independent runner request is invalid');
  const configuration = await readRunnerConfiguration(snapshot);
  const baseName = `${String(sequence).padStart(3, '0')}-${operation.toLowerCase()}-${slice}`;
  let operationName;
  let attempt;
  for (attempt = 1; attempt <= 3; attempt += 1) {
    operationName = `${baseName}-attempt-${attempt}`;
    try {
      await fs.writeFile(path.join(tmpdir, `${operationName}.started.json`),
        `${JSON.stringify({ operation, sequence, slice, attempt })}\n`, { flag: 'wx' });
      break;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  if (attempt > 3) fail('runner invocation budget exhausted');
  const schemas = {
    EXECUTE_SLICE: 'runner-execute-response.schema.json',
    APPLY_FINDINGS: 'runner-apply-findings-response.schema.json',
    VALIDATE_SLICE: 'runner-validate-response.schema.json',
  };
  const schema = JSON.parse(await fs.readFile(path.join(snapshot, 'skills', 'workflows', 'stnl-slice-executor', 'runtime', schemas[operation]), 'utf8'));
  const serializer = path.join(snapshot, 'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs');
  const serializerMetadata = await fs.lstat(serializer);
  if (!serializerMetadata.isFile() || serializerMetadata.isSymbolicLink()
    || await fs.realpath(serializer) !== serializer) fail('runner evidence serializer is unavailable');
  const request = composeRunnerRequest({ configuration, officialPreflight, operation, slice,
    workspace, serializer, prompt });
  const eventsPath = path.join(tmpdir, `${operationName}.events.jsonl`);
  const responsePath = path.join(tmpdir, `${operationName}.response.json`);
  await onBeforeTurn({ role: 'runner', operation, sequence, slice, attempt });
  const turn = await runCodexTurn({
    env, cwd: workspace, prompt: request, model: configuration.model,
    effort: configuration.effort, operationId: `runner-${operationName}`,
    eventsPath, outputSchema: schema, timeoutMs: 1_800_000,
  });
  await onTurn({ role: 'runner', operation, sequence, slice, attempt, turn, eventsPath });
  let captureFailure = null;
  let semanticResponseFile = null;
  if (turn.completed) {
    try {
      await captureRunnerResponse({ structuredOutputFile: eventsPath, outputFile: responsePath });
      semanticResponseFile = responsePath;
    } catch (error) { captureFailure = error.message; }
  }
  const status = semanticResponseFile !== null ? 'RUNNER_RESPONSE_CAPTURED'
    : turn.threadId ? 'RUNNER_RESULT_BLOCKED' : 'RUNNER_INITIALIZATION_BLOCKED';
  const receipt = {
    status, operation, sequence, slice, attempt, runnerAgent: RUNNER_NAME,
    requestedModel: turn.requestedModel, requestedEffort: turn.requestedEffort,
    reportedModel: turn.reportedModel, threadId: turn.threadId,
    eventsPath, semanticResponseFile, captureFailure,
    error: turn.error, usage: turn.usage,
    exitCode: semanticResponseFile === null ? 1 : 0,
  };
  await fs.writeFile(path.join(tmpdir, `${operationName}.receipt.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

export async function main(argv) {
  if (argv.length !== 4 || argv[0] !== '--operation' || argv[2] !== '--slice'
    || !OPERATIONS.has(argv[1]) || !/^slice-[0-9]{2,}$/u.test(argv[3])) {
    fail('usage: validation-runner.mjs --operation <operation> --slice <slice-NN>');
  }
  const workspace = await fs.realpath(process.cwd());
  const tmpdir = await fs.realpath(process.env.TMPDIR ?? '');
  const active = JSON.parse(await fs.readFile(path.join(tmpdir, 'stnl-runner-broker', 'active.json'), 'utf8'));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const result = await submitOfficialRunnerRequest({
    workspace, tmpdir, operation: argv[1], slice: argv[3],
    sequence: active.sequence, prompt: Buffer.concat(chunks).toString('utf8'),
  });
  process.stdout.write(`SENTINEL_RUNNER_RECEIPT ${JSON.stringify(result)}\n`);
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`BLOCKED: ${error.message}\n`); process.exitCode = 1; }
}
