import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCurrentJson, resolveLogicalProductClaim, logicalArtifactPath, validateCurrentCandidate } from './execution-current.mjs';
import {RunnerSemanticResultError} from './runner-result-contract.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
export const NATIVE_JUDGMENT_VARIANT = 'stnl-current-native-judgment-v1';
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
  if (value && typeof value === 'object' && !Object.hasOwn(value, 'localRevision') && (value.imported === true || value.operationAttemptId)) fail('UNSUPPORTED_FORMAT', `${label}: old owner lacks local revision`);
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
function conversionDomain(entries,claims,label) {
  const byPath=new Map(entries.map(entry=>[entry.path,entry]));
  const included=name=>claims.some(item=>item.path===name || item.kind==='directory' && name.startsWith(`${item.path}/`));
  for (const item of claims) {
    const entry=byPath.get(item.path);
    if (!entry) {
      if (item.kind!=='input' && observedAbsent(byPath,item.path)) continue;
      incomplete(`${label}: missing declared ${item.path}`);
    }
    if (item.kind==='input' && entry.kind!=='file' || item.kind==='directory' && entry.kind==='file'
      || item.kind==='file' && entry.kind==='directory') stale(`${label}: declared kind differs ${item.path}`);
  }
  for (const entry of entries) {
    if (!included(entry.path)) incomplete(`${label}: unexpected domain member ${entry.path}`);
    // Separate declared roots can repeat an absence already proved by the
    // union. Present descendants still pass every parent/child check below.
    if (entry.kind==='absent' && observedAbsent(byPath,entry.path)) continue;
    const parts=entry.path.split('/');
    for (let index=1;index<parts.length;index+=1) {
      const name=parts.slice(0,index).join('/'),parent=byPath.get(name);
      // Only ancestors inside an approved directory need an observation.
      if (!parent && !included(name)) continue;
      if (!parent || parent.kind!=='directory' ||
        parent.children.includes(parts[index]) === (index===parts.length-1 && entry.kind==='absent'))
        incomplete(`${label}: missing parent/child closure ${entry.path}`);
    }
    if (entry.kind==='directory') for (const child of entry.children) {
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
  if (value.format === 'stnl-runner-verification-v1') fail('UNSUPPORTED_FORMAT', `${label}: observation v1 lacks WorkManifest preimage`);
  const divergence=value.format==='stnl-runner-verification-divergence-v1';
  if (!['stnl-runner-verification-v2','stnl-runner-verification-v3','stnl-runner-verification-divergence-v1'].includes(value.format))
    fail('UNSUPPORTED_FORMAT', `${label}: observation format`);
  closed(value, ['format', 'status', 'owner', 'round', 'recipe', 'resolved', 'before', 'after', 'checks',
    ...(value.format==='stnl-runner-verification-v3'?['binding']:[])], label);
  if(value.format==='stnl-runner-verification-v3') {
    closed(value.binding,['head','requestSha256','dispatchId','agentId',
      ...(Object.hasOwn(value.binding,'continuationSha256')?['continuationSha256']:[])],`${label}.binding`);
    if(value.binding.continuationSha256!==undefined)token(value.binding.continuationSha256,HASH,`${label}.continuationSha256`);
    token(value.binding.head,/^[a-f0-9]{40}$/u,`${label}.binding.head`);
    token(value.binding.requestSha256,HASH,`${label}.binding.requestSha256`);
    str(value.binding.dispatchId,`${label}.binding.dispatchId`);
    str(value.binding.agentId,`${label}.binding.agentId`);
  }
  if (value.status !== (divergence?'stale':'completed')) uncertain(`${label}: verification not completed`);
  ownerMatches(value.owner, owner, `${label}.owner`);
  if (value.round !== round) mismatch(`${label}: round differs`);
  expectEqual(value.recipe, recipeInfo.recipe, 'EVIDENCE_STALE', `${label}.recipe`);
  expectEqual(value.resolved, recipeInfo.resolved, 'EVIDENCE_STALE', `${label}.resolved`);
  if(!divergence)expectEqual(value.before, value.after, 'EVIDENCE_STALE', `${label}: product changed during checks`);
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
  if(transport!=='native'||value.transport!=='native')fail('UNSUPPORTED_FORMAT',`${label}: native transport required`);
  closed(value, [...common, ...native,
    ...(profile === 'current-validation' ? ['validationRequest'] : profile === 'current-findings' ? ['applyRequest'] : [])], label);
  if (value.transport !== transport) invalid(`${label}: mixed transports`);
  dense(value.removalProofs, `${label}.removalProofs`);
  for (const key of [...common, ...native]) {
    if (key === 'transport' || key === 'removalProofs' || key === 'runtimeIdentity' || (key === 'verificationObservation' && value[key] === null)) continue;
    bytes(value[key], `${label}.${key}`);
  }
  if (profile === 'current-validation') bytes(value.validationRequest, `${label}.validationRequest`);
  if (profile === 'current-findings') bytes(value.applyRequest, `${label}.applyRequest`);
  for (const item of value.removalProofs) bytes(item, `${label}.removalProof`);
}
function body(value, key, label) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) incomplete(`${label}: missing ${key}`);
  return value[key];
}
// A controller-issued pre-verification concession is evidence, never a verdict.
// Both the live producer and historical reader use this one binding validator.
export const nativeContinuationSha256=value=>raw(serialized(value));
export function validateNativeContinuation(value,{origin,originBytes,agentId,claim}) {
  closed(value,['format','id','owner','operationId','dispatchId','round','binding','firstTurnId',
    'firstToolResultUtf8','firstToolResultSha256','originSha256','workStateSha256'],'native continuation');
  if(value.format!=='stnl-native-pre-verification-continuation-v1')invalid('native continuation format');
  str(value.id,'continuation id');str(value.firstTurnId,'continuation turn');
  closed(value.binding,['parentThreadId','parentTurnId','agentPath','agentThreadId','model','effort'],'continuation public binding');
  for(const v of Object.values(value.binding))str(v,'continuation public identity');
  ownerMatches(value.owner,origin.owner,'continuation owner');
  if(value.operationId!==origin.admission.binding.operationId||value.dispatchId!==origin.dispatchId
    ||value.round!==origin.attempt||value.binding.agentPath!==agentId
    ||value.originSha256!==raw(originBytes)||value.workStateSha256!==claim.boundWorkSha256)
    mismatch('native continuation source binding differs');
  token(value.workStateSha256,HASH,'continuation work state');
  const original=utf8(value.firstToolResultUtf8);
  if(value.firstToolResultSha256!==raw(original))incomplete('native continuation original bytes differ');
  const tool=jsonBytes(original,'continuation first result').value;
  closed(tool,['agentId','status','finalResponse'],'continuation first result');
  if(tool.agentId!==agentId||tool.status!=='completed'||typeof tool.finalResponse!=='string'||!tool.finalResponse.length)
    uncertain('native continuation first result did not conclude');
  return value;
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
  if (origin.responseVariant!==undefined && origin.responseVariant!==NATIVE_JUDGMENT_VARIANT)
    fail('UNSUPPORTED_FORMAT',`round ${round}: native response variant`);
  if (origin.responseVariant===NATIVE_JUDGMENT_VARIANT) token(origin.requestSha256,HASH,`round ${round}: native request digest`);
  else if (origin.requestSha256!==undefined) invalid(`round ${round}: legacy origin carries native request digest`);
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
  const continued=result.preVerificationContinuation;
  const observed=cap.verificationObservation===null?null:jsonBytes(cap.verificationObservation,'native continuation observation').value;
  if(continued!==undefined) {
    validateNativeContinuation(continued,{origin,originBytes:cap.origin,agentId:agent.agentId,claim:agentClaim});
    if(observed?.binding?.continuationSha256!==nativeContinuationSha256(continued))mismatch('native continuation observation differs');
  } else if(observed?.binding?.continuationSha256!==undefined)incomplete('native continuation source absent');
  if (receipt.operation !== owner.operation || receipt.slice !== owner.slice || receipt.workspace !== origin.workspace) mismatch(`round ${round}: receipt owner differs`);
  if (receipt.error !== null) uncertain(`round ${round}: native receipt error`);
  return { dispatchId:origin.dispatchId, runnerId:agent.agentId, receipt, root,
    producerTurns:continued===undefined?1:2 };
}

// The projection is transient. It is never written as the concluded response or
// used until the caller has verified the original native invocation and recipe.
export function projectNativeJudgment({origin,observation,requestBytes=null,agentId,rawText,operation}) {
  if(origin.responseVariant!==NATIVE_JUDGMENT_VARIANT) {
    if(origin.responseVariant!==undefined) fail('UNSUPPORTED_FORMAT','native response variant differs');
    return rawText;
  }
  if(observation.format!=='stnl-runner-verification-v3' || !same(observation.owner,origin.owner)
    || observation.round!==origin.attempt || observation.binding?.dispatchId!==origin.dispatchId
    || observation.binding?.agentId!==agentId
    || observation.binding?.requestSha256!==origin.requestSha256
    || requestBytes!==null && observation.binding.requestSha256!==raw(bytes(requestBytes,'native request bytes')))
    stale('native judgment binding differs from origin, request or observation');
  token(observation.binding.head,/^[a-f0-9]{40}$/u,'native judgment HEAD');
  let answer;
  try {answer=parseCurrentJson(rawText);}
  catch(error) {throw new RunnerSemanticResultError(operation,error);}
  const foreignMetadata=answer && typeof answer==='object' && (Object.hasOwn(answer,'head')||Object.hasOwn(answer,'requestSha256')
    || answer.result&&typeof answer.result==='object'
      && (Object.hasOwn(answer.result,'head')||Object.hasOwn(answer.result,'requestSha256')));
  if(operation!=='VALIDATE_SLICE') {
    if(foreignMetadata)invalid('native judgment contains foreign metadata');
    if(answer?.format!==undefined&&answer.format!==NATIVE_JUDGMENT_VARIANT)
      fail('UNSUPPORTED_FORMAT','native judgment response format');
  }
  try {
  if(foreignMetadata)
    invalid('native judgment contains foreign metadata');
  if(answer?.format!==undefined&&answer.format!==NATIVE_JUDGMENT_VARIANT)
    fail('UNSUPPORTED_FORMAT','native judgment response format');
    closed(answer,['format','result',...(operation==='VALIDATE_SLICE'?['newFindings']:[])],'native judgment response');
    if(answer.format!==NATIVE_JUDGMENT_VARIANT) fail('UNSUPPORTED_FORMAT','native judgment response format');
    plain(answer.result,'native judgment result');
  } catch(error) {throw new RunnerSemanticResultError(operation,error);}
  const {status,...semantic}=answer.result;
  const result={status,head:observation.binding.head,...semantic};
  if(operation==='EXECUTE_SLICE') return JSON.stringify(result);
  return JSON.stringify({format:operation==='VALIDATE_SLICE'
    ?'stnl-current-validation-response-v1':'stnl-current-findings-response-v1',
    requestSha256:observation.binding.requestSha256,result,
    ...(operation==='VALIDATE_SLICE'?{newFindings:answer.newFindings}:{})});
}
function areaContains(areas, name) {
  return areas.some(item => item.path === name || (item.kind === 'directory' && name.startsWith(`${item.path}/`)));
}
// Missing forecasts are not removals. Retain absent leaves only when an earlier
// scope or a real removal witness proves that the output actually existed.
export function currentOutputPaths(manifest,areas,removedPaths=[]) {
  const removed=new Set(removedPaths);
  return manifest.entries.filter(entry=>areaContains(areas,entry.path)
    && (entry.kind==='file'||entry.kind==='absent'&&removed.has(entry.path)))
    .map(entry=>entry.path).sort(ordinal);
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
  if(cap.transport!=='native')fail('UNSUPPORTED_FORMAT','capture sources require native transport');
  const base = {
    transport:cap.transport, rawResponse:store.add(cap.rawResponse), receipt:store.add(cap.receipt),
    verificationObservation:cap.verificationObservation === null ? null : store.add(cap.verificationObservation),
    removalProofs:cap.removalProofs.map(item => store.add(item)).sort(ordinal), legacyPreparation:null,
  };
  if (new Set(base.removalProofs).size !== base.removalProofs.length) invalid('duplicate removal proof bytes');
  return {
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
}
function restoreCapsule(objects, id, format, keys, label) {
  const data = objects.get(id);
  if (!data) incomplete(`${label}: missing capsule`);
  const parsed = jsonBytes(data, label).value;
  const versionedCapsule = format.includes('-validation-') || format.includes('-findings-');
  if (!versionedCapsule) closed(parsed, ['format', ...keys], label);
  else plain(parsed,label);
  if (parsed.format !== format) fail(
    versionedCapsule && parsed.format==='stnl-native-origin-bundle-v1'
      ? 'UNSUPPORTED_FORMAT' : 'UNSUPPORTED_FORMAT', `${label}: capsule format`);
  if (versionedCapsule) closed(parsed, ['format', ...keys], label);
  const restored = {};
  for (const key of keys) restored[key] = utf8(str(parsed[key], `${label}.${key}`, false));
  return restored;
}
function restoreSources(record, objects, profile) {
  const sources = record.sources;
  if(sources.transport!=='native')fail('UNSUPPORTED_FORMAT','persisted capture sources require native transport');
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
}

// The two closed profiles share source and transport checks, with distinct formal
// invocation rules. No caller supplies a verifier or bypass flag.
export function verifyCapturedInvocation(profile, cap, receipt, rawText, expectation, round, resolved) {
  if (!['initial-implementation', 'current-validation', 'current-findings'].includes(profile)) invalid('capture profile');
  plain(cap,`round ${round} capture`);
  const transport = receipt === undefined && profile !== 'current-validation' ? resolved : cap.transport;
  if (transport!=='native') fail('UNSUPPORTED_FORMAT', 'capture transport');
  captureShape(cap, transport, `round ${round}`, profile);
  if (receipt === undefined) return;
  const verifiedResolved = profile === 'current-validation'
    ? recipeAndClaims(expectation.context, expectation.authority.delivery, expectation.owner.slice).resolved : resolved;
  return nativeOrigin(cap,receipt,rawText,expectation,round,verifiedResolved);
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
    const judgment=jsonBytes(capture.origin,'validation scope origin').value.responseVariant===NATIVE_JUDGMENT_VARIANT;
    const scopePaths = [...new Set([
      ...priorScopePaths.filter(name => byPath.get(name)?.kind !== 'directory'),
      ...removalScopePaths.filter(name => byPath.get(name)?.kind === 'absent'),
      ...(judgment?currentOutputPaths(observedManifest,info.areas,removalScopePaths)
        :[...observedManifest.entries.filter(entry=>['file','absent'].includes(entry.kind)&&areaContains(info.areas,entry.path)).map(entry=>entry.path),
          ...info.refs.filter(ref=>ref.kind==='product').map(ref=>ref.path)]),
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
export function validateRemovalPreimage(blob,{owner,round,prior}) {
  const proof=jsonBytes(blob,'removal preimage').value;
    closed(proof, ['format','owner','round','path','sha256','mode','bytesBase64'], `round ${round} removal proof`);
    if (proof.format !== 'stnl-current-removal-proof-v1') fail('CURRENT_FORMAT_REQUIRED', 'removal proof format');
    ownerMatches(proof.owner, owner, `round ${round} removal owner`);
    if (proof.round !== round) mismatch(`round ${round}: removal round`);
    relative(proof.path, `round ${round} removal path`);
    if (proof.round !== round || !prior || prior.kind !== 'file' || proof.path !== prior.path
      || prior.sha256 !== proof.sha256 || prior.mode !== proof.mode) incomplete(`round ${round}: removal preimage differs`);
    if (typeof proof.bytesBase64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(proof.bytesBase64)) incomplete(`round ${round}: removal base64`);
    const product = Buffer.from(proof.bytesBase64, 'base64');
    if (product.toString('base64') !== proof.bytesBase64 || raw(product) !== prior.sha256) incomplete(`round ${round}: removal bytes differ`);
  return proof;
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
    validateRemovalPreimage(blob,{owner,round,prior:old.get(proof.path)});
    if(next.get(proof.path)?.kind!=='absent')incomplete(`round ${round}: removal output differs`);
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
  const requestScopePaths=[...new Set([...input.priorScopePaths,...input.previousScopePaths,
    ...currentOutputPaths(before,info.areas,input.witnessedRemovals)])].sort(ordinal);
  const after = observed.after;
  const deltas = auxiliaryDeltas(before, after, info, round);
  const removed = auxiliaryRemovalProofs(capture.removalProofs, owner, round, before, after);
  const byPath = new Map(after.entries.map(entry => [entry.path, entry]));
  const witnesses = new Set([...input.witnessedRemovals, ...removed]);
  const scopePaths = [...new Set([
    ...input.priorScopePaths, ...input.previousScopePaths,
    ...currentOutputPaths(after,info.areas,[...witnesses]),
    ...witnesses,
  ])].sort(ordinal);
  for (const name of scopePaths) {
    const entry = byPath.get(name);
    if (!entry || entry.kind === 'directory') stale(`round ${round}: scope lacks leaf ${name}`);
  }
  if (receipt.testedState === null) return {info, before, observed, commands, entries:null, scopePaths, requestScopePaths, correctionPaths:deltas, removed:[...removed]};
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
  return {info, before, observed, commands, entries:receipt.testedState.entries, scopePaths, requestScopePaths,
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
// Only literal invocation-local native capture bytes define this causal link.
export function findingsRoundCaptureSha256(cap) {
  plain(cap,'findings link capture');
  if(cap.transport!=='native')fail('UNSUPPORTED_FORMAT','findings link transport');
  const hasRequest=Object.hasOwn(cap,'applyRequest');
  const stable=['transport',...(hasRequest?['applyRequest']:[]),'rawResponse','receipt','baselineCapture','verificationObservation','removalProofs','origin','dispatch','agentBinding','agentClaim','concludedToolResult'];
  if(Object.keys(cap).some(key=>!stable.includes(key))||stable.some(key=>!Object.hasOwn(cap,key)))invalid('findings link capture: fields differ');
  for(const key of stable){if(key==='transport')continue;if(key==='removalProofs'){dense(cap[key],`findings link ${key}`);for(const blob of cap[key])bytes(blob,`findings link ${key}`);}else bytes(cap[key],`findings link ${key}`);}
  const hashes=cap.removalProofs.map(item=>raw(bytes(item,'removal proof')));if(new Set(hashes).size!==hashes.length)invalid('removal proof: duplicate bytes');
  return raw(serialized({format:'stnl-current-findings-round-link-v1',transport:cap.transport,
    ...(hasRequest?{applyRequest:raw(cap.applyRequest)}:{}),rawResponse:raw(cap.rawResponse),receipt:raw(cap.receipt),baselineCapture:raw(cap.baselineCapture),verificationObservation:raw(cap.verificationObservation),removalProofs:hashes.sort(ordinal),
    origin:raw(cap.origin),dispatch:raw(cap.dispatch),agentBinding:raw(cap.agentBinding),agentClaim:raw(cap.agentClaim),concludedToolResult:raw(cap.concludedToolResult)}));
}
export function closeEvidenceObjects() { return objectStore(); }

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
    || carrier.get('Diff Summary') === '- pending') incomplete(`${task}: unsupported current scope`);
  if (current.validation === 'unvalidated'
    && (!/^- \[ \] /mu.test(carrier.get('Checklist') ?? '')
      || /^- \[x\] /mu.test(carrier.get('Checklist') ?? '')))
    incomplete(`${task}: unvalidated checklist is not pristine`);
  if (current.evidence !== null && /^- \[ \] /mu.test(carrier.get('Checklist') ?? ''))
    incomplete(`${task}: current PASS retains an incomplete checklist`);
  return carrier;
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
      fail('UNSUPPORTED_FORMAT','Current EC-1 evidence must use the current evidence inspector');
    }
    return {slice:current.slice,deliveryId:current.deliveryId,counters:current.counters,
      counterAuthority:'persisted-continuity',persistedValidation:current.validation,
      observedValidation:requiresFormalRevalidation || !matches ? 'revalidation-required' : current.validation,
      evidenceSha256:current.evidence?.sha256 ?? null,baseline:current.baseline,observationMatches:matches,
      openFindings:[],openDivergences:[],cycle,consumption,
      diagnostics:current.lastDiagnostic ? [current.lastDiagnostic] : [],requiresFormalRevalidation};
}
