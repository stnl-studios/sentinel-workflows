import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCurrentJson, resolveLogicalProductClaim, logicalArtifactPath, validateCurrentCandidate } from './execution-current.mjs';

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
function workEntries(value, label) {
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
  return byPath;
}
function work(value,label) {
  const byPath=workEntries(value,label);
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
function observedAbsent(byPath,name) {
  const parts=name.split('/');
  for (let index=1;index<parts.length;index+=1) {
    const ancestor=byPath.get(parts.slice(0,index).join('/'));
    if (ancestor?.kind==='absent' || ancestor?.kind==='directory' && Array.isArray(ancestor.children)
      && !ancestor.children.includes(parts[index])) return true;
  }
  return false;
}
function canonicalConversionEntries(entries) {
  const byPath=new Map(entries.map(entry=>[entry.path,entry]));
  return entries.filter(entry=>entry.kind!=='absent' || !observedAbsent(byPath,entry.path))
    .sort((a,b)=>ordinal(a.path,b.path));
}
function conversionDomain(entries,claims,label,{legacy=false}={}) {
  const byPath=new Map(entries.map(entry=>[entry.path,entry]));
  const included=name=>claims.some(item=>item.path===name || item.kind==='directory' && name.startsWith(`${item.path}/`));
  for (const item of claims) {
    const entry=byPath.get(item.path);
    if (!entry) {
      if (item.kind!=='input' && !legacy && observedAbsent(byPath,item.path)) continue;
      incomplete(`${label}: missing declared ${item.path}`);
    }
    if (item.kind==='input' && entry.kind!=='file' || item.kind==='directory' && entry.kind==='file'
      || item.kind==='file' && entry.kind==='directory') stale(`${label}: declared kind differs ${item.path}`);
  }
  for (const entry of entries) {
    if (!included(entry.path)) incomplete(`${label}: unexpected domain member ${entry.path}`);
    // Separate declared roots can repeat an absence already proved by the
    // union. Present descendants still pass every parent/child check below.
    if (!legacy && entry.kind==='absent' && observedAbsent(byPath,entry.path)) continue;
    const parts=entry.path.split('/');
    for (let index=1;index<parts.length;index+=1) {
      const name=parts.slice(0,index).join('/'),parent=byPath.get(name);
      // Only ancestors inside an approved directory need an observation.
      if (!parent && !included(name)) continue;
      // v1 inventories roots, forecasts and prior paths independently: an
      // absent root may therefore have explicitly absent descendants.
      if (legacy && entry.kind==='absent' && (!parent || parent.kind==='absent')) continue;
      if (!parent || parent.kind!=='directory' || !legacy &&
        parent.children.includes(parts[index]) === (index===parts.length-1 && entry.kind==='absent'))
        incomplete(`${label}: missing parent/child closure ${entry.path}`);
    }
    if (!legacy && entry.kind==='directory') for (const child of entry.children) {
      if (!byPath.has(`${entry.path}/${child}`) || byPath.get(`${entry.path}/${child}`).kind==='absent')
        incomplete(`${label}: missing present child ${child}`);
    }
  }
  return byPath;
}

// An observation is the union of the selected delivery domains. Roots may be
// nested in the product; structural ancestors outside those domains are absent.
export function projectConversionObservedWork(value) {
  closed(value,['context','deliveries','observedWork'],'conversion work input');
  const {context}=value;
  const observed=JSON.parse(canonical(value.observedWork));
  workEntries(observed,'conversion observedWork');
  const declarations=new Map(),slices=new Set();
  for (const delivery of dense(value.deliveries,'conversion work deliveries',1)) {
    closed(delivery,['slice','deliveryId','authorizedAreas','existingInputs','verificationRecipe'],'conversion delivery domain');
    canonicalSlice(delivery.slice,'conversion domain slice');token(delivery.deliveryId,UUID,'conversion domain delivery');
    if (declarations.has(delivery.deliveryId) || slices.has(delivery.slice)) invalid('duplicate conversion delivery domain');
    slices.add(delivery.slice);
    const info=recipeAndClaims(context,delivery,delivery.slice);
    declarations.set(delivery.deliveryId,[...info.areas,...info.inputs]);
  }
  const union=conversionDomain(observed.entries,[...declarations.values()].flat(),'conversion observedWork');
  const projections=new Map();
  for (const [id,claims] of declarations) {
    let entries=observed.entries.filter(entry=>claims.some(item=>item.path===entry.path
      || item.kind==='directory' && entry.path.startsWith(`${item.path}/`)));
    for (const item of claims) if (!entries.some(entry=>entry.path===item.path) && observedAbsent(union,item.path))
      entries.push({path:item.path,kind:'absent'});
    entries=canonicalConversionEntries(entries);
    conversionDomain(entries,claims,`conversion ${id}`);
    projections.set(id,{format:'stnl-current-work-v1',entries});
  }
  return projections;
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
  closed(value, [...common, ...(transport === 'native' ? native : managed),
    ...(profile === 'current-validation' ? ['validationRequest'] : profile === 'current-findings' ? ['applyRequest'] : [])], label);
  if (value.transport !== transport) invalid(`${label}: mixed transports`);
  dense(value.removalProofs, `${label}.removalProofs`);
  if (transport === 'managed') dense(value.runtimeIdentity, `${label}.runtimeIdentity`);
  for (const key of [...common, ...(transport === 'native' ? native : managed)]) {
    if (key === 'transport' || key === 'removalProofs' || key === 'runtimeIdentity' || (key === 'verificationObservation' && value[key] === null)) continue;
    bytes(value[key], `${label}.${key}`);
  }
  if (profile === 'current-validation') bytes(value.validationRequest, `${label}.validationRequest`);
  if (profile === 'current-findings') bytes(value.applyRequest, `${label}.applyRequest`);
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
    || (profile !== 'current-validation' && receipt.automaticCheckRound !== `${round}/3`)) mismatch(`round ${round}: managed invocation`);
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
    origin:store.add(capsule(profile === 'current-validation' ? 'stnl-native-validation-origin-bundle-v1'
      : profile === 'current-findings' ? 'stnl-native-findings-origin-bundle-v1' : 'stnl-native-origin-bundle-v1', {
      originUtf8:textBytes(cap.origin,'origin').text, dispatchUtf8:textBytes(cap.dispatch,'dispatch').text,
      baselineUtf8:textBytes(cap.baselineCapture,'baseline').text,
      ...(profile === 'current-validation' ? {validationRequestUtf8:textBytes(cap.validationRequest,'validation request').text} : {}),
      ...(profile === 'current-findings' ? {applyRequestUtf8:textBytes(cap.applyRequest,'apply request').text} : {}),
    })),
    agentBinding:store.add(capsule('stnl-native-agent-bundle-v1', {
      agentUtf8:textBytes(cap.agentBinding,'agent').text, claimUtf8:textBytes(cap.agentClaim,'claim').text,
    })),
    concludedToolResult:store.add(cap.concludedToolResult),
  };
  return {
    ...base,
    started:store.add(capsule(profile === 'current-validation' ? 'stnl-managed-validation-start-bundle-v1'
      : profile === 'current-findings' ? 'stnl-managed-findings-start-bundle-v1' : 'stnl-managed-start-bundle-v1', {
      contextUtf8:textBytes(cap.managedContext,'managed context').text, activeUtf8:textBytes(cap.active,'active').text,
      startedUtf8:textBytes(cap.started,'started').text, baselineUtf8:textBytes(cap.baselineCapture,'baseline').text,
      ...(profile === 'current-validation' ? {validationRequestUtf8:textBytes(cap.validationRequest,'validation request').text} : {}),
      ...(profile === 'current-findings' ? {applyRequestUtf8:textBytes(cap.applyRequest,'apply request').text} : {}),
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
  const versionedCapsule = format.includes('-validation-') || format.includes('-findings-');
  if (!versionedCapsule) closed(parsed, ['format', ...keys], label);
  else plain(parsed,label);
  if (parsed.format !== format) fail(
    versionedCapsule && ['stnl-native-origin-bundle-v1','stnl-managed-start-bundle-v1'].includes(parsed.format)
      ? 'MIGRATION_REQUIRED' : 'UNSUPPORTED_FORMAT', `${label}: capsule format`);
  if (versionedCapsule) closed(parsed, ['format', ...keys], label);
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
    const origin = restoreCapsule(objects,sources.origin,profile === 'current-validation' ? 'stnl-native-validation-origin-bundle-v1'
      : profile === 'current-findings' ? 'stnl-native-findings-origin-bundle-v1' : 'stnl-native-origin-bundle-v1',
      ['originUtf8','dispatchUtf8','baselineUtf8',...(profile === 'current-validation' ? ['validationRequestUtf8'] : profile === 'current-findings' ? ['applyRequestUtf8'] : [])],'native origin capsule');
    const agent = restoreCapsule(objects,sources.agentBinding,'stnl-native-agent-bundle-v1',['agentUtf8','claimUtf8'],'native agent capsule');
    return {...base, origin:origin.originUtf8,dispatch:origin.dispatchUtf8,baselineCapture:origin.baselineUtf8,
      ...(profile === 'current-validation' ? {validationRequest:origin.validationRequestUtf8} : {}),
      ...(profile === 'current-findings' ? {applyRequest:origin.applyRequestUtf8} : {}),
      agentBinding:agent.agentUtf8,agentClaim:agent.claimUtf8,concludedToolResult:get(sources.concludedToolResult,'toolResult')};
  }
  const start = restoreCapsule(objects,sources.started,profile === 'current-validation' ? 'stnl-managed-validation-start-bundle-v1'
    : profile === 'current-findings' ? 'stnl-managed-findings-start-bundle-v1' : 'stnl-managed-start-bundle-v1',
    ['contextUtf8','activeUtf8','startedUtf8','baselineUtf8',...(profile === 'current-validation' ? ['validationRequestUtf8'] : profile === 'current-findings' ? ['applyRequestUtf8'] : [])],'managed start capsule');
  const close = restoreCapsule(objects,sources.closedSupervisor,'stnl-managed-close-bundle-v1',['supervisorUtf8','latestUtf8'],'managed close capsule');
  return {...base, managedContext:start.contextUtf8,active:start.activeUtf8,started:start.startedUtf8,baselineCapture:start.baselineUtf8,
    ...(profile === 'current-validation' ? {validationRequest:start.validationRequestUtf8} : {}),
    ...(profile === 'current-findings' ? {applyRequest:start.applyRequestUtf8} : {}),
    events:get(sources.events,'events'),closedSupervisor:close.supervisorUtf8,latest:close.latestUtf8,
    runtimeIdentity:sources.runtimeIdentity.map(id => get(id,'runtimeIdentity'))};
}

// The two closed profiles share source and transport checks, with distinct formal
// invocation rules. No caller supplies a verifier or bypass flag.
export function verifyCapturedInvocation(profile, cap, receipt, rawText, expectation, round, resolved) {
  if (!['initial-implementation', 'current-validation', 'current-findings'].includes(profile)) invalid('capture profile');
  plain(cap,`round ${round} capture`);
  const transport = receipt === undefined && profile !== 'current-validation' ? resolved : cap.transport;
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
function auxiliaryDeltas(before, after, info, round) {
  const old = new Map(before.entries.map(entry => [entry.path, entry]));
  const next = new Map(after.entries.map(entry => [entry.path, entry]));
  for (const name of old.keys()) if (!next.has(name)) stale(`round ${round}: prior domain member omitted ${name}`);
  const changed = [...new Set([...old.keys(), ...next.keys()])].sort(ordinal)
    .filter(name => !same(old.get(name) ?? null, next.get(name) ?? null));
  const leaves = changed.filter(name => old.get(name)?.kind === 'file' || next.get(name)?.kind === 'file');
  for (const name of changed) {
    if (info.inputs.some(item => item.path === name) && !areaContains(info.areas, name)) stale(`round ${round}: exclusive input changed ${name}`);
    const beforeEntry = old.get(name), afterEntry = next.get(name);
    const structural = beforeEntry?.kind === 'directory' || afterEntry?.kind === 'directory';
    if (!structural) {
      if (!areaContains(info.areas, name)) stale(`round ${round}: out-of-area delta ${name}`);
      continue;
    }
    // Parent entries are domain closure, not extra authority. Every changed child
    // edge must be explained by authorized leaf creation/removal below that edge.
    const oldChildren = beforeEntry?.kind === 'directory' ? beforeEntry.children : [];
    const newChildren = afterEntry?.kind === 'directory' ? afterEntry.children : [];
    const edges = [...new Set([...oldChildren, ...newChildren])]
      .filter(child => oldChildren.includes(child) !== newChildren.includes(child));
    const justified = edge => leaves.some(leaf => (leaf === edge || leaf.startsWith(`${edge}/`))
      && areaContains(info.areas, leaf)
      && (old.get(leaf)?.kind === 'file') !== (next.get(leaf)?.kind === 'file'));
    if (edges.some(child => !justified(`${name}/${child}`))
      || (!edges.length && !areaContains(info.areas, name))
      || ([beforeEntry, afterEntry].some(entry => entry?.kind === 'file') && !areaContains(info.areas, name)))
      stale(`round ${round}: unexplained directory delta ${name}`);
  }
  return leaves;
}
function auxiliaryRemovalProofs(blobs, owner, round, before, after) {
  dense(blobs, `round ${round} removal proofs`);
  const old = new Map(before.entries.map(entry => [entry.path, entry]));
  const next = new Map(after.entries.map(entry => [entry.path, entry]));
  const required = [...old].filter(([name, entry]) => entry.kind === 'file' && next.get(name)?.kind === 'absent')
    .map(([name]) => name).sort(ordinal);
  const seen = new Set();
  for (const [index, blob] of blobs.entries()) {
    const proof = jsonBytes(blob, `round ${round} removal proof ${index + 1}`).value;
    closed(proof, ['format','owner','round','path','sha256','mode','bytesBase64'], `round ${round} removal proof`);
    if (proof.format !== 'stnl-current-removal-proof-v1') fail('CURRENT_FORMAT_REQUIRED', 'removal proof format');
    ownerMatches(proof.owner, owner, `round ${round} removal owner`);
    if (proof.round !== round) mismatch(`round ${round}: removal round`);
    relative(proof.path, `round ${round} removal path`);
    const prior = old.get(proof.path);
    if (proof.round !== round || !prior || prior.kind !== 'file' || next.get(proof.path)?.kind !== 'absent'
      || prior.sha256 !== proof.sha256 || prior.mode !== proof.mode) incomplete(`round ${round}: removal preimage differs`);
    if (typeof proof.bytesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(proof.bytesBase64)) incomplete(`round ${round}: removal base64`);
    const product = Buffer.from(proof.bytesBase64, 'base64');
    if (product.toString('base64') !== proof.bytesBase64 || raw(product) !== prior.sha256) incomplete(`round ${round}: removal bytes differ`);
    if (seen.has(proof.path)) invalid(`round ${round}: duplicate removal proof`);
    seen.add(proof.path);
  }
  expectEqual([...seen].sort(ordinal), required, 'EVIDENCE_INCOMPLETE', `round ${round}: removal proof set`);
  return seen;
}
export function verifyAuxiliaryWork(profile, input) {
  if (profile !== 'current-findings') invalid('auxiliary work profile');
  closed(input, ['context','authority','owner','round','capture','receipt','priorScopePaths','previousScopePaths','previousAfter','witnessedRemovals','status'], 'auxiliary work input');
  const {context, authority, owner, round, capture, receipt} = input;
  const info = recipeAndClaims(context, authority.delivery, owner.slice);
  const claims = [...info.areas, ...info.inputs, ...info.refs];
  const baselineDocument = jsonBytes(capture.baselineCapture, `round ${round} baseline`).value;
  const before = baseline(baselineDocument, owner, round, context, claims, `round ${round} baseline`);
  if (input.previousAfter !== null) expectEqual(before, input.previousAfter, 'EVIDENCE_STALE', `round ${round}: baseline continuity`);
  for (const [paths, label] of [[input.priorScopePaths, 'prior scope'], [input.previousScopePaths, 'previous scope']]) {
    dense(paths, label);
    for (const name of paths) {
      relative(name, `${label} path`);
      if (!before.entries.some(entry => entry.path === name)) incomplete(`round ${round}: ${label} member omitted ${name}`);
    }
  }
  dense(input.witnessedRemovals, 'witnessed removals');
  if (capture.verificationObservation === null) {
    if (receipt.verification !== null || capture.removalProofs.length) incomplete(`round ${round}: absent observation conflicts with receipt/proofs`);
    return {info, before, observed:null, commands:null, entries:null, scopePaths:null, correctionPaths:null, removed:[]};
  }
  const observed = jsonBytes(capture.verificationObservation, `round ${round} observation`).value;
  const commands = observation(observed, owner, round, info, before, context, `round ${round} observation`);
  expectEqual(receipt.verification, observed, 'EVIDENCE_STALE', `round ${round}: receipt observation`);
  const after = observed.after;
  const deltas = auxiliaryDeltas(before, after, info, round);
  const removed = auxiliaryRemovalProofs(capture.removalProofs, owner, round, before, after);
  const byPath = new Map(after.entries.map(entry => [entry.path, entry]));
  const witnesses = new Set([...input.witnessedRemovals, ...removed]);
  const scopePaths = [...new Set([
    ...input.priorScopePaths, ...input.previousScopePaths,
    ...after.entries.filter(entry => ['file','absent'].includes(entry.kind) && areaContains(info.areas, entry.path)).map(entry => entry.path),
    ...info.refs.filter(ref => ref.kind === 'product').map(ref => ref.path),
    ...witnesses,
  ])].sort(ordinal);
  for (const name of scopePaths) {
    const entry = byPath.get(name);
    if (!entry || entry.kind === 'directory') stale(`round ${round}: scope lacks leaf ${name}`);
  }
  if (receipt.testedState === null) return {info, before, observed, commands, entries:null, scopePaths, correctionPaths:deltas, removed:[...removed]};
  closed(receipt.testedState, ['workspace','sourceTaskPath','entries'], `round ${round} testedState`);
  if (receipt.testedState.workspace !== context.productRoot
    || receipt.testedState.sourceTaskPath !== logicalArtifactPath(context, `tasks/${owner.slice}.md`)) stale(`round ${round}: testedState context`);
  dense(receipt.testedState.entries, `round ${round} testedState entries`);
  const selected = new Set(); let previous = null;
  for (const entry of receipt.testedState.entries) {
    closed(entry, ['path','value'], `round ${round} tested entry`);
    relative(entry.path, `round ${round} tested path`);
    if (previous !== null && ordinal(previous, entry.path) >= 0) invalid(`round ${round}: tested entries order`);
    previous = entry.path;
    const absolute = resolveLogicalProductClaim(context, `tasks/${owner.slice}.md`, entry.path);
    const name = productRelative(context, absolute, `round ${round} tested path`);
    const state = byPath.get(name);
    if (!scopePaths.includes(name) || !state || state.kind === 'directory' || selected.has(name)) stale(`round ${round}: tested target outside scope`);
    if (entry.value !== (state.kind === 'file' ? state.sha256 : 'REMOVED')) stale(`round ${round}: tested value differs`);
    if (state.kind === 'absent' && !witnesses.has(name)) incomplete(`round ${round}: REMOVED without witness ${name}`);
    selected.add(name);
  }
  for (const name of scopePaths) {
    const state = byPath.get(name);
    if (state.kind === 'file' && !selected.has(name)) incomplete(`round ${round}: file output lacks tested tuple ${name}`);
    if (state.kind === 'absent' && witnesses.has(name) && !selected.has(name)) incomplete(`round ${round}: removed output lacks tested tuple ${name}`);
    if (state.kind === 'absent' && !witnesses.has(name) && input.status === 'TESTS_PASS') incomplete(`round ${round}: PASS lacks removal witness ${name}`);
  }
  for (const name of deltas) if (!scopePaths.includes(name)) stale(`round ${round}: correction omitted ${name}`);
  return {info, before, observed, commands, entries:receipt.testedState.entries, scopePaths,
    correctionPaths:deltas, removed:[...removed]};
}
export function packCaptureSources(profile, cap, store) {
  if (!['initial-implementation', 'current-validation', 'current-findings'].includes(profile)) invalid('source profile');
  return sourcesFor(cap, store, profile);
}
export function restoreCaptureSources(profile, record, objects) {
  if (!['initial-implementation', 'current-validation', 'current-findings'].includes(profile)) invalid('source profile');
  return restoreSources(record, objects, profile);
}
// Only invocation-local bytes enter this link. In particular, managed close and
// latest are unavailable when the next request is dispatched.
export function findingsRoundCaptureSha256(cap) {
  plain(cap, 'findings link capture');
  if (!['native', 'managed'].includes(cap.transport)) fail('UNSUPPORTED_FORMAT', 'findings link transport');
  // The link is also available before the aggregate managed close exists. Guard
  // exactly its invocation-local projection; full capture guards remain mandatory
  // at incorporation. Never read accessors while projecting.
  const stable = ['transport','applyRequest','rawResponse','receipt','baselineCapture',
    'verificationObservation','removalProofs', ...(cap.transport === 'native'
      ? ['origin','dispatch','agentBinding','agentClaim','concludedToolResult']
      : ['managedContext','active','started','events','runtimeIdentity'])];
  if (Object.keys(cap).some(key => !stable.includes(key)
    && !(cap.transport === 'managed' && ['closedSupervisor','latest'].includes(key)))
    || stable.some(key => !Object.hasOwn(cap,key))) invalid('findings link capture: fields differ');
  for (const key of stable) {
    if (key === 'transport') continue;
    if (['removalProofs','runtimeIdentity'].includes(key)) {
      dense(cap[key], `findings link ${key}`);
      for (const blob of cap[key]) bytes(blob, `findings link ${key}`);
    } else bytes(cap[key], `findings link ${key}`);
  }
  const uniqueHashes = (items, label) => {
    const hashes = items.map(item => raw(bytes(item, label)));
    if (new Set(hashes).size !== hashes.length) invalid(`${label}: duplicate bytes`);
    return hashes.sort(ordinal);
  };
  const link = {
    format:'stnl-current-findings-round-link-v1', transport:cap.transport,
    applyRequest:raw(cap.applyRequest), rawResponse:raw(cap.rawResponse), receipt:raw(cap.receipt),
    baselineCapture:raw(cap.baselineCapture), verificationObservation:raw(cap.verificationObservation),
    removalProofs:uniqueHashes(cap.removalProofs, 'removal proof'),
    ...(cap.transport === 'native' ? {
      origin:raw(cap.origin), dispatch:raw(cap.dispatch), agentBinding:raw(cap.agentBinding),
      agentClaim:raw(cap.agentClaim), concludedToolResult:raw(cap.concludedToolResult),
    } : {
      managedContext:raw(cap.managedContext), active:raw(cap.active), started:raw(cap.started),
      events:raw(cap.events), runtimeIdentity:uniqueHashes(cap.runtimeIdentity, 'runtime identity'),
    }),
  };
  return raw(serialized(link));
}
export function closeEvidenceObjects() { return objectStore(); }

function importedObject(objects, id, label) {
  if (!(objects instanceof Map) || Object.getPrototypeOf(objects) !== Map.prototype) invalid('imported object store');
  token(id, HASH, label);
  const value = Map.prototype.get.call(objects,id);
  if (!value || raw(bytes(value,label)) !== id) incomplete(`${label}: referenced bytes differ`);
  return jsonBytes(value,label).value;
}

function importedCapsule(objects, id, format, fields, label) {
  const value = importedObject(objects,id,label);
  closed(value,['format',...fields],label);
  if (value.format !== format) fail('UNSUPPORTED_FORMAT',`${label}: capsule format`);
  return Object.fromEntries(fields.map(key => [key,utf8(str(value[key],`${label}.${key}`))]));
}

function importedManifest(value, record, context) {
  closed(value,['format','logicalExecutionRoot','logicalWorkspaceRoot','slice','deliveryId',
    'operationAttemptId','sourceActivationId','preparationRevision','requirementsAuthority','normativeSha256','entries'],
    'legacy work manifest');
  if (value.format !== 'stnl-work-continuation-v1' || value.logicalExecutionRoot !== context.logicalExecutionRoot
    || value.logicalWorkspaceRoot !== context.productRoot || value.slice !== record.origin.slice
    || value.deliveryId !== record.origin.deliveryId || value.operationAttemptId !== record.origin.operationAttemptId
    || value.sourceActivationId !== record.origin.originActivationId
    || value.preparationRevision !== record.origin.preparationRevision
    || value.requirementsAuthority !== record.contract.context.requirementsAuthority
    || value.normativeSha256 !== record.origin.normativeSha256)
    mismatch('legacy work manifest identity differs');
  dense(value.entries,'legacy work entries',0,10000);
  const paths = new Map();
  for (const entry of value.entries) {
    closed(entry,['path','kind','sha256','storedPath'],'legacy work entry');
    relative(entry.path,'legacy work path');
    if (paths.has(entry.path)) invalid('duplicate legacy work path');
    if (!['directory','absent','file'].includes(entry.kind)) invalid('legacy work kind');
    if (entry.kind === 'file') token(entry.sha256,HASH,'legacy work hash');
    else if (entry.sha256 !== null || entry.storedPath !== null) invalid('non-file legacy work hash');
    paths.set(entry.path,entry);
  }
  if ([...paths.keys()].some((name,index,array) => index && array[index-1].localeCompare(name,'en')>=0)) invalid('legacy work order');
  if ([...paths.values()].some(entry => entry.kind === 'file')) incomplete('legacy file mode was never captured');
  const entries=canonicalConversionEntries([...paths.values()].map(entry => entry.kind === 'directory'
    ? {path:entry.path,kind:'directory',children:[...paths.values()].filter(child => child.kind !== 'absent'
      && path.posix.dirname(child.path) === entry.path).map(child => path.posix.basename(child.path)).sort(ordinal)}
    : {path:entry.path,kind:'absent'}));
  const result={format:'stnl-current-work-v1',entries};
  const info=recipeAndClaims(context,record.contract.delivery,record.origin.slice);
  conversionDomain(result.entries,[...info.areas,...info.inputs],'imported testedWork');
  return result;
}

function importedTerminal(publication, owner, manifestBytes, context) {
  plain(publication,'terminal publication');
  plain(publication.confirmation,'terminal confirmation');
  plain(publication.expectedInstalledActivation,'terminal activation');
  dense(publication.expectedInstalledActivation.artifacts,'terminal artifacts');
  if (publication.format !== 'stnl-execution-publication-owner-v1' || !publication.confirmation
    || publication.confirmation.terminalOperationAttemptId !== owner.operationAttemptId
    || publication.confirmation.activationId !== publication.expectedInstalledActivation?.activationId
    || publication.expectedInstalledActivation.activeAttempt !== null
    || publication.expectedInstalledActivation.lastAttempt?.operationAttemptId !== owner.operationAttemptId
    || publication.expectedInstalledActivation.lastAttempt.terminalActivationId !== publication.confirmation.activationId
    || publication.expectedInstalledActivation.lastAttempt.originActivationId !== owner.originActivationId
    || !same(publication.owner,owner)
    || publication.expectedInstalledActivation.lastAttempt.deliveryId !== owner.deliveryId
    || publication.expectedInstalledActivation.lastAttempt.slice !== owner.slice
    || publication.expectedInstalledActivation.lastAttempt.operation !== owner.operation
    || publication.expectedInstalledActivation.lastAttempt.ownershipToken !== owner.ownershipToken
    || publication.expectedInstalledActivation.lastAttempt.preparationRevision !== owner.preparationRevision
    || publication.expectedInstalledActivation.lastAttempt.normativeSha256 !== owner.normativeSha256
    || !same(publication.expectedInstalledActivation.lastAttempt.workCapture,owner.workCapture)
    || publication.confirmation.artifactManifestSha256!==raw(utf8(JSON.stringify(publication.expectedInstalledActivation.artifacts)))
    || publication.retention?.producer !== 'operational-publication'
    || !same(publication.retention.owner,owner)
    || publication.retention.executionRoot !== context.logicalExecutionRoot
    || publication.executionRoot !== context.logicalExecutionRoot
    || publication.retention.allocationId !== publication.allocationId
    || publication.retentionRoot !== path.join(context.logicalSpecRoot===null
      ? path.dirname(context.logicalExecutionRoot) : path.dirname(context.logicalSpecRoot),
      `.stnl-execution-backup-${publication.allocationId}`))
    incomplete('publication does not confirm this terminal operation');
  const retained = publication.retention?.retainedPaths;
  const manifestPath=path.join(publication.retentionRoot,'preserved-product-manifest.json');
  if (!Array.isArray(retained) || !retained.some(item => item.path === manifestPath && item.sha256 === raw(manifestBytes)))
    incomplete('tested preimage is not producer retained');
}

function importedOwner(value, record, label) {
  plain(value,label);
  for (const [key,expected] of Object.entries({operationAttemptId:record.origin.operationAttemptId,
    deliveryId:record.origin.deliveryId,slice:record.origin.slice,operation:record.origin.operation,
    preparationRevision:record.origin.preparationRevision,normativeSha256:record.origin.normativeSha256,
    originActivationId:record.origin.originActivationId}))
    if (value[key]!==expected) mismatch(`${label}: ${key} differs`);
  token(value.ownershipToken,UUID,`${label}.ownershipToken`);
  if (Object.hasOwn(value,'localRevision') && value.localRevision!==null)
    mismatch(`${label}: legacy localRevision is not null`);
  return value;
}

function importedRecordField(text,name) {
  const items=[...text.matchAll(new RegExp(`^- ${name}: (.+)$`,'gmu'))];
  if (items.length !== 1) incomplete(`imported record: missing/duplicate ${name}`);
  return items[0][1];
}

function importedScalar(value) {
  if (!value.startsWith('json:')) return value;
  const decoded=parseCurrentJson(value.slice(5));
  if (typeof decoded!=='string' || (!/[`\r\n]/u.test(decoded) && !decoded.startsWith('json:'))
    || `json:${JSON.stringify(decoded)}`!==value)
    incomplete('imported record: noncanonical explanatory scalar');
  return decoded;
}

function importedSemanticFields(record,payload,receipt) {
  const pairs=record.kind==='validation'
    ? [['Status','status'],['HEAD','head'],['Evidence','evidence'],['Blockers','blockers'],
      ['Unexpected workspace effects','unexpectedWorkspaceEffects'],['Persistence summary','persistenceSummary']]
    : [['Status','status'],['HEAD','head'],['Discovery sources','discoverySources'],
      ['Discovery actions','discoveryActions'],['Verification types considered','verificationTypesConsidered'],
      ['Selected checks','selectedChecks'],['Selection rationale','selectionRationale'],
      ['Coverage','coverage'],['Failures','failures'],['Blockers','blockers'],
      ['Unexpected workspace effects','unexpectedWorkspaceEffects'],['Persistence summary','persistenceSummary']];
  for (const [field,key] of pairs) if (importedScalar(importedRecordField(record.recordUtf8,field))!==payload[key])
    incomplete(`${record.id}: ${field} differs from captured response`);
  if (record.kind==='validation') {
    const references=importedRecordField(record.recordUtf8,'Finding references');
    const dispositions=importedRecordField(record.recordUtf8,'Finding dispositions');
    const capturedDispositions=payload.findingReferences==='none' && payload.findingDispositions==='unchanged'
      ? 'none' : payload.findingDispositions;
    if (references!==payload.findingReferences || dispositions!==capturedDispositions)
      incomplete(`${record.id}: finding disposition differs from captured response`);
    const ids=references==='none'?[]:references.split(', ');
    if (ids.some(id=>!/^finding-[0-9]{2,}$/u.test(id)) || new Set(ids).size!==ids.length
      || ids.some((id,index)=>index && ids[index-1].localeCompare(id,'en')>=0)
      || (ids.length ? !['resolved','superseded'].includes(dispositions.split(', ')[0]?.split('=')[1]) : dispositions!=='none')
      || (ids.length && !same(dispositions.split(', ').map(item=>item.split('=')[0]),ids))
      || (ids.length && dispositions.split(', ').some(item=>!/^finding-[0-9]{2,}=(?:resolved|superseded)$/u.test(item))))
      incomplete(`${record.id}: formal PASS has an open or malformed finding disposition`);
  }
  if (record.kind==='implementation-check'
    && (importedRecordField(record.recordUtf8,'Automatic check round')!==`${receipt.attempt}/3`
      || (Object.hasOwn(payload,'automaticCheckRound') && payload.automaticCheckRound!==`${receipt.attempt}/3`)))
    mismatch(`${record.id}: automatic round differs`);
}

function importedCommandTuples(body,label) {
  const marker=[...body.matchAll(/^- Commands:$/gmu)];
  if (marker.length!==1) incomplete(`${label}: commands absent`);
  const tail=body.slice(marker[0].index+marker[0][0].length);
  const end=tail.search(/^- [^:\n]+:/mu);
  const lines=(end<0?tail:tail.slice(0,end)).replace(/^\n/u,'').trimEnd().split('\n');
  if (!lines.length || !lines[0]) incomplete(`${label}: commands empty`);
  return lines.map(line=>{
    const match=/^  - (?:`([^`\r\n]+)`|json:(".*")) \| exit:([-]?[0-9]+)$/u.exec(line);
    if (!match) incomplete(`${label}: command tuple malformed`);
    const command=match[1]??parseCurrentJson(match[2]);
    const exit=Number(match[3]);
    if (typeof command!=='string' || !command || !Number.isSafeInteger(exit)
      || (match[2] && (!/[`\r\n]/u.test(command) || JSON.stringify(command)!==match[2])))
      incomplete(`${label}: command tuple invalid`);
    return {command,exit};
  });
}

function importedTestedState(record, tested) {
  const marker=[...record.recordUtf8.matchAll(/^- Tested state:(?: (none))?$/gmu)];
  if (marker.length!==1) incomplete(`${record.id}: Tested state carrier`);
  const body=record.recordUtf8;
  const tail=body.slice(marker[0].index+marker[0][0].length);
  const end=tail.search(/^- [^:\n]+:/mu);
  const block=(end<0?tail:tail.slice(0,end)).replace(/^\n/u,'').trimEnd();
  if (marker[0][1]==='none') {
    if (block || !/^- Fileless reason: \S.+$/mu.test(body)
      || importedScalar(importedRecordField(body,'Tested scope'))!==importedScalar(importedRecordField(body,'Fileless reason'))) incomplete(`${record.id}: invalid fileless carrier`);
    return;
  }
  incomplete(`${record.id}: file-backed tested state lacks original mode`);
}

function importedEffectiveBase(carrier,formal,tested) {
  const body=carrier.get('Effective Validation Base');
  if (!body || body==='- none') incomplete('formal PASS lacks Effective Validation Base');
  const field=name=>importedRecordField(body,name);
  const attempt=formal.recordUtf8;
  if (field('Origin attempt')!==formal.id || field('Attempt type')!==importedRecordField(attempt,'Type')
    || field('HEAD')!==importedRecordField(attempt,'HEAD') || field('Result')!=='PASS'
    || field('Evidence summary')!==importedRecordField(attempt,'Evidence'))
    incomplete('Effective Validation Base differs from formal PASS');
  const marker=body.indexOf('- Authoritative commands:');
  const evidence=body.indexOf('- Evidence summary:');
  if (marker<0 || evidence<=marker) incomplete('Effective Validation Base command order');
  const commands=body.slice(marker+'- Authoritative commands:'.length,evidence)
    .replace(/^\n/u,'').trimEnd().split('\n');
  const expected=importedCommandTuples(attempt,'formal attempt');
  const actual=importedCommandTuples(`- Commands:\n${commands.join('\n')}`,'Effective Validation Base');
  if (!same(actual,expected) || actual.some(item=>item.exit!==0)) incomplete('Effective Validation Base commands differ');
  const fileless=/^- Files: none$/mu.test(body);
  if (fileless) {
    if (importedRecordField(attempt,'Verified scope')!=='fileless task state'
      || [...body.matchAll(/^- Files:/gmu)].length!==1
      || !/^- Fileless reason: \S.+$/mu.test(body) || tested.entries.some(entry=>entry.kind==='file'))
      incomplete('Effective Validation Base fileless claim differs');
  } else {
    const tuples=[...body.matchAll(/^  - `([^`]+)` \| (sha256:[a-f0-9]{64}|REMOVED)$/gmu)];
    if (!tuples.length || tuples.some(match=>match[2]==='REMOVED'))
      incomplete('Effective Validation Base needs historical file mode');
  }
}

function importedPreparationEquivalent(old, oldDelivery, approvedAuthority) {
  const leaf=approvedAuthority.delivery;
  const oldGlobal=old.normativeProjection.global;
  const global=approvedAuthority.snapshot.normativeProjection.global;
  if (oldGlobal.Objective!==global.objective || oldGlobal.Strategy!==global.strategy
    || old.normativeProjection.risks!==global.risks
    || !same(old.normativeProjection.order.map(item=>item.slice),
      approvedAuthority.snapshot.deliveries.map(item=>item.slice)))
    stale('imported global preparation differs');
  const sections={
    objectiveAndObservableResult:'Objective and Observable Result',requirements:'Requirements',
    includedScope:'Included Scope',outOfScopeAndBoundaries:'Out of Scope and Boundaries',
    authorizedAreas:'Authorized Areas',existingInputs:'Existing Inputs',
    protectedResponsibilities:'Protected Responsibilities',risksAndStrategy:'Risks and Strategy',
    expectedTests:'Expected Tests',completionCriterion:'Completion Criterion',
  };
  for (const [key,heading] of Object.entries(sections))
    if (oldDelivery.plan[heading]!==leaf[key]) stale(`imported ${heading} differs`);
  if (oldDelivery.task.Result!==leaf.taskResult || !same(oldDelivery.obligations,leaf.obligations)
    || !same(oldDelivery.plan['Verification Recipe'],oldDelivery.task['Verification Recipe']))
    stale('imported task result, obligations or recipe differs');
  const oldDependencies=old.normativeProjection.order.find(item=>item.slice===oldDelivery.slice)?.dependencies;
  const ids=oldDependencies==='-'?[]:oldDependencies?.split(', ').map(slice=>
    old.normativeProjection.deliveries.find(item=>item.slice===slice)?.deliveryId);
  if (!ids || !same(ids,leaf.dependencies)) stale('imported dependencies differ');
}

function legacySpecPath(context,value) {
  return typeof value==='string' && (value===context.logicalAuthorityPath
    || (context.logicalSpecRoot!==null && value===context.logicalSpecRoot));
}
function legacyOwnerEquals(value,owner,label) {
  plain(value,label);
  if (!same(value,owner)) mismatch(`${label}: full owner differs`);
}
function legacyManifestFacts(manifest,owner,authority,context,capture,publication) {
  closed(manifest,['format','logicalExecutionRoot','logicalWorkspaceRoot','slice','deliveryId',
    'operationAttemptId','sourceActivationId','preparationRevision','requirementsAuthority','normativeSha256','entries'],
    'legacy manifest');
  if (manifest.format!=='stnl-work-continuation-v1'
    || manifest.logicalExecutionRoot!==context.logicalExecutionRoot || manifest.logicalWorkspaceRoot!==context.productRoot
    || manifest.slice!==owner.slice || manifest.deliveryId!==owner.deliveryId
    || manifest.operationAttemptId!==owner.operationAttemptId || manifest.sourceActivationId!==owner.originActivationId
    || manifest.preparationRevision!==owner.preparationRevision || manifest.normativeSha256!==owner.normativeSha256
    || manifest.requirementsAuthority!==authority) mismatch('legacy manifest identity differs');
  dense(manifest.entries,'legacy manifest entries',0,10000);
  const retained=new Map();
  for (const item of dense(capture.retainedFiles,'retained files')) {
    closed(item,['path','bytes'],'retained file');absolute(item.path,'retained file path');
    if (retained.has(item.path)) invalid('duplicate retained file');
    retained.set(item.path,bytes(item.bytes,'retained file bytes'));
  }
  let previous=null;
  for (const entry of manifest.entries) {
    closed(entry,['path','kind','sha256','storedPath'],'legacy entry');relative(entry.path,'legacy entry path');
    // The v1 producer hashes this exact locale-ordered tuple list.
    if (previous!==null && previous.localeCompare(entry.path,'en')>=0) invalid('legacy manifest order');
    previous=entry.path;
    if (!['file','directory','absent'].includes(entry.kind)) invalid('legacy entry kind');
    if (entry.kind==='file') {
      token(entry.sha256,HASH,'legacy file hash');absolute(entry.storedPath,'legacy retained path');
      const rel=path.relative(publication.retentionRoot,entry.storedPath);
      if (!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
        || !retained.has(entry.storedPath) || raw(retained.get(entry.storedPath))!==entry.sha256
        || !publication.retention.retainedPaths.some(item=>item.path===entry.storedPath && item.sha256===entry.sha256))
        incomplete('retained file bytes differ from tested preimage');
      retained.delete(entry.storedPath);
    } else if (entry.sha256!==null || entry.storedPath!==null) invalid('legacy non-file hash/path');
  }
  if (retained.size) incomplete('unexpected retained file bytes');
}

// Shared v1 proof boundary: all content is original producer bytes, with no
// current owner, file mode, observation or activation manufactured for v1.
export async function verifyLegacyOperationFacts(value) {
  closed(value,['context','legacyPreparationBytes','operationRecordUtf8','capture'],'legacy operation input');
  const {context,capture}=value;
  plain(capture,'legacy capture');
  const common=['transport','receipt','rawResponse','verificationObservation','workManifest','publication','retainedFiles'];
  closed(capture,[...common,...(capture.transport==='native'
    ? ['origin','dispatch','agentBinding','agentClaim','concludedToolResult']
    : ['managedContext','active','started','events','closedSupervisor','latest','runtimeIdentity'])],'legacy capture');
  if (!['native','managed'].includes(capture.transport)) fail('UNSUPPORTED_FORMAT','legacy transport');
  const decode=name=>jsonBytes(capture[name],`legacy ${name}`).value;
  const receipt=decode('receipt'), responseBytes=bytes(capture.rawResponse,'legacy response');
  const response=jsonBytes(responseBytes,'legacy response').value;
  const observation=decode('verificationObservation'),manifest=decode('workManifest'),publication=decode('publication');
  const owner=plain(receipt.owner,'legacy receipt owner');
  for (const key of ['operationAttemptId','ownershipToken','deliveryId','originActivationId']) token(owner[key],UUID,`legacy owner ${key}`);
  canonicalSlice(owner.slice,'legacy owner slice');integer(owner.preparationRevision,'legacy owner revision',1);
  token(owner.normativeSha256,HASH,'legacy owner normative hash');
  if (Object.hasOwn(owner,'localRevision') && owner.localRevision!==null) mismatch('legacy owner local revision');
  const operationRecordUtf8=str(value.operationRecordUtf8,'legacy record');
  const heading=/^### ((attempt|implementation-check)-([0-9]{2,}))\n/u.exec(operationRecordUtf8);
  if (!heading || String(Number(heading[3])).padStart(2,'0')!==heading[3]) incomplete('legacy record heading');
  integer(Number(heading[3]),'legacy record ordinal',1);
  const record={id:heading[1],kind:heading[2]==='attempt'?'validation':'implementation-check',recordUtf8:operationRecordUtf8};
  const wanted=record.kind==='validation'?'PASS':'TESTS_PASS';
  if (owner.operation!==(record.kind==='validation'?'VALIDATE_SLICE':'EXECUTE_SLICE')) mismatch('legacy operation differs');
  const {validateApprovedPreparation,parseVerificationRecipe}=await import('./execution-preparation.mjs');
  const old=validateApprovedPreparation(jsonBytes(value.legacyPreparationBytes,'legacy preparation').value,{historical:true});
  if (old.preparationRevision!==owner.preparationRevision || old.normativeSha256!==owner.normativeSha256)
    stale('legacy operation preparation authority differs');
  const oldDelivery=old.normativeProjection.deliveries.find(item=>item.deliveryId===owner.deliveryId && item.slice===owner.slice);
  if (!oldDelivery) stale('legacy operation delivery absent');
  const recipe=parseVerificationRecipe(oldDelivery.task['Verification Recipe']);
  const declaration={authorizedAreas:oldDelivery.plan['Authorized Areas'],existingInputs:oldDelivery.plan['Existing Inputs'],verificationRecipe:recipe};
  const resolved=recipeAndClaims(context,declaration,owner.slice).resolved;
  const expected={...resolved,format:'stnl-resolved-verification-v1',recipeSha256:raw(utf8(JSON.stringify(recipe)))};
  integer(receipt.attempt,'legacy receipt attempt',1,3);str(receipt.threadId,'legacy runner id');
  if (receipt.status!=='RUNNER_RESPONSE_CAPTURED' || receipt.semanticResponseStatus!==wanted || response.status!==wanted
    || receipt.operation!==owner.operation || receipt.slice!==owner.slice
    || receipt.semanticResponseSha256!==hex(responseBytes) || receipt.error!=null || receipt.captureFailure!=null)
    incomplete('legacy receipt/status/owner differs');
  for (const [field,key] of [['Operation attempt ID','operationAttemptId'],['Origin activation ID','originActivationId'],
    ['Delivery ID','deliveryId'],['Preparation revision','preparationRevision'],['Normative sha256','normativeSha256']])
    if (importedRecordField(operationRecordUtf8,field)!==String(owner[key])) mismatch(`legacy record ${field} differs`);
  const recordCommands=importedCommandTuples(operationRecordUtf8,record.id);
  importedSemanticFields(record,response,receipt);
  let origin, dispatchId, runnerId;
  if (capture.transport === 'native') {
    origin=decode('origin');
    const dispatch=decode('dispatch'), agent=decode('agentBinding'), claim=decode('agentClaim');
    const result=decode('concludedToolResult');
    legacyOwnerEquals(origin.owner,owner,'native origin');
    legacyOwnerEquals(dispatch.owner,owner,'native dispatch');
    legacyOwnerEquals(claim.owner,owner,'native claim');
    integer(dispatch.attempt,'native dispatch attempt',1,receipt.attempt);
    token(origin.dispatchId,UUID,'native dispatch id');
    absolute(receipt.originFile,'native origin file');
    if (!legacySpecPath(context,origin.specPath) || origin.workspace !== context.productRoot
      || dispatch.specPath !== origin.specPath || dispatch.workspace !== origin.workspace
      || origin.transport !== 'native' || dispatch.transport !== 'native' || receipt.transport !== 'native'
      || !same(dispatch.verification,origin.verification)
      || receipt.workspace !== origin.workspace
      || origin.attempt !== receipt.attempt || dispatch.attempt !== (owner.recovery?.round ?? 1)
      || origin.dispatchId !== dispatch.dispatchId || result.status !== 'completed'
      || result.finalResponse !== responseBytes.toString('utf8') || agent.agentId !== receipt.threadId
      || claim.agentId !== receipt.threadId || result.agentId !== receipt.threadId
      || agent.originFile !== receipt.originFile
      || claim.originFile !== receipt.originFile
      || receipt.originFile !== path.join(path.dirname(receipt.originFile),`round-${receipt.attempt}.origin.json`)
      || receipt.receiptFile !== path.join(path.dirname(receipt.originFile),`round-${receipt.attempt}.receipt.json`)
      || receipt.semanticResponseFile !== path.join(path.dirname(receipt.originFile),`round-${receipt.attempt}.response.json`))
      mismatch('native origin/dispatch/claim/result differs');
    dispatchId=origin.dispatchId;runnerId=receipt.threadId;
  } else if (capture.transport === 'managed') {
    origin=decode('managedContext');
    const active=decode('active'), started=decode('started');
    const supervisor=decode('closedSupervisor'), latest=decode('latest');
    const events=bytes(capture.events,'managed events');
    const identity={workspace:origin.workspace,tmpdir:active.tmpdir,operation:owner.operation,
      sequence:active.sequence,slice:owner.slice};
    for (const doc of [active,supervisor,latest])
      for (const [key,expected] of Object.entries(identity)) if (doc[key] !== expected) mismatch('managed lifecycle identity');
    legacyOwnerEquals(origin.owner,owner,'managed context');
    legacyOwnerEquals(active.officialPreflight?.owner,owner,'managed preflight');
    legacyOwnerEquals(started.owner,owner,'managed start');
    integer(active.sequence,'managed sequence',1);
    absolute(active.tmpdir,'managed tmpdir');
    token(origin.expectedActivationId,UUID,'managed admitted activation');
    if (origin.expectedActivationId===owner.originActivationId) mismatch('managed admission did not advance activation');
    if (Object.hasOwn(receipt,'transport')) mismatch('managed receipt mixed transport');
    if (record.kind==='validation' ? Object.hasOwn(receipt,'automaticCheckRound')
      : receipt.automaticCheckRound!==`${receipt.attempt}/3`) mismatch('managed receipt automatic round differs');
    if (active.officialPreflight?.activationId!==owner.originActivationId)
      incomplete('managed preflight requires an unavailable intervening reopening proof');
    if (!legacySpecPath(context,origin.specPath) || origin.workspace !== context.productRoot
      || origin.operation !== owner.operation || origin.slice !== owner.slice
      || active.officialPreflight?.specPath !== origin.specPath
      || active.officialPreflight?.operation !== owner.operation || active.officialPreflight?.slice !== owner.slice
      || active.officialPreflight?.state !== origin.state
      || active.officialPreflight?.expectedActivationId !== origin.expectedActivationId
      || started.operation !== owner.operation || started.slice !== owner.slice
      || (Object.hasOwn(started,'specPath') && started.specPath !== origin.specPath)
      || origin.version !== 4 || active.protocol !== 3
      || origin.authority !== old.requirementsAuthority
      || started.authority !== origin.authority || receipt.authority !== origin.authority
      || active.officialPreflight?.authority !== origin.authority
      || active.officialPreflight?.exitCode !== 0
      || active.sequence !== started.sequence
      || active.sequence !== receipt.sequence
      || started.attempt !== receipt.attempt
      || receipt.runnerAgent !== 'stnl_validation_runner'
      || receipt.operation !== active.operation || receipt.slice !== active.slice
      || supervisor.pending !== false || supervisor.cancelledPending !== false
      || !Array.isArray(supervisor.errors) || supervisor.errors.length
      || typeof supervisor.closedAt !== 'string' || !supervisor.closedAt
      || latest.authority !== origin.authority || !same(latest.receipt,receipt)
      || receipt.exitCode !== 0 || receipt.threadId == null || (receipt.formatRepair !== null && receipt.formatRepair?.attempted !== false)
      || receipt.processError != null || receipt.providerError != null)
      incomplete('managed runner closure differs');
    integer(supervisor.capturedReceipts,'managed captured receipts',1,3);
    integer(supervisor.requestsHandled,'managed requests handled',supervisor.capturedReceipts);
    if (supervisor.capturedReceipts !== receipt.attempt-(owner.recovery?.round ?? 1)+1
      || (owner.operation==='VALIDATE_SLICE' && supervisor.capturedReceipts!==1))
      incomplete('managed captured invocation count differs');
    token(latest.requestId,UUID,'managed latest request id');
    token(latest.payloadSha256,/^[a-f0-9]{64}$/u,'managed latest payload hash');
    const stem=`${String(active.sequence).padStart(3,'0')}-${owner.operation.toLowerCase()}-${owner.slice}-attempt-${receipt.attempt}`;
    if (receipt.receiptFile!==path.join(active.tmpdir,`${stem}.receipt.json`)
      || receipt.semanticResponseFile!==path.join(active.tmpdir,`${stem}.response.json`)
      || receipt.eventsPath!==path.join(active.tmpdir,`${stem}.events.jsonl`))
      mismatch('managed receipt paths differ');
    managedEvents({events},receipt,stem,responseBytes.toString('utf8'),receipt.attempt);
    const roles={adapter:'agents/codex/runtime/validation-runner.mjs',
      bridge:'agents/codex/runtime/managed-runner-bridge.mjs',
      preflight:'agents/codex/runtime/managed-slice-preflight.mjs',
      evidenceSerializer:'skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs',
      runnerResultContract:'skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs'};
    closed(origin.identity,['snapshot',...Object.keys(roles)],'managed runtime identity');
    closed(origin.identity.snapshot,['path','mode'],'managed snapshot identity');
    absolute(origin.identity.snapshot.path,'managed snapshot path');
    token(origin.identity.snapshot.mode,/^[0-7]{3,4}$/u,'managed snapshot mode');
    const declared=[];
    for (const [role,relativePath] of Object.entries(roles)) {
      const identity=closed(origin.identity[role],['path','sha256','mode'],`managed ${role}`);
      if (identity.path!==path.join(origin.identity.snapshot.path,relativePath)) stale(`managed ${role} path`);
      token(identity.sha256,HASH,`managed ${role} hash`);
      token(identity.mode,/^[0-7]{3,4}$/u,`managed ${role} mode`);
      if (role==='adapter' && !(parseInt(identity.mode,8)&0o111)) stale('managed adapter is not executable');
      declared.push(identity.sha256);
    }
    const actual=dense(capture.runtimeIdentity,'managed runtime bytes').map(value=>raw(bytes(value,'runtime identity')));
    if (!same([...new Set(declared)].sort(ordinal),actual)
      || !same([...new Set(actual)].sort(ordinal),actual)) incomplete('managed runtime identity closure differs');
    dispatchId=`${owner.operationAttemptId}:${active.sequence}`;runnerId=receipt.threadId;
  } else fail('UNSUPPORTED_FORMAT','imported transport');

  const mechanicalCommands=record.kind==='validation'?recordCommands.slice(1):recordCommands;
  if (record.kind==='validation') {
    const first=recordCommands[0];
    const prefix=/^node "([^"\r\n]+)" "([^"\r\n]+)" VALIDATE_SLICE ([1-9][0-9]*)$/u.exec(first.command);
    const suffix='skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs';
    if (!prefix || first.exit!==0 || prefix[2]!==origin.specPath || prefix[3]!==String(Number(owner.slice.slice(6)))
      || !path.isAbsolute(prefix[1]) || path.normalize(prefix[1])!==prefix[1] || !prefix[1].endsWith(`/${suffix}`)
      || (capture.transport==='managed' && prefix[1]!==path.join(origin.identity.snapshot.path,suffix)))
      incomplete('formal launcher preflight command differs');
  }
  if (!same(response.commands,mechanicalCommands)) incomplete('legacy record and response commands differ');
  importedTerminal(publication,owner,capture.workManifest,context);
  const terminal=publication.expectedInstalledActivation;
  if (terminal.format!=='stnl-execution-activation-v1' || terminal.preparationRevision!==old.preparationRevision
    || terminal.normativeSha256!==old.normativeSha256 || terminal.requirementsAuthority!==old.requirementsAuthority
    || terminal.approvedSnapshotSha256!==raw(bytes(value.legacyPreparationBytes,'legacy preparation')))
    incomplete('terminal publication preparation differs');
  legacyManifestFacts(manifest,owner,old.requirementsAuthority,context,capture,publication);
  const domain=recipeAndClaims(context,declaration,owner.slice);
  conversionDomain(manifest.entries,[...domain.areas,...domain.inputs],'legacy tested domain',{legacy:true});
  if (observation.format!=='stnl-runner-verification-v1' || observation.status!=='completed'
    || !same(observation.verification,expected) || !same(receipt.verification,observation)
    || (capture.transport==='native' && !same(origin.verification,expected))
    || observation.workStateSha256!==raw(utf8(JSON.stringify(manifest.entries.map(({path,kind,sha256})=>({path,kind,sha256})))))
    || !Array.isArray(observation.checks) || observation.checks.length!==recipe.checks.length
    || !same(mechanicalCommands,observation.checks.map(({command,exit})=>({command,exit}))))
    incomplete('legacy verification is not a complete observation of the tested preimage');
  for (const [index,check] of observation.checks.entries()) {
    if (!same(check.request,expected.checks[index]) || check.command!==commandFor(expected.checks[index])
      || typeof check.stdout!=='string' || typeof check.stderr!=='string'
      || check.stdoutSha256!==raw(utf8(check.stdout)) || check.stderrSha256!==raw(utf8(check.stderr))
      || !Number.isSafeInteger(check.exit) || check.exit!==0) incomplete('legacy check differs');
  }
  return {owner,receipt,response,manifest,publication,old,oldDelivery,recipe,dispatchId,runnerId};
}

function importedCapture(record,objects) {
  const source=record.sources;
  const get=(id,label)=>{importedObject(objects,id,label);return bytes(objects.get(id),label);};
  const common={transport:source.transport,receipt:get(source.receipt,'receipt'),rawResponse:get(source.rawResponse,'response'),
    verificationObservation:get(source.verificationObservation,'observation'),retainedFiles:[]};
  if (source.transport==='native') {
    const cap=importedCapsule(objects,source.origin,'stnl-native-imported-origin-bundle-v1',
      ['originUtf8','dispatchUtf8','workManifestUtf8','publicationUtf8'],'native origin');
    const agent=importedCapsule(objects,source.agentBinding,'stnl-native-agent-bundle-v1',['agentUtf8','claimUtf8'],'native agent');
    return {...common,origin:cap.originUtf8,dispatch:cap.dispatchUtf8,workManifest:cap.workManifestUtf8,publication:cap.publicationUtf8,
      agentBinding:agent.agentUtf8,agentClaim:agent.claimUtf8,concludedToolResult:get(source.concludedToolResult,'native result')};
  }
  const cap=importedCapsule(objects,source.started,'stnl-managed-imported-start-bundle-v1',
    ['contextUtf8','activeUtf8','startedUtf8','workManifestUtf8','publicationUtf8'],'managed start');
  const close=importedCapsule(objects,source.closedSupervisor,'stnl-managed-close-bundle-v1',['supervisorUtf8','latestUtf8'],'managed close');
  const events=bytes(objects.get(source.events),'managed events');
  if (raw(events)!==source.events) incomplete('managed event bytes');
  return {...common,managedContext:cap.contextUtf8,active:cap.activeUtf8,started:cap.startedUtf8,
    workManifest:cap.workManifestUtf8,publication:cap.publicationUtf8,closedSupervisor:close.supervisorUtf8,latest:close.latestUtf8,
    events,runtimeIdentity:source.runtimeIdentity.map(id=>{
      const value=bytes(objects.get(id),'runtime identity');if(raw(value)!==id) incomplete('runtime identity hash');return value;
    })};
}

export async function verifyImportedEvidence(value) {
  closed(value,['context','record','objects','approvedAuthority','observedWork'],'imported proof input');
  const {context,record,objects,approvedAuthority}=value;
  logicalArtifactPath(context,`tasks/${record.origin?.slice}.md`);
  if (/^### ([a-z-]+-[0-9]{2,})\n/u.exec(record.recordUtf8)?.[1]!==record.id) incomplete('imported record ID differs from raw heading');
  if (record.recordFormat!=='stnl-task-record-v1-imported' || record.origin.localRevision!==null
    || !['implementation-check','validation'].includes(record.kind)
    || record.origin.operation!==(record.kind==='validation'?'VALIDATE_SLICE':'EXECUTE_SLICE'))
    incomplete('imported record provenance/operation differs');
  const global=approvedAuthority.snapshot.normativeProjection.global;
  const currentContext={requirementsAuthority:approvedAuthority.snapshot.requirementsAuthority,
    objective:global.objective,strategy:global.strategy,risks:global.risks};
  if (!same(record.contract.delivery,approvedAuthority.delivery) || !same(record.contract.context,currentContext)
    || record.contract.terminal!==null || !same(record.contract.recipe,approvedAuthority.delivery.verificationRecipe))
    stale('imported local contract differs from approved preparation');
  importedObject(objects,record.sources.legacyPreparation,'legacy preparation');
  const facts=await verifyLegacyOperationFacts({context,legacyPreparationBytes:objects.get(record.sources.legacyPreparation),
    operationRecordUtf8:record.recordUtf8,capture:importedCapture(record,objects)});
  importedOwner(facts.owner,record,'imported owner');
  if (facts.dispatchId!==record.origin.dispatchId || facts.runnerId!==record.origin.runnerId)
    mismatch('imported dispatch/runner identity differs');
  if (facts.old.requirementsAuthority!==approvedAuthority.snapshot.requirementsAuthority
    || !same(facts.recipe,record.contract.recipe)) stale('imported preparation/recipe authority differs');
  importedPreparationEquivalent(facts.old,facts.oldDelivery,approvedAuthority);
  const tested=importedManifest(facts.manifest,record,context);
  if (!same(tested,record.testedWork)) incomplete('imported file-free testedWork differs');
  if (record.kind==='implementation-check') importedTestedState(record,tested);
  const {receipt}=facts;
  if (receipt.testedState?.entries?.some(entry=>entry.kind==='absent' && entry.expected==='REMOVED')
    || record.sources.removalProofs.length) incomplete('legacy removal needs unavailable original mode');
  if (record.kind==='implementation-check' && (!same(receipt.testedState?.entries,[])
    || receipt.testedState.workspace!==context.productRoot
    || receipt.testedState.sourceTaskPath!==path.join(context.logicalExecutionRoot,`tasks/${record.origin.slice}.md`)))
    incomplete('fileless captured Tested state is not bound to official task');
  return {testedWork:tested,receipt,operationAttemptId:record.origin.operationAttemptId};
}

// The conversion consumer is deliberately separate from the ordinary current
// evidence reader. It receives a sealed candidate and an observed product
// image, never a locator or a historical source resolver.
function conversionFiles(value) {
  if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length)
    invalid('conversion files: ordinary Map required');
  const copy = new Map();
  for (const [name, valueBytes] of Map.prototype.entries.call(value)) {
    str(name, 'conversion path');
    copy.set(name, bytes(valueBytes, `conversion ${name}`));
  }
  return copy;
}

function conversionSections(text, label) {
  const sections = new Map();
  const markers = [...text.matchAll(/^## ([^\n]+)\n\n/gmu)];
  for (let i = 0; i < markers.length; i += 1) {
    const name = markers[i][1];
    if (sections.has(name)) invalid(`${label}: duplicate section ${name}`);
    sections.set(name, text.slice(markers[i].index + markers[i][0].length, markers[i + 1]?.index).trim());
  }
  return sections;
}

function convertedTaskCarriers(snapshot, item, current) {
  const task = `tasks/${item.slice}.md`;
  const entry = snapshot.reviewedArtifacts.find(artifact => artifact.path === task);
  if (!entry) invalid(`${task}: reviewed task absent`);
  const text = entry.utf8;
  const carrier = conversionSections(text, task);
  const expectedValidation = current.validation;
  const expectedEvidence = current.evidence ? current.evidence.sha256 : 'none';
  if (carrier.get('Continuity') !== `- Current validation: ${expectedValidation}\n- Current evidence: ${expectedEvidence}\n- Current action: ${current.validation === 'unvalidated' ? 'implement approved delivery' : current.validation === 'current' ? 'none' : 'validate'}`)
    invalid(`${task}: continuity carrier differs`);
  for (const name of ['Divergences', 'Delegation Blocker', 'Validation Findings',
    'Scope Expansion', 'Prior Validation Overlap', 'Findings Test Evidence', 'Corrections Applied'])
    if (carrier.get(name) !== '- none') incomplete(`${task}: active or ambiguous ${name}`);
  if (carrier.get('Operational Changes') !== '- none') incomplete(`${task}: active operational change`);
  if (current.evidence === null) {
    for (const name of ['Implementation Test Evidence', 'Validation Attempts', 'Effective Validation Base'])
      if (carrier.get(name) !== '- none') incomplete(`${task}: evidence-free candidate has ${name}`);
    if (carrier.get('Final Result') !== '- pending') invalid(`${task}: no current formal result`);
    if (!['- pending','- none'].includes(carrier.get('Changed Areas'))
      || carrier.get('Diff Summary') !== '- pending') incomplete(`${task}: unsupported evidence-free scope`);
  } else if (carrier.get('Changed Areas') !== '- none'
    || carrier.get('Diff Summary') === '- pending') incomplete(`${task}: unsupported imported scope`);
  if (current.validation === 'unvalidated'
    && (!/^- \[ \] /mu.test(carrier.get('Checklist') ?? '')
      || /^- \[x\] /mu.test(carrier.get('Checklist') ?? '')))
    incomplete(`${task}: unvalidated checklist is not pristine`);
  if (current.evidence !== null && /^- \[ \] /mu.test(carrier.get('Checklist') ?? ''))
    incomplete(`${task}: imported PASS retains an incomplete checklist`);
  return carrier;
}

function convertedIndex(snapshot, continuity) {
  const entry=snapshot.reviewedArtifacts.find(item=>item.path==='tasks.md');
  if (!entry || snapshot.globalReview.evidenceDecisions.length) invalid('converted global review/index differs');
  const rows=entry.utf8.split('\n').filter(line=>/^\| \[[ x]\] \|/u.test(line));
  if (rows.length!==continuity.deliveries.length) invalid('converted Tasks row count');
  for (const [index,current] of continuity.deliveries.entries()) {
    const columns=rows[index].slice(1,-1).split('|').map(item=>item.trim());
    if (columns.length!==7 || columns[1].split(' - ')[0]!==current.slice.slice(6)
      || columns[4]!==`tasks/${current.slice}.md`
      || columns[5]!==current.validation
      || columns[6]!==(current.evidence ? 'PASS':'pending')
      || columns[0]!== (current.evidence ? '[x]':'[ ]'))
      invalid(`${current.slice}: Tasks row/continuity differs`);
  }
}

function counterIds(current, bundle) {
  const values = [
    ['implementationChecks', bundle.implementation, 'implementation-check-'],
    ['findingsChecks', bundle.findingsChecks, 'findings-check-'],
    ['validationAttempts', bundle.validation ? [bundle.validation] : [], 'attempt-'],
  ];
  for (const [key, records, prefix] of values) for (const record of records) {
    const id = Number(record.id.slice(prefix.length));
    if (!Number.isSafeInteger(id) || id < 1 || id > current.counters[key]) invalid(`${current.slice}: record exceeds ${key}`);
  }
  if (bundle.validation) {
    const references=importedRecordField(bundle.validation.recordUtf8,'Finding references');
    for (const identifier of references==='none'?[]:references.split(', ')) {
      const match=/^finding-([0-9]{2,})$/u.exec(identifier),id=Number(match?.[1]);
      if (!match || !Number.isSafeInteger(id) || id<1 || String(id).padStart(2,'0')!==match[1]
        || id>current.counters.findings) invalid(`${current.slice}: record exceeds findings`);
    }
  }

}

export async function inspectConvertedDelivery({context,snapshot,current,bundleBytes,observedWork}) {
  const i=snapshot.deliveries.findIndex(item=>item.deliveryId===current.deliveryId && item.slice===current.slice);
  if(i<0) invalid('converted delivery is absent from approved preparation');
  const item=snapshot.deliveries[i];
  if((current.evidence===null)!==(bundleBytes===null)
    || (bundleBytes!==null && raw(bytes(bundleBytes,'converted bundle'))!==current.evidence.sha256))
    invalid(`${current.slice}: converted evidence bytes differ`);
  const leaf=snapshot.normativeProjection.deliveries[i];
  const domainDeliveries=[{slice:item.slice,deliveryId:leaf.deliveryId,authorizedAreas:leaf.authorizedAreas,
    existingInputs:leaf.existingInputs,verificationRecipe:leaf.verificationRecipe}];
  const observedByDelivery=projectConversionObservedWork({context,deliveries:domainDeliveries,observedWork});
    const carrier = convertedTaskCarriers(snapshot,item,current);
    if (current.normalization !== null) incomplete(`${current.slice}: open normalization`);
    const baseline=projectConversionObservedWork({context:context,deliveries:[domainDeliveries[0]],observedWork:current.baseline}).get(current.deliveryId);
    const matches = same(baseline,observedByDelivery.get(current.deliveryId));
    const decisions = item.review.evidenceDecisions;
    if (current.evidence === null && decisions.length) invalid(`${current.slice}: evidence decision without bundle`);
    let cycle = null, consumption, requiresFormalRevalidation = false;
    if (current.evidence === null) {
      const zero = Object.values(current.counters).every(number => number === 0);
      if (current.validation === 'unvalidated' && zero && current.lastDiagnostic === null) {
        if (carrier.get('Changed Areas') !== '- pending') incomplete(`${current.slice}: S0 changed-area carrier`);
        consumption = {kind:'none-observed',consumedInvocations:0,remainingInvocations:null,resumable:false};
        requiresFormalRevalidation = !matches;
      } else if (current.validation === 'revalidation-required' && current.counters.validationAttempts > 0
        && current.lastDiagnostic?.code === 'EVIDENCE_INCOMPLETE'
        && current.lastDiagnostic.nextAction === 'validate'
        && current.lastDiagnostic.operationAttemptId !== null) {
        if (carrier.get('Changed Areas') !== '- pending') incomplete(`${current.slice}: S2 changed-area carrier`);
        consumption = {kind:'closed-boundary-not-resumable',consumedInvocations:null,remainingInvocations:null,resumable:false};
        requiresFormalRevalidation = true;
      } else incomplete(`${current.slice}: unsupported evidence-free conversion state`);
    } else {
      const bundle = parseCurrentJson(textBytes(bundleBytes, current.evidence.path).text);
      if (bundle.openFindings.length || bundle.openDivergences.length || bundle.support.length)
        incomplete(`${current.slice}: open evidence episode`);
      if (current.validation !== 'current' && current.validation !== 'revalidation-required')
        invalid(`${current.slice}: evidence validation state`);
      if (decisions.length !== 1 || decisions[0].deliveryId !== current.deliveryId
        || decisions[0].evidenceSha256 !== current.evidence.sha256
        || decisions[0].disposition !== (current.validation === 'current' ? 'retain-current' : 'revalidate'))
        invalid(`${current.slice}: evidence review disposition`);
      if (!bundle.validation || bundle.validation.recordFormat !== 'stnl-task-record-v1-imported'
        || bundle.implementation.some(record => record.recordFormat !== 'stnl-task-record-v1-imported')
        || bundle.findingsChecks.length) incomplete(`${current.slice}: imported closed PASS cycle required`);
      counterIds(current,bundle);
      if (current.lastDiagnostic !== null) incomplete(`${current.slice}: imported cycle has a diagnostic`);
      for (const [section,records] of [
        ['Implementation Test Evidence',bundle.implementation],['Validation Attempts',[bundle.validation]],
      ]) {
        const body=carrier.get(section);
        const parts=body === '- none' ? [] : body.split(/(?=^### [a-z-]+-[0-9]{2,}$)/mu).filter(part => part.trim());
        if (!same(parts.map(part => part.trim()),records.map(record => record.recordUtf8.trim())))
          incomplete(`${current.slice}: ${section} differs from imported records`);
      }
      const objects = new Map(bundle.objects.map(object => [object.id,Buffer.from(object.bytesBase64,'base64')]));
      const approvedAuthority = {snapshot,delivery:snapshot.normativeProjection.deliveries[i]};
      let formalTestedWork = null;
      for (const record of [...bundle.implementation,bundle.validation]) {
        const verified = await verifyImportedEvidence({context:context,record,objects,approvedAuthority,
          observedWork:observedWork});
        if (record === bundle.validation) formalTestedWork = verified.testedWork;
      }
      if (current.validation === 'current' && !same(formalTestedWork,current.baseline))
        stale(`${current.slice}: imported formal tested work differs from current baseline`);
      const formal = bundle.validation;
      importedEffectiveBase(carrier,formal,formalTestedWork);
      const formalSource = parseCurrentJson(textBytes(objects.get(formal.sources.receipt),'formal receipt').text);
      const lastOperationAttemptId = formal.origin.operationAttemptId;
      if (formalSource.owner?.operationAttemptId !== lastOperationAttemptId
        || formalSource.status !== 'RUNNER_RESPONSE_CAPTURED' || formalSource.semanticResponseStatus !== 'PASS')
        incomplete(`${current.slice}: formal receipt does not close PASS`);
      cycle = {implementation:bundle.implementation.map(record => record.id),findings:[],validation:formal.id,state:'closed'};
      consumption = {kind:'closed-formal-boundary',lastOperationAttemptId,operation:'VALIDATE_SLICE',
        consumedInvocations:1,remainingInvocations:null,resumable:false};
      requiresFormalRevalidation = current.validation === 'revalidation-required' || !matches;
      if (carrier.get('Final Result') !== '- PASS') invalid(`${current.slice}: formal carrier differs`);
    }
    return {slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
      counterAuthority:'persisted-continuity',persistedValidation:current.validation,
      observedValidation:requiresFormalRevalidation || !matches ? 'revalidation-required' : current.validation,
      evidenceSha256:current.evidence?.sha256 ?? null,baseline:current.baseline,observationMatches:matches,
      openFindings:[],openDivergences:[],cycle,consumption,
      diagnostics:current.lastDiagnostic ? [current.lastDiagnostic] : [],requiresFormalRevalidation};
}

export async function inspectConvertedExecution(value) {
  closed(value, ['context', 'requirementsAuthority', 'files', 'observedWork'], 'conversion inspection input');
  token(value.requirementsAuthority, HASH, 'requirementsAuthority');
  logicalArtifactPath(value.context, 'plan.md');
  const files = conversionFiles(value.files);
  const {snapshot, continuity} = validateCurrentCandidate({files});
  if (snapshot.requirementsAuthority !== value.requirementsAuthority) fail('REQUIREMENTS_CHANGED', 'conversion authority differs');
  const {validateConversionApprovedPreparation} = await import('./execution-preparation-current.mjs');
  const artifacts = new Map([...files].filter(([name]) => name !== 'approved-preparation.json'));
  const preparation = validateConversionApprovedPreparation({context:value.context,
    requirementsAuthority:value.requirementsAuthority,snapshotBytes:files.get('approved-preparation.json'),artifacts});
  if (preparation.authority.normativeSha256 !== snapshot.normativeSha256) invalid('conversion projection differs');
  convertedIndex(snapshot,continuity);
  const domains=snapshot.normativeProjection.deliveries.map((item,index)=>({slice:snapshot.deliveries[index].slice,deliveryId:item.deliveryId,
    authorizedAreas:item.authorizedAreas,existingInputs:item.existingInputs,
    verificationRecipe:item.verificationRecipe}));
  const scoped=projectConversionObservedWork({context:value.context,deliveries:domains,
    observedWork:value.observedWork});
  const deliveries=[];
  for(const current of continuity.deliveries)
    deliveries.push(await inspectConvertedDelivery({context:value.context,snapshot,current,
      bundleBytes:current.evidence?files.get(current.evidence.path):null,
      observedWork:scoped.get(current.deliveryId)}));
  return {authority:preparation.authority,deliveries,admissibleOperations:[]};
}
