import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { connectAppServer, initializeAppServer, describeAppServerBundle, assertAppServerBundle,
  startAppServerTurn, readAppServerTurn, bindAppServerChild, readAppServerChild, writeNativeToolResult,
  deniedShellTemporaryFile, persistAppServerStderrSample, observeAppServerChild,
  nativeTransportError as blocked, nativeFailure, publicTurnStatus, publicTurnDiagnostic } from './app-server-transport.mjs';
import { appServerUsageObservations } from './usage-accounting.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', cancel); resolve(); }
  function cancel() { clearTimeout(timer); reject(blocked('native observation cancelled; dispatch may be active')); }
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
});

// Command output is a whitespace-delimited stream of complete JSON objects.
// Scan object boundaries so pretty-printed objects and multiple records are
// retained; any prose, malformed value, array, or partial tail invalidates the
// whole stream instead of letting a later object mask it.
export function parseStructuredCommandResults(output) {
  if (typeof output !== 'string') return [];
  const results = [];
  let cursor = 0;
  while (cursor < output.length) {
    while (/\s/u.test(output[cursor] ?? '') && cursor < output.length) cursor++;
    if (cursor === output.length) break;
    if (output[cursor] !== '{') return [];
    const start = cursor;
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (; cursor < output.length; cursor++) {
      const character = output[cursor];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}') {
        depth--;
        if (depth === 0) { end = cursor + 1; break; }
      }
    }
    if (end < 0) return [];
    let value;
    try { value = JSON.parse(output.slice(start, end)); } catch { return []; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    results.push(value);
    cursor = end;
    if (cursor < output.length && !/\s/u.test(output[cursor])) return [];
  }
  return results;
}

// One owned App Server per case, normal HOME. Tests inject only a fake public
// RPC object; importing/calling the observer with it never opens a real client.
export async function createNativeProvider({ snapshot, workspace, evidenceRoot, rpc = null, pollMs = 100 }) {
  let bundle,connection=null;
  let eventWrites=Promise.resolve(),measurementFile=null,measurementFailure=null,measurementUnavailableWritten=false;
  let pendingMeasurements=0;const measurementEvents=[],scopeFingerprints=new Set();
  const append=(file,event)=>{
    const writing=eventWrites.then(async()=>{
      await fs.appendFile(file,`${JSON.stringify(event)}\n`);
      if(event.type.startsWith('native.usage.')) {
        if(measurementEvents.length<16384)measurementEvents.push(event);
        else measurementFailure='measurement event bound exhausted';
      }
    });
    eventWrites=writing.catch(()=>{});return writing;
  };
  // Only this case's existing operation journals, never session directories.
  try {
    for(const name of (await fs.readdir(evidenceRoot)).filter(name=>/^[A-Za-z0-9][A-Za-z0-9_-]*\.events\.jsonl$/u.test(name)).sort()) {
      const file=path.join(evidenceRoot,name),info=await fs.lstat(file);
      if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024)throw new Error('invalid retained measurement file');
      for(const line of (await fs.readFile(file,'utf8')).split('\n').filter(Boolean)) {
        const event=JSON.parse(line);
        if(event?.type?.startsWith('native.usage.')) {
          if(measurementEvents.length>=16384)throw new Error('measurement event bound');
          measurementEvents.push(event);
        }
      }
    }
  } catch {measurementFailure='retained measurement history unavailable';}
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
  const subscription=rpc.observeMeasurements?.(notification=>{
    if(!measurementFile)return; // No admitted operation exists before the first journal.
    if(measurementEvents.length+pendingMeasurements>=16384){measurementFailure='measurement event bound exhausted';return;}
    if(++pendingMeasurements>1024){pendingMeasurements--;measurementFailure='measurement write bound exhausted';return;}
    const file=measurementFile;
    void append(file,{type:'native.usage.notification',observationId:randomUUID(),notification,observedAt:new Date().toISOString()})
      .catch(()=>{measurementFailure='measurement persistence unavailable';}).finally(()=>pendingMeasurements--);
  })??null;
  if(subscription===null)measurementFailure='measurement notification source unavailable';
  const flushMeasurements=async()=>{
    await eventWrites;
    if(subscription?.failed)measurementFailure='measurement observer unavailable';
    if(measurementFailure&&measurementFile&&!measurementUnavailableWritten) {
      measurementUnavailableWritten=true;
      try{await append(measurementFile,{type:'native.usage.unavailable',reason:measurementFailure});}catch{/* The caller retains the issue as well. */}
    }
  };
  const measured=async operationId=>{
    await flushMeasurements();const result=appServerUsageObservations(measurementEvents);
    if(measurementFailure)result.issues.push(measurementFailure);
    const selected=result.observations.filter(o=>o.operationId===operationId);
    return {usageObservation:selected.find(o=>o.source==='main')??{status:'unavailable',source:'main',delta:null,reason:'main usage scope unavailable'},
      runnerUsageObservations:selected.filter(o=>o.source==='runner'),usageIssues:[...new Set(result.issues)]};
  };
  return {
    bundle,
    async runTurn({ prompt, workflowSkill, model, effort, outputSchema, operationId, role,
      priorAuthorThread = null, signal, timeoutMs = 900_000, onChildStarted, onChildCompleted,
      onDispatched, onUnadmittedChildren, observation = null, observeFormalBinding = null,
      onChildTurns, onFormalObserved, onAuxiliaryCompleted, validateRetainedCaptures, onPrepareContinuation = null }) {
      const events=[],children=new Map(),captures=new Map();
      let eventsFile,previousEvents,previousReady;
      const continuations=new Map(),firstResponses=new Map(),continuationChecked=new Set(),initializationObservations=new Map();
      try {
        await assertAppServerBundle(bundle);
        if(typeof operationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(operationId))throw blocked('invalid operation evidence identity');
        eventsFile=path.join(evidenceRoot,`${operationId}.events.jsonl`);
        if(observation===null)await fs.writeFile(eventsFile,'',{flag:'wx',mode:0o600});else await fs.access(eventsFile);
        measurementFile=eventsFile;
        previousEvents=observation===null?[]:(await fs.readFile(eventsFile,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
        if(!previousEvents.every(event=>event&&typeof event==='object'&&!Array.isArray(event)))throw blocked('persisted observation event malformed');
        previousReady=previousEvents.filter(event=>event.type==='native.child.completed');
        for(const event of previousEvents.filter(event=>event.type==='native.child.continuation.admitted')) {
          if(continuations.has(event.binding.agentPath))throw blocked('duplicate continuation admission');
          continuations.set(event.binding.agentPath,event.grant);
          initializationObservations.set(event.binding.agentPath,event.initializationCommandFailures??[]);
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
        try { await append(eventsFile,event); }
        catch(error) { throw nativeFailure(error,'evidence'); }
      };
      const scope=async value=>{
        const fingerprint=JSON.stringify(value);
        if(!scopeFingerprints.has(fingerprint)){await record({type:'native.usage.scope',scope:value});scopeFingerprints.add(fingerprint);}
      };
      const childScopes=async(binding,view)=>{
        for(const [index,turn]of view.turns.entries()) {
          // parentBinding proves a unique started edge in this admitted turn;
          // the validated child metadata and explicit no-fork establish birth.
          // rootTurnId is not an immediate-parent identity or a usage baseline.
          const fresh=index===0&&view.provenance?.forkedFromId===null;
          await scope({source:'runner',threadId:binding.agentThreadId,turnId:turn.id,operationId,
            fresh,proof:fresh?'public-child-no-fork':'retained-thread',
            model: binding.model, effort: binding.effort,
            forkState: view.provenance?.forkState ?? 'absent',
            forkSourceMatchesParent: typeof view.provenance?.forkSourceMatchesParent === 'boolean' ? view.provenance.forkSourceMatchesParent : null,
            forkedFromId:view.provenance?.forkedFromId===null?null:'unknown'});
        }
      };
      // Pin each public result independently. A continuation never overwrites
      // the first file, even if both the API and a mutable file later drift.
      const captureKey=(binding,designation)=>designation?.clarification?`${binding.agentPath}:${designation.round}`:binding.agentPath;
      const readyFor=(binding,designation)=>previousReady.filter(e=>e.binding?.agentPath===binding.agentPath
        &&(e.designation?.round??null)===(designation?.round??null));
      const pin = async (binding,observed,file,map,prior=[],key=binding.agentPath) => {
        let capture=map.get(key);
        if(!capture&&prior.length) {
          if(prior.length!==1||prior[0].toolResultFile!==file
            ||Object.keys(binding).some(k=>prior[0].binding[k]!==binding[k]))throw blocked('persisted child readiness binding differs');
          const saved=JSON.parse(await fs.readFile(file,'utf8'));
          if(sha(saved.finalResponse)!==prior[0].finalResponseSha256)throw blocked('persisted first child envelope differs');
          capture={binding,file,toolResult:saved,finalResponseSha256:prior[0].finalResponseSha256,
            ...(prior[0].turnId?{turnId:prior[0].turnId}:{}),...(prior[0].designation?{designation:prior[0].designation}:{})};
        }
        if(capture&&JSON.stringify(capture.toolResult)!==JSON.stringify(observed))throw blocked('public child differs from first capture');
        const written=capture??await writeNativeToolResult(file,observed),meta=await fs.lstat(file);
        if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||await fs.realpath(file)!==file
          ||!(await fs.readFile(file)).equals(Buffer.from(JSON.stringify(observed)+'\n')))throw blocked('saved first child envelope absent/aliased/divergent');
        const result={...written,binding,toolResult:observed};map.set(key,result);return result;
      };
      const collect = async (binding,parentActive=false) => {
        try {
        const stem=path.join(evidenceRoot,`${operationId}.child-${sha(binding.agentPath).slice(7)}`);
        let grant=continuations.get(binding.agentPath)??null;
        const count=views.get(binding.agentThreadId)?.turns.length??1;
        const firstTurnId=views.get(binding.agentThreadId)?.turns[0]?.id;
        const designation=formal.get(binding.agentThreadId),clarification=designation?.clarification;
        const key=captureKey(binding,designation),priorCaptures=[];
        if(clarification) {
          let prior=captures.get(binding.agentPath);
          if(!prior) {
            const ready=previousReady.filter(e=>e.binding?.agentPath===binding.agentPath&&e.designation?.round===clarification.round);
            if(ready.length!==1)throw blocked('coverage clarification first capture is missing or ambiguous');
            prior=await pin(binding,JSON.parse(await fs.readFile(ready[0].toolResultFile,'utf8')),ready[0].toolResultFile,captures,ready);
          }
          if(clarification.agentId!==binding.agentPath||clarification.round!==designation.round-1
            ||prior.designation?.round!==clarification.round||prior.finalResponseSha256!==clarification.responseSha256
            ||['operationAttemptId','operationId','dispatchId'].some(field=>prior.designation?.[field]!==designation[field]))
            throw blocked('coverage clarification differs from the authenticated first capture');
          priorCaptures.push(prior);
        }
        const onInitializationObserved=failures=>{
          if(grant&&JSON.stringify(initializationObservations.get(binding.agentPath)??[])!==JSON.stringify(failures))
            throw blocked('initialization command observation differs from its admitted source');
          initializationObservations.set(binding.agentPath,structuredClone(failures));
        };
        const observeInitialization=()=>readAppServerChild(rpc,{binding,bundle,cwd:workspace,initialization:true,onInitializationObserved});
        if(grant) {
          const original=JSON.parse(grant.firstToolResultUtf8);
          const sourcePin=[{binding,toolResultFile:stem+'.json',finalResponseSha256:sha(original.finalResponse)}];
          const first=original; // The complete source is rechecked with the final two-turn capture.
          await pin(binding,first,stem+'.json',firstResponses,sourcePin);
          if(!(await fs.readFile(stem+'.json')).equals(Buffer.from(grant.firstToolResultUtf8)))throw blocked('continuation first bytes changed');
          if(!continuationChecked.has(binding.agentPath)) {
            if(!parentActive||typeof onPrepareContinuation!=='function')throw blocked('continuation cannot be readmitted after principal termination');
            const confirmed=await hook('onPrepareContinuation',onPrepareContinuation,{binding,toolResultFile:stem+'.json',firstTurnId:grant.firstTurnId,observeInitialization});
            if(JSON.stringify(confirmed)!==JSON.stringify(grant))throw blocked('persisted continuation differs from controller');
            continuationChecked.add(binding.agentPath);
          }
          if(count===1) {
            if(!parentActive)throw blocked('native continuation did not conclude');
            return;
          }
        }
        const observed=await readAppServerChild(rpc,{binding,bundle,cwd:workspace,continuation:grant,priorCaptures,onInitializationObserved});
        assertCurrent();
        if(!grant&&!clarification) {
          const original=await pin(binding,observed,stem+'.json',firstResponses,
            previousReady.filter(e=>e.binding?.agentPath===binding.agentPath));
          if(parentActive&&onPrepareContinuation!==null&&!captures.has(binding.agentPath)) {
            grant=await hook('onPrepareContinuation',onPrepareContinuation,{binding,toolResultFile:original.file,firstTurnId,observeInitialization});
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
                initializationCommandFailures:initializationObservations.get(binding.agentPath)??[],
                firstToolResultFile:original.file,firstTurnId,finalResponseSha256:original.finalResponseSha256});
              await hook('onChildCompleted',onChildCompleted,{binding,initialization:true,toolResult:observed,capture:original});
              return;
            }
          }
        }
        const file=stem+(clarification?`.round-${designation.round}.json`:grant?'.continued.json':'.json');
        const capture=await pin(binding,observed,file,captures,readyFor(binding,designation),key);
        capture.turnId=views.get(binding.agentThreadId)?.turns.at(-1)?.id;
        if(formal.has(binding.agentThreadId))capture.designation=formal.get(binding.agentThreadId);
        if(!notified.has(key)) {
          if(!readyFor(binding,designation).length)await record({type:'native.child.completed',binding,toolResultFile:file,turnId:capture.turnId,
            ...(capture.designation?{designation:capture.designation}:{}),finalResponseSha256:capture.finalResponseSha256});
          await hook('onChildCompleted',onChildCompleted,{binding,toolResult:observed,capture});notified.add(key);
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
        await scope({source:'main',threadId:dispatch.threadId,turnId:dispatch.turnId,operationId,
          fresh:dispatch.startedFreshThread===true,proof:dispatch.startedFreshThread===true?'thread/start':'retained-thread'});
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
              let designated = designation?.agentPath === binding.agentPath
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
              await childScopes(binding,view);
              let selectedDesignation=designated?designation:formal.get(binding.agentThreadId);
              const initialTurns=continuations.has(binding.agentPath)?2:1;
              if(selectedDesignation&&!selectedDesignation.clarification&&view.turns.length>initialTurns) {
                const next=await hook('observeFormalBinding',observeFormalBinding);
                if(next?.state==='pending'){formalPending=true;continue;}
                if(next?.agentPath!==binding.agentPath||next?.clarification?.round!==selectedDesignation.round
                  ||next.round!==selectedDesignation.round+1
                  ||['operationAttemptId','operationId','dispatchId'].some(field=>next[field]!==selectedDesignation[field]))
                  throw blocked('formal child has repeated completion or follow-up');
                selectedDesignation=next;designated=true;
              }
              const completions = observed.items.filter(item => item.type === 'subAgentActivity' && item.kind === 'completed'
                && item.agentPath === binding.agentPath).length;
              // Distinct completion items can describe distinct auxiliary
              // turns. They never relax the formal runner's single-turn rule.
              if (formal.has(binding.agentThreadId) || designated) {
                const grant=continuations.get(binding.agentPath);
                const clarification=selectedDesignation?.clarification;
                if(!clarification&&(!grant&&(completions>1||view.turns.length>1)||grant&&(view.turns.length>2
                  ||view.turns[0]?.id!==grant.firstTurnId||completions>view.turns.filter(t=>t.status==='completed').length))
                  ||clarification&&(view.turns.length!==initialTurns+1
                    ||completions>view.turns.filter(t=>t.status==='completed').length))
                  throw blocked('formal child has repeated completion or follow-up');
              } else if (completions > view.turns.filter(turn => turn.status === 'completed').length) {
                throw blocked('auxiliary completion count exceeds completed public turns');
              }
              const failedTurn=view.turns.find(item => ['failed','interrupted'].includes(item.status));
              if(failedTurn)throw blocked(`child turn failed/interrupted; preserve its effects (formal=${designated||formal.has(binding.agentThreadId)}; ${failedTurn.failure})`);
              if (designated) {
                const previous = formal.get(binding.agentThreadId);
                if (previous && JSON.stringify(previous) !== JSON.stringify(selectedDesignation)
                  &&!selectedDesignation.clarification) throw blocked('formal designation changed');
                if (!previous||JSON.stringify(previous)!==JSON.stringify(selectedDesignation)) {
                  await hook('onFormalObserved',value=>onFormalObserved?.(binding,value),
                    {...selectedDesignation,...(selectedDesignation.clarification?{turnId:view.turns.at(-1).id}:{})});
                  formal.set(binding.agentThreadId, selectedDesignation);
                  await record({ type: 'native.child.formal', binding, designation:selectedDesignation });
                }
              }
              if (formal.has(binding.agentThreadId) && view.turns.length && view.turns.every(item => item.status === 'completed')) {
                if (!captures.has(captureKey(binding,formal.get(binding.agentThreadId)))) await collect(binding,observed.turn.status==='inProgress');
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
        for (const binding of children.values()) if (observeFormalBinding === null || formal.has(binding.agentThreadId)) {
          views.set(binding.agentThreadId,await observeAppServerChild(rpc,{binding,cwd:workspace,
            onTurns:turns=>hook('onChildTurns',value=>onChildTurns?.(binding,value),turns)}));
          await childScopes(binding,views.get(binding.agentThreadId));
          await collect(binding);
        }
        if (new Set(previousReady.map(event => captureKey(event.binding,event.designation))).size !== previousReady.length
          || previousReady.some(event => !children.has(event.binding?.agentPath)
            || !captures.has(captureKey(event.binding,event.designation)))) throw blocked('persisted child readiness is orphaned or duplicated');
        const messages = observed.items.filter(item => item.type === 'agentMessage');
        const answer = messages.at(-1);
        if (!answer || ![null, undefined, 'final_answer'].includes(answer.phase)
          || typeof answer.text !== 'string') throw blocked('parent final response incomplete');
        const commandResults = [];
        for (const item of observed.items) if (item.type === 'commandExecution') {
          await record({ type: 'native.command.completed', item });
          if (item.status === 'completed' && item.exitCode === 0 && typeof item.aggregatedOutput === 'string') {
            commandResults.push(...parseStructuredCommandResults(item.aggregatedOutput));
          }
        }
        await assertAppServerBundle(bundle);
        assertCurrent();
        await record({ type: 'native.turn.completed', ...dispatch });
        assertCurrent();
        const usage=await measured(operationId);
        return { ...dispatch, completed: true, turnStarted: true, response: answer.text, terminalObserved,
          commandResults, captures: [...captures.values()], eventsPath: eventsFile, ...usage, usage: null, toolCalls: null,
          requestedModel: model, requestedEffort: effort, reportedModel: dispatch.runtimeConfiguration?.model ?? null,
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
        const usage=await measured(operationId);
        return { ...dispatch, threadId: dispatch?.threadId ?? null, completed: false,
          turnStarted: dispatchAttempted ? null : false, response: null, usage: null, toolCalls: null,
          ...usage,
          captures: [...captures.values()], commandResults: [], eventsPath: eventsFile, error: primary.message,
          errorCode: primary.code, requestedModel: model, requestedEffort: effort,
          observation: dispatch, stderrSample, terminalObserved,evidenceStatus,
          ...(secondaryFailures.length?{secondaryFailures}:{}) };
      } finally { clearTimeout(historyTimer); }
    },
    async close() { subscription?.close();await flushMeasurements();connection?.close();return {measurementIssue:measurementFailure}; },
  };
}
