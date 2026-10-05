import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const replace = (text, values) => values.reduce((result, [from, to]) => result.replaceAll(from, to), text);
const claim = (artifact, target) => path.relative(path.dirname(artifact), target).split(path.sep).join('/');
export const targets = ['src/cli.mjs', 'test/offline-case.test.mjs', 'test/offline-case.json'];
export async function renderOfflineArtifacts({ snapshot, workspace, specPath, tasks = false, candidateExecutionRoot, targetPaths = targets }) {
  const runtime = (owner, name) => pathToFileURL(path.join(snapshot, 'skills/workflows', owner, 'runtime', name)).href;
  const { computeRequirementsAuthority } = await import(runtime('stnl-execution-planner', 'execution-state.mjs'));
  const authority = await computeRequirementsAuthority(specPath);
  const execution = path.join(specPath, 'execution');
  const source = path.join(specPath, 'feature_spec.md');
  const template = (owner, file) => fs.readFile(path.join(snapshot, 'skills/workflows', owner, 'templates', file), 'utf8');
  const identity = (artifact) => [['`<relative path>`', '`' + claim(artifact, source) + '`'], ['sha256:<64hex>', 'sha256:' + authority], ['<positive integer>', '1']];
  const claims = (artifact, join = '; ') => targetPaths.map((target) => '`' + claim(artifact, path.join(workspace, target)) + '`').join(join);
  const check = 'STNL_VERIFICATION_COMMAND=1 node --test';
  if (!tasks) {
    await fs.mkdir(path.join(candidateExecutionRoot, 'plans'), { recursive: true });
    const globalArtifact = path.join(execution, 'plan.md');
    const detailArtifact = path.join(execution, 'plans/slice-01.md');
    let global = replace(await template('stnl-execution-planner', 'plan.template.md'), [...identity(globalArtifact),
      ['<compact objective>', 'Deliver every behavior in R-001 and AC-001 from the unchanged benchmark requirements.'],
      ['<compact strategy>', 'One coherent product delivery; prepare the CLI check in the same authorized slice.'],
      ['01 - <name>', '01 - Todo behavior'], ['<result>', 'All specified CLI behavior and prepared negative variants pass.'],
      ['Model-selected physical target (repository-relative before serialization): `<repository-relative physical target>`; <optional conceptual area> (plain-text description)', claims(globalArtifact)],
      ['<risk, boundary, or explicit final integration slice>', 'Preserve seed services and public compatibility; no later slice supplies missing evidence.']]);
    global = global.replace(/\nFor revision 1,[\s\S]*?\n## Serial Slice Order/u, '\n## Serial Slice Order');
    const detail = replace(await template('stnl-execution-planner', 'slice-plan.template.md'), [...identity(detailArtifact),
      ['<Name>', 'Todo behavior'], ['<One coherent delivery and how it is observed.>', 'Deliver the complete unchanged R-001 / AC-001 contract; observe successful and rejected CLI operations with prepared checks.'],
      ['<included work>', 'Implement the CLI and prepare the case check and its input identity before delegation.'], ['<excluded work and boundary with later slices>', 'No dependencies, seed changes or later evidence slice.'],
      ['`<artifact-relative path>` — <optional contract, subsystem, test area, or explanation>', claims(detailArtifact)],
      ['<earlier slice or none>', 'none'], ['<risk and mitigation>', 'Legacy data and rejected writes: assert original storage bytes.'],
      ['<bounded approach>', 'Implement the selected case only, then verify independently.'], ['<test, command, suite, or observable check>', check],
      ['<objective result and preserved boundary>', 'Every requirement and negative variant passes with unchanged legacy behavior.']]);
    await fs.writeFile(path.join(candidateExecutionRoot, 'plan.md'), global);
    await fs.writeFile(path.join(candidateExecutionRoot, 'plans/slice-01.md'), detail);
    const { preparePlanCandidate } = await import(runtime('stnl-execution-planner', 'prepare-plan-candidate.mjs'));
    const { serializePlanPathClaims } = await import(runtime('stnl-execution-planner', 'serialize-plan-paths.mjs'));
    await preparePlanCandidate({ candidateExecutionRoot });
    await serializePlanPathClaims({ specPath, candidateExecutionRoot });
  } else {
    await fs.mkdir(path.join(candidateExecutionRoot, 'tasks'), { recursive: true });
    const taskArtifact = path.join(execution, 'tasks/slice-01.md');
    await fs.writeFile(path.join(candidateExecutionRoot, 'tasks.md'), replace(await template('stnl-task-materializer', 'tasks.template.md'),
      [['01 - <name>', '01 - Todo behavior'], ['<observable delivery>', 'Complete AC-001 with prepared checks.']]));
    const task = replace(await template('stnl-task-materializer', 'slice-tasks.template.md'), [...identity(taskArtifact),
      ['<Name>', 'Todo behavior'], ['<task>', 'Implement full CLI behavior and prepare authorized case checks.'], ['<result>', 'All AC-001 variants pass.'],
      ['`<artifact-relative path>`; <optional conceptual area>', claims(taskArtifact)], ['<test, command, suite, or observable check>', check]]);
    await fs.writeFile(path.join(candidateExecutionRoot, 'tasks/slice-01.md'), task);
    const { serializeTaskPathClaims } = await import(runtime('stnl-task-materializer', 'serialize-task-paths.mjs'));
    await serializeTaskPathClaims({ specPath, candidateExecutionRoot });
  }
}
