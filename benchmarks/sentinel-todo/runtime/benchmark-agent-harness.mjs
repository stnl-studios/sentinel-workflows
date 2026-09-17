#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const agentHarnessContractVersion = 1;

const RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(RUNTIME_ROOT, '../../..');
const DISCOVERY_TIMEOUT_MS = 10_000;
const DISCOVERY_OUTPUT_LIMIT = 512 * 1024;
const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const TERMINATION_GRACE_MS = 500;

const MODEL_MAPPING = Object.freeze({
  'GPT-5.6-Luna': 'gpt-5.6-luna',
  'GPT-5.6-Terra': 'gpt-5.6-terra',
  'GPT-5.6-Sol': 'gpt-5.6-sol',
});

const EFFORT_MAPPING = Object.freeze({
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
});

const SANDBOX_MAPPING = Object.freeze({
  'read-only': 'read-only',
  'workspace-write': 'workspace-write',
});

const STATIC_CONFIG_OVERRIDES = Object.freeze([
  'project_doc_max_bytes=0',
  'project_doc_fallback_filenames=[]',
  'shell_environment_policy.inherit="all"',
  'shell_environment_policy.experimental_use_profile=false',
  'shell_environment_policy.ignore_default_excludes=false',
]);

const INVOCATION_POLICY = Object.freeze({
  approval: 'global-long-form-never',
  configIsolation: ['ignore-user-config', 'ignore-rules', 'project-docs-disabled'],
  sessionPersistence: 'ephemeral',
  promptTransport: 'stdin',
  structuredOutput: 'jsonl',
  shellEnvironment: STATIC_CONFIG_OVERRIDES.slice(2),
  timeoutOwnership: 'benchmark-harness',
  retryCount: 0,
});

const REQUIRED_CAPABILITIES = Object.freeze([
  'exec',
  'structuredOutput',
  'stdin',
  'sandbox',
  'modelOverride',
  'explicitEffort',
  'cwdOverride',
  'noninteractiveApproval',
  'strictConfig',
  'ephemeral',
  'ignoreUserConfig',
  'ignoreRules',
]);

const ENVIRONMENT_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'USER',
  'LOGNAME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
]);

class HarnessInvocationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.exitCode = 2;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function providerSpec(providerCommand) {
  if (providerCommand === undefined) return { command: 'codex', argsPrefix: [] };
  if (!providerCommand || typeof providerCommand.command !== 'string' || providerCommand.command.length === 0
    || !Array.isArray(providerCommand.argsPrefix)
    || providerCommand.argsPrefix.some((item) => typeof item !== 'string')) {
    throw new TypeError('test provider command must contain command and string argsPrefix');
  }
  return { command: providerCommand.command, argsPrefix: [...providerCommand.argsPrefix] };
}

function minimalEnvironment(tmpdir) {
  const environment = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    if (typeof process.env[name] === 'string') environment[name] = process.env[name];
  }
  if (environment.PATH === undefined) environment.PATH = process.env.PATH ?? '';
  if (tmpdir !== undefined) environment.TMPDIR = tmpdir;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = os.devNull;
  environment.GIT_TERMINAL_PROMPT = '0';
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_INDEX_FILE;
  delete environment.GIT_OBJECT_DIRECTORY;
  delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  return environment;
}

function terminate(child, signal) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

async function runProcess({ command, args, cwd, environment, input = '', timeoutMs, outputLimit }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: environment,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ spawnError: error, exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, outputExceeded: false });
      return;
    }

    const stdout = [];
    const stderr = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;
    let forceTimer = null;

    const stop = () => {
      terminate(child, 'SIGTERM');
      if (forceTimer === null) {
        forceTimer = setTimeout(() => terminate(child, 'SIGKILL'), TERMINATION_GRACE_MS);
        forceTimer.unref();
      }
    };

    const capture = (target) => (chunk) => {
      if (outputExceeded) return;
      const remaining = outputLimit - capturedBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) target.push(chunk.subarray(0, remaining));
        capturedBytes = outputLimit;
        outputExceeded = true;
        stop();
        return;
      }
      target.push(chunk);
      capturedBytes += chunk.length;
    };

    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer !== null) clearTimeout(forceTimer);
      resolve({ spawnError: error, exitCode: null, signal: null, stdout: '', stderr: '', timedOut, outputExceeded });
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceTimer !== null) clearTimeout(forceTimer);
      resolve({
        spawnError: null,
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        outputExceeded,
      });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    timeout.unref();
    child.stdin.end(input);
  });
}

function capabilityBooleans(rootHelp, execHelp) {
  const has = (text, option) => text.includes(option);
  return {
    exec: /Usage:\s+codex exec\b/u.test(execHelp),
    structuredOutput: has(execHelp, '--json'),
    stdin: /instructions are read from stdin/iu.test(execHelp),
    sandbox: has(execHelp, '--sandbox') && has(execHelp, 'read-only') && has(execHelp, 'workspace-write'),
    modelOverride: has(execHelp, '--model'),
    explicitEffort: has(execHelp, '--config'),
    cwdOverride: has(execHelp, '--cd'),
    noninteractiveApproval: has(rootHelp, '--ask-for-approval') && has(rootHelp, 'never'),
    strictConfig: has(execHelp, '--strict-config'),
    ephemeral: has(execHelp, '--ephemeral'),
    ignoreUserConfig: has(execHelp, '--ignore-user-config'),
    ignoreRules: has(execHelp, '--ignore-rules'),
  };
}

async function discoveryCall(provider, args) {
  return runProcess({
    command: provider.command,
    args: [...provider.argsPrefix, ...args],
    cwd: REPOSITORY_ROOT,
    environment: minimalEnvironment(),
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    outputLimit: DISCOVERY_OUTPUT_LIMIT,
  });
}

function discoverySucceeded(result) {
  return result.spawnError === null
    && result.exitCode === 0
    && result.timedOut === false
    && result.outputExceeded === false;
}

export async function discoverProviderCapabilities({ providerCommand } = {}) {
  const provider = providerSpec(providerCommand);
  const [versionResult, rootHelpResult, execHelpResult] = await Promise.all([
    discoveryCall(provider, ['--version']),
    discoveryCall(provider, ['--help']),
    discoveryCall(provider, ['exec', '--help']),
  ]);
  if (![versionResult, rootHelpResult, execHelpResult].every(discoverySucceeded)) {
    return {
      status: 'HARNESS_CAPABILITY_MISSING',
      missingCapabilities: ['provider-discovery'],
      fingerprint: null,
    };
  }

  const providerVersion = versionResult.stdout.trim();
  const capabilities = capabilityBooleans(rootHelpResult.stdout, execHelpResult.stdout);
  const missingCapabilities = REQUIRED_CAPABILITIES.filter((name) => capabilities[name] !== true);
  const fingerprintSource = {
    harnessContractVersion: agentHarnessContractVersion,
    provider: 'codex',
    providerVersion,
    rootHelp: rootHelpResult.stdout.replaceAll('\r\n', '\n'),
    execHelp: execHelpResult.stdout.replaceAll('\r\n', '\n'),
    modelMapping: MODEL_MAPPING,
    effortMapping: EFFORT_MAPPING,
    sandboxMapping: SANDBOX_MAPPING,
    invocationPolicy: INVOCATION_POLICY,
  };
  const fingerprint = {
    harnessContractVersion: agentHarnessContractVersion,
    provider: 'codex',
    providerVersion,
    capabilitiesHash: sha256(stableJson(fingerprintSource)),
    structuredOutput: capabilities.structuredOutput,
    stdin: capabilities.stdin,
    sandbox: capabilities.sandbox,
    modelOverride: capabilities.modelOverride,
    explicitEffort: capabilities.explicitEffort,
    userConfigIsolation: capabilities.ignoreUserConfig && capabilities.ignoreRules && capabilities.ephemeral,
    timeoutOwnership: 'benchmark-harness',
  };
  return {
    status: missingCapabilities.length === 0 ? 'HARNESS_COMPLETED' : 'HARNESS_CAPABILITY_MISSING',
    missingCapabilities,
    capabilities,
    fingerprint,
  };
}

async function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', `${label} must be an absolute path`);
  }
  const metadata = await fs.lstat(value).catch(() => null);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', `${label} must be a real existing directory`);
  }
  const canonical = await fs.realpath(value);
  if (canonical !== path.resolve(value)) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', `${label} must already be canonical`);
  }
  return canonical;
}

export async function validateHarnessRequest(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', 'request must be an object');
  }
  const expectedKeys = ['cwd', 'effort', 'model', 'prompt', 'sandbox', 'timeoutMs', 'tmpdir'];
  if (stableJson(Object.keys(request).sort()) !== stableJson(expectedKeys)) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', 'request fields are incomplete or unknown');
  }
  if (!Object.hasOwn(MODEL_MAPPING, request.model)) {
    throw new HarnessInvocationError('HARNESS_MODEL_UNSUPPORTED', 'requested model is unsupported');
  }
  if (!Object.hasOwn(EFFORT_MAPPING, request.effort)) {
    throw new HarnessInvocationError('HARNESS_EFFORT_UNSUPPORTED', 'requested effort is unsupported');
  }
  if (!Object.hasOwn(SANDBOX_MAPPING, request.sandbox)) {
    throw new HarnessInvocationError('HARNESS_SANDBOX_UNSUPPORTED', 'requested sandbox is unsupported');
  }
  if (typeof request.prompt !== 'string' || request.prompt.length === 0) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', 'prompt must be a non-empty string');
  }
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 3_600_000) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', 'timeoutMs must be an integer from 100 through 3600000');
  }

  const cwd = await canonicalDirectory(request.cwd, 'cwd');
  const tmpdir = await canonicalDirectory(request.tmpdir, 'tmpdir');
  const sessionRoot = path.dirname(tmpdir);
  const workspacesRoot = path.join(sessionRoot, 'workspaces');
  if (path.basename(tmpdir) !== 'runner-tmp'
    || cwd === workspacesRoot
    || !inside(cwd, workspacesRoot)
    || inside(cwd, REPOSITORY_ROOT)
    || inside(tmpdir, REPOSITORY_ROOT)) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', 'cwd and tmpdir must belong to one managed benchmark session');
  }
  return Object.freeze({ ...request, cwd, tmpdir });
}

export function buildCanonicalArgv(request) {
  const argv = [
    '--ask-for-approval',
    'never',
    'exec',
    '--strict-config',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--color',
    'never',
    '--json',
    '--model',
    MODEL_MAPPING[request.model],
    '--sandbox',
    SANDBOX_MAPPING[request.sandbox],
    '--cd',
    request.cwd,
    '--config',
    `model_reasoning_effort=${JSON.stringify(EFFORT_MAPPING[request.effort])}`,
  ];
  for (const override of STATIC_CONFIG_OVERRIDES) argv.push('--config', override);
  argv.push('-');
  return argv;
}

function providerErrorCategory(stderr) {
  if (/auth|credential|log[ -]?in|unauthorized/iu.test(stderr)) return 'AUTHENTICATION';
  if (/unexpected argument|invalid value|usage:/iu.test(stderr)) return 'INVOCATION_REJECTED';
  if (/rate.?limit|too many requests/iu.test(stderr)) return 'RATE_LIMIT';
  return stderr.trim() === '' ? null : 'PROVIDER_ERROR';
}

function parseStructuredOutput(stdout, processResult) {
  const events = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.trim() === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return { status: 'HARNESS_PROTOCOL_ERROR', events: [], sessionStarted: false, turnStarted: false };
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      return { status: 'HARNESS_PROTOCOL_ERROR', events: [], sessionStarted: false, turnStarted: false };
    }
    events.push(event);
  }

  const sessionStarted = events.some((event) => event.type === 'thread.started');
  const turnStarted = events.some((event) => event.type === 'turn.started');
  const turnCompleted = events.some((event) => event.type === 'turn.completed');
  const turnFailed = events.some((event) => event.type === 'turn.failed');
  const assistantMessages = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string')
    .map((event) => event.item.text);
  const commandExecutions = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'command_execution')
    .map((event) => Number.isInteger(event.item.exit_code) ? event.item.exit_code : null);
  const reportedModel = events
    .map((event) => event.model ?? event.item?.model)
    .find((model) => typeof model === 'string');

  let status;
  if (!sessionStarted && processResult.exitCode !== 0) status = 'HARNESS_INIT_FAILED';
  else if (turnFailed || (sessionStarted && processResult.exitCode !== 0)) status = 'MODEL_TURN_FAILED';
  else if (sessionStarted && turnStarted && turnCompleted && processResult.exitCode === 0) status = 'HARNESS_COMPLETED';
  else status = 'HARNESS_PROTOCOL_ERROR';
  return {
    status,
    sessionStarted,
    turnStarted,
    turnCompleted,
    commandExecutionCount: commandExecutions.length,
    commandExitCodes: commandExecutions,
    finalAssistantMessage: assistantMessages.at(-1) ?? null,
    providerReportedModel: reportedModel,
  };
}

function baseResult(request, capabilityResult) {
  return {
    status: 'HARNESS_INIT_FAILED',
    harnessContractVersion: agentHarnessContractVersion,
    requestedModel: request.model,
    requestedEffort: request.effort,
    requestedSandbox: request.sandbox,
    providerInvocationAccepted: false,
    sessionStarted: false,
    turnStarted: false,
    terminal: false,
    retryCount: 0,
    promptTransport: 'stdin',
    structuredOutput: true,
    capabilityFingerprint: capabilityResult.fingerprint,
    providerErrorCategory: null,
    finalAssistantMessage: null,
  };
}

export async function runHarness(request, { providerCommand, outputLimit = DEFAULT_OUTPUT_LIMIT } = {}) {
  let validated;
  try {
    validated = await validateHarnessRequest(request);
  } catch (error) {
    if (error instanceof HarnessInvocationError) {
      return {
        status: error.status,
        exitCode: error.exitCode,
        requestedModel: request?.model ?? null,
        requestedEffort: request?.effort ?? null,
        providerInvocationAccepted: false,
        retryCount: 0,
      };
    }
    throw error;
  }

  const capabilityResult = await discoverProviderCapabilities({ providerCommand });
  if (capabilityResult.status !== 'HARNESS_COMPLETED') {
    return {
      ...baseResult(validated, capabilityResult),
      status: 'HARNESS_CAPABILITY_MISSING',
      missingCapabilities: capabilityResult.missingCapabilities,
      exitCode: 1,
    };
  }

  const provider = providerSpec(providerCommand);
  const args = [...provider.argsPrefix, ...buildCanonicalArgv(validated)];
  const processResult = await runProcess({
    command: provider.command,
    args,
    cwd: validated.cwd,
    environment: minimalEnvironment(validated.tmpdir),
    input: validated.prompt,
    timeoutMs: validated.timeoutMs,
    outputLimit,
  });
  const result = baseResult(validated, capabilityResult);
  if (processResult.spawnError !== null) {
    return { ...result, status: 'HARNESS_INIT_FAILED', exitCode: 1 };
  }
  if (processResult.timedOut) {
    return { ...result, status: 'HARNESS_TIMEOUT', exitCode: 1 };
  }
  if (processResult.outputExceeded) {
    return { ...result, status: 'HARNESS_PROTOCOL_ERROR', providerErrorCategory: 'OUTPUT_LIMIT', exitCode: 1 };
  }

  const parsed = parseStructuredOutput(processResult.stdout, processResult);
  return {
    ...result,
    ...parsed,
    providerInvocationAccepted: parsed.sessionStarted,
    terminal: parsed.status === 'HARNESS_COMPLETED' || parsed.status === 'MODEL_TURN_FAILED',
    providerErrorCategory: parsed.status === 'HARNESS_COMPLETED' ? null : providerErrorCategory(processResult.stderr),
    exitCode: parsed.status === 'HARNESS_COMPLETED' ? 0 : 1,
  };
}

function publicSummary(result) {
  const summary = { ...result };
  if (Object.hasOwn(summary, 'finalAssistantMessage')) {
    summary.finalAssistantMessagePresent = typeof summary.finalAssistantMessage === 'string';
    summary.finalAssistantMessageSha256 = summary.finalAssistantMessagePresent
      ? sha256(summary.finalAssistantMessage)
      : null;
    delete summary.finalAssistantMessage;
  }
  return summary;
}

async function readRequestFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', '--request must be an absolute path');
  }
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', '--request must be a real existing file');
  }
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new HarnessInvocationError('HARNESS_INIT_FAILED', 'request JSON is invalid');
  }
}

export async function main(argv) {
  const [command, ...tokens] = argv;
  if (command === 'check' && tokens.length === 0) {
    const result = await discoverProviderCapabilities();
    process.stdout.write(`${JSON.stringify(publicSummary(result))}\n`);
    return result.status === 'HARNESS_COMPLETED' ? 0 : 1;
  }
  if (command === 'run' && tokens.length === 2 && tokens[0] === '--request') {
    const request = await readRequestFile(tokens[1]);
    const result = await runHarness(request);
    process.stdout.write(`${JSON.stringify(publicSummary(result))}\n`);
    return result.exitCode;
  }
  const result = {
    status: 'HARNESS_INIT_FAILED',
    harnessContractVersion: agentHarnessContractVersion,
    providerInvocationAccepted: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const status = error instanceof HarnessInvocationError ? error.status : 'HARNESS_INIT_FAILED';
    process.stdout.write(`${JSON.stringify({
      status,
      harnessContractVersion: agentHarnessContractVersion,
      providerInvocationAccepted: false,
    })}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

export { HarnessInvocationError };
