import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connectAppServer, initializeAppServer, describeAppServerBundle, assertAppServerBundle,
  startAppServerTurn, readAppServerTurn, bindAppServerChild, readAppServerChild, writeNativeToolResult,
  deniedShellTemporaryFile, persistAppServerStderrSample, observeAppServerChild,
  nativeTransportError as blocked, nativeFailure, publicTurnStatus, publicTurnDiagnostic } from './app-server-transport.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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
  let bundle,connection=null;
  try {
    bundle=await describeAppServerBundle({skillsRoot:path.join(snapshot,'skills/workflows'),
      runnerFile:path.join(snapshot,'agents/codex/.codex/agents/stnl_validation_runner.toml')});
    if(rpc===null) {
      if(process.env.STNL_OFFLINE_PROVIDER_CONTEXT!==undefined||process.env.NODE_TEST_CONTEXT!==undefined)
        throw blocked('an explicit offline App Server provider is required for this fixture');
      const cliLauncher=path.join(snapshot,'agents/codex/node_modules/@openai/codex/bin/codex.js');
      connection=await connectAppServer({cliLauncher,cliSha256:sha(await fs.readFile(cliLauncher)),cwd:workspace});rpc=connection.rpc;
    }
    await initializeAppServer(rpc);
  } catch(error) {
    const primary=nativeFailure(error,'setup');
    const stderrSample=await persistAppServerStderrSample(rpc??{},evidenceRoot);
    if(stderrSample!==null)primary.stderrSample=stderrSample;
    try { connection?.close(); } catch(secondary) { const safe=nativeFailure(secondary,'process');primary.cleanupFailure={code:safe.code,message:safe.message}; }
    throw primary;
  }
  return {
    bundle,
    async runTurn({ prompt, workflowSkill, model, effort, outputSchema, operationId, role,
      priorAuthorThread = null, signal, timeoutMs = 900_000, onChildStarted, onChildCompleted,
      onDispatched, onUnadmittedChildren, observation = null, observeFormalBinding = null,
      onChildTurns, onFormalObserved, onAuxiliaryCompleted, validateRetainedCaptures, onPrepareContinuation = null }) {
      const events=[],children=new Map(),captures=new Map();
      let eventsFile,previousEvents,previousReady;
      const continuations=new Map(),firstResponses=new Map(),continuationChecked=new Set();
      try {
        await assertAppServerBundle(bundle);
        if(typeof operationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(operationId))throw blocked('invalid operation evidence identity');
        eventsFile=path.join(evidenceRoot,`${operationId}.events.jsonl`);
        if(observation===null)await fs.writeFile(eventsFile,'',{flag:'wx'});else await fs.access(eventsFile);
        previousEvents=observation===null?[]:(await fs.readFile(eventsFile,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        if(!previousEvents.every(event=>event&&typeof event==='object'&&!Array.isArray(event)))throw blocked('persisted observation event malformed');
        previousReady=previousEvents.filter(event=>event.type==='native.child.completed');
        for(const event of previousEvents.filter(event=>event.type==='native.child.continuation.admitted')) {
          if(continuations.has(event.binding.agentPath))throw blocked('duplicate continuation admission');
          continuations.set(event.binding.agentPath,event.grant);
        }
      } catch(error) { throw nativeFailure(error,'prepare'); }
      const notified = new Set();
      const formal = new Map(), views = new Map(), auxiliaryDone = new Set();
      let terminalObserved = false;
      let dispatch = null, dispatchAttempted = false, historyTimer = null;
      const assertCurrent = () => {
        if(signal?.aborted)throw blocked('native observation cancelled; dispatch may be active');
        if(dispatch&&Date.now()>dispatch.deadlineAt)throw blocked('observation deadline exceeded; started turn is uncertain');
      };
      const hook = async (name,callback,value) => {
        let result;
        try { result=await callback?.(value); }
        catch(error) { throw nativeFailure(error,name); }
        // Dispatch accounting must finish first; its initial-history window is
        // checked immediately below before any observation can start.
        if(name!=='onDispatched')assertCurrent();return result;
      };
      const record = async event => {
        events.push(event);
        try { await fs.appendFile(eventsFile, `${JSON.stringify(event)}\n`); }
        catch(error) { throw nativeFailure(error,'evidence'); }
      };
      // Pin each public result independently. A continuation never overwrites
      // the first file, even if both the API and a mutable file later drift.
      const pin = async (binding,observed,file,map,prior=[]) => {
        let capture=map.get(binding.agentPath);
        if(!capture&&prior.length) {
          if(prior.length!==1||prior[0].toolResultFile!==file
            ||Object.keys(binding).some(k=>prior[0].binding[k]!==binding[k]))throw blocked('persisted child readiness binding differs');
          const saved=JSON.parse(await fs.readFile(file,'utf8'));
          if(sha(saved.finalResponse)!==prior[0].finalResponseSha256)throw blocked('persisted first child envelope differs');
          capture={binding,file,toolResult:saved,finalResponseSha256:prior[0].finalResponseSha256};
        }
        if(capture&&JSON.stringify(capture.toolResult)!==JSON.stringify(observed))throw blocked('public child differs from first capture');
        const written=capture??await writeNativeToolResult(file,observed),meta=await fs.lstat(file);
        if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||await fs.realpath(file)!==file
          ||!(await fs.readFile(file)).equals(Buffer.from(JSON.stringify(observed)+'\n')))throw blocked('saved first child envelope absent/aliased/divergent');
        const result={...written,binding,toolResult:observed};map.set(binding.agentPath,result);return result;
      };
      const collect = async (binding,parentActive=false) => {
        try {
        const stem=path.join(evidenceRoot,`${operationId}.child-${sha(binding.agentPath).slice(7)}`);
        let grant=continuations.get(binding.agentPath)??null;
        const count=views.get(binding.agentThreadId)?.turns.length??1;
        const firstTurnId=views.get(binding.agentThreadId)?.turns[0]?.id;
        const validateInitialization=()=>readAppServerChild(rpc,{binding,bundle,cwd:workspace,initialization:true});
        if(grant) {
          const original=JSON.parse(grant.firstToolResultUtf8);
          const sourcePin=[{binding,toolResultFile:stem+'.json',finalResponseSha256:sha(original.finalResponse)}];
          const first=original; // The complete source is rechecked with the final two-turn capture.
          await pin(binding,first,stem+'.json',firstResponses,sourcePin);
          if(!(await fs.readFile(stem+'.json')).equals(Buffer.from(grant.firstToolResultUtf8)))throw blocked('continuation first bytes changed');
          if(!continuationChecked.has(binding.agentPath)) {
            if(!parentActive||typeof onPrepareContinuation!=='function')throw blocked('continuation cannot be readmitted after principal termination');
            const confirmed=await hook('onPrepareContinuation',onPrepareContinuation,{binding,toolResultFile:stem+'.json',firstTurnId:grant.firstTurnId,validateInitialization});
            if(JSON.stringify(confirmed)!==JSON.stringify(grant))throw blocked('persisted continuation differs from controller');
            continuationChecked.add(binding.agentPath);
          }
          if(count===1) {
            if(!parentActive)throw blocked('native continuation did not conclude');
            return;
          }
        }
        const observed=await readAppServerChild(rpc,{binding,bundle,cwd:workspace,continuation:grant});
        assertCurrent();
        if(!grant) {
          const original=await pin(binding,observed,stem+'.json',firstResponses,
            previousReady.filter(e=>e.binding?.agentPath===binding.agentPath));
          if(parentActive&&onPrepareContinuation!==null&&!captures.has(binding.agentPath)) {
            grant=await hook('onPrepareContinuation',onPrepareContinuation,{binding,toolResultFile:original.file,firstTurnId,validateInitialization});
            if(grant) {
              // Admission may have raced a long read/checkpoint with termination.
              // Keep the controller's grant, but expose no permission after the
              // original principal/deadline is no longer observable as active.
              if(signal?.aborted||Date.now()>dispatch.deadlineAt)
                throw blocked('continuation admission exceeded the original principal deadline');
              const principal=await readAppServerTurn(rpc,{...dispatch,cwd:workspace});
              if(principal.turn.status!=='inProgress'||principal.turn.error!=null
                ||signal?.aborted||Date.now()>dispatch.deadlineAt)
                throw blocked('continuation principal ended before permission publication');
              continuations.set(binding.agentPath,grant);continuationChecked.add(binding.agentPath);
              await record({type:'native.child.continuation.admitted',binding,grant,
                firstToolResultFile:original.file,firstTurnId,finalResponseSha256:original.finalResponseSha256});
              await hook('onChildCompleted',onChildCompleted,{binding,initialization:true,toolResult:observed,capture:original});
              return;
            }
          }
        }
        const file=stem+(grant?'.continued.json':'.json');
        const capture=await pin(binding,observed,file,captures,previousReady.filter(e=>e.binding?.agentPath===binding.agentPath));
        if(formal.has(binding.agentThreadId))capture.designation=formal.get(binding.agentThreadId);
        if(!notified.has(binding.agentPath)) {
          if(!previousReady.some(e=>e.binding?.agentPath===binding.agentPath))await record({type:'native.child.completed',binding,toolResultFile:file,
            ...(capture.designation?{designation:capture.designation}:{}),finalResponseSha256:capture.finalResponseSha256});
          await hook('onChildCompleted',onChildCompleted,{binding,toolResult:observed,capture});notified.add(binding.agentPath);
        }
        } catch(error) { throw nativeFailure(error,'capture'); }
      };
      try {
        if (role !== 'author' && priorAuthorThread !== null) throw blocked('review context cannot inherit author history');
        if (observation !== null && (!Number.isSafeInteger(observation.deadlineAt) || observation.deadlineAt < 1))
          throw blocked('persisted observation has no proven original deadline');
        dispatchAttempted = true;
        dispatch = observation ?? await startAppServerTurn(rpc, { bundle, cwd: workspace, skillName: workflowSkill,
          prompt, model, effort, outputSchema, threadId: priorAuthorThread?.threadId ?? null,
          // Explicit null inherits the normal client's configured permissions.
          // The benchmark never silently enables Full Access/never.
          admittedAuthorThread: priorAuthorThread, approvalPolicy: null, sandbox: null });
        dispatch={...dispatch,deadlineAt:observation===null?Date.now()+timeoutMs:observation.deadlineAt};
        const acknowledgedAt = Date.now();
        const historyDeadlineAt = observation === null && priorAuthorThread === null
          ? acknowledgedAt + Math.min(30_000, timeoutMs) : null;
        await hook('onDispatched',onDispatched,dispatch);
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
          assertCurrent();
          if (!historyObserved && historyDeadlineAt !== null && Date.now() >= historyDeadlineAt) {
            throw blocked('initial public history observation deadline exceeded; dispatch remains uncertain');
          }
          try {
            const reading = readAppServerTurn(rpc, { ...dispatch, cwd: workspace });
            observed = await (!historyObserved && historyDeadline ? Promise.race([reading, historyDeadline]) : reading);
          } catch (error) {
            error=nativeFailure(error);
            if (historyObserved || !historyDeadline || error.initialHistoryUnavailable !== true) throw error;
            if (!pendingRecorded) {
              await record({ type: 'native.history.pending', ...dispatch, message: error.message });
              pendingRecorded = true;
            }
            await Promise.race([wait(pollMs, signal), historyDeadline]);
            continue;
          }
          assertCurrent();
          if (!historyObserved && historyDeadlineAt !== null && Date.now() >= historyDeadlineAt) {
            throw blocked('initial public history observation deadline exceeded; dispatch remains uncertain');
          }
          if (['absent','other'].includes(publicTurnStatus(observed.turn.status)))
            throw blocked(`parent turn status unproven (${publicTurnDiagnostic(observed.turn)})`);
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
                await hook('onChildStarted',onChildStarted,binding); }
              catch (error) { const safe=nativeFailure(error);
                throw Object.assign(safe,{descendants:[...(safe.descendants??[]),...reportedStarts]}); }
              children.set(item.agentPath, binding);
              await record({ type: 'native.child.started', binding });
            }
          }
          for (const item of observed.items) if (item.type === 'subAgentActivity' && item.kind === 'completed') {
            const binding = children.get(item.agentPath);
            if (!binding || binding.agentThreadId !== item.agentThreadId) throw blocked('unmatched completed child identity');
          }
          let formalPending = false;
          if (observeFormalBinding !== null) {
            const rootCompleted = new Set(observed.items.filter(item => item.type === 'subAgentActivity' && item.kind === 'completed')
              .map(item => item.agentThreadId));
            const needsDesignation = [...children.values()].some(binding => !formal.has(binding.agentThreadId)
              && !auxiliaryDone.has(binding.agentThreadId)
              && (rootCompleted.has(binding.agentThreadId) || observed.turn.status !== 'inProgress'));
            const formalObservation = needsDesignation ? await hook('observeFormalBinding',observeFormalBinding) : null;
            formalPending = formalObservation?.state === 'pending';
            if (formalPending && Object.keys(formalObservation).length !== 1)
              throw blocked('pending formal observation is malformed');
            if (formalObservation !== null && !formalPending
              && (!formalObservation || typeof formalObservation !== 'object' || Array.isArray(formalObservation)
                || Object.hasOwn(formalObservation, 'state') || typeof formalObservation.agentPath !== 'string'
                || !formalObservation.agentPath)) throw blocked('formal designation identity absent or malformed');
            const designation = formalPending ? null : formalObservation;
            if (designation && ![...children.values()].some(binding => binding.agentPath === designation.agentPath
              && binding.parentThreadId === dispatch.threadId && binding.parentTurnId === dispatch.turnId))
              throw blocked('formal designation does not match an observed child');
            if (!formalPending && !designation && previousReady.length && formal.size === 0) {
              if (typeof validateRetainedCaptures !== 'function') throw blocked('retained formal verifier absent');
              const saved = [];
              for (const ready of previousReady) {
                const toolResult = JSON.parse(await fs.readFile(ready.toolResultFile, 'utf8'));
                if (!ready.designation || toolResult.agentId !== ready.binding.agentPath
                  || sha(toolResult.finalResponse) !== ready.finalResponseSha256) throw blocked('retained formal readiness differs');
                saved.push({ ...ready, toolResult });
              }
              await hook('validateRetainedCaptures',validateRetainedCaptures,saved);
              for (const ready of saved) {formal.set(ready.binding.agentThreadId, ready.designation);
                if(ready.toolResult.preVerificationContinuation)continuationChecked.add(ready.binding.agentPath);}
            }
            for (const binding of children.values()) {
              const designated = designation?.agentPath === binding.agentPath
                && binding.parentThreadId === dispatch.threadId && binding.parentTurnId === dispatch.turnId;
              if (observed.turn.status === 'inProgress' && !rootCompleted.has(binding.agentThreadId)
                && !designated && !views.has(binding.agentThreadId)) continue;
              const view = await observeAppServerChild(rpc, { binding, cwd: workspace,
                onTurns: turns => hook('onChildTurns',value=>onChildTurns?.(binding,value),turns),
                onChild: async descendant => {
                const known = children.get(descendant.agentPath);
                if (known && (known.agentThreadId !== descendant.agentThreadId
                  || known.parentThreadId !== descendant.parentThreadId || known.parentTurnId !== descendant.parentTurnId)) throw blocked('descendant lineage changed');
                if (!known) {
                  if ([...children.values()].some(item => item.agentThreadId === descendant.agentThreadId)) throw blocked('child has duplicate lineage');
                  await hook('onChildStarted',onChildStarted,descendant); children.set(descendant.agentPath, descendant);
                  await record({ type: 'native.child.started', binding: descendant });
                }
              } });
              assertCurrent();
              views.set(binding.agentThreadId, view);
              const completions = observed.items.filter(item => item.type === 'subAgentActivity' && item.kind === 'completed'
                && item.agentPath === binding.agentPath).length;
              // Distinct completion items can describe distinct auxiliary
              // turns. They never relax the formal runner's single-turn rule.
              if (formal.has(binding.agentThreadId) || designated) {
                const grant=continuations.get(binding.agentPath);
                if(!grant&&(completions>1||view.turns.length>1)||grant&&(view.turns.length>2
                  ||view.turns[0]?.id!==grant.firstTurnId||completions>view.turns.filter(t=>t.status==='completed').length))
                  throw blocked('formal child has repeated completion or follow-up');
              } else if (completions > view.turns.filter(turn => turn.status === 'completed').length) {
                throw blocked('auxiliary completion count exceeds completed public turns');
              }
              const failedTurn=view.turns.find(item => ['failed','interrupted'].includes(item.status));
              if(failedTurn)throw blocked(`child turn failed/interrupted; preserve its effects (formal=${designated||formal.has(binding.agentThreadId)}; ${failedTurn.failure})`);
              if (designated) {
                const previous = formal.get(binding.agentThreadId);
                if (previous && JSON.stringify(previous) !== JSON.stringify(designation)) throw blocked('formal designation changed');
                if (!previous) {
                  await hook('onFormalObserved',value=>onFormalObserved?.(binding,value),designation); formal.set(binding.agentThreadId, designation);
                  await record({ type: 'native.child.formal', binding, designation });
                }
              }
              if (formal.has(binding.agentThreadId) && view.turns.length && view.turns.every(item => item.status === 'completed')) {
                if (!captures.has(binding.agentPath)) await collect(binding,observed.turn.status==='inProgress');
              } else if (!formalPending && view.turns.length && view.turns.every(item => item.status === 'completed')) {
                const key = `${binding.agentThreadId}:${view.turns.map(item => item.id).join(',')}`;
                if (!notified.has(key)) {
                  await hook('onAuxiliaryCompleted',onAuxiliaryCompleted,binding); auxiliaryDone.add(binding.agentThreadId);
                  await record({ type: 'native.auxiliary.completed', binding, turns: view.turns }); notified.add(key);
                }
              }
            }
            if (observed.turn.status !== 'inProgress') {
              const complete = [...children.values()].every(binding => views.get(binding.agentThreadId)?.turns.length
                && views.get(binding.agentThreadId).turns.every(item => item.status === 'completed'));
              if (!complete || formalPending) { await wait(pollMs, signal); continue; }
              terminalObserved = true;
              for (const binding of children.values()) if (!formal.has(binding.agentThreadId) && !auxiliaryDone.has(binding.agentThreadId)) {
                await hook('onAuxiliaryCompleted',onAuxiliaryCompleted,binding); auxiliaryDone.add(binding.agentThreadId);
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
          if (observed.turn.status !== 'inProgress' && !formalPending) break;
          await wait(pollMs, signal);
        }
        if (observed.turn.status !== 'completed' || observed.turn.error != null)
          throw blocked(`parent turn failed/interrupted (${publicTurnDiagnostic(observed.turn)})`);
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
        assertCurrent();
        await record({ type: 'native.turn.completed', ...dispatch });
        assertCurrent();
        return { ...dispatch, completed: true, turnStarted: true, response: answer.text, terminalObserved,
          commandResults, captures: [...captures.values()], eventsPath: eventsFile, usage: null, toolCalls: null,
          requestedModel: model, requestedEffort: effort, reportedModel: null,
          authorThread: role === 'author' ? { threadId: dispatch.threadId, cwd: workspace,
            bundleSha256: sha(Buffer.from(JSON.stringify(bundle))), role: 'author' } : null };
      } catch (error) {
        clearTimeout(historyTimer); historyTimer = null;
        const primary=nativeFailure(error,'operation'),secondaryFailures=[];
        if (error?.descendants?.length)try { await onUnadmittedChildren?.(error.descendants); }
        catch(secondary) { const safe=nativeFailure(secondary,'onUnadmittedChildren');
          secondaryFailures.push({stage:'onUnadmittedChildren',code:safe.code,message:safe.message}); }
        const stderrSample = await persistAppServerStderrSample(rpc, evidenceRoot);
        let evidenceStatus='retained';
        try { await record({ type: 'native.transport.blocked', code: primary.code,
          message: primary.message, dispatch, dispatchAttempted, stderrSample,
          ...(secondaryFailures.length?{secondaryFailures}:{}) }); }
        catch(secondary) { const safe=nativeFailure(secondary,'evidence');evidenceStatus='unavailable';
          secondaryFailures.push({stage:'evidence',code:safe.code,message:safe.message}); }
        return { ...dispatch, threadId: dispatch?.threadId ?? null, completed: false,
          turnStarted: dispatchAttempted ? null : false, response: null, usage: null, toolCalls: null,
          captures: [...captures.values()], commandResults: [], eventsPath: eventsFile, error: primary.message,
          errorCode: primary.code, requestedModel: model, requestedEffort: effort,
          observation: dispatch, stderrSample, terminalObserved,evidenceStatus,
          ...(secondaryFailures.length?{secondaryFailures}:{}) };
      } finally { clearTimeout(historyTimer); }
    },
    close() { connection?.close(); },
  };
}
