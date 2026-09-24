import fs from 'node:fs/promises';
import { Codex } from '@openai/codex-sdk';

const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const ALLOWED_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);

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
}) {
  if (typeof prompt !== 'string' || prompt.trim() === '' || !ALLOWED_MODELS.has(model)
    || !ALLOWED_EFFORTS.has(effort) || typeof cwd !== 'string' || typeof eventsPath !== 'string'
    || !env?.CODEX_HOME || Object.hasOwn(env, 'OPENAI_API_KEY') || Object.hasOwn(env, 'CODEX_API_KEY')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('invalid Codex SDK turn configuration');
  }
  const codex = new Codex({ env });
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
  let response = null;
  let completed = false;
  let error = null;
  let toolCalls = 0;
  const file = await fs.open(eventsPath, 'a');
  try {
    const { events } = await thread.runStreamed(prompt, { signal: abort.signal, outputSchema });
    for await (const event of events) {
      await file.writeFile(`${JSON.stringify(persistentEvent(event, operationId))}\n`);
      onEvent(event);
      if (event.type === 'thread.started') actualThreadId = event.thread_id;
      if (event.type === 'turn.completed') { usage = event.usage ?? null; completed = true; }
      if (event.type === 'turn.failed') error = event.error?.message ?? 'turn failed';
      if (event.type === 'error') error = event.message;
      if (event.type === 'item.completed') {
        if (event.item.type === 'agent_message') response = event.item.text;
        if (['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call'].includes(event.item.type)) toolCalls += 1;
      }
    }
  } catch (caught) {
    error = String(caught);
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
    error,
    response,
    usage,
    toolCalls,
  };
}
