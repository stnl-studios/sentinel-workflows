import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import Ajv2020 from 'ajv/dist/2020.js';
import { allocateOfflineFixture, finishOfflineFixture } from './fixtures/offline-checkout.mjs';
import { describeOfflineSdk } from '../agents/codex/runtime/offline-provider-context.mjs';
import { offlineNativeWorkflow } from './fixtures/native-workflow-provider.mjs';
import { invocationContext, decideOutcome } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';

const repo = path.resolve(import.meta.dirname, '..');

test('invocation provenance distinguishes review contexts from author continuity without reclassifying controllers', () => {
  const author = { threadId: 'author-thread', role: 'author' };
  const temporaryDirectory = path.join(repo, 'tmp', 'case scratch');
  const originalTmpdir = process.env.TMPDIR;
  for (const regime of ['fresh', 'author-continuity']) {
    const policy = { regime, authorContinuityOperations: regime === 'fresh' ? [] : ['PLAN'] };
    for (const [operation, skill] of [['SPEC_READINESS', 'stnl-spec-lifecycle-manager'],
      ['REVIEW_PLAN', 'stnl-plan-reviewer'], ['VALIDATE_SLICE', 'stnl-slice-quality-manager'],
      ['PLAN', 'stnl-execution-planner']]) {
      const context = invocationContext(operation, skill, policy, author, temporaryDirectory);
      const resumed = regime === 'author-continuity' && operation === 'PLAN';
      assert.equal(context.prior, resumed ? author : null);
      assert.equal(context.role, operation === 'PLAN' ? 'author' : 'review');
      assert.ok(context.text.includes(`You are executing ${operation} as ${skill}.`));
      const provenance = /^Context provenance: (thread\/(?:start|resume)); (.+)\.$/mu.exec(context.text);
      assert.equal(provenance[1], resumed ? 'thread/resume' : 'thread/start');
      assert.equal(provenance[2], resumed ? `author thread ${author.threadId}` : 'no author thread resumed');
      assert.equal(/^Temporary work directory: (.+)$/mu.exec(context.text)[1], temporaryDirectory);
      assert.match(context.text, /Pass both temporary-path rules to every delegated agent/u);
      assert.match(context.text, /Keep registered candidates and operation controls at the repository-local paths returned by public producers/u);
      assert.match(context.text, /do not relocate those owned allocations to this scratch directory/u);
      assert.match(context.text, /Do not choose external\/system temporary paths/u);
      assert.match(context.text, /preserve the inherited process-local TMPDIR for tool-managed temporaries/u);
    }
  }
  for (const missing of [null, undefined]) {
    const context = invocationContext('PLAN', 'stnl-execution-planner',
      { regime: 'author-continuity', authorContinuityOperations: ['PLAN'] }, missing, temporaryDirectory);
    assert.equal(context.prior, null);
    assert.match(context.text, /Context provenance: thread\/start; no author thread resumed\./u);
  }
  assert.equal(process.env.TMPDIR, originalTmpdir, 'context communication does not alter the process environment');
});

for (const phase of ['initialize', 'turn', 'turn-write-failure']) test(`normal entry retains bounded stderr after ${phase} failure without another admission`, async t => {
  const fixture = await allocateOfflineFixture(repo);
  t.after(async () => { await finishOfflineFixture(fixture); });
  const url = name => pathToFileURL(path.join(fixture.root, name)).href;
  const manager = await import(url('benchmarks/sentinel-todo/runtime/benchmark-manager.mjs'));
  const { createNativeProvider } = await import(url('agents/codex/runtime/native-provider.mjs'));
  const { appServerRpc } = await import(url('agents/codex/runtime/app-server-transport.mjs'));
  const input = new PassThrough(), output = new PassThrough(), diagnostics = new PassThrough();
  const codec = appServerRpc({ input, output, diagnostics, timeoutMs: 1000 });
  t.after(() => { codec.close(); input.destroy(); output.destroy(); diagnostics.destroy(); });
  const calls = [];
  const rpc = {
    stderrSample: () => codec.stderrSample(), notify() {},
    request(method, params) {
      calls.push(method);
      if (phase !== 'initialize' && method === 'initialize') return Promise.resolve({ userAgent: 'codex-cli/0.163.0' });
      const pending = codec.request(method, params);
      diagnostics.write(Buffer.concat([Buffer.from('failed to load skill: private-value\n'), Buffer.alloc(65537)]));
      return pending;
    },
  };
  const sdk = await describeOfflineSdk(await fs.realpath(path.join(repo, 'agents/codex/node_modules')), fixture.root);
  const offline = { mode: 'OFFLINE_TEST_ONLY', sdk,
    createNativeProvider: async args => {
      if (phase === 'turn-write-failure') await fs.writeFile(path.join(args.evidenceRoot, 'tmp/app-server-stderr-sample.txt'), 'prior sample');
      return createNativeProvider({ ...args, rpc });
    } };
  assert.equal(await manager.main(['run', '--case', 'A', '--max-operations', '1', '--json'], { offline }), 1);
  const runId = (await fs.readdir(path.join(fixture.root, 'benchmark-temp'))).find(name => name.startsWith('run-'));
  const runRoot = path.join(fixture.root, 'benchmark-temp', runId);
  const state = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/case-state.json')));
  const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
  const summary = JSON.parse(await fs.readFile(path.join(runRoot, 'summary.json')));
  const failure = phase === 'initialize' ? state.terminal
    : JSON.parse(await fs.readFile(state.operations[0].evidencePath)).turn;
  assert.equal(failure.diagnostic ?? failure.error, 'App Server diagnostic limit exceeded');
  assert.equal(failure.blocker ?? failure.errorCode, 'NATIVE_TRANSPORT_UNPROVEN');
  assert.deepEqual(summary.cases.A.terminal.stderrSample, failure.stderrSample, 'sample reference is exposed in the public result');
  const sampleFile = path.join(runRoot, 'case-a/tmp/app-server-stderr-sample.txt');
  const sample = await fs.readFile(sampleFile);
  if (phase === 'turn-write-failure') {
    assert.deepEqual(failure.stderrSample, { status: 'unavailable' });
    assert.equal(sample.toString(), 'prior sample');
  } else {
    assert.deepEqual(failure.stderrSample, { status: 'retained', file: sampleFile });
    assert.ok(sample.includes(Buffer.from('failed to load skill'))); assert.ok(!sample.includes(Buffer.from('private-value')));
  }
  assert.ok(sample.length <= 1024);
  assert.equal(state.status, 'BLOCKED'); assert.equal(ledger.total, phase === 'initialize' ? 0 : 1);
  assert.equal(ledger.reservations.length, phase === 'initialize' ? 0 : 8,
    'uncertain dispatch retains auxiliary financial margin'); assert.equal(state.operations.length, phase === 'initialize' ? 0 : 1);
  if (phase !== 'initialize') assert.equal(ledger.turns[0].state, 'uncertain');
  assert.deepEqual(calls, phase === 'initialize' ? ['initialize'] : ['initialize', 'skills/extraRoots/set']);
  await assert.rejects(fs.lstat(state.specPath), { code: 'ENOENT' });
});

for (const [regime, fault] of [['fresh', null], ['author-continuity', null], ['fresh', 'interrupt-execute'], ['fresh', 'interrupt-close'], ['fresh', 'findings-cycle'], ['fresh', 'premature-verification'],['fresh','automatic-capture'],['fresh','formal-successor'],['fresh','formal-exhausted'], ['fresh','review-correction'], ['author-continuity','review-correction'], ['fresh','review-correction-aux'], ['fresh','review-correction-interrupt'], ...['review-correction-twice','review-correction-drift','review-correction-owner','review-correction-cas'].map(fault=>['fresh',fault]), ...['aux-before-reservation', 'aux-after-reservation', 'aux-after-formal', 'aux-followup', 'aux-followup-interrupt', 'aux-descendant', 'aux-run-eight'].map(fault => ['fresh', fault])]) test(`normal manager ${regime}/${fault}: public preparation through closed/export without managed`, async t => {
  const fixture = await allocateOfflineFixture(repo);
  t.after(async () => { await finishOfflineFixture(fixture); });
  const configurationPath = path.join(fixture.root, 'benchmarks/sentinel-todo/benchmark.json');
  const configuration = JSON.parse(await fs.readFile(configurationPath));
  configuration.contextPolicy = { regime, authorContinuityOperations: regime === 'fresh' ? [] : ['PLAN', 'EXECUTE_SLICE', 'SPEC_CLOSE'] };
  configuration.turnBudget.maxTurnsPerRun = 30;
  await fs.writeFile(configurationPath, JSON.stringify(configuration));
  const runRoot = path.join(fixture.root, 'benchmark-temp/run-native-offline');
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(path.join(runRoot, '.sentinel-benchmark-owned'), 'sentinel-todo-run-v2\n');
  const url = name => pathToFileURL(path.join(fixture.root, name)).href;
  const snapshot = await import(url('benchmarks/sentinel-todo/runtime/benchmark-snapshot.mjs'));
  const manager = await import(url('benchmarks/sentinel-todo/runtime/benchmark-manager.mjs'));
  const sdk = await describeOfflineSdk(await fs.realpath(path.join(repo, 'agents/codex/node_modules')), fixture.root);
  const metadata = await snapshot.createSnapshot(runRoot, { executionMode: 'OFFLINE_TEST_ONLY', offlineSdk: sdk });
  const product = await manager.loadProduct(path.join(runRoot, 'snapshot'));
  const serialize = product.serializePlanPathClaims;
  let serialized = 0;
  product.serializePlanPathClaims = async input => {
    const value = await serialize(input);
    if (++serialized === 1) {
      if (fault === 'review-correction-drift') await fs.appendFile(path.join(input.candidateExecutionRoot, 'plans/slice-01.md'), '\nExtra unreviewed draft content.\n');
      if (fault === 'review-correction-owner') {
        const markerFile = `${input.candidateExecutionRoot}.owner.json`, marker = JSON.parse(await fs.readFile(markerFile));
        marker.allocationId = '00000000-0000-4000-8000-000000000000'; await fs.writeFile(markerFile, JSON.stringify(marker));
      }
      if (fault === 'review-correction-cas') {
        await fs.mkdir(path.join(input.specPath, 'execution'));
        await fs.writeFile(path.join(input.specPath, 'execution/plan.md'), 'Foreign execution introduced after refusal.\n');
      }
    }
    return value;
  };
  let backend;
  const actualFactory = product.createNativeProvider;
  product.createNativeProvider = async args => {
    backend ??= offlineNativeWorkflow({ ...args, caseRoot: args.evidenceRoot, fault });
    return actualFactory({ ...args, rpc: backend.rpc, pollMs: 1 });
  };
  await manager.initializeTurnBudget(runRoot, configuration.turnBudget.maxTurnsPerRun);
  const inherited = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  let result;
  try {
    const args = { runRoot, caseId: 'A', configuration, snapshotMetadata: metadata,
      maxOperations: null, mode: 'case', product, signal: new AbortController().signal };
    result = await manager.runCase(args);
    if (fault?.startsWith('interrupt-') || fault === 'aux-followup-interrupt' || fault === 'review-correction-interrupt') {
      assert.equal(result.status, 'BLOCKED');
      const before = backend.calls.filter(call => call.method === 'turn/start').length;
      const prior = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/case-state.json')));
      assert.ok(prior.pendingObservation.dispatch.turnId);
      const firstEvidence = await fs.readFile(prior.operations.at(-1).evidencePath);
      const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
      assert.ok(ledger.turns.some(turn => turn.state === 'uncertain'));
      if (fault === 'interrupt-execute') assert.equal(ledger.reservations.length, 10,
        'uncertain parent retains all unused formal and auxiliary credits');
      if (fault === 'aux-followup-interrupt') assert.equal(ledger.reservations.length, 8,
        'both auxiliary turns and the formal first turn consume their distinct credits before interruption');
      result = await manager.runCase({ ...args, resume: true });
      assert.ok(firstEvidence.equals(await fs.readFile(prior.operations.at(-1).evidencePath)), 'first failed observation stays byte-identical');
      assert.equal(backend.calls.filter(call => call.method === 'turn/start').length, fault === 'review-correction-interrupt' ? 8 : 6,
        'observation resume must not start a replacement turn or rerun its recipe');
      assert.ok(before <= (fault === 'review-correction-interrupt' ? 8 : 6));
    }
  }
  finally { if (inherited !== undefined) process.env.NODE_TEST_CONTEXT = inherited; }
  const run = { runId: path.basename(runRoot), mode: 'case', cases: ['A'], profile: 'production-v3',
    status: result.status, snapshot: metadata, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
  await fs.writeFile(path.join(runRoot, 'run.json'), JSON.stringify(run));
  await fs.writeFile(path.join(runRoot, 'summary.json'), JSON.stringify({ ...run, cases: { A: result } }));
  if (fault === 'premature-verification') {
    assert.equal(result.status,'BLOCKED');
    assert.equal(backend.operations.some(item=>['VALIDATE_SLICE','SPEC_CLOSE'].includes(item.operation)),false);
    const calls=backend.calls.filter(call=>call.method==='turn/start');assert.equal(calls.length,4,'no successor after missing prepared tests');
    const state=JSON.parse(await fs.readFile(path.join(runRoot,'case-a/case-state.json')));
    await assert.rejects(fs.lstat(path.join(state.workspace,'src/native-filter.test.mjs')),{code:'ENOENT'});
    assert.ok((await fs.readFile(path.join(state.workspace,'src/cli.mjs'),'utf8')).includes('args.length === 0'));
    return;
  }
  if(fault==='formal-exhausted'){
    assert.equal(result.status,'BLOCKED');
    assert.equal(backend.operations.some(item=>item.operation==='SPEC_CLOSE'),false);
    const state=JSON.parse(await fs.readFile(path.join(runRoot,'case-a/case-state.json')));
    const formal=JSON.parse(await fs.readFile(state.operations.at(-1).evidencePath));
    assert.equal(formal.captureProof.matched,2);assert.equal(formal.captureProof.rejectedResponses.length,2);
    const ledger=JSON.parse(await fs.readFile(path.join(runRoot,'.turn-ledger.json')));
    assert.equal(ledger.total,8);assert.equal(ledger.reservations.length,0);
    return;
  }
  if (['review-correction-twice','review-correction-drift','review-correction-owner','review-correction-cas'].includes(fault)) {
    assert.equal(result.status, 'BLOCKED');
    const state = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/case-state.json')));
    const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
    const count = fault === 'review-correction-twice' ? 5 : 3;
    assert.equal(backend.calls.filter(call=>call.method==='turn/start').length, count,
      'invalid source/ownership blocks before admitting author correction; a second refusal never starts a third review');
    assert.equal(ledger.total, count); assert.equal(ledger.reservations.length, 0);
    assert.equal(backend.operations.some(item=>['EXECUTE_SLICE','SPEC_CLOSE'].includes(item.operation)), false);
    const refused = JSON.parse(await fs.readFile(state.operations[2].evidencePath));
    assert.equal(refused.outcome.result, 'NEEDS_FIX');
    if (fault === 'review-correction-twice') assert.deepEqual(state.terminal, { result: 'BLOCKED', blocker: 'PREPARATION_REVIEW_NOT_APPROVED' });
    return;
  }
  if(fault==='formal-successor'){
    const state=JSON.parse(await fs.readFile(path.join(runRoot,'case-a/case-state.json')));
    const formal=JSON.parse(await fs.readFile(state.operations.find(o=>o.operation==='VALIDATE_SLICE').evidencePath));
    assert.equal(formal.captureProof.matched,2);assert.equal(formal.captureProof.rejectedResponses.length,1);
    assert.equal(formal.turn.captures[0].toolResult.finalResponse.includes('Canonical task identity:'),true);
    const ledger=JSON.parse(await fs.readFile(path.join(runRoot,'.turn-ledger.json')));
    assert.equal(ledger.total,9);assert.equal(ledger.reservations.length,0);
  }
  assert.equal(result.status, 'PASS', JSON.stringify(result));
  const starts = backend.calls.filter(call => call.method === 'turn/start');
  assert.ok(starts.length > 0);
  for (const { params } of starts) {
    const skill = params.input.filter(item => item.type === 'skill');
    const text = params.input.filter(item => item.type === 'text');
    assert.equal(skill.length, 1); assert.equal(text.length, 1);
    assert.equal(skill[0].path, path.join(runRoot, 'snapshot/skills/workflows', skill[0].name, 'SKILL.md'));
    assert.ok(text[0].text.startsWith(`$${skill[0].name}\n`), 'normal explicit mention agrees with native skill item');
    const rawOperation = /^(?:OPERATION|MODE)=(.*)$/mu.exec(text[0].text)[1];
    const operation = { INIT: 'SPEC_INIT', CLOSE: 'SPEC_CLOSE', READINESS: 'SPEC_READINESS' }[rawOperation] ?? rawOperation;
    assert.ok(text[0].text.includes(`You are executing ${operation} as ${skill[0].name}.`));
    const turnIndex = backend.calls.findIndex(call => call.method === 'turn/start' && call.params === params);
    const contextRequest = backend.calls.slice(0, turnIndex).findLast(call => ['thread/start', 'thread/resume'].includes(call.method));
    const provenance = /^Context provenance: (thread\/(?:start|resume)); (.+)\.$/mu.exec(text[0].text);
    assert.equal(provenance[1], contextRequest.method, 'context description must match the actual public thread request');
    assert.equal(provenance[2], contextRequest.method === 'thread/start' ? 'no author thread resumed'
      : `author thread ${contextRequest.params.threadId}`);
    assert.match(text[0].text, /including the internal delegation required by its skill/u,
      'returning the handoff must preserve required checks inside the selected operation');
    assert.match(text[0].text, /external manager is the caller and invokes the next operation from your returned handoff/u);
    const temporaryDirectory = /^Temporary work directory: (.+)$/mu.exec(text[0].text)?.[1];
    assert.equal(temporaryDirectory, await fs.realpath(path.join(runRoot, 'case-a/tmp')),
      'every operation receives the actual already allocated case temporary directory');
    assert.match(text[0].text, /authored scratch files and author-selected lifecycle candidates/u);
    assert.match(text[0].text, /Keep registered candidates and operation controls at the repository-local paths returned by public producers/u);
    assert.match(text[0].text, /Pass both temporary-path rules to every delegated agent/u);
    assert.match(text[0].text, /Pass both temporary-path rules to every delegated agent/u,
      'the principal must transmit scratch and owned-allocation rules to auxiliaries and formal children');
    assert.match(text[0].text, /Do not choose external\/system temporary paths/u);
    if (['stnl-execution-planner', 'stnl-plan-reviewer'].includes(skill[0].name)) {
      const originalInput = text[0].text.match(/^Original requirements input: (.+)$/mu)?.[1];
      assert.equal(originalInput, path.join(runRoot, 'case-a/workspace/requirements.md'),
        'original context input must be distinct from the canonical Requirements source carrier');
      assert.doesNotMatch(text[0].text, /^Requirements source: /mu,
        'launcher must not label the original input as the canonical authority source');
    }
  }
  const extra = fault === 'findings-cycle' ? 2 : 0;
  const preparationExtra = fault?.startsWith('review-correction') ? 2 : 0;
  const refusalChild=fault==='formal-successor'?1:0;
  const auxiliaryCalls = fault === 'review-correction-aux' ? 3 : fault === 'aux-run-eight' ? 8
    : ['aux-followup', 'aux-followup-interrupt', 'aux-descendant'].includes(fault) ? 2 : fault?.startsWith('aux-') ? 1 : 0;
  assert.deepEqual(backend.operations.map(item => item.operation), ['SPEC_INIT', 'PLAN', 'REVIEW_PLAN',
    ...(preparationExtra ? ['PLAN', 'REVIEW_PLAN'] : []),
    'EXECUTE_SLICE', 'VALIDATE_SLICE', ...(extra ? ['APPLY_FINDINGS', 'VALIDATE_SLICE'] : []), 'SPEC_CLOSE'],
  'the manager follows each public handoff once, retaining the separate independent review');
  assert.equal(result.operations, 6 + extra + preparationExtra); assert.equal(result.runnerTurns, 2 + extra + refusalChild + auxiliaryCalls); assert.equal(result.mainTurns, 6 + extra + preparationExtra);
  const state = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/case-state.json')));
  if (preparationExtra) {
    const read = async index => JSON.parse(await fs.readFile(state.operations[index].evidencePath));
    const first = await read(2), correction = await read(3), second = await read(4);
    assert.deepEqual(first.outcome, { result: 'NEEDS_FIX', blocker: 'PREPARATION_REVIEW_NOT_APPROVED' });
    assert.match(first.turn.response, /Offline preparation review declined/u);
    assert.equal(first.officialReadback.execution.state, 'NO_EXECUTION');
    assert.equal(first.preparation.candidateExecutionRoot, correction.preparation.candidateExecutionRoot);
    assert.notEqual(first.preparation.authority.normativeSha256, correction.preparation.authority.normativeSha256);
    assert.equal(second.outcome.result, 'PASS');
    assert.notEqual(first.turn.threadId, second.turn.threadId);
    assert.equal(second.context.inheritedAuthorHistory, false);
    assert.notEqual(correction.turn.threadId, second.turn.threadId);
    const reviewPrompt = await fs.readFile(second.promptFile, 'utf8');
    assert.doesNotMatch(reviewPrompt, /Prior review feedback|Offline preparation review declined/u,
      'new independent reviewer receives canonical corrected artifacts, not prior judgment');
  }
  for (const operation of state.operations) {
    // The manager persists the exact launcher it sends, including the mention.
    const evidence = JSON.parse(await fs.readFile(operation.evidencePath));
    const prompt = await fs.readFile(evidence.promptFile, 'utf8');
    assert.ok(starts.some(call => call.params.input.some(item => item.type === 'text' && item.text === prompt)));
    assert.ok(prompt.includes(`SPEC_PATH=${state.specPath}`));
    assert.equal(evidence.promptSha256, `sha256:${createHash('sha256').update(prompt).digest('hex')}`);
  }
  if (fault === null && regime === 'fresh') {
    const read = async name => {
      const evidence = JSON.parse(await fs.readFile(state.operations.find(item => item.operation === name).evidencePath));
      return { ...evidence.officialReadback, preparation: evidence.preparation };
    };
    const plan = await read('PLAN'), review = await read('REVIEW_PLAN'), executed = await read('EXECUTE_SLICE');
    const ownedRoot = plan.preparation.candidateExecutionRoot;
    assert.ok(ownedRoot.startsWith(path.join(state.workspace, 'tmp', 'sentinel') + path.sep),
      'the public producer retains its registered allocation inside the product temporary root');
    assert.equal(ownedRoot.startsWith(path.join(runRoot, 'case-a/tmp') + path.sep), false,
      'a registered preparation is not relocated into the author-selected scratch directory');
    assert.equal(decideOutcome('PLAN', plan, true).result, 'PASS');
    assert.equal(decideOutcome('PLAN', { ...executed, preparation: plan.preparation }, true).result, 'BLOCKED');
    assert.equal(decideOutcome('REVIEW_PLAN', review, true).result, 'PASS');
    assert.equal(decideOutcome('REVIEW_PLAN', { ...executed, preparation: review.preparation }, true).result, 'BLOCKED',
      'an Initial review cannot approve a workflow already advanced into execution');
  }
  const raw = JSON.parse(await fs.readFile(state.finalizer.rawPath));
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const v1 = JSON.parse(await fs.readFile(path.join(repo, 'benchmarks/sentinel-todo/schemas/result.schema.json')));
  ajv.addSchema(v1, 'https://sentinel.local/schemas/result.schema.json');
  const validator = ajv.compile(JSON.parse(await fs.readFile(path.join(repo, 'benchmarks/sentinel-todo/schemas/result-v2.schema.json'))));
  assert.equal(validator(raw), true, JSON.stringify(validator.errors));
  assert.equal(raw.finalExecutionState, 'SPEC_CLOSED'); assert.equal(raw.specClosed, true);
  assert.equal(raw.productAcceptance.passed, true); assert.equal(raw.nativeTerminal.sourceActivationId.length, 36);
  assert.deepEqual(raw.contextPolicy, configuration.contextPolicy);
  await assert.rejects(fs.lstat(path.join(state.specPath, 'execution')), { code: 'ENOENT' });
  assert.equal(backend.calls.some(call => /account|login|config\/value/.test(call.method)), false);
  const authors = backend.operations.filter(item => ['SPEC_INIT', 'PLAN', 'EXECUTE_SLICE', 'SPEC_CLOSE'].includes(item.operation));
  assert.equal(new Set(authors.map(item => item.threadId)).size, regime === 'fresh' ? 4 + (preparationExtra ? 1 : 0) : 1);
  const reviews = backend.operations.filter(item => ['REVIEW_PLAN', 'VALIDATE_SLICE'].includes(item.operation));
  assert.equal(new Set(reviews.map(item => item.threadId)).size, 2 + (extra ? 1 : 0) + (preparationExtra ? 1 : 0));
  assert.ok(reviews.every(item => !authors.some(author => author.threadId === item.threadId)));
  const ledger = JSON.parse(await fs.readFile(path.join(runRoot, '.turn-ledger.json')));
  assert.equal(ledger.total, 8 + 2 * extra + preparationExtra + refusalChild + auxiliaryCalls); assert.equal(ledger.reservations.length, 0);
  assert.ok(ledger.turns.every(turn => turn.state === 'completed'));
  assert.equal(ledger.turns.filter(turn => turn.childKind === 'auxiliary').length, auxiliaryCalls);
  assert.equal(ledger.turns.filter(turn => turn.childKind === 'formal').length, 2 + extra + refusalChild);
  assert.equal(new Set(ledger.turns.filter(turn => turn.role === 'runner').map(turn => `${turn.threadId}:${turn.turnId}`)).size,
    2 + extra + refusalChild + auxiliaryCalls, 'each public child turn is charged once, including follow-ups');
  const terminal = JSON.parse(await fs.readFile(path.join(runRoot, 'case-a/terminal-evidence.json')));
  assert.equal(terminal.source.inspection.state, 'COMPLETE'); assert.equal(terminal.state, 'SPEC_CLOSED');
  const consumer = await import(url('benchmarks/sentinel-todo/runtime/native-evidence.mjs'));
  await consumer.validateTerminalEvidence({ product, evidence: terminal, specPath: state.specPath, workspace: state.workspace });
  for (const mutate of [
    value => { value.disposition = { kind: 'absent' }; value.receipt.sourceExecutionDisposition = { kind: 'absent' }; },
    value => { value.workspace = path.dirname(value.workspace); },
    value => { value.source.files = []; },
    value => { value.source.manifests = []; },
    value => { value.receipt.closedSnapshotSha256 = `sha256:${'0'.repeat(64)}`; },
    ...['outcome', 'terminalActivationId', 'deliveryId'].map(field => value => {
      const activation = JSON.parse(Buffer.from(value.source.activationBase64, 'base64'));
      activation.lastAttempt[field] = field === 'outcome' ? 'rejected' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      value.source.activationBase64 = Buffer.from(JSON.stringify(activation)).toString('base64');
      value.sourceSha256 = `sha256:${createHash('sha256').update(JSON.stringify(value.source)).digest('hex')}`;
    }),
  ]) {
    const forged = structuredClone(terminal); mutate(forged);
    await assert.rejects(consumer.validateTerminalEvidence({ product, evidence: forged,
      specPath: state.specPath, workspace: state.workspace }));
  }
  const measurements = await import(url('benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs'));
  const report = await measurements.exportMeasurement(path.basename(runRoot));
  assert.equal(report.cases[0].execution, 'SPEC_CLOSED');
  assert.deepEqual(report.comparability.contextPolicy, configuration.contextPolicy);
  assert.equal(report.provenance.executionMode, 'OFFLINE_TEST_ONLY');
  assert.equal(measurements.compareMeasurements(report, report).directlyComparable, false,
    'mechanical provider evidence cannot be promoted to real benchmark savings');
  if (regime === 'fresh' && fault === null) {
    const ledgerFile = path.join(runRoot, '.turn-ledger.json'), ledgerBytes = await fs.readFile(ledgerFile);
    for (const invalid of [null, '{broken', JSON.stringify({ ...JSON.parse(ledgerBytes), total: 99 }),
      JSON.stringify({ ...JSON.parse(ledgerBytes), turns: JSON.parse(ledgerBytes).turns.map((turn, index) => index ? turn : { ...turn, state: 'unknown' }) })]) {
      if (invalid === null) await fs.unlink(ledgerFile); else await fs.writeFile(ledgerFile, invalid);
      await assert.rejects(manager.main(['clean', '--run', path.basename(runRoot)]));
      await assert.rejects(measurements.exportMeasurement(path.basename(runRoot)));
      assert.ok((await fs.lstat(runRoot)).isDirectory(), 'invalid consumption proof cannot clean the run');
      await fs.writeFile(ledgerFile, ledgerBytes);
    }
    const retained = path.join(fixture.root, 'benchmark-temp/.retained', path.basename(runRoot));
    // Interrupt the actual final rename after the normal exporter completed.
    const rename = fs.rename;
    fs.rename = async (source, target) => {
      if (source === runRoot && target === retained) throw Object.assign(new Error('OFFLINE final retention interruption'), { code: 'EIO' });
      return rename(source, target);
    };
    try { await assert.rejects(manager.main(['clean', '--run', path.basename(runRoot)]), /OFFLINE final retention interruption/); }
    finally { fs.rename = rename; }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(runRoot, 'measurement-retained.json'))), report);
    assert.equal(await manager.main(['clean', '--run', path.basename(runRoot)]), 0);
    await assert.rejects(fs.lstat(runRoot), { code: 'ENOENT' });
    assert.ok((await fs.lstat(path.join(retained, 'case-a/terminal-evidence.json'))).isFile());
  }
});

test('literal manager entry parses ordinary run --case A and retains its normal Node metadata', async t => {
  const fixture = await allocateOfflineFixture(repo);
  t.after(async () => { await finishOfflineFixture(fixture); });
  const url = relative => pathToFileURL(path.join(fixture.root, relative)).href;
  const manager = await import(url('benchmarks/sentinel-todo/runtime/benchmark-manager.mjs'));
  const actual = (await import(url('agents/codex/runtime/native-provider.mjs'))).createNativeProvider;
  const sdk = await describeOfflineSdk(await fs.realpath(path.join(repo,'agents/codex/node_modules')),fixture.root);
  const backends = [];
  const offline = { mode: 'OFFLINE_TEST_ONLY', sdk, createNativeProvider: async args => {
    const backend = offlineNativeWorkflow({ ...args, caseRoot: args.evidenceRoot }); backends.push(backend);
    return actual({ ...args, rpc: backend.rpc, pollMs: 1 });
  } };
  const context = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  let runId;
  try {
    assert.equal(await manager.main(['run','--case','A','--max-operations','3','--json'], { offline }), 0);
    runId = (await fs.readdir(path.join(fixture.root,'benchmark-temp'))).find(name => name.startsWith('run-'));
    const stopped = JSON.parse(await fs.readFile(path.join(fixture.root,'benchmark-temp',runId,'run.json')));
    assert.equal(stopped.status,'FOCAL_STOP');
    assert.equal(await manager.main(['run','--resume',runId,'--json'], { offline }),0);
  }
  finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
  const info = JSON.parse(await fs.readFile(path.join(fixture.root,'benchmark-temp',runId,'run.json')));
  assert.equal(info.status,'PASS'); assert.equal(info.mode,'case'); assert.deepEqual(info.cases,['A']);
  const measurement = await import(url('benchmarks/sentinel-todo/runtime/benchmark-measurement.mjs'));
  const report = await measurement.exportMeasurement(runId);
  assert.equal(report.run.status,'PASS'); assert.equal(report.cases[0].execution,'SPEC_CLOSED');
  assert.equal(report.provenance.executionMode,'OFFLINE_TEST_ONLY');
  assert.equal(backends.length,2);
  assert.equal(backends.flatMap(backend => backend.calls).filter(call => call.method === 'turn/start').length,6);
  await assert.rejects(fs.lstat(path.join(fixture.root,'benchmark-temp/.active-run.json')),{code:'ENOENT'});
});

for (const fault of ['foreign-child','grandchildren','budget','unexpected-plan-child','aux-only','aux-run-nine','aux-run-eleven','aux-followup-twelve']) test(`normal entry blocks ${fault} without successor, refund or proof substitution`, async t => {
  const fixture = await allocateOfflineFixture(repo);
  t.after(async () => { await finishOfflineFixture(fixture); });
  const url = relative => pathToFileURL(path.join(fixture.root, relative)).href;
  const manager = await import(url('benchmarks/sentinel-todo/runtime/benchmark-manager.mjs'));
  const actual = (await import(url('agents/codex/runtime/native-provider.mjs'))).createNativeProvider;
  const sdk = await describeOfflineSdk(await fs.realpath(path.join(repo,'agents/codex/node_modules')),fixture.root);
  if (fault === 'budget') {
    const configPath = path.join(fixture.root,'benchmarks/sentinel-todo/benchmark.json');
    const configuration = JSON.parse(await fs.readFile(configPath)); configuration.turnBudget.maxTurnsPerRun = 4;
    await fs.writeFile(configPath,JSON.stringify(configuration));
  }
  let backend;
  const offline = { mode: 'OFFLINE_TEST_ONLY', sdk, createNativeProvider: async args => {
    backend ??= offlineNativeWorkflow({ ...args, caseRoot: args.evidenceRoot, fault });
    return actual({ ...args, rpc: backend.rpc, pollMs: 1 });
  } };
  const context = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  try {
    assert.notEqual(await manager.main(['run','--case','A','--json'], { offline }),0);
    const runId = (await fs.readdir(path.join(fixture.root,'benchmark-temp'))).find(name => name.startsWith('run-'));
    const runRoot = path.join(fixture.root,'benchmark-temp',runId);
    const file = path.join(runRoot,'case-a/case-state.json'), state = JSON.parse(await fs.readFile(file));
    assert.notEqual(state.status,'PASS'); assert.ok(!backend.operations.some(item => item.operation === 'SPEC_CLOSE'));
    const ledger = JSON.parse(await fs.readFile(path.join(runRoot,'.turn-ledger.json')));
    assert.equal(backend.calls.filter(call => call.method === 'turn/start').length,
      ['unexpected-plan-child', 'aux-run-eleven'].includes(fault) ? 2 : ['budget', 'aux-run-nine'].includes(fault) ? 3 : 4);
    if (fault === 'unexpected-plan-child') {
      assert.deepEqual(backend.operations.map(item => item.operation), ['SPEC_INIT', 'PLAN']);
      assert.equal(state.terminal.result, 'BLOCKED');
      const evidence = JSON.parse(await fs.readFile(state.operations.at(-1).evidencePath));
      assert.match(evidence.turn.error, /auxiliary turn failed\/interrupted/u);
      assert.equal(evidence.officialReadback.execution.state, 'NO_EXECUTION');
      assert.equal(ledger.total, 3); assert.equal(ledger.reservations.length, 7);
      const unexpected = ledger.turns.filter(turn => turn.childKind === 'pending');
      assert.equal(unexpected.length, 1);
      assert.equal(unexpected[0].operation, 'PLAN'); assert.equal(unexpected[0].state, 'dispatched',
        'the unverified child credit stays charged and unsettled');
      assert.equal(unexpected[0].agentPath, '/root/review_plan');
      await assert.rejects(manager.main(['clean','--run',runId]),/pending\/uncertain/);
    } else if (fault === 'aux-only') {
      const evidence = JSON.parse(await fs.readFile(state.operations.at(-1).evidencePath));
      assert.equal(evidence.turn.captures.length, 0, 'auxiliary advice cannot emit a formal ready envelope');
      assert.equal(evidence.outcome.blocker, 'OWNER_UNCERTAIN');
      assert.match(evidence.officialReadback.execution.error, /activeAttempt declares an unresolved or different owner/u);
      assert.equal(ledger.total, 5); assert.equal(ledger.reservations.length, 0);
      assert.equal(ledger.turns.filter(turn => turn.childKind === 'auxiliary').length, 1);
    } else if (fault === 'aux-run-nine') {
      assert.equal(ledger.total, 12, 'the ninth auxiliary is counted even though the boundary blocks');
      assert.equal(ledger.turns.filter(turn => turn.unadmitted).length, 1);
      assert.equal(ledger.turns.filter(turn => turn.childKind === 'auxiliary').length, 4);
      assert.ok(ledger.turns.some(turn => turn.state === 'uncertain'));
      assert.equal(ledger.reservations.length, 0);
    } else if (fault === 'aux-run-eleven') {
      assert.equal(ledger.total, 13, 'all eleven emitted children count even when the ninth triggers the refusal');
      assert.equal(ledger.turns.filter(turn => turn.unadmitted).length, 3);
      assert.equal(ledger.reservations.length, 0);
    } else if (fault === 'aux-followup-twelve') {
      assert.equal(ledger.total, 17, 'all twelve auxiliary turns plus the observed formal child count');
      assert.equal(ledger.turns.filter(turn => turn.unadmitted).length, 2);
      assert.equal(ledger.reservations.length, 0);
    } else if (fault === 'budget') {
      assert.equal(ledger.total,3); assert.equal(ledger.reservations.length,0);
    } else {
      assert.ok(ledger.turns.some(turn => turn.state === 'uncertain'));
      assert.equal(ledger.reservations.length, fault === 'grandchildren' ? 8 : 10);
      await assert.rejects(manager.main(['clean','--run',runId]),/pending\/uncertain/);
      if (fault === 'grandchildren') {
        assert.equal(ledger.turns.filter(turn => turn.childKind === 'formal').length,1);
        assert.equal(ledger.turns.filter(turn => turn.childKind === 'pending').length,2,
          'both observed descendants remain charged; designation alone grants no capture');
        const firstFile = state.operations.at(-1).evidencePath, first = await fs.readFile(firstFile);
        assert.notEqual(await manager.main(['run','--resume',runId,'--json'],{offline}),0);
        const after = JSON.parse(await fs.readFile(path.join(runRoot,'.turn-ledger.json')));
        assert.equal(after.total,ledger.total); assert.equal(after.turns.filter(turn => turn.childKind === 'pending').length,2);
        assert.equal(backend.calls.filter(call => call.method === 'turn/start').length,4);
        assert.ok(first.equals(await fs.readFile(firstFile)));
      }
    }
  } finally { if (context !== undefined) process.env.NODE_TEST_CONTEXT = context; }
});
