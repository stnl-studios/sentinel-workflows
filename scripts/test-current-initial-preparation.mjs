import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as initial from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs';
import { validateCurrentImage } from '../skills/workflows/stnl-execution-planner/runtime/execution-current.mjs';
import {
  REQUIREMENTS, DELIVERY_IDS, LIFECYCLE, STANDALONE, EXPECTED_PROJECTION,
  LEAF_1_PREIMAGE, LEAF_2_PREIMAGE, PREPARATION_PREIMAGE, GLOBAL_REVIEW_PREIMAGE,
  initialArtifacts, initialReview, initialEnvelope, rawOracle, projectedOracle,
} from './fixtures/current-initial-preparation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePaths = [
  'skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs',
  'skills/workflows/stnl-plan-reviewer/runtime/execution-preparation-current.mjs',
];
const kernelPaths = [
  'skills/workflows/stnl-execution-planner/runtime/execution-current.mjs',
  'skills/workflows/stnl-plan-reviewer/runtime/execution-current.mjs',
];
const bytes = text => Buffer.from(text, 'utf8');
const clone = value => structuredClone(value);
const reject = (action, code, label) => assert.throws(action, error => error?.code === code, `${label}: expected ${code}`);
const input = (artifacts = initialArtifacts(), context = LIFECYCLE) => ({context, requirementsAuthority: REQUIREMENTS, artifacts});
const sorted = values => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
function edit(artifacts, name, transform) {
  const result = new Map([...artifacts].map(([key, value]) => [key, Buffer.from(value)]));
  const original = result.get(name).toString('utf8'), revised = transform(original);
  assert.notEqual(revised, original, `${name}: mutation must apply`);
  result.set(name, bytes(revised));
  return result;
}
function editAll(artifacts, names, transform) {
  return names.reduce((current, name) => edit(current, name, transform), artifacts);
}
function canonicalOracle(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalOracle).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalOracle(value[key])}`).join(',')}}`;
}
function expectedAuthority(artifacts) {
  return {
    requirementsAuthority: REQUIREMENTS, preparationRevision: 1,
    normativeProjection: clone(EXPECTED_PROJECTION), normativeSha256: projectedOracle('preparation', PREPARATION_PREIMAGE),
    globalReviewAuthoritySha256: projectedOracle('global-review', GLOBAL_REVIEW_PREIMAGE),
    deliveries: DELIVERY_IDS.map((deliveryId, index) => ({slice: `slice-0${index + 1}`, deliveryId, localRevision: 1,
      authoritySha256: projectedOracle('delivery', index === 0 ? LEAF_1_PREIMAGE : LEAF_2_PREIMAGE)})),
    artifactHashes: sorted([...artifacts.keys()]).map(name => ({path: name, sha256: rawOracle(artifacts.get(name))})),
  };
}
function expectedSnapshot(artifacts, review) {
  const authority = expectedAuthority(artifacts);
  return {format: 'stnl-preparation-v3', preparationRevision: 1, requirementsAuthority: REQUIREMENTS,
    normativeSha256: authority.normativeSha256, normativeProjection: clone(EXPECTED_PROJECTION),
    globalReview: clone(review.globalReview),
    deliveries: authority.deliveries.map((item, index) => ({slice: item.slice, deliveryId: item.deliveryId,
      localRevision: 1, review: clone(review.deliveries[index].review)})), completed: [],
    reviewedArtifacts: authority.artifactHashes.map(item => ({path: item.path, sha256: item.sha256,
      utf8: artifacts.get(item.path).toString('utf8')}))};
}

function p01(api) {
  const artifacts = initialArtifacts(), review = initialReview(artifacts), request = input(artifacts);
  const before = new Map([...artifacts].map(([name, value]) => [name, Buffer.from(value)]));
  const authority = api.projectInitialPreparation(request);
  assert.deepEqual(authority, expectedAuthority(artifacts));
  assert.equal(authority.deliveries[0].deliveryId, DELIVERY_IDS[0]);
  assert.equal(authority.deliveries[1].slice, 'slice-02');
  assert.deepEqual(authority.normativeProjection.deliveries[1].dependencies, [DELIVERY_IDS[0]]);
  assert.equal(authority.normativeProjection.deliveries[0].obligations[0].contribution, 'partial');
  assert.equal(authority.normativeProjection.deliveries[1].obligations[0].fullOwner, 'slice-02');
  const approved = api.approveInitialPreparation({...request, review});
  const literalSnapshot = expectedSnapshot(artifacts, review), literalBytes = bytes(canonicalOracle(literalSnapshot) + '\n');
  assert.deepEqual(approved.authority, expectedAuthority(artifacts));
  assert.deepEqual(approved.snapshot, literalSnapshot);
  assert.deepEqual(approved.bytes, literalBytes);
  assert.equal(approved.sha256, rawOracle(literalBytes));
  assert.notEqual(approved.sha256, approved.authority.normativeSha256);
  assert.deepEqual(api.validateInitialApprovedPreparation({context: LIFECYCLE, requirementsAuthority: REQUIREMENTS,
    snapshotBytes: literalBytes}), approved);
  for (const [name, original] of before) assert.deepEqual(artifacts.get(name), original);
  assert.notStrictEqual(approved.snapshot.globalReview, review.globalReview);
  approved.snapshot.globalReview.summary = 'Changed returned object.';
  assert.equal(review.globalReview.summary, 'Fixture reviewer approved the supplied bytes.');
}

function p02(api) {
  const originalCwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const baseline = api.projectInitialPreparation(input(initialArtifacts(), LIFECYCLE));
    for (const [form, context] of [['lifecycle', LIFECYCLE], ['standalone', STANDALONE]]) {
      const artifacts = initialArtifacts({form}), before = new Map([...artifacts].map(([name, data]) => [name, Buffer.from(data)]));
      for (const physicalExecutionRoot of [context.logicalExecutionRoot,
        '/work/repo/tmp/sentinel/key/op/candidate', '/work/repo/tmp/sentinel/key/deeper/a/b/candidate']) {
        const candidate = {...context, physicalExecutionRoot};
        const projected = api.projectInitialPreparation(input(artifacts, candidate));
        assert.deepEqual(projected.normativeProjection, baseline.normativeProjection);
        assert.equal(projected.normativeSha256, baseline.normativeSha256);
        assert.equal(projected.globalReviewAuthoritySha256, baseline.globalReviewAuthoritySha256);
        assert.deepEqual(projected.deliveries, baseline.deliveries);
      }
      assert.equal(context.productRoot, '/work/repo');
      assert.equal(context.logicalAuthorityPath, form === 'lifecycle'
        ? '/work/repo/specs/pay/feature_spec.md' : '/work/repo/specs/pay/requirements.md');
      assert.equal(path.posix.resolve('/work/repo/specs/pay/execution/plans', '../../../../src'), '/work/repo/src');
      assert.equal(path.posix.resolve('/work/repo/specs/pay/requirements-execution/tasks', '../../../../src/pay.test.mjs'), '/work/repo/src/pay.test.mjs');
      for (const [name, original] of before) assert.deepEqual(artifacts.get(name), original);
    }
  } finally { process.chdir(originalCwd); }
}

function p03(api) {
  const draft = initialArtifacts({status: 'draft'}), draftAuthority = api.projectInitialPreparation(input(draft));
  assert.deepEqual(draftAuthority.normativeProjection, EXPECTED_PROJECTION);
  reject(() => api.approveInitialPreparation({...input(draft), review: initialReview(draft)}), 'STALE_APPROVAL', 'draft approval');
  const artifacts = initialArtifacts(), review = initialReview(artifacts);
  reject(() => api.approveInitialPreparation(input(artifacts)), 'STALE_APPROVAL', 'missing review');
  for (const [label, changed] of [
    ['coherent title', editAll(artifacts, ['plan.md', 'tasks.md', 'plans/slice-01.md', 'tasks/slice-01.md'],
      text => text.replaceAll('Foundation', 'Foundation Renamed'))],
    ['checklist', edit(artifacts, 'tasks/slice-01.md', text => text.replace('Implement the approved pay check', 'Implement the approved pay export check'))],
    ['Expected Files', edit(artifacts, 'tasks/slice-01.md', text => text.replace('Expected Files\n\n- `../../../../src/pay.mjs`',
      'Expected Files\n\n- `../../../../src/pay-next.mjs`'))],
    ['Objective/Strategy N', edit(artifacts, 'plan.md', text => text.replace('- Objective: Ship pay.\n- Strategy: Two deliveries.',
      '- Objective: Ship pay.  \n- Strategy: Two deliveries.  '))],
    ['final LF', edit(artifacts, 'plan.md', text => text + '\n')],
  ]) {
    const projected = api.projectInitialPreparation(input(changed));
    assert.equal(projected.normativeSha256, projectedOracle('preparation', PREPARATION_PREIMAGE), label);
    assert.equal(projected.globalReviewAuthoritySha256, projectedOracle('global-review', GLOBAL_REVIEW_PREIMAGE), label);
    if (label === 'Objective/Strategy N') {
      assert.deepEqual(projected.normativeProjection.global, EXPECTED_PROJECTION.global);
      assert.notEqual(projected.artifactHashes.find(item => item.path === 'plan.md').sha256, rawOracle(artifacts.get('plan.md')));
    }
    reject(() => api.approveInitialPreparation({...input(changed), review}), 'STALE_APPROVAL', label);
  }
  const changedObligation = edit(artifacts, 'tasks/slice-01.md', text => text.replace('condition: Pay export compiles', 'condition: Pay export compiles reliably'));
  const obligationAuthority = api.projectInitialPreparation(input(changedObligation));
  assert.notEqual(obligationAuthority.deliveries[0].authoritySha256, projectedOracle('delivery', LEAF_1_PREIMAGE));
  assert.notEqual(obligationAuthority.normativeSha256, projectedOracle('preparation', PREPARATION_PREIMAGE));
  const changedRecipe = editAll(artifacts, ['plans/slice-01.md', 'tasks/slice-01.md'],
    text => text.replace('"literal":"--test"', '"literal":"--run"'));
  const recipeAuthority = api.projectInitialPreparation(input(changedRecipe));
  assert.notEqual(recipeAuthority.deliveries[0].authoritySha256, projectedOracle('delivery', LEAF_1_PREIMAGE));
  assert.notEqual(recipeAuthority.normativeSha256, projectedOracle('preparation', PREPARATION_PREIMAGE));
}

function p04(api) {
  const original = initialArtifacts();
  const cases = [
    ['delivery identity', edit(original, 'tasks/slice-01.md', text => text.replace(DELIVERY_IDS[0], '99999999-9999-4999-8999-999999999999'))],
    ['local revision', edit(original, 'plans/slice-01.md', text => text.replace('- Local revision: 1', '- Local revision: 2'))],
    ['serial order', edit(original, 'tasks.md', text => text.replace('01 - Foundation', '01 - Other'))],
    ['dependency', editAll(original, ['plan.md', 'tasks.md', 'plans/slice-02.md'], text => {
      if (text.includes('| slice-01 | AC-001 |')) return text.replace('| slice-01 | AC-001 |', '| slice-02 | AC-001 |');
      if (text.includes('| slice-01 | tasks/slice-02.md |')) return text.replace('| slice-01 | tasks/slice-02.md |', '| slice-02 | tasks/slice-02.md |');
      return text.replace('Dependencies\n\n- slice-01', 'Dependencies\n\n- slice-02');
    })],
    ['full owner', edit(original, 'tasks/slice-02.md', text => text.replace('full owner: slice-02', 'full owner: slice-01'))],
    ['Plan/Task responsibility', edit(original, 'tasks/slice-01.md', text => text.replace('- Keep authentication unchanged.', '- Change authentication.'))],
    ['recipe differs', edit(original, 'tasks/slice-01.md', text => text.replace('"literal":"--test"', '"literal":"--run"'))],
  ];
  const missing = new Map(original); missing.delete('tasks/slice-02.md'); cases.push(['manifest', missing]);
  for (const [label, artifacts] of cases) reject(() => api.projectInitialPreparation(input(artifacts)), 'INVALID_CURRENT_IMAGE', label);
}

function p05(api) {
  const artifacts = initialArtifacts();
  reject(() => api.projectInitialPreparation({...input(artifacts), historical: true}), 'INVALID_CURRENT_IMAGE', 'extra option');
  const duplicate = edit(artifacts, 'plans/slice-01.md', text => text.replace('"format":"stnl-verification-recipe-v1"',
    '"format":"stnl-verification-recipe-v1","\\u0066ormat":"stnl-verification-recipe-v1"'));
  reject(() => api.projectInitialPreparation(input(duplicate)), 'INVALID_CURRENT_IMAGE', 'escaped duplicate JSON key');
  const nested = edit(artifacts, 'plans/slice-01.md', text => text.replace('"literal":"--test"',
    '"literal":"--test","\\u006citeral":"--test"'));
  reject(() => api.projectInitialPreparation(input(nested)), 'INVALID_CURRENT_IMAGE', 'nested duplicate JSON key');
  for (const [name, find, replacement] of [
    ['plan.md', 'owner: stnl-execution-planner', '__proto__: inert\nowner: stnl-execution-planner'],
    ['plan.md', '- Objective: Ship pay.', '- __proto__: inert\n- Objective: Ship pay.'],
    ['plans/slice-01.md', '- Slice: 01', '- __proto__: inert\n- Slice: 01'],
    ['tasks/slice-01.md', '- Current validation: unvalidated', '- __proto__: inert\n- Current validation: unvalidated'],
    ['plan.md', '- Objective: Ship pay.', '- Objective: Ship pay.\n- Objective: Ship pay.'],
  ]) {
    const malformed = edit(artifacts, name, text => text.replace(find, replacement));
    reject(() => api.projectInitialPreparation(input(malformed)), 'INVALID_CURRENT_IMAGE', `inline field ${name}: ${replacement}`);
  }
  let called = false;
  const accessor = input(artifacts);
  Object.defineProperty(accessor, 'context', {enumerable: true, get() { called = true; return LIFECYCLE; }});
  reject(() => api.projectInitialPreparation(accessor), 'INVALID_CURRENT_IMAGE', 'accessor'); assert.equal(called, false);
  const subclass = new (class extends Map {})(artifacts);
  reject(() => api.projectInitialPreparation(input(subclass)), 'INVALID_CURRENT_IMAGE', 'Map subclass');
  const ownProperty = new Map(artifacts); ownProperty.extra = 'not a carrier';
  reject(() => api.projectInitialPreparation(input(ownProperty)), 'INVALID_CURRENT_IMAGE', 'Map own property');
  const pathArray = editAll(artifacts, ['plans/slice-01.md', 'tasks/slice-01.md'], text => text.replace('"path":"../../../../src/pay.test.mjs"',
    '"path":["../../../../src/pay.test.mjs"]'));
  reject(() => api.projectInitialPreparation(input(pathArray)), 'INVALID_CURRENT_IMAGE', 'array recipe path');
  const badOwnerReview = initialReview(artifacts); badOwnerReview.deliveries[0].deliveryId = [DELIVERY_IDS[0]];
  reject(() => api.approveInitialPreparation({...input(artifacts), review: badOwnerReview}), 'INVALID_CURRENT_IMAGE', 'array review identity');
  const badUtf8 = new Map(artifacts); badUtf8.set('plan.md', Buffer.from([0xff]));
  reject(() => api.projectInitialPreparation(input(badUtf8)), 'INVALID_CURRENT_IMAGE', 'invalid UTF-8');
  const placeholder = edit(artifacts, 'plans/slice-01.md', text => text.replace('- Implement the pay export.', '- TODO'));
  reject(() => api.projectInitialPreparation(input(placeholder)), 'INVALID_CURRENT_IMAGE', 'placeholder');
  const historical = edit(artifacts, 'plan.md', text => text.replace('## Global Risks and Integration', '## Delivery Continuity\n\n- runtime\n\n## Global Risks and Integration'));
  reject(() => api.projectInitialPreparation(input(historical)), 'INVALID_CURRENT_IMAGE', 'historical section');
  const escaped = edit(artifacts, 'plans/slice-01.md', text => text.replace('Authorized Areas\n\n- directory: `../../../../src`',
    'Authorized Areas\n\n- directory: `../../../../../outside`'));
  reject(() => api.projectInitialPreparation(input(escaped)), 'UNSAFE_PATH', 'escaped area');
  for (const newline of ['\\n', '\\r']) {
    const command = editAll(artifacts, ['plans/slice-01.md', 'tasks/slice-01.md'],
      text => text.replace('"literal":"node"', `"literal":"node${newline}other"`));
    reject(() => api.projectInitialPreparation(input(command)), 'INVALID_CURRENT_IMAGE', `executable ${newline}`);
  }
}

function p06(api) {
  const lf = initialArtifacts(), crlf = initialArtifacts({newline: '\r\n'});
  const l = api.projectInitialPreparation(input(lf)), c = api.projectInitialPreparation(input(crlf));
  assert.deepEqual(l.normativeProjection, c.normativeProjection);
  assert.equal(l.normativeSha256, c.normativeSha256);
  assert.notEqual(l.artifactHashes[0].sha256, c.artifactHashes[0].sha256);
  reject(() => api.approveInitialPreparation({...input(crlf), review: initialReview(lf)}), 'STALE_APPROVAL', 'CRLF stale raw review');
  const approved = api.approveInitialPreparation({...input(crlf), review: initialReview(crlf)});
  assert.equal(approved.bytes.toString('utf8'), canonicalOracle(approved.snapshot) + '\n');
  assert.equal(approved.sha256, rawOracle(approved.bytes));
  const pretty = bytes(JSON.stringify(approved.snapshot, null, 2) + '\n');
  const readback = api.validateInitialApprovedPreparation({context: LIFECYCLE, requirementsAuthority: REQUIREMENTS,
    snapshotBytes: pretty});
  assert.deepEqual(readback.bytes, pretty);
  assert.equal(readback.sha256, rawOracle(pretty));
  assert.notEqual(readback.sha256, approved.sha256);
  assert.deepEqual(readback.snapshot, approved.snapshot);
  const wrongDomain = initialReview(lf);
  wrongDomain.deliveries[0].review.authoritySha256 = projectedOracle('preparation', PREPARATION_PREIMAGE);
  reject(() => api.approveInitialPreparation({...input(lf), review: wrongDomain}), 'STALE_APPROVAL', 'wrong hash domain');
  const validateSnapshot = snapshot => api.validateInitialApprovedPreparation({context: LIFECYCLE,
    requirementsAuthority: REQUIREMENTS, snapshotBytes: bytes(canonicalOracle(snapshot) + '\n')});
  const changedProjection = clone(approved.snapshot);
  changedProjection.normativeProjection.global.objective = 'A different pay objective.';
  changedProjection.normativeSha256 = projectedOracle('preparation', canonicalOracle(changedProjection.normativeProjection));
  reject(() => validateSnapshot(changedProjection), 'INVALID_CURRENT_IMAGE', 'snapshot projection differs from reviewed artifacts');
  const changedDeclaredHash = clone(approved.snapshot);
  changedDeclaredHash.normativeSha256 = rawOracle(bytes('a different declared preparation digest'));
  reject(() => validateSnapshot(changedDeclaredHash), 'INVALID_CURRENT_IMAGE', 'snapshot declared hash differs');
  const changedRawHash = clone(approved.snapshot);
  changedRawHash.reviewedArtifacts[0].sha256 = rawOracle(bytes('different reviewed bytes'));
  reject(() => validateSnapshot(changedRawHash), 'INVALID_CURRENT_IMAGE', 'snapshot raw artifact digest differs');
  const legacy = clone(approved.snapshot); legacy.format = 'stnl-preparation-v2';
  reject(() => validateSnapshot(legacy), 'MIGRATION_REQUIRED', 'snapshot v2 requires explicit migration');
  const noFormat = clone(approved.snapshot); delete noFormat.format;
  reject(() => validateSnapshot(noFormat), 'CURRENT_FORMAT_REQUIRED', 'snapshot format required');
  const unknownFormat = clone(approved.snapshot); unknownFormat.format = 'stnl-preparation-v99';
  reject(() => validateSnapshot(unknownFormat), 'UNSUPPORTED_FORMAT', 'snapshot unknown format');
}

function p07(api) {
  const artifacts = initialArtifacts(), review = initialReview(artifacts);
  const approved = api.approveInitialPreparation({...input(artifacts), review});
  const envelope = initialEnvelope(approved.bytes, artifacts);
  const image = validateCurrentImage({activationBytes: envelope.activationBytes, files: envelope.files});
  assert.equal(image.activation.normativeSha256, projectedOracle('preparation', PREPARATION_PREIMAGE));
  assert.deepEqual(image.continuity.deliveries.map(item => item.deliveryId), DELIVERY_IDS);
  assert.equal(image.continuity.nextSliceOrdinal, 3);
  assert.deepEqual(image.referencedObjects, []);
  assert.deepEqual(image.continuity.deliveries.map(item => item.counters), Array.from({length: 2}, () =>
    ({implementationChecks: 0, findingsChecks: 0, validationAttempts: 0, findings: 0})));
  assert.equal(envelope.files.has('evidence/' + DELIVERY_IDS[0] + '.json'), false);
}

const checks = [p01, p02, p03, p04, p05, p06, p07];
for (let index = 0; index < checks.length; index += 1) {
  test(`P0${index + 1} — initial EC-1 preparation`, () => checks[index](initial));
}
test('P08 — planner/reviewer copies import with only their L1 sibling', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-initial-isolated-'));
  try {
    const modules = await Promise.all(modulePaths.map(name => fs.readFile(path.join(root, name))));
    assert.equal(rawOracle(modules[0]), rawOracle(modules[1]));
    for (let i = 0; i < modules.length; i += 1) {
      const directory = path.join(temporary, String(i)); await fs.mkdir(directory);
      await fs.writeFile(path.join(directory, 'execution-preparation-current.mjs'), modules[i]);
      await fs.copyFile(path.join(root, kernelPaths[i]), path.join(directory, 'execution-current.mjs'));
      const api = await import(pathToFileURL(path.join(directory, 'execution-preparation-current.mjs')).href);
      assert.deepEqual(Object.keys(api).sort(), ['approveConversionPreparation', 'approveInitialPreparation',
        'projectConversionPreparation', 'projectInitialPreparation', 'validateConversionApprovedPreparation',
        'validateCurrentPreparation', 'validateInitialApprovedPreparation']);
      for (const [label, check] of [['P01', p01], ['P03', p03], ['P05', p05], ['P07', p07]]) {
        try { check(api); } catch (error) { error.message = `copy ${i + 1}, ${label}: ${error.message}`; throw error; }
      }
    }
  } finally { await fs.rm(temporary, {recursive: true, force: true}); }
});
