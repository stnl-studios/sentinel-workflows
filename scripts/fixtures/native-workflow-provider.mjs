// OFFLINE_TEST_ONLY. Scripted authors/judges through the real public producers;
// these outcomes do not attest semantic model quality or native transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initialArtifacts, REQUIREMENTS } from './current-initial-preparation.mjs';
import { payload } from './current-initial-evidence.mjs';
import { applyPayload } from './current-findings-evidence.mjs';
import { publishCandidate } from '../../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import { preparePreparationCandidate } from '../../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import { publishPreparationCandidate } from '../../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import { inspectCurrentExecution } from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import { begin, normalizeSuccessor, reserveDispatch, bindNative, verifyNative, captureNative, publish } from
  '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkSource = `import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {runCli} from './cli.mjs';
test('AC-001 list filters preserve storage',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-list-'));try{
const store=path.join(root,'todos.json');await fs.writeFile(store,JSON.stringify({todos:[{id:1,title:'a',completed:true},{id:2,title:'b',completed:false}]}));
const before=await fs.readFile(store);let out='';const code=await runCli(['--store',store,'list','--completed'],{stdout:{write:s=>{out+=s;}},stderr:{write:()=>{}}});
assert.equal(code,0);assert.deepEqual(out.trim().split('\\n').map(JSON.parse).map(x=>x.id),[1]);assert.ok(before.equals(await fs.readFile(store)));
}finally{await fs.rm(root,{recursive:true,force:true});}});\n`;

export function offlineNativeWorkflow({ workspace, caseRoot, snapshot, fault = null }) {
  const threads = new Map(), calls = [], operations = [];
  const automatic = ['automatic-capture', 'formal-successor', 'formal-exhausted'].includes(fault);
  let interrupted = false;
  let preparation = null;
  function command(items, result) { items.push({ id: randomUUID(), type: 'commandExecution', status: 'completed',
    exitCode: 0, aggregatedOutput: JSON.stringify(result) }); }
  async function authored(operation, prompt, thread, turn) {
    const specPath = /^SPEC_PATH=(.*)$/mu.exec(prompt)?.[1];
    if (!specPath) throw new Error('fixture requires the real launcher SPEC_PATH');
    operations.push({ operation, threadId: thread.id, specPath });
    if (operation === 'SPEC_INIT') {
      const candidate = path.join(caseRoot, 'candidates/spec-draft');
      async function author(source, target) {
        await fs.mkdir(target);
        for (const entry of await fs.readdir(source, { withFileTypes: true })) {
          if (entry.isDirectory()) await author(path.join(source, entry.name), path.join(target, entry.name));
          else await fs.writeFile(path.join(target, entry.name), await fs.readFile(path.join(source, entry.name)));
        }
      }
      // Normal authoring renders writable content; frozen template modes are
      // not an input to mutable lifecycle staging (particularly on Darwin).
      await author(path.join(snapshot, 'skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready'), candidate);
      command(turn.items, await publishCandidate('INIT', specPath, candidate));
    } else if (operation === 'PLAN') {
      const allocated = await preparePreparationCandidate({ specPath, operation: 'PLAN' });
      const current = await inspectCurrentExecution(specPath);
      for (const [name, bytes] of initialArtifacts({ form: 'lifecycle' })) {
        if (name.includes('slice-02')) continue;
        let text = bytes.toString().replaceAll(REQUIREMENTS, current.requirementsAuthority)
          .replaceAll(/- Delivery ID: [^\n]+/gu, '- Delivery ID: runtime')
          .replaceAll('contribution: partial | full owner: slice-02', 'contribution: complete | full owner: slice-01')
          .replaceAll('../../../../src/pay.test.mjs', '../../../../src/native-filter.test.mjs');
        text = text.split('\n').filter(line => !line.includes('| 02 - Verification |')).join('\n');
        const destination = path.join(allocated.candidateExecutionRoot, name);
        await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, text);
      }
      preparation = await publishPreparationCandidate({ specPath, candidateExecutionRoot: allocated.candidateExecutionRoot });
      command(turn.items, preparation);
    } else if (operation === 'REVIEW_PLAN') {
      if (!prompt.includes(`CANDIDATE_EXECUTION_ROOT=${preparation.candidateExecutionRoot}`)) throw new Error('fixture root was not passed to the independent review');
      const { projectInitialPreparation } = await import('../../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs');
      const { resolveCurrentExecutionContext } = await import('../../skills/workflows/stnl-execution-planner/runtime/execution-workspace.mjs');
      const artifacts = new Map();
      for (const name of ['plan.md', 'tasks.md', 'plans/slice-01.md', 'tasks/slice-01.md']) artifacts.set(name,
        await fs.readFile(path.join(preparation.candidateExecutionRoot, name)));
      const current = await inspectCurrentExecution(specPath), { context } = await resolveCurrentExecutionContext(specPath);
      const projected = projectInitialPreparation({ context, requirementsAuthority: current.requirementsAuthority, artifacts });
      const hashes = new Map(projected.artifactHashes.map(item => [item.path, item.sha256]));
      const decision = (scope, hash, names) => ({ scope, decision: 'approved', authoritySha256: hash,
        examinedArtifactHashes: names.sort().map(name => ({ path: name, sha256: hashes.get(name) })),
        evidenceDecisions: [], summary: 'OFFLINE mechanical authored review, not model proof.' });
      const review = { globalReview: decision('set', projected.globalReviewAuthoritySha256, ['plan.md', 'tasks.md']),
        deliveries: projected.deliveries.map(item => ({ deliveryId: item.deliveryId,
          review: decision('slice', item.authoritySha256, [`plans/${item.slice}.md`, `tasks/${item.slice}.md`]) })) };
      command(turn.items, await publishPreparationCandidate({ specPath, candidateExecutionRoot: preparation.candidateExecutionRoot, reviewDecision: review }));
    } else if (['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS'].includes(operation)) {
      const current = await inspectCurrentExecution(specPath);
      let admitted = await begin({ specPath, operation, slice: 'slice-01', expectedActivationId: current.activationId });
      if (operation === 'VALIDATE_SLICE' && !prompt.includes('Solicito validação integral terminal')) {
        throw new Error('fixture requires the same explicit integral request as the normal author');
      }
      if (!prompt.includes('Select model=gpt-6-luna and reasoning_effort=medium explicitly')
        || (operation !== 'VALIDATE_SLICE' && !prompt.includes('before delegating read-only verification'))) throw new Error('generic profile/work-order context missing');
      let dispatch = await reserveDispatch(admitted.handle, { responseVariant: 'stnl-current-native-judgment-v1',
        ...(operation === 'VALIDATE_SLICE' ? { terminal: true } : {}) });
      if (operation === 'EXECUTE_SLICE' && fault !== 'premature-verification') {
        await fs.copyFile(path.join(repo, 'scripts/fixtures/filtered-cli.mjs'), path.join(workspace, 'src/cli.mjs'));
        await fs.writeFile(path.join(workspace, 'src/native-filter.test.mjs'), checkSource);
        if (fault === 'findings-cycle') {
          const file = path.join(workspace, 'src/cli.mjs');
          const original = await fs.readFile(file, 'utf8');
          if (!original.includes('todo.completed === false')) throw new Error('offline mutant did not reach its pending branch');
          await fs.writeFile(file, original.replace('todo.completed === false', 'todo.completed === true'));
        }
      } else if (operation === 'APPLY_FINDINGS') {
        await fs.copyFile(path.join(repo, 'scripts/fixtures/filtered-cli.mjs'), path.join(workspace, 'src/cli.mjs'));
        await fs.writeFile(path.join(workspace, 'src/native-filter.test.mjs'), checkSource.replace("assert.equal(code,0);", "let pending='';assert.equal(await runCli(['--store',store,'list','--pending'],{stdout:{write:s=>{pending+=s;}},stderr:{write:()=>{}}}),0);assert.deepEqual(pending.trim().split('\\n').map(JSON.parse).map(x=>x.id),[2]);assert.equal(code,0);"));
      }
      const formalRounds = operation === 'VALIDATE_SLICE' && ['formal-successor','formal-exhausted'].includes(fault) ? 2 : 1;
      for(let formalRound=0;formalRound<formalRounds;formalRound++){
      if(formalRound){const next=await inspectCurrentExecution(specPath);
        admitted=await normalizeSuccessor({specPath,operation,slice:'slice-01',expectedActivationId:next.activationId});
        dispatch=await reserveDispatch(admitted.handle,{responseVariant:'stnl-current-native-judgment-v1',terminal:true});}
      const agentPath = `/root/check-${randomUUID()}`, childId = randomUUID();
      const child = { id: childId, cwd: workspace, cliVersion: '0.163.0', historyMode: 'paginated', parentThreadId: thread.id,
        forkedFromId: null, agentRole: 'default', model: 'gpt-6-luna', reasoningEffort: 'medium', turns: [] };
      threads.set(childId, child);
      turn.items.push({ id: randomUUID(), type: 'subAgentActivity', kind: 'started', agentPath,
        agentThreadId: childId, model: 'gpt-6-luna', reasoningEffort: 'medium' });
      await bindNative(admitted.handle, agentPath);
      const measured = await verifyNative(dispatch.originFile);
      const needsFix = fault === 'findings-cycle' && operation === 'VALIDATE_SLICE'
        && operations.filter(item => item.operation === 'VALIDATE_SLICE').length === 1;
      const corrected = fault === 'findings-cycle' && operation === 'VALIDATE_SLICE' && !needsFix;
      const result = operation === 'EXECUTE_SLICE' ? (({ head, ...rest }) => rest)(payload(1))
        : operation === 'APPLY_FINDINGS' ? (({ head, ...rest }) => rest)(applyPayload(1, 'TESTS_PASS', 0))
        : { status: 'PASS', commands: measured.commands, evidence: 'OFFLINE semantic judgment fixture only.',
          findingReferences: needsFix || corrected ? 'finding-01' : 'none', findingDispositions: needsFix ? 'finding-01=active' : corrected ? 'finding-01=resolved' : 'none', blockers: 'none',
          unexpectedWorkspaceEffects: 'none', persistenceSummary: 'No runner edits.' };
      result.commands = measured.commands;
      if (needsFix) result.status = 'NEEDS_FIX';
      const findings = needsFix ? [{ id: 'finding-01', originAttempt: JSON.parse(await fs.readFile(dispatch.requestFile)).attemptId,
        severity: 'blocking', problem: 'Pending filter selects completed records.', evidence: 'The pending branch uses todo.completed.',
        impact: 'Case A pending list requirement is unmet.', relatedAuthority: 'AC-001; obligation-01', expectedCorrection: 'Select incomplete records and assert pending output.' }] : [];
      const invalid = formalRounds===2 && (formalRound===0 || fault==='formal-exhausted');
      const text = JSON.stringify({ format: 'stnl-current-native-judgment-v1', result,
        ...(operation === 'VALIDATE_SLICE' && !invalid ? { newFindings: findings } : {}) })
        +(invalid?'\nCanonical task identity: `'+agentPath+'`':'');
      child.turns.push({ id: randomUUID(), status: 'completed', error: null, itemsView: 'full',
        items: [{ id: randomUUID(), type: 'commandExecution', command: `cat -- '${path.join(snapshot, 'agents/codex/.codex/agents/stnl_validation_runner.toml').replaceAll("'", "'\\''")}'`, cwd: workspace, status: 'completed', exitCode: 0, aggregatedOutput: await fs.readFile(path.join(snapshot, 'agents/codex/.codex/agents/stnl_validation_runner.toml'), 'utf8') }, { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text }] });
      if (fault === 'grandchildren' && operation === 'EXECUTE_SLICE') child.turns[0].items.push(...[1, 2].map(index => ({
        id: randomUUID(), type: 'subAgentActivity', kind: 'started', agentPath: `${agentPath}/extra-${index}`, agentThreadId: randomUUID() })));
      let file = path.join(caseRoot, `${operation}.normal-tool-result.json`);
      if(automatic){
        turn.items.push({id:randomUUID(),type:'subAgentActivity',kind:'completed',agentPath,agentThreadId:childId});
        const eventPath=/record in (.+?); match binding\.agentPath/u.exec(prompt)?.[1];
        if(!eventPath)throw Error('public transport ready-event path missing');
        const deadline=Date.now()+10_000;let ready;
        while(!ready && Date.now()<deadline){const raw=await fs.readFile(eventPath,'utf8');
          ready=raw.split('\n').slice(0,-1).map(JSON.parse).find(e=>e.type==='native.child.completed'&&e.binding.agentPath===agentPath);
          if(!ready)await new Promise(resolve=>setTimeout(resolve,1));}
        if(!ready)throw Error('official automatic envelope unavailable');file=ready.toolResultFile;
        const value=JSON.parse(await fs.readFile(file,'utf8'));
        if(value.agentId!==agentPath||value.finalResponse!==text)throw Error('automatic source differs; no repair');
      }else await fs.writeFile(file, JSON.stringify({ agentId: agentPath, status: 'completed', finalResponse: text }));
      command(turn.items, await captureNative(admitted.handle, file));
      command(turn.items, await publish(admitted.handle));
      if (fault === 'foreign-child' && operation === 'EXECUTE_SLICE') child.parentThreadId = 'foreign';
      }
    } else if (operation === 'SPEC_CLOSE') command(turn.items, await publishCandidate('CLOSE', specPath, null));
    else throw new Error(`fixture has no scripted author for ${operation}`);
  }
  return { operations, calls, threads, rpc: {
    notify() {},
    async request(method, params) {
      calls.push({ method, params: structuredClone(params) });
      if (method === 'initialize') return { userAgent: 'codex-cli/0.163.0' };
      if (method === 'skills/extraRoots/set') return {};
      if (method === 'experimentalFeature/list') return {data:[{name:'multi_agent',enabled:true},{name:'multi_agent_v2',enabled:true}],nextCursor:null};
      if (method === 'skills/list') {
        const root = path.join(snapshot, 'skills/workflows'), skills = [];
        for (const name of await fs.readdir(root)) if ((await fs.lstat(path.join(root, name))).isDirectory()) {
          const file = path.join(root, name, 'SKILL.md');
          if (await fs.lstat(file).catch(() => null)) skills.push({ name, path: file, enabled: true });
        }
        return { data: [{ cwd: workspace, skills, errors: [] }] };
      }
      if (method === 'thread/start') {
        const thread = { id: randomUUID(), cwd: workspace, cliVersion: '0.163.0', historyMode: 'paginated', parentThreadId: null, turns: [] };
        threads.set(thread.id, thread); return { thread: structuredClone(thread) };
      }
      if (method === 'thread/resume' || method === 'thread/read') return { thread: structuredClone(threads.get(params.threadId)) };
      if (method === 'turn/start') {
        const thread = threads.get(params.threadId), turn = { id: randomUUID(), status: 'inProgress', error: null, items: [], itemsView: 'full' };
        thread.turns.push(turn);
        const prompt = params.input.find(item => item.type === 'text').text;
        const operation = /^(?:OPERATION|MODE)=(.*)$/mu.exec(prompt)?.[1];
        const normalized = { INIT: 'SPEC_INIT', CLOSE: 'SPEC_CLOSE', READINESS: 'SPEC_READINESS' }[operation] ?? operation;
        const finish=async()=>{await authored(normalized,prompt,thread,turn);
          turn.status='completed';turn.items.push({id:randomUUID(),type:'agentMessage',phase:'final_answer',text:'Offline authored operation completed.'});
        };
        if(automatic)void finish().catch(error=>{turn.status='failed';turn.error={message:error.message};});else await finish();
        return { turn: structuredClone(turn) };
      }
      const thread = threads.get(params.threadId);
      if (!thread) throw new Error('foreign public thread query');
      if (method === 'thread/turns/list') {
        const target = fault === 'interrupt-close' ? 'SPEC_CLOSE' : 'EXECUTE_SLICE';
        if (['interrupt-execute', 'interrupt-close'].includes(fault) && !interrupted
          && operations.at(-1)?.operation === target && thread.parentThreadId === null) {
          interrupted = true; throw Object.assign(new Error('OFFLINE injected observation I/O failure after normal publication'), { code: 'EIO' });
        }
        return { data: structuredClone(thread.turns), nextCursor: null };
      }
      if (method === 'thread/items/list') return { data: structuredClone(thread.turns.find(turn => turn.id === params.turnId).items).map(item => ({ turnId: params.turnId, item })), nextCursor: null };
      throw new Error(`unexpected public method ${method}`);
    },
  } };
}
