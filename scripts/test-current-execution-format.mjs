import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as current from '../skills/workflows/stnl-execution-planner/runtime/execution-current.mjs';
import {
  ACTIVATION_ID, DELIVERY_ID, REQUIREMENTS_HASH, LEAF_CANON, GLOBAL_CANON,
  PREPARATION_PREIMAGE, GLOBAL_REVIEW_PREIMAGE, DELIVERY_PREIMAGE,
  minimalImage, imageWithBundle, completedImage, proofBundle, lifecycleContext, standaloneContext,
  rawReference, projectedReference,
} from './fixtures/current-execution-images.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePaths = [
  'skills/workflows/stnl-execution-planner/runtime/execution-current.mjs',
  'skills/workflows/stnl-plan-reviewer/runtime/execution-current.mjs',
  'skills/workflows/stnl-slice-executor/runtime/execution-current.mjs',
  'skills/workflows/stnl-slice-quality-manager/runtime/execution-current.mjs',
  'skills/workflows/stnl-spec-roadmap/runtime/execution-current.mjs',
  'skills/workflows/stnl-spec-test-runbook/runtime/execution-current.mjs',
  'skills/workflows/stnl-spec-lifecycle-manager/runtime/lib/execution-current.mjs',
];
const json = value => Buffer.from(JSON.stringify(value) + '\n', 'utf8');
const clone = value => structuredClone(value);
const rejects = (action, code) => assert.throws(action, error => error?.code === code, `expected ${code}`);
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const projectionHash = (tag, literal) => sha(Buffer.concat([
  Buffer.from(`stnl-ec1/${tag}/v1`, 'utf8'), Buffer.from([0]), Buffer.from(literal, 'utf8'),
]));

function reseal(image) {
  image.files.set('approved-preparation.json', json(image.preparation));
  image.files.set('continuity.json', json(image.continuity));
  image.activation.approvedSnapshotSha256 = sha(image.files.get('approved-preparation.json'));
  image.activation.artifacts = [...image.files.keys()].sort().map(name => ({path: name, sha256: sha(image.files.get(name))}));
  image.activationBytes = json(image.activation);
  return image;
}
function fixtureWithEvidence(bundle) { return imageWithBundle(bundle); }
function managedBundle() {
  const bundle = proofBundle(), id = bundle.objects[0].id;
  bundle.validation.origin.transport = 'managed';
  bundle.validation.sources = {
    transport: 'managed', rawResponse: id, receipt: id, verificationObservation: id,
    started: id, events: id, closedSupervisor: id, runtimeIdentity: [id], removalProofs: [], legacyPreparation: null,
  };
  return bundle;
}
function rejectionSupport(bundle) {
  const origin = clone(bundle.validation.origin);
  origin.operationAttemptId = '77777777-7777-4777-8777-777777777777';
  return {
    kind: 'rejection', operationAttemptId: origin.operationAttemptId, origin,
    diagnostic: 'Concluded malformed response retained.', consumedInvocations: 1, round: 1,
    sources: {...clone(bundle.validation.sources), verificationObservation: null},
  };
}
function b1(api) {
  const image = minimalImage();
  const expectedPreimages = [PREPARATION_PREIMAGE, GLOBAL_REVIEW_PREIMAGE, DELIVERY_PREIMAGE];
  for (const literal of expectedPreimages) assert.equal(typeof literal, 'string');
  assert.equal(sha(Buffer.from('abc')), 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(sha(Buffer.from('abc\n')), sha(Buffer.from('abc')));
  assert.equal(Buffer.from('{"a":1,"b":2}').toString('hex'), '7b2261223a312c2262223a327d');
  assert.equal(Buffer.concat([Buffer.from('stnl-ec1/preparation/v1'), Buffer.from([0]), Buffer.from('{"a":1,"b":2}')]).toString('hex'),
    '73746e6c2d6563312f7072657061726174696f6e2f7631007b2261223a312c2262223a327d');
  assert.equal(image.preparation.normativeSha256, projectionHash('preparation', PREPARATION_PREIMAGE));
  assert.equal(image.preparation.globalReview.authoritySha256, projectionHash('global-review', GLOBAL_REVIEW_PREIMAGE));
  assert.equal(image.preparation.deliveries[0].review.authoritySha256, projectionHash('delivery', DELIVERY_PREIMAGE));
  assert.equal(image.continuity.deliveries[0].authoritySha256, projectionHash('delivery', DELIVERY_PREIMAGE));
  assert.deepEqual(Object.keys(image.preparation.normativeProjection).sort(), ['completed', 'deliveries', 'format', 'global', 'requirementsAuthority']);
  assert.equal(image.preparation.normativeProjection.deliveries[0].deliveryId, DELIVERY_ID);
  assert.equal(image.activation.activationId, ACTIVATION_ID);
  assert.equal(image.activation.requirementsAuthority, REQUIREMENTS_HASH);
  assert.equal(image.preparation.normativeProjection.deliveries[0].verificationRecipe.checks[0].args[1].file.path,
    '../../../../src/pay.test.mjs');
  if (process.platform !== 'win32') assert.equal(api.resolveLogicalProductClaim(lifecycleContext(), 'tasks/slice-01.md',
    image.preparation.normativeProjection.deliveries[0].verificationRecipe.checks[0].args[1].file.path), '/work/repo/src/pay.test.mjs');
  assert.deepEqual(image.activation.artifacts.map(item => item.path), [
    'approved-preparation.json', 'continuity.json', 'plan.md', 'plans/slice-01.md', 'tasks.md', 'tasks/slice-01.md',
  ]);
  assert.deepEqual(Object.keys(api).sort(), [
    'currentDeliveryAuthoritySha256', 'currentEvidenceLastAttempt', 'currentOperationBindingSha256', 'currentTerminalProjection', 'logicalArtifactPath', 'parseCurrentJson', 'resolveLogicalProductClaim',
    'validateCurrentAbortDisposition', 'validateCurrentActivation', 'validateCurrentCandidate', 'validateCurrentContinuity', 'validateCurrentEvidence', 'validateCurrentImage', 'validateCurrentTerminalProjection',
  ]);
  assert.deepEqual(api.validateCurrentImage({activationBytes: image.activationBytes, files: image.files}), {
    activation: image.activation, continuity: image.continuity, referencedObjects: [],
  });
  assert.deepEqual(api.parseCurrentJson('{"b":2,"a":1}'), {b: 2, a: 1});
  const owner = {
    operationAttemptId: '33333333-3333-4333-8333-333333333333', ownershipToken: '44444444-4444-4444-8444-444444444444',
    deliveryId: DELIVERY_ID, slice: 'slice-01', operation: 'EXECUTE_SLICE', preparationRevision: 1, localRevision: 1,
    normativeSha256: image.activation.normativeSha256, originActivationId: ACTIVATION_ID,
    operationRef: {operationId: '55555555-5555-4555-8555-555555555555', allocationSha256: sha(Buffer.from('immutable binding'))},
  };
  image.activation.activeAttempt = owner; image.activationBytes = json(image.activation);
  assert.equal(api.validateCurrentImage({activationBytes: image.activationBytes, files: image.files}).activation.activeAttempt.operationAttemptId,
    owner.operationAttemptId);
  owner.deliveryId = '66666666-6666-4666-8666-666666666666'; image.activationBytes = json(image.activation);
  rejects(() => api.validateCurrentImage({activationBytes: image.activationBytes, files: image.files}), 'INVALID_CURRENT_IMAGE');
}

function b2(api) {
  const originalCwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    if (process.platform === 'win32') {
      const base = {
        logicalSpecRoot: 'C:\\work\\repo\\specs\\pay', logicalAuthorityPath: 'C:\\work\\repo\\specs\\pay\\feature_spec.md',
        logicalExecutionRoot: 'C:\\work\\repo\\specs\\pay\\execution', productRoot: 'C:\\work\\repo',
      };
      for (const physicalExecutionRoot of [base.logicalExecutionRoot, 'C:\\work\\repo\\tmp\\sentinel\\key\\op\\candidate', 'C:\\work\\repo\\tmp\\sentinel\\key\\deep\\a\\candidate']) {
        const context = {...base, physicalExecutionRoot}, before = clone(context);
        assert.equal(api.logicalArtifactPath(context, 'tasks/slice-01.md'), 'C:\\work\\repo\\specs\\pay\\execution\\tasks\\slice-01.md');
        assert.equal(api.resolveLogicalProductClaim(context, 'tasks/slice-01.md', '../../../../src/pay.mjs'), 'C:\\work\\repo\\src\\pay.mjs');
        assert.deepEqual(context, before);
      }
      const standalone = {
        logicalSpecRoot: null, logicalAuthorityPath: 'C:\\work\\repo\\requirements.md',
        logicalExecutionRoot: 'C:\\work\\repo\\requirements-execution',
        physicalExecutionRoot: 'C:\\work\\repo\\requirements-execution', productRoot: 'C:\\work\\repo',
      };
      assert.equal(api.resolveLogicalProductClaim(standalone, 'tasks/slice-01.md', '../../src/pay.mjs'), 'C:\\work\\repo\\src\\pay.mjs');
      return;
    }
    for (const physical of [undefined, '/work/repo/tmp/sentinel/key/op/candidate', '/work/repo/tmp/sentinel/key/deeper/a/b/candidate']) {
      const context = lifecycleContext(physical), before = clone(context);
      assert.equal(api.logicalArtifactPath(context, 'tasks/slice-01.md'), '/work/repo/specs/pay/execution/tasks/slice-01.md');
      assert.equal(api.resolveLogicalProductClaim(context, 'tasks/slice-01.md', '../../../../src/pay.mjs'), '/work/repo/src/pay.mjs');
      assert.deepEqual(context, before);
    }
    const standalone = standaloneContext();
    assert.equal(api.resolveLogicalProductClaim(standalone, 'tasks/slice-01.md', '../../src/pay.mjs'), '/work/repo/src/pay.mjs');
  } finally { process.chdir(originalCwd); }
}

function b3(api) {
  const context = process.platform === 'win32' ? {
    logicalSpecRoot: 'C:\\work\\repo\\specs\\pay', logicalAuthorityPath: 'C:\\work\\repo\\specs\\pay\\feature_spec.md',
    logicalExecutionRoot: 'C:\\work\\repo\\specs\\pay\\execution', physicalExecutionRoot: 'C:\\work\\repo\\specs\\pay\\execution', productRoot: 'C:\\work\\repo',
  } : lifecycleContext();
  const artifact = 'tasks/slice-01.md';
  for (const bad of [context.logicalExecutionRoot + path.sep + artifact.replaceAll('/', path.sep), 'execution/tasks/slice-01.md',
    '../tasks/slice-01.md', 'evidence/' + DELIVERY_ID + '.json', 'tasks\\slice-01.md', 'tasks//slice-01.md', 'slice-01.md', 'plans/slice-00.md']) {
    rejects(() => api.logicalArtifactPath(context, bad), 'UNSAFE_PATH');
    rejects(() => api.resolveLogicalProductClaim(context, bad, 'src/pay.mjs'), 'UNSAFE_PATH');
  }
  for (const bad of ['../../../../../outside.mjs', '../../../../src/../pay.mjs', 'C:/src/pay.mjs', './pay.mjs',
    'src//pay.mjs', 'src\\pay.mjs', '/work/repo/src/pay.mjs', 'src/pay.mjs/', '.', '']) {
    rejects(() => api.resolveLogicalProductClaim(context, artifact, bad), 'UNSAFE_PATH');
  }
  for (const change of [
    {logicalAuthorityPath: process.platform === 'win32' ? 'C:\\work\\repo\\other.md' : '/work/repo/other.md'},
    {logicalExecutionRoot: process.platform === 'win32' ? 'C:\\work\\repo\\other-execution' : '/work/repo/other-execution'},
    {productRoot: process.platform === 'win32' ? 'C:\\work\\repo-extra' : '/work/repo-extra'},
    {physicalExecutionRoot: context.logicalSpecRoot},
    {logicalAuthorityPath: 'relative.md'},
  ]) rejects(() => api.logicalArtifactPath({...context, ...change}, artifact), 'UNSAFE_PATH');
  rejects(() => api.parseCurrentJson('{"a":1,"a":2}'), 'INVALID_CURRENT_IMAGE');
  rejects(() => api.parseCurrentJson('{"a":"\\ud800"}'), 'INVALID_CURRENT_IMAGE');
  rejects(() => api.parseCurrentJson('{"n":1e999}'), 'INVALID_CURRENT_IMAGE');
  rejects(() => api.parseCurrentJson('{"n":-0}'), 'INVALID_CURRENT_IMAGE');
  const unknown = minimalImage(); unknown.files.set('unknown.json', Buffer.from('{}'));
  rejects(() => api.validateCurrentImage({activationBytes: unknown.activationBytes, files: unknown.files}), 'INVALID_CURRENT_IMAGE');
  const mixed = minimalImage(); mixed.preparation.format = 'stnl-preparation-v2'; reseal(mixed);
  rejects(() => api.validateCurrentImage({activationBytes: mixed.activationBytes, files: mixed.files}), 'UNSUPPORTED_FORMAT');
  const wrongKind = minimalImage(); wrongKind.preparation.format = 'stnl-current-evidence-v1'; reseal(wrongKind);
  rejects(() => api.validateCurrentImage({activationBytes: wrongKind.activationBytes, files: wrongKind.files}), 'INVALID_CURRENT_IMAGE');
  const unsupported = minimalImage(); unsupported.activation.format = 'foreign-format'; unsupported.activationBytes = json(unsupported.activation);
  rejects(() => api.validateCurrentImage({activationBytes: unsupported.activationBytes, files: unsupported.files}), 'UNSUPPORTED_FORMAT');
  const noVersion = minimalImage(); delete noVersion.activation.format; noVersion.activationBytes = json(noVersion.activation);
  rejects(() => api.validateCurrentImage({activationBytes: noVersion.activationBytes, files: noVersion.files}), 'CURRENT_FORMAT_REQUIRED');
  const invalidUtf8 = minimalImage(); invalidUtf8.files.set('continuity.json', Buffer.from([0xff]));
  invalidUtf8.activation.artifacts.find(item => item.path === 'continuity.json').sha256 = sha(invalidUtf8.files.get('continuity.json'));
  invalidUtf8.activationBytes = json(invalidUtf8.activation);
  rejects(() => api.validateCurrentImage({activationBytes: invalidUtf8.activationBytes, files: invalidUtf8.files}), 'INVALID_CURRENT_IMAGE');
  const invalidMarkdown = minimalImage(); invalidMarkdown.files.set('plan.md', Buffer.from([0xff]));
  invalidMarkdown.activation.artifacts.find(item => item.path === 'plan.md').sha256 = sha(invalidMarkdown.files.get('plan.md'));
  invalidMarkdown.activationBytes = json(invalidMarkdown.activation);
  rejects(() => api.validateCurrentImage({activationBytes: invalidMarkdown.activationBytes, files: invalidMarkdown.files}), 'INVALID_CURRENT_IMAGE');
  const badRecipe = proofBundle();
  badRecipe.validation.contract.delivery.verificationRecipe.checks[0].args[1].file.path = 'src/../pay.test.mjs';
  badRecipe.validation.contract.recipe.checks[0].args[1].file.path = 'src/../pay.test.mjs';
  rejects(() => api.validateCurrentEvidence(badRecipe), 'INVALID_CURRENT_IMAGE');
  for (const executable of ['node\nother', 'node\rother']) {
    const badExecutable = proofBundle();
    badExecutable.validation.contract.delivery.verificationRecipe.checks[0].executable.literal = executable;
    badExecutable.validation.contract.recipe.checks[0].executable.literal = executable;
    rejects(() => api.validateCurrentEvidence(badExecutable), 'INVALID_CURRENT_IMAGE');
  }
  let getterCalled = false;
  const accessor = clone(minimalImage().activation);
  Object.defineProperty(accessor, 'format', {enumerable: true, get() { getterCalled = true; return 'stnl-execution-activation-v2'; }});
  rejects(() => api.validateCurrentActivation(accessor), 'INVALID_CURRENT_IMAGE');
  assert.equal(getterCalled, false);
  const accessorArray = clone(minimalImage().continuity);
  Object.defineProperty(accessorArray.deliveries, '0', {enumerable: true, configurable: true, get() { getterCalled = true; return {}; }});
  rejects(() => api.validateCurrentContinuity(accessorArray), 'INVALID_CURRENT_IMAGE');
  assert.equal(getterCalled, false);
  const exotic = clone(minimalImage().activation); Object.setPrototypeOf(exotic, Date.prototype);
  rejects(() => api.validateCurrentActivation(exotic), 'INVALID_CURRENT_IMAGE');
  const nonStringPath = clone(minimalImage().activation); nonStringPath.artifacts[0].path = ['approved-preparation.json'];
  rejects(() => api.validateCurrentActivation(nonStringPath), 'INVALID_CURRENT_IMAGE');
  const nonStringEvidencePath = proofBundle(); nonStringEvidencePath.logicalTaskPath = ['tasks/slice-01.md'];
  rejects(() => api.validateCurrentEvidence(nonStringEvidencePath), 'INVALID_CURRENT_IMAGE');
  const nonStringEvidenceRef = clone(minimalImage().continuity);
  nonStringEvidenceRef.deliveries[0].evidence = {path: [`evidence/${DELIVERY_ID}.json`], sha256: sha(Buffer.from('raw'))};
  rejects(() => api.validateCurrentContinuity(nonStringEvidenceRef), 'INVALID_CURRENT_IMAGE');
  rejects(() => api.logicalArtifactPath(context, ['tasks/slice-01.md']), 'UNSAFE_PATH');
  let coerced = false;
  const pathObject = {toString() { coerced = true; return 'tasks/slice-01.md'; }};
  rejects(() => api.logicalArtifactPath(context, pathObject), 'UNSAFE_PATH');
  assert.equal(coerced, false);
  const ownerArray = proofBundle(); ownerArray.validation.contract.delivery.obligations[0].fullOwner = ['slice-01'];
  rejects(() => api.validateCurrentEvidence(ownerArray), 'INVALID_CURRENT_IMAGE');
  const ownerObject = proofBundle(); ownerObject.validation.contract.delivery.obligations[0].fullOwner = {
    toString() { coerced = true; return 'slice-01'; },
  };
  rejects(() => api.validateCurrentEvidence(ownerObject), 'INVALID_CURRENT_IMAGE');
  assert.equal(coerced, false);
  const accessorContext = {...context};
  Object.defineProperty(accessorContext, 'productRoot', {enumerable: true, get() { getterCalled = true; return context.productRoot; }});
  rejects(() => api.logicalArtifactPath(accessorContext, artifact), 'UNSAFE_PATH');
  assert.equal(getterCalled, false);
}

function b4(api) {
  const bundle = proofBundle({externalLiteral: '/legacy/receipt/only-a-literal.json'});
  const image = fixtureWithEvidence(bundle);
  const result = api.validateCurrentImage({activationBytes: image.activationBytes, files: image.files});
  assert.deepEqual(result.referencedObjects, [bundle.objects[0].id]);
  assert.match(bundle.validation.recordUtf8, /\/legacy\/receipt\/only-a-literal\.json/u);
  assert.equal(image.files.has('/legacy/receipt/only-a-literal.json'), false);
  assert.deepEqual(api.validateCurrentEvidence(bundle), bundle);
  const managed = managedBundle(), managedImage = fixtureWithEvidence(managed);
  rejects(()=>api.validateCurrentImage({activationBytes:managedImage.activationBytes,files:managedImage.files}),'UNSUPPORTED_FORMAT');
  rejects(()=>api.validateCurrentEvidence(managed),'UNSUPPORTED_FORMAT');
  const rejected = proofBundle(); rejected.support.push(rejectionSupport(rejected));
  assert.deepEqual(api.validateCurrentEvidence(rejected), rejected);
  const rejectedImage = fixtureWithEvidence(rejected);
  assert.equal(api.validateCurrentImage({activationBytes: rejectedImage.activationBytes, files: rejectedImage.files}).continuity.deliveries[0].counters.validationAttempts, 1);

}

function b5(api) {
  const base = proofBundle();
  const rawChanged = clone(base); rawChanged.objects[0].bytesBase64 = Buffer.from('abc\n').toString('base64');
  const rawImage = fixtureWithEvidence(rawChanged);
  rejects(() => api.validateCurrentImage({activationBytes: rawImage.activationBytes, files: rawImage.files}), 'EVIDENCE_INCOMPLETE');
  assert.equal(sha(Buffer.from('abc')), rawReference(Buffer.from('abc')));
  assert.notEqual(sha(Buffer.from('abc')), sha(Buffer.from('abc\n')));
  const newline = clone(base); newline.objects[0].id = sha(Buffer.from('abc\n'));
  newline.objects[0].bytesBase64 = Buffer.from('abc\n').toString('base64');
  for (const key of ['rawResponse', 'receipt', 'verificationObservation', 'origin', 'agentBinding', 'concludedToolResult']) {
    newline.validation.sources[key] = newline.objects[0].id;
  }
  const newlineImage = fixtureWithEvidence(newline);
  assert.deepEqual(api.validateCurrentImage({activationBytes: newlineImage.activationBytes, files: newlineImage.files}).referencedObjects,
    [sha(Buffer.from('abc\n'))]);
  const missing = clone(base); missing.objects = [];
  const missingImage = fixtureWithEvidence(missing);
  rejects(() => api.validateCurrentImage({activationBytes: missingImage.activationBytes, files: missingImage.files}), 'EVIDENCE_INCOMPLETE');
  const orphan = clone(base); orphan.objects.push({id: sha(Buffer.from('orphan')), bytesBase64: Buffer.from('orphan').toString('base64')});
  orphan.objects.sort((a, b) => a.id < b.id ? -1 : 1);
  const orphanImage = fixtureWithEvidence(orphan);
  rejects(() => api.validateCurrentImage({activationBytes: orphanImage.activationBytes, files: orphanImage.files}), 'EVIDENCE_INCOMPLETE');
  const twoObjects = clone(base);
  const secondId = sha(Buffer.from('second raw source'));
  twoObjects.validation.sources.receipt = secondId;
  twoObjects.objects.push({id: secondId, bytesBase64: Buffer.from('second raw source').toString('base64')});
  twoObjects.objects.sort((a, b) => a.id < b.id ? -1 : 1);
  const orderedImage = fixtureWithEvidence(twoObjects);
  assert.deepEqual(api.validateCurrentImage({activationBytes: orderedImage.activationBytes, files: orderedImage.files}).referencedObjects,
    [base.objects[0].id, secondId].sort());
  twoObjects.objects.reverse();
  const unorderedImage = fixtureWithEvidence(twoObjects);
  rejects(() => api.validateCurrentImage({activationBytes: unorderedImage.activationBytes, files: unorderedImage.files}), 'INVALID_CURRENT_IMAGE');
  const external = clone(base); external.validation.sources.receipt = '/legacy/receipt.json';
  const externalImage = fixtureWithEvidence(external);
  rejects(() => api.validateCurrentImage({activationBytes: externalImage.activationBytes, files: externalImage.files}), 'INVALID_CURRENT_IMAGE');
  const absentRef = clone(base); absentRef.validation.sources.receipt = sha(Buffer.from('not supplied'));
  const absentRefImage = fixtureWithEvidence(absentRef);
  rejects(() => api.validateCurrentImage({activationBytes: absentRefImage.activationBytes, files: absentRefImage.files}), 'EVIDENCE_INCOMPLETE');
  const managedMissing = managedBundle(); delete managedMissing.validation.sources.closedSupervisor;
  rejects(() => api.validateCurrentEvidence(managedMissing), 'UNSUPPORTED_FORMAT');
  const managedAbsent = managedBundle(); managedAbsent.validation.sources.closedSupervisor = sha(Buffer.from('missing close'));
  rejects(() => api.validateCurrentEvidence(managedAbsent), 'UNSUPPORTED_FORMAT');
  const normalWithoutObservation = proofBundle(); normalWithoutObservation.validation.sources.verificationObservation = null;
  rejects(() => api.validateCurrentEvidence(normalWithoutObservation), 'INVALID_CURRENT_IMAGE');
  const rejectionMissing = proofBundle(); rejectionMissing.support.push(rejectionSupport(rejectionMissing));
  delete rejectionMissing.support[0].sources.concludedToolResult;
  rejects(() => api.validateCurrentEvidence(rejectionMissing), 'INVALID_CURRENT_IMAGE');
  const rawFile = minimalImage(); rawFile.files.set('plan.md', Buffer.from('# Current plan\n\n')); // one raw byte changes the manifest hash
  rejects(() => api.validateCurrentImage({activationBytes: rawFile.activationBytes, files: rawFile.files}), 'INVALID_CURRENT_IMAGE');
  const reordered = minimalImage();
  reordered.preparation.normativeProjection = {
    requirementsAuthority: REQUIREMENTS_HASH, global: {...reordered.preparation.normativeProjection.global},
    format: 'stnl-preparation-projection-v3', deliveries: [JSON.parse(LEAF_CANON)], completed: [],
  };
  reseal(reordered);
  assert.equal(reordered.preparation.normativeSha256, projectionHash('preparation', PREPARATION_PREIMAGE));
  assert.equal(api.validateCurrentImage({activationBytes: reordered.activationBytes, files: reordered.files}).activation.normativeSha256,
    projectionHash('preparation', PREPARATION_PREIMAGE));
  const changedOrder = minimalImage(); changedOrder.preparation.normativeProjection.deliveries[0].verificationRecipe.checks[0].args.reverse(); reseal(changedOrder);
  rejects(() => api.validateCurrentImage({activationBytes: changedOrder.activationBytes, files: changedOrder.files}), 'INVALID_CURRENT_IMAGE');
  const wrongDomain = minimalImage(); wrongDomain.preparation.deliveries[0].review.authoritySha256 = projectionHash('preparation', PREPARATION_PREIMAGE); reseal(wrongDomain);
  rejects(() => api.validateCurrentImage({activationBytes: wrongDomain.activationBytes, files: wrongDomain.files}), 'INVALID_CURRENT_IMAGE');
  const changedLiteral = minimalImage(); changedLiteral.preparation.normativeProjection.global.strategy = 'Different strategy.'; reseal(changedLiteral);
  rejects(() => api.validateCurrentImage({activationBytes: changedLiteral.activationBytes, files: changedLiteral.files}), 'INVALID_CURRENT_IMAGE');
  assert.notEqual(projectionHash('preparation', PREPARATION_PREIMAGE), projectionHash('preparation', PREPARATION_PREIMAGE.replace(GLOBAL_CANON, GLOBAL_CANON.replace('One serial delivery.', 'Different strategy.'))));
  const unicode = minimalImage();
  unicode.preparation.normativeProjection.global.strategy = 'One ç\nline.';
  unicode.preparation.normativeSha256 = projectionHash('preparation', PREPARATION_PREIMAGE.replace('One serial delivery.', 'One ç\\nline.'));
  unicode.preparation.globalReview.authoritySha256 = projectionHash('global-review', GLOBAL_REVIEW_PREIMAGE.replace('One serial delivery.', 'One ç\\nline.'));
  unicode.activation.normativeSha256 = unicode.preparation.normativeSha256;
  reseal(unicode);
  assert.equal(api.validateCurrentImage({activationBytes: unicode.activationBytes, files: unicode.files}).activation.normativeSha256,
    projectionHash('preparation', PREPARATION_PREIMAGE.replace('One serial delivery.', 'One ç\\nline.')));
}

function b6(api) {
  for (const [field, legacy] of [['workCapture', '/old/work-capture.json'], ['receiptFile', '/old/receipt.json']]) {
    const oldAttempt = minimalImage();
    oldAttempt.activation.lastAttempt = {
      operationAttemptId: '33333333-3333-4333-8333-333333333333', deliveryId: DELIVERY_ID,
      slice: 'slice-01', operation: 'VALIDATE_SLICE', terminalActivationId: ACTIVATION_ID, outcome: 'recorded',
      [field]: legacy,
    };
    oldAttempt.activationBytes = json(oldAttempt.activation);
    rejects(() => api.validateCurrentImage({activationBytes: oldAttempt.activationBytes, files: oldAttempt.files}), 'INVALID_CURRENT_IMAGE');
  }
  for (const [field, legacy] of [['history', []], ['allocationRef', '/old/allocation.json']]) {
    const oldContinuity = minimalImage(); oldContinuity.continuity[field] = legacy; reseal(oldContinuity);
    rejects(() => api.validateCurrentImage({activationBytes: oldContinuity.activationBytes, files: oldContinuity.files}), 'INVALID_CURRENT_IMAGE');
  }
  const oldProjection = minimalImage(); oldProjection.preparation.normativeProjection.format = 'stnl-preparation-projection-v2'; reseal(oldProjection);
  rejects(() => api.validateCurrentImage({activationBytes: oldProjection.activationBytes, files: oldProjection.files}), 'UNSUPPORTED_FORMAT');
}

function b7(api) {
  const bundle = proofBundle();
  const image = completedImage(bundle);
  const result = api.validateCurrentImage({activationBytes: image.activationBytes, files: image.files});
  assert.deepEqual(result.continuity.deliveries, []);
  assert.equal(result.continuity.completed[0].deliveryId, DELIVERY_ID);
  assert.equal(result.continuity.completed[0].validation, 'current');
  assert.equal(result.referencedObjects[0], bundle.objects[0].id);
  assert.equal(image.files.has('tasks/slice-01.md'), false);
  const noFormalProof = clone(bundle); noFormalProof.validation = null; noFormalProof.objects = [];
  const invalid = completedImage(noFormalProof);
  rejects(() => api.validateCurrentImage({activationBytes: invalid.activationBytes, files: invalid.files}), 'EVIDENCE_INCOMPLETE');
  const noBundle = completedImage(null);
  rejects(() => api.validateCurrentImage({activationBytes: noBundle.activationBytes, files: noBundle.files}), 'EVIDENCE_INCOMPLETE');
  const activeWithoutFormal = proofBundle(); activeWithoutFormal.validation = null; activeWithoutFormal.objects = [];
  const activeInvalid = fixtureWithEvidence(activeWithoutFormal);
  rejects(() => api.validateCurrentImage({activationBytes: activeInvalid.activationBytes, files: activeInvalid.files}), 'EVIDENCE_INCOMPLETE');
  const counterMismatch = fixtureWithEvidence(proofBundle());
  counterMismatch.continuity.deliveries[0].counters.validationAttempts = 0; reseal(counterMismatch);
  rejects(() => api.validateCurrentImage({activationBytes: counterMismatch.activationBytes, files: counterMismatch.files}), 'INVALID_CURRENT_IMAGE');
  const missingOwner = minimalImage();
  missingOwner.preparation.normativeProjection.deliveries[0].obligations[0].fullOwner = 'slice-99';
  const alteredLeaf = DELIVERY_PREIMAGE.replace('"fullOwner":"slice-01"', '"fullOwner":"slice-99"');
  const alteredPreparation = PREPARATION_PREIMAGE.replace('"fullOwner":"slice-01"', '"fullOwner":"slice-99"');
  missingOwner.preparation.normativeSha256 = projectionHash('preparation', alteredPreparation);
  missingOwner.preparation.deliveries[0].review.authoritySha256 = projectionHash('delivery', alteredLeaf);
  missingOwner.continuity.deliveries[0].authoritySha256 = projectionHash('delivery', alteredLeaf);
  missingOwner.activation.normativeSha256 = missingOwner.preparation.normativeSha256;
  reseal(missingOwner);
  rejects(() => api.validateCurrentImage({activationBytes: missingOwner.activationBytes, files: missingOwner.files}), 'INVALID_CURRENT_IMAGE');
  const absentChild = clone(minimalImage().continuity);
  absentChild.deliveries[0].baseline.entries = [
    {path: 'src', kind: 'directory', children: []}, {path: 'src/gone.mjs', kind: 'absent'},
  ];
  assert.equal(api.validateCurrentContinuity(absentChild).deliveries[0].baseline.entries[1].kind, 'absent');
  const falsePresent = clone(absentChild); falsePresent.deliveries[0].baseline.entries[0].children = ['gone.mjs'];
  rejects(() => api.validateCurrentContinuity(falsePresent), 'INVALID_CURRENT_IMAGE');
  const tenThousand = clone(minimalImage().continuity);
  tenThousand.deliveries[0].baseline.entries = Array.from({length: 10000}, (_, index) =>
    ({path: `f-${String(index).padStart(5, '0')}`, kind: 'absent'}));
  assert.equal(api.validateCurrentContinuity(tenThousand).deliveries[0].baseline.entries.length, 10000);
  tenThousand.deliveries[0].baseline.entries.push({path: 'f-10000', kind: 'absent'});
  rejects(() => api.validateCurrentContinuity(tenThousand), 'INVALID_CURRENT_IMAGE');
  const diagnostic = clone(minimalImage().continuity);
  diagnostic.deliveries[0].lastDiagnostic = {
    code: 'RUNNER_RESULT_REJECTED', operationAttemptId: null, reason: 'Captured malformed response.',
    affectedPaths: [], nextAction: 'normalize',
  };
  assert.equal(api.validateCurrentContinuity(diagnostic).deliveries[0].lastDiagnostic.code, 'RUNNER_RESULT_REJECTED');
  diagnostic.deliveries[0].lastDiagnostic.code = 'made-up-code';
  rejects(() => api.validateCurrentContinuity(diagnostic), 'INVALID_CURRENT_IMAGE');
  const finding = {
    id: 'finding-01', severity: 'blocking', originAttempt: 'attempt-01', problem: 'Missing assertion.',
    evidence: 'The current record shows an incomplete check.', impact: 'Acceptance remains unproven.',
    relatedAuthority: 'AC-001', expectedCorrection: 'Add the assertion.',
  };
  const withFinding = proofBundle(); withFinding.openFindings.push(finding);
  assert.equal(api.validateCurrentEvidence(withFinding).openFindings[0].originAttempt, 'attempt-01');
  const findingImage = fixtureWithEvidence(withFinding); findingImage.continuity.deliveries[0].counters.findings = 1; reseal(findingImage);
  assert.equal(api.validateCurrentImage({activationBytes: findingImage.activationBytes, files: findingImage.files}).continuity.deliveries[0].counters.findings, 1);
  const missingOrigin = clone(withFinding); missingOrigin.openFindings[0].originAttempt = 'attempt-99';
  rejects(() => api.validateCurrentEvidence(missingOrigin), 'EVIDENCE_INCOMPLETE');
  const badFindingId = clone(withFinding); badFindingId.openFindings[0].id = 'arbitrary';
  rejects(() => api.validateCurrentEvidence(badFindingId), 'INVALID_CURRENT_IMAGE');
  const badDivergence = proofBundle(); badDivergence.openDivergences.push({
    id: 'arbitrary', severity: 'blocking', problem: 'Shared contract changed.', evidence: 'Observed drift.',
    requiredAuthorityOperation: 'REPLAN',
  });
  rejects(() => api.validateCurrentEvidence(badDivergence), 'INVALID_CURRENT_IMAGE');
  const duplicateOrdinal = proofBundle();
  const duplicate = clone(duplicateOrdinal.validation);
  duplicate.id = 'attempt-001'; duplicate.origin.operationAttemptId = '99999999-9999-4999-8999-999999999999';
  duplicateOrdinal.support.push(duplicate);
  rejects(() => api.validateCurrentEvidence(duplicateOrdinal), 'INVALID_CURRENT_IMAGE');
}

const checks = [b1, b2, b3, b4, b5, b6, b7];
for (let index = 0; index < checks.length; index += 1) {
  test(`B${index + 1} — EC-1 contract and independent oracle`, () => checks[index](current));
}

test('B8 — seven identical, self-contained distributed modules reproduce B1–B7', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-ec1-isolated-'));
  try {
    const bytes = await Promise.all(modulePaths.map(file => fs.readFile(path.join(root, file))));
    const digests = bytes.map(data => sha(data));
    assert.equal(new Set(digests).size, 1, `distributed module hashes differ: ${digests.join(', ')}`);
    for (let index = 0; index < bytes.length; index += 1) {
      const directory = path.join(temporary, String(index));
      await fs.mkdir(directory);
      const isolated = path.join(directory, 'execution-current.mjs');
      await fs.writeFile(isolated, bytes[index]);
      const api = await import(pathToFileURL(isolated).href);
      for (let proof = 0; proof < checks.length; proof += 1) {
        try { checks[proof](api); }
        catch (error) { error.message = `copy ${index + 1}, B${proof + 1}: ${error.message}`; throw error; }
      }
    }
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
});
