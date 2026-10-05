import fs from 'node:fs/promises';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { offlineProviderContext } from './offline-provider-context.mjs';

const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const ALLOWED_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra']);
const MANAGED_COMMAND_INSTRUCTIONS = [
  'Keep edits within the selected workflow scope and use prepared checks without implicit shell temporary dependencies.',
  'Do not use heredocs or here-strings or generate',
  'multiline programs through nested shell quoting. Use already prepared scripts for checks; authorized',
  'implementation prepares reusable tests before delegation, while the independent runner never edits them.',
  'For authorized artifact edits, use permitted file editing within the selected scope before validation.',
  'If any command reports a sandbox or permission denial, stop and preserve the whole diagnostic even if',
  'its final exit is zero. Do not retry via another path, tool, TMPDIR/TMPPREFIX setting, or permission mode.',
  'Missing evidence alone is BLOCKED; a passing old suite does not prove the new acceptance criteria.',
  'For VALIDATE_SLICE only, a demonstrated defect or omitted required variant in executor-prepared tests already required by current authority and authorized in this slice',
  'is NEEDS_FIX with a specific coverage finding, direct evidence, authorized path and expected in-scope correction.',
  'Only the executor corrects through APPLY_FINDINGS then VALIDATE_SLICE within existing budgets; no runner writes or extra calls.',
  'Every finding must demonstrate a violated current requirement or required variant on an authorized path in this slice.',
  'Before claiming coverage is absent, compare the current requirement/variant, input actually persisted or supplied to the check, expected assertion, and relevant producer path.',
  'Inspect that producer and the fixture/assertion; cite paths and observed values or excerpts, including transformations/calls, instead of inferring absence from fixture syntax or a test name.',
  'Distinguish required coverage from optional improvements; this remains semantic judgment and does not authorize automatic PASS.',
  'A preference for a stronger assertion or an unrequired exact output string is not a coverage defect.',
  'VALIDATE_SLICE commands must be nonempty and report actually executed verification commands and exits, including NEEDS_FIX/BLOCKED.',
  'Discovery and inspection are not verification commands; never fabricate a command or exit to satisfy the schema.',
  'Access, transport, environment and insufficient authority remain BLOCKED; never PASS before sufficient evidence.',
].join('\n');

function hasShellTemporaryRedirection(command, kind) {
  // Inspect recorded shell syntax, not quoted/escaped output data. Decode only
  // a shell's explicit -c argument; arbitrary program arguments are not shell.
  const words = String(command ?? '').match(/#[^\n]*|(?:\\[\s\S]|'[^']*'|"(?:\\[\s\S]|[^"\\])*"|[^\s'"\\<>;&|()])+|<<<|<<-?|[<>;&|()]/gu) ?? [];
  const operator = kind === 'string' ? /^<<<$/u : /^<<-?$/u;
  if (words.some((word) => operator.test(word))) return true;
  if (!/^(?:\/[^\s]+\/)?(?:zsh|bash|sh)$/u.test(words[0] ?? '')) return false;
  const option = words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/u.test(word));
  if (option < 0 || words[option + 1] === undefined) return false;
  const script = words[option + 1].replace(/'([^']*)'|"((?:\\[\s\S]|[^"\\])*)"|\\([\s\S])/gu,
    (_, single, double, escaped) => single ?? double?.replace(/\\([$`"\\\n])/gu, '$1') ?? escaped);
  return hasShellTemporaryRedirection(script, kind);
}

function deniedShellTemporaryFile(event) {
  if (event.type !== 'item.completed' || event.item?.type !== 'command_execution') return false;
  const denials = String(event.item.aggregated_output ?? '').matchAll(
    /^zsh:[0-9]+: can't create temp file for here (document|string): operation not permitted\s*$/gmu);
  return [...denials].some((denial) => hasShellTemporaryRedirection(event.item.command, denial[1]));
}

export function managedDiscoveryInstructions({ env, cwd = null, workflowSkill = null }) {
  if (!env.STNL_DISCOVERY_PATHS) return '';
  const roots = JSON.parse(env.STNL_DISCOVERY_PATHS);
  for (const name of ['workspace', 'snapshot', 'candidates', 'tmpdir', 'skillsRoot']) {
    const value = roots[name];
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\r\n\0]/u.test(value)) {
      throw new Error(`managed discovery ${name} is not a canonical absolute path`);
    }
  }
  if ((cwd !== null && cwd !== roots.workspace)
    || env.STNL_CODEX_ADAPTER !== path.join(roots.snapshot, 'agents/codex/runtime')
    || env.TMPDIR !== roots.tmpdir || roots.skillsRoot !== path.join(env.HOME, '.agents/skills')) {
    throw new Error('managed discovery paths disagree with the configured environment or working directory');
  }
  if (workflowSkill !== null && (typeof workflowSkill !== 'string' || !/^stnl-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(workflowSkill))) {
    throw new Error('managed discovery workflow skill is not a bundle name');
  }
  const skillBase = workflowSkill === null ? null : path.join(roots.skillsRoot, workflowSkill);
  return [
    'Managed workflow discovery context; the benchmark uses Full Access, without a host filesystem security boundary.',
    'These paths define the working copies and workflow scope; Full Access does not expand operation/slice artifact authority.',
    `Project working directory and implementation root: ${JSON.stringify(roots.workspace)}.`,
    `Frozen runtime/reference root (preserve unchanged): ${JSON.stringify(roots.snapshot)}.`,
    `Copied skill root (preserve unchanged): ${JSON.stringify(roots.skillsRoot)}; resolve references from their declaring SKILL.md.`,
    ...(skillBase === null ? [] : [
      `Invoked workflow skill: ${workflowSkill}; read ${JSON.stringify(path.join(skillBase, 'SKILL.md'))}.`,
      `Invoked skill resource base: ${JSON.stringify(skillBase)}.`,
      `Its bundle-relative runtime/ resolves under ${JSON.stringify(path.join(skillBase, 'runtime'))};`,
      `templates/ under ${JSON.stringify(path.join(skillBase, 'templates'))}; references/ under ${JSON.stringify(path.join(skillBase, 'references'))}.`,
      'Resolve this skill\'s bundled resources against that base, never SPEC_PATH, the execution root, candidate root or command cwd.',
    ]),
    'Runtime helper paths belong to the documented owner, never command cwd. For a shared helper, use its explicitly',
    'named sibling owner in this same bundle; execute the published recipe rather than guessing a path or reading code to invent one.',
    `Candidate root: ${JSON.stringify(roots.candidates)}. Temporary root: ${JSON.stringify(roots.tmpdir)}.`,
    'Start project discovery in the stated working directory, using local package/config files and named source/test paths;',
    'if a file inventory is needed, use rg --files -- . from that directory. Read only needed named snapshot/skill references.',
    'Inspect only what the selected workflow operation requires: its prescribed preflight, named artifact reads and checks.',
    'Generic repository status checks are not a prerequisite for documentary operations. Use Git only when that operation requires Git evidence',
    '(for example, HEAD provenance for execution or validation); the supplied workspace already establishes the project root.',
    'The project root is already supplied: do not rediscover it or instructions by searching parent directories,',
    'rg/find on .., the host checkout or HOME. Relative .. components in persisted artifact paths are rebasing,',
    'not discovery roots; resolve the exact named target and keep it inside the supplied project root.',
    'Project/skill discovery outside these roots requires BLOCKED, not a parent probe. The independent runner remains read only by contract,',
    'not by an operating-system sandbox. Host files, sibling cases and credentials are technically accessible; do not inspect or alter them.',
  ].join('\n');
}

export async function codexClientConfig({ env, cwd = null, developerInstructions = null, isolateSkills = false }) {
  const config = { agents: { enabled: false }, features: { multi_agent: false, multi_agent_v2: false },
    skills: { bundled: { enabled: false } } };
  if ((developerInstructions !== null || isolateSkills)
    && (typeof developerInstructions !== 'string' || developerInstructions.trim() === '')) {
    throw new Error('runner developer instructions are missing');
  }
  if (developerInstructions !== null) config.developer_instructions = developerInstructions;
  if (env.STNL_CODEX_ADAPTER) {
    config.developer_instructions = [developerInstructions, MANAGED_COMMAND_INSTRUCTIONS,
      managedDiscoveryInstructions({ env, cwd })].filter(Boolean).join('\n\n');
  }
  if (env.HOME) {
    const skillsRoot = path.join(env.HOME, '.agents', 'skills');
    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    // skills.config controls already discovered skills; it does not add roots.
    // Native discovery uses the case HOME/.agents/skills copy.
    config.skills.config = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('stnl-'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({ path: path.join(skillsRoot, entry.name, 'SKILL.md'), enabled: !isolateSkills }));
  } else if (isolateSkills) {
    throw new Error('runner skill home is missing');
  }
  return config;
}

function persistentEvent(event, operationId) {
  if ((event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
    && event.item?.type === 'reasoning') {
    return { operationId, type: event.type, item: { type: 'reasoning', omitted: true } };
  }
  return { operationId, ...event };
}

export async function runCodexTurn({
  env, cwd, prompt, model, effort, threadId = null, operationId, eventsPath,
  outputSchema = undefined, timeoutMs = 900_000, onEvent = () => {}, signal = null,
  developerInstructions = null, isolateSkills = false,
  codexPathOverride = undefined,
}) {
  if (typeof prompt !== 'string' || prompt.trim() === '' || !ALLOWED_MODELS.has(model)
    || !ALLOWED_EFFORTS.has(effort) || typeof cwd !== 'string' || typeof eventsPath !== 'string'
    || !env?.CODEX_HOME || Object.hasOwn(env, 'OPENAI_API_KEY') || Object.hasOwn(env, 'CODEX_API_KEY')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('invalid Codex SDK turn configuration');
  }
  // The manager admits and counts independent runner turns through its adapter.
  // Prevent SDK turns from starting untracked collaboration subagents.
  const offline = await offlineProviderContext(env, env.STNL_CODEX_ADAPTER ? path.resolve(env.STNL_CODEX_ADAPTER, '../../..') : null);
  if (offline && codexPathOverride !== undefined && codexPathOverride !== offline.provider) throw new Error('offline provider override disagrees');
  const codex = new Codex({ env, config: await codexClientConfig({ env, cwd, developerInstructions, isolateSkills }),
    codexPathOverride: offline?.provider ?? codexPathOverride });
  const options = {
    model,
    modelReasoningEffort: effort,
    workingDirectory: cwd,
    approvalPolicy: 'never',
    ...(env.STNL_CODEX_ADAPTER ? { sandboxMode: 'danger-full-access' } : {}),
  };
  const thread = threadId === null ? codex.startThread(options) : codex.resumeThread(threadId, options);
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) abort.abort();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let actualThreadId = threadId;
  let usage = null;
  let turnStarted = false;
  let response = null;
  let completed = false;
  let error = null;
  let errorEvent = null;
  let processError = null;
  let toolCalls = 0;
  let commandDenied = false;
  const file = await fs.open(eventsPath, 'a');
  try {
    const { events } = await thread.runStreamed(prompt, { signal: abort.signal, outputSchema });
    for await (const event of events) {
      await file.writeFile(`${JSON.stringify(persistentEvent(event, operationId))}\n`);
      onEvent(event);
      if (deniedShellTemporaryFile(event)) {
        commandDenied = true;
        error ??= 'SANDBOX_COMMAND_DENIED: implicit shell temporary file creation was denied';
        // Retain the exact SDK command event; stop this turn rather than let a
        // later successful command hide a denial or try another mechanism.
        abort.abort();
      }
      if (event.type === 'thread.started') actualThreadId = event.thread_id;
      if (event.type === 'thread.started' || event.type === 'turn.started') turnStarted = true;
      if (event.type === 'turn.completed') { usage = event.usage ?? null; completed = true; }
      if (event.type === 'turn.failed') {
        if (event.error && typeof event.error === 'object') errorEvent ??= persistentEvent(event, operationId);
        error ??= event.error?.message ?? event.error?.code ?? 'turn failed';
      }
      if (event.type === 'error') {
        errorEvent ??= persistentEvent(event, operationId);
        error ??= event.message ?? event.code ?? 'provider error';
      }
      if (event.type === 'item.completed') {
        if (event.item.type === 'agent_message') response = event.item.text;
        if (['command_execution', 'file_change', 'mcp_tool_call', 'collab_tool_call'].includes(event.item.type)) toolCalls += 1;
      }
    }
  } catch (caught) {
    processError = String(caught);
    error ??= processError;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await file.close();
  }
  return {
    requestedModel: model,
    requestedEffort: effort,
    reportedModel: null,
    threadId: actualThreadId,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    completed: completed && !commandDenied,
    // A stream with no start event does not prove that dispatch never reached
    // the provider. Refund/retry requires explicit pre-dispatch proof.
    turnStarted: turnStarted ? true : null,
    error,
    errorEvent,
    processError,
    response,
    usage,
    toolCalls,
  };
}
