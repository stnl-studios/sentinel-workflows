import fs from 'node:fs/promises';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';

const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const ALLOWED_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']);

export async function codexClientConfig({ env, developerInstructions = null, isolateSkills = false }) {
  const config = { agents: { enabled: false }, features: { multi_agent: false, multi_agent_v2: false } };
  if (developerInstructions === null && !isolateSkills) return config;
  if (typeof developerInstructions !== 'string' || developerInstructions.trim() === '') {
    throw new Error('runner developer instructions are missing');
  }
  config.developer_instructions = developerInstructions;
  if (isolateSkills) {
    const skillsRoot = path.join(env.CODEX_HOME, 'skills');
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    config.skills = { config: entries.filter((entry) => entry.isDirectory())
      .map((entry) => ({ path: path.join(skillsRoot, entry.name), enabled: false })) };
  }
  return config;
}

function persistentEvent(event, operationId) {
  if ((event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
    && event.item?.type === 'reasoning') {
    return { operationId, type: event.type, item: { type: 'reasoning', omitted: true } };
  }
  return { operationId, ...event };
}

export async function runCodexTurn({
  env, cwd, prompt, model, effort, threadId = null, operationId, eventsPath,
  outputSchema = undefined, timeoutMs = 900_000, onEvent = () => {}, signal = null,
  developerInstructions = null, isolateSkills = false,
  codexPathOverride = undefined,
}) {
  if (typeof prompt !== 'string' || prompt.trim() === '' || !ALLOWED_MODELS.has(model)
    || !ALLOWED_EFFORTS.has(effort) || typeof cwd !== 'string' || typeof eventsPath !== 'string'
    || !env?.CODEX_HOME || Object.hasOwn(env, 'OPENAI_API_KEY') || Object.hasOwn(env, 'CODEX_API_KEY')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('invalid Codex SDK turn configuration');
  }
  // The manager admits and counts independent runner turns through its adapter.
  // Prevent SDK turns from starting untracked collaboration subagents.
  const codex = new Codex({ env, config: await codexClientConfig({ env, developerInstructions, isolateSkills }), codexPathOverride });
  const options = {
    model,
    modelReasoningEffort: effort,
    workingDirectory: cwd,
    approvalPolicy: 'never',
  };
  const thread = threadId === null ? codex.startThread(options) : codex.resumeThread(threadId, options);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let actualThreadId = threadId;
  let usage = null;
  let turnStarted = false;
  let response = null;
  let completed = false;
  let error = null;
  let errorEvent = null;
  let processError = null;
  let toolCalls = 0;
  const file = await fs.open(eventsPath, 'a');
  try {
    const { events } = await thread.runStreamed(prompt, { signal: abort.signal, outputSchema });
    for await (const event of events) {
      await file.writeFile(`${JSON.stringify(persistentEvent(event, operationId))}\n`);
      onEvent(event);
      if (event.type === 'thread.started') actualThreadId = event.thread_id;
      if (event.type === 'thread.started' || event.type === 'turn.started') turnStarted = true;
      if (event.type === 'turn.completed') { usage = event.usage ?? null; completed = true; }
      if (event.type === 'turn.failed') {
        if (event.error && typeof event.error === 'object') errorEvent ??= persistentEvent(event, operationId);
        error ??= event.error?.message ?? event.error?.code ?? 'turn failed';
      }
      if (event.type === 'error') {
        errorEvent ??= persistentEvent(event, operationId);
        error ??= event.message ?? event.code ?? 'provider error';
      }
      if (event.type === 'item.completed') {
        if (event.item.type === 'agent_message') response = event.item.text;
        if (['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call'].includes(event.item.type)) toolCalls += 1;
      }
    }
  } catch (caught) {
    processError = String(caught);
    error ??= processError;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await file.close();
  }
  return {
    requestedModel: model,
    requestedEffort: effort,
    reportedModel: null,
    threadId: actualThreadId,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    completed,
    turnStarted,
    error,
    errorEvent,
    processError,
    response,
    usage,
    toolCalls,
  };
}
