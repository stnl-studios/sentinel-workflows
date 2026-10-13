import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCurrentJson, resolveLogicalProductClaim, logicalArtifactPath, validateCurrentEvidence } from './execution-current.mjs';
import {
  RunnerSemanticResultError, assertRunnerVerdictConsistency, assertExecutionResultScope,
  deriveCanonicalRunnerRejection, recoverableRunnerResultDiagnostic,
  parseSemanticExecutionPayload, serializeMarkdownScalar, serializeCommand,
  executionFields, isExplanatoryExecutionField,
} from './runner-result-contract.mjs';

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
function projected(tag, value) { return raw(Buffer.concat([utf8(`stnl-ec1/${tag}/v1`), Buffer.from([0]), utf8(canonical(value))])); }
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
function artifactRelative(value, label) {
  str(value, label);
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
    || value.endsWith('/') || value.split('/').some(part => !part || part === '.')
    || path.posix.normalize(value) !== value) unsafe(`${label}: unsafe artifact-relative path`);
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

function guard(input, validating = false) {
  plain(input, 'initial evidence input');
  if (Object.hasOwn(input, 'imported') && input.imported === true) fail('MIGRATION_REQUIRED', 'imported evidence requires conversion');
  closed(input, ['context', 'authority', 'owner', 'currentEvidence', 'counters', validating ? 'bundleBytes' : 'rounds'], 'initial evidence input');
  closed(input.authority, ['preparationRevision', 'localRevision', 'normativeSha256', 'delivery', 'context'], 'authority');
  closed(input.authority.context, ['requirementsAuthority', 'objective', 'strategy', 'risks'], 'authority.context');
  closed(input.counters, ['implementationChecks', 'findingsChecks', 'validationAttempts', 'findings'], 'counters');
  plain(input.owner, 'owner');
  if (!Object.hasOwn(input.owner, 'localRevision') && Object.hasOwn(input.owner, 'operationAttemptId')) fail('MIGRATION_REQUIRED', 'old owner lacks local revision');
  ownerShape(input.owner, 'owner');
  if (input.authority.preparationRevision !== 1 || input.authority.localRevision !== 1
    || input.owner.preparationRevision !== 1 || input.owner.localRevision !== 1 || input.owner.operation !== 'EXECUTE_SLICE'
    || input.currentEvidence !== null || Object.values(input.counters).some(item => !Object.is(item, 0))) invalid('initial EXECUTE_SLICE authority required');
  const delivery = input.authority.delivery;
  closed(delivery, ['deliveryId', 'objectiveAndObservableResult', 'requirements', 'includedScope', 'outOfScopeAndBoundaries', 'authorizedAreas', 'existingInputs', 'protectedResponsibilities', 'dependencies', 'risksAndStrategy', 'expectedTests', 'verificationRecipe', 'completionCriterion', 'taskResult', 'obligations'], 'delivery');
  token(delivery.deliveryId, UUID, 'delivery.deliveryId');
  if (input.authority.normativeSha256 !== input.owner.normativeSha256
    || delivery.deliveryId !== input.owner.deliveryId) mismatch('owner authority differs');
  token(input.authority.normativeSha256, HASH, 'authority.normativeSha256');
  token(input.authority.context.requirementsAuthority, HASH, 'authority.requirementsAuthority');
  for (const field of ['objective', 'strategy', 'risks']) str(input.authority.context[field], `authority.${field}`);
  // The L1 logical path helper validates the complete EC-1 ImageContext.
  logicalArtifactPath(input.context, `tasks/${input.owner.slice}.md`);
  for (const field of ['objectiveAndObservableResult', 'requirements', 'includedScope', 'outOfScopeAndBoundaries', 'authorizedAreas', 'existingInputs', 'protectedResponsibilities', 'risksAndStrategy', 'expectedTests', 'completionCriterion', 'taskResult']) str(delivery[field], `delivery.${field}`);
  dense(delivery.dependencies, 'delivery.dependencies');
  for (const dependency of delivery.dependencies) token(dependency, UUID, 'delivery.dependency');
  if (new Set(delivery.dependencies).size !== delivery.dependencies.length || delivery.dependencies.includes(delivery.deliveryId)) invalid('delivery: invalid dependencies');
  dense(delivery.obligations, 'delivery.obligations', 1);
  const obligationIds = new Set();
  for (const obligation of delivery.obligations) {
    closed(obligation, ['id','requirement','contribution','fullOwner','condition','proof'], 'delivery.obligation');
    token(obligation.id, /^obligation-[0-9]{2,}$/u, 'delivery.obligation.id');
    token(obligation.requirement, /^[A-Z][A-Z0-9]*-[0-9]+$/u, 'delivery.obligation.requirement');
    if (!['complete','partial'].includes(obligation.contribution)) invalid('delivery.obligation.contribution');
    if (typeof obligation.fullOwner !== 'string') invalid('delivery.obligation.fullOwner');
    if (obligation.fullOwner.startsWith('delivery:')) token(obligation.fullOwner.slice(9), UUID, 'delivery.obligation.fullOwner');
    else canonicalSlice(obligation.fullOwner, 'delivery.obligation.fullOwner');
    str(obligation.condition, 'delivery.obligation.condition'); str(obligation.proof, 'delivery.obligation.proof');
    if (obligationIds.has(obligation.id)) invalid('delivery: duplicate obligation');
    obligationIds.add(obligation.id);
  }
  // Canonical serialization also rejects descriptors, malformed strings and non-JSON nested values.
  canonical(input.context); canonical(input.authority); canonical(input.owner);
  if (validating) bytes(input.bundleBytes, 'bundleBytes');
  else dense(input.rounds, 'rounds', 1, 3);
  return recipeAndClaims(input.context, delivery, input.owner.slice);
}
function captureShape(value, transport, label) {
  const common = ['transport', 'rawResponse', 'receipt', 'baselineCapture', 'verificationObservation', 'removalProofs'];
  const native = ['origin', 'dispatch', 'agentBinding', 'agentClaim', 'concludedToolResult'];
  const managed = ['managedContext', 'active', 'started', 'events', 'closedSupervisor', 'latest', 'runtimeIdentity'];
  closed(value, [...common, ...(transport === 'native' ? native : managed)], label);
  if (value.transport !== transport) invalid(`${label}: mixed transports`);
  dense(value.removalProofs, `${label}.removalProofs`);
  if (transport === 'managed') dense(value.runtimeIdentity, `${label}.runtimeIdentity`);
  for (const key of [...common, ...(transport === 'native' ? native : managed)]) {
    if (key === 'transport' || key === 'removalProofs' || key === 'runtimeIdentity' || (key === 'verificationObservation' && value[key] === null)) continue;
    bytes(value[key], `${label}.${key}`);
  }
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
function managedOrigin(cap, receipt, rawText, expectation, round) {
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
  if (context.version !== 4 || active.protocol !== 3 || active.operation !== 'EXECUTE_SLICE' || context.operation !== 'EXECUTE_SLICE') fail('UNSUPPORTED_FORMAT', `round ${round}: managed context/protocol`);
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
    || receipt.runnerAgent !== 'stnl_validation_runner' || receipt.automaticCheckRound !== `${round}/3`) mismatch(`round ${round}: managed invocation`);
  const stem = `${String(active.sequence).padStart(3,'0')}-execute_slice-${owner.slice}-attempt-${round}`;
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

function relativeTask(context, absolutePath, slice) {
  const rel = path.relative(path.dirname(logicalArtifactPath(context, `tasks/${slice}.md`)), absolutePath).split(path.sep).join('/');
  if (!rel || rel === '.') unsafe('tested state path aliases task');
  return rel;
}
function changedLeaves(before, after) {
  const prior = new Map(before.entries.map(item => [item.path, item]));
  const current = new Map(after.entries.map(item => [item.path, item]));
  return [...new Set([...prior.keys(), ...current.keys()])].sort(ordinal).filter(name => {
    const left = prior.get(name), right = current.get(name);
    return (left?.kind === 'file' || right?.kind === 'file') && !same(left ?? null, right ?? null);
  });
}
function areaContains(areas, name) {
  return areas.some(item => item.path === name || (item.kind === 'directory' && name.startsWith(`${item.path}/`)));
}
function verifyRemoval(proofs, owner, round, before, after) {
  const prior = new Map(before.entries.map(entry => [entry.path, entry]));
  const current = new Map(after.entries.map(entry => [entry.path, entry]));
  const required = changedLeaves(before, after).filter(name => prior.get(name)?.kind === 'file' && current.get(name)?.kind === 'absent');
  if (proofs.length !== required.length) incomplete(`round ${round}: removal proof count`);
  const names = [];
  for (const [index, blob] of proofs.entries()) {
    const proof = jsonBytes(blob, `round ${round} removalProof ${index + 1}`).value;
    closed(proof, ['format','owner','round','path','sha256','mode','bytesBase64'], `round ${round} removalProof`);
    if (proof.format !== 'stnl-current-removal-proof-v1') fail('CURRENT_FORMAT_REQUIRED', `round ${round}: removal proof format`);
    ownerMatches(proof.owner, owner, `round ${round} removal owner`);
    if (proof.round !== round) mismatch(`round ${round}: removal round`);
    relative(proof.path, `round ${round} removal path`);
    const old = prior.get(proof.path);
    if (!old || old.kind !== 'file' || current.get(proof.path)?.kind !== 'absent'
      || proof.sha256 !== old.sha256 || proof.mode !== old.mode) incomplete(`round ${round}: removal has no real baseline file`);
    if (typeof proof.bytesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(proof.bytesBase64)) incomplete(`round ${round}: invalid removal base64`);
    const product = Buffer.from(proof.bytesBase64, 'base64');
    if (product.toString('base64') !== proof.bytesBase64 || raw(product) !== old.sha256) incomplete(`round ${round}: removal bytes/hash`);
    names.push(proof.path);
  }
  if (!same(names.sort(ordinal), required)) incomplete(`round ${round}: removal proof path set`);
}
function domainChanges(before, after, info, round) {
  const priorMap = new Map(before.entries.map(entry => [entry.path, entry]));
  const afterMap = new Map(after.entries.map(entry => [entry.path, entry]));
  const deltas = changedLeaves(before, after);
  for (const prior of before.entries) if (!afterMap.has(prior.path)) stale(`round ${round}: prior domain member omitted ${prior.path}`);
  const priorDirectories = new Map(before.entries.filter(entry => entry.kind === 'directory').map(entry => [entry.path,entry]));
  const afterDirectories = new Map(after.entries.filter(entry => entry.kind === 'directory').map(entry => [entry.path,entry]));
  for (const name of new Set([...priorDirectories.keys(),...afterDirectories.keys()])) {
    const left=priorDirectories.get(name), right=afterDirectories.get(name);
    if (!left || !right) {
      if (!areaContains(info.areas,name) || !deltas.some(delta => delta.startsWith(`${name}/`))) stale(`round ${round}: unexplained directory domain change ${name}`);
      continue;
    }
    for (const child of new Set([...left.children,...right.children])) {
      if (left.children.includes(child) !== right.children.includes(child)
        && !deltas.some(delta => delta === `${name}/${child}` || delta.startsWith(`${name}/${child}/`))) stale(`round ${round}: unexplained directory child ${name}/${child}`);
    }
  }
  for (const name of deltas) if (!areaContains(info.areas, name)) stale(`round ${round}: out-of-area delta ${name}`);
  for (const item of info.inputs) if (!areaContains(info.areas, item.path)) {
    if (!same(priorMap.get(item.path), afterMap.get(item.path))) stale(`round ${round}: exclusive input changed`);
  }
  return deltas;
}
function testedState(value, context, owner, before, after, info, round) {
  closed(value, ['workspace','sourceTaskPath','entries'], `round ${round} testedState`);
  if (value.workspace !== context.productRoot || value.sourceTaskPath !== logicalArtifactPath(context, `tasks/${owner.slice}.md`)) stale(`round ${round}: tested state context`);
  dense(value.entries, `round ${round} testedState.entries`);
  const afterMap = new Map(after.entries.map(entry => [entry.path, entry]));
  const priorMap = new Map(before.entries.map(entry => [entry.path, entry]));
  let previous = null;
  const selected = new Map();
  for (const entry of value.entries) {
    closed(entry, ['path','value'], `round ${round} tested entry`);
    artifactRelative(entry.path, `round ${round} tested path`);
    if (previous !== null && ordinal(previous, entry.path) >= 0) invalid(`round ${round}: tested entries unordered`);
    previous = entry.path;
    const target = path.resolve(path.dirname(value.sourceTaskPath), entry.path);
    const productPath = productRelative(context, target, `round ${round} tested path`);
    const state = afterMap.get(productPath);
    if (!areaContains(info.areas, productPath) || !state || state.kind === 'directory') stale(`round ${round}: tested target outside areas/domain`);
    if (entry.value !== (state.kind === 'file' ? state.sha256 : 'REMOVED')) stale(`round ${round}: tested state hash/removal`);
    if (state.kind === 'absent' && priorMap.get(productPath)?.kind !== 'file') incomplete(`round ${round}: absent was not removed`);
    selected.set(productPath, entry);
  }
  const deltas = domainChanges(before, after, info, round);
  for (const name of deltas) if (!selected.has(name)) stale(`round ${round}: unrecorded delta ${name}`);
  return value.entries;
}
function renderRecord(id, owner, payload, entries, commands, correctionPaths) {
  const scalar = (label, value) => serializeMarkdownScalar(label, value, isExplanatoryExecutionField(label));
  const fields = Object.fromEntries(executionFields('EXECUTE_SLICE').map(([key, label]) => [label, payload[key]]));
  const tested = entries.length ? `- Tested state:\n${entries.map(entry => `  - \`${entry.path}\` | ${entry.value}`).join('\n')}`
    : `- Tested state: none\n- Fileless reason: ${serializeMarkdownScalar('Fileless reason', payload.filelessReason, true)}`;
  const commandText = commands.length ? `- Commands:\n${commands.map((entry, index) => `  - ${serializeCommand(entry.command, `command ${index + 1}`)} | exit:${entry.exit}`).join('\n')}` : '- Commands: none';
  const lines = [
    `### ${id}`, `- Automatic check round: ${payload.automaticCheckRound}`, `- Status: ${payload.status}`,
    `- HEAD: ${payload.head}`, `- Tested scope: ${entries.length ? entries.map(entry => entry.path).join(', ') : scalar('Fileless reason', payload.filelessReason)}`,
    `- Delivery ID: ${owner.deliveryId}`, `- Preparation revision: ${owner.preparationRevision}`,
    `- Local revision: ${owner.localRevision}`, `- Normative sha256: ${owner.normativeSha256}`,
    `- Operation attempt ID: ${owner.operationAttemptId}`, `- Origin activation ID: ${owner.originActivationId}`,
    tested, commandText,
    ...['Discovery sources','Discovery actions','Verification types considered','Non-applicability rationale','No verification-command confirmation','Selected checks','Selection rationale','Coverage','Failures','Blockers','Unexpected workspace effects','Persistence summary']
      .map(label => `- ${label}: ${scalar(label, fields[label])}`),
  ];
  if (payload.automaticCheckRound !== '1/3') lines.push(
    `- Prior-round failure: ${scalar('Prior-round failure', fields['Prior-round failure'])}`,
    `- Correction applied: ${scalar('Correction applied', fields['Correction applied'])}`,
    `- Correction paths: ${correctionPaths.length ? correctionPaths.join(', ') : 'none'}`,
    `- Updated scope: ${entries.length ? entries.map(entry => entry.path).join(', ') : scalar('Fileless reason', payload.filelessReason)}`,
    `- In-slice rationale: ${scalar('In-slice rationale', fields['In-slice rationale'])}`,
  );
  return lines.join('\n');
}
function capsule(format, fields) { return serialized({format, ...fields}); }
function objectStore() {
  const objects = new Map();
  return {
    add(value) { const copy = bytes(value, 'source bytes'); const id = raw(copy); objects.set(id, {id,bytesBase64:copy.toString('base64')}); return id; },
    finish() { return [...objects.values()].sort((a,b) => ordinal(a.id,b.id)); },
  };
}
function sourcesFor(cap, store) {
  const base = {
    transport:cap.transport, rawResponse:store.add(cap.rawResponse), receipt:store.add(cap.receipt),
    verificationObservation:cap.verificationObservation === null ? null : store.add(cap.verificationObservation),
    removalProofs:cap.removalProofs.map(item => store.add(item)).sort(ordinal), legacyPreparation:null,
  };
  if (new Set(base.removalProofs).size !== base.removalProofs.length) invalid('duplicate removal proof bytes');
  if (cap.transport === 'native') return {
    ...base,
    origin:store.add(capsule('stnl-native-origin-bundle-v1', {
      originUtf8:textBytes(cap.origin,'origin').text, dispatchUtf8:textBytes(cap.dispatch,'dispatch').text,
      baselineUtf8:textBytes(cap.baselineCapture,'baseline').text,
    })),
    agentBinding:store.add(capsule('stnl-native-agent-bundle-v1', {
      agentUtf8:textBytes(cap.agentBinding,'agent').text, claimUtf8:textBytes(cap.agentClaim,'claim').text,
    })),
    concludedToolResult:store.add(cap.concludedToolResult),
  };
  return {
    ...base,
    started:store.add(capsule('stnl-managed-start-bundle-v1', {
      contextUtf8:textBytes(cap.managedContext,'managed context').text, activeUtf8:textBytes(cap.active,'active').text,
      startedUtf8:textBytes(cap.started,'started').text, baselineUtf8:textBytes(cap.baselineCapture,'baseline').text,
    })),
    events:store.add(cap.events),
    closedSupervisor:store.add(capsule('stnl-managed-close-bundle-v1', {
      supervisorUtf8:textBytes(cap.closedSupervisor,'supervisor').text, latestUtf8:textBytes(cap.latest,'latest').text,
    })),
    runtimeIdentity:cap.runtimeIdentity.map(item => store.add(item)).sort(ordinal),
  };
}
function originRecord(owner, transport, transportInfo) {
  const {ownershipToken, ...origin} = owner;
  return {...origin, transport, dispatchId:transportInfo.dispatchId, runnerId:transportInfo.runnerId};
}
function semanticError(cause) { return new RunnerSemanticResultError('EXECUTE_SLICE', new Error(cause)); }
function presentRendered(value) {
  if (typeof value !== 'string' || value.length === 0 || /^(?:pending|n\/a)$/iu.test(value)) return false;
  const outsideEncodedScalars = value.replace(/json:"(?:\\.|[^"\\])*"/gu, 'json:""');
  return !/<[^>\n]+>/u.test(outsideEncodedScalars);
}
function nonPlaceholder(value) {
  return presentRendered(value) && !/^(?:none|not_available)$/iu.test(value);
}
function recordGrammarRejection(payload, entries, round) {
  const values = new Map(executionFields('EXECUTE_SLICE').map(([key, label]) => [label, payload[key]]));
  const rendered = label => {
    const value = values.get(label);
    return typeof value === 'string' ? serializeMarkdownScalar(label, value, isExplanatoryExecutionField(label)).trim() : '';
  };
  const scope = entries.length ? entries.map(entry => entry.path).join(', ').trim()
    : typeof payload.filelessReason === 'string'
      ? serializeMarkdownScalar('Fileless reason', payload.filelessReason, true).trim() : '';
  for (const label of ['HEAD','Tested scope','Discovery sources','Discovery actions','Verification types considered',
    'Selected checks','Selection rationale','Coverage','Failures','Blockers','Unexpected workspace effects','Persistence summary']) {
    const value = label === 'Tested scope' ? scope : rendered(label);
    if (!presentRendered(value)) return semanticError(`${label} must contain a persisted value`);
  }
  if (entries.length === 0 && !nonPlaceholder(scope)) return semanticError('Fileless reason must be objective non-placeholder content');
  if (payload.status === 'TESTS_PASS') for (const label of ['Tested scope','Verification types considered','Selected checks','Coverage']) {
    const value = label === 'Tested scope' ? scope : rendered(label);
    if (!nonPlaceholder(value)) return semanticError(`${label} must be objective non-placeholder content`);
  }
  if (round > 1) {
    for (const label of ['Prior-round failure','Correction applied','In-slice rationale']) {
      if (!nonPlaceholder(rendered(label))) return semanticError(`${label} must be objective non-placeholder content`);
    }
    if (!nonPlaceholder(scope)) return semanticError('Updated scope must be objective non-placeholder content');
  }
  return null;
}
function semantic(rawText, receipt, round) {
  try {
    parseCurrentJson(rawText);
  } catch { return {error:semanticError('captured response is not strict JSON')}; }
  try {
    return {payload:parseSemanticExecutionPayload(rawText, 'EXECUTE_SLICE', {
      automaticCheckRound:receipt.transport === 'native' ? undefined : `${round}/3`,
    })};
  } catch (error) { return {error:new RunnerSemanticResultError('EXECUTE_SLICE', error)}; }
}

function compose(input, info) {
  plain(input.rounds[0], 'round 1');
  const transport = input.rounds[0].transport;
  if (!['native','managed'].includes(transport)) fail('UNSUPPORTED_FORMAT', 'round 1: unknown transport');
  const store = objectStore();
  const implementation = []; const support = [];
  let previousAfter = null, previousStatus = null, dispatchId = null;
  const runners = new Set();
  let finalManaged = null;
  const managedCloses = [];
  const receipts = [];
  let productBytes = 0;
  for (const [index, cap] of input.rounds.entries()) {
    const round = index + 1;
    captureShape(cap, transport, `round ${round}`);
    if (round > 1 && previousStatus !== 'TESTS_FAIL') invalid(`round ${round}: previous round did not fail`);
    const rawText = textBytes(cap.rawResponse, `round ${round} rawResponse`).text;
    const receipt = jsonBytes(cap.receipt, `round ${round} receipt`).value;
    plain(receipt, `round ${round} receipt`);
    if (receipt.attempt !== round) invalid(`round ${round}: invocation sequence differs`);
    const base = jsonBytes(cap.baselineCapture, `round ${round} baselineCapture`).value;
    const claims = [...info.areas, ...info.inputs, ...info.refs];
    const before = baseline(base, input.owner, round, input.context, claims, `round ${round} baseline`);
    if (previousAfter !== null && !same(previousAfter, before)) stale(`round ${round}: baseline differs from previous tested product`);
    const transportInfo = transport === 'native'
      ? nativeOrigin(cap, receipt, rawText, input, round, info.resolved)
      : managedOrigin(cap, receipt, rawText, input, round);
    for (const proof of cap.removalProofs) {
      const parsed=jsonBytes(proof, `round ${round} removalProof`).value;
      plain(parsed, `round ${round} removalProof`);
      if (typeof parsed.bytesBase64 === 'string') productBytes += Buffer.from(parsed.bytesBase64,'base64').length;
      if (productBytes > 128 * 1024 * 1024) incomplete(`round ${round}: product capture exceeds 128 MiB`);
    }
    if (dispatchId !== null && dispatchId !== transportInfo.dispatchId) mismatch(`round ${round}: dispatch changed`);
    dispatchId = transportInfo.dispatchId;
    if (runners.has(transportInfo.runnerId)) mismatch(`round ${round}: runner identity replay`);
    runners.add(transportInfo.runnerId);
    if (transport === 'managed') { finalManaged = transportInfo; managedCloses.push(transportInfo); }
    receipts.push(receipt);
    const origin = originRecord(input.owner, transport, transportInfo);
    const result = semantic(rawText, receipt, round);
    const schemaRejected = result.error !== undefined;
    if (schemaRejected) {
      if (index !== input.rounds.length - 1) invalid(`round ${round}: rejected round cannot precede another`);
      if (receipt.status === 'RUNNER_RESULT_BLOCKED') {
        if (transport === 'native') {
          if (receipt.semanticResponseStatus !== null || receipt.testedState !== null
            || typeof receipt.captureFailure !== 'string' || !receipt.captureFailure.trim()) uncertain(`round ${round}: native rejection has no concluded schema receipt`);
        } else if (receipt.exitCode !== 1 || receipt.semanticResponseStatus !== null || receipt.testedState !== null
          || receipt.captureFailureCode !== 'RUNNER_RESPONSE_SCHEMA_INVALID' || typeof receipt.captureFailure !== 'string'
          || !receipt.captureFailure.trim()) uncertain(`round ${round}: managed rejection has no concluded schema receipt`);
        if (cap.verificationObservation === null) {
          if (receipt.verification !== null || cap.removalProofs.length !== 0) incomplete(`round ${round}: blocked receipt hides observation or removal proof`);
        } else {
          const observed=jsonBytes(cap.verificationObservation, `round ${round} verificationObservation`).value;
          observation(observed,input.owner,round,info,before,input.context,`round ${round} observation`);
          expectEqual(receipt.verification,observed,'EVIDENCE_STALE',`round ${round}: receipt observation`);
          domainChanges(before,observed.after,info,round);
          verifyRemoval(cap.removalProofs,input.owner,round,before,observed.after);
        }
      } else if (receipt.status === 'RUNNER_RESPONSE_CAPTURED') {
        if (receipt.captureFailure !== null || (transport === 'managed' && (receipt.exitCode !== 0 || receipt.captureFailureCode != null))) uncertain(`round ${round}: captured schema result is not concluded`);
        let loose;
        try { loose=JSON.parse(rawText); } catch { uncertain(`round ${round}: accepted receipt cannot bind non-JSON raw`); }
        if (receipt.semanticResponseStatus !== loose?.status) uncertain(`round ${round}: accepted receipt semantic status differs`);
        if (cap.verificationObservation === null) incomplete(`round ${round}: accepted schema result lacks observation`);
        const observed=jsonBytes(cap.verificationObservation, `round ${round} verificationObservation`).value;
        observation(observed,input.owner,round,info,before,input.context,`round ${round} observation`);
        expectEqual(receipt.verification,observed,'EVIDENCE_STALE',`round ${round}: receipt observation`);
        testedState(receipt.testedState,input.context,input.owner,before,observed.after,info,round);
        verifyRemoval(cap.removalProofs,input.owner,round,before,observed.after);
      } else uncertain(`round ${round}: schema result has no concluded capture`);
      const diagnostic = recoverableRunnerResultDiagnostic(result.error);
      if (diagnostic === null) invalid(`round ${round}: rejection diagnostic unavailable`);
      support.push({kind:'rejection', operationAttemptId:input.owner.operationAttemptId, origin, diagnostic,
        consumedInvocations:round, round, sources:sourcesFor(cap,store)});
      previousStatus = 'rejected';
      continue;
    }
    const payload = result.payload;
    if (receipt.status !== 'RUNNER_RESPONSE_CAPTURED' || receipt.semanticResponseStatus !== payload.status
      || receipt.captureFailure !== null || (transport === 'managed' && (receipt.exitCode !== 0 || receipt.captureFailureCode != null))) uncertain(`round ${round}: accepted result lacks capture receipt`);
    if (cap.verificationObservation === null) incomplete(`round ${round}: completed response lacks observation`);
    const observed = jsonBytes(cap.verificationObservation, `round ${round} verificationObservation`).value;
    const commands = observation(observed, input.owner, round, info, before, input.context, `round ${round} observation`);
    expectEqual(receipt.verification, observed, 'EVIDENCE_STALE', `round ${round}: receipt observation`);
    const entries = testedState(receipt.testedState, input.context, input.owner, before, observed.after, info, round);
    verifyRemoval(cap.removalProofs, input.owner, round, before, observed.after);
    previousAfter = observed.after;
    let rejection = null;
    if (transport === 'native' && (payload.automaticCheckRound !== `${round}/3` || !same(payload.commands, commands))) rejection = semanticError('native response round/commands contradict observed execution');
    if (!rejection) rejection = recordGrammarRejection(payload, entries, round);
    if (!rejection && payload.status === 'TESTS_FAIL' && !commands.some(command => command.exit !== 0)) rejection = semanticError('TESTS_FAIL requires an observed nonzero exit');
    if (!rejection && payload.status === 'TESTS_NOT_APPLICABLE') rejection = semanticError('TESTS_NOT_APPLICABLE contradicts the reviewed nonempty recipe');
    if (!rejection) {
      try {
        const helperResult = deriveCanonicalRunnerRejection({receipt, response:rawText});
        if (helperResult !== null) rejection = helperResult;
        else {
          assertRunnerVerdictConsistency('EXECUTE_SLICE', payload.status, commands);
          assertExecutionResultScope('EXECUTE_SLICE', payload, entries.length);
        }
      } catch (error) {
        if (recoverableRunnerResultDiagnostic(error) === null) incomplete(`round ${round}: semantic helper disagrees: ${error.message}`);
        rejection = error;
      }
    }
    if (rejection !== null) {
      if (index !== input.rounds.length - 1) invalid(`round ${round}: rejected round cannot precede another`);
      const diagnostic = recoverableRunnerResultDiagnostic(rejection);
      if (diagnostic === null) invalid(`round ${round}: rejection diagnostic unavailable`);
      support.push({kind:'rejection', operationAttemptId:input.owner.operationAttemptId, origin, diagnostic,
        consumedInvocations:round, round, sources:sourcesFor(cap,store)});
      previousStatus = 'rejected';
      continue;
    }
    const correction = round === 1 ? [] : changedLeaves(implementation.at(-1).testedWork, observed.after)
      .map(name => relativeTask(input.context, path.join(input.context.productRoot, name), input.owner.slice));
    const id = `implementation-check-${String(implementation.length + 1).padStart(2,'0')}`;
    const recordUtf8 = renderRecord(id, input.owner, payload, entries, commands, correction);
    implementation.push({kind:'implementation-check', recordFormat:'stnl-task-record-v2', id, origin,
      contract:{delivery:input.authority.delivery, context:input.authority.context, terminal:null, recipe:info.recipe},
      recordUtf8, testedWork:observed.after, sources:sourcesFor(cap,store)});
    previousStatus = payload.status;
  }
  if (transport === 'managed') {
    const {supervisor, latest, active} = finalManaged;
    if (supervisor.requestsHandled !== input.rounds.length
      || supervisor.capturedReceipts !== receipts.filter(receipt => receipt.status === 'RUNNER_RESPONSE_CAPTURED' && receipt.exitCode === 0).length
      || !same(latest.receipt, receipts.at(-1)) || latest.sequence !== active.sequence
      || managedCloses.some(item => !same(item.supervisor,supervisor) || !same(item.latest,latest))) uncertain('managed close/latest does not cover every round');
  }
  const bundle = {
    format:'stnl-current-evidence-v1', deliveryId:input.owner.deliveryId, slice:input.owner.slice,
    logicalTaskPath:`tasks/${input.owner.slice}.md`, currentAuthoritySha256:projected('delivery', input.authority.delivery),
    implementation, findingsChecks:[], validation:null, openFindings:[], openDivergences:[], support,
    objects:store.finish(),
  };
  validateCurrentEvidence(bundle);
  const resultBytes = serialized(bundle);
  return {bundle:parseCurrentJson(resultBytes.toString('utf8')), bytes:Uint8Array.from(resultBytes), sha256:raw(resultBytes),
    counters:{implementationChecks:implementation.length,findingsChecks:0,validationAttempts:0,findings:0},
    consumedInvocations:input.rounds.length, outcome:support.length ? 'rejected' : 'recorded'};
}

export function composeInitialImplementationEvidence(input) {
  const info = guard(input);
  return compose(input, info);
}

function restoreCapsule(objects, id, format, keys, label) {
  const data = objects.get(id);
  if (!data) incomplete(`${label}: missing capsule`);
  const parsed = jsonBytes(data, label).value;
  closed(parsed, ['format', ...keys], label);
  if (parsed.format !== format) fail('UNSUPPORTED_FORMAT', `${label}: capsule format`);
  const restored = {};
  for (const key of keys) restored[key] = utf8(str(parsed[key], `${label}.${key}`, false));
  return restored;
}
function restoreSources(record, objects) {
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
    const origin = restoreCapsule(objects,sources.origin,'stnl-native-origin-bundle-v1',['originUtf8','dispatchUtf8','baselineUtf8'],'native origin capsule');
    const agent = restoreCapsule(objects,sources.agentBinding,'stnl-native-agent-bundle-v1',['agentUtf8','claimUtf8'],'native agent capsule');
    return {...base, origin:origin.originUtf8,dispatch:origin.dispatchUtf8,baselineCapture:origin.baselineUtf8,
      agentBinding:agent.agentUtf8,agentClaim:agent.claimUtf8,concludedToolResult:get(sources.concludedToolResult,'toolResult')};
  }
  const start = restoreCapsule(objects,sources.started,'stnl-managed-start-bundle-v1',['contextUtf8','activeUtf8','startedUtf8','baselineUtf8'],'managed start capsule');
  const close = restoreCapsule(objects,sources.closedSupervisor,'stnl-managed-close-bundle-v1',['supervisorUtf8','latestUtf8'],'managed close capsule');
  return {...base, managedContext:start.contextUtf8,active:start.activeUtf8,started:start.startedUtf8,baselineCapture:start.baselineUtf8,
    events:get(sources.events,'events'),closedSupervisor:close.supervisorUtf8,latest:close.latestUtf8,
    runtimeIdentity:sources.runtimeIdentity.map(id => get(id,'runtimeIdentity'))};
}
export function validateInitialImplementationEvidence(input) {
  const info = guard(input, true);
  const original = bytes(input.bundleBytes, 'bundleBytes');
  const parsed = jsonBytes(original, 'bundleBytes').value;
  validateCurrentEvidence(parsed);
  if (parsed.deliveryId !== input.owner.deliveryId || parsed.slice !== input.owner.slice
    || parsed.currentAuthoritySha256 !== projected('delivery', input.authority.delivery)
    || parsed.findingsChecks.length || parsed.validation !== null || parsed.openFindings.length || parsed.openDivergences.length
    || parsed.support.length > 1 || parsed.support.some(item => item.kind !== 'rejection')) invalid('bundle outside initial implementation scope');
  const objects = new Map(parsed.objects.map(item => [item.id,Buffer.from(item.bytesBase64,'base64')]));
  const records = [...parsed.implementation,...parsed.support];
  if (!records.length || records.length > 3) invalid('bundle initial round count');
  for (const [index, record] of parsed.implementation.entries()) {
    if (record.id !== `implementation-check-${String(index + 1).padStart(2,'0')}`) invalid('bundle implementation ID sequence');
  }
  if (parsed.support.length && (parsed.support[0].round !== records.length || parsed.support[0].consumedInvocations !== records.length)) invalid('bundle rejection round/consumption');
  if (new Set(records.map(record => record.sources.receipt)).size !== records.length) invalid('bundle source replay');
  const rounds = records.map(item => restoreSources(item,objects));
  const candidate = compose({...input, rounds}, info);
  if (!same(parsed,candidate.bundle)) stale('bundle semantic reconstruction differs');
  return {...candidate, bundle:parseCurrentJson(original.toString('utf8')), bytes:Uint8Array.from(original), sha256:raw(original)};
}
