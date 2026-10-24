import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connectAppServer, initializeAppServer, describeAppServerBundle, assertAppServerBundle,
  startAppServerTurn, readAppServerTurn, bindAppServerChild, captureAppServerChild,
  deniedShellTemporaryFile, persistAppServerStderrSample } from './app-server-transport.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const blocked = message => Object.assign(new Error(message), { code: 'NATIVE_TRANSPORT_UNPROVEN' });
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', cancel); resolve(); }
  function cancel() { clearTimeout(timer); reject(blocked('native observation cancelled; dispatch may be active')); }
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
});

// One owned App Server per case, normal HOME. Tests inject only a fake public
// RPC object; importing/calling the observer with it never opens a real client.
export async function createNativeProvider({ snapshot, workspace, evidenceRoot, rpc = null, pollMs = 100 }) {
  const bundle = await describeAppServerBundle({ skillsRoot: path.join(snapshot, 'skills/workflows'),
    runnerFile: path.join(snapshot, 'agents/codex/.codex/agents/stnl_validation_runner.toml') });
  let connection = null;
  if (rpc === null) {
    // Legacy SDK offline fixtures must never fall through to an authenticated
    // client because their provider does not speak App Server.
    if (process.env.STNL_OFFLINE_PROVIDER_CONTEXT !== undefined || process.env.NODE_TEST_CONTEXT !== undefined) {
      throw blocked('an explicit offline App Server provider is required for this fixture');
    }
    const cliLauncher = path.join(snapshot, 'agents/codex/node_modules/@openai/codex/bin/codex.js');
    connection = await connectAppServer({ cliLauncher, cliSha256: sha(await fs.readFile(cliLauncher)), cwd: workspace });
    rpc = connection.rpc;
  }
  try { await initializeAppServer(rpc); }
  catch (error) {
    const stderrSample = await persistAppServerStderrSample(rpc, evidenceRoot);
    if (stderrSample !== null) error.stderrSample = stderrSample;
    throw error;
  }
  return {
    bundle,
    async runTurn({ prompt, workflowSkill, model, effort, outputSchema, operationId, role,
      priorAuthorThread = null, signal, timeoutMs = 900_000, onChildStarted, onChildCompleted,
      onDispatched, onUnadmittedChildren, observation = null }) {
      await assertAppServerBundle(bundle);
      const events = [], children = new Map();
      const eventsFile = path.join(evidenceRoot, `${operationId}.events.jsonl`);
      if (observation === null) await fs.writeFile(eventsFile, '', { flag: 'wx' });
      else await fs.access(eventsFile);
      const record = async event => {
        events.push(event); await fs.appendFile(eventsFile, `${JSON.stringify(event)}\n`);
      };
      let dispatch = null, dispatchAttempted = false, historyTimer = null;
      try {
        if (role !== 'author' && priorAuthorThread !== null) throw blocked('review context cannot inherit author history');
        dispatchAttempted = true;
        dispatch = observation ?? await startAppServerTurn(rpc, { bundle, cwd: workspace, skillName: workflowSkill,
          prompt, model, effort, outputSchema, threadId: priorAuthorThread?.threadId ?? null,
          // Explicit null inherits the normal client's configured permissions.
          // The benchmark never silently enables Full Access/never.
          admittedAuthorThread: priorAuthorThread, approvalPolicy: null, sandbox: null });
        const acknowledgedAt = Date.now();
        const historyDeadlineAt = observation === null && priorAuthorThread === null
          ? acknowledgedAt + Math.min(30_000, timeoutMs) : null;
        await onDispatched?.(dispatch);
        await record({ type: observation === null ? 'native.turn.started' : 'native.turn.observation-resumed', ...dispatch, operationId, role });
        const started = Date.now(); let observed, historyObserved = false, pendingRecorded = false;
        // ACK is not a readable history barrier. Observe this fresh dispatch
        // within one bounded window; never restart it on persisted observation.
        if (historyDeadlineAt !== null && Date.now() >= historyDeadlineAt) {
          throw blocked('initial public history observation deadline exceeded; dispatch remains uncertain');
        }
        const historyDeadline = historyDeadlineAt !== null ? new Promise((_, reject) => {
          historyTimer = setTimeout(() => reject(blocked('initial public history observation deadline exceeded; dispatch remains uncertain')),
            Math.max(0, historyDeadlineAt - Date.now()));
        }) : null;
        for (;;) {
          if (signal?.aborted || Date.now() - started > timeoutMs) throw blocked('observation interrupted; started turn is uncertain');
          if (!historyObserved && historyDeadlineAt !== null && Date.now() >= historyDeadlineAt) {
            throw blocked('initial public history observation deadline exceeded; dispatch remains uncertain');
          }
          try {
            const reading = readAppServerTurn(rpc, dispatch);
            observed = await (!historyObserved && historyDeadline ? Promise.race([reading, historyDeadline]) : reading);
          } catch (error) {
            if (historyObserved || !historyDeadline || error.initialHistoryUnavailable !== true) throw error;
            if (!pendingRecorded) {
              await record({ type: 'native.history.pending', ...dispatch, message: error.message });
              pendingRecorded = true;
            }
            await Promise.race([wait(pollMs, signal), historyDeadline]);
            continue;
          }
          if (signal?.aborted || Date.now() - started > timeoutMs) throw blocked('observation interrupted; started turn is uncertain');
          if (!historyObserved && historyDeadlineAt !== null && Date.now() >= historyDeadlineAt) {
            throw blocked('initial public history observation deadline exceeded; dispatch remains uncertain');
          }
          historyObserved = true; clearTimeout(historyTimer); historyTimer = null;
          if (observed.items.some(deniedShellTemporaryFile)) throw blocked('SANDBOX_COMMAND_DENIED: implicit temporary file denial');
          for (const item of observed.items) {
            if (item.type !== 'subAgentActivity' || item.kind !== 'started') continue;
            const known = children.get(item.agentPath);
            if (known && known.agentThreadId !== item.agentThreadId) throw blocked('child identity changed');
            if (!known) {
              const binding = await bindAppServerChild(rpc, { parentThreadId: dispatch.threadId,
                parentTurnId: dispatch.turnId, agentPath: item.agentPath });
              await onChildStarted?.(binding);
              children.set(item.agentPath, binding);
              await record({ type: 'native.child.started', binding });
            }
          }
          if (observed.turn.status !== 'inProgress') break;
          await wait(pollMs, signal);
        }
        if (observed.turn.status !== 'completed' || observed.turn.error != null) throw blocked('parent turn failed/interrupted');
        const captures = [];
        for (const binding of children.values()) {
          const toolResultFile = path.join(evidenceRoot, `${operationId}.child-${sha(binding.agentPath).slice(7)}.json`);
          const capture = await captureAppServerChild(rpc, { binding, bundle, cwd: workspace, toolResultFile });
          const toolResult = JSON.parse(await fs.readFile(toolResultFile, 'utf8'));
          captures.push({ binding, ...capture, toolResult });
          await onChildCompleted?.({ binding, toolResult, capture });
          await record({ type: 'native.child.completed', binding, finalResponseSha256: capture.finalResponseSha256 });
        }
        const messages = observed.items.filter(item => item.type === 'agentMessage');
        const answer = messages.at(-1);
        if (!answer || ![null, undefined, 'final_answer'].includes(answer.phase)
          || typeof answer.text !== 'string') throw blocked('parent final response incomplete');
        const commandResults = [];
        for (const item of observed.items) if (item.type === 'commandExecution') {
          await record({ type: 'native.command.completed', item });
          if (item.status === 'completed' && item.exitCode === 0 && typeof item.aggregatedOutput === 'string') {
            try { commandResults.push(JSON.parse(item.aggregatedOutput)); } catch { /* prose is not structured proof */ }
          }
        }
        await assertAppServerBundle(bundle);
        await record({ type: 'native.turn.completed', ...dispatch });
        return { ...dispatch, completed: true, turnStarted: true, response: answer.text,
          commandResults, captures, eventsPath: eventsFile, usage: null, toolCalls: null,
          requestedModel: model, requestedEffort: effort, reportedModel: null,
          authorThread: role === 'author' ? { threadId: dispatch.threadId, cwd: workspace,
            bundleSha256: sha(Buffer.from(JSON.stringify(bundle))), role: 'author' } : null };
      } catch (error) {
        clearTimeout(historyTimer); historyTimer = null;
        if (error.descendants?.length) await onUnadmittedChildren?.(error.descendants);
        const stderrSample = await persistAppServerStderrSample(rpc, evidenceRoot);
        await record({ type: 'native.transport.blocked', code: error.code ?? 'DRIVER_FAILURE',
          message: error.message, dispatch, dispatchAttempted, stderrSample });
        return { ...dispatch, threadId: dispatch?.threadId ?? null, completed: false,
          turnStarted: dispatchAttempted ? null : false, response: null, usage: null, toolCalls: null,
          captures: [], commandResults: [], eventsPath: eventsFile, error: error.message,
          errorCode: error.code ?? 'NATIVE_TRANSPORT_UNPROVEN', requestedModel: model, requestedEffort: effort,
          observation: dispatch, stderrSample };
      } finally { clearTimeout(historyTimer); }
    },
    close() { connection?.close(); },
  };
}
