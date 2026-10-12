import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preparePreparationCandidate } from '../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import { publishPreparationCandidate } from '../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import { computeRequirementsAuthority, resolveExecutionWorkspace, readExecutionActivation, preflightExecutionOperation,
  beginPreparedExecutionOperation } from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import { projectPreparationAuthority, readPreparationArtifacts, parseStrictJson } from '../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import { preparePlanCandidate } from '../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs';
import { serializePlanPathClaims } from '../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs';
import { captureExecutionTree } from '../skills/workflows/stnl-execution-planner/runtime/execution-publication.mjs';
import { validateExecutionCandidate, inspectExecutionState } from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import { deriveNormalHandoff } from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import { decideOutcome, nextHandoff } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';

export const reviewDecision = { operation: 'REVIEW_PLAN', status: 'approved', examined: ['requirements', 'plans', 'tasks', 'initial checklist', 'proof capability'],
  summary: 'Offline review fixture: AC-001 requires an observable export; serial ownership, protected responsibilities and node --test export behavior checked. This simulated decision does not certify independent model judgment.' };
const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/workflows/stnl-execution-planner/templates');
const replace = (text, values) => values.reduce((result, [a, b]) => result.replaceAll(a, b), text);
export const verificationBody = ({file='src/greeting.test.mjs', kind='product', inputs=[], files=null, cwd='.'}={}) => '- Recipe: ' + JSON.stringify({format:'stnl-verification-recipe-v1',base:'workspace',cwd,
  checks:[{id:'verification-01',executable:{literal:'node'},args:[{literal:'--test'},...(files ?? [file]).map(path=>({file:{kind,path}}))],inputs:inputs.map(path=>({kind:'input',path}))}],
  dependencyReview:'Reviewed direct proof references and indirect imports/configuration; all dependencies explicitly contained in approved product areas or Existing Inputs.'});
export async function fixture({ parent = os.tmpdir(), test = null, form = 'standalone' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'stnl-p1b-test-')));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'src'));
  assert.ok(['standalone', 'nested-standalone', 'lifecycle-directory', 'lifecycle-file'].includes(form));
  let specPath = path.join(root, form === 'nested-standalone' ? 'docs/área Ω/requirements.md' : 'requirements.md');
  if (form.startsWith('lifecycle-')) {
    const directory = path.join(root, 'specs/área Ω/feature');
    await fs.cp(path.join(templateRoot, '../../stnl-spec-lifecycle-manager/examples/validator-fixtures/ready'), directory, { recursive: true });
    specPath = form === 'lifecycle-directory' ? directory : path.join(directory, 'feature_spec.md');
  } else {
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath, '# Requirements\n\nAC-001: Export a deterministic greeting. Verify by node --test.\n');
  }
  const workspace = await resolveExecutionWorkspace(specPath);
  const authority = await computeRequirementsAuthority(specPath);
  const prepared = await preparePreparationCandidate({ specPath, operation: 'PLAN' });
  const candidate = prepared.candidateExecutionRoot;
  for (const dir of ['plans', 'tasks']) await fs.mkdir(path.join(candidate, dir));
  const authorityPath = form === 'lifecycle-directory' ? path.join(specPath, 'feature_spec.md') : specPath;
  const identity = file => [['`<relative path>`', '`' + path.relative(path.dirname(path.join(workspace.executionRoot, file)), authorityPath).split(path.sep).join('/') + '`'],
    ['sha256:<64hex>', `sha256:${authority}`], ['<positive integer>', '1']];
  const rendering = [
    ['plan.template.md', 'plan.md', [['<compact objective>', 'Deliver a deterministic greeting.'], ['<compact strategy>', 'One serial implementation and test delivery.'], ['01 - <name>', '01 - Greeting'], ['<result>', 'Export observed by a prepared node test.'],
      ['directory: `<repository-relative physical target>`', 'directory: `src`'], ['<risk, boundary, or explicit final integration slice>', 'No auth, persistence or public protocol changes.']]],
    ['slice-plan.template.md', 'plans/slice-01.md', [['<Name>', 'Greeting'], ['<One coherent delivery and how it is observed.>', 'Export observed by node --test.'], ['<included work>', 'Create the greeting and its prepared check.'], ['<excluded work and boundary with later slices>', 'No authentication or persistence changes.'], ['`<artifact-relative authorized subtree or exact file>`', '`src`'], ['`<artifact-relative predicted file>`', '`src/greeting.mjs`'], ['<auth, persistence and public-contract boundaries requiring semantic review>', 'No authentication or persistence changes.'], ['<earlier slice or none>', 'none'], ['<risk and mitigation>', 'Export compatibility: assert value.'], ['<bounded approach>', 'Prepare a bounded module and node test.'], ['<test, command, suite, or observable check>', 'node --test src/greeting.test.mjs'], ['<verification file>', 'src/greeting.test.mjs'], ['<reviewed indirect dependencies>', 'The prepared test imports src/unpredicted.mjs inside the authorized product area; no external indirect inputs.'], ['<objective result and preserved boundary>', 'AC-001 observed with protected responsibilities preserved.']]],
    ['tasks.template.md', 'tasks.md', [['01 - <name>', '01 - Greeting'], ['<observable delivery>', 'Export observed by a prepared node test.']]],
    ['slice-tasks.template.md', 'tasks/slice-01.md', [['<Name>', 'Greeting'], ['<Local observable delivery and its practical outcome.>', 'Export observed by node --test.'], ['<observable condition>', 'Greeting equals hello'], ['<required evidence>', 'node --test src/greeting.test.mjs observes export value'], ['`<artifact-relative authorized subtree or exact file>`', '`src`'], ['`<artifact-relative predicted file>`', '`src/greeting.mjs`'], ['<protected semantic responsibility and exclusion>', 'No authentication or persistence changes.'], ['<technical action>', 'Implement greeting and prepared test'], ['<test, command, suite, or observable check>', 'node --test src/greeting.test.mjs'], ['<verification file>', 'src/greeting.test.mjs'], ['<reviewed indirect dependencies>', 'The prepared test imports src/unpredicted.mjs inside the authorized product area; no external indirect inputs.']]],
  ];
  for (const [template, file, values] of rendering) await fs.writeFile(path.join(candidate, file), replace(await fs.readFile(path.join(templateRoot, template), 'utf8'), [...identity(file), ...values]));
  const f = { root, specPath, workspace, candidate, test };
  if (test) {
    test.after(() => fs.rm(root, { recursive: true, force: true }));
    retainPreparation(f, candidate);
  }
  return f;
}
export function retainPreparation(f, root) {
  if (f.test && root) f.test.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(root + '.owner.json', { force: true });
  });
  return root;
}
export async function prepareFixtureCandidate(f, operation, options = {}) {
  const prepared = await preparePreparationCandidate({ specPath: f.specPath, operation, ...options });
  retainPreparation(f, prepared.candidateExecutionRoot);
  return prepared.candidateExecutionRoot;
}
export async function publishFixtureCandidate(f, candidateExecutionRoot, options = {}) {
  const published = await publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot, ...options });
  retainPreparation(f, published.retainedBackup);
  return published;
}
export const setPreparationSection = (text, heading, body) => {
  const pattern = new RegExp(`(^## ${heading}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'mu');
  assert.match(text, pattern, `section ${heading} exists`);
  return text.replace(pattern, (_, prefix) => `${prefix}${body}\n\n`);
};
export async function editPreparation(root, name, mutate) {
  const file = path.join(root, name), before = await fs.readFile(file, 'utf8'), after = mutate(before);
  assert.notEqual(after, before, `${name}: stimulus-applied`);
  await fs.writeFile(file, after);
}
export async function normalizePreparation(f, root) {
  await preparePlanCandidate({ candidateExecutionRoot: root });
  await serializePlanPathClaims({ specPath: f.specPath, candidateExecutionRoot: root });
}
export async function projectPreparationAuthorityFrom(root) {
  return projectPreparationAuthority(await readPreparationArtifacts(root));
}
export async function approveFixture(f) {
  await publishFixtureCandidate(f, f.candidate);
  const review = await prepareFixtureCandidate(f, 'REVIEW_PLAN');
  await reviewFixtureCandidate(f, review);
  return readExecutionActivation(f.specPath);
}
export async function reviewFixtureCandidate(f, root) {
  for (const [name, text] of await readPreparationArtifacts(root)) await fs.writeFile(path.join(root, name), text.replace('status: draft', 'status: ready').replace('- Review state: pending', '- Review state: approved'));
  return publishFixtureCandidate(f, root, { reviewDecision });
}

test('joint preparation CLI publishes from a frozen skill path containing spaces', async t => {
  const f = await fixture({ test: t, form: 'nested-standalone' });
  const bundleParent = await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-frozen-planner-'));
  t.after(() => fs.rm(bundleParent, { recursive: true, force: true }));
  const bundle = path.join(bundleParent, 'frozen skill bundle', 'stnl-execution-planner');
  await fs.mkdir(path.dirname(bundle), { recursive: true });
  await fs.cp(path.join(templateRoot, '..'), bundle, { recursive: true });
  for (const resource of ['templates/plan.template.md', 'templates/slice-plan.template.md',
    'templates/tasks.template.md', 'templates/slice-tasks.template.md', 'references/verification-recipe.md']) {
    assert.deepEqual(await fs.readFile(path.join(bundle, resource)),
      await fs.readFile(path.join(templateRoot, '..', resource)));
    await assert.rejects(fs.stat(path.join(f.workspace.executionRoot, resource)), { code: 'ENOENT' });
  }
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const invoke = (module, args) => spawnSync(process.execPath, [path.join(bundle, 'runtime', module), ...args],
    { cwd: f.root, encoding: 'utf8', env });
  const prepared = invoke('prepare-task-candidate.mjs', ['--spec-path', f.specPath, '--operation', 'PLAN']);
  assert.equal(prepared.status, 0, prepared.stderr);
  const candidate = JSON.parse(prepared.stdout).candidateExecutionRoot;
  retainPreparation(f, candidate);
  for (const name of ['plan.md', 'plans/slice-01.md', 'tasks.md', 'tasks/slice-01.md']) {
    const destination = path.join(candidate, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(f.candidate, name), destination);
  }
  for (const [module, args] of [
    ['prepare-plan-candidate.mjs', ['--candidate-execution-root', candidate]],
    ['serialize-plan-paths.mjs', ['--spec-path', f.specPath, '--candidate-execution-root', candidate]],
  ]) {
    const result = invoke(module, args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'PASS');
  }
  const published = invoke('publish-task-candidate.mjs', ['--spec-path', f.specPath, '--candidate-execution-root', candidate]);
  assert.equal(published.status, 0, published.stderr);
  assert.equal(JSON.parse(published.stdout).publication, 'confirmed');
  assert.equal((await inspectExecutionState(f.specPath)).state, 'PLANNED_DRAFT');
  for (const module of ['prepare-task-candidate.mjs', 'prepare-plan-candidate.mjs',
    'serialize-plan-paths.mjs', 'serialize-task-paths.mjs', 'publish-task-candidate.mjs']) {
    const result = invoke(module, []);
    assert.notEqual(result.status, 0, module);
    assert.match(result.stderr, /usage:/u, module);
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
test('joint pristine replacement preserves nine obligation steps and exact Unicode QA forecasts through CLI review', async (t) => {
  const f = await fixture({ test: t });
  const qa = ['tests/qa/ação.md', 'tests/qa/report.html', 'tests/qa/example.tsx'];
  await fs.mkdir(path.join(f.root, 'tests/qa'), { recursive: true });
  const checklist = Array.from({ length: 9 }, (_, i) => `- [ ] 1.${i + 1} Implement observable greeting condition ${i + 1} | obligations: obligation-01`).join('\n');
  const areas = ['directory: `src`', ...qa.map(file => 'file: `' + file + '`')];
  await editPreparation(f.candidate, 'plan.md', text => text.replace('directory: `src`', areas.join('; ')));
  for (const name of ['plans/slice-01.md', 'tasks/slice-01.md']) {
    await editPreparation(f.candidate, name, text => setPreparationSection(setPreparationSection(text, 'Authorized Areas', areas.map(area => '- ' + area).join('\n')), 'Expected Files', ['src/greeting.mjs', ...qa].map(file => '- `' + file + '`').join('\n')));
  }
  await editPreparation(f.candidate, 'tasks/slice-01.md', text => setPreparationSection(text, 'Checklist', checklist));
  await approveFixture(f);
  assert.equal((await preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1')).state, 'MATERIALIZED_PRISTINE', 'positive current authority in the same admission consumer');
  const priorSnapshot = await fs.readFile(path.join(f.workspace.executionRoot, 'approved-preparation.json'));
  const oldAuthority = await computeRequirementsAuthority(f.specPath);
  await fs.appendFile(f.specPath, '\nDocumentary clarification of the unchanged AC-001 delivery before joint REPLAN.\n');
  const newAuthority = await computeRequirementsAuthority(f.specPath);
  assert.notEqual(newAuthority, oldAuthority, 'requirements stimulus-applied');
  assert.equal((await inspectExecutionState(f.specPath)).state, 'REQUIREMENTS_CHANGED');
  const staleImage = await captureExecutionTree(f.workspace.executionRoot);
  await assert.rejects(preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1'), /not legal/);
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), staleImage);
  const candidate = await prepareFixtureCandidate(f, 'REPLAN');
  await editPreparation(candidate, 'plan.md', text => text.replace('- Review state: approved', '- Review state: approved\n- Replan reason: Refine the joint preparation while retaining all nine actions and exact QA forecasts.'));
  await editPreparation(candidate, 'plan.md', text => setPreparationSection(text, 'Delivery Continuity', '- runtime'));
  const draft = await publishFixtureCandidate(f, candidate);
  const pending = await inspectExecutionState(f.specPath);
  assert.equal(pending.state, 'PENDING_REPLAN_DRAFT');
  const draftReadback = { execution: pending, executionRaw: pending, product: { deriveNormalHandoff } };
  assert.deepEqual(decideOutcome('REPLAN', draftReadback, true), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('REPLAN', draftReadback), { operation: 'REVIEW_PLAN', slice: null });
  assert.deepEqual(decideOutcome('REPLAN', draftReadback, false), { result: 'BLOCKED', blocker: 'SDK_TURN_FAILED' });
  assert.deepEqual(await fs.readFile(path.join(draft.retainedBackup, 'approved-preparation.json')), priorSnapshot);
  const draftImage = await captureExecutionTree(f.workspace.executionRoot);
  await assert.rejects(preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1'), /not legal/);
  assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), draftImage);
  const review = await prepareFixtureCandidate(f, 'REVIEW_PLAN');
  for (const [name, text] of await readPreparationArtifacts(review)) await fs.writeFile(path.join(review, name), text.replace('status: draft', 'status: ready').replace('Review state: pending', 'Review state: approved'));
  for (const name of ['plans/slice-01.md', 'tasks/slice-01.md']) await editPreparation(review, name, text => setPreparationSection(text, 'Expected Files', ['src/greeting.mjs', ...qa].map(file => '- `' + file + '`').join('\n')));
  assert.match(await fs.readFile(path.join(review, 'tasks/slice-01.md'), 'utf8'), /- `tests\/qa\/ação.md`/u, 'CLI receives actual noncanonical artifact-relative forecast spelling');
  const decision = path.join(f.root, 'review-decision.json');
  await fs.writeFile(decision, JSON.stringify(reviewDecision));
  const published = spawnSync(process.execPath, [fileURLToPath(new URL('../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs', import.meta.url)), '--spec-path', f.specPath, '--candidate-execution-root', review, '--review-decision-file', decision], { encoding: 'utf8' });
  assert.equal(published.status, 0, published.stderr);
  retainPreparation(f, JSON.parse(published.stdout).retainedBackup);
  const current = await inspectExecutionState(f.specPath), task = current.tasks.get('slice-01');
  assert.equal(current.state, 'MATERIALIZED_PRISTINE');
  assert.equal(task.pristine, true);
  assert.equal(task.revision, 2);
  assert.equal(task.fingerprint, newAuthority);
  assert.equal(task.sections.get('Checklist'), checklist);
  assert.equal(task.sections.get('Expected Files'), ['src/greeting.mjs', ...qa].map(file => '- `../../' + file + '`').join('\n'));
  assert.equal(task.sections.get('Authorized Areas'), areas.map(area => '- ' + area.replace('`', '`../../')).join('\n'));
  assert.deepEqual(current.normalHandoff, { workflowSkill: 'stnl-slice-executor', operation: 'EXECUTE_SLICE', invocation: 'OPERATION=EXECUTE_SLICE', slice: 'slice-01' });
  assert.equal((await preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1')).state, 'MATERIALIZED_PRISTINE');
  const reviewedReadback = { execution: current, executionRaw: current, product: { deriveNormalHandoff } };
  assert.deepEqual(decideOutcome('REVIEW_PLAN', reviewedReadback, true), { result: 'PASS', blocker: null });
  assert.deepEqual(nextHandoff('REVIEW_PLAN', reviewedReadback), { operation: 'EXECUTE_SLICE', slice: 'slice-01' });
  assert.deepEqual(decideOutcome('REVIEW_PLAN', reviewedReadback, false), { result: 'BLOCKED', blocker: 'SDK_TURN_FAILED' });
  for (const retired of ['MATERIALIZE_TASKS', 'REVIEW_TASKS']) await assert.rejects(preflightExecutionOperation(f.specPath, retired), /unsupported operation/);
});

test('joint physical paths retain one repository target across every SPEC_PATH form and isolated candidate depth', async (t) => {
  for (const form of ['standalone', 'nested-standalone', 'lifecycle-directory', 'lifecycle-file']) await t.test(form, async child => {
    const f = await fixture({ test: child, form });
    const future = 'src/área local/arquivo Ω.mjs';
    const existing = 'src/controle ü.mjs';
    await fs.writeFile(path.join(f.root, existing), 'export const control = true;\n');
    for (const name of ['plans/slice-01.md', 'tasks/slice-01.md']) await editPreparation(f.candidate, name,
      text => setPreparationSection(text, 'Expected Files', '- `' + future + '`\n- `' + existing + '`'));
    await normalizePreparation(f, f.candidate);
    const first = await captureExecutionTree(f.candidate);
    const again = await serializePlanPathClaims({ specPath: f.specPath, candidateExecutionRoot: f.candidate });
    assert.deepEqual(again.changedPaths, [], 'canonical serializer is idempotent');
    assert.deepEqual(await captureExecutionTree(f.candidate), first);
    assert.equal(again.candidateValidation.state, 'PLANNED_DRAFT');
    const artifacts = await readPreparationArtifacts(f.candidate);
    for (const name of ['plan.md', 'plans/slice-01.md', 'tasks/slice-01.md']) {
      const basis = path.dirname(path.join(f.workspace.executionRoot, name));
      const expected = path.relative(basis, path.join(f.root, 'src')).split(path.sep).join('/');
      assert.ok(artifacts.get(name).includes('directory: `' + expected + '`'), `${name} canonical physical basis`);
      assert.equal(path.resolve(basis, expected), path.join(f.root, 'src'));
      if (name !== 'plan.md') {
        const expectedFile = path.relative(basis, path.join(f.root, future)).split(path.sep).join('/');
        assert.ok(artifacts.get(name).includes('- `' + expectedFile + '`'), 'Unicode future forecast uses the containing artifact');
        assert.equal(path.resolve(basis, expectedFile), path.join(f.root, future));
        const existingFile = path.relative(basis, path.join(f.root, existing)).split(path.sep).join('/');
        assert.ok(artifacts.get(name).includes('- `' + existingFile + '`'));
        assert.equal(await fs.realpath(path.resolve(basis, existingFile)), await fs.realpath(path.join(f.root, existing)));
      }
    }
    assert.equal(await fs.stat(path.join(f.root, future)).catch(() => null), null, 'forecast is not an invented existing file');
    await approveFixture(f);
    const activated = await readExecutionActivation(f.specPath);
    assert.equal(activated.snapshot.reviewedArtifacts.length, 4);
    assert.equal((await preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1')).state, 'MATERIALIZED_PRISTINE');
    const live = await captureExecutionTree(f.workspace.executionRoot);
    // A candidate from the real REPLAN allocator has unrelated physical depth;
    // its claims still resolve against the official artifacts, never its temp path.
    const candidate = await prepareFixtureCandidate(f, 'REPLAN');
    const before = await readPreparationArtifacts(candidate);
    const official = await readPreparationArtifacts(f.workspace.executionRoot);
    for (const [name, text] of official) assert.equal(before.get(name), text, 'allocator preserves the official artifact basis at unrelated temp depth');
    assert.notEqual(candidate, f.workspace.executionRoot);
    assert.ok(path.relative(f.workspace.executionRoot, candidate).startsWith('..' + path.sep));
    assert.equal((await validateExecutionCandidate(f.specPath, candidate)).state, 'MATERIALIZED_PRISTINE');
    const taskName = 'tasks/slice-01.md', taskText = before.get(taskName);
    const globalClaim = path.relative(f.workspace.executionRoot, path.join(f.root, 'src')).split(path.sep).join('/');
    const canonicalTaskClaim = path.relative(path.join(f.workspace.executionRoot, 'tasks'), path.join(f.root, 'src')).split(path.sep).join('/');
    const legacyFileBasis = path.relative(path.join(f.specPath, 'execution/tasks'), path.join(f.root, 'src')).split(path.sep).join('/');
    for (const wrong of [...new Set([globalClaim, legacyFileBasis])].filter(claim => claim !== canonicalTaskClaim)) {
      await fs.writeFile(path.join(candidate, taskName), taskText);
      await editPreparation(candidate, taskName, text => setPreparationSection(text, 'Authorized Areas', '- directory: `' + wrong + '`'));
      const rejected = await captureExecutionTree(candidate);
      await assert.rejects(validateExecutionCandidate(f.specPath, candidate), /Authorized Areas differs between Plan and Task/);
      assert.deepEqual(await captureExecutionTree(candidate), rejected);
      assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
    }
    await fs.writeFile(path.join(candidate, taskName), taskText);
    const alias = path.join(f.root, 'requirements-alias');
    await fs.symlink(f.specPath, alias);
    await assert.rejects(preparePreparationCandidate({ specPath: alias, operation: 'REPLAN' }), /symlink component/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
  });
});

test('joint path candidate rejects wrong physical bases and unsafe targets without mutating authority', async (t) => {
  const cases = [
    ['global inside execution', 'plan.md', text => text.replace(/directory: `[^`]+`/u, 'directory: `../execution/src`'), /resolves inside the execution root/],
    ['global inside lifecycle workspace', 'plan.md', text => text.replace(/directory: `[^`]+`/u, 'directory: `../src`'), /inside the lifecycle SPEC workspace/],
    ['detailed copied global basis', 'plans/slice-01.md', (text, f) => text.replace('directory: `' + path.relative(path.join(f.workspace.executionRoot, 'plans'), path.join(f.root, 'src')).split(path.sep).join('/') + '`', 'directory: `' + path.relative(f.workspace.executionRoot, path.join(f.root, 'src')).split(path.sep).join('/') + '`'), /authorization differs between global and detailed Plan/],
    ['task conceptual code span', 'tasks/slice-01.md', text => setPreparationSection(text, 'Authorized Areas', '- directory: `list`'), /Authorized Areas differs between Plan and Task/],
    ['absolute path', 'plan.md', text => text.replace(/directory: `[^`]+`/u, 'directory: `/absolute/target`'), /must be a normalized repository-relative path/],
    ['repository escape', 'plan.md', text => text.replace(/directory: `[^`]+`/u, 'directory: `../../../../../../outside`'), /escapes its trusted workspace/],
  ];
  for (const [name, artifact, mutate, diagnostic] of cases) await t.test(name, async child => {
    const f = await fixture({ test: child, form: 'lifecycle-directory' });
    await normalizePreparation(f, f.candidate);
    const consume = () => artifact === 'plan.md'
      ? serializePlanPathClaims({ specPath: f.specPath, candidateExecutionRoot: f.candidate })
      : validateExecutionCandidate(f.specPath, f.candidate);
    const positive = await consume();
    assert.equal(positive.candidateValidation?.state ?? positive.state, 'PLANNED_DRAFT', 'positive at the same selected consumer');
    await editPreparation(f.candidate, artifact, text => mutate(text, f));
    const bytes = await captureExecutionTree(f.candidate);
    const requirements = await fs.readFile(path.join(f.specPath, 'feature_spec.md'));
    await assert.rejects(consume(), diagnostic);
    assert.deepEqual(await captureExecutionTree(f.candidate), bytes);
    assert.deepEqual(await fs.readFile(path.join(f.specPath, 'feature_spec.md')), requirements);
    assert.equal(await fs.stat(f.workspace.executionRoot).catch(() => null), null);
  });
});

test('joint publisher canonicalizes Task path spelling and installs independent single-link artifacts', async (t) => {
  const f = await fixture({ test: t, form: 'lifecycle-file' });
  await normalizePreparation(f, f.candidate);
  assert.equal((await validateExecutionCandidate(f.specPath, f.candidate)).state, 'PLANNED_DRAFT');
  const canonical = await fs.readFile(path.join(f.candidate, 'tasks/slice-01.md'), 'utf8');
  const source = (await projectPreparationAuthorityFrom(f.candidate)).normativeProjection.deliveries[0].task['Authorized Areas'];
  const globalBasis = path.relative(f.workspace.executionRoot, path.join(f.root, 'src')).split(path.sep).join('/');
  await editPreparation(f.candidate, 'tasks/slice-01.md', text => setPreparationSection(text, 'Authorized Areas', '- directory: `' + globalBasis + '`'));
  await assert.rejects(validateExecutionCandidate(f.specPath, f.candidate), /Authorized Areas differs between Plan and Task/);
  const published = await publishFixtureCandidate(f, f.candidate);
  assert.equal(published.publication, 'confirmed');
  assert.equal((await inspectExecutionState(f.specPath)).state, 'PLANNED_DRAFT');
  const current = await fs.readFile(path.join(f.workspace.executionRoot, 'tasks/slice-01.md'), 'utf8');
  assert.equal(current, canonical, 'the real publisher uses the reviewed Plan physical target');
  assert.ok(current.includes(source));
  for (const name of ['plan.md', 'plans/slice-01.md', 'tasks.md', 'tasks/slice-01.md']) {
    const installed = path.join(f.workspace.executionRoot, name), candidate = path.join(f.candidate, name);
    const [a, b] = await Promise.all([fs.lstat(installed), fs.lstat(candidate)]);
    assert.ok(a.isFile() && b.isFile()); assert.equal(a.nlink, 1); assert.equal(b.nlink, 1);
    assert.notEqual(a.ino, b.ino);
    assert.deepEqual(await fs.readFile(installed), await fs.readFile(candidate));
  }
});

test('joint review cannot activate pre-authored operational scope or a started checklist without an execution owner', async (t) => {
  const positive = await fixture({ test: t });
  await approveFixture(positive);
  assert.equal((await preflightExecutionOperation(positive.specPath, 'EXECUTE_SLICE', '1')).state, 'MATERIALIZED_PRISTINE');
  for (const started of [false, true]) await t.test(started ? 'scope with started checklist' : 'scope alone', async child => {
    const f = await fixture({ test: child });
    await normalizePreparation(f, f.candidate);
    await editPreparation(f.candidate, 'tasks/slice-01.md', text => setPreparationSection(started ? text.replace('- [ ] 1.1', '- [x] 1.1') : text, 'Changed Areas', '- `../../src/greeting.mjs`'));
    await publishFixtureCandidate(f, f.candidate);
    const review = await prepareFixtureCandidate(f, 'REVIEW_PLAN');
    for (const [name, text] of await readPreparationArtifacts(review)) await fs.writeFile(path.join(review, name), text.replace('status: draft', 'status: ready').replace('Review state: pending', 'Review state: approved'));
    const live = await captureExecutionTree(f.workspace.executionRoot), artifacts = await readPreparationArtifacts(review);
    await assert.rejects(publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: review, reviewDecision }), /historical artifact changed: plans\/slice-01.md/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
    assert.deepEqual(await readPreparationArtifacts(review), artifacts, 'all proposed Plan and Task bytes remain intact');
    const snapshot = parseStrictJson(await fs.readFile(path.join(review, 'approved-preparation.json'), 'utf8'));
    assert.equal(snapshot.reviewedArtifacts.length, 4, 'producer-created review snapshot remains diagnostic and never activates');
    await assert.rejects(preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1'), /not legal/);
    assert.deepEqual(await captureExecutionTree(f.workspace.executionRoot), live);
  });
});

test('joint candidate structural guards reach checklist, obligation, owner and paired authority without live drift', async (t) => {
  const cases = [
    ['unknown checklist obligation', 'tasks/slice-01.md', text => text.replace('| obligations: obligation-01', '| obligations: obligation-99'), /unknown or duplicate obligation association/],
    ['duplicate checklist obligation', 'tasks/slice-01.md', text => text.replace('| obligations: obligation-01', '| obligations: obligation-01, obligation-01'), /unknown or duplicate obligation association/],
    ['duplicate checklist step', 'tasks/slice-01.md', text => setPreparationSection(text, 'Checklist', '- [ ] 1.1 First action | obligations: obligation-01\n- [ ] 1.1 Second action | obligations: obligation-01'), /loses an obligation or duplicates a step/],
    ['uncovered declared obligation', 'tasks/slice-01.md', text => text.replace('## Acceptance Obligations\n\n', '## Acceptance Obligations\n\n- obligation-02 | requirement: AC-001 | contribution: complete | full owner: slice-01 | condition: Greeting remains deterministic | proof: Repeat greeting assertion\n'), /loses an obligation or duplicates a step/],
    ['wrong integral owner', 'tasks/slice-01.md', text => text.replace('full owner: slice-01', 'full owner: slice-99'), /claims another full owner/],
    ['unmapped requirement', 'tasks/slice-01.md', text => text.replace('requirement: AC-001', 'requirement: AC-999'), /obligation is not mapped by its Plan/],
    ['task revision mismatch', 'tasks/slice-01.md', text => text.replace('Plan revision: 1', 'Plan revision: 2'), /authority pair differs/],
    ['task authority mismatch', 'tasks/slice-01.md', text => text.replace(/sha256:[a-f0-9]{64}/u, 'sha256:' + 'f'.repeat(64)), /authority pair differs/],
    ['preparation purpose owner', 'tasks/slice-01.md', text => text.replace('owner: stnl-execution-planner', 'owner: unrelated-owner'), /incompatible owner\/status/],
  ];
  for (const [name, artifact, mutate, diagnostic] of cases) await t.test(name, async child => {
    const f = await fixture({ test: child });
    await normalizePreparation(f, f.candidate);
    const consume = () => projectPreparationAuthorityFrom(f.candidate);
    assert.equal((await consume()).preparationRevision, 1, 'positive in the same structural consumer');
    await editPreparation(f.candidate, artifact, mutate);
    const before = await captureExecutionTree(f.candidate);
    await assert.rejects(consume(), diagnostic);
    assert.deepEqual(await captureExecutionTree(f.candidate), before);
    assert.equal(await fs.stat(f.workspace.executionRoot).catch(() => null), null);
  });
});

test('joint draft parser rejects inconsistent started checklist, malformed evidence and forged supersession', async (t) => {
  for (const [name, mutate, diagnostic] of [
    ['started checklist without actual scope', text => text.replace('- [ ] 1.1', '- [x] 1.1'), /Changed Areas cannot remain pending after work/],
    ['malformed execution evidence', text => setPreparationSection(text, 'Implementation Test Evidence', '### implementation-check-01\n\n- Status: TESTS_PASS'), /expected exactly one 'Automatic check round' field/],
    ['placeholder formal attempt', text => setPreparationSection(text, 'Validation Attempts', '### attempt-01\n\n- Type: initial\n- Status: <PASS>'), /placeholder/],
    ['forged supersession', text => setPreparationSection(text, 'Final Result', '- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 1'), /SUPERSEDED|disagree|supersed/],
  ]) await t.test(name, async child => {
    const f = await fixture({ test: child });
    await normalizePreparation(f, f.candidate);
    assert.equal((await validateExecutionCandidate(f.specPath, f.candidate)).state, 'PLANNED_DRAFT');
    await editPreparation(f.candidate, 'tasks/slice-01.md', mutate);
    const before = await captureExecutionTree(f.candidate);
    await assert.rejects(validateExecutionCandidate(f.specPath, f.candidate), diagnostic);
    assert.deepEqual(await captureExecutionTree(f.candidate), before);
    assert.equal(await fs.stat(f.workspace.executionRoot).catch(() => null), null);
  });
});

test('joint draft grammar rejects hidden tables, residue and cross-reference drift at the current consumer', async t => {
  const row = text => text.match(/^\| \[ \] \|.*$/mu)[0];
  const table = text => text.slice(text.indexOf('| Done |')).trim();
  const cases = [
    ['global reference', 'plans/slice-01.md', text => text.replace('Global plan: `../plan.md`', 'Global plan: `../other.md`'), /non-canonical Global plan/],
    ['malformed detailed plan', 'plans/slice-01.md', () => 'utterly malformed\n', /has no purpose header/],
    ['malformed serial row', 'plan.md', text => text.replace(/(\| plans\/slice-01.md \|)\n/u, '$1\n| malformed serial row |\n'), /Serial Slice Order has an ambiguous table carrier/],
    ['nonpipe serial residue', 'plan.md', text => text.replace(/(\| plans\/slice-01.md \|)\n/u, '$1\nmalformed serial row without pipes\n'), /Serial Slice Order contains text outside its table carrier/],
    ['malformed progress row', 'tasks.md', text => text.replace(row(text), row(text) + '\n| unexpected task row |'), /Tasks index has an ambiguous table carrier/],
    ['malformed checklist', 'tasks/slice-01.md', text => text.replace('- [ ] 1.1', '- [ ] malformed checklist row\n- [ ] 1.1'), /malformed operational step/],
    ['fenced table', 'tasks.md', text => text.replace(table(text), '```md\n' + table(text) + '\n```'), /tasks.md contains hidden or unknown carriers/],
    ['commented table', 'tasks.md', text => text.replace(table(text), '<!--\n' + table(text) + '\n-->'), /tasks.md contains hidden or unknown carriers/],
  ];
  for (const suffix of ['', ' <!-- editorial marker -->']) cases.push([
    'row residue' + suffix, 'tasks.md', text => text + '\n' + row(text).slice(2) + suffix + '\n', suffix ? /tasks.md contains hidden or unknown carriers/ : /Tasks index contains text outside its table carrier/,
  ]);
  cases.push(['comment-prefixed row residue', 'tasks.md', text => text + '\n<!-- editorial marker --> ' + row(text).slice(2) + '\n', /tasks.md contains hidden or unknown carriers/]);
  for (const [name, artifact, mutate, diagnostic] of cases) await t.test(name, async child => {
    const f = await fixture({ test: child });
    await normalizePreparation(f, f.candidate);
    assert.equal((await validateExecutionCandidate(f.specPath, f.candidate)).state, 'PLANNED_DRAFT');
    await editPreparation(f.candidate, artifact, mutate);
    const before = await captureExecutionTree(f.candidate);
    await assert.rejects(validateExecutionCandidate(f.specPath, f.candidate), diagnostic);
    assert.deepEqual(await captureExecutionTree(f.candidate), before);
    assert.equal(await fs.stat(f.workspace.executionRoot).catch(() => null), null);
  });
  const f = await fixture({ test: t });
  await normalizePreparation(f, f.candidate);
  const original = await fs.readFile(path.join(f.candidate, 'tasks.md'), 'utf8');
  for (const prose of ['Editorial notation A | B | C is explanatory prose.',
    'History remains append-only after execution work starts.']) {
    const changed = original.replace(/^purpose: .+$/mu, 'purpose: ' + prose);
    assert.notEqual(changed, original);
    await fs.writeFile(path.join(f.candidate, 'tasks.md'), changed);
    assert.equal((await validateExecutionCandidate(f.specPath, f.candidate)).state, 'PLANNED_DRAFT');
    assert.equal(table(changed), table(original), 'descriptive metadata cannot create progress authority');
    const bodyProse = original.replace('| Done |', prose + '\n\n| Done |');
    await fs.writeFile(path.join(f.candidate, 'tasks.md'), bodyProse);
    await assert.rejects(validateExecutionCandidate(f.specPath, f.candidate), /tasks.md has noncanonical table/);
    assert.equal(await fs.readFile(path.join(f.candidate, 'tasks.md'), 'utf8'), bodyProse);
  }
});

test('joint path serializers reject escape, symlink and mismatched claim count before any write', async (t) => {
  for (const [name, setup, artifact, mutate, diagnostic] of [
    ['repository escape', async () => {}, 'plan.md', text => text.replace('`../src`', '`../../../outside`'), /escapes|outside/],
    ['symlink path component', async f => fs.symlink(f.root, path.join(f.root, 'src/link')), 'plan.md', text => text.replace('`../src`', '`../src/link/target`'), /symlink/],
    ['mismatched global detailed count', async () => {}, 'plans/slice-01.md', text => setPreparationSection(text, 'Authorized Areas', '- directory: `../../src`\n- file: `../../src/other.mjs`'), /more path claims/],
    ['Plan Task recipe mismatch', async () => {}, 'tasks/slice-01.md', text => text.replace('"literal":"--test"', '"literal":"--check"'), /Verification Recipe differs between Plan and Task/],
  ]) await t.test(name, async child => {
    const f = await fixture({ test: child });
    await normalizePreparation(f, f.candidate);
    const consume = () => serializePlanPathClaims({ specPath: f.specPath, candidateExecutionRoot: f.candidate });
    assert.equal((await consume()).status, 'PASS', 'positive in the same path consumer');
    await setup(f);
    await editPreparation(f.candidate, artifact, mutate);
    const before = await captureExecutionTree(f.candidate);
    await assert.rejects(consume(), diagnostic);
    assert.deepEqual(await captureExecutionTree(f.candidate), before);
    assert.equal(await fs.stat(f.workspace.executionRoot).catch(() => null), null);
  });
});

test('joint preparation reader and publisher reject symlink and hardlink artifacts with target bytes preserved', async (t) => {
  for (const kind of ['symlink', 'hardlink']) await t.test(kind, async child => {
    const positive = await fixture({ test: child });
    await normalizePreparation(positive, positive.candidate);
    await publishFixtureCandidate(positive, positive.candidate);
    assert.equal((await inspectExecutionState(positive.specPath)).state, 'PLANNED_DRAFT', 'positive real preparation publisher with the same regular-file setup');
    const f = await fixture({ test: child });
    await normalizePreparation(f, f.candidate);
    const artifacts = await readPreparationArtifacts(f.candidate);
    assert.equal(artifacts.size, 4);
    const task = path.join(f.candidate, 'tasks/slice-01.md'), external = path.join(f.root, 'linked-task.md');
    const bytes = await fs.readFile(task);
    if (kind === 'symlink') { await fs.rename(task, external); await fs.symlink(external, task); }
    else await fs.link(task, external);
    const linkBefore = await fs.lstat(task);
    await assert.rejects(readPreparationArtifacts(f.candidate), /unsafe preparation artifact/);
    await assert.rejects(publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: f.candidate }), kind === 'symlink' ? /symlink|not a real regular file/ : /regular and single-link/);
    const linkAfter = await fs.lstat(task);
    assert.equal(linkAfter.ino, linkBefore.ino);
    assert.equal(linkAfter.nlink, linkBefore.nlink);
    assert.equal(linkAfter.isSymbolicLink(), kind === 'symlink');
    for (const [name, text] of artifacts) assert.equal(await fs.readFile(path.join(f.candidate, name), 'utf8'), text);
    assert.deepEqual(await fs.readFile(external), bytes);
    assert.equal(await fs.stat(f.workspace.executionRoot).catch(() => null), null);
  });
});

test('joint author -> draft -> review final snapshot -> resolver -> begin returns post-admission CAS', async () => {
  const f = await fixture();
  try {
    const current = await approveFixture(f);
    assert.equal(current.snapshot.reviewedArtifacts.length, 4);
    assert.equal((await preflightExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1')).state, 'MATERIALIZED_PRISTINE');
    const begin = await beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', current.activation.activationId);
    assert.notEqual(begin.expectedActivationId, current.activation.activationId);
    assert.equal(begin.owner.originActivationId, current.activation.activationId);
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', begin.expectedActivationId), /active|owns/);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('duplicate JSON keys, ambiguous Markdown and unknown sections fail closed', async () => {
  assert.throws(() => parseStrictJson('{"x":1,"x":2}'), /duplicate/);
  const f = await fixture();
  try {
    const current = await approveFixture(f);
    const task = path.join(f.workspace.executionRoot, 'tasks/slice-01.md');
    await fs.appendFile(task, '\n## Hidden permission\n\nChange authentication.\n');
    await assert.rejects(readExecutionActivation(f.specPath), /unknown|sections/);
    assert.equal(current.activation.activeAttempt, null);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
test('draft without Tasks and legacy/unactivated readiness never admit execution', async () => {
  const f = await fixture();
  try {
    await fs.rm(path.join(f.candidate, 'tasks/slice-01.md'));
    await assert.rejects(publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot: f.candidate }));
    await assert.rejects(beginPreparedExecutionOperation(f.specPath, 'EXECUTE_SLICE', '1', 'absent'));
    assert.equal(await fs.stat(f.workspace.executionRoot).catch(() => null), null);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test('native begin CLI and standalone consumers use the same activated joint contract', async () => {
  const f = await fixture(); let ownerFile;
  try {
    const approved = await approveFixture(f);
    const { inspectWorkspace } = await import('../skills/workflows/stnl-spec-test-runbook/runtime/lib/core.mjs');
    const before = await readExecutionActivation(f.specPath);
    const inspected = await inspectWorkspace(f.specPath, 'SLICE', {slice:'1'});
    assert.ok(inspected);
    const road = await import('../skills/workflows/stnl-spec-roadmap/runtime/execution-state.mjs');
    assert.equal((await road.readExecutionActivation(f.specPath)).activation.activationId, approved.activation.activationId);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activationId, before.activation.activationId);
    const cli = fileURLToPath(new URL('../skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs', import.meta.url));
    const began = spawnSync(process.execPath, [cli, f.specPath, '--begin', 'EXECUTE_SLICE', '1'], {encoding:'utf8'});
    assert.equal(began.status, 0, began.stderr);
    const admission = JSON.parse(began.stdout); ownerFile = admission.ownerFile;
    assert.notEqual(admission.expectedActivationId, approved.activation.activationId);
    assert.equal((await fs.stat(ownerFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await fs.readFile(ownerFile,'utf8')).owner.originActivationId, approved.activation.activationId);
    const env={...process.env,STNL_OPERATION_OWNER_FILE:ownerFile};
    const check = spawnSync(process.execPath, [cli,f.specPath,'EXECUTE_SLICE','1'],{encoding:'utf8',env});
    assert.equal(check.status,0,check.stderr);
    const duplicate=spawnSync(process.execPath,[cli,f.specPath,'--begin','EXECUTE_SLICE','1'],{encoding:'utf8',env});
    assert.notEqual(duplicate.status,0);
    assert.equal((await readExecutionActivation(f.specPath)).activation.activationId,admission.expectedActivationId);
  } finally {if(ownerFile)await fs.unlink(ownerFile);await fs.rm(f.root,{recursive:true,force:true});}
});

}
