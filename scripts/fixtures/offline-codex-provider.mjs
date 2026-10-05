#!/usr/bin/env node
// External-provider fixture only. Runs real helpers/checks; never writes receipts,
// journals, ledgers or benchmark verdicts. It has no network/provider dependency.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { offlineProviderContext } from '../../agents/codex/runtime/offline-provider-context.mjs';
import { renderOfflineArtifacts, targets } from './offline-workflow-artifacts.mjs';

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
try {
  if (!independent && operation === 'SPEC_INIT' && ['B', 'C'].includes(caseId) && context.scenario !== 'coverage-findings') {
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
    const coverageReview = context.scenario === 'coverage-findings' && operation !== 'EXECUTE_SLICE';
    const observed = run('--test', [], true, coverageReview ? { STNL_OFFLINE_REQUIRE_PRIORITY_COVERAGE: '1' } : {});
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' });
    if (head.status !== 0) throw new Error('HEAD unavailable');
    const commands = [{ command: observed.command, exit: observed.status }];
    const passed = observed.status === 0;
    const evidence = `${caseId} prepared case variants and original seed tests; ${observed.stdout}`;
    if (operation === 'VALIDATE_SLICE') {
      const matrix = JSON.parse(await fs.readFile(path.join(workspace, 'test/offline-case.json')));
      const coverageOmitted = coverageReview && !matrix.priorities.includes('high');
      const previousFinding = (await fs.readFile(taskFile, 'utf8')).includes('### finding-01');
      finish({ status: passed ? 'PASS' : coverageOmitted ? 'NEEDS_FIX' : 'BLOCKED', head: head.stdout.trim(), commands, evidence,
        findingReferences: coverageOmitted || previousFinding ? 'finding-01' : 'none',
        findingDispositions: coverageOmitted ? 'finding-01=active' : previousFinding && passed ? 'finding-01=resolved' : 'none',
        blockers: passed || coverageOmitted ? 'none' : 'Prepared check failed; no correction judgment simulated.', unexpectedWorkspaceEffects: 'none', persistenceSummary: 'No runner writes to the workspace.' });
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
        findingsVerified: 'finding-01', correctionsCovered: 'Prepared matrix includes high.', regressionsSelected: 'Complete prepared priority checks and original seed tests.', unsupportedActiveFindings: 'none',
      });
      else Object.assign(response, { priorRoundFailure: round === '1/3' ? 'none' : 'Prepared completed/pending variants failed in the previous round.',
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
    await renderOfflineArtifacts({ snapshot, workspace, specPath, candidateExecutionRoot });
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
    await renderOfflineArtifacts({ snapshot, workspace, specPath, tasks: true, candidateExecutionRoot: candidate.candidateExecutionRoot });
    helper('stnl-task-materializer', 'publish-task-candidate.mjs', ['--publish', '--spec-path', specPath, '--candidate-execution-root', candidate.candidateExecutionRoot]);
    finish('Tasks materialized through the authorized publisher.');
  } else if (operation === 'REVIEW_TASKS') {
    helper('stnl-task-reviewer', 'validate-execution-state.mjs', [specPath, 'REVIEW_TASKS']);
    finish('Materialized task and authorized prepared check scope agree.');
  } else if (['EXECUTE_SLICE', 'VALIDATE_SLICE', 'APPLY_FINDINGS'].includes(operation)) {
    if (context.scenario === 'zero-runner' && operation === 'EXECUTE_SLICE') { finish('No request: injected main omission.'); process.exit(0); }
    const prepared = run(process.env.STNL_MANAGED_FINALIZER, ['--prepare']);
    if (prepared.status) throw new Error(prepared.stderr);
    if (operation === 'EXECUTE_SLICE') {
      const cli = { A: 'filtered-cli.mjs', B: 'prioritized-cli.mjs', C: 'archived-cli.mjs' }[caseId];
      if (context.scenario !== 'private-retry' || caseId !== 'A') await fs.copyFile(path.join(snapshot, 'scripts/fixtures', cli), path.join(workspace, 'src/cli.mjs'));
      await fs.mkdir(path.join(workspace, 'test'), { recursive: true });
      await fs.copyFile(path.join(snapshot, 'scripts/fixtures/prepared-offline-case.test.mjs'), path.join(workspace, 'test/offline-case.test.mjs'));
      await fs.writeFile(path.join(workspace, 'test/offline-case.json'), JSON.stringify({ caseId,
        ...(context.scenario === 'coverage-findings' ? { priorities: ['low', 'medium'] } : {}) }));
      const binding = JSON.parse(prepared.stdout);
      let text = await fs.readFile(binding.candidateTaskArtifact, 'utf8');
      text = text.replace('- [ ] 1.1', '- [x] 1.1');
      const claims = targets.map((target) => path.relative(path.join(specPath, 'execution/tasks'), path.join(workspace, target)).split(path.sep).join('/'));
      text = section(text, 'Changed Areas', claims.map((value) => '- `' + value + '`').join('\n'));
      text = section(text, 'Diff Summary', '- Implemented the selected case and prepared required variants in the authorized slice.');
      await fs.writeFile(binding.candidateTaskArtifact, text);
      await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ automaticCheckRound: '1/3', changedAreas: claims, relevantEvidence: 'Authorized complete case checks prepared before independent delegation.' }));
    } else if (operation === 'APPLY_FINDINGS') {
      const binding = JSON.parse(prepared.stdout);
      await fs.writeFile(path.join(context.root, '.offline-apply-before-task.md'), await fs.readFile(taskFile));
      await fs.writeFile(path.join(context.root, '.offline-apply-source-before.sha256'), await digest(path.join(workspace, 'src/cli.mjs')));
      const matrix = JSON.parse(await fs.readFile(path.join(workspace, 'test/offline-case.json')));
      await fs.writeFile(path.join(workspace, 'test/offline-case.json'), JSON.stringify({ ...matrix, priorities: ['low', 'medium', 'high'] }));
      await fs.writeFile(binding.candidateTaskArtifact, section(await fs.readFile(binding.candidateTaskArtifact, 'utf8'), 'Corrections Applied', '- `' + matrixClaim + '`'));
      const claims = targets.map((target) => path.relative(path.dirname(taskFile), path.join(workspace, target)).split(path.sep).join('/'));
      await fs.writeFile(process.env.STNL_MANAGED_RUNNER_PAYLOAD, JSON.stringify({ automaticCheckRound: '1/3', changedAreas: claims, activeFindings: ['finding-01'], corrections: ['Added required high variant to the authorized prepared matrix.'], relevantEvidence: 'Prepared coverage assertion and CLI regressions are ready.' }));
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
    const delegated = run(process.env.STNL_MANAGED_RUNNER_BRIDGE, ['--payload-file', process.env.STNL_MANAGED_RUNNER_PAYLOAD]);
    if (delegated.status) throw new Error(delegated.stderr);
    if (context.scenario === 'coverage-findings' && operation === 'VALIDATE_SLICE') {
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
    const finalized = run(process.env.STNL_MANAGED_FINALIZER, ['--finalize']);
    if (finalized.status) throw new Error(finalized.stderr);
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
