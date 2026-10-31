import { createHash } from 'node:crypto';

// These literals are independent EC-1 oracle preimages. No product module is imported.
export const DELIVERY_ID = '11111111-1111-4111-8111-111111111111';
export const ACTIVATION_ID = '22222222-2222-4222-8222-222222222222';
export const REQUIREMENTS_HASH = `sha256:${'a'.repeat(64)}`;
export const SLICE = 'slice-01';
export const RECIPE_CANON = '{"base":"workspace","checks":[{"args":[{"literal":"--test"},{"file":{"kind":"product","path":"../../../../src/pay.test.mjs"}}],"executable":{"literal":"node"},"id":"verification-01","inputs":[]}],"cwd":".","dependencyReview":"Reviewed direct and indirect inputs.","format":"stnl-verification-recipe-v1"}';
export const LEAF_CANON = "{\"authorizedAreas\":\"- directory: `src`\",\"completionCriterion\":\"AC-001 passes.\",\"deliveryId\":\"11111111-1111-4111-8111-111111111111\",\"dependencies\":[],\"existingInputs\":\"- none\",\"expectedTests\":\"node --test src/pay.test.mjs\",\"includedScope\":\"Implement pay export.\",\"objectiveAndObservableResult\":\"Pay export observed.\",\"obligations\":[{\"condition\":\"Pay export observed\",\"contribution\":\"complete\",\"fullOwner\":\"slice-01\",\"id\":\"obligation-01\",\"proof\":\"Prepared node test\",\"requirement\":\"AC-001\"}],\"outOfScopeAndBoundaries\":\"No auth changes.\",\"protectedResponsibilities\":\"No auth changes.\",\"requirements\":\"AC-001: Pay export is observable.\",\"risksAndStrategy\":\"Use one module and one test.\",\"taskResult\":\"Pay export observed.\",\"verificationRecipe\":{\"base\":\"workspace\",\"checks\":[{\"args\":[{\"literal\":\"--test\"},{\"file\":{\"kind\":\"product\",\"path\":\"../../../../src/pay.test.mjs\"}}],\"executable\":{\"literal\":\"node\"},\"id\":\"verification-01\",\"inputs\":[]}],\"cwd\":\".\",\"dependencyReview\":\"Reviewed direct and indirect inputs.\",\"format\":\"stnl-verification-recipe-v1\"}}";
export const GLOBAL_CANON = '{"objective":"Pay export observed.","order":["11111111-1111-4111-8111-111111111111"],"risks":"No auth changes.","strategy":"One serial delivery."}';
export const COMPLETED_GLOBAL_CANON = '{"objective":"Pay export observed.","order":[],"risks":"No auth changes.","strategy":"One serial delivery."}';
export const PREPARATION_PREIMAGE = "{\"completed\":[],\"deliveries\":[{\"authorizedAreas\":\"- directory: `src`\",\"completionCriterion\":\"AC-001 passes.\",\"deliveryId\":\"11111111-1111-4111-8111-111111111111\",\"dependencies\":[],\"existingInputs\":\"- none\",\"expectedTests\":\"node --test src/pay.test.mjs\",\"includedScope\":\"Implement pay export.\",\"objectiveAndObservableResult\":\"Pay export observed.\",\"obligations\":[{\"condition\":\"Pay export observed\",\"contribution\":\"complete\",\"fullOwner\":\"slice-01\",\"id\":\"obligation-01\",\"proof\":\"Prepared node test\",\"requirement\":\"AC-001\"}],\"outOfScopeAndBoundaries\":\"No auth changes.\",\"protectedResponsibilities\":\"No auth changes.\",\"requirements\":\"AC-001: Pay export is observable.\",\"risksAndStrategy\":\"Use one module and one test.\",\"taskResult\":\"Pay export observed.\",\"verificationRecipe\":{\"base\":\"workspace\",\"checks\":[{\"args\":[{\"literal\":\"--test\"},{\"file\":{\"kind\":\"product\",\"path\":\"../../../../src/pay.test.mjs\"}}],\"executable\":{\"literal\":\"node\"},\"id\":\"verification-01\",\"inputs\":[]}],\"cwd\":\".\",\"dependencyReview\":\"Reviewed direct and indirect inputs.\",\"format\":\"stnl-verification-recipe-v1\"}}],\"format\":\"stnl-preparation-projection-v3\",\"global\":{\"objective\":\"Pay export observed.\",\"order\":[\"11111111-1111-4111-8111-111111111111\"],\"risks\":\"No auth changes.\",\"strategy\":\"One serial delivery.\"},\"requirementsAuthority\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}";
export const GLOBAL_REVIEW_PREIMAGE = "{\"completed\":[],\"deliveryIds\":[\"11111111-1111-4111-8111-111111111111\"],\"global\":{\"objective\":\"Pay export observed.\",\"order\":[\"11111111-1111-4111-8111-111111111111\"],\"risks\":\"No auth changes.\",\"strategy\":\"One serial delivery.\"},\"requirementsAuthority\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}";
export const DELIVERY_PREIMAGE = "{\"authorizedAreas\":\"- directory: `src`\",\"completionCriterion\":\"AC-001 passes.\",\"deliveryId\":\"11111111-1111-4111-8111-111111111111\",\"dependencies\":[],\"existingInputs\":\"- none\",\"expectedTests\":\"node --test src/pay.test.mjs\",\"includedScope\":\"Implement pay export.\",\"objectiveAndObservableResult\":\"Pay export observed.\",\"obligations\":[{\"condition\":\"Pay export observed\",\"contribution\":\"complete\",\"fullOwner\":\"slice-01\",\"id\":\"obligation-01\",\"proof\":\"Prepared node test\",\"requirement\":\"AC-001\"}],\"outOfScopeAndBoundaries\":\"No auth changes.\",\"protectedResponsibilities\":\"No auth changes.\",\"requirements\":\"AC-001: Pay export is observable.\",\"risksAndStrategy\":\"Use one module and one test.\",\"taskResult\":\"Pay export observed.\",\"verificationRecipe\":{\"base\":\"workspace\",\"checks\":[{\"args\":[{\"literal\":\"--test\"},{\"file\":{\"kind\":\"product\",\"path\":\"../../../../src/pay.test.mjs\"}}],\"executable\":{\"literal\":\"node\"},\"id\":\"verification-01\",\"inputs\":[]}],\"cwd\":\".\",\"dependencyReview\":\"Reviewed direct and indirect inputs.\",\"format\":\"stnl-verification-recipe-v1\"}}";
export const COMPLETED_LEAF_CANON = LEAF_CANON.replace('"fullOwner":"slice-01"', `"fullOwner":"delivery:${DELIVERY_ID}"`);
export const COMPLETED_PREPARATION_PREIMAGE = '{"completed":[' + COMPLETED_LEAF_CANON + '],"deliveries":[],"format":"stnl-preparation-projection-v3","global":' + COMPLETED_GLOBAL_CANON + ',"requirementsAuthority":"' + REQUIREMENTS_HASH + '"}';
export const COMPLETED_GLOBAL_REVIEW_PREIMAGE = '{"completed":[' + COMPLETED_LEAF_CANON + '],"deliveryIds":[],"global":' + COMPLETED_GLOBAL_CANON + ',"requirementsAuthority":"' + REQUIREMENTS_HASH + '"}';

export const rawReference = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const projectedReference = (tag, literal) => rawReference(Buffer.concat([
  Buffer.from(`stnl-ec1/${tag}/v1`, 'utf8'), Buffer.from([0]), Buffer.from(literal, 'utf8'),
]));
const utf8 = text => Buffer.from(text, 'utf8');
const json = value => utf8(JSON.stringify(value) + '\n');
const sort = values => values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

const reviewed = (path, text) => ({path, sha256: rawReference(utf8(text)), utf8: text});
function review(scope, preimage, examinedArtifactHashes) {
  return {
    scope, decision: 'approved', authoritySha256: projectedReference(scope === 'set' ? 'global-review' : 'delivery', preimage),
    examinedArtifactHashes, evidenceDecisions: [], summary: 'Independent fixture review of the selected scope.',
  };
}
const emptyWork = () => ({format: 'stnl-current-work-v1', entries: []});
const counters = evidence => ({implementationChecks: 0, findingsChecks: 0, validationAttempts: evidence ? 1 : 0, findings: 0});
const current = (evidence = null, completed = false) => ({
  slice: SLICE, deliveryId: DELIVERY_ID, localRevision: 1,
  authoritySha256: projectedReference('delivery', completed ? COMPLETED_LEAF_CANON : DELIVERY_PREIMAGE),
  validation: evidence ? 'current' : 'unvalidated', evidence, counters: counters(evidence), baseline: emptyWork(),
  normalization: null, lastDiagnostic: null,
});

function makeImage({completed = false, bundle = null} = {}) {
  const normativeProjection = JSON.parse(completed ? COMPLETED_PREPARATION_PREIMAGE : PREPARATION_PREIMAGE);
  const texts = completed ? {
    'plan.md': '# Current plan\n', 'tasks.md': '# Current tasks\n',
  } : {
    'plan.md': '# Current plan\n', 'tasks.md': '# Current tasks\n',
    'plans/slice-01.md': '# Current delivery plan\n', 'tasks/slice-01.md': '# Current delivery task\n',
  };
  const reviewedArtifacts = sort(Object.keys(texts)).map(name => reviewed(name, texts[name]));
  const examined = names => sort(names).map(name => ({path: name, sha256: reviewedArtifacts.find(item => item.path === name).sha256}));
  const currentBundle = bundle === null ? null : {...bundle,
    currentAuthoritySha256: projectedReference('delivery', completed ? COMPLETED_LEAF_CANON : DELIVERY_PREIMAGE)};
  const evidenceBytes = currentBundle === null ? null : json(currentBundle);
  const evidence = evidenceBytes === null ? null : {path: `evidence/${DELIVERY_ID}.json`, sha256: rawReference(evidenceBytes)};
  const preparation = {
    format: 'stnl-preparation-v3', preparationRevision: 1, requirementsAuthority: REQUIREMENTS_HASH,
    normativeSha256: projectedReference('preparation', completed ? COMPLETED_PREPARATION_PREIMAGE : PREPARATION_PREIMAGE),
    normativeProjection,
    globalReview: review('set', completed ? COMPLETED_GLOBAL_REVIEW_PREIMAGE : GLOBAL_REVIEW_PREIMAGE, examined(['plan.md', 'tasks.md'])),
    deliveries: completed ? [] : [{slice: SLICE, deliveryId: DELIVERY_ID, localRevision: 1,
      review: review('slice', DELIVERY_PREIMAGE, examined(['plans/slice-01.md', 'tasks/slice-01.md']))}],
    completed: completed ? [{deliveryId: DELIVERY_ID, slice: SLICE, localRevision: 1, evidenceSha256: evidence?.sha256 ?? rawReference(utf8('missing'))}] : [],
    reviewedArtifacts,
  };
  const continuity = {
    format: 'stnl-delivery-continuity-v2', nextSliceOrdinal: 2,
    deliveries: completed ? [] : [current(evidence)], completed: completed ? [current(evidence, true)] : [],
  };
  const files = new Map(Object.entries(texts).map(([name, text]) => [name, utf8(text)]));
  files.set('approved-preparation.json', json(preparation));
  files.set('continuity.json', json(continuity));
  if (evidenceBytes !== null) files.set(evidence.path, evidenceBytes);
  const activation = {
    format: 'stnl-execution-activation-v2', activationId: ACTIVATION_ID, sequence: 1, previousActivationId: null,
    preparationRevision: 1, requirementsAuthority: REQUIREMENTS_HASH, normativeSha256: preparation.normativeSha256,
    approvedSnapshotSha256: rawReference(files.get('approved-preparation.json')),
    artifacts: sort([...files.keys()]).map(name => ({path: name, sha256: rawReference(files.get(name))})),
    activeAttempt: null, lastAttempt: null,
  };
  return {activation, preparation, continuity, files, activationBytes: json(activation)};
}

export function minimalImage() { return makeImage(); }
export function imageWithBundle(bundle) { return makeImage({bundle}); }
export function completedImage(bundle) { return makeImage({completed: true, bundle}); }

export function proofBundle({rawText = 'abc', externalLiteral = '/old/capture/receipt.json'} = {}) {
  const bytes = utf8(rawText), id = rawReference(bytes);
  const origin = {
    operationAttemptId: '33333333-3333-4333-8333-333333333333', deliveryId: DELIVERY_ID,
    slice: SLICE, operation: 'VALIDATE_SLICE', preparationRevision: 1, localRevision: 1,
    normativeSha256: projectedReference('preparation', PREPARATION_PREIMAGE), originActivationId: ACTIVATION_ID,
    transport: 'native', dispatchId: 'dispatch-1', runnerId: 'runner-1',
  };
  const sources = {
    transport: 'native', rawResponse: id, receipt: id, verificationObservation: id,
    origin: id, agentBinding: id, concludedToolResult: id, removalProofs: [], legacyPreparation: null,
  };
  const record = {
    kind: 'validation', recordFormat: 'stnl-task-record-v2', id: 'attempt-01', origin,
    contract: {
      delivery: JSON.parse(LEAF_CANON), context: {requirementsAuthority: REQUIREMENTS_HASH,
        objective: 'Pay export observed.', strategy: 'One serial delivery.', risks: 'No auth changes.'},
      terminal: null, recipe: JSON.parse(RECIPE_CANON),
    },
    recordUtf8: `### attempt-01\n- Source note: ${externalLiteral}\n`,
    testedWork: emptyWork(), sources,
  };
  return {
    format: 'stnl-current-evidence-v1', deliveryId: DELIVERY_ID, slice: SLICE,
    logicalTaskPath: 'tasks/slice-01.md', currentAuthoritySha256: projectedReference('delivery', DELIVERY_PREIMAGE),
    implementation: [], findingsChecks: [], validation: record, openFindings: [], openDivergences: [], support: [],
    objects: [{id, bytesBase64: bytes.toString('base64')}],
  };
}

export const lifecycleContext = physicalExecutionRoot => ({
  logicalSpecRoot: '/work/repo/specs/pay', logicalAuthorityPath: '/work/repo/specs/pay/feature_spec.md',
  logicalExecutionRoot: '/work/repo/specs/pay/execution',
  physicalExecutionRoot: physicalExecutionRoot ?? '/work/repo/specs/pay/execution', productRoot: '/work/repo',
});
export const standaloneContext = () => ({
  logicalSpecRoot: null, logicalAuthorityPath: '/work/repo/requirements.md',
  logicalExecutionRoot: '/work/repo/requirements-execution',
  physicalExecutionRoot: '/work/repo/requirements-execution', productRoot: '/work/repo',
});
