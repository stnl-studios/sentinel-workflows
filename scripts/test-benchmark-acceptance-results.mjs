import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { productInstrumentIdentity, PRODUCT_CONTRACT, PRODUCT_CHECK_IDS } from '../benchmarks/sentinel-todo/runtime/product-acceptance.mjs';
import { validateResult } from '../benchmarks/sentinel-todo/runtime/benchmark.mjs';

const runtime = path.resolve(import.meta.dirname, '../benchmarks/sentinel-todo/runtime/benchmark.mjs');
const phases = ['SPEC', 'PLAN', 'TASKS', 'EXECUTE', 'REVIEW_VALIDATE'];
// Synthetic report solely for validator tests; not workflow/native evidence.
function result(caseId = 'A') {
  return {
    schemaVersion: 2, benchmarkVersion: 1, benchmarkId: 'sentinel-todo', caseId, runMode: 'full',
    sentinelSha: 'a'.repeat(40), productionProfileId: 'production-v3', status: 'PASS',
    finalExecutionState: 'COMPLETE', specClosed: true, finalTestsPassed: true,
    decomposition: { slices: 0, tasks: 0, tasksPerSlice: {} },
    operations: Object.fromEntries(['total', 'reviewPlanRounds', 'reviewTasksRounds', 'replans', 'executeCalls', 'validateCalls',
      'applyFindingsCalls', 'findingsCycles', 'mechanicalRejections', 'retries', 'maturationCycles'].map(key => [key, 0])),
    modelUse: { expectedProfile: Object.fromEntries(phases.map(p => [p, { model: 'GPT-6.1-Sol', effort: 'high' }])),
      actualModelsByPhase: Object.fromEntries(phases.map(p => [p, []])), actualEffortsByPhase: Object.fromEntries(phases.map(p => [p, []])),
      childDispatches: [], profileMismatches: [], solEscalations: 0 },
    contextCost: { actualTokenTelemetryAvailable: false, planBytes: 0, planWords: 0, tasksBytes: 0, tasksWords: 0,
      handoffBytes: null, observableReads: null, inputTokens: null, outputTokens: null },
    workspace: { changedFileCount: 0, finalDiffBytes: 0, seedContentHash: `sha256:${'b'.repeat(64)}`,
      productRoot: '/TEST-ONLY/synthetic-workspace', productSha256: `sha256:${'d'.repeat(64)}`,
      requirementsHash: `sha256:${'c'.repeat(64)}`, observedSentinelSha: 'a'.repeat(40), requirementsHashMatches: true, sentinelShaMatchesCheckout: true },
    finalTests: { command: 'node --test', exitCode: 0, passed: true },
  };
}

async function compare(t, value) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-acceptance-result-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'synthetic-result.json');
  const output = path.join(root, 'comparison.md');
  await fs.writeFile(file, JSON.stringify(value));
  const child = spawnSync(process.execPath, [runtime, 'compare', '--before', file, '--after', file, '--output', output],
    { encoding: 'utf8', timeout: 10000 });
  return { child, output };
}

for (const caseId of ['A', 'B', 'C']) {
  test(`public compare rejects ${caseId} PASS without product acceptance before writing output`, async t => {
    const { child, output } = await compare(t, result(caseId));
    assert.notEqual(child.status, 0, child.stdout + child.stderr);
    assert.match(child.stderr, /productAcceptance/u);
    await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
  });
  test(`current ${caseId} acceptance passes API/public compare regardless of check ordering`, async t => {
    const value = result(caseId);
    value.productAcceptance = { contract: PRODUCT_CONTRACT, instrumentSha256: productInstrumentIdentity(), caseId,
      product: { root: value.workspace.productRoot, sha256: value.workspace.productSha256 },
      passed: true, checks: [...PRODUCT_CHECK_IDS[caseId]].reverse(), commands: 1, failedCheck: null, diagnostic: null, errorCode: null };
    assert.doesNotThrow(() => validateResult(value));
    const { child, output } = await compare(t, value);
    assert.equal(child.status, 0, child.stderr);
    assert.match(await fs.readFile(output, 'utf8'), /Sentinel Benchmark comparison/u);
  });
  for (const [name, mutate] of [
    ['null', value => { value.productAcceptance = null; }],
    ['foreign case', value => { value.productAcceptance.caseId = caseId === 'A' ? 'B' : 'A'; }],
    ['old contract', value => { value.productAcceptance.contract = 'sentinel-todo-product-v1'; }],
    ['missing check', value => { value.productAcceptance.checks.pop(); }],
    ['invented check', value => { value.productAcceptance.checks[0] = 'invented'; }],
    ['duplicate check', value => { value.productAcceptance.checks[1] = value.productAcceptance.checks[0]; }],
    ['wrong instrument', value => { value.productAcceptance.instrumentSha256 = `sha256:${'0'.repeat(64)}`; }],
    ['transplanted workspace', value => { value.productAcceptance.product.root = '/TEST-ONLY/another-candidate'; }],
    ['transplanted bytes', value => { value.productAcceptance.product.sha256 = `sha256:${'e'.repeat(64)}`; }],
    ['no commands', value => { value.productAcceptance.commands = 0; }],
    ['success with failed check', value => { value.productAcceptance.failedCheck = 'failure'; }],
    ['success with failure diagnostic', value => { value.productAcceptance.diagnostic = 'failure'; }],
    ['success with error code', value => { value.productAcceptance.errorCode = 'ERR'; }],
  ]) {
    test(`API/public compare refuse ${caseId} ${name} acceptance before output`, async t => {
      const value = result(caseId);
      value.productAcceptance = { contract: PRODUCT_CONTRACT, instrumentSha256: productInstrumentIdentity(), caseId,
        product: { root: value.workspace.productRoot, sha256: value.workspace.productSha256 },
        passed: true, checks: [...PRODUCT_CHECK_IDS[caseId]], commands: 1, failedCheck: null, diagnostic: null, errorCode: null };
      mutate(value);
      assert.throws(() => validateResult(value), /productAcceptance/u);
      const { child, output } = await compare(t, value);
      assert.notEqual(child.status, 0); assert.match(child.stderr, /productAcceptance/u);
      await assert.rejects(fs.lstat(output), { code: 'ENOENT' });
    });
  }
}

test('schema copies require the same v2 check sets as the runtime for every approved case/full', async () => {
  for (const name of ['result.schema.json', 'result-v2.schema.json']) {
    const schema = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, '../benchmarks/sentinel-todo/schemas', name), 'utf8'));
    assert.ok(schema.allOf[0].then.required.includes('productAcceptance'));
    assert.equal(schema.allOf[0].then.properties.productAcceptance.properties.contract.const, PRODUCT_CONTRACT);
    const definition = schema.$defs?.productAcceptance ?? JSON.parse(await fs.readFile(
      path.resolve(import.meta.dirname, '../benchmarks/sentinel-todo/schemas/result.schema.json'), 'utf8')).$defs.productAcceptance;
    const consistency = definition.allOf.find(rule => rule.if?.properties?.passed?.const === true);
    for (const field of ['failedCheck', 'diagnostic', 'errorCode']) assert.equal(consistency.then.properties[field].type, 'null');
    assert.equal(consistency.else.properties.failedCheck.type, 'string');
    assert.equal(consistency.else.properties.diagnostic.type, 'string');
    assert.ok(schema.allOf[0].then.properties.workspace.required.includes('productRoot'));
    assert.ok(schema.allOf[0].then.properties.workspace.required.includes('productSha256'));
    for (const caseId of ['A', 'B', 'C']) {
      const rule = schema.allOf.find(rule => rule.if?.properties?.caseId?.const === caseId && rule.if?.properties?.status?.const === 'PASS');
      const checks = rule.then.properties.productAcceptance.properties.checks;
      assert.deepEqual([...checks.items.enum].sort(), [...PRODUCT_CHECK_IDS[caseId]].sort());
      assert.equal(checks.minItems, PRODUCT_CHECK_IDS[caseId].length);
      assert.equal(checks.maxItems, PRODUCT_CHECK_IDS[caseId].length);
    }
  }
});
