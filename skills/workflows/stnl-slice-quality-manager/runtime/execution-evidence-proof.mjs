import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCurrentJson, resolveLogicalProductClaim, logicalArtifactPath } from './execution-current.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const raw = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const utf8 = text => Buffer.from(text, 'utf8');
const hex = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const invalid = message => fail('INVALID_CURRENT_IMAGE', message);
const incomplete = message => fail('EVIDENCE_INCOMPLETE', message);
const stale = message => fail('EVIDENCE_STALE', message);
const uncertain = message => fail('OWNER_UNCERTAIN', message);
const mismatch = message => fail('OWNER_MISMATCH', message);
const unsafe = message => fail('UNSAFE_PATH', message);
function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(`${label}: plain object required`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(item => !Object.hasOwn(item, 'value') || !item.enumerable)) invalid(`${label}: non-data property`);
  return value;
}
function closed(value, keys, label) {
  plain(value, label);
  if (Object.keys(value).sort(ordinal).join('\0') !== [...keys].sort(ordinal).join('\0')) invalid(`${label}: fields differ`);
  return value;
}
function dense(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < min || value.length > max || Object.keys(value).length !== value.length
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, descriptor]) => key !== 'length' && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable))) invalid(`${label}: dense array required`);
  return value;
}
function str(value, label, nonempty = true) {
  if (typeof value !== 'string' || value.includes('\0') || (nonempty && value.trim() === '') || !isWellFormed(value)) invalid(`${label}: invalid string`);
  return value;
}
function isWellFormed(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) { if (!(value.charCodeAt(++i) >= 0xdc00 && value.charCodeAt(i) <= 0xdfff)) return false; }
    else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function token(value, pattern, label) { str(value, label); if (!pattern.test(value)) invalid(`${label}: invalid token`); return value; }
function integer(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) invalid(`${label}: invalid integer`);
  return value;
}
function bytes(value, label) {
  if (!(value instanceof Uint8Array) || (Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value))
    || Reflect.ownKeys(value).length !== value.length) invalid(`${label}: bytes required`);
  return Buffer.from(value);
}
function textBytes(value, label) {
  const copy = bytes(value, label);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(copy); } catch { invalid(`${label}: invalid UTF-8`); }
  if (text.startsWith('\ufeff') || text.includes('\0') || !isWellFormed(text) || !utf8(text).equals(copy)) invalid(`${label}: noncanonical UTF-8`);
  return { bytes: copy, text };
}
function jsonBytes(value, label) {
  const decoded = textBytes(value, label);
  try { return { ...decoded, value: parseCurrentJson(decoded.text) }; }
  catch (error) { fail(error.code ?? 'INVALID_CURRENT_IMAGE', `${label}: ${error.message}`); }
}
function canonical(value, signedNumbers = false) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') { str(value, 'canonical', false); return JSON.stringify(value); }
  if (typeof value === 'number') { integer(value, 'canonical', signedNumbers ? Number.MIN_SAFE_INTEGER : 0); return String(value); }
  if (Array.isArray(value)) return `[${dense(value, 'canonical').map(item => canonical(item, signedNumbers)).join(',')}]`;
  plain(value, 'canonical');
  return `{${Object.keys(value).sort(ordinal).map(key => `${canonical(key)}:${canonical(value[key], signedNumbers)}`).join(',')}}`;
}
const same = (a, b) => canonical(a, true) === canonical(b, true);
const serialized = value => utf8(`${canonical(value)}\n`);
function expectEqual(actual, expected, code, label) { if (!same(actual, expected)) fail(code, `${label}: binding differs`); }
function ownerShape(value, label) {
  closed(value, ['operationAttemptId', 'ownershipToken', 'deliveryId', 'slice', 'operation', 'preparationRevision', 'localRevision', 'normativeSha256', 'originActivationId'], label);
  for (const key of ['operationAttemptId', 'ownershipToken', 'deliveryId', 'originActivationId']) token(value[key], UUID, `${label}.${key}`);
  canonicalSlice(value.slice, `${label}.slice`);
  token(value.normativeSha256, HASH, `${label}.normativeSha256`);
  str(value.operation, `${label}.operation`);
  integer(value.preparationRevision, `${label}.preparationRevision`, 1);
  integer(value.localRevision, `${label}.localRevision`, 1);
}
function canonicalSlice(value, label) {
  token(value, /^slice-([0-9]{2,})$/u, label);
  const digits = value.slice('slice-'.length);
  const ordinalNumber = Number(digits);
  if (!Number.isSafeInteger(ordinalNumber) || ordinalNumber < 1 || String(ordinalNumber).padStart(2, '0') !== digits) invalid(`${label}: noncanonical slice`);
  return value;
}
function ownerMatches(value, expected, label) {
  if (value && typeof value === 'object' && !Object.hasOwn(value, 'localRevision') && (value.imported === true || value.operationAttemptId)) fail('MIGRATION_REQUIRED', `${label}: old owner lacks local revision`);
  ownerShape(value, label);
  expectEqual(value, expected, 'OWNER_MISMATCH', label);
}
function absolute(value, label) {
  str(value, label);
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value.split(path.sep).includes('..')) unsafe(`${label}: unsafe absolute path`);
  return value;
}
function relative(value, label) {
  str(value, label);
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
    || value.endsWith('/') || value.split('/').some(part => !part || part === '.') || path.posix.normalize(value) !== value) unsafe(`${label}: unsafe relative path`);
  return value;
}
function productRelative(context, target, label) {
  const rel = path.relative(context.productRoot, target).split(path.sep).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) unsafe(`${label}: outside product`);
  return relative(rel, label);
}
function claim(context, rawClaim, label) {
  try { return productRelative(context, resolveLogicalProductClaim(context, `tasks/${label.slice}.md`, rawClaim), label.name); }
  catch (error) { fail(error.code === 'UNSAFE_PATH' ? 'UNSAFE_PATH' : 'INVALID_CURRENT_IMAGE', `${label.name}: ${error.message}`); }
}
function claimLines(value, label, typed = false) {
  str(value, label);
  if (value === '- none' && !typed) return [];
  const lines = value.split('\n');
  return lines.map(line => {
    const match = typed ? /^- (file|directory): `([^`]+)`$/u.exec(line) : /^- `([^`]+)`$/u.exec(line);
    if (!match) invalid(`${label}: invalid declaration`);
    return typed ? { kind: match[1], path: match[2] } : { kind: 'file', path: match[1] };
  });
}
function work(value, label) {
  closed(value, ['format', 'entries'], label);
  if (value.format !== 'stnl-current-work-v1') fail('CURRENT_FORMAT_REQUIRED', `${label}: current WorkManifest required`);
  dense(value.entries, `${label}.entries`, 0, 10000);
  const byPath = new Map();
  for (const entry of value.entries) {
    plain(entry, `${label}.entry`);
    if (entry.kind === 'file') {
      closed(entry, ['path', 'kind', 'sha256', 'mode'], `${label}.entry`);
      token(entry.sha256, HASH, `${label}.hash`); integer(entry.mode, `${label}.mode`, 0, 511);
    } else if (entry.kind === 'directory') {
      closed(entry, ['path', 'kind', 'children'], `${label}.entry`);
      dense(entry.children, `${label}.children`);
      let prev = null;
      for (const child of entry.children) {
        relative(child, `${label}.child`);
        if (child.includes('/') || (prev !== null && ordinal(prev, child) >= 0)) invalid(`${label}: children unordered`);
        prev = child;
      }
    } else if (entry.kind === 'absent') closed(entry, ['path', 'kind'], `${label}.entry`);
    else invalid(`${label}: unknown entry kind`);
    relative(entry.path, `${label}.path`);
    if (byPath.has(entry.path)) invalid(`${label}: duplicate path`);
    byPath.set(entry.path, entry);
  }
  if (value.entries.some((entry, index) => index && ordinal(value.entries[index - 1].path, entry.path) >= 0)) invalid(`${label}: entries unordered`);
  for (const entry of value.entries) {
    const parts = entry.path.split('/');
    for (let i = 1; i < parts.length; i += 1) {
      const parent = byPath.get(parts.slice(0, i).join('/'));
      if (!parent || parent.kind !== 'directory'
        || (i < parts.length - 1 && !parent.children.includes(parts[i]))
        || (i === parts.length - 1 && parent.children.includes(parts[i]) === (entry.kind === 'absent'))) incomplete(`${label}: missing parent/child closure ${entry.path}`);
    }
    if (entry.kind === 'directory') for (const child of entry.children) {
      const present = byPath.get(`${entry.path}/${child}`);
      if (!present || present.kind === 'absent') incomplete(`${label}: missing present child ${child}`);
    }
  }
  return byPath;
}
function coverage(manifest, claims, label) {
  const byPath = work(manifest, label);
  for (const item of claims) {
    const entry = byPath.get(item.path);
    if (!entry) incomplete(`${label}: missing declared ${item.path}`);
    if (item.kind === 'input' && entry.kind !== 'file') stale(`${label}: Existing Input is not a file ${item.path}`);
    if (item.kind === 'directory' && entry.kind === 'file') stale(`${label}: declared directory is a file ${item.path}`);
    if (['file','product'].includes(item.kind) && entry.kind === 'directory') stale(`${label}: declared file is a directory ${item.path}`);
  }
  for (const [name, entry] of byPath) {
    if (!claims.some(item => item.path === name || item.path.startsWith(`${name}/`)
      || (item.kind === 'directory' && name.startsWith(`${item.path}/`)))) incomplete(`${label}: unexpected domain member ${name}`);
    if (entry.kind === 'file' && !HASH.test(entry.sha256)) invalid(`${label}: invalid file hash`);
  }
  return byPath;
}
function recipeAndClaims(context, delivery, slice) {
  const task = `tasks/${slice}.md`;
  logicalArtifactPath(context, task);
  const areas = claimLines(delivery.authorizedAreas, 'Authorized Areas', true).map(item => ({ kind: item.kind, path: claim(context, item.path, {slice, name:'Authorized Areas'}) }));
  const inputs = claimLines(delivery.existingInputs, 'Existing Inputs').map(item => ({ kind:'input', path:claim(context, item.path, {slice, name:'Existing Inputs'}) }));
  const recipe = delivery.verificationRecipe;
  closed(recipe, ['format', 'base', 'cwd', 'checks', 'dependencyReview'], 'recipe');
  if (recipe.format !== 'stnl-verification-recipe-v1' || recipe.base !== 'workspace') fail('EVIDENCE_STALE', 'recipe: current reviewed recipe required');
  str(recipe.dependencyReview, 'recipe.dependencyReview');
  if (recipe.cwd !== '.') relative(recipe.cwd, 'recipe.cwd');
  dense(recipe.checks, 'recipe.checks', 1, 32);
  const cwd = path.resolve(context.productRoot, recipe.cwd);
  productRelative(context, path.join(cwd, '_'), 'recipe.cwd');
  const refs = [];
  const argument = item => {
    plain(item, 'recipe argument');
    if (Object.hasOwn(item, 'literal')) { closed(item, ['literal'], 'recipe literal'); return str(item.literal, 'recipe literal', false); }
    closed(item, ['file'], 'recipe file argument');
    closed(item.file, ['kind', 'path'], 'recipe reference');
    if (!['product', 'input'].includes(item.file.kind)) invalid('recipe reference kind');
    const name = claim(context, item.file.path, {slice, name:'recipe reference'});
    refs.push({kind:item.file.kind, path:name});
    if (item.file.kind === 'product' ? !areas.some(area => area.path === name || (area.kind === 'directory' && name.startsWith(`${area.path}/`))) : !inputs.some(input => input.path === name)) stale(`recipe reference outside declaration: ${name}`);
    const rel = path.relative(cwd, path.join(context.productRoot, name)).split(path.sep).join('/');
    return rel || '.';
  };
  const checks = recipe.checks.map(check => {
    closed(check, ['id', 'executable', 'args', 'inputs'], 'recipe check');
    token(check.id, /^verification-[0-9]{2,}$/u, 'recipe check id');
    dense(check.args, 'recipe args'); dense(check.inputs, 'recipe inputs');
    for (const input of check.inputs) {
      closed(input, ['kind', 'path'], 'recipe input');
      argument({file:input});
    }
    const executable = argument(check.executable);
    if (!executable || /[\r\n]/u.test(executable)) invalid('recipe executable');
    return { id:check.id, cwd, executable:Object.hasOwn(check.executable, 'file') ? `./${executable}` : executable, args:check.args.map(argument) };
  });
  if (new Set(checks.map(check => check.id)).size !== checks.length) invalid('recipe duplicate check id');
  return { recipe, areas, inputs, refs, resolved:{format:'stnl-resolved-verification-v2', recipeSha256:raw(utf8(canonical(recipe))), checks} };
}
const quote = value => /^[A-Za-z0-9_./:=+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const commandFor = check => [check.executable, ...check.args].map(quote).join(' ');
function observation(value, owner, round, recipeInfo, baseline, context, label) {
  if (value === null) incomplete(`${label}: observation required`);
  if (value.format === 'stnl-runner-verification-v1') fail('MIGRATION_REQUIRED', `${label}: observation v1 lacks WorkManifest preimage`);
  closed(value, ['format', 'status', 'owner', 'round', 'recipe', 'resolved', 'before', 'after', 'checks'], label);
  if (value.format !== 'stnl-runner-verification-v2') fail('UNSUPPORTED_FORMAT', `${label}: observation format`);
  if (value.status !== 'completed') uncertain(`${label}: verification not completed`);
  ownerMatches(value.owner, owner, `${label}.owner`);
  if (value.round !== round) mismatch(`${label}: round differs`);
  expectEqual(value.recipe, recipeInfo.recipe, 'EVIDENCE_STALE', `${label}.recipe`);
  expectEqual(value.resolved, recipeInfo.resolved, 'EVIDENCE_STALE', `${label}.resolved`);
  expectEqual(value.before, value.after, 'EVIDENCE_STALE', `${label}: product changed during checks`);
  const claims = [...recipeInfo.areas, ...recipeInfo.inputs, ...recipeInfo.refs];
  coverage(value.before, claims, `${label}.before`);
  coverage(value.after, claims, `${label}.after`);
  dense(value.checks, `${label}.checks`, 1, 32);
  if (value.checks.length !== recipeInfo.resolved.checks.length) incomplete(`${label}: incomplete recipe execution`);
  for (let i = 0; i < value.checks.length; i += 1) {
    const check = value.checks[i];
    closed(check, ['request', 'command', 'exit', 'stdout', 'stderr', 'stdoutSha256', 'stderrSha256'], `${label}.check`);
    expectEqual(check.request, recipeInfo.resolved.checks[i], 'EVIDENCE_STALE', `${label}.request`);
    if (check.command !== commandFor(check.request)) stale(`${label}: command differs`);
    integer(check.exit, `${label}.exit`, -2147483648, 2147483647);
    for (const stream of ['stdout', 'stderr']) {
      str(check[stream], `${label}.${stream}`, false);
      if (check[`${stream}Sha256`] !== raw(utf8(check[stream]))) incomplete(`${label}: ${stream} hash differs`);
    }
  }
  return value.checks.map(check => ({command:check.command, exit:check.exit}));
}
function baseline(value, owner, round, context, claims, label) {
  closed(value, ['format', 'owner', 'round', 'context', 'manifest'], label);
  if (value.format !== 'stnl-current-baseline-v1') fail('CURRENT_FORMAT_REQUIRED', `${label}: baseline format`);
  ownerMatches(value.owner, owner, `${label}.owner`);
  if (value.round !== round) mismatch(`${label}: round differs`);
  expectEqual(value.context, context, 'EVIDENCE_STALE', `${label}.context`);
  coverage(value.manifest, claims, `${label}.manifest`);
  return value.manifest;
}

function captureShape(value, transport, label, profile) {
  const common = ['transport', 'rawResponse', 'receipt', 'baselineCapture', 'verificationObservation', 'removalProofs'];
  const native = ['origin', 'dispatch', 'agentBinding', 'agentClaim', 'concludedToolResult'];
  const managed = ['managedContext', 'active', 'started', 'events', 'closedSupervisor', 'latest', 'runtimeIdentity'];
  closed(value, [...common, ...(transport === 'native' ? native : managed), ...(profile === 'current-validation' ? ['validationRequest'] : [])], label);
  if (value.transport !== transport) invalid(`${label}: mixed transports`);
  dense(value.removalProofs, `${label}.removalProofs`);
  if (transport === 'managed') dense(value.runtimeIdentity, `${label}.runtimeIdentity`);
  for (const key of [...common, ...(transport === 'native' ? native : managed)]) {
    if (key === 'transport' || key === 'removalProofs' || key === 'runtimeIdentity' || (key === 'verificationObservation' && value[key] === null)) continue;
    bytes(value[key], `${label}.${key}`);
  }
  if (profile === 'current-validation') bytes(value.validationRequest, `${label}.validationRequest`);
  for (const item of value.removalProofs) bytes(item, `${label}.removalProof`);
  if (transport === 'managed') for (const item of value.runtimeIdentity) bytes(item, `${label}.runtimeIdentity`);
}
function body(value, key, label) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) incomplete(`${label}: missing ${key}`);
  return value[key];
}
function nativeOrigin(cap, receipt, rawText, expectation, round, resolved) {
  const origin = jsonBytes(cap.origin, `round ${round} origin`).value;
  const dispatch = jsonBytes(cap.dispatch, `round ${round} dispatch`).value;
  const agent = jsonBytes(cap.agentBinding, `round ${round} agentBinding`).value;
  const agentClaim = jsonBytes(cap.agentClaim, `round ${round} agentClaim`).value;
  const result = jsonBytes(cap.concludedToolResult, `round ${round} concludedToolResult`).value;
  for (const [document, name] of [[origin,'origin'],[dispatch,'dispatch'],[agent,'agentBinding'],[agentClaim,'agentClaim'],[result,'concludedToolResult']]) plain(document, `round ${round} ${name}`);
  const owner = expectation.owner;
  for (const [value, name] of [[origin,'origin'],[dispatch,'dispatch'],[agentClaim,'agentClaim'],[receipt,'receipt']]) ownerMatches(body(value, 'owner', name), owner, `round ${round} ${name}.owner`);
  if (origin.specPath !== expectation.context.logicalAuthorityPath || origin.workspace !== expectation.context.productRoot) mismatch(`round ${round}: native ImageContext differs`);
  if (origin.transport !== 'native' || receipt.transport !== 'native' || origin.attempt !== round || receipt.attempt !== round
    || origin.specPath !== dispatch.specPath || origin.workspace !== dispatch.workspace
    || origin.workspace !== receipt.workspace || origin.dispatchId !== dispatch.dispatchId) mismatch(`round ${round}: native dispatch/origin differs`);
  expectEqual(origin.verification, resolved, 'EVIDENCE_STALE', `round ${round}: origin verification`);
  absolute(receipt.originFile, `round ${round} native originFile`);
  const root = path.dirname(receipt.originFile);
  absolute(root, `round ${round} native root`);
  const originFile = path.join(root, `round-${round}.origin.json`);
  if (receipt.originFile !== originFile || agent.originFile !== originFile || agentClaim.originFile !== originFile
    || receipt.receiptFile !== path.join(root, `round-${round}.receipt.json`)
    || receipt.semanticResponseFile !== path.join(root, `round-${round}.response.json`)) mismatch(`round ${round}: native paths differ`);
  if (dispatch.dispatchId !== origin.dispatchId || dispatch.specPath !== origin.specPath || dispatch.workspace !== origin.workspace) mismatch(`round ${round}: dispatch differs`);
  str(origin.dispatchId, 'dispatchId'); str(agent.agentId, 'agentId');
  if (agent.agentId !== agentClaim.agentId || agent.agentId !== result.agentId || agent.agentId !== receipt.threadId) mismatch(`round ${round}: agent binding differs`);
  if (result.status !== 'completed' || typeof result.finalResponse !== 'string') uncertain(`round ${round}: native tool did not conclude`);
  if (result.finalResponse !== rawText || receipt.semanticResponseSha256 !== hex(utf8(rawText))) incomplete(`round ${round}: raw native result differs`);
  if (receipt.operation !== owner.operation || receipt.slice !== owner.slice || receipt.workspace !== origin.workspace) mismatch(`round ${round}: receipt owner differs`);
  if (receipt.error !== null) uncertain(`round ${round}: native receipt error`);
  return { dispatchId:origin.dispatchId, runnerId:agent.agentId, receipt, root };
}
function managedEvents(cap, receipt, stem, rawText, round) {
  const {text} = textBytes(cap.events, `round ${round} events`);
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (!lines.length || lines.some(line => !line)) invalid(`round ${round}: blank SDK event line`);
  let thread = null; let threadStarts = 0; let pending = false; let completed = 0; let finalMessage = null; let last = null;
  const starts = new Map(); const endings = new Set();
  for (const [index, line] of lines.entries()) {
    let event;
    try { event = parseCurrentJson(line); } catch (error) { invalid(`round ${round} events line ${index + 1}: ${error.message}`); }
    plain(event, `round ${round} events line ${index + 1}`);
    if (event.operationId !== `runner-${stem}` || event.item?.type === 'collab_tool_call') uncertain(`round ${round}: SDK event identity/collaboration`);
    if (event.type === 'error' || event.type === 'turn.failed') uncertain(`round ${round}: SDK error`);
    if (event.type === 'thread.started') { if (thread !== null && thread !== event.thread_id) uncertain(`round ${round}: SDK thread changed`); thread = event.thread_id; threadStarts += 1; }
    if (event.type === 'turn.started') { if (threadStarts !== 1 || pending || completed) uncertain(`round ${round}: SDK turn overlap`); pending = true; finalMessage = null; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') { if (!pending) uncertain(`round ${round}: final message outside turn`); finalMessage = event.item.text; }
    if (event.type === 'turn.completed') { if (!pending || typeof finalMessage !== 'string') uncertain(`round ${round}: incomplete SDK turn`); pending = false; completed += 1; }
    if (event.item?.type === 'command_execution') {
      const item = event.item;
      if (!pending) uncertain(`round ${round}: SDK command outside turn`);
      token(item.id, /^item_[0-9]+$/u, `round ${round} command id`);
      if (event.type === 'item.started') {
        if (starts.has(item.id)) uncertain(`round ${round}: duplicate command start`);
        str(item.command, `round ${round} command`);
        starts.set(item.id, item.command);
      } else if (event.type === 'item.completed') {
        if (!starts.has(item.id) || endings.has(item.id) || starts.get(item.id) !== item.command || !['completed','failed'].includes(item.status)
          || !Number.isSafeInteger(item.exit_code)) uncertain(`round ${round}: command completion differs`);
        endings.add(item.id);
      }
    }
    last = event.type;
  }
  if (threadStarts !== 1 || thread !== receipt.threadId || pending || completed !== 1 || last !== 'turn.completed' || finalMessage !== rawText
    || starts.size !== endings.size) uncertain(`round ${round}: SDK turn did not conclude exactly`);
  if ([...starts.values()].some(command => /^(?:\/bin\/(?:zsh|bash|sh) -lc ['"])?STNL_VERIFICATION_COMMAND=1 [\s\S]+/u.test(command))) incomplete(`round ${round}: additional SDK verification command`);
}
function managedOrigin(cap, receipt, rawText, expectation, round, profile) {
  if (Object.hasOwn(receipt, 'transport')) invalid(`round ${round}: managed receipt has mixed transport`);
  const context = jsonBytes(cap.managedContext, `round ${round} managedContext`).value;
  const active = jsonBytes(cap.active, `round ${round} active`).value;
  const started = jsonBytes(cap.started, `round ${round} started`).value;
  const supervisor = jsonBytes(cap.closedSupervisor, `round ${round} closedSupervisor`).value;
  const latest = jsonBytes(cap.latest, `round ${round} latest`).value;
  for (const [document, name] of [[context,'managedContext'],[active,'active'],[started,'started'],[supervisor,'closedSupervisor'],[latest,'latest']]) plain(document, `round ${round} ${name}`);
  plain(active.officialPreflight, `round ${round} officialPreflight`);
  const owner = expectation.owner;
  if (context.specPath !== expectation.context.logicalAuthorityPath || context.workspace !== expectation.context.productRoot) mismatch(`round ${round}: managed ImageContext differs`);
  if (context.version !== 4 || active.protocol !== 3 || active.operation !== owner.operation || context.operation !== owner.operation) fail('UNSUPPORTED_FORMAT', `round ${round}: managed context/protocol`);
  for (const [doc,name] of [[context,'context'],[active.officialPreflight,'active.officialPreflight'],[started,'started'],[receipt,'receipt']]) ownerMatches(body(doc,'owner',name),owner,`round ${round} ${name}.owner`);
  for (const [doc,name] of [[context,'context'],[active,'active']]) {
    if (doc.operation !== owner.operation || doc.slice !== owner.slice || doc.workspace !== context.workspace) mismatch(`round ${round}: ${name} identity`);
  }
  if (active.officialPreflight.operation !== owner.operation || active.officialPreflight.slice !== owner.slice
    || active.officialPreflight.exitCode !== 0 || active.officialPreflight.state !== context.state) mismatch(`round ${round}: official preflight identity`);
  if (receipt.operation !== owner.operation || receipt.slice !== owner.slice) mismatch(`round ${round}: receipt identity`);
  if (started.operation !== owner.operation || started.slice !== owner.slice) mismatch(`round ${round}: started identity`);
  if (context.specPath !== active.officialPreflight.specPath || context.authority !== active.officialPreflight.authority
    || context.authority !== started.authority || context.authority !== receipt.authority
    || context.authority !== expectation.authority.context.requirementsAuthority) stale(`round ${round}: managed authority`);
  if (context.specPath !== started.specPath && Object.hasOwn(started,'specPath')) mismatch(`round ${round}: started specPath`);
  integer(active.sequence, `round ${round} sequence`, 1);
  if (active.sequence !== started.sequence || active.sequence !== receipt.sequence || receipt.attempt !== round || started.attempt !== round
    || receipt.runnerAgent !== 'stnl_validation_runner'
    || (profile === 'initial-implementation' && receipt.automaticCheckRound !== `${round}/3`)) mismatch(`round ${round}: managed invocation`);
  if (profile === 'current-validation' && Object.hasOwn(receipt, 'automaticCheckRound')) mismatch(`round ${round}: managed automaticCheckRound`);
  const stem = `${String(active.sequence).padStart(3,'0')}-${owner.operation.toLowerCase()}-${owner.slice}-attempt-${round}`;
  const root = absolute(active.tmpdir, `round ${round} managed tmpdir`);
  if (receipt.receiptFile !== path.join(root, `${stem}.receipt.json`)
    || receipt.semanticResponseFile !== path.join(root, `${stem}.response.json`)
    || receipt.eventsPath !== path.join(root, `${stem}.events.jsonl`)) mismatch(`round ${round}: managed paths`);
  if (receipt.error != null || receipt.processError != null || receipt.providerError != null) uncertain(`round ${round}: managed tool error`);
  str(receipt.threadId, `round ${round} managed threadId`);
  if (receipt.formatRepair !== null && receipt.formatRepair?.attempted !== false) uncertain(`round ${round}: format repair unsupported`);
  if (receipt.semanticResponseSha256 !== hex(utf8(rawText))) incomplete(`round ${round}: raw managed response hash`);
  managedEvents(cap, receipt, stem, rawText, round);
  if (context.identity === null || typeof context.identity !== 'object') incomplete(`round ${round}: runtime identity`);
  closed(context.identity, ['snapshot','adapter','bridge','preflight','evidenceSerializer','runnerResultContract'], `round ${round} runtime identity`);
  closed(context.identity.snapshot, ['path','mode'], `round ${round} snapshot identity`);
  const expectedPaths = {
    adapter:'agents/codex/runtime/validation-runner.mjs', bridge:'agents/codex/runtime/managed-runner-bridge.mjs',
    preflight:'agents/codex/runtime/managed-slice-preflight.mjs',
    evidenceSerializer:'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs',
    runnerResultContract:'skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs',
  };
  absolute(context.identity.snapshot.path, `round ${round} snapshot`);
  token(context.identity.snapshot.mode, /^[0-7]{3,4}$/u, `round ${round} snapshot mode`);
  const declared = new Set();
  for (const [role, relativePath] of Object.entries(expectedPaths)) {
    const identity = context.identity[role];
    closed(identity, ['path','sha256','mode'], `round ${round} ${role}`);
    if (identity.path !== path.join(context.identity.snapshot.path, relativePath)) stale(`round ${round}: ${role} path`);
    token(identity.sha256, HASH, `round ${round} ${role} hash`);
    token(identity.mode, /^[0-7]{3,4}$/u, `round ${round} ${role} mode`);
    if (role === 'adapter' && (parseInt(identity.mode, 8) & 0o111) === 0) stale(`round ${round}: adapter not executable`);
    declared.add(identity.sha256);
  }
  const actual = cap.runtimeIdentity.map(item => raw(bytes(item, `round ${round} runtime bytes`)));
  if (!same(actual, [...new Set(actual)].sort(ordinal)) || !same([...declared].sort(ordinal), actual)) incomplete(`round ${round}: runtime identity bytes`);
  const identity = {workspace:context.workspace,tmpdir:root,operation:owner.operation,sequence:active.sequence,slice:owner.slice};
  for (const doc of [active,supervisor,latest]) for (const [key,value] of Object.entries(identity)) if (doc[key] !== value) mismatch(`round ${round}: managed ${key}`);
  if (supervisor.pending !== false || supervisor.cancelledPending !== false || !Array.isArray(supervisor.errors)
    || supervisor.errors.length || typeof supervisor.closedAt !== 'string' || !supervisor.closedAt) uncertain(`round ${round}: supervisor not closed`);
  if (latest.authority !== context.authority) stale(`round ${round}: latest authority`);
  return { dispatchId:`${owner.operationAttemptId}:${active.sequence}`, runnerId:receipt.threadId, receipt, supervisor, latest, active };
}

function areaContains(areas, name) {
  return areas.some(item => item.path === name || (item.kind === 'directory' && name.startsWith(`${item.path}/`)));
}
function capsule(format, fields) { return serialized({format, ...fields}); }
function objectStore() {
  const objects = new Map();
  return {
    add(value) { const copy = bytes(value, 'source bytes'); const id = raw(copy); objects.set(id, {id,bytesBase64:copy.toString('base64')}); return id; },
    finish() { return [...objects.values()].sort((a,b) => ordinal(a.id,b.id)); },
  };
}
function sourcesFor(cap, store, profile) {
  const base = {
    transport:cap.transport, rawResponse:store.add(cap.rawResponse), receipt:store.add(cap.receipt),
    verificationObservation:cap.verificationObservation === null ? null : store.add(cap.verificationObservation),
    removalProofs:cap.removalProofs.map(item => store.add(item)).sort(ordinal), legacyPreparation:null,
  };
  if (new Set(base.removalProofs).size !== base.removalProofs.length) invalid('duplicate removal proof bytes');
  if (cap.transport === 'native') return {
    ...base,
    origin:store.add(capsule(profile === 'current-validation' ? 'stnl-native-validation-origin-bundle-v1' : 'stnl-native-origin-bundle-v1', {
      originUtf8:textBytes(cap.origin,'origin').text, dispatchUtf8:textBytes(cap.dispatch,'dispatch').text,
      baselineUtf8:textBytes(cap.baselineCapture,'baseline').text,
      ...(profile === 'current-validation' ? {validationRequestUtf8:textBytes(cap.validationRequest,'validation request').text} : {}),
    })),
    agentBinding:store.add(capsule('stnl-native-agent-bundle-v1', {
      agentUtf8:textBytes(cap.agentBinding,'agent').text, claimUtf8:textBytes(cap.agentClaim,'claim').text,
    })),
    concludedToolResult:store.add(cap.concludedToolResult),
  };
  return {
    ...base,
    started:store.add(capsule(profile === 'current-validation' ? 'stnl-managed-validation-start-bundle-v1' : 'stnl-managed-start-bundle-v1', {
      contextUtf8:textBytes(cap.managedContext,'managed context').text, activeUtf8:textBytes(cap.active,'active').text,
      startedUtf8:textBytes(cap.started,'started').text, baselineUtf8:textBytes(cap.baselineCapture,'baseline').text,
      ...(profile === 'current-validation' ? {validationRequestUtf8:textBytes(cap.validationRequest,'validation request').text} : {}),
    })),
    events:store.add(cap.events),
    closedSupervisor:store.add(capsule('stnl-managed-close-bundle-v1', {
      supervisorUtf8:textBytes(cap.closedSupervisor,'supervisor').text, latestUtf8:textBytes(cap.latest,'latest').text,
    })),
    runtimeIdentity:cap.runtimeIdentity.map(item => store.add(item)).sort(ordinal),
  };
}
function restoreCapsule(objects, id, format, keys, label) {
  const data = objects.get(id);
  if (!data) incomplete(`${label}: missing capsule`);
  const parsed = jsonBytes(data, label).value;
  const validationCapsule = format.includes('-validation-');
  if (!validationCapsule) closed(parsed, ['format', ...keys], label);
  else plain(parsed,label);
  if (parsed.format !== format) fail(
    validationCapsule && ['stnl-native-origin-bundle-v1','stnl-managed-start-bundle-v1'].includes(parsed.format)
      ? 'MIGRATION_REQUIRED' : 'UNSUPPORTED_FORMAT', `${label}: capsule format`);
  if (validationCapsule) closed(parsed, ['format', ...keys], label);
  const restored = {};
  for (const key of keys) restored[key] = utf8(str(parsed[key], `${label}.${key}`, false));
  return restored;
}
function restoreSources(record, objects, profile) {
  const sources = record.sources;
  const get = (id, label) => {
    if (id === null) return null;
    const item = objects.get(id);
    if (!item) incomplete(`${label}: missing source`);
    return Uint8Array.from(item);
  };
  const base = {
    transport:sources.transport, rawResponse:get(sources.rawResponse,'rawResponse'), receipt:get(sources.receipt,'receipt'),
    verificationObservation:get(sources.verificationObservation,'verificationObservation'),
    removalProofs:sources.removalProofs.map(id => get(id,'removalProof')),
  };
  if (sources.transport === 'native') {
    const origin = restoreCapsule(objects,sources.origin,profile === 'current-validation' ? 'stnl-native-validation-origin-bundle-v1' : 'stnl-native-origin-bundle-v1',
      ['originUtf8','dispatchUtf8','baselineUtf8',...(profile === 'current-validation' ? ['validationRequestUtf8'] : [])],'native origin capsule');
    const agent = restoreCapsule(objects,sources.agentBinding,'stnl-native-agent-bundle-v1',['agentUtf8','claimUtf8'],'native agent capsule');
    return {...base, origin:origin.originUtf8,dispatch:origin.dispatchUtf8,baselineCapture:origin.baselineUtf8,
      ...(profile === 'current-validation' ? {validationRequest:origin.validationRequestUtf8} : {}),
      agentBinding:agent.agentUtf8,agentClaim:agent.claimUtf8,concludedToolResult:get(sources.concludedToolResult,'toolResult')};
  }
  const start = restoreCapsule(objects,sources.started,profile === 'current-validation' ? 'stnl-managed-validation-start-bundle-v1' : 'stnl-managed-start-bundle-v1',
    ['contextUtf8','activeUtf8','startedUtf8','baselineUtf8',...(profile === 'current-validation' ? ['validationRequestUtf8'] : [])],'managed start capsule');
  const close = restoreCapsule(objects,sources.closedSupervisor,'stnl-managed-close-bundle-v1',['supervisorUtf8','latestUtf8'],'managed close capsule');
  return {...base, managedContext:start.contextUtf8,active:start.activeUtf8,started:start.startedUtf8,baselineCapture:start.baselineUtf8,
    ...(profile === 'current-validation' ? {validationRequest:start.validationRequestUtf8} : {}),
    events:get(sources.events,'events'),closedSupervisor:close.supervisorUtf8,latest:close.latestUtf8,
    runtimeIdentity:sources.runtimeIdentity.map(id => get(id,'runtimeIdentity'))};
}

// The two closed profiles share source and transport checks, with distinct formal
// invocation rules. No caller supplies a verifier or bypass flag.
export function verifyCapturedInvocation(profile, cap, receipt, rawText, expectation, round, resolved) {
  if (!['initial-implementation', 'current-validation'].includes(profile)) invalid('capture profile');
  plain(cap,`round ${round} capture`);
  const transport = receipt === undefined && profile === 'initial-implementation' ? resolved : cap.transport;
  if (!['native', 'managed'].includes(transport)) fail('UNSUPPORTED_FORMAT', 'capture transport');
  captureShape(cap, transport, `round ${round}`, profile);
  if (receipt === undefined) return;
  const verifiedResolved = profile === 'current-validation'
    ? recipeAndClaims(expectation.context, expectation.authority.delivery, expectation.owner.slice).resolved : resolved;
  return cap.transport === 'native'
    ? nativeOrigin(cap, receipt, rawText, expectation, round, verifiedResolved)
    : managedOrigin(cap, receipt, rawText, expectation, round, profile);
}
export function verifyWorkObservation(profile, value, owner, round, recipeInfo, baselineManifest, context, label) {
  if (!['initial-implementation', 'current-validation'].includes(profile)) invalid('observation profile');
  if (profile === 'initial-implementation' && value && Object.hasOwn(value,'delivery')) {
    closed(value,['context','delivery','slice'],'reviewed work preparation');
    return recipeAndClaims(value.context,value.delivery,value.slice);
  }
  if (profile === 'current-validation') {
    if (Object.hasOwn(value,'observedWork')) {
      work(value.observedWork,'observedWork');
      return value.observedWork;
    }
    const {capture, receipt, expectation, priorScopePaths, removalScopePaths} = value;
    const info = recipeAndClaims(expectation.context, expectation.authority.delivery, expectation.owner.slice);
    const baselineDocument = jsonBytes(capture.baselineCapture, 'validation baseline').value;
    const claims = [...info.areas, ...info.inputs, ...info.refs];
    const before = baseline(baselineDocument, expectation.owner, 1, expectation.context, claims, 'validation baseline');
    let observed=null, commands=null;
    if (capture.verificationObservation === null) {
      if (receipt.status !== 'RUNNER_RESULT_BLOCKED' || receipt.verification !== null) incomplete('validation: observation absent without a schema rejection');
    } else {
      observed = jsonBytes(capture.verificationObservation, 'validation observation').value;
      commands = observation(observed, expectation.owner, 1, info, before, expectation.context, 'validation observation');
      expectEqual(before, observed.before, 'EVIDENCE_STALE', 'validation baseline/observation');
      expectEqual(receipt.verification, observed, 'EVIDENCE_STALE', 'validation receipt observation');
    }
    if (capture.removalProofs.length) invalid('validation cannot produce removal proofs');
    const observedManifest = observed?.after ?? before;
    const byPath = new Map(observedManifest.entries.map(entry => [entry.path, entry]));
    dense(priorScopePaths, 'prior scope paths');
    dense(removalScopePaths, 'retained removal paths');
    for (const [names,label] of [[priorScopePaths,'prior scope'],[removalScopePaths,'retained removal']]) for (const name of names) {
      relative(name, `${label} path`);
      if (!byPath.has(name)) incomplete(`validation: ${label} member omitted ${name}`);
    }
    const scopePaths = [...new Set([
      ...priorScopePaths.filter(name => byPath.get(name)?.kind !== 'directory'),
      ...removalScopePaths.filter(name => byPath.get(name)?.kind === 'absent'),
      ...observedManifest.entries.filter(entry => ['file','absent'].includes(entry.kind) && areaContains(info.areas, entry.path)).map(entry => entry.path),
      ...info.refs.filter(ref => ref.kind === 'product').map(ref => ref.path),
    ])].sort(ordinal);
    for (const name of scopePaths) {
      const entry = byPath.get(name);
      if (!entry || entry.kind === 'directory') stale(`validation: scope path lacks file/absent observation ${name}`);
    }
    return {info, before, observed, commands, scopePaths};
  }
  const commands = observation(value, owner, round, recipeInfo, baselineManifest, context, label);
  return commands;
}
export function packCaptureSources(profile, cap, store) {
  if (!['initial-implementation', 'current-validation'].includes(profile)) invalid('source profile');
  return sourcesFor(cap, store, profile);
}
export function restoreCaptureSources(profile, record, objects) {
  if (!['initial-implementation', 'current-validation'].includes(profile)) invalid('source profile');
  return restoreSources(record, objects, profile);
}
export function closeEvidenceObjects() { return objectStore(); }
