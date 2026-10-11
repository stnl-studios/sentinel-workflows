import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const replace = (text, values) => values.reduce((result, [from, to]) => result.replaceAll(from, to), text);
export const targets = ['src/cli.mjs', 'test/offline-case.test.mjs', 'test/offline-case.json'];
// Explicit offline producer fixture. It renders the joint set and exercises the real
// preparer/publisher. Review judgment is simulated; no model or network is called.
export async function renderOfflineArtifacts({ snapshot, workspace, specPath, candidateExecutionRoot, targetPaths = targets }) {
  const runtime = name => pathToFileURL(path.join(snapshot, 'skills/workflows/stnl-execution-planner/runtime', name)).href;
  const { computeRequirementsAuthority, resolveExecutionWorkspace } = await import(runtime('execution-state.mjs'));
  const authority = await computeRequirementsAuthority(specPath);
  const { executionRoot, authorityPath } = await resolveExecutionWorkspace(specPath);
  const template = file => fs.readFile(path.join(snapshot, 'skills/workflows/stnl-execution-planner/templates', file), 'utf8');
  const identity = file => [['`<relative path>`', '`' + path.relative(path.dirname(path.join(executionRoot, file)), authorityPath).split(path.sep).join('/') + '`'], ['sha256:<64hex>', 'sha256:' + authority], ['<positive integer>', '1']];
  const areas = targetPaths.map(target => 'file: `' + target + '`');
  const expected = targetPaths.map(target => '- `' + target + '`').join('\n');
  const check = 'STNL_VERIFICATION_COMMAND=1 node --test';
  const common = [['01 - <name>', '01 - Todo behavior'], ['<Name>', 'Todo behavior'], ['<observable delivery>', 'Every AC-001 condition passes prepared checks.'], ['<result>', 'Every AC-001 condition passes prepared checks.'], ['<test, command, suite, or observable check>', check], ['<verification file>', targetPaths.find(p=>p.endsWith('.test.mjs')) ?? (targetPaths.length===1 ? targetPaths[0] : 'test/offline-case.test.mjs')], ['<reviewed indirect dependencies>', 'Reviewed imports/configuration are within explicit product files and Existing Inputs; no universal discovery is claimed.'], ['- directory: `<artifact-relative authorized subtree or exact file>`', areas.map(area => '- ' + area).join('\n')], ['- `<artifact-relative predicted file>`', expected]];
  const rendering = [
    ['plan.template.md', 'plan.md', [['<compact objective>', 'Deliver unchanged R-001 and AC-001 behavior.'], ['<compact strategy>', 'Implement and prepare observable checks in one bounded delivery.'], ['directory: `<repository-relative physical target>`', areas.join('; ')], ['<risk, boundary, or explicit final integration slice>', 'Preserve seed services, persistence and existing CLI compatibility.']]],
    ['slice-plan.template.md', 'plans/slice-01.md', [['<One coherent delivery and how it is observed.>', 'Deliver all AC-001 conditions using prepared positive and negative CLI checks.'], ['<included work>', 'Implement selected CLI behavior and prepare its bounded matrix.'], ['<excluded work and boundary with later slices>', 'No seed service, storage, dependency or permission changes.'], ['<auth, persistence and public-contract boundaries requiring semantic review>', 'Preserve original storage behavior and existing public CLI operations.'], ['<earlier slice or none>', 'none'], ['<risk and mitigation>', 'Rejected writes must preserve original bytes; observe with prepared checks.'], ['<bounded approach>', 'Implement selected CLI behavior and independently run prepared checks.'], ['<objective result and preserved boundary>', 'Complete AC-001 observed while seed compatibility and storage boundaries remain intact.']]],
    ['tasks.template.md', 'tasks.md', []],
    ['slice-tasks.template.md', 'tasks/slice-01.md', [['<Local observable delivery and its practical outcome.>', 'Complete AC-001 with prepared checks for every observable condition.'], ['<observable condition>', 'All required successful and rejected CLI variants preserve specified behavior'], ['<required evidence>', 'Prepared node tests observe every AC-001 variant and original seed regressions'], ['<protected semantic responsibility and exclusion>', 'Preserve original storage behavior and existing public CLI operations.'], ['<technical action>', 'Implement full CLI behavior and prepare the complete case matrix']]],
  ];
  for (const dir of ['plans', 'tasks']) await fs.mkdir(path.join(candidateExecutionRoot, dir), { recursive: true });
  for (const [name, file, values] of rendering) await fs.writeFile(path.join(candidateExecutionRoot, file), replace(await template(name), [...identity(file), ...common, ...values]));
  const { preparePlanCandidate } = await import(runtime('prepare-plan-candidate.mjs'));
  const { serializePlanPathClaims } = await import(runtime('serialize-plan-paths.mjs'));
  await preparePlanCandidate({ candidateExecutionRoot });
  await serializePlanPathClaims({ specPath, candidateExecutionRoot });
}
