import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexClientConfig, managedDiscoveryInstructions, runCodexTurn } from '../agents/codex/runtime/sdk-transport.mjs';
import { configText, isolatedEnvironment, verifyIsolatedHome } from '../agents/codex/runtime/isolated-home.mjs';
import { invokeIndependentRunner } from '../agents/codex/runtime/validation-runner.mjs';
import { decideOutcome, renderLauncher, renderManagedLauncher, runTemplateTurn } from '../benchmarks/sentinel-todo/runtime/benchmark-manager.mjs';
import { createUsageNormalizer, ZERO_USAGE } from '../agents/codex/runtime/usage-accounting.mjs';
import { workflowSkillForOperation } from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DENIAL = "zsh:1: can't create temp file for here document: operation not permitted\n";
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stnl-command-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('managed author and runner share workflow limits without claiming a host sandbox', async () => {
  const env = { STNL_CODEX_ADAPTER: '/snapshot/agents/codex/runtime' };
  const main = await codexClientConfig({ env });
  const runner = await codexClientConfig({ env, developerInstructions: 'Independent runner contract.' });
  assert.ok(runner.developer_instructions.startsWith('Independent runner contract.\n\n'));
  assert.ok(runner.developer_instructions.endsWith(main.developer_instructions));
  assert.match(main.developer_instructions, /Do not retry via another path, tool, TMPDIR\/TMPPREFIX setting, or permission mode/u);
  assert.equal(main.default_permissions, undefined);
  assert.equal(main.permissions, undefined);
  assert.equal(managedDiscoveryInstructions({ env: {} }), '', 'ordinary SDK contexts do not acquire managed inspection guidance');
});

test('manager and runner share explicit local discovery roots and the workspace cwd before dispatch', async (t) => {
  const root = await fixture(t);
  const workspace = path.join(root, 'workspace with space ü');
  const snapshot = path.join(root, 'snapshot');
  const candidates = path.join(root, 'candidates');
  const tmpdir = path.join(root, 'tmp');
  const shellHome = path.join(tmpdir, 'shell-home');
  const privateHome = path.join(root, 'private-home');
  const specPath = path.join(workspace, 'specs/benchmark-case-a');
  const executionRoot = path.join(specPath, 'execution');
  const skillsRoot = path.join(shellHome, '.agents/skills');
  for (const directory of [workspace, snapshot, candidates, tmpdir, skillsRoot,
    path.join(workspace, '.git'), path.join(workspace, 'src'), path.join(workspace, 'test'),
    path.join(executionRoot, 'plans'), path.join(executionRoot, 'tasks'),
    path.join(snapshot, 'agents/codex/.codex/agents')]) await fs.mkdir(directory, { recursive: true });
  for (const relative of ['feature_spec.md', 'execution/plan.md', 'execution/plans/slice-01.md', 'execution/tasks/slice-01.md']) {
    await fs.writeFile(path.join(specPath, relative), '# Offline artifact\n');
  }
  for (const relative of ['package.json', 'README.md', 'src/cli.mjs', 'test/cli.test.mjs']) {
    await fs.writeFile(path.join(workspace, relative), 'offline fixture\n');
  }
  await fs.writeFile(path.join(root, 'outside-workspace-sentinel.mjs'), 'must not be discovered\n');
  await fs.copyFile(path.join(ROOT, 'agents/codex/.codex/agents/stnl_validation_runner.toml'),
    path.join(snapshot, 'agents/codex/.codex/agents/stnl_validation_runner.toml'));
  for (const name of ['stnl-spec-lifecycle-manager', ...new Set(['PLAN', 'REVIEW_PLAN', 'MATERIALIZE_TASKS',
    'REVIEW_TASKS', 'EXECUTE_SLICE', 'VALIDATE_SLICE'].map(workflowSkillForOperation))]) {
    await fs.cp(path.join(ROOT, 'skills/workflows', name), path.join(snapshot, 'skills/workflows', name), { recursive: true });
    await fs.cp(path.join(snapshot, 'skills/workflows', name), path.join(skillsRoot, name), { recursive: true });
  }
  const env = isolatedEnvironment({ privateHome, shellHome, tmpdir, snapshot, workspace, candidates });
  const discovery = managedDiscoveryInstructions({ env, cwd: workspace });
  assert.deepEqual(JSON.parse(env.STNL_DISCOVERY_PATHS), { workspace, snapshot, candidates, tmpdir, skillsRoot });
  for (const target of [workspace, snapshot, candidates, tmpdir, skillsRoot]) {
    assert.ok(discovery.includes(JSON.stringify(target)), `missing configured path ${target}`);
  }
  // The failed run records this diagnostic and target, but no rg argv event.
  // Reproduce the discovery scope defect without issuing that denied search.
  const reportedFailure = { target: '..', diagnostic: 'rg: ..: Operation not permitted (os error 1)' };
  assert.notEqual(path.resolve(workspace, reportedFailure.target), workspace);
  assert.match(discovery, /rg\/find on \.\./u);
  assert.match(discovery, /Relative \.\. components in persisted artifact paths are rebasing/u);
  assert.match(discovery, /independent runner remains read only/u);
  assert.ok(!discovery.includes('Local Git marker:'));
  assert.match(discovery, /Inspect only what the selected workflow operation requires/u);
  assert.match(discovery, /Generic repository status checks are not a prerequisite/u);
  assert.match(discovery, /Use Git only when that operation requires Git evidence/u);
  const inventory = spawnSync('rg', ['--files', '--', '.'], { cwd: workspace, encoding: 'utf8' });
  assert.equal(inventory.status, 0, inventory.stderr);
  assert.ok(inventory.stdout.includes('./src/cli.mjs'));
  assert.ok(inventory.stdout.includes('./test/cli.test.mjs'));
  assert.ok(!inventory.stdout.includes('outside-workspace-sentinel'));

  for (const [operation, template] of [
    ['SPEC_INIT', 'spec-init.md'], ['SPEC_READINESS', 'spec-readiness.md'], ['SPEC_RESUME', 'spec-resume.md'],
    ['SPEC_PROMOTE', 'spec-resume.md'], ['SPEC_CLOSE', 'spec-close.md'],
    ['PLAN', 'execution-plan.md'], ['REPLAN', 'execution-replan.md'], ['REVIEW_PLAN', 'execution-plan-review.md'],
    ['MATERIALIZE_TASKS', 'execution-tasks.md'], ['REVIEW_TASKS', 'execution-tasks-review.md'],
    ['EXECUTE_SLICE', 'slice-execute-codex.md'], ['APPLY_FINDINGS', 'slice-apply-findings-codex.md'],
    ['VALIDATE_SLICE', 'slice-validate-codex.md'],
  ]) {
    const text = await fs.readFile(path.join(ROOT, 'templates/prompts', template), 'utf8');
    const values = { SPEC_PATH: specPath, SLICE: '1', REPLAN_REASON: 'offline regression',
      REQUIREMENTS_SOURCE: path.join(workspace, 'requirements.md'), READINESS_SCOPE: 'GLOBAL', NEW_INFORMATION: 'offline evidence' };
    const workflowSkill = operation.startsWith('SPEC_') ? 'stnl-spec-lifecycle-manager' : workflowSkillForOperation(operation);
    assert.ok(text.startsWith('Use `' + workflowSkill + '`.'), 'concrete base must agree with the invoked launcher owner');
    const scopedDiscovery = managedDiscoveryInstructions({ env, cwd: workspace, workflowSkill });
    const skillBase = path.join(skillsRoot, workflowSkill);
    assert.ok(scopedDiscovery.includes(`Invoked skill resource base: ${JSON.stringify(skillBase)}.`));
    for (const family of ['runtime', 'templates', 'references']) {
      assert.ok(scopedDiscovery.includes(JSON.stringify(path.join(skillBase, family))));
    }
    assert.match(scopedDiscovery, /never SPEC_PATH, the execution root, candidate root or command cwd/u);
    assert.ok(!renderLauncher(text, values).includes('Project working directory and implementation root:'));
    const prompt = renderManagedLauncher(text, values, scopedDiscovery);
    assert.ok(prompt.endsWith(scopedDiscovery + '\n'));
    if (!operation.startsWith('SPEC_')) assert.match(prompt, new RegExp(`OPERATION=${operation}`, 'u'));
    const config = await codexClientConfig({ env, cwd: workspace });
    assert.ok(config.developer_instructions.endsWith(discovery));
    assert.match(config.developer_instructions, /Do not retry via another path/u);
    assert.equal(config.default_permissions, undefined);
    assert.equal(config.permissions, undefined);
  }
  const materializer = path.join(skillsRoot, 'stnl-task-materializer');
  for (const resource of ['runtime/prepare-task-candidate.mjs', 'templates/tasks.template.md',
    'templates/slice-tasks.template.md', 'references/execution-record-schema.md']) {
    assert.deepEqual(await fs.readFile(path.join(materializer, resource)),
      await fs.readFile(path.join(snapshot, 'skills/workflows/stnl-task-materializer', resource)));
    await assert.rejects(fs.access(path.join(executionRoot, resource)), { code: 'ENOENT' });
  }
  const policy = configText({ privateHome, snapshot, workspace, candidates, tmpdir });
  assert.match(policy, /^sandbox_mode = "danger-full-access"$/mu);
  assert.match(policy, /^approval_policy = "never"$/mu);
  assert.doesNotMatch(policy, /default_permissions|\[permissions\.|sandbox_workspace_write|allowed_roots/u);
  assert.match(discovery, /Full Access, without a host filesystem security boundary/u);
  assert.match(discovery, /read only by contract/u);

  const cli = path.join(root, 'offline-discovery-codex.mjs');
  const capture = path.join(root, 'sdk-dispatch.jsonl');
  await fs.writeFile(cli, '#!' + process.execPath + '\nimport fs from "node:fs";\n'
    + 'const index=fs.existsSync(process.env.STNL_FAKE_CAPTURE)?fs.readFileSync(process.env.STNL_FAKE_CAPTURE,"utf8").trim().split("\\n").length:0;\n'
    + 'fs.appendFileSync(process.env.STNL_FAKE_CAPTURE, JSON.stringify({args:process.argv.slice(2),prompt:fs.readFileSync(0,"utf8")})+"\\n");\n'
    + 'console.log(JSON.stringify({type:"thread.started",thread_id:"offline-template-"+index}));\n'
    + 'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:100+index,output_tokens:10+index,cached_input_tokens:20+index,reasoning_output_tokens:1+index}}));\n');
  await fs.chmod(cli, 0o755);
  const offlineEnv = { ...env, STNL_FAKE_CAPTURE: capture };
  const authorPrompts = [];
  const authorTurns = [];
  const usage = createUsageNormalizer({ baseline: ZERO_USAGE, source: 'main' });
  let priorThreadId = 'legacy-cached-author';
  for (const [operation, template] of [['PLAN', 'execution-plan.md'], ['REVIEW_PLAN', 'execution-plan-review.md'],
    ['PLAN', 'execution-plan.md'], ['REVIEW_PLAN', 'execution-plan-review.md'],
    ['MATERIALIZE_TASKS', 'execution-tasks.md'], ['REVIEW_TASKS', 'execution-tasks-review.md']]) {
    const text = await fs.readFile(path.join(ROOT, 'templates/prompts', template), 'utf8');
    const prompt = renderManagedLauncher(text, { SPEC_PATH: specPath }, managedDiscoveryInstructions({
      env, cwd: workspace, workflowSkill: workflowSkillForOperation(operation) }));
    authorPrompts.push(prompt);
    const author = await runTemplateTurn({ runCodexTurn }, { env: offlineEnv, cwd: workspace, prompt,
      model: 'gpt-6-luna', effort: 'medium', threadId: priorThreadId,
      operationId: `offline-${operation}-${authorTurns.length}`,
      eventsPath: path.join(root, `${operation}-${authorTurns.length}.events.jsonl`), codexPathOverride: cli });
    assert.equal(author.completed, true, author.error);
    authorTurns.push(author);
    priorThreadId = author.threadId;
    const observed = usage.observe({ threadId: author.threadId, segment: 'offline-run', usage: author.usage });
    assert.equal(observed.status, 'attributable');
    assert.equal(observed.delta.input, author.usage.input_tokens);
    assert.equal(observed.delta.output, author.usage.output_tokens);
    assert.equal(observed.delta.total, author.usage.input_tokens + author.usage.output_tokens);
    assert.equal(usage.observe({ threadId: author.threadId, segment: 'offline-run', usage: author.usage }).delta.total, 0);
  }
  assert.equal(new Set(authorTurns.map((turn) => turn.threadId)).size, 6);
  assert.deepEqual(usage.snapshot().reduce((sum, state) => ({ input: sum.input + state.previous.input_tokens,
    output: sum.output + state.previous.output_tokens, cached: sum.cached + state.previous.cached_input_tokens,
    reasoning: sum.reasoning + state.previous.reasoning_output_tokens }), { input: 0, output: 0, cached: 0, reasoning: 0 }),
    { input: 615, output: 75, cached: 135, reasoning: 21 });

  for (const operation of ['EXECUTE_SLICE', 'VALIDATE_SLICE']) {
    let dispatched;
    await invokeIndependentRunner({ snapshot, workspace, tmpdir, env: offlineEnv, operation, sequence: 1,
      slice: 'slice-01', officialPreflight: { exitCode: 0, operation, slice: 'slice-01', specPath,
        legalOperations: [{ operation, slice: 'slice-01' }], mandatoryRecovery: null },
      prompt: operation === 'EXECUTE_SLICE' ? 'automaticCheckRound=1/3\nOffline check payload.' : 'Offline validation payload.',
      runTurn: async (input) => {
        dispatched = input;
        // Exercise SDK dispatch only. The fake CLI performs no checks and its
        // missing semantic response is never claimed as successful validation.
        return runCodexTurn({ ...input, codexPathOverride: cli });
      } });
    assert.equal(dispatched.cwd, workspace);
    assert.ok(dispatched.prompt.includes(`MANAGED_WORKSPACE=${workspace}`));
    assert.ok(dispatched.prompt.includes(`SPEC_PATH=${specPath}`));
    assert.ok(dispatched.prompt.includes(`EXECUTION_ROOT=${executionRoot}`));
    const config = await codexClientConfig(dispatched);
    assert.ok(config.developer_instructions.startsWith(dispatched.developerInstructions));
    assert.ok(config.developer_instructions.endsWith(discovery));
    assert.equal(dispatched.isolateSkills, true);
    assert.ok(config.skills.config.every((skill) => skill.enabled === false));
  }
  const calls = (await fs.readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls.slice(0, 6).map((call) => call.prompt), authorPrompts);
  for (const [index, operation] of ['PLAN', 'REVIEW_PLAN', 'PLAN', 'REVIEW_PLAN', 'MATERIALIZE_TASKS', 'REVIEW_TASKS'].entries()) {
    const base = path.join(skillsRoot, workflowSkillForOperation(operation));
    assert.ok(calls[index].prompt.includes(`Invoked skill resource base: ${JSON.stringify(base)}.`));
    for (const family of ['runtime', 'templates', 'references']) assert.ok(calls[index].prompt.includes(JSON.stringify(path.join(base, family))));
  }
  for (const call of calls.slice(6)) assert.ok(!call.prompt.includes('Invoked skill resource base:'), 'independent runner must not inherit the author skill');
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'danger-full-access');
    assert.ok(call.args.includes('approval_policy="never"'));
    assert.ok(!call.args.some((arg) => /default_permissions|permissions\./u.test(arg)));
    assert.ok(!call.args.includes('resume'), 'a new template or independent runner must start a new SDK thread');
    assert.ok(!call.args.some((arg) => arg.startsWith('offline-template-') || arg === 'legacy-cached-author'));
    assert.equal(call.args[call.args.indexOf('--cd') + 1], workspace);
    const config = call.args.find((value) => value.startsWith('developer_instructions='));
    assert.ok(config.includes(JSON.stringify(workspace).slice(1, -1)));
    assert.ok(config.includes('do not rediscover it or instructions by searching parent directories'));
    assert.ok(config.includes('Inspect only what the selected workflow operation requires'));
    assert.ok(config.includes('Generic repository status checks are not a prerequisite'));
    assert.ok(config.includes('Use Git only when that operation requires Git evidence'));
    assert.ok(config.includes('If any command reports a sandbox or permission denial, stop'));
    assert.ok(!config.includes('Local Git marker:'));
  }
  const managerSource = await fs.readFile(path.join(ROOT, 'benchmarks/sentinel-todo/runtime/benchmark-manager.mjs'), 'utf8');
  assert.match(managerSource, /turn = await runTemplateTurn\(product, \{/u, 'the operation loop must use the tested SDK boundary');
  assert.doesNotMatch(managerSource, /const threadId = caseState\.threads/u);
  assert.match(managerSource, /operation\.startsWith\('SPEC_'\) \? 'stnl-spec-lifecycle-manager' : product\.workflowSkillForOperation\(operation\)/u);
  assert.match(managerSource, /managedDiscoveryInstructions\(\{ env: home\.env, cwd: workspace, workflowSkill \}\)/u);
  assert.throws(() => managedDiscoveryInstructions({ env, cwd: workspace, workflowSkill: '../stnl-task-materializer' }), /workflow skill/u);
  assert.throws(() => managedDiscoveryInstructions({ env, cwd: path.dirname(workspace) }), /working directory/u);
  assert.throws(() => managedDiscoveryInstructions({ env: { ...env, TMPDIR: '/tmp' }, cwd: workspace }), /configured environment/u);
  const badRoots = { ...JSON.parse(env.STNL_DISCOVERY_PATHS), workspace: `${workspace}/..` };
  assert.throws(() => managedDiscoveryInstructions({ env: { ...env, STNL_DISCOVERY_PATHS: JSON.stringify(badRoots) } }), /canonical absolute path/u);
});

test('Full Access case config and effective report must agree; restricted or managed denies block verification', async (t) => {
  // No preparation/login/doctor subprocess or credential file: exercise the
  // existing verifier with empty hashed skill copies and recorded report data.
  const root = await fixture(t);
  const workspace = path.join(root, 'workspace'), snapshot = path.join(root, 'snapshot');
  const tmpdir = path.join(root, 'tmp'), candidates = path.join(root, 'candidates');
  const shellHome = path.join(tmpdir, 'shell-home'), privateHome = path.join(root, 'private-home');
  for (const directory of [workspace, candidates, privateHome, path.join(snapshot, 'skills/workflows'),
    path.join(shellHome, '.agents/skills')]) await fs.mkdir(directory, { recursive: true });
  const config = configText({ privateHome, snapshot, workspace, candidates, tmpdir });
  await fs.writeFile(path.join(privateHome, 'config.toml'), config);
  const home = { privateHome, shellHome,
    configSha256: 'sha256:' + createHash('sha256').update(config).digest('hex'),
    snapshotSkillsSha256: 'sha256:' + createHash('sha256').update('sentinel-skill-copy-v1\0').digest('hex'),
    env: isolatedEnvironment({ privateHome, shellHome, tmpdir, snapshot, workspace, candidates }) };
  const sandbox = { 'filesystem sandbox': 'unrestricted', 'network sandbox': 'enabled',
    'approval policy': 'Never', 'denied-read rules': '0', 'denied-read glob rules': '0' };
  function runCommand(overrides = {}, processResult = {}) {
    return (_command, args) => args[0] === 'login'
      ? { status: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' }
      : { status: 0, stdout: JSON.stringify({ checks: {
        'auth.credentials': { details: { 'stored auth mode': 'chatgpt', 'stored API key': 'false' } },
        'config.load': { details: { 'model provider': 'openai' } },
        'sandbox.helpers': { details: { ...sandbox, ...overrides } },
      } }), stderr: '', ...processResult };
  }
  assert.deepEqual(await verifyIsolatedHome(home, { runCommand: runCommand() }), {
    authMode: 'chatgpt', provider: 'openai', filesystemSandbox: 'unrestricted', sandboxMode: 'danger-full-access',
  });
  for (const [processResult, diagnostic] of [
    [{ status: 1 }, /doctor failed \(exit: 1, signal: none\)/u],
    [{ status: null, signal: 'SIGTERM' }, /doctor failed \(exit: null, signal: SIGTERM\)/u],
    [{ status: undefined }, /doctor failed \(exit: null, signal: none\)/u],
    [{ status: null, stdout: '', error: new Error('spawn failed') }, /doctor failed \(exit: null, signal: none\)/u],
  ]) {
    await assert.rejects(verifyIsolatedHome(home, { runCommand: runCommand({}, processResult) }), (error) => {
      assert.match(error.message, diagnostic);
      assert.equal(error.cause, processResult.error);
      return true;
    });
  }
  for (const overrides of [{ 'filesystem sandbox': 'restricted' }, { 'network sandbox': 'restricted' },
    { 'approval policy': 'OnRequest' }, { 'denied-read rules': '1' }, { 'denied-read glob rules': '1' },
    { 'filesystem sandbox': undefined }]) {
    await assert.rejects(verifyIsolatedHome(home, { runCommand: runCommand(overrides) }), /report does not match policy/u);
  }
  await fs.appendFile(path.join(privateHome, 'config.toml'), '\n# tampered\n');
  await assert.rejects(verifyIsolatedHome(home, { runCommand: runCommand() }), /config changed/u);
});

async function recordedCommand(t, command, output, exitCode = 0, response = null) {
  const root = await fixture(t);
  const cli = path.join(root, 'offline-codex.mjs');
  const eventsPath = path.join(root, 'events.jsonl');
  const deniedEvent = { type: 'item.completed', item: { id: 'item_1', type: 'command_execution',
    command, status: 'completed', exit_code: exitCode, aggregated_output: output } };
  await fs.writeFile(cli, '#!' + process.execPath + '\n'
    + 'for(const event of ' + JSON.stringify([{ type: 'thread.started', thread_id: 'offline-denial' },
      { type: 'turn.started' }, deniedEvent,
      ...(response === null ? [] : [{ type: 'item.completed', item: { id: 'response', type: 'agent_message', text: response } }]),
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }])
    + ') console.log(JSON.stringify(event));\n');
  await fs.chmod(cli, 0o755);
  const turn = await runCodexTurn({ env: { CODEX_HOME: root }, cwd: root, prompt: 'offline fixture',
    model: 'gpt-6-luna', effort: 'medium', operationId: 'offline-denial', eventsPath, codexPathOverride: cli });
  const events = (await fs.readFile(eventsPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.find((event) => event.item?.id === 'item_1'), { operationId: 'offline-denial', ...deniedEvent });
  return turn;
}

test('recorded git cache denial with final exit zero and a compliant stop remains blocked without official review transition', async (t) => {
  // Replay recorded command output, never execute git in the failed run. This
  // proves event retention and the existing state gate, not model obedience or
  // a general SDK denial detector (its special guard covers shell redirections).
  const output = "git: error: couldn't create cache file '/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/xcrun_db-TDCyAlG2' (errno=Operation not permitted)\n"
    + "git: error: couldn't create cache file '/var/folders/yx/psjzdbd91pg9v2h4hm5m_vbr0000gn/T/xcrun_db-jZUxUVXr' (errno=Operation not permitted)\n?? specs/\n";
  const response = 'REVIEW_PLAN is BLOCKED after a permission denial. No candidate was published.';
  const turn = await recordedCommand(t, "/bin/zsh -lc 'git status --short'", output, 0, response);
  assert.equal(turn.completed, true, 'SDK turn completion is distinct from official workflow success');
  assert.equal(turn.error, null);
  assert.equal(turn.response, response);
  assert.deepEqual(decideOutcome('REVIEW_PLAN', { execution: { state: 'PLANNED_DRAFT' } }, turn.completed),
    { result: 'BLOCKED', blocker: 'OFFICIAL_TRANSITION_NOT_OBSERVED' });
});

test('SDK preserves implicit-temp denial for recorded heredocs and here-strings, including final exit zero', async (t) => {
  for (const [command, kind, prefix = ''] of [
    ["/bin/zsh -lc 'cat <<EOF\ncheck\nEOF\ntrue'", 'document'],
    ['cat <<-EOF\ncheck\nEOF', 'document'],
    ["/bin/zsh -lc 'cat <<\"EOF\"\ncheck\nEOF\ntrue'", 'document'],
    ['/bin/zsh -f -c "cat <<< check; true"', 'string'],
    ['cat <<< check; true', 'string', DENIAL],
  ]) {
    for (const exitCode of [0, 1]) {
      await t.test(`${kind}, exit ${exitCode}: ${command}`, async (t) => {
        const turn = await recordedCommand(t, command, prefix + DENIAL.replace('document', kind)
          + '{"status":"PASS","changedPaths":[]}\n', exitCode);
        assert.equal(turn.completed, false);
        assert.match(turn.error, /SANDBOX_COMMAND_DENIED/u);
        assert.deepEqual(decideOutcome('REVIEW_PLAN', { execution: { state: 'PLANNED_READY' } }, turn.completed),
          { result: 'BLOCKED', blocker: 'SDK_TURN_FAILED' });
      });
    }
  }
});

test('SDK accepts denial text printed as data without a recorded implicit-temp operation', async (t) => {
  for (const [command, kind = 'document'] of [
    [`printf '%s\\n' "${DENIAL.trim()}"`],
    ["node scripts/print-diagnostic.mjs"],
    ["printf '%s\\n' 'cat <<EOF'"],
    ['/bin/zsh -lc "printf \'%s\\n\' \'cat <<< check\'"', 'string'],
    ['printf %s cat\\<\\<EOF'],
    ['node scripts/print-diagnostic.mjs # cat <<EOF'],
  ]) {
    await t.test(command, async (t) => {
      const turn = await recordedCommand(t, command, DENIAL.replace('document', kind));
      assert.equal(turn.completed, true);
      assert.equal(turn.error, null);
      assert.equal(turn.toolCalls, 1);
      assert.equal(turn.usage.input_tokens, 1);
      assert.equal(turn.usage.output_tokens, 1);
    });
  }
});

test('zsh uses a separate implicit-temp prefix even when TMPDIR names an authorized destination', async (t) => {
  if (process.platform !== 'darwin') { t.skip('observed zsh/macOS regression'); return; }
  const root = await fixture(t);
  const result = spawnSync('/bin/zsh', ['-f', '-c', 'print -r -- "$TMPDIR" "$TMPPREFIX"'], {
    env: { ...process.env, TMPDIR: root }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), root + ' /tmp/zsh');
});

test('prepared AC checks run without filesystem writes; heredoc cannot create its implicit temp', async (t) => {
  if (process.platform !== 'darwin') { t.skip('macOS sandbox regression'); return; }
  const root = await fixture(t);
  const source = path.join(root, 'source with quotes');
  await fs.cp(path.join(ROOT, 'benchmarks/sentinel-todo/seed/src'), source, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'scripts/fixtures/filtered-cli.mjs'), path.join(source, 'cli.mjs'));
  const fixtures = path.join(root, 'fixtures');
  await fs.mkdir(fixtures);
  const title = 'Olá "quoted" \\ backslash $() `literal`\nline';
  for (const [name, todos] of [['mixed', [{ id: 3, title, completed: false },
    { id: 1, title: 'first', completed: true }, { id: 2, title: 'second', completed: false }]],
    ['empty', []], ['pending', [{ id: 1, title, completed: false }]]]) {
    await fs.writeFile(path.join(fixtures, name + '.json'), JSON.stringify({ todos }, null, 3) + '\n');
  }
  const policy = '(version 1)(allow default)(deny file-write*)';
  const heredoc = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, '/bin/zsh', '-f', '-c',
    'cat <<EOF\nthis program needs implicit temp storage\nEOF\ntrue'], {
    env: { ...process.env, TMPDIR: fixtures }, encoding: 'utf8',
  });
  assert.equal(heredoc.status, 0, heredoc.stderr);
  assert.match(heredoc.stderr, /can't create temp file for here document: operation not permitted/u);
  const prepared = path.join(ROOT, 'scripts/fixtures/prepared-list-check.mjs');
  const invoke = () => spawnSync('/usr/bin/sandbox-exec', ['-p', policy, process.execPath,
    prepared, path.join(source, 'cli.mjs'), fixtures], { encoding: 'utf8' });
  const checked = invoke();
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /40 list\/filter\/invalid-flag cases/u);
  // The old suite passes for the seed but does not prove any filter coverage.
  await fs.copyFile(path.join(ROOT, 'benchmarks/sentinel-todo/seed/src/cli.mjs'), path.join(source, 'cli.mjs'));
  const missingCoverage = invoke();
  assert.equal(missingCoverage.status, 1);
  assert.match(missingCoverage.stderr, /AssertionError/u);
});
