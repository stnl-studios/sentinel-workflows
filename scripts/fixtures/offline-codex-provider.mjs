#!/usr/bin/env node
// External-provider fixture only. Runs real helpers/checks; never writes receipts,
// journals, ledgers or benchmark verdicts. It has no network/provider dependency.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { offlineProviderContext } from '../../agents/codex/runtime/offline-provider-context.mjs';
import { renderOfflineArtifacts, targets as defaultTargets } from './offline-workflow-artifacts.mjs';

const snapshot = path.resolve(process.env.STNL_CODEX_ADAPTER, '../../..');
const context = await offlineProviderContext(process.env, snapshot);
if (!context) throw new Error('provider fixture requires owned TEST-ONLY context');
const authPresent = await fs.access(path.join(process.env.CODEX_HOME, 'auth.json')).then(() => true, () => false);
if (process.argv[2] === 'login') {
  console.log(authPresent ? 'Logged in using ChatGPT' : 'Not logged in'); process.exit(authPresent ? 0 : 1);
}
if (process.argv[2] === 'doctor') {
  const config = await fs.readFile(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
  if (!authPresent || !config.includes('sandbox_mode = "danger-full-access"')) process.exit(1);
  console.log(JSON.stringify({ checks: {
    'auth.credentials': { details: { 'stored auth mode': 'chatgpt', 'stored API key': 'false' } },
    'config.load': { details: { 'model provider': 'openai' } },
    'sandbox.helpers': { details: { 'filesystem sandbox': 'unrestricted', 'network sandbox': 'enabled', 'approval policy': 'Never', 'denied-read rules': '0', 'denied-read glob rules': '0' } },
  } }));
  if (context.scenario === 'main-first-exception') {
    const current = JSON.parse(await fs.readFile(context.file));
    await fs.writeFile(context.file, JSON.stringify({ ...current, providerSha256: 'sha256:' + '0'.repeat(64) }));
  }
  process.exit(0);
}
if (process.argv[2] !== 'exec') throw new Error('unsupported fixture invocation');
let prompt = ''; for await (const bytes of process.stdin) prompt += bytes;
const roots = JSON.parse(process.env.STNL_DISCOVERY_PATHS);
const workspace = roots.workspace;
const operation = /^OPERATION=([A-Z_]+)/mu.exec(prompt)?.[1]
  ?? { INIT: 'SPEC_INIT', CLOSE: 'SPEC_CLOSE', RESUME: 'SPEC_RESUME' }[/^MODE=([A-Z_]+)/mu.exec(prompt)?.[1]];
const specPath = /^SPEC_PATH=(.+)$/mu.exec(prompt)?.[1];
const caseId = /case-([abc])\/workspace$/u.exec(workspace)?.[1].toUpperCase();
if (!operation || !specPath || !caseId || !workspace.startsWith(context.root + '/benchmark-temp/')) throw new Error('fixture work identity missing');
const independent = prompt.includes('RUNNER_DISPATCH_MODE=');
await fs.appendFile(path.join(context.root, '.offline-calls.jsonl'), JSON.stringify({ operation, caseId, independent, pid: process.pid, managerPid: process.ppid, at: new Date().toISOString(), externalCalls: 0 }) + '\n');
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
emit({ type: 'thread.started', thread_id: randomUUID() }); emit({ type: 'turn.started' });
let sequence = 0;
const quoted = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
function run(file, args = [], verification = false, checkEnvironment = {}) {
  const command = `${verification ? 'STNL_VERIFICATION_COMMAND=1 ' : ''}${Object.entries(checkEnvironment).map(([key, value]) => key + '=' + quoted(value) + ' ').join('')}node ${[file, ...args].map(quoted).join(' ')}`;
  const id = 'item_' + sequence++;
  emit({ type: 'item.started', item: { id, type: 'command_execution', command, status: 'in_progress', aggregated_output: '', exit_code: null } });
  const result = spawnSync(process.execPath, [file, ...args], { cwd: workspace, env: { ...process.env, ...(verification ? { STNL_VERIFICATION_COMMAND: '1' } : {}), ...checkEnvironment }, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  emit({ type: 'item.completed', item: { id, type: 'command_execution', command, status: 'completed', aggregated_output: (result.stdout ?? '') + (result.stderr ?? ''), exit_code: result.status } });
  if (result.error || result.signal) throw new Error(result.error?.message ?? result.signal);
  return { ...result, command };
}
function helper(owner, file, args) {
  const result = run(path.join(snapshot, 'skills/workflows', owner, 'runtime', file), args);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
const importHelper = (owner, file) => import(pathToFileURL(path.join(snapshot, 'skills/workflows', owner, 'runtime', file)).href);
const section = (text, heading, value) => text.replace(new RegExp(`(## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, 'u'), '$1' + value + '\n');
const coverageFinding = (claim, origin) => `### finding-01

- Severity: blocking
- State: active
- Origin: ${origin}
- Problem: Prepared priority matrix omits the required high variant.
- Evidence: Prepared coverage assertion fails against unchanged R-001 and AC-001; low and medium variants pass. No CLI defect is claimed.
- Impact: Required high-priority behavior lacks executed evidence.
- Related authority: AC-001 and slice-01
- Expected correction: Add high to the prepared matrix only in ${claim}.`;
const taskFile = path.join(specPath, 'execution/tasks/slice-01.md');
const matrixClaim = path.relative(path.dirname(taskFile), path.join(workspace, 'test/offline-case.json')).split(path.sep).join('/');
const digest = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const finish = (response) => { emit({ type: 'item.completed', item: { id: 'message_' + sequence++, type: 'agent_message', text: typeof response === 'string' ? response : JSON.stringify(response) } }); emit({ type: 'turn.completed', usage: {} }); };
const reassessmentScenario = context.scenario.startsWith('reassessment-');
const applyScopeScenario = context.scenario === 'apply-scope-repair';
const replayBoundary = { 'apply-replay-private': 'private', 'apply-replay-published': 'published' }[context.scenario] ?? null;
const findingsCycleScenario = context.scenario === 'apply-findings-cycle' || replayBoundary !== null;
const executeScopeScenario = ['execute-scope-subset', 'execute-scope-correction'].includes(context.scenario);
const executeRoundScenario = context.scenario === 'execute-round-divergence';
const targets = (applyScopeScenario || findingsCycleScenario || executeScopeScenario) ? [...defaultTargets, 'src/todo-service.mjs', 'src/validation.mjs', 'test/todo-service.test.mjs'] : defaultTargets;
const coverageScenario = ['coverage-findings', 'finalizer-fail-apply-publication',
  'reassessment-needs-fix', 'reassessment-after-fix-blocked', 'apply-scope-repair', 'apply-findings-cycle', 'apply-replay-private', 'apply-replay-published'].includes(context.scenario);
try {
  if (!independent && operation === 'SPEC_INIT' && ['B', 'C'].includes(caseId) && !coverageScenario && !executeScopeScenario && !executeRoundScenario) {
    // Both siblings must reach the provider before either injected failure or
    // normal completion proceeds. Files are an owned test barrier, not workflow state.
    const runId = path.basename(path.resolve(workspace, '../..'));
    await fs.writeFile(path.join(context.root, `.offline-barrier-${runId}-${caseId}`), String(process.pid));
    const sibling = path.join(context.root, `.offline-barrier-${runId}-${caseId === 'B' ? 'C' : 'B'}`);
    const deadline = Date.now() + 5000;
    while (!await fs.access(sibling).then(() => true, () => false)) {
      if (Date.now() >= deadline) throw new Error('owned sibling barrier timed out');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (context.scenario === 'interrupt-siblings') {
      await fs.writeFile(path.join(context.root, `.offline-sibling-ready-${caseId}`), String(process.pid));
      setInterval(() => {}, 1000); await new Promise(() => {});
    }
  }
  if (context.scenario === `block-${caseId.toLowerCase()}` && operation === 'SPEC_INIT') {
    emit({ type: 'turn.failed', error: { message: 'TEST-ONLY injected provider capacity after thread.started' } }); process.exit(0);
  }
  if (independent) {
    if (['pending-main', 'interrupt'].includes(context.scenario)) {
      await fs.writeFile(path.join(context.root, '.offline-runner-ready'), String(process.pid));
      // This fixture stalls after real SDK start events; SDK cancellation owns
      // termination. No check/verdict/exit is fabricated for this scenario.
      setInterval(() => {}, 1000); await new Promise(() => {});
    }
    const payload = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2));
    const round = payload.automaticCheckRound ?? '1/3';
    const priorAttempts = reassessmentScenario && operation === 'VALIDATE_SLICE'
      ? ((await fs.readFile(taskFile, 'utf8')).match(/^### attempt-/gmu) ?? []).length : null;
    if (operation === 'VALIDATE_SLICE' && (context.scenario === 'reassessment-transport'
      || (context.scenario === 'reassessment-second-transport' && priorAttempts === 1))) {
      emit({ type: 'turn.failed', error: { message: 'TEST-ONLY uncertain provider completion' } }); process.exit(0);
    }
    if (operation === 'VALIDATE_SLICE' && context.scenario === 'reassessment-access') {
      // Real nonzero command event, explicitly injected access exception. A
      // later green verification must not admit the reassessment policy.
      run('-e', ["throw Object.assign(new Error('TEST-ONLY access denied'), { code: 'EACCES' })"]);
    }
    const coverageReview = coverageScenario && operation !== 'EXECUTE_SLICE' && priorAttempts !== 0;
    const observed = run('--test', [], true, coverageReview ? { STNL_OFFLINE_REQUIRE_PRIORITY_COVERAGE: '1' } : {});
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
    if (head.status !== 0) throw new Error('HEAD unavailable');
    const commands = [{ command: observed.command, exit: observed.status }];
    const passed = observed.status === 0;
    const evidence = `${caseId} prepared case variants and original seed tests; ${observed.stdout}`;
    if (operation === 'VALIDATE_SLICE') {
      if (context.scenario === 'reassessment-pending-command') emit({ type: 'item.started', item: {
        id: 'item_' + sequence++, type: 'command_execution', command: 'node TEST-ONLY-pending-inspection.mjs', status: 'in_progress', exit_code: null } });
      if (context.scenario === 'reassessment-malformed'
        || (context.scenario === 'reassessment-second-malformed' && priorAttempts === 1)) { finish({ status: 'BLOCKED' }); process.exit(0); }
      const matrix = JSON.parse(await fs.readFile(path.join(workspace, 'test/offline-case.json')));
      const coverageOmitted = coverageReview && !matrix.priorities.includes('high');
      const previousFinding = (await fs.readFile(taskFile, 'utf8')).includes('### finding-01');
      const injectedBlock = reassessmentScenario && (priorAttempts === 0 || context.scenario === 'reassessment-blocked'
        || (context.scenario === 'reassessment-after-fix-blocked' && priorAttempts >= 2));
      finish({ status: injectedBlock ? 'BLOCKED' : passed ? 'PASS' : coverageOmitted ? 'NEEDS_FIX' : 'BLOCKED', head: head.stdout.trim(), commands, evidence,
        findingReferences: coverageOmitted || previousFinding ? 'finding-01' : 'none',
        findingDispositions: (coverageOmitted || (injectedBlock && previousFinding)) ? 'finding-01=active'
          : previousFinding && passed ? 'finding-01=resolved' : 'none',
        blockers: injectedBlock ? 'TEST-ONLY captured review requests further assessment; original diagnostic must remain.'
          : passed || coverageOmitted ? 'none' : 'Prepared check failed; no correction judgment simulated.', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'No runner writes to the workspace.' });
    } else {
      const { inspectExecutionState } = await importHelper('stnl-slice-executor', 'execution-state.mjs');
      const state = operation === 'APPLY_FINDINGS' ? await inspectExecutionState(specPath) : null;
      const response = { status: passed ? 'TESTS_PASS' : 'TESTS_FAIL', automaticCheckRound: round, head: head.stdout.trim(),
      discoverySources: 'approved task, prepared case check, original seed tests', discoveryActions: 'Read the approved task and run prepared checks.', verificationTypesConsidered: 'CLI regression and service/store unit tests',
      nonApplicabilityRationale: 'none', noVerificationCommandConfirmation: 'Actual prepared verification executed.', commands,
      resultOfEachCommandAndExitCode: `node --test exited ${observed.status}`, selectedChecks: 'node --test', selectionRationale: 'AC-001 behavior plus compatibility.', coverage: coverageReview ? 'Prepared coverage assertion checks low, medium and high against R-001 and AC-001.' : 'Executed the prepared matrix and compatibility checks.',
      failures: passed ? 'none' : observed.stdout, evidenceOrFailureSummary: evidence,
      affectedFilesOrBehaviors: targets.join(', '), blockers: 'none', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'No runner edits.' };
      if (operation === 'APPLY_FINDINGS') Object.assign(response, {
        findingsCycle: state.tasks.get('slice-01').attempts.filter((attempt) => attempt.status === 'NEEDS_FIX').at(-1).id,
        findingsVerified: passed ? 'finding-01' : 'none', correctionsCovered: 'Prepared matrix includes high.', regressionsSelected: 'Complete prepared priority checks and original seed tests.', unsupportedActiveFindings: passed ? 'none' : 'finding-01',
      });
      if (executeRoundScenario && operation === 'EXECUTE_SLICE') response.automaticCheckRound = '1/3';
      if (findingsCycleScenario && operation === 'APPLY_FINDINGS') {
        response.automaticCheckRound = round === '1/3' ? { legacy: '3/3' } : null;
        if (replayBoundary !== null && round === '1/3') delete response.automaticCheckRound;
        if (round === '1/3') delete response.findingsCycle;
        else response.findingsCycle = { slice: 'slice-02', text: 'attempt-99', values: [null, 7, true] };
      }
      if (operation !== 'APPLY_FINDINGS') Object.assign(response, { priorRoundFailure: round === '1/3' ? 'none' : 'Prepared completed/pending variants failed in the previous round.',
        correctionApplied: round === '1/3' ? 'none' : 'Corrected the approved CLI filter implementation.',
        inSliceRationale: round === '1/3' ? 'none' : 'AC-001 and the approved CLI path require these filters.' });
      finish(response);
    }
  } else if (operation === 'SPEC_INIT') {
    const candidate = path.join(roots.candidates, 'offline-spec');
    await fs.cp(path.join(snapshot, 'skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready'), candidate, { recursive: true });
    await fs.chmod(candidate, 0o700); await fs.chmod(path.join(candidate, 'shared'), 0o700);
    for (const file of ['feature_spec.md', ...['requirements', 'acceptance-criteria', 'decisions', 'constraints', 'risks', 'questions'].map((name) => `shared/${name}.md`)]) await fs.chmod(path.join(candidate, file), 0o600);
    const requirements = await fs.readFile(path.join(workspace, 'requirements.md'), 'utf8');
    const quotedRequirements = requirements.split('\n').map((line) => '> ' + line).join('\n');
    const title = requirements.split('\n')[0].replace(/^# /u, '');
    const feature = path.join(candidate, 'feature_spec.md');
    let text = await fs.readFile(feature, 'utf8');
    text = text.replace('Fixture Feature', title);
    for (const [heading, value] of [['Objective', title], ['Context', '### Facts\n\n- Existing Todo CLI; unchanged requirements are reproduced losslessly under R-001 and AC-001.\n\n### Hypotheses\n\n- None identified.'], ['Scope', '- Every behavior in R-001.'], ['Out of Scope', '- External dependencies and unrelated features.'], ['Business Rules', '- Preserve JSON lines, exit codes and legacy data compatibility.'], ['Relevant Contracts', '- R-001 and AC-001 preserve the unchanged benchmark requirements.']]) text = section(text, heading, value);
    await fs.writeFile(feature, text);
    for (const [file, id, body] of [['requirements.md', 'R-001', '- status: in_scope\n\n' + quotedRequirements], ['acceptance-criteria.md', 'AC-001', '- status: active\n- verifies: [R-001]\n- references: [D-001, C-001, RK-001]\n\n' + quotedRequirements],
      ['decisions.md', 'D-001', '- status: accepted\n- references: [C-001]\n\n#### Contexto\n\nExisting CLI and legacy data.\n\n#### Decisão\n\nImplement the unchanged specified case contract.\n\n#### Impacto\n\nCompatibility remains observable.'],
      ['constraints.md', 'C-001', '- status: active\n- references: [D-001]\n\n#### Restrição\n\nNo dependencies or seed changes.\n\n#### Razão\n\nPreserve the specified compatibility.'],
      ['risks.md', 'RK-001', '- status: active\n- impact: medium\n- references: [C-001, AC-001]\n\n#### Risco\n\nWrites after rejected commands could corrupt legacy data.\n\n#### Mitigação\n\nPrepare byte-preservation checks in this slice.'],
      ['questions.md', 'Q-001', '- status: resolved\n- classification: blocking\n- resolved_by: decision\n- linked_decision: D-001\n\n#### Pergunta\n\nWhich behavioral authority applies?\n\n#### Por que importa\n\nAC-001 must preserve all source criteria.\n\n#### Resolução\n\nD-001 uses the unchanged benchmark requirements.']]) {
      const filePath = path.join(candidate, 'shared', file);
      const original = await fs.readFile(filePath, 'utf8');
      await fs.writeFile(filePath, original.slice(0, original.indexOf('### ')) + `### ${id} — ${title}\n\n${body}\n`);
    }
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    helper('stnl-spec-lifecycle-manager', 'publish-spec-lifecycle.mjs', ['INIT', specPath, candidate]);
    if (context.scenario === 'main-exception') {
      // The next real SDK call rejects this owned fixture context before its
      // try/stream block. This throws in the manager, not a provider error turn;
      // the rejected offline context also makes real-provider fallback impossible.
      const current = JSON.parse(await fs.readFile(context.file));
      await fs.writeFile(context.file, JSON.stringify({ ...current, providerSha256: 'sha256:' + '0'.repeat(64) }));
    }
    finish('Documentary artifacts published by the lifecycle producer.');
  } else if (operation === 'PLAN') {
    const candidateExecutionRoot = path.join(roots.candidates, 'offline-plan');
    await renderOfflineArtifacts({ snapshot, workspace, specPath, candidateExecutionRoot, targetPaths: targets });
    await fs.cp(candidateExecutionRoot, path.join(specPath, 'execution'), { recursive: true });
    finish('Draft plan with implementation and prepared checks in the same slice.');
  } else if (operation === 'REVIEW_PLAN') {
    helper('stnl-plan-reviewer', 'validate-execution-state.mjs', [specPath, operation]);
    for (const name of ['plan.md', 'plans/slice-01.md']) {
      const file = path.join(specPath, 'execution', name);
      const text = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, text.replace('status: draft', 'status: ready').replaceAll('Review state: pending', 'Review state: approved'));
    }
    finish('Prepared check paths belong to this complete delivery.');
  } else if (operation === 'MATERIALIZE_TASKS') {
    const { prepareTaskMaterializationCandidate } = await importHelper('stnl-task-materializer', 'prepare-task-candidate.mjs');
    const candidate = await prepareTaskMaterializationCandidate({ specPath });
    await renderOfflineArtifacts({ snapshot, workspace, specPath, tasks: true, candidateExecutionRoot: candidate.candidateExecutionRoot, targetPaths: targets });
    helper('stnl-task-materializer', 'publish-task-candidate.mjs', ['--publish', '--spec-path', specPath, '--candidate-execution-root', candidate.candidateExecutionRoot]);
    finish('Tasks materialized through the authorized publisher.');
  } else if (operation === 'REVIEW_TASKS') {
    helper('stnl-task-reviewer', 'validate-execution-state.mjs', [specPath, 'REVIEW_TASKS']);
    finish('Materialized task and authorized prepared check scope agree.');
  } else if (['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS'].includes(operation)) {
    if (context.scenario === 'zero-runner' && operation === 'EXECUTE_SLICE') { finish('No request: injected main omission.'); process.exit(0); }
    let prepared;
    if (context.scenario.startsWith('allocation-fail-') && operation === 'EXECUTE_SLICE') {
      const directory = path.join(process.env.TMPDIR, 'stnl-runner-broker');
      const active = JSON.parse(await fs.readFile(path.join(directory, 'active.json')));
      const stem = String(active.sequence).padStart(3, '0');
      const ownerFile = path.join(directory, stem + '.candidate-owner.json'), bindingFile = path.join(directory, stem + '.candidate.json');
      const sourceBefore = await digest(taskFile), parent = path.dirname(specPath), beforeRoots = await fs.readdir(parent);
      const injection = path.join(context.root, '.offline-allocation-injection.mjs');
      await fs.writeFile(injection, `import fs from 'node:fs/promises';
const original = { rename: fs.rename.bind(fs), writeFile: fs.writeFile.bind(fs) };
let fired = false;
const fail = () => { fired = true; throw Object.assign(new Error('TEST-ONLY allocation fault before binding'), { code: 'EIO' }); };
fs.rename = async (from, to) => { if (!fired && ${JSON.stringify(context.scenario)} === 'allocation-fail-binding' && to === ${JSON.stringify(bindingFile)}) fail(); return original.rename(from, to); };
fs.writeFile = async (file, ...args) => { if (!fired && ${JSON.stringify(context.scenario)} === 'allocation-fail-owner' && file === ${JSON.stringify(ownerFile)}) fail(); return original.writeFile(file, ...args); };
`);
      const first = run('--import', [injection, process.env.STNL_MANAGED_FINALIZER, '--prepare']);
      const allocated = (await fs.readdir(parent)).filter(name => name.startsWith('.stnl-execution-copy-') && !beforeRoots.includes(name));
      const allocatedHashes = Object.fromEntries(await Promise.all(allocated.map(async name => [name, await digest(path.join(parent, name, 'execution/tasks/slice-01.md'))])));
      const ownerBefore = await fs.readFile(ownerFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      prepared = run(process.env.STNL_MANAGED_FINALIZER, ['--prepare']);
      const binding = JSON.parse(prepared.stdout);
      await fs.writeFile(path.join(context.root, '.offline-allocation-failure.json'), JSON.stringify({ scenario: context.scenario,
        first: { exit: first.status, diagnostic: first.stderr }, second: { exit: prepared.status, diagnostic: prepared.stderr },
        allocated, allocatedHashes, allocatedHashesAfter: Object.fromEntries(await Promise.all(allocated.map(async name => [name, await digest(path.join(parent, name, 'execution/tasks/slice-01.md'))]))),
        ownerBefore, ownerAfter: await fs.readFile(ownerFile, 'utf8'), binding, liveUnchanged: sourceBefore === await digest(taskFile) }));
    } else prepared = run(process.env.STNL_MANAGED_FINALIZER, ['--prepare']);
    if (prepared.status) throw new Error(prepared.stderr);
    if (operation === 'EXECUTE_SLICE') {
      const cli = { A: 'filtered-cli.mjs', B: 'prioritized-cli.mjs', C: 'archived-cli.mjs' }[caseId];
      if (context.scenario === 'finalizer-fail-execute-source-edit' || reassessmentScenario || applyScopeScenario || findingsCycleScenario || executeScopeScenario || executeRoundScenario) {
        // Author the implementation on its already-writable approved seed
        // path. copyFile would inherit the frozen reference's 0444 mode.
        // This fresh fixture never changes permissions or resumes a denial.
        await fs.writeFile(path.join(workspace, 'src/cli.mjs'), await fs.readFile(path.join(snapshot, 'scripts/fixtures', cli)));
      } else if (context.scenario !== 'private-retry' || caseId !== 'A') await fs.copyFile(path.join(snapshot, 'scripts/fixtures', cli), path.join(workspace, 'src/cli.mjs'));
      await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
      await fs.copyFile(path.join(snapshot, 'scripts/fixtures/prepared-offline-case.test.mjs'), path.join(workspace, 'test/offline-case.test.mjs'));
      await fs.writeFile(path.join(workspace, 'test/offline-case.json'), JSON.stringify({ caseId,
        ...(coverageScenario ? { priorities: ['low', 'medium'] } : {}), ...(executeRoundScenario ? { completeTarget: 1 } : {}) }));
      const binding = JSON.parse(prepared.stdout);
      let text = await fs.readFile(binding.candidateTaskArtifact, 'utf8');
      text = text.replace('- [ ] 1.1', '- [x] 1.1');
      const claims = targets.map((target) => path.relative(path.join(specPath, 'execution/tasks'), path.join(workspace, target)).split(path.sep).join('/'));
      text = section(text, 'Changed Areas', claims.map((value) => '- `' + value + '`').join('\n'));
      text = section(text, 'Diff Summary', context.scenario === 'finalize-summary-rejection'
        ? '- pending' : '- Implemented the selected case and prepared required variants in the authorized slice.');
      await fs.writeFile(binding.candidateTaskArtifact, text);
      await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ automaticCheckRound: '1/3', changedAreas: executeScopeScenario ? [matrixClaim] : claims, relevantEvidence: 'Authorized complete case checks prepared before independent delegation.' }));
    } else if (operation === 'APPLY_FINDINGS') {
      const binding = JSON.parse(prepared.stdout);
      await fs.writeFile(path.join(context.root, '.offline-apply-before-task.md'), await fs.readFile(taskFile));
      await fs.writeFile(path.join(context.root, '.offline-apply-source-before.sha256'), await digest(path.join(workspace, 'src/cli.mjs')));
      const matrix = JSON.parse(await fs.readFile(path.join(workspace, 'test/offline-case.json')));
      await fs.writeFile(path.join(workspace, 'test/offline-case.json'), JSON.stringify({ ...matrix, priorities: ['low', 'medium', 'high'], ...(findingsCycleScenario ? { completeTarget: 1 } : {}) }));
      await fs.writeFile(binding.candidateTaskArtifact, section(await fs.readFile(binding.candidateTaskArtifact, 'utf8'), 'Corrections Applied', '- `' + matrixClaim + '`'));
      const claims = targets.map((target) => path.relative(path.dirname(taskFile), path.join(workspace, target)).split(path.sep).join('/'));
      await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ automaticCheckRound: '1/3', changedAreas: applyScopeScenario ? [matrixClaim] : claims, activeFindings: findingsCycleScenario ? ['finding-01: Assert the prepared matrix and complete target coverage.'] : ['finding-01'], corrections: ['Added required high variant to the authorized prepared matrix.'], relevantEvidence: 'Prepared coverage assertion and CLI regressions are ready.' }));
    } else await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ requestedChecks: 'node --test', relevantEvidence: 'Check every required variant and unchanged compatibility.' }));
    if (['pending-main', 'interrupt'].includes(context.scenario)) {
      const output = await fs.open(path.join(context.root, '.offline-pending-bridge.log'), 'w');
      const child = spawn(process.execPath, [process.env.STNL_MANAGED_RUNNER_BRIDGE, '--payload-file', process.env.STNL_MANAGED_RUNNER_PAYLOAD],
        { cwd: workspace, env: process.env, stdio: ['ignore', output.fd, output.fd] });
      child.unref(); await output.close();
      await fs.writeFile(path.join(context.root, '.offline-bridge-pid'), String(child.pid));
      const deadline = Date.now() + 5000;
      while (!await fs.access(path.join(context.root, '.offline-runner-ready')).then(() => true, () => false)) {
        if (Date.now() >= deadline) throw new Error('pending runner barrier timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (context.scenario === 'interrupt') { setInterval(() => {}, 1000); await new Promise(() => {}); }
      finish('Injected main completion while owned runner is still pending.'); process.exit(0);
    }
    if (operation === 'VALIDATE_SLICE' && context.scenario === 'reassessment-broker') {
      const activeFile = path.join(process.env.TMPDIR, 'stnl-runner-broker/active.json');
      const active = JSON.parse(await fs.readFile(activeFile));
      await fs.writeFile(activeFile, JSON.stringify({ ...active, slice: 'slice-99' }));
    }
    if (operation === 'VALIDATE_SLICE' && context.scenario === 'reassessment-before-runner-source'
      && (await fs.readFile(taskFile, 'utf8')).includes('### attempt-01')) {
      await fs.appendFile(path.join(workspace, 'src/cli.mjs'), '\n// TEST-ONLY change before runner admission\n');
    }
    let delegated = run(process.env.STNL_MANAGED_RUNNER_BRIDGE, ['--payload-file', process.env.STNL_MANAGED_RUNNER_PAYLOAD]);
    if (context.scenario === 'execute-scope-correction' && operation === 'EXECUTE_SLICE') {
      if (delegated.status !== 1 || !delegated.stderr.includes('EXECUTE payload scope differs from the prepared authorized candidate')) throw new Error('TEST-ONLY initial scope submission did not stop before dispatch');
      const first = delegated;
      const broker = path.join(process.env.TMPDIR, 'stnl-runner-broker');
      const active = JSON.parse(await fs.readFile(path.join(broker, 'active.json')));
      const stem = String(active.sequence).padStart(3, '0');
      const binding = JSON.parse(await fs.readFile(path.join(broker, stem + '.candidate.json')));
      const inputHash = await digest(binding.candidateTaskArtifact);
      const beforeStarts = (await fs.readdir(process.env.TMPDIR)).filter(name => name.startsWith(stem + '-execute_slice-') && name.endsWith('.started.json')).length;
      if (beforeStarts !== 0 || await fs.access(path.join(broker, stem + '.latest.json')).then(() => true, () => false)) throw new Error('TEST-ONLY rejected scope consumed runner evidence');
      const current = JSON.parse(await fs.readFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD));
      const body = /(?:^|\n)## Changed Areas\n\n([\s\S]*?)(?=\n## |$)/u.exec(await fs.readFile(binding.candidateTaskArtifact, 'utf8'))[1];
      const claims = body.trim().split('\n').map(line => /^- `([^`]+)`$/u.exec(line)[1]);
      await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ ...current, changedAreas: claims }));
      delegated = run(process.env.STNL_MANAGED_RUNNER_BRIDGE, ['--payload-file', process.env.STNL_MANAGED_RUNNER_PAYLOAD]);
      await fs.writeFile(path.join(context.root, '.offline-execute-scope-correction.json'), JSON.stringify({ firstExit: first.status,
        firstDiagnostic: first.stderr, beforeStarts, sequence: active.sequence, originalPaths: current.changedAreas, correctedPaths: claims,
        candidateUnchanged: inputHash === await digest(binding.candidateTaskArtifact), secondExit: delegated.status,
        secondReceipt: delegated.status === 0 ? JSON.parse(delegated.stdout.slice('SENTINEL_RUNNER_RECEIPT '.length).trim()) : null }));
    }

    if (delegated.status && context.scenario !== 'reassessment-second-malformed') throw new Error(delegated.stderr);
    if (executeRoundScenario && operation === 'EXECUTE_SLICE') {
      const binding = JSON.parse(prepared.stdout);
      const receipts = [JSON.parse(delegated.stdout.slice('SENTINEL_RUNNER_RECEIPT '.length).trim())];
      const finalizedRounds = [], immutable = {};
      let beforeCandidate;
      const { serializeRunnerExecutionBundleFromResponse, insertExecutionEvidenceInCandidate } = await importHelper('stnl-slice-executor', 'serialize-runner-evidence.mjs');
      const { validateExecutionCandidate } = await importHelper('stnl-slice-executor', 'execution-state.mjs');
      const firstReceipt = receipts[0];
      const bundle = await serializeRunnerExecutionBundleFromResponse({ operation, response: await fs.readFile(firstReceipt.semanticResponseFile, 'utf8'),
        workspace, taskArtifact: binding.candidateTaskArtifact, receiptFile: firstReceipt.receiptFile,
        semanticResponseFile: firstReceipt.semanticResponseFile, automaticCheckRound: '1/3' });
      beforeCandidate = await digest(binding.candidateTaskArtifact);
      let invalidAppends = 0;
      for (const malformed of [bundle.replace('- Automatic check round: 1/3', '- Automatic check round: 2/3'), bundle.replace('- Status: TESTS_FAIL', '- Status: TESTS_PASS')]) {
        let rejected = false;
        try { await insertExecutionEvidenceInCandidate({ taskArtifact: binding.candidateTaskArtifact, operation, bundle: malformed,
          validateProspectiveTask: task => validateExecutionCandidate(specPath, binding.candidateExecutionRoot, [task], { privateAutomaticCheck: { operation, slice: 'slice-01', round: 1 } }) }); }
        catch { rejected = true; }
        if (!rejected || beforeCandidate !== await digest(binding.candidateTaskArtifact)) throw new Error(`TEST-ONLY invalid EXECUTE append was not refused atomically: rejected=${rejected}, unchanged=${beforeCandidate === await digest(binding.candidateTaskArtifact)}`);
        invalidAppends += 1;
      }

      for (let admitted = 1; admitted <= 3; admitted += 1) {
        const receipt = receipts.at(-1);
        for (const file of [receipt.receiptFile, receipt.semanticResponseFile, receipt.eventsPath]) immutable[file] = await digest(file);
        const finalized = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
        finalizedRounds.push({ admitted, exit: finalized.status, diagnostic: finalized.stderr, result: finalized.status === 0 ? JSON.parse(finalized.stdout) : null });
        if (finalized.status !== 0 || admitted === 3) break;
        const payload = JSON.parse(await fs.readFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD));
        await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ ...payload, automaticCheckRound: `${admitted + 1}/3` }));
        const next = run(process.env.STNL_MANAGED_RUNNER_BRIDGE, ['--payload-file', process.env.STNL_MANAGED_RUNNER_PAYLOAD]);
        if (next.status !== 0) throw new Error(next.stderr);
        receipts.push(JSON.parse(next.stdout.slice('SENTINEL_RUNNER_RECEIPT '.length).trim()));
      }
      const extra = run(process.env.STNL_MANAGED_RUNNER_BRIDGE, ['--payload-file', process.env.STNL_MANAGED_RUNNER_PAYLOAD]);
      const after = Object.fromEntries(await Promise.all(Object.keys(immutable).map(async file => [file, await digest(file)])));
      await fs.writeFile(path.join(context.root, '.offline-execute-round-observed.json'), JSON.stringify({ receipts, finalizedRounds, immutable, after, extraExit: extra.status, extraDiagnostic: extra.stderr, beforeCandidate, invalidAppends, privateTask: await fs.readFile(binding.candidateTaskArtifact, 'utf8'), publishedTask: await fs.readFile(taskFile, 'utf8') }));
      if (finalizedRounds.some(entry => entry.exit !== 0)) throw new Error(finalizedRounds.at(-1).diagnostic);
      finish('Three actual failed EXECUTE checks reached the bounded terminal state.'); process.exit(0);
    }
    if (findingsCycleScenario && operation === 'APPLY_FINDINGS') {
      const firstReceipt = JSON.parse(delegated.stdout.slice('SENTINEL_RUNNER_RECEIPT '.length).trim());
      const immutableFiles = [firstReceipt.receiptFile, firstReceipt.semanticResponseFile, firstReceipt.eventsPath,
        firstReceipt.receiptFile.replace(/\.receipt\.json$/u, '.started.json')];
      const before = Object.fromEntries(await Promise.all(immutableFiles.map(async file => [file, await digest(file)])));
      const probes = run(path.join(snapshot, 'scripts/fixtures/findings-cycle-probes.mjs'));
      if (probes.status !== 0) throw new Error(probes.stderr);
      const first = replayBoundary === 'private'
        ? run(path.join(snapshot, 'scripts/fixtures/findings-replay-probes.mjs'), ['private'])
        : run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
      if (first.status !== 0) throw new Error(first.stderr);
      const historyProbes = run(path.join(snapshot, 'scripts/fixtures/findings-cycle-probes.mjs'), ['--private-history']);
      if (historyProbes.status !== 0) throw new Error(historyProbes.stderr);
      const binding = JSON.parse(prepared.stdout);
      const privateTask = await fs.readFile(binding.candidateTaskArtifact, 'utf8');
      await fs.writeFile(path.join(context.root, '.offline-findings-private-task.md'), privateTask);
      const matrixFile = path.join(workspace, 'test/offline-case.json');
      const matrix = JSON.parse(await fs.readFile(matrixFile));
      await fs.writeFile(matrixFile, JSON.stringify({ ...matrix, completeTarget: 2 }));
      const firstPayload = JSON.parse(await fs.readFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD));
      await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ ...firstPayload,
        automaticCheckRound: '2/3', corrections: ['Corrected complete target from ID 1 to ID 2 in the authorized prepared check.'] }));
      const second = run(process.env.STNL_MANAGED_RUNNER_BRIDGE, ['--payload-file', process.env.STNL_MANAGED_RUNNER_PAYLOAD]);
      if (second.status !== 0) throw new Error(second.stderr);
      const secondReceipt = JSON.parse(second.stdout.slice('SENTINEL_RUNNER_RECEIPT '.length).trim());
      immutableFiles.push(secondReceipt.receiptFile, secondReceipt.semanticResponseFile, secondReceipt.eventsPath,
        secondReceipt.receiptFile.replace(/\.receipt\.json$/u, '.started.json'));
      for (const file of immutableFiles) if (!(file in before)) before[file] = await digest(file);
      const finalized = replayBoundary === 'published'
        ? run(path.join(snapshot, 'scripts/fixtures/findings-replay-probes.mjs'), ['published'])
        : run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
      const after = Object.fromEntries(await Promise.all(immutableFiles.map(async file => [file, await digest(file)])));
      await fs.writeFile(path.join(context.root, '.offline-findings-cycle-observed.json'), JSON.stringify({
        firstReceipt, secondReceipt, before, after, firstFinalize: first.status,
        secondFinalize: finalized.status, diagnostic: finalized.stderr, privateTask,
        publishedTask: await fs.readFile(taskFile, 'utf8') }, null, 2));
      if (finalized.status !== 0) throw new Error(finalized.stderr);
      finish('Two actual APPLY checks persisted and published through the managed finalizer.'); process.exit(0);
    }
    const faultOperation = context.scenario.startsWith('finalizer-fail-execute-') ? 'EXECUTE_SLICE'
      : context.scenario === 'finalizer-fail-apply-publication' ? 'APPLY_FINDINGS' : 'VALIDATE_SLICE';
    if ((context.scenario === 'finalize-summary-rejection' || context.scenario.startsWith('finalizer-fail-')) && operation === faultOperation) {
      let binding = JSON.parse(prepared.stdout);
      const receipt = JSON.parse(delegated.stdout.slice('SENTINEL_RUNNER_RECEIPT '.length).trim());
      const evidenceRoot = path.join(context.root, '.offline-finalizer-rejection');
      await fs.mkdir(evidenceRoot);
      const files = [receipt.receiptFile, receipt.semanticResponseFile, receipt.eventsPath,
        receipt.receiptFile.replace(/\.receipt\.json$/u, '.started.json')];
      const active = JSON.parse(await fs.readFile(path.join(process.env.TMPDIR, 'stnl-runner-broker/active.json')));
      const finalizedFile = path.join(process.env.TMPDIR, 'stnl-runner-broker', String(active.sequence).padStart(3, '0') + '.finalization.json');
      const evidenceHashes = async () => Object.fromEntries(await Promise.all(files.map(async (file) => [file, await digest(file)])));
      const treeHashes = async (root, relative = '', hashes = {}) => {
        for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
          const key = path.join(relative, entry.name);
          if (entry.isDirectory()) await treeHashes(root, key, hashes);
          else if (entry.isFile()) hashes[key] = await digest(path.join(root, key));
          else throw new Error('unexpected evidence tree entry');
        }
        return hashes;
      };
      const snapshot = async (label) => {
        const root = path.join(evidenceRoot, label);
        await fs.mkdir(root);
        await fs.cp(binding.candidateExecutionRoot, path.join(root, 'candidate'), { recursive: true });
        await fs.cp(path.join(specPath, 'execution'), path.join(root, 'live'), { recursive: true });
        return { candidateTaskSha256: await digest(binding.candidateTaskArtifact),
          candidateIndexSha256: await digest(path.join(binding.candidateExecutionRoot, 'tasks.md')),
          liveTaskSha256: await digest(taskFile), liveIndexSha256: await digest(path.join(specPath, 'execution/tasks.md')),
          candidateTreeSha256: await treeHashes(binding.candidateExecutionRoot), liveTreeSha256: await treeHashes(path.join(specPath, 'execution')),
          evidenceSha256: await evidenceHashes() };
      };
      const before = await snapshot('00-before-finalize');
      let first;
      if (context.scenario.startsWith('finalizer-fail-')) {
        const injection = path.join(evidenceRoot, 'inject-owned-failure.mjs');
        await fs.writeFile(injection, `// TEST-ONLY scoped filesystem fault; no runtime or verdict substitution.
import fs from 'node:fs/promises';
import path from 'node:path';
const scope = ${JSON.stringify({ scenario: context.scenario, candidateIndex: path.join(binding.candidateExecutionRoot, 'tasks.md'), liveRoot: path.join(specPath, 'execution'), liveTask: taskFile, finalizationFile: finalizedFile, firedFile: path.join(evidenceRoot, 'injection-fired.json') })};
const original = { rename: fs.rename.bind(fs), readFile: fs.readFile.bind(fs), rm: fs.rm.bind(fs), writeFile: fs.writeFile.bind(fs) };
let fired = false, published = false;
const fail = async (boundary) => { fired = true; await original.writeFile(scope.firedFile, JSON.stringify({ boundary, code: 'EIO', testOnly: true })); throw Object.assign(new Error('TEST-ONLY owned filesystem fault: ' + boundary), { code: 'EIO' }); };
fs.rename = async (from, to) => {
  if (!fired && ['finalizer-fail-execute-publication', 'finalizer-fail-apply-publication', 'finalizer-fail-execute-source-edit'].includes(scope.scenario) && to === scope.liveTask && from.startsWith(scope.liveTask + '.stnl-publish-')) await fail('execution publisher task install before live mutation');
  if (!fired && scope.scenario === 'finalizer-fail-prepare-index' && path.basename(to) === 'tasks.md' && path.dirname(to) !== path.dirname(scope.candidateIndex) && path.basename(path.dirname(to)).startsWith('validation-slice-01-')) await fail('prepare index rename after task rename');
  if (!fired && scope.scenario === 'finalizer-fail-publication-install' && to === scope.liveRoot && path.basename(from).startsWith('.stnl-validation-publication-')) await fail('publication install after live moved to backup');
  if (!fired && ['finalizer-fail-finalization-write', 'finalizer-fail-contraproofs'].includes(scope.scenario) && to === scope.finalizationFile) await fail('finalization metadata rename after publication');
  const result = await original.rename(from, to);
  if (to === scope.liveTask && from.startsWith(scope.liveTask + '.stnl-publish-')) published = true;
  return result;
};
fs.rm = async (file, options) => {
  if (!fired && published && scope.scenario === 'finalizer-fail-execute-cleanup' && path.basename(file).startsWith('.stnl-execution-copy-')) await fail('execution candidate cleanup after live installation');
  const committedBackup = path.dirname(file) === path.dirname(scope.liveRoot) && path.basename(file).startsWith('.stnl-validation-backup-')
    && await original.readFile(path.join(file, 'tasks/slice-01.md')).then(() => true, () => false);
  const result = await original.rm(file, options);
  if (committedBackup) published = true;
  return result;
};
fs.readFile = async (file, options) => {
  if (!fired && published && scope.scenario === 'finalizer-fail-readback' && file === scope.liveTask) await fail('outer finalizer readback after publisher success');
  return original.readFile(file, options);
};
`);
        first = run('--import', [injection, process.env.STNL_MANAGED_FINALIZER, '--finalize']);
      } else first = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
      const afterFirst = await snapshot('01-after-rejected-finalize');
      const brokerDirectory = path.join(process.env.TMPDIR, 'stnl-runner-broker');
      const fullBinding = JSON.parse(await fs.readFile(path.join(brokerDirectory, String(active.sequence).padStart(3, '0') + '.candidate.json')));
      const preparationPath = path.join(brokerDirectory, String(active.sequence).padStart(3, '0') + '.preparation-' + fullBinding.nonce + '-attempt-' + receipt.attempt + '.json');
      const checkpointAfterFirst = JSON.parse(await fs.readFile(preparationPath));
      const stagePresent = await fs.access(checkpointAfterFirst.stage.candidateExecutionRoot).then(() => true, () => false);
      if (stagePresent) await fs.cp(checkpointAfterFirst.stage.candidateExecutionRoot, path.join(evidenceRoot, '01-prepared-stage'), { recursive: true });
      const rejectedInput = { ...binding };
      let reprepare;
      const probes = [];
      if (context.scenario === 'finalize-summary-rejection') {
        for (const [name, file] of [['rejected-input-edit', binding.candidateTaskArtifact], ['rejected-stage-edit', checkpointAfterFirst.stage.candidateTaskArtifact]]) {
          const original = await fs.readFile(file), altered = Buffer.concat([original, Buffer.from('\n<!-- TEST-ONLY foreign edit -->\n')]);
          await fs.writeFile(file, altered);
          const blocked = run(process.env.STNL_MANAGED_FINALIZER, ['--prepare']);
          probes.push({ name, exit: blocked.status, diagnostic: blocked.stderr, foreignPreserved: (await fs.readFile(file)).equals(altered) });
          await fs.writeFile(file, original);
        }
        reprepare = run(process.env.STNL_MANAGED_FINALIZER, ['--prepare']);
        if (reprepare.status) throw new Error(reprepare.stderr);
        binding = JSON.parse(reprepare.stdout);
        await fs.writeFile(binding.candidateTaskArtifact, section(await fs.readFile(binding.candidateTaskArtifact, 'utf8'),
          'Diff Summary', '- Implemented the selected case with prepared acceptance evidence.'));
      }
      if (context.scenario === 'finalizer-fail-contraproofs') {
        // Deliberate, reversible tampering in this TEST-ONLY owned checkout.
        // Each blocked call must preserve the foreign bytes before restoration.
        const probe = async (name, file, change) => {
          const original = await fs.readFile(file), altered = Buffer.from(change(original.toString('utf8')));
          await fs.writeFile(file, altered);
          const liveBefore = await treeHashes(path.join(specPath, 'execution'));
          const result = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
          probes.push({ name, exit: result.status, diagnostic: result.stderr,
            foreignPreserved: (await fs.readFile(file)).equals(altered),
            livePreserved: JSON.stringify(liveBefore) === JSON.stringify(await treeHashes(path.join(specPath, 'execution'))),
            finalizationExists: await fs.access(finalizedFile).then(() => true, () => false) });
          await fs.writeFile(file, original);
        };
        for (const [name, file] of [['input-edit', binding.candidateTaskArtifact],
          ['stage-edit', checkpointAfterFirst.stage.candidateTaskArtifact], ['live-source-edit', taskFile],
          ['authority-edit', path.join(specPath, 'shared/requirements.md')], ['evidence-hash-edit', receipt.eventsPath]]) {
          await probe(name, file, text => text + '\n<!-- TEST-ONLY foreign write -->\n');
        }
        await probe('checkpoint-hash-edit', preparationPath, text => {
          const value = JSON.parse(text); value.liveAfter.find(entry => entry.path === 'tasks/slice-01.md').hash = '0'.repeat(64); return JSON.stringify(value);
        });
        await probe('checkpoint-receipt-edit', preparationPath, text => {
          const value = JSON.parse(text); value.association.evidenceSha256[receipt.eventsPath] = '0'.repeat(64); return JSON.stringify(value);
        });
        await probe('outside-stage-path', preparationPath, text => {
          const value = JSON.parse(text); value.stage.candidateExecutionRoot = '/outside/fictitious'; value.stage.candidateTaskArtifact = '/outside/fictitious/tasks/slice-01.md'; return JSON.stringify(value);
        });
        const lockFile = path.join(brokerDirectory, 'finalization.lock');
        const acquired = path.join(evidenceRoot, 'lock-acquired'), released = path.join(evidenceRoot, 'lock-released');
        const injection = path.join(evidenceRoot, 'hold-owned-finalization-lock.mjs');
        await fs.writeFile(injection, `import fs from 'node:fs/promises';
const open = fs.open.bind(fs);
fs.open = async (file, flags, ...args) => {
  const handle = await open(file, flags, ...args);
  if (file === ${JSON.stringify(lockFile)} && flags === 'wx') {
    await fs.writeFile(${JSON.stringify(acquired)}, 'acquired');
    const deadline = Date.now() + 5000;
    while (!await fs.access(${JSON.stringify(released)}).then(() => true, () => false)) {
      if (Date.now() >= deadline) throw new Error('TEST-ONLY lock barrier timed out');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  return handle;
};
`);
        const child = spawn(process.execPath, ['--import', injection, process.env.STNL_MANAGED_FINALIZER, '--finalize'], { cwd: workspace, env: process.env });
        let stdout = '', stderr = '';
        child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
        const settled = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', exit => resolve({ exit, stdout, stderr })); });
        const deadline = Date.now() + 5000;
        while (!await fs.access(acquired).then(() => true, () => false)) {
          if (Date.now() >= deadline) throw new Error('TEST-ONLY finalizer lock was not acquired');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const liveBefore = await treeHashes(path.join(specPath, 'execution'));
        const loser = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
        probes.push({ name: 'concurrent-finalization', exit: loser.status, diagnostic: loser.stderr,
          livePreserved: JSON.stringify(liveBefore) === JSON.stringify(await treeHashes(path.join(specPath, 'execution'))) });
        await fs.writeFile(released, 'released');
        probes.push({ name: 'lock-owner-completion', ...await settled });
      }
      if (context.scenario === 'finalizer-fail-execute-source-edit') {
        // A fresh EXEC fixture owns this source path; no denied VALIDATE
        // context is resumed and no permissions are changed for this probe.
        const file = path.join(workspace, 'src/cli.mjs'), original = await fs.readFile(file);
        const altered = Buffer.concat([original, Buffer.from('\n// TEST-ONLY foreign source edit\n')]);
        await fs.writeFile(file, altered);
        const liveBefore = await treeHashes(path.join(specPath, 'execution'));
        const blocked = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
        probes.push({ name: 'tested-source-edit', exit: blocked.status, diagnostic: blocked.stderr,
          foreignPreserved: (await fs.readFile(file)).equals(altered),
          livePreserved: JSON.stringify(liveBefore) === JSON.stringify(await treeHashes(path.join(specPath, 'execution'))),
          finalizationExists: await fs.access(finalizedFile).then(() => true, () => false) });
        await fs.writeFile(file, original);
      }
      const afterSummary = await snapshot('02-after-summary-only-correction');
      const second = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
      const afterSecond = await snapshot('03-after-second-finalize');
      reprepare ??= run(process.env.STNL_MANAGED_FINALIZER, ['--prepare']);
      const duplicate = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
      const rejectedInputAfter = await treeHashes(rejectedInput.candidateExecutionRoot);
      const retainedStageAfter = stagePresent && context.scenario === 'finalize-summary-rejection' ? await treeHashes(checkpointAfterFirst.stage.candidateExecutionRoot) : null;
      await fs.writeFile(path.join(evidenceRoot, 'observed.json'), JSON.stringify({ binding, receipt, before, afterFirst, afterSummary, afterSecond,
        checkpointAfterFirst, rejectedInput, rejectedInputAfter, retainedStageAfter, probes,
        first: { exit: first.status, diagnostic: first.stderr, command: first.command },
        second: { exit: second.status, diagnostic: second.stderr, command: second.command },
        reprepare: { exit: reprepare.status, diagnostic: reprepare.stderr, command: reprepare.command },
        duplicate: { exit: duplicate.status, diagnostic: duplicate.stderr, command: duplicate.command, result: duplicate.stdout },
        finalizationExists: await fs.access(finalizedFile).then(() => true, () => false) }, null, 2));
      throw new Error('TEST-ONLY reproduction preserved: ' + second.stderr);
    }
    if (coverageScenario && operation === 'VALIDATE_SLICE') {
      const receipt = JSON.parse(delegated.stdout.slice('SENTINEL_RUNNER_RECEIPT '.length).trim());
      const response = JSON.parse(await fs.readFile(receipt.semanticResponseFile));
      const binding = JSON.parse(prepared.stdout);
      let text = await fs.readFile(binding.candidateTaskArtifact, 'utf8');
      const { inspectExecutionState } = await importHelper('stnl-slice-quality-manager', 'execution-state.mjs');
      const state = await inspectExecutionState(specPath);
      const nextAttempt = 'attempt-' + String(state.tasks.get('slice-01').attempts.length + 1).padStart(2, '0');
      if (response.status === 'NEEDS_FIX') text = section(text, 'Validation Findings', coverageFinding(matrixClaim, nextAttempt));
      else if (response.status === 'PASS' && response.findingDispositions === 'finding-01=resolved') {
        text = text.replace('- State: active', '- State: resolved');
        const priorFinding = /## Validation Findings\n\n([\s\S]*?)(?=\n## |$)/u.exec(text)[1].trim();
        text = section(text, 'Validation Findings', priorFinding + '\n- Resolution: ' + nextAttempt + ' verified the required high variant and complete prepared coverage.');
      }
      await fs.writeFile(binding.candidateTaskArtifact, text);
    }
    if (applyScopeScenario && operation === 'APPLY_FINDINGS') {
      const active = JSON.parse(await fs.readFile(path.join(process.env.TMPDIR, 'stnl-runner-broker/active.json')));
      const repairFile = path.join(process.env.TMPDIR, 'stnl-runner-broker', `${String(active.sequence).padStart(3, '0')}.scope-repair.json`);
      if (await fs.access(repairFile).then(() => true, () => false)) {
        const probes = run(path.join(snapshot, 'scripts/fixtures/apply-scope-probes.mjs'));
        if (probes.status !== 0) throw new Error(probes.stderr);
      }
    }
    const finalized = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
    if (finalized.status) throw new Error(finalized.stderr);
    if (reassessmentScenario && operation === 'VALIDATE_SLICE') {
      const result = JSON.parse(finalized.stdout);
      if (result.state === 'VALIDATION_BLOCKED') {
        if (context.scenario === 'reassessment-source-change') await fs.appendFile(path.join(workspace, 'src/cli.mjs'), '\n// TEST-ONLY source change after publication\n');
        if (context.scenario === 'reassessment-tests-change') await fs.appendFile(path.join(workspace, 'test/offline-case.json'), '\n');
        if (context.scenario === 'reassessment-seed-tests-change') await fs.appendFile(path.join(workspace, 'test/cli.test.mjs'), '\n// TEST-ONLY seed check changed\n');
        if (context.scenario === 'reassessment-tests-added') await fs.writeFile(path.join(workspace, 'test/unapproved.test.mjs'), '// TEST-ONLY unclaimed check added\n');
        if (context.scenario === 'reassessment-decision-duplicate') await fs.writeFile(path.join(path.dirname(workspace), 'validation-reassessment-slice-01.json'), '');
        if (context.scenario === 'reassessment-authority-change') await fs.appendFile(path.join(specPath, 'shared/requirements.md'), '\nTEST-ONLY changed requirement authority.\n');
        if (context.scenario === 'reassessment-capture-change') {
          const receipt = JSON.parse(delegated.stdout.slice('SENTINEL_RUNNER_RECEIPT '.length).trim());
          await fs.appendFile(receipt.semanticResponseFile, '\n');
        }
        if (context.scenario === 'reassessment-provenance') emit({ type: 'item.completed', item: {
          id: 'item_' + sequence++, type: 'collab_tool_call', tool: 'spawn_agent', receiver_thread_ids: ['TEST-ONLY-unmanaged-context'], status: 'completed' } });
      }
    }
    if (operation === 'APPLY_FINDINGS') await fs.writeFile(path.join(context.root, '.offline-after-apply-task.md'), await fs.readFile(taskFile));
    if (JSON.parse(finalized.stdout).state === 'PRIVATE_TESTS_FAIL' && context.scenario === 'private-retry' && caseId === 'A') {
      const binding = JSON.parse(prepared.stdout);
      // Evidence is retained before the authorized CLI correction and round 2.
      const priorTask = await fs.readFile(binding.candidateTaskArtifact, 'utf8');
      if (!priorTask.includes('Status: TESTS_FAIL')) throw new Error('private failure was not retained');
      await fs.copyFile(path.join(snapshot, 'scripts/fixtures/filtered-cli.mjs'), path.join(workspace, 'src/cli.mjs'));
      const cliClaim = path.relative(path.join(specPath, 'execution/tasks'), path.join(workspace, 'src/cli.mjs')).split(path.sep).join('/');
      await fs.writeFile(binding.candidateTaskArtifact, section(priorTask, 'Corrections Applied', '- `' + cliClaim + '`'));
      const payload = JSON.parse(await fs.readFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD));
      await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ ...payload, automaticCheckRound: '2/3', corrections: ['Corrected approved completed/pending CLI filters.'] }));
      const next = run(process.env.STNL_MANAGED_RUNNER_BRIDGE, ['--payload-file', process.env.STNL_MANAGED_RUNNER_PAYLOAD]);
      if (next.status) throw new Error(next.stderr);
      const published = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
      if (published.status) throw new Error(published.stderr);
    }
    finish('Managed receipt finalized through existing producers and official readback.');
  } else if (operation === 'SPEC_CLOSE') {
    const candidate = path.join(roots.candidates, 'offline-closed');
    helper('stnl-spec-lifecycle-manager', 'build-closed-spec.mjs', [specPath, candidate]);
    helper('stnl-spec-lifecycle-manager', 'publish-spec-lifecycle.mjs', ['CLOSE', specPath, candidate]);
    finish('Closed documentary artifacts published through the lifecycle producer.');
  } else throw new Error('unsupported offline operation ' + operation);
} catch (error) { emit({ type: 'turn.failed', error: { message: 'TEST-ONLY fixture: ' + error.message } }); }
