import { createHash } from 'node:crypto';

export const REQUIREMENTS = `sha256:${'a'.repeat(64)}`;
export const DELIVERY_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
export const NAMES = ['Foundation', 'Verification'];
export const RESULTS = ['Pay export prepared.', 'Pay export verified.'];
const encoder = text => Buffer.from(text, 'utf8');
export const rawOracle = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const projectedOracle = (tag, literal) => rawOracle(Buffer.concat([
  encoder(`stnl-ec1/${tag}/v1`), Buffer.from([0]), encoder(literal),
]));
export const LIFECYCLE = {
  logicalSpecRoot: '/work/repo/specs/pay', logicalAuthorityPath: '/work/repo/specs/pay/feature_spec.md',
  logicalExecutionRoot: '/work/repo/specs/pay/execution',
  physicalExecutionRoot: '/work/repo/specs/pay/execution', productRoot: '/work/repo',
};
export const STANDALONE = {
  logicalSpecRoot: null, logicalAuthorityPath: '/work/repo/specs/pay/requirements.md',
  logicalExecutionRoot: '/work/repo/specs/pay/requirements-execution',
  physicalExecutionRoot: '/work/repo/specs/pay/requirements-execution', productRoot: '/work/repo',
};
export const RECIPE = {
  format: 'stnl-verification-recipe-v1', base: 'workspace', cwd: '.',
  checks: [{id: 'verification-01', executable: {literal: 'node'},
    args: [{literal: '--test'}, {file: {kind: 'product', path: '../../../../src/pay.test.mjs'}}], inputs: []}],
  dependencyReview: 'Reviewed direct and indirect inputs.',
};
const metadata = (status, purpose) => `# File Purpose Header

\`\`\`yaml
purpose: ${purpose}
status: ${status}
read_when: Preparing the initial pay execution image.
do_not_read_when: Another delivery is selected.
contains: Current authority and initial delivery carriers.
owner: stnl-execution-planner
update_policy: Author writes; reviewer approves the final bytes.
\`\`\`

`;
const section = (name, body) => `## ${name}\n\n${body}\n\n`;
const normalizedStatus = status => status === 'ready' ? 'approved' : 'pending';
const area = '- directory: `../../../../src`';
const tests = '- node --test src/pay.test.mjs';
const responsibility = '- Keep authentication unchanged.';
const requirementsBody = '- AC-001: The pay export must be observable by the prepared test.';
const risk = '- Risk: a shared file could drift.\n- Strategy: keep the edit scoped.';
const checklist = index => `- [ ] ${index}.1 Implement the approved pay check | obligations: obligation-01`;
const recipe = () => '- Recipe: ' + JSON.stringify(RECIPE);
const obligation = index => `- obligation-01 | requirement: AC-001 | contribution: ${index === 1 ? 'partial' : 'complete'} | full owner: slice-02 | condition: ${index === 1 ? 'Pay export compiles' : 'Pay export is observed'} | proof: Prepared node test`;

function detailedPlan(index, status, source) {
  const number = String(index).padStart(2, '0'), name = NAMES[index - 1];
  return metadata(status, `Detailed plan for ${name}.`) + `# Slice ${number} - ${name}\n\n`
    + section('References', `- Slice: ${number}\n- Delivery ID: ${DELIVERY_IDS[index - 1]}\n- Requirements source: ${source}\n- Requirements authority: ${REQUIREMENTS}\n- Plan revision: 1\n- Local revision: 1\n- Global plan: \`../plan.md\`\n- Review state: ${normalizedStatus(status)}`)
    + section('Objective and Observable Result', index === 1 ? 'Prepare the pay export.' : 'Verify the pay export.')
    + section('Requirements', requirementsBody)
    + section('Included Scope', index === 1 ? '- Implement the pay export.' : '- Verify the prepared export.')
    + section('Out of Scope and Boundaries', '- Do not alter authentication.')
    + section('Authorized Areas', area)
    + section('Expected Files', '- `../../../../src/pay.mjs`')
    + section('Existing Inputs', '- none')
    + section('Protected Responsibilities', responsibility)
    + section('Dependencies', index === 1 ? '- none' : '- slice-01')
    + section('Risks and Strategy', risk)
    + section('Expected Tests', tests)
    + section('Verification Recipe', recipe())
    + section('Completion Criterion', index === 1 ? '- Partial pay check exists.' : '- Full pay result is proven.');
}
function detailedTask(index, status, source) {
  const number = String(index).padStart(2, '0'), name = NAMES[index - 1], slice = `slice-${number}`;
  let result = metadata(status, `Pristine task for ${name}.`) + `# Slice ${number} Tasks - ${name}\n\n`
    + section('References', `- Slice: ${number}\n- Delivery ID: ${DELIVERY_IDS[index - 1]}\n- Plan: \`../plans/${slice}.md\`\n- Requirements source: ${source}\n- Requirements authority: ${REQUIREMENTS}\n- Plan revision: 1\n- Local revision: 1\n- Global tasks: \`../tasks.md\``)
    + section('Result', RESULTS[index - 1])
    + section('Acceptance Obligations', obligation(index))
    + section('Authorized Areas', area)
    + section('Expected Files', '- `../../../../src/pay.mjs`')
    + section('Existing Inputs', '- none')
    + section('Protected Responsibilities', responsibility)
    + section('Checklist', checklist(index))
    + section('Expected Tests', tests)
    + section('Verification Recipe', recipe())
    + section('Continuity', '- Current validation: unvalidated\n- Current evidence: none\n- Current action: implement approved delivery');
  for (const name of ['Operational Changes', 'Changed Areas', 'Scope Expansion', 'Prior Validation Overlap',
    'Divergences', 'Delegation Blocker', 'Implementation Test Evidence', 'Findings Test Evidence',
    'Validation Attempts', 'Validation Findings', 'Corrections Applied', 'Effective Validation Base',
    'Diff Summary', 'Final Result']) {
    result += section(name, ['Changed Areas', 'Diff Summary', 'Final Result'].includes(name) ? '- pending' : '- none');
  }
  return result;
}
function globalPlan(status, source) {
  return metadata(status, 'Global pay execution plan.') + '# Execution Plan\n\n'
    + section('Global Context', `- Requirements source: ${source}\n- Requirements authority: ${REQUIREMENTS}\n- Plan revision: 1\n- Objective: Ship pay.\n- Strategy: Two deliveries.\n- Review state: ${normalizedStatus(status)}`)
    + section('Serial Slice Order', '| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |\n'
      + '|---|---|---|---|---|---|\n'
      + '| 01 - Foundation | Pay export prepared. | - | AC-001 | directory: `../../../src` | plans/slice-01.md |\n'
      + '| 02 - Verification | Pay export verified. | slice-01 | AC-001 | directory: `../../../src` | plans/slice-02.md |')
    + section('Global Risks and Integration', '- No authentication changes.');
}
function globalTasks(status) {
  return metadata(status, 'Global pristine pay tasks.') + '# Execution Tasks\n\n'
    + '| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |\n'
    + '|---|---|---|---|---|---|---|\n'
    + '| [ ] | 01 - Foundation | Pay export prepared. | - | tasks/slice-01.md | pending | pending |\n'
    + '| [ ] | 02 - Verification | Pay export verified. | slice-01 | tasks/slice-02.md | pending | pending |\n';
}
export function initialArtifacts({status = 'ready', form = 'lifecycle', newline = '\n'} = {}) {
  const source = form === 'lifecycle' ? '`../feature_spec.md`' : '`../requirements.md`';
  const detailSource = form === 'lifecycle' ? '`../../feature_spec.md`' : '`../../requirements.md`';
  const texts = [
    ['plan.md', globalPlan(status, source)], ['tasks.md', globalTasks(status)],
    ['plans/slice-01.md', detailedPlan(1, status, detailSource)],
    ['tasks/slice-01.md', detailedTask(1, status, detailSource)],
    ['plans/slice-02.md', detailedPlan(2, status, detailSource)],
    ['tasks/slice-02.md', detailedTask(2, status, detailSource)],
  ];
  return new Map(texts.map(([name, text]) => [name, encoder(newline === '\n' ? text : text.replaceAll('\n', newline))]));
}

// Literal canonical preimages are filled independently of the production projector.
export const LEAF_1_PREIMAGE = "{\"authorizedAreas\":\"- directory: `../../../../src`\",\"completionCriterion\":\"- Partial pay check exists.\",\"deliveryId\":\"11111111-1111-4111-8111-111111111111\",\"dependencies\":[],\"existingInputs\":\"- none\",\"expectedTests\":\"- node --test src/pay.test.mjs\",\"includedScope\":\"- Implement the pay export.\",\"objectiveAndObservableResult\":\"Prepare the pay export.\",\"obligations\":[{\"condition\":\"Pay export compiles\",\"contribution\":\"partial\",\"fullOwner\":\"slice-02\",\"id\":\"obligation-01\",\"proof\":\"Prepared node test\",\"requirement\":\"AC-001\"}],\"outOfScopeAndBoundaries\":\"- Do not alter authentication.\",\"protectedResponsibilities\":\"- Keep authentication unchanged.\",\"requirements\":\"- AC-001: The pay export must be observable by the prepared test.\",\"risksAndStrategy\":\"- Risk: a shared file could drift.\\n- Strategy: keep the edit scoped.\",\"taskResult\":\"Pay export prepared.\",\"verificationRecipe\":{\"base\":\"workspace\",\"checks\":[{\"args\":[{\"literal\":\"--test\"},{\"file\":{\"kind\":\"product\",\"path\":\"../../../../src/pay.test.mjs\"}}],\"executable\":{\"literal\":\"node\"},\"id\":\"verification-01\",\"inputs\":[]}],\"cwd\":\".\",\"dependencyReview\":\"Reviewed direct and indirect inputs.\",\"format\":\"stnl-verification-recipe-v1\"}}";
export const LEAF_2_PREIMAGE = "{\"authorizedAreas\":\"- directory: `../../../../src`\",\"completionCriterion\":\"- Full pay result is proven.\",\"deliveryId\":\"22222222-2222-4222-8222-222222222222\",\"dependencies\":[\"11111111-1111-4111-8111-111111111111\"],\"existingInputs\":\"- none\",\"expectedTests\":\"- node --test src/pay.test.mjs\",\"includedScope\":\"- Verify the prepared export.\",\"objectiveAndObservableResult\":\"Verify the pay export.\",\"obligations\":[{\"condition\":\"Pay export is observed\",\"contribution\":\"complete\",\"fullOwner\":\"slice-02\",\"id\":\"obligation-01\",\"proof\":\"Prepared node test\",\"requirement\":\"AC-001\"}],\"outOfScopeAndBoundaries\":\"- Do not alter authentication.\",\"protectedResponsibilities\":\"- Keep authentication unchanged.\",\"requirements\":\"- AC-001: The pay export must be observable by the prepared test.\",\"risksAndStrategy\":\"- Risk: a shared file could drift.\\n- Strategy: keep the edit scoped.\",\"taskResult\":\"Pay export verified.\",\"verificationRecipe\":{\"base\":\"workspace\",\"checks\":[{\"args\":[{\"literal\":\"--test\"},{\"file\":{\"kind\":\"product\",\"path\":\"../../../../src/pay.test.mjs\"}}],\"executable\":{\"literal\":\"node\"},\"id\":\"verification-01\",\"inputs\":[]}],\"cwd\":\".\",\"dependencyReview\":\"Reviewed direct and indirect inputs.\",\"format\":\"stnl-verification-recipe-v1\"}}";
export const PREPARATION_PREIMAGE = "{\"completed\":[],\"deliveries\":[{\"authorizedAreas\":\"- directory: `../../../../src`\",\"completionCriterion\":\"- Partial pay check exists.\",\"deliveryId\":\"11111111-1111-4111-8111-111111111111\",\"dependencies\":[],\"existingInputs\":\"- none\",\"expectedTests\":\"- node --test src/pay.test.mjs\",\"includedScope\":\"- Implement the pay export.\",\"objectiveAndObservableResult\":\"Prepare the pay export.\",\"obligations\":[{\"condition\":\"Pay export compiles\",\"contribution\":\"partial\",\"fullOwner\":\"slice-02\",\"id\":\"obligation-01\",\"proof\":\"Prepared node test\",\"requirement\":\"AC-001\"}],\"outOfScopeAndBoundaries\":\"- Do not alter authentication.\",\"protectedResponsibilities\":\"- Keep authentication unchanged.\",\"requirements\":\"- AC-001: The pay export must be observable by the prepared test.\",\"risksAndStrategy\":\"- Risk: a shared file could drift.\\n- Strategy: keep the edit scoped.\",\"taskResult\":\"Pay export prepared.\",\"verificationRecipe\":{\"base\":\"workspace\",\"checks\":[{\"args\":[{\"literal\":\"--test\"},{\"file\":{\"kind\":\"product\",\"path\":\"../../../../src/pay.test.mjs\"}}],\"executable\":{\"literal\":\"node\"},\"id\":\"verification-01\",\"inputs\":[]}],\"cwd\":\".\",\"dependencyReview\":\"Reviewed direct and indirect inputs.\",\"format\":\"stnl-verification-recipe-v1\"}},{\"authorizedAreas\":\"- directory: `../../../../src`\",\"completionCriterion\":\"- Full pay result is proven.\",\"deliveryId\":\"22222222-2222-4222-8222-222222222222\",\"dependencies\":[\"11111111-1111-4111-8111-111111111111\"],\"existingInputs\":\"- none\",\"expectedTests\":\"- node --test src/pay.test.mjs\",\"includedScope\":\"- Verify the prepared export.\",\"objectiveAndObservableResult\":\"Verify the pay export.\",\"obligations\":[{\"condition\":\"Pay export is observed\",\"contribution\":\"complete\",\"fullOwner\":\"slice-02\",\"id\":\"obligation-01\",\"proof\":\"Prepared node test\",\"requirement\":\"AC-001\"}],\"outOfScopeAndBoundaries\":\"- Do not alter authentication.\",\"protectedResponsibilities\":\"- Keep authentication unchanged.\",\"requirements\":\"- AC-001: The pay export must be observable by the prepared test.\",\"risksAndStrategy\":\"- Risk: a shared file could drift.\\n- Strategy: keep the edit scoped.\",\"taskResult\":\"Pay export verified.\",\"verificationRecipe\":{\"base\":\"workspace\",\"checks\":[{\"args\":[{\"literal\":\"--test\"},{\"file\":{\"kind\":\"product\",\"path\":\"../../../../src/pay.test.mjs\"}}],\"executable\":{\"literal\":\"node\"},\"id\":\"verification-01\",\"inputs\":[]}],\"cwd\":\".\",\"dependencyReview\":\"Reviewed direct and indirect inputs.\",\"format\":\"stnl-verification-recipe-v1\"}}],\"format\":\"stnl-preparation-projection-v3\",\"global\":{\"objective\":\"Ship pay.\",\"order\":[\"11111111-1111-4111-8111-111111111111\",\"22222222-2222-4222-8222-222222222222\"],\"risks\":\"- No authentication changes.\",\"strategy\":\"Two deliveries.\"},\"requirementsAuthority\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}";
export const GLOBAL_REVIEW_PREIMAGE = "{\"completed\":[],\"deliveryIds\":[\"11111111-1111-4111-8111-111111111111\",\"22222222-2222-4222-8222-222222222222\"],\"global\":{\"objective\":\"Ship pay.\",\"order\":[\"11111111-1111-4111-8111-111111111111\",\"22222222-2222-4222-8222-222222222222\"],\"risks\":\"- No authentication changes.\",\"strategy\":\"Two deliveries.\"},\"requirementsAuthority\":\"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}";
export const EXPECTED_PROJECTION = JSON.parse(PREPARATION_PREIMAGE);

export function initialReview(artifacts) {
  const digest = name => rawOracle(artifacts.get(name));
  const examined = names => names.sort().map(name => ({path: name, sha256: digest(name)}));
  const review = (scope, authoritySha256, names) => ({scope, decision: 'approved', authoritySha256,
    examinedArtifactHashes: examined(names), evidenceDecisions: [], summary: 'Fixture reviewer approved the supplied bytes.'});
  return {globalReview: review('set', projectedOracle('global-review', GLOBAL_REVIEW_PREIMAGE), ['plan.md', 'tasks.md']),
    deliveries: DELIVERY_IDS.map((deliveryId, index) => ({deliveryId,
      review: review('slice', projectedOracle('delivery', index === 0 ? LEAF_1_PREIMAGE : LEAF_2_PREIMAGE),
        [`plans/slice-0${index + 1}.md`, `tasks/slice-0${index + 1}.md`])}))};
}

export function initialEnvelope(snapshotBytes, artifacts) {
  const emptyWork = {format: 'stnl-current-work-v1', entries: []};
  const continuity = {format: 'stnl-delivery-continuity-v2', nextSliceOrdinal: 3,
    deliveries: DELIVERY_IDS.map((deliveryId, index) => ({slice: `slice-0${index + 1}`, deliveryId, localRevision: 1,
      authoritySha256: projectedOracle('delivery', index === 0 ? LEAF_1_PREIMAGE : LEAF_2_PREIMAGE),
      validation: 'unvalidated', evidence: null,
      counters: {implementationChecks: 0, findingsChecks: 0, validationAttempts: 0, findings: 0},
      baseline: emptyWork, normalization: null, lastDiagnostic: null})), completed: []};
  const files = new Map(artifacts);
  files.set('approved-preparation.json', Buffer.from(snapshotBytes));
  files.set('continuity.json', encoder(JSON.stringify(continuity) + '\n'));
  const activation = {format: 'stnl-execution-activation-v2', activationId: '33333333-3333-4333-8333-333333333333',
    sequence: 1, previousActivationId: null, preparationRevision: 1, requirementsAuthority: REQUIREMENTS,
    normativeSha256: projectedOracle('preparation', PREPARATION_PREIMAGE), approvedSnapshotSha256: rawOracle(snapshotBytes),
    artifacts: [...files].map(([name, bytes]) => ({path: name, sha256: rawOracle(bytes)})).sort((a, b) => a.path < b.path ? -1 : 1),
    activeAttempt: null, lastAttempt: null};
  return {activationBytes: encoder(JSON.stringify(activation) + '\n'), files, activation, continuity};
}
