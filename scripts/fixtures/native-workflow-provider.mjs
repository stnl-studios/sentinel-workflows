// OFFLINE_TEST_ONLY. Scripted authors/judges through the real public producers;
// these outcomes do not attest semantic model quality or native transport.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initialArtifacts, REQUIREMENTS } from './current-initial-preparation.mjs';
import { payload } from './current-initial-evidence.mjs';
import { applyPayload } from './current-findings-evidence.mjs';
import { publishCandidate } from '../../skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/publisher.mjs';
import { preparePreparationCandidate } from '../../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import { assertPreparationCandidate, preparePlanCandidate } from '../../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs';
import { serializePlanPathClaims } from '../../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs';
import { publishPreparationCandidate } from '../../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import { inspectCurrentExecution } from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import { begin, normalizeSuccessor, reserveDispatch, bindNative, verifyNative, captureNative, publish, resume } from
  '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checkSource = `import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {runCli} from './cli.mjs';
test('AC-001 list filters preserve storage',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-list-'));try{
const store=path.join(root,'todos.json');await fs.writeFile(store,JSON.stringify({todos:[{id:1,title:'a',completed:true},{id:2,title:'b',completed:false}]}));
const before=await fs.readFile(store);let out='';const code=await runCli(['--store',store,'list','--completed'],{stdout:{write:s=>{out+=s;}},stderr:{write:()=>{}}});
assert.equal(code,0);assert.deepEqual(out.trim().split('\\n').map(JSON.parse).map(x=>x.id),[1]);assert.ok(before.equals(await fs.readFile(store)));
}finally{await fs.rm(root,{recursive:true,force:true});}});\n`;

export function offlineNativeWorkflow({ workspace, caseRoot, snapshot, fault = null, beforeAuthored = null, caseId='A' }) {
  const threads = new Map(), calls = [], operations = [];
  const startedWork = [];
  const automatic = true;
  let interrupted = false;
  let preparation = null;
  let retainedPlanReturn = null;
  function command(items, result) { items.push({ id: randomUUID(), type: 'commandExecution', status: 'completed',
    exitCode: 0, aggregatedOutput: JSON.stringify(result) }); }
  async function authored(operation, prompt, thread, turn) {
    const specPath = /^SPEC_PATH=(.*)$/mu.exec(prompt)?.[1];
    const auxiliary = (parent = thread, parentTurn = turn, { followup = false, nested = false, turns = 1 } = {}) => {
      const agentPath = `${parent === thread ? '/root' : '/root/aux'}/aux-${randomUUID()}`, id = randomUUID();
      const child = { id, cwd: workspace, cliVersion: '0.163.0', historyMode: 'paginated', parentThreadId: parent.id,
        forkedFromId: parent.id, agentRole: 'default', model: 'gpt-6.1-sol', reasoningEffort: 'medium', turns: [] };
      const childTurn = { id: randomUUID(), status: 'completed', error: null, itemsView: 'full',
        items: [{ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'PASS — auxiliary advice only.' }] };
      child.turns.push(childTurn); threads.set(id, child);
      parentTurn.items.push({ id: randomUUID(), type: 'subAgentActivity', kind: 'started', agentPath,
        agentThreadId: id, model: child.model, reasoningEffort: child.reasoningEffort });
      if (followup) child.turns.push({ ...structuredClone(childTurn), id: randomUUID() });
      for (let i = 1; i < turns; i++) child.turns.push({ ...structuredClone(childTurn), id: randomUUID() });
      if (nested) auxiliary(child, childTurn);
      for (const [index, completed] of child.turns.entries()) {
        if (index) parentTurn.items.push({ id: randomUUID(), type: 'subAgentActivity', kind: 'interacted', agentPath, agentThreadId: id });
        parentTurn.items.push({ id: `subagent-completed-${completed.id}`, type: 'subAgentActivity', kind: 'completed', agentPath, agentThreadId: id });
      }
      return child;
    };
    if (fault === 'aux-run-eight' || fault === 'aux-run-nine') {
      const count = operation === 'PLAN' ? 4 : operation === 'REVIEW_PLAN' ? (fault === 'aux-run-nine' ? 5 : 4) : 0;
      for (let i = 0; i < count; i++) auxiliary();
    }
    if (fault === 'aux-run-eleven' && operation === 'PLAN') for (let i = 0; i < 11; i++) auxiliary();
    if (fault === 'review-correction-aux' && (operation === 'REVIEW_PLAN' || operation === 'PLAN' && preparation)) auxiliary();
    if (operation === 'EXECUTE_SLICE' && ['aux-before-reservation', 'aux-followup', 'aux-followup-interrupt', 'aux-descendant'].includes(fault))
      auxiliary(thread, turn, { followup: ['aux-followup', 'aux-followup-interrupt'].includes(fault), nested: fault === 'aux-descendant' });
    if (!specPath) throw new Error('fixture requires the real launcher SPEC_PATH');
    operations.push({ operation, threadId: thread.id, specPath });
    if (beforeAuthored !== null) await beforeAuthored(operation);
    if (operation === 'PLAN' && fault === 'missing-plan-result') return;
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
      if (retainedPlanReturn && fault?.startsWith('plan-redelivery')) {
        if (!prompt.includes('handoff re-delivery only') || !prompt.includes(preparation.candidateExecutionRoot)
          || !prompt.includes('Do not rerun')) throw new Error('redelivery lacks exact candidate and concrete feedback');
        const attempt=operations.filter(item=>item.operation==='PLAN').length-1;
        if(fault==='plan-redelivery-missing-file') {
          turn.items.push({id:randomUUID(),type:'agentMessage',phase:'final_answer',text:'The preserved original file is absent; no handoff invented.'});return;
        }
        if(fault==='plan-redelivery-exhausted'||fault==='plan-redelivery-twice'&&attempt<2) {
          command(turn.items,{status:'DRAFT',candidateExecutionRoot:preparation.candidateExecutionRoot});
          return;
        }
        const original = await fs.readFile(retainedPlanReturn, 'utf8'),value=JSON.parse(original);
        if(fault==='plan-redelivery-divergent-file')value.authority.artifactHashes[0].sha256='sha256:'+'0'.repeat(64);
        if(fault==='plan-redelivery-foreign')value.candidateExecutionRoot+='-foreign';
        if(fault==='plan-redelivery-drift')await fs.appendFile(path.join(preparation.candidateExecutionRoot,'plans/slice-01.md'),'\nUnapproved change during re-delivery.\n');
        command(turn.items, value);
        return;
      }
      if (preparation && (fault?.startsWith('review-correction')
        || ['plan-redelivery-four','plan-redelivery-exhausted'].includes(fault))) {
        if (!prompt.includes(`CANDIDATE_EXECUTION_ROOT=${preparation.candidateExecutionRoot}`)
          || !prompt.includes('bounded author correction') || !prompt.includes('Offline preparation review declined')) throw new Error('author correction lacks exact candidate/feedback');
        await assertPreparationCandidate(preparation.candidateExecutionRoot, specPath);
        for (const name of ['plans/slice-01.md', 'tasks/slice-01.md']) {
          const file = path.join(preparation.candidateExecutionRoot, name), text = await fs.readFile(file, 'utf8');
          await fs.writeFile(file, text.replace(/^- Recipe: (.+)$/mu, (_, json) => {
            const recipe = JSON.parse(json); recipe.dependencyReview += ' Offline author reviewed the omitted indirect dependency.';
            return `- Recipe: ${JSON.stringify(recipe)}`;
          }));
        }
        command(turn.items, await preparePlanCandidate({ candidateExecutionRoot: preparation.candidateExecutionRoot }));
        command(turn.items, await serializePlanPathClaims({ specPath, candidateExecutionRoot: preparation.candidateExecutionRoot }));
        preparation = await publishPreparationCandidate({ specPath, candidateExecutionRoot: preparation.candidateExecutionRoot });
        if(['plan-redelivery-four','plan-redelivery-exhausted'].includes(fault)
          && operations.filter(item=>item.operation==='PLAN').length===4) {
          retainedPlanReturn=path.join(caseRoot,'tmp/literal-plan-return.json');
          await fs.writeFile(retainedPlanReturn,JSON.stringify(preparation)+'\n');
          command(turn.items,{});turn.items.at(-1).aggregatedOutput=JSON.stringify({stdoutFile:retainedPlanReturn})+'\n'+JSON.stringify({status:preparation.status});
        } else command(turn.items, preparation);
        return;
      }
      const allocated = await preparePreparationCandidate({ specPath, operation: 'PLAN' });
      if (fault?.startsWith('plan-redelivery')) command(turn.items, allocated);
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
      if (fault?.startsWith('plan-redelivery')&&!['plan-redelivery-four','plan-redelivery-exhausted'].includes(fault)) {
        retainedPlanReturn = path.join(caseRoot, 'tmp/literal-plan-return.json');
        await fs.writeFile(retainedPlanReturn, JSON.stringify(preparation) + '\n');
        command(turn.items, {});
        turn.items.at(-1).aggregatedOutput = JSON.stringify({ stdoutFile: retainedPlanReturn }) + '\n'
          + JSON.stringify({ status: preparation.status, candidateExecutionRoot: preparation.candidateExecutionRoot });
        if(fault==='plan-redelivery-missing-file')await fs.unlink(retainedPlanReturn);
        if(fault==='plan-redelivery-no-allocation')turn.items=turn.items.filter(item=>!item.aggregatedOutput?.includes('"status":"DRAFT"'));
        if(fault==='plan-redelivery-denied')turn.items.push({id:randomUUID(),type:'commandExecution',status:'completed',exitCode:1,
          command:"zsh -lc 'cat <<EOF\nsynthetic\nEOF'",aggregatedOutput:"zsh:1: can't create temp file for here document: operation not permitted\n"});
      } else command(turn.items, preparation);
      if (fault === 'unexpected-plan-child') {
        const childId = randomUUID();
        threads.set(childId, { id: childId, parentThreadId: thread.id, cliVersion: '0.163.0',
          cwd: workspace, historyMode: 'paginated', forkedFromId: null, agentRole: 'default',
          model: 'gpt-6-luna', reasoningEffort: 'high', turns: [{ id: randomUUID(), status: 'interrupted', error: null, items: [] }] });
        turn.items.push({ id: randomUUID(), type: 'subAgentActivity', kind: 'started',
          agentPath: '/root/review_plan', agentThreadId: childId });
      }
    } else if (operation === 'REVIEW_PLAN') {
      if (!prompt.includes(`CANDIDATE_EXECUTION_ROOT=${preparation.candidateExecutionRoot}`)) throw new Error('fixture root was not passed to the independent review');
      if ((fault?.startsWith('review-correction') && (operations.filter(item => item.operation === 'REVIEW_PLAN').length === 1
        || fault === 'review-correction-twice'||fault==='review-correction-four'&&operations.filter(item=>item.operation==='REVIEW_PLAN').length<=4))
        || ['plan-redelivery-four','plan-redelivery-exhausted'].includes(fault)&&operations.filter(item=>item.operation==='REVIEW_PLAN').length<=3) {
        turn.items.push({ id: randomUUID(), type: 'agentMessage', phase: 'final_answer',
          text: 'Offline preparation review declined: author must correct the recipe dependency review; no approval or publication.' });
        return;
      }
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
      const slice = /^SLICE=(.*)$/mu.exec(prompt)?.[1];
      let admitted = await begin({ specPath, operation, slice, expectedActivationId: current.activationId });
      if (operation === 'VALIDATE_SLICE' && !prompt.includes('Solicito validação integral terminal')) {
        throw new Error('fixture requires the same explicit integral request as the normal author');
      }
      if (!prompt.includes('Select model=gpt-6-luna and reasoning_effort=medium explicitly')
        || (operation !== 'VALIDATE_SLICE' && !prompt.includes('before delegating read-only verification'))) throw new Error('generic profile/work-order context missing');
      let dispatch = await reserveDispatch(admitted.handle, { responseVariant: 'stnl-current-native-judgment-v1',
        ...(operation === 'VALIDATE_SLICE' ? { terminal: true } : {}) });
      if (operation === 'EXECUTE_SLICE' && ['aux-after-reservation', 'aux-only'].includes(fault)) {
        auxiliary(); if (fault === 'aux-only') return;
      }
      if (operation === 'EXECUTE_SLICE' && fault !== 'premature-verification') {
        // Existing deterministic product fixtures, only for offline FULL
        // orchestration tests. They never attest model authorship/semantics.
        const source=caseId==='B'?'prioritized-cli.mjs':caseId==='C'?'archived-cli.mjs':'filtered-cli.mjs';
        await fs.copyFile(path.join(repo, 'scripts/fixtures',source), path.join(workspace, 'src/cli.mjs'));
        const checks=caseId==='A'?checkSource:checkSource.replace("'list','--completed'","'list'").replace('map(x=>x.id),[1]','map(x=>x.id),[1,2]');
        await fs.writeFile(path.join(workspace, 'src/native-filter.test.mjs'), checks);
        if (['findings-cycle', 'findings-two-cycles','findings-format-corrections','formal-recovered-apply-rejection'].includes(fault)) {
          const file = path.join(workspace, 'src/cli.mjs');
          const original = await fs.readFile(file, 'utf8');
          if (!original.includes('todo.completed === false')) throw new Error('offline mutant did not reach its pending branch');
          await fs.writeFile(file, original.replace('todo.completed === false', 'todo.completed === true'));
        }
      } else if (operation === 'APPLY_FINDINGS') {
        await fs.copyFile(path.join(repo, 'scripts/fixtures/filtered-cli.mjs'), path.join(workspace, 'src/cli.mjs'));
        let corrected = checkSource.replace("assert.equal(code,0);", "let pending='';assert.equal(await runCli(['--store',store,'list','--pending'],{stdout:{write:s=>{pending+=s;}},stderr:{write:()=>{}}}),0);assert.deepEqual(pending.trim().split('\\n').map(JSON.parse).map(x=>x.id),[2]);assert.equal(code,0);");
        if (fault === 'findings-two-cycles' && operations.filter(item => item.operation === 'APPLY_FINDINGS').length === 2)
          corrected = corrected.replace('assert.ok(before.equals(await fs.readFile(store)));', "assert.ok(before.equals(await fs.readFile(store)));const noMatch=path.join(root,'no-match.json');await fs.writeFile(noMatch,JSON.stringify({todos:[{id:1,title:'a',completed:true}]}));let empty='';assert.equal(await runCli(['--store',noMatch,'list','--pending'],{stdout:{write:s=>{empty+=s;}},stderr:{write:()=>{}}}),0);assert.equal(empty,'');");
        await fs.writeFile(path.join(workspace, 'src/native-filter.test.mjs'), corrected);
      }
      const clarificationRounds=operation==='EXECUTE_SLICE'&&fault?.startsWith('test-coverage-clarification');
      const coverageRounds = operation === 'EXECUTE_SLICE' && ['test-coverage-correction','test-coverage-clarification','test-coverage-clarification-continuation'].includes(fault);
      let coverageProducer=null;
      const validationOrdinal=operations.filter(item=>item.operation==='VALIDATE_SLICE').length;
      const mixedFinal=fault==='findings-format-corrections'&&operation==='VALIDATE_SLICE'&&validationOrdinal===2;
      const expanded=operation==='VALIDATE_SLICE'&&['formal-two-corrections','formal-four-corrections','formal-exhausted','formal-continuation-exhausted'].includes(fault);
      const producerCorrections=fault==='execute-producer-corrections'&&operation==='EXECUTE_SLICE'?4:fault==='findings-producer-corrections'&&operation==='APPLY_FINDINGS'?3:0;
      const mixedApply=fault==='findings-producer-mixed'&&operation==='APPLY_FINDINGS';
      const recoveredApply=fault==='formal-recovered-apply-rejection'&&(operation==='APPLY_FINDINGS'||operation==='VALIDATE_SLICE'&&validationOrdinal===1);
      const formalRounds=recoveredApply?2:mixedApply?3:producerCorrections?producerCorrections+1:coverageRounds?3:mixedFinal?4:expanded?(fault==='formal-two-corrections'?3:fault==='formal-continuation-exhausted'?4:5):operation==='VALIDATE_SLICE'&&fault==='formal-incomplete-exhausted'?3:operation==='VALIDATE_SLICE'&&['formal-successor','formal-incomplete','formal-continuation-correction'].includes(fault)?2:1;
      for(let formalRound=0;formalRound<formalRounds;formalRound++){
      if(coverageRounds) {
        const file=path.join(workspace,'src/native-filter.test.mjs');
        const corrected=checkSource.replace("assert.equal(code,0);", "let pending='';assert.equal(await runCli(['--store',store,'list','--pending'],{stdout:{write:s=>{pending+=s;}},stderr:{write:()=>{}}}),0);assert.deepEqual(pending.trim().split('\\n').map(JSON.parse).map(x=>x.id),[2]);assert.equal(code,0);");
        await fs.writeFile(file,formalRound===0&&!clarificationRounds?checkSource.replace('assert.equal(code,0);','assert.equal(code,1);'):formalRound<2?checkSource:corrected);
        if(formalRound)dispatch=await reserveDispatch(admitted.handle,{responseVariant:'stnl-current-native-judgment-v1'});
      }
      else if(mixedApply&&formalRound===2)dispatch=await reserveDispatch(admitted.handle,{responseVariant:'stnl-current-native-judgment-v1'});
      else if(formalRound){const next=await inspectCurrentExecution(specPath);
        admitted=await normalizeSuccessor({specPath,operation,slice,expectedActivationId:next.activationId});
        dispatch=await reserveDispatch(admitted.handle,{responseVariant:'stnl-current-native-judgment-v1',terminal:operation==='VALIDATE_SLICE'});}
      const sameProducer=clarificationRounds&&formalRound===1;
      const agentPath = sameProducer?coverageProducer.agentPath:`/root/check-${randomUUID()}`, childId = sameProducer?coverageProducer.childId:randomUUID();
      const child = sameProducer?coverageProducer.child:{ id: childId, cwd: workspace, cliVersion: '0.163.0', historyMode: 'paginated', parentThreadId: thread.id,
        forkedFromId: null, agentRole: 'default', model: 'gpt-6-luna', reasoningEffort: 'medium', turns: [] };
      if(!sameProducer) {threads.set(childId, child);
      turn.items.push({ id: randomUUID(), type: 'subAgentActivity', kind: 'started', agentPath,
        agentThreadId: childId, model: 'gpt-6-luna', reasoningEffort: 'medium' });
      } else turn.items.push({id:randomUUID(),type:'subAgentActivity',kind:'interacted',agentPath,agentThreadId:childId});
      if(clarificationRounds&&formalRound===0)coverageProducer={agentPath,childId,child};
      await bindNative(admitted.handle, agentPath);
      if (operation === 'EXECUTE_SLICE' && fault === 'aux-after-formal') auxiliary();
      if (operation === 'EXECUTE_SLICE' && fault === 'aux-followup-twelve') auxiliary(thread, turn, { turns: 12 });
      const continuing=(fault==='pre-verification-continuation'||clarificationRounds&&fault==='test-coverage-clarification-continuation'&&formalRound===0)&&operation==='EXECUTE_SLICE'
        ||['formal-continuation-exhausted','formal-continuation-correction'].includes(fault)&&operation==='VALIDATE_SLICE'&&formalRound===0;
      const contractCommand=/^cat -- .+$/mu.exec(prompt)?.[0];
      if(!contractCommand)throw Error('canonical full-contract read command absent from public context');
      const contractRead=()=>({id:randomUUID(),type:'commandExecution',command:contractCommand,cwd:workspace,status:'completed',exitCode:0,aggregatedOutput:null});
      if(continuing) {
        const read=contractRead();read.aggregatedOutput=await fs.readFile(path.join(snapshot,'agents/codex/.codex/agents/stnl_validation_runner.toml'),'utf8');
        child.turns.push({id:randomUUID(),status:'completed',error:null,itemsView:'full',items:[
          {id:randomUUID(),type:'reasoning',summary:[],content:[]},
          read,...(fault==='pre-verification-continuation'?[{id:'initialization-discovery',type:'commandExecution',
            command:'/bin/zsh -lc "sed -n \'1,5p\' package.json"',cwd:workspace,status:'completed',exitCode:0,
            aggregatedOutput:'Synthetic discovery only; no command executed by this fixture.',commandActions:[]}]:[]),
          {id:randomUUID(),type:'agentMessage',phase:'final_answer',text:'Arbitrary initialization; no verification yet.'}]});
        turn.items.push({id:randomUUID(),type:'subAgentActivity',kind:'completed',agentPath,agentThreadId:childId});
        const eventPath=/record in (.+?); match binding\.agentPath/u.exec(prompt)?.[1];
        const deadline=Date.now()+10000;let admittedContinuation;
        while(!admittedContinuation&&Date.now()<deadline) {
          const raw=await fs.readFile(eventPath,'utf8');admittedContinuation=raw.split('\n').slice(0,-1).map(JSON.parse).find(e=>e.type==='native.child.continuation.admitted'&&e.binding.agentPath===agentPath);
          if(!admittedContinuation)await new Promise(resolve=>setTimeout(resolve,1));
        }
        if(!admittedContinuation)throw Error('public continuation admission unavailable');
        const second={id:randomUUID(),status:'inProgress',error:null,itemsView:'full',items:[]};child.turns.push(second);
        turn.items.push({id:randomUUID(),type:'subAgentActivity',kind:'interacted',agentPath,agentThreadId:childId});
      }
      if(mixedApply){
        const file=path.join(workspace,'src/cli.mjs'),source=await fs.readFile(path.join(repo,'scripts/fixtures/filtered-cli.mjs'),'utf8');
        await fs.writeFile(file,formalRound===1?source.replace('todo.completed === false','todo.completed === true'):source);
      }
      const measured = await verifyNative(dispatch.originFile);
      if(sameProducer&&(!measured.correctionFeedback?.diagnostic.includes('testCoverageOmissions')
        ||JSON.parse(measured.correctionFeedback.previousResponse).result.testCoverageOmissions!==undefined))
        throw Error('same coverage producer did not receive its missing-proof feedback');
      if(fault==='formal-two-corrections'&&operation==='VALIDATE_SLICE'&&formalRound>0) {
        const feedback=measured.correctionFeedback;
        if(!feedback||!feedback.diagnostic.includes('RUNNER_SEMANTIC_RESULT_INVALID')
          ||JSON.parse(feedback.previousResponse).result.status!=='INVALID'
          ||feedback.previousResponseSha256!=='sha256:'+createHash('sha256').update(feedback.previousResponse).digest('hex'))
          throw Error('corrective producer did not receive the complete prior failure input');
      }
      const findingsCycles = fault === 'findings-two-cycles' ? 2 : ['findings-cycle','findings-format-corrections','findings-producer-corrections','findings-producer-mixed','formal-recovered-apply-rejection'].includes(fault) ? 1 : 0;
      const validationRound = operations.filter(item => item.operation === 'VALIDATE_SLICE').length;
      const needsFix = findingsCycles > 0 && operation === 'VALIDATE_SLICE' && validationRound <= findingsCycles;
      const corrected = findingsCycles > 0 && operation === 'VALIDATE_SLICE' && !needsFix;
      const findingIds = validationRound > findingsCycles ? [`finding-${String(findingsCycles).padStart(2, '0')}`]
        : Array.from({ length: validationRound }, (_, i) => `finding-${String(i + 1).padStart(2, '0')}`);
      const result = operation === 'EXECUTE_SLICE' ? (({ head, ...rest }) => rest)(payload(coverageRounds||producerCorrections?formalRound+1:1))
        : operation === 'APPLY_FINDINGS' ? (({ head, ...rest }) => rest)(applyPayload(producerCorrections||mixedApply?formalRound+1:1, mixedApply&&formalRound===1?'TESTS_FAIL':'TESTS_PASS', mixedApply&&formalRound===1?1:0, [fault === 'findings-two-cycles' && operations.filter(item => item.operation === 'APPLY_FINDINGS').length === 2 ? 'finding-02' : 'finding-01']))
        : { status: 'PASS', commands: measured.commands, evidence: 'OFFLINE semantic judgment fixture only.',
          findingReferences: needsFix || corrected ? findingIds.join(', ') : 'none', findingDispositions: needsFix || corrected ? findingIds.map((id, i) => `${id}=${needsFix && i === validationRound - 1 ? 'active' : 'resolved'}`).join(', ') : 'none', blockers: 'none',
          unexpectedWorkspaceEffects: 'none', persistenceSummary: 'No runner edits.' };
      result.commands = measured.commands;
      if(operation!=='VALIDATE_SLICE')result.automaticCheckRound=`${formalRound+1}/5`;
      if(producerCorrections&&formalRound<producerCorrections)delete result[['coverage','selectionRationale','discoverySources','selectedChecks'][formalRound]];
      if(coverageRounds) {
        result.status=formalRound===0&&!clarificationRounds?'TESTS_FAIL':formalRound<2?'BLOCKED':'TESTS_PASS';
        if(clarificationRounds&&formalRound===0)result.blockers='The prepared test omits the pending assertion but this response lacks structured coverage proof.';
        if(formalRound===1) {
          result.blockers='The prepared test omits the pending filter assertion required by the approved obligation.';
          result.testCoverageOmissions=[{obligationId:'obligation-01',testPath:'src/native-filter.test.mjs',testedFileSha256:'sha256:'+createHash('sha256').update(await fs.readFile(path.join(workspace,'src/native-filter.test.mjs'))).digest('hex'),evidence:'The recipe-selected test checks completed but never pending output.',expectedCorrection:'Assert the pending IDs without modifying implementation or recipe.'}];
        }
      }
      if (needsFix) result.status = 'NEEDS_FIX';
      const findings = needsFix ? [{ id: findingIds.at(-1), originAttempt: JSON.parse(await fs.readFile(dispatch.requestFile)).attemptId,
        severity: 'blocking', problem: validationRound === 1 ? 'Pending filter selects completed records.' : 'Prepared tests omit pending no-match behavior.', evidence: validationRound === 1 ? 'The pending branch uses todo.completed.' : 'The prepared test exercises mixed storage but not a nonempty store with no pending records.',
        impact: 'Case A pending list requirement is not fully demonstrated.', relatedAuthority: 'AC-001; obligation-01', expectedCorrection: validationRound === 1 ? 'Select incomplete records and assert pending output.' : 'Assert empty pending output from a nonempty completed-only store.' }] : [];
      const incomplete=operation==='VALIDATE_SLICE'&&['formal-incomplete','formal-incomplete-exhausted'].includes(fault)
        &&(formalRound===0||fault==='formal-incomplete-exhausted');
      if(incomplete){result.status='BLOCKED';result.blockers='Independent inspection of the prepared assertions against the canonical AC-001 obligation is incomplete.';}
      const invalid = recoveredApply&&formalRound===0 || !coverageRounds && (['formal-continuation-exhausted','formal-exhausted'].includes(fault)&&operation==='VALIDATE_SLICE'
        || ['formal-successor','formal-continuation-correction'].includes(fault)&&formalRounds===2&&formalRound===0);
      if((fault==='formal-four-corrections'&&operation==='VALIDATE_SLICE'||mixedFinal)&&formalRound<formalRounds-1) {
        const [field,value]=[['status','INVALID'],['commands',[]],['evidence',0],['findingReferences',{}]][formalRound];result[field]=value;
      }
      if(fault==='formal-two-corrections'&&operation==='VALIDATE_SLICE'&&formalRound<2)result.status='INVALID';
      const text = (['findings-producer-corrections','findings-producer-mixed'].includes(fault)&&operation==='APPLY_FINDINGS'||fault==='execute-producer-corrections'&&operation==='EXECUTE_SLICE')&&formalRound===0?'{invalid Initial APPLY result':JSON.stringify({ format: 'stnl-current-native-judgment-v1', result,
        ...(operation === 'VALIDATE_SLICE' && !invalid ? { newFindings: findings } : {}) })
        +(invalid?'\nCanonical task identity: `'+agentPath+'`':'');
      if(continuing)Object.assign(child.turns.at(-1),{status:'completed',items:[{id:randomUUID(),type:'commandExecution',command:'node verificationHelper verify-native --origin-file originFile',cwd:workspace,status:'completed',exitCode:0,aggregatedOutput:JSON.stringify(measured)},{id:randomUUID(),type:'agentMessage',phase:'final_answer',text}]});
      else child.turns.push({ id: randomUUID(), status: 'completed', error: null, itemsView: 'full',
        items: [{ id: randomUUID(), type: 'commandExecution', command: `cat -- '${path.join(snapshot, 'agents/codex/.codex/agents/stnl_validation_runner.toml').replaceAll("'", "'\\''")}'`, cwd: workspace, status: 'completed', exitCode: 0, aggregatedOutput: await fs.readFile(path.join(snapshot, 'agents/codex/.codex/agents/stnl_validation_runner.toml'), 'utf8') }, { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text }] });
      if(fault==='formal-observe-inventory'&&operation==='EXECUTE_SLICE'||fault==='formal-observe-wait-timeout')child.turns[0].items.splice(1,0,{id:randomUUID(),type:'collabAgentToolCall',tool:fault==='formal-observe-inventory'?'listAgents':'wait',status:'completed',senderThreadId:childId,receiverThreadIds:[],prompt:null,model:null,reasoningEffort:null,agentsStates:{}});
      if (fault === 'grandchildren' && operation === 'EXECUTE_SLICE') child.turns[0].items.push(...[1, 2].map(index => ({
        id: randomUUID(), type: 'subAgentActivity', kind: 'started', agentPath: `${agentPath}/extra-${index}`, agentThreadId: randomUUID() })));
      let file = path.join(caseRoot, `${operation}.normal-tool-result.json`);
      if(automatic){
        turn.items.push({id:randomUUID(),type:'subAgentActivity',kind:'completed',agentPath,agentThreadId:childId});
        const eventPath=/record in (.+?); match binding\.agentPath/u.exec(prompt)?.[1];
        if(!eventPath)throw Error('public transport ready-event path missing');
        const deadline=Date.now()+10_000;let ready;
        while(!ready && Date.now()<deadline){const raw=await fs.readFile(eventPath,'utf8');
          ready=raw.split('\n').slice(0,-1).map(JSON.parse).find(e=>e.type==='native.child.completed'&&e.binding.agentPath===agentPath
            &&(!sameProducer||e.designation?.round===formalRound+1));
          if(!ready)await new Promise(resolve=>setTimeout(resolve,1));}
        if(!ready)throw Error('official automatic envelope unavailable');file=ready.toolResultFile;
        const value=JSON.parse(await fs.readFile(file,'utf8'));
        if(value.agentId!==agentPath||value.finalResponse!==text)throw Error('automatic source differs; no repair');
      }else await fs.writeFile(file, JSON.stringify({ agentId: agentPath, status: 'completed', finalResponse: text }));
      let reviewTriageFile=null;
      if(incomplete||clarificationRounds&&formalRound===0){
        const requestBytes=await fs.readFile(dispatch.requestFile),request=JSON.parse(requestBytes);
        reviewTriageFile=path.join(caseRoot,`review-triage-${formalRound}.json`);
        await fs.writeFile(reviewTriageFile,JSON.stringify({format:'stnl-formal-review-triage-v1',owner:request.owner,requestSha256:'sha256:'+createHash('sha256').update(requestBytes).digest('hex'),responseSha256:'sha256:'+createHash('sha256').update(text).digest('hex'),category:'incomplete-review',inputsAvailable:true,externalBlockers:[],missingWork:[{obligationId:request.authority.delivery.obligations[0].id,evidence:result.blockers,remainingWork:'Inspect the prepared assertions independently against the unchanged canonical obligation.'}]}));
      }
      const captured=await captureNative(admitted.handle,file,{reviewTriageFile});command(turn.items,captured);
      if (fault === 'findings-two-cycles' && operation === 'APPLY_FINDINGS') {
        const directory = path.dirname(dispatch.originFile);
        const names = ['round-1.response.json', 'round-1.receipt.json', 'round-1.observation.json', 'round-1.tool-result.json'];
        const originals = await Promise.all(names.map(name => fs.readFile(path.join(directory, name))));
        const turnCount = calls.filter(call => call.method === 'turn/start').length;
        if (!(await captureNative(admitted.handle, file)).replayed || (await resume(admitted.handle)).nextAction !== 'publish')
          throw Error('APPLY replay did not preserve its existing capture/publication handoff');
        for (const [index, name] of names.entries())
          if (!(await fs.readFile(path.join(directory, name))).equals(originals[index])) throw Error('APPLY replay changed captured sources');
        if (calls.filter(call => call.method === 'turn/start').length !== turnCount) throw Error('APPLY replay admitted a turn');
      }
      if(mixedApply&&formalRound===1){
        if(captured.nextAction!=='reserve-dispatch')throw Error('failed APPLY prefix lost its correction handoff');
      } else if(coverageRounds && formalRound<2) {
        if(captured.nextAction!=='reserve-dispatch')throw Error('coverage correction did not retain the existing correction handoff');
        if(formalRound===1)try {await publish(admitted.handle);throw Error('intermediate omission unexpectedly published');}catch(error){if(error.code!=='EVIDENCE_INCOMPLETE')throw error;}
      } else command(turn.items, await publish(admitted.handle));
      if (fault === 'foreign-child' && operation === 'EXECUTE_SLICE') child.parentThreadId = 'foreign';
      }
    } else if (operation === 'SPEC_CLOSE') command(turn.items, await publishCandidate('CLOSE', specPath, null));
    else throw new Error(`fixture has no scripted author for ${operation}`);
  }
  return { operations, calls, threads,
    // After the manager returns, join only work already started by this fixture.
    // This neither starts turns nor settles/refunds the manager's uncertain ledger.
    async settled() { await Promise.all(startedWork); }, rpc: {
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
          turn.status='completed';if(!turn.items.some(item=>item.type==='agentMessage'&&item.phase==='final_answer'))turn.items.push({id:randomUUID(),type:'agentMessage',phase:'final_answer',text:'Offline authored operation completed.'});
        };
        const work = finish().catch(error=>{turn.status='failed';turn.error={message:error.message};});
        startedWork.push(work);
        if(!automatic)await work;
        return { turn: structuredClone(turn) };
      }
      const thread = threads.get(params.threadId);
      if (!thread) throw new Error('foreign public thread query');
      if (method === 'thread/turns/list') {
        if(fault==='plan-redelivery-uncertain'&&operations.at(-1)?.operation==='PLAN'
          &&thread.parentThreadId===null&&thread.turns.at(-1)?.status==='completed')
          throw Object.assign(new Error('OFFLINE uncertain observation after PLAN'),{code:'EIO'});
        const target = fault === 'interrupt-close' ? 'SPEC_CLOSE' : fault === 'review-correction-interrupt' ? 'PLAN' : 'EXECUTE_SLICE';
        if (['interrupt-execute', 'interrupt-close', 'aux-followup-interrupt', 'review-correction-interrupt'].includes(fault) && !interrupted
          && (fault !== 'review-correction-interrupt' || operations.filter(item=>item.operation==='PLAN').length === 2)
          && operations.at(-1)?.operation === target && thread.parentThreadId === null
          && thread.turns.at(-1)?.status === 'completed') {
          interrupted = true; throw Object.assign(new Error('OFFLINE injected observation I/O failure after normal publication'), { code: 'EIO' });
        }
        return { data: structuredClone(thread.turns), nextCursor: null };
      }
      if (method === 'thread/items/list') return { data: structuredClone(thread.turns.find(turn => turn.id === params.turnId).items).map(item => ({ turnId: params.turnId, item })), nextCursor: null };
      throw new Error(`unexpected public method ${method}`);
    },
  } };
}
