import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connectAppServer, initializeAppServer, describeAppServerBundle, assertAppServerBundle,
  startAppServerTurn, readAppServerTurn, bindAppServerChild, readAppServerChild, writeNativeToolResult,
  deniedShellTemporaryFile, persistAppServerStderrSample, observeAppServerChild } from './app-server-transport.mjs';

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
      onDispatched, onUnadmittedChildren, observation = null, observeFormalBinding = null,
      onChildTurns, onFormalObserved, onAuxiliaryCompleted, validateRetainedCaptures }) {
      await assertAppServerBundle(bundle);
      if (typeof operationId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(operationId)) throw blocked('invalid operation evidence identity');
      const events = [], children = new Map(), captures = new Map();
      const eventsFile = path.join(evidenceRoot, `${operationId}.events.jsonl`);
      if (observation === null) await fs.writeFile(eventsFile, '', { flag: 'wx' });
      else await fs.access(eventsFile);
      const previousReady = observation === null ? [] : (await fs.readFile(eventsFile, 'utf8'))
        .split('\n').filter(Boolean).map(JSON.parse).filter(event => event.type === 'native.child.completed');
      const notified = new Set();
      const formal = new Map(), views = new Map(), auxiliaryDone = new Set();
      let terminalObserved = false;
      const record = async event => {
        events.push(event); await fs.appendFile(eventsFile, `${JSON.stringify(event)}\n`);
      };
      const collect = async binding => {
        const toolResultFile = path.join(evidenceRoot, `${operationId}.child-${sha(binding.agentPath).slice(7)}.json`);
        const observed = await readAppServerChild(rpc, { binding, bundle, cwd: workspace });
        let first = captures.get(binding.agentPath);
        if (!first) {
          const prior = previousReady.filter(event => event.binding?.agentPath === binding.agentPath);
          if (prior.length > 1) throw blocked('duplicate persisted child readiness');
          if (prior.length) {
            if (prior[0].toolResultFile !== toolResultFile
              || Object.keys(binding).some(key => prior[0].binding[key] !== binding[key])) throw blocked('persisted child readiness binding differs');
            const saved = JSON.parse(await fs.readFile(toolResultFile, 'utf8'));
            if (saved.agentId !== binding.agentPath || saved.status !== 'completed' || typeof saved.finalResponse !== 'string'
              || sha(saved.finalResponse) !== prior[0].finalResponseSha256) throw blocked('persisted first child envelope differs');
            first = { binding, file: toolResultFile, finalResponseSha256: prior[0].finalResponseSha256,
              ...(prior[0].designation ? { designation: prior[0].designation } : {}),
              toolResult: { agentId: binding.agentPath, status: 'completed', finalResponse: saved.finalResponse } };
            captures.set(binding.agentPath, first);
          }
        }
        const toolResult = first?.toolResult ?? observed;
        const bytes = Buffer.from(`${JSON.stringify(toolResult)}\n`);
        if (JSON.stringify(observed) !== JSON.stringify(toolResult)) throw blocked('public child differs from first capture');
        // Reobservation never recreates a missing first file. File and public
        // source agreeing with each other is insufficient if both drifted.
        const capture = first ?? await writeNativeToolResult(toolResultFile, toolResult);
        const metadata = await fs.lstat(toolResultFile);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
          || await fs.realpath(toolResultFile) !== toolResultFile
          || !bytes.equals(await fs.readFile(toolResultFile))) throw blocked('saved first child envelope absent/aliased/divergent');
        if (first) {
          if (!notified.has(binding.agentPath)) { await onChildCompleted?.({ binding, toolResult, capture: first }); notified.add(binding.agentPath); }
          return;
        }
        captures.set(binding.agentPath, { binding, ...capture, toolResult,
          ...(formal.has(binding.agentThreadId) ? { designation: formal.get(binding.agentThreadId) } : {}) });
        // A complete event is the ready barrier, after the exclusive file write.
        // This supplies transport bytes only; the principal still owns bind,
        // capture-native, publication and any legal normalization.
        await record({ type: 'native.child.completed', binding, toolResultFile,
          ...(formal.has(binding.agentThreadId) ? { designation: formal.get(binding.agentThreadId) } : {}),
          finalResponseSha256: capture.finalResponseSha256 });
        await onChildCompleted?.({ binding, toolResult, capture });
        notified.add(binding.agentPath);
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
            const reading = readAppServerTurn(rpc, { ...dispatch, cwd: workspace });
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
          const reportedStarts = observed.items.filter(value => value.type === 'subAgentActivity' && value.kind === 'started'
            && typeof value.agentThreadId === 'string' && typeof value.agentPath === 'string')
            .map(value => ({ parentThreadId: dispatch.threadId, parentTurnId: dispatch.turnId,
              agentPath: value.agentPath, agentThreadId: value.agentThreadId, unadmitted: true }));
          if (observed.items.some(deniedShellTemporaryFile)) throw Object.assign(
            blocked('SANDBOX_COMMAND_DENIED: implicit temporary file denial'), { descendants: reportedStarts });
          for (const item of observed.items) {
            if (item.type !== 'subAgentActivity' || item.kind !== 'started') continue;
            const known = children.get(item.agentPath);
            if (known && known.agentThreadId !== item.agentThreadId) throw Object.assign(blocked('child identity changed'), {
              descendants: reportedStarts });
            if (!known) {
              let binding;
              try { binding = await bindAppServerChild(rpc, { parentThreadId: dispatch.threadId,
                parentTurnId: dispatch.turnId, agentPath: item.agentPath });
                await onChildStarted?.(binding); }
              catch (error) { throw Object.assign(error, { descendants: [...(error.descendants ?? []), ...reportedStarts] }); }
              children.set(item.agentPath, binding);
              await record({ type: 'native.child.started', binding });
            }
          }
          for (const item of observed.items) if (item.type === 'subAgentActivity' && item.kind === 'completed') {
            const binding = children.get(item.agentPath);
            if (!binding || binding.agentThreadId !== item.agentThreadId
              || observed.items.filter(value => value.type === 'subAgentActivity' && value.kind === 'completed'
                && value.agentPath === item.agentPath).length !== 1) throw blocked('unmatched/duplicate completed child identity');
          }
          if (observeFormalBinding !== null) {
            const rootCompleted = new Set(observed.items.filter(item => item.type === 'subAgentActivity' && item.kind === 'completed')
              .map(item => item.agentThreadId));
            const needsDesignation = [...children.values()].some(binding => !formal.has(binding.agentThreadId)
              && !auxiliaryDone.has(binding.agentThreadId)
              && (rootCompleted.has(binding.agentThreadId) || observed.turn.status !== 'inProgress'));
            const designation = needsDesignation ? await observeFormalBinding() : null;
            if (!designation && previousReady.length && formal.size === 0) {
              if (typeof validateRetainedCaptures !== 'function') throw blocked('retained formal verifier absent');
              const saved = [];
              for (const ready of previousReady) {
                const toolResult = JSON.parse(await fs.readFile(ready.toolResultFile, 'utf8'));
                if (!ready.designation || toolResult.agentId !== ready.binding.agentPath
                  || sha(toolResult.finalResponse) !== ready.finalResponseSha256) throw blocked('retained formal readiness differs');
                saved.push({ ...ready, toolResult });
              }
              await validateRetainedCaptures(saved);
              for (const ready of saved) formal.set(ready.binding.agentThreadId, ready.designation);
            }
            for (const binding of children.values()) {
              const designated = designation?.agentPath === binding.agentPath
                && binding.parentThreadId === dispatch.threadId && binding.parentTurnId === dispatch.turnId;
              if (observed.turn.status === 'inProgress' && !rootCompleted.has(binding.agentThreadId)
                && !designated && !views.has(binding.agentThreadId)) continue;
              const view = await observeAppServerChild(rpc, { binding, cwd: workspace,
                onTurns: turns => onChildTurns?.(binding, turns),
                onChild: async descendant => {
                const known = children.get(descendant.agentPath);
                if (known && (known.agentThreadId !== descendant.agentThreadId
                  || known.parentThreadId !== descendant.parentThreadId || known.parentTurnId !== descendant.parentTurnId)) throw blocked('descendant lineage changed');
                if (!known) {
                  if ([...children.values()].some(item => item.agentThreadId === descendant.agentThreadId)) throw blocked('child has duplicate lineage');
                  await onChildStarted?.(descendant); children.set(descendant.agentPath, descendant);
                  await record({ type: 'native.child.started', binding: descendant });
                }
              } });
              views.set(binding.agentThreadId, view);
              if (view.turns.some(item => ['failed', 'interrupted'].includes(item.status))) throw blocked('auxiliary turn failed/interrupted; preserve its effects');
              if (designated) {
                const previous = formal.get(binding.agentThreadId);
                if (previous && JSON.stringify(previous) !== JSON.stringify(designation)) throw blocked('formal designation changed');
                if (!previous) {
                  await onFormalObserved?.(binding, designation); formal.set(binding.agentThreadId, designation);
                  await record({ type: 'native.child.formal', binding, designation });
                }
              }
              if (formal.has(binding.agentThreadId) && view.turns.length && view.turns.every(item => item.status === 'completed')) {
                if (!captures.has(binding.agentPath)) await collect(binding);
              } else if (view.turns.length && view.turns.every(item => item.status === 'completed')) {
                const key = `${binding.agentThreadId}:${view.turns.map(item => item.id).join(',')}`;
                if (!notified.has(key)) {
                  await onAuxiliaryCompleted?.(binding); auxiliaryDone.add(binding.agentThreadId);
                  await record({ type: 'native.auxiliary.completed', binding, turns: view.turns }); notified.add(key);
                }
              }
            }
            if (observed.turn.status !== 'inProgress') {
              const complete = [...children.values()].every(binding => views.get(binding.agentThreadId)?.turns.length
                && views.get(binding.agentThreadId).turns.every(item => item.status === 'completed'));
              if (!complete) { await wait(pollMs, signal); continue; }
              terminalObserved = true;
              for (const binding of children.values()) if (!formal.has(binding.agentThreadId) && !auxiliaryDone.has(binding.agentThreadId)) {
                await onAuxiliaryCompleted?.(binding); auxiliaryDone.add(binding.agentThreadId);
                await record({ type: 'native.auxiliary.completed', binding, turns: views.get(binding.agentThreadId).turns });
              }
            }
          } else for (const item of observed.items) if (item.type === 'subAgentActivity' && item.kind === 'completed') {
            const binding = children.get(item.agentPath);
            if (!binding || binding.agentThreadId !== item.agentThreadId) throw blocked('unmatched completed child identity');
            if (observed.items.filter(value => value.type === 'subAgentActivity' && value.kind === 'completed'
              && value.agentPath === item.agentPath).length !== 1) throw blocked('duplicate completed child identity');
            if (!captures.has(item.agentPath)) await collect(binding);
          }
          if (observed.turn.status !== 'inProgress') break;
          await wait(pollMs, signal);
        }
        if (observed.turn.status !== 'completed' || observed.turn.error != null) throw blocked('parent turn failed/interrupted');
        // Also reobserve already captured children after the principal ends.
        // A changed/extra turn or modified envelope cannot replace the first.
        for (const binding of children.values()) if (observeFormalBinding === null || formal.has(binding.agentThreadId)) await collect(binding);
        if (new Set(previousReady.map(event => event.binding?.agentPath)).size !== previousReady.length
          || previousReady.some(event => !children.has(event.binding?.agentPath)
            || !captures.has(event.binding?.agentPath))) throw blocked('persisted child readiness is orphaned or duplicated');
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
        return { ...dispatch, completed: true, turnStarted: true, response: answer.text, terminalObserved,
          commandResults, captures: [...captures.values()], eventsPath: eventsFile, usage: null, toolCalls: null,
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
          captures: [...captures.values()], commandResults: [], eventsPath: eventsFile, error: error.message,
          errorCode: error.code ?? 'NATIVE_TRANSPORT_UNPROVEN', requestedModel: model, requestedEffort: effort,
          observation: dispatch, stderrSample, terminalObserved };
      } finally { clearTimeout(historyTimer); }
    },
    close() { connection?.close(); },
  };
}
