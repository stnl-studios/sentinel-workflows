import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCurrentJson, logicalArtifactPath, resolveLogicalProductClaim, validateCurrentContinuity,
  validateCurrentEvidence,validateCurrentImage,validateCurrentCandidate } from './execution-current.mjs';
import {composeRetainedValidationCarriers} from './current-evidence-state.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const SLICE = /^slice-([0-9]{2,})$/u;
const REQUIREMENT = /^[A-Z][A-Z0-9]*-[0-9]+$/u;
const HEADER_KEYS = ['purpose', 'status', 'read_when', 'do_not_read_when', 'contains', 'owner', 'update_policy'];
const PLAN_SECTIONS = ['Global Context', 'Serial Slice Order', 'Global Risks and Integration'];
const DETAIL_SECTIONS = ['References', 'Objective and Observable Result', 'Requirements', 'Included Scope',
  'Out of Scope and Boundaries', 'Authorized Areas', 'Expected Files', 'Existing Inputs',
  'Protected Responsibilities', 'Dependencies', 'Risks and Strategy', 'Expected Tests',
  'Verification Recipe', 'Completion Criterion'];
const TASK_SECTIONS = ['References', 'Result', 'Acceptance Obligations', 'Authorized Areas', 'Expected Files',
  'Existing Inputs', 'Protected Responsibilities', 'Checklist', 'Expected Tests', 'Verification Recipe',
  'Continuity', 'Operational Changes', 'Changed Areas', 'Scope Expansion', 'Prior Validation Overlap',
  'Divergences', 'Delegation Blocker', 'Implementation Test Evidence', 'Findings Test Evidence',
  'Validation Attempts', 'Validation Findings', 'Corrections Applied', 'Effective Validation Base',
  'Diff Summary', 'Final Result'];
const NONE_SECTIONS = TASK_SECTIONS.slice(TASK_SECTIONS.indexOf('Operational Changes'), TASK_SECTIONS.indexOf('Diff Summary'))
  .filter(name => name !== 'Changed Areas');
const PLAN_TABLE = ['| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |',
  '|---|---|---|---|---|---|'];
const TASK_TABLE = ['| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |',
  '|---|---|---|---|---|---|---|'];
const ordinal = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
const invalid = message => fail('INVALID_CURRENT_IMAGE', message);
const unsafe = message => fail('UNSAFE_PATH', message);
const stale = message => fail('STALE_APPROVAL', message);
const changed = message => fail('REQUIREMENTS_CHANGED', message);
const raw = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function plain(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid(`${label}: plain object required`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== Object.keys(value).length
    || Object.values(descriptors).some(item => !Object.hasOwn(item, 'value') || !item.enumerable)) invalid(`${label}: non-JSON property`);
  return value;
}
function exact(value, fields, label) {
  plain(value, label);
  const actual = Object.keys(value).sort(ordinal), expected = [...fields].sort(ordinal);
  if (actual.length !== expected.length || actual.some((item, i) => item !== expected[i])) invalid(`${label}: unknown or missing field`);
  return value;
}
function array(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).some(key => !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key, item]) => key !== 'length'
      && (!Object.hasOwn(item, 'value') || !item.enumerable))) invalid(`${label}: dense array required`);
  return value;
}
function string(value, label, nonempty = true) {
  if (typeof value !== 'string' || value.includes('\0') || (nonempty && value.trim() === '')) invalid(`${label}: invalid string`);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid(`${label}: isolated surrogate`);
    } else if (code >= 0xdc00 && code <= 0xdfff) invalid(`${label}: isolated surrogate`);
  }
  return value;
}
function match(value, regex, label) { string(value, label); if (!regex.test(value)) invalid(`${label}: invalid value`); return value; }
const hash = (value, label) => match(value, HASH, label);
const uuid = (value, label) => match(value, UUID, label);
function slice(value, label) {
  match(value, SLICE, label);
  const n = Number(SLICE.exec(value)[1]);
  if (!Number.isSafeInteger(n) || n < 1 || String(n).padStart(2, '0') !== SLICE.exec(value)[1]) invalid(`${label}: noncanonical slice`);
  return value;
}
function populated(value, label) {
  string(value, label);
  if (/<[^>]*>|\b(?:TODO|TBD)\b/u.test(value)) invalid(`${label}: placeholder`);
  return value;
}
const normalized = value => value.replaceAll('\r\n', '\n').trim();
function canonical(value) {
  if (value === null || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(string(value, 'canonical string', false));
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) invalid('canonical number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${array(value, 'canonical array').map(canonical).join(',')}]`;
  plain(value, 'canonical object');
  return `{${Object.keys(value).sort(ordinal).map(key => `${JSON.stringify(string(key, 'canonical key', false))}:${canonical(value[key])}`).join(',')}}`;
}
const same = (a, b) => canonical(a) === canonical(b);
const projected = (tag, value) => raw(Buffer.concat([
  Buffer.from(`stnl-ec1/${tag}/v1`, 'utf8'), Buffer.from([0]), Buffer.from(canonical(value), 'utf8'),
]));
function decode(bytes, label) {
  if (!(bytes instanceof Uint8Array)) invalid(`${label}: bytes required`);
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { invalid(`${label}: invalid UTF-8`); }
  if (text.startsWith('\ufeff') || text.includes('\0') || text.replaceAll('\r\n', '\n').includes('\r')
    || !Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) invalid(`${label}: noncanonical text bytes`);
  return text;
}
function artifactMap(value) {
  if (!(value instanceof Map) || Object.getPrototypeOf(value) !== Map.prototype || Reflect.ownKeys(value).length !== 0) invalid('artifacts: ordinary Map required');
  const result = new Map();
  for (const [name, bytes] of Map.prototype.entries.call(value)) {
    string(name, 'artifact path');
    if (!(bytes instanceof Uint8Array)) invalid(`${name}: bytes required`);
    result.set(name, Buffer.from(bytes));
  }
  return result;
}
function input(value, withReview = false) {
  exact(value, withReview ? ['context', 'requirementsAuthority', 'artifacts', 'review']
    : ['context', 'requirementsAuthority', 'artifacts'], 'preparation input');
  hash(value.requirementsAuthority, 'requirementsAuthority');
  logicalArtifactPath(value.context, 'plan.md');
  return artifactMap(value.artifacts);
}
function lines(value, label) {
  const result = normalized(value).split('\n');
  if (result.some(line => line.includes('\r'))) invalid(`${label}: isolated CR`);
  return result;
}
function inline(body, names, label, prefix = '- ') {
  const result = Object.create(null);
  for (const line of lines(body, label)) {
    if (!line.startsWith(prefix)) invalid(`${label}: invalid inline carrier`);
    const matchLine = /^([^:]+): (.+)$/u.exec(line.slice(prefix.length));
    if (!matchLine || !names.includes(matchLine[1]) || Object.hasOwn(result, matchLine[1])) invalid(`${label}: ambiguous inline field`);
    result[matchLine[1]] = populated(matchLine[2], `${label}.${matchLine[1]}`);
  }
  exact(result, names, label);
  return result;
}
function carrier(text, filename, heading, expectedSections = null, currentRevision = false) {
  const source = normalized(text);
  const header = /^# File Purpose Header\n\n```yaml\n([\s\S]*?)\n```\n\n# ([^\n]+)\n\n/u.exec(source + '\n\n');
  if (!header || header[2] !== heading) invalid(`${filename}: invalid purpose header or heading`);
  const metadata = inline(header[1], HEADER_KEYS, `${filename} header`, '');
  if (metadata.owner !== 'stnl-execution-planner' || !['draft', 'ready'].includes(metadata.status)) invalid(`${filename}: owner/status mismatch`);
  const body = (source + '\n\n').slice(header[0].length).trim();
  if (!body || /```|~~~|<!--|-->/u.test(body)) invalid(`${filename}: hidden or missing carrier`);
  if (expectedSections === null) {
    if (/^#{1,6} /mu.test(body)) invalid(`${filename}: unexpected section`);
    return {metadata, body};
  }
  const found = [...body.matchAll(/^## ([^\n]+)\n\n/gmu)];
  if (found.length !== expectedSections.length || found[0]?.index !== 0
    || found.some((item, index) => item[1] !== expectedSections[index])) invalid(`${filename}: unknown, missing or unordered section`);
  const sections = {};
  for (let i = 0; i < found.length; i += 1) {
    const value = normalized(body.slice(found[i].index + found[i][0].length, found[i + 1]?.index));
    const nestedRecords = currentRevision && ['Implementation Test Evidence', 'Findings Test Evidence',
      'Validation Attempts', 'Validation Findings'].includes(found[i][1]);
    if (!value || /^#{1,2} /mu.test(value) || (!nestedRecords && /^#{3,6} /mu.test(value)))
      invalid(`${filename}: empty or hidden section ${found[i][1]}`);
    if (found[i][1] !== 'Verification Recipe') populated(value, `${filename} ${found[i][1]}`);
    sections[found[i][1]] = value;
  }
  return {metadata, sections};
}
function table(body, header, label, allowEmpty=false) {
  const source = lines(body, label);
  if (source.length < (allowEmpty?2:3) || source[0] !== header[0] || source[1] !== header[1]) invalid(`${label}: invalid table header`);
  return source.slice(2).map(line => {
    if (!line.startsWith('|') || !line.endsWith('|')) invalid(`${label}: invalid table row`);
    const columns = line.slice(1, -1).split('|').map(item => item.trim());
    if (columns.length !== header[0].split('|').length - 2 || columns.some(item => !item)) invalid(`${label}: ambiguous table row`);
    return columns;
  });
}
function serial(value, label) {
  const found = /^([0-9]{2,}) - (\S.*)$/u.exec(value);
  if (!found) invalid(`${label}: invalid serial title`);
  const id = slice(`slice-${found[1]}`, label);
  populated(found[2], label);
  return {slice: id, number: found[1], name: found[2]};
}
function requirements(value, label) {
  const ids = value.split(', ');
  if (ids.some(id => !REQUIREMENT.test(id)) || new Set(ids).size !== ids.length) invalid(`${label}: invalid requirement IDs`);
  return ids;
}
function dependencies(value, label) {
  if (value === '-') return [];
  const refs = value.split(', ');
  refs.forEach(ref => slice(ref, label));
  if (new Set(refs).size !== refs.length) invalid(`${label}: duplicate dependency`);
  return refs;
}
function sourceClaim(value, context, artifact, label) {
  const found = /^`([^`]+)`$/u.exec(value);
  if (!found) invalid(`${label}: one backtick path required`);
  const resolved = resolveLogicalProductClaim(context, artifact, found[1]);
  if (resolved !== context.logicalAuthorityPath) unsafe(`${label}: authority source differs`);
}
// Requirements source deliberately resolves to authority. Operational claims do
// not: use this field-level gate without changing the shared path resolver.
function operationalClaim(context,target,label,kind=null) {
  if (target===context.logicalAuthorityPath || within(context.logicalExecutionRoot,target)
    || kind==='directory' && (within(target,context.logicalAuthorityPath)
      || within(target,context.logicalExecutionRoot)))
    unsafe(`${label}: operational claim overlaps authority or execution controls`);
}
function claims(body, context, artifact, label, typed = false, required = false) {
  if (body === '- none' && !required) return [];
  const result = [];
  for (const line of lines(body, label)) {
    const found = typed ? /^- (file|directory): `([^`]+)`$/u.exec(line) : /^- `([^`]+)`$/u.exec(line);
    if (!found) invalid(`${label}: invalid path carrier`);
    const kind = typed ? found[1] : null, rawPath = typed ? found[2] : found[1];
    const target = resolveLogicalProductClaim(context, artifact, rawPath);
    operationalClaim(context,target,label,kind);
    result.push({kind, target});
  }
  if (!result.length || new Set(result.map(item => `${item.kind}\0${item.target}`)).size !== result.length) invalid(`${label}: duplicate or empty paths`);
  return result;
}
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function recipe(body, context, artifact, areas, inputs, label) {
  if (!body.startsWith('- Recipe: ') || body.includes('\n')) invalid(`${label}: invalid recipe carrier`);
  const value = parseCurrentJson(body.slice('- Recipe: '.length));
  exact(value, ['format', 'base', 'cwd', 'checks', 'dependencyReview'], label);
  if (value.format !== 'stnl-verification-recipe-v1' || value.base !== 'workspace') invalid(`${label}: invalid recipe format/base`);
  string(value.cwd, `${label}.cwd`);
  if (value.cwd !== '.' && (value.cwd.startsWith('/') || value.cwd.includes('\\') || /^[A-Za-z]:/u.test(value.cwd)
    || value.cwd.endsWith('/') || value.cwd.split('/').some(part => !part || part === '.' || part === '..')
    || path.posix.normalize(value.cwd) !== value.cwd)) unsafe(`${label}: invalid cwd`);
  populated(value.dependencyReview, `${label}.dependencyReview`);
  array(value.checks, `${label}.checks`);
  if (value.checks.length < 1 || value.checks.length > 32) invalid(`${label}: bounded checks required`);
  const ids = new Set();
  const reference = ref => {
    exact(ref, ['kind', 'path'], `${label}.reference`);
    if (!['product', 'input'].includes(ref.kind)) invalid(`${label}: invalid reference kind`);
    string(ref.path, `${label}.reference.path`);
    const target = resolveLogicalProductClaim(context, artifact, ref.path);
    operationalClaim(context,target,`${label}.reference`);
    if (ref.kind === 'input' ? !inputs.some(item => item.target === target)
      : !areas.some(item => item.kind === 'file' ? item.target === target : within(item.target, target))) unsafe(`${label}: reference outside declared ${ref.kind}`);
  };
  const argument = (arg, executable = false) => {
    plain(arg, `${label}.argument`);
    if (Object.hasOwn(arg, 'literal')) {
      exact(arg, ['literal'], `${label}.literal`);
      string(arg.literal, `${label}.literal`, false);
      if (executable && (!arg.literal || /[\r\n]/u.test(arg.literal))) invalid(`${label}: invalid executable literal`);
    } else { exact(arg, ['file'], `${label}.file`); reference(arg.file); }
  };
  for (const check of value.checks) {
    exact(check, ['id', 'executable', 'args', 'inputs'], `${label}.check`);
    match(check.id, /^verification-[0-9]{2,}$/u, `${label}.check.id`);
    if (ids.has(check.id)) invalid(`${label}: duplicate check ID`);
    ids.add(check.id); argument(check.executable, true);
    array(check.args, `${label}.args`).forEach(arg => argument(arg));
    array(check.inputs, `${label}.inputs`).forEach(reference);
  }
  return value;
}
function obligations(body, label) {
  const result = [];
  for (const line of lines(body, label)) {
    const found = /^- (obligation-[0-9]{2,}) \| requirement: ([A-Z][A-Z0-9]*-[0-9]+) \| contribution: (complete|partial) \| full owner: (slice-[0-9]{2,}|delivery:[a-f0-9-]+) \| condition: ([^|]+) \| proof: ([^|]+)$/u.exec(line);
    if (!found) invalid(`${label}: invalid obligation`);
    const item = {id: found[1], requirement: found[2], contribution: found[3], fullOwner: found[4],
      condition: populated(found[5].trim(), label), proof: populated(found[6].trim(), label)};
    if(item.fullOwner.startsWith('delivery:')) uuid(item.fullOwner.slice(9),label);else slice(item.fullOwner, label);
    const n = Number(item.id.slice('obligation-'.length));
    if (!Number.isSafeInteger(n) || n < 1 || result.some(other => Number(other.id.slice('obligation-'.length)) === n)) invalid(`${label}: duplicate or invalid obligation ID`);
    result.push(item);
  }
  if (!result.length) invalid(`${label}: obligations required`);
  return result;
}
function checklist(body, declared, label, currentRevision = false) {
  const seen = new Set(), covered = new Set();
  for (const line of lines(body, label)) {
    const found = (currentRevision ? /^- \[[ x]\] ([0-9]+\.[0-9]+) (\S.*) \| obligations: (obligation-[0-9]{2,}(?:, obligation-[0-9]{2,})*)$/u
      : /^- \[ \] ([0-9]+\.[0-9]+) (\S.*) \| obligations: (obligation-[0-9]{2,}(?:, obligation-[0-9]{2,})*)$/u).exec(line);
    if (!found || seen.has(found?.[1])) invalid(`${label}: invalid or duplicate pristine step`);
    seen.add(found[1]); populated(found[2], label);
    const ids = found[3].split(', ');
    if (new Set(ids).size !== ids.length || ids.some(id => !declared.some(item => item.id === id))) invalid(`${label}: invalid obligation association`);
    ids.forEach(id => covered.add(id));
  }
  if (!seen.size || declared.some(item => !covered.has(item.id))) invalid(`${label}: obligation not covered`);
}
function requirementsBody(body, assigned, label) {
  populated(body, label);
  for (const id of assigned) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    if (!new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`, 'u').test(body)) invalid(`${label}: missing ${id}`);
  }
  if (!/[\p{L}]/u.test(body.replace(/[A-Z][A-Z0-9]*-[0-9]+/gu, ''))) invalid(`${label}: IDs without requirement content`);
}

function project(value, withReview = false, currentRevision = false, local = null) {
  const supplied = input(value, withReview);
  const artifacts = currentRevision ? new Map([...supplied].filter(([name]) => /^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(name))) : supplied;
  const context = value.context, expectedAuthority = value.requirementsAuthority;
  const completed=local?.completed??[];
  const completedBySlice=new Map(completed.map(item=>[item.slice,item]));
  if(completedBySlice.size!==completed.length || new Set(completed.map(item=>item.leaf.deliveryId)).size!==completed.length)
    invalid('duplicate completed delivery');
  const texts = new Map();
  for (const [name, bytes] of artifacts) texts.set(name, decode(bytes, name));
  if (!texts.has('plan.md') || !texts.has('tasks.md')) invalid('preparation requires plan.md and tasks.md');
  const plan = carrier(texts.get('plan.md'), 'plan.md', 'Execution Plan', PLAN_SECTIONS);
  const global = inline(plan.sections['Global Context'], ['Requirements source', 'Requirements authority', 'Plan revision', 'Objective', 'Strategy', 'Review state'], 'plan.md Global Context');
  sourceClaim(global['Requirements source'], context, 'plan.md', 'plan.md Requirements source');
  hash(global['Requirements authority'], 'plan.md authority');
  if (global['Requirements authority'] !== expectedAuthority) changed('plan.md requirements authority differs');
  const planRevision = Number(global['Plan revision']);
  if (!Number.isSafeInteger(planRevision) || planRevision < 1 || Object.is(planRevision, -0)
    || String(planRevision) !== global['Plan revision'] || (!currentRevision && planRevision !== 1))
    invalid('plan.md: invalid preparation revision');
  const preparationRevision = local?.preparationRevision ?? planRevision;
  if (!Number.isSafeInteger(preparationRevision) || preparationRevision < planRevision)
    invalid('preparation revision precedes global plan revision');
  if (global['Review state'] !== (plan.metadata.status === 'ready' ? 'approved' : 'pending')) invalid('plan.md: review state differs from status');
  const serialRows = table(plan.sections['Serial Slice Order'], PLAN_TABLE, 'plan.md Serial Slice Order',currentRevision).map(columns => {
    const identity = serial(columns[0], 'plan.md Slice');
    if (columns[5] !== `plans/${identity.slice}.md`) invalid(`${identity.slice}: detailed plan link differs`);
    return {...identity, delivery: populated(columns[1], 'observable delivery'), dependencies: dependencies(columns[2], 'serial dependencies'),
      requirements: requirements(columns[3], 'serial requirements'), areas: columns[4]};
  });
  if (new Set(serialRows.map(item => item.slice)).size !== serialRows.length) invalid('duplicate serial slice');
  const expectedNames = ['plan.md', 'tasks.md', ...serialRows.flatMap(item => [`plans/${item.slice}.md`, `tasks/${item.slice}.md`])].sort(ordinal);
  const actualNames = [...artifacts.keys()].sort(ordinal);
  if (!same(actualNames, expectedNames)) invalid('preparation artifact manifest differs');
  const taskIndex = carrier(texts.get('tasks.md'), 'tasks.md', 'Execution Tasks');
  if (taskIndex.metadata.status !== plan.metadata.status) invalid('tasks.md status differs');
  const indexRows = table(taskIndex.body, TASK_TABLE, 'tasks.md',currentRevision);
  if (indexRows.length !== serialRows.length) invalid('tasks.md row count differs');
  const seen = new Map(), serialIndex = new Map(serialRows.map((row, index) => [row.slice, index]));
  for (let index = 0; index < serialRows.length; index += 1) {
    const row = serialRows[index], columns = indexRows[index], indexIdentity = serial(columns[1], 'tasks.md Slice');
    if ((!currentRevision && (columns[0] !== '[ ]' || columns[5] !== 'pending' || columns[6] !== 'pending'))
      || (currentRevision && (!['[ ]', '[x]'].includes(columns[0])
        || !(['pending', 'unvalidated', 'current', 'revalidation-required'].includes(columns[5])
          || local?.retainedPass?.has(row.slice) && columns[0]==='[x]' && columns[5]==='PASS' && columns[6]==='PASS')
        || !['pending', 'PASS'].includes(columns[6])))
      || indexIdentity.slice !== row.slice || indexIdentity.name !== row.name
      || columns[2] !== row.delivery || columns[3] !== (row.dependencies.length ? row.dependencies.join(', ') : '-')
      || columns[4] !== `tasks/${row.slice}.md`) invalid(`${row.slice}: Tasks index differs from Plan`);
    const priorIndexes = row.dependencies.map(dep => serialIndex.get(dep));
    if (row.dependencies.some((dep,i)=>{
      const position=priorIndexes[i];
      return position===undefined?!completedBySlice.has(dep)
        :position>=index;
    }) || row.dependencies.some((dep,i)=>i>0 && Number(dep.slice(6))<=Number(row.dependencies[i-1].slice(6))))
      invalid(`${row.slice}: dependency is not prior and serial`);
  }
  const deliveries = [], projectionLeaves = [], obligationRows = [];
  for (const row of serialRows) {
    const planName = `plans/${row.slice}.md`, taskName = `tasks/${row.slice}.md`;
    const detail = carrier(texts.get(planName), planName, `Slice ${row.number} - ${row.name}`, DETAIL_SECTIONS);
    const task = carrier(texts.get(taskName), taskName, `Slice ${row.number} Tasks - ${row.name}`, TASK_SECTIONS, currentRevision);
    if (detail.metadata.status !== plan.metadata.status || task.metadata.status !== plan.metadata.status) invalid(`${row.slice}: mixed statuses`);
    const detailRefs = inline(detail.sections.References,
      ['Slice', 'Delivery ID', 'Requirements source', 'Requirements authority', 'Plan revision', 'Local revision', 'Global plan', 'Review state'], `${planName} References`);
    const taskRefs = inline(task.sections.References,
      ['Slice', 'Delivery ID', 'Plan', 'Requirements source', 'Requirements authority', 'Plan revision', 'Local revision', 'Global tasks'], `${taskName} References`);
    const localRevision=local?.revisions?.get(row.slice) ?? 1;
    if (!Number.isSafeInteger(localRevision) || localRevision<1
      || detailRefs.Slice !== row.number || taskRefs.Slice !== row.number || detailRefs['Plan revision'] !== String(planRevision)
      || taskRefs['Plan revision'] !== String(planRevision) || detailRefs['Local revision'] !== String(localRevision) || taskRefs['Local revision'] !== String(localRevision)
      || detailRefs['Global plan'] !== '`../plan.md`' || taskRefs.Plan !== `\`../plans/${row.slice}.md\``
      || taskRefs['Global tasks'] !== '`../tasks.md`'
      || detailRefs['Review state'] !== (plan.metadata.status === 'ready' ? 'approved' : 'pending')) invalid(`${row.slice}: invalid references/revisions`);
    uuid(detailRefs['Delivery ID'], `${row.slice} Delivery ID`);
    if (taskRefs['Delivery ID'] !== detailRefs['Delivery ID'] || seen.has(detailRefs['Delivery ID'])) invalid(`${row.slice}: duplicate or mismatched Delivery ID`);
    seen.set(detailRefs['Delivery ID'], row.slice);
    for (const [artifact, refs] of [[planName, detailRefs], [taskName, taskRefs]]) {
      sourceClaim(refs['Requirements source'], context, artifact, `${artifact} Requirements source`);
      hash(refs['Requirements authority'], `${artifact} authority`);
      if (refs['Requirements authority'] !== expectedAuthority) changed(`${artifact}: requirements authority differs`);
    }
    const listedDependencies = detail.sections.Dependencies === '- none' ? []
      : lines(detail.sections.Dependencies, `${planName} Dependencies`).map(line => {
        const found = /^- (slice-[0-9]{2,})$/u.exec(line);
        if (!found) invalid(`${planName}: invalid dependency carrier`);
        return slice(found[1], planName);
      });
    if (!same(listedDependencies, row.dependencies)) invalid(`${row.slice}: dependency carrier differs`);
    requirementsBody(detail.sections.Requirements, row.requirements, `${planName} Requirements`);
    const planAreas = claims(detail.sections['Authorized Areas'], context, planName, `${planName} Authorized Areas`, true, true);
    const taskAreas = claims(task.sections['Authorized Areas'], context, taskName, `${taskName} Authorized Areas`, true, true);
    const globalAreas = claims(row.areas.split('; ').map(item => `- ${item}`).join('\n'), context, 'plan.md', `${row.slice} global areas`, true, true);
    if (!same(planAreas, taskAreas) || !same(planAreas, globalAreas)) invalid(`${row.slice}: Authorized Areas differ`);
    const planInputs = claims(detail.sections['Existing Inputs'], context, planName, `${planName} Existing Inputs`);
    const taskInputs = claims(task.sections['Existing Inputs'], context, taskName, `${taskName} Existing Inputs`);
    claims(detail.sections['Expected Files'], context, planName, `${planName} Expected Files`);
    claims(task.sections['Expected Files'], context, taskName, `${taskName} Expected Files`);
    if (detail.sections['Authorized Areas'] !== task.sections['Authorized Areas']
      || detail.sections['Existing Inputs'] !== task.sections['Existing Inputs'] || !same(planInputs, taskInputs)
      || detail.sections['Protected Responsibilities'] !== task.sections['Protected Responsibilities']
      || detail.sections['Expected Tests'] !== task.sections['Expected Tests']) invalid(`${row.slice}: Plan/Task normative carriers differ`);
    const planRecipe = recipe(detail.sections['Verification Recipe'], context, planName, planAreas, planInputs, `${planName} recipe`);
    const taskRecipe = recipe(task.sections['Verification Recipe'], context, taskName, taskAreas, taskInputs, `${taskName} recipe`);
    if (!same(planRecipe, taskRecipe)) invalid(`${row.slice}: Plan/Task recipe differs`);
    const declared = obligations(task.sections['Acceptance Obligations'], `${taskName} Acceptance Obligations`);
    const declaredIds = new Set(declared.map(item => item.requirement));
    if (declaredIds.size !== row.requirements.length || row.requirements.some(id => !declaredIds.has(id))) invalid(`${row.slice}: obligation/requirement set differs`);
    checklist(task.sections.Checklist, declared, `${taskName} Checklist`, currentRevision);
    const continuity = inline(task.sections.Continuity, ['Current validation', 'Current evidence', 'Current action'], `${taskName} Continuity`);
    if (!currentRevision) {
      if (continuity['Current validation'] !== 'unvalidated' || continuity['Current evidence'] !== 'none'
        || continuity['Current action'] !== 'implement approved delivery') invalid(`${row.slice}: nonpristine continuity`);
      for (const name of NONE_SECTIONS) if (task.sections[name] !== '- none') invalid(`${row.slice}: nonpristine ${name}`);
      for (const name of ['Changed Areas', 'Diff Summary', 'Final Result']) if (task.sections[name] !== '- pending') invalid(`${row.slice}: nonpristine ${name}`);
    } else if (!['unvalidated', 'current', 'revalidation-required'].includes(continuity['Current validation']))
      invalid(`${row.slice}: invalid current continuity`);
    if (task.sections.Result !== row.delivery) invalid(`${row.slice}: observable delivery differs from Task Result`);
    const leaf = {
      deliveryId: detailRefs['Delivery ID'], objectiveAndObservableResult: detail.sections['Objective and Observable Result'],
      requirements: detail.sections.Requirements, includedScope: detail.sections['Included Scope'],
      outOfScopeAndBoundaries: detail.sections['Out of Scope and Boundaries'], authorizedAreas: detail.sections['Authorized Areas'],
      existingInputs: detail.sections['Existing Inputs'], protectedResponsibilities: detail.sections['Protected Responsibilities'],
      dependencies: row.dependencies.map(dep => {
        const source = deliveries.find(item => item.slice === dep)
          ?? (completedBySlice.has(dep)?{deliveryId:completedBySlice.get(dep).leaf.deliveryId}:null);
        if (!source) invalid(`${row.slice}: dependency UUID unavailable`);
        return source.deliveryId;
      }),
      risksAndStrategy: detail.sections['Risks and Strategy'], expectedTests: detail.sections['Expected Tests'],
      verificationRecipe: planRecipe, completionCriterion: detail.sections['Completion Criterion'],
      taskResult: task.sections.Result, obligations: declared,
    };
    deliveries.push({slice: row.slice, deliveryId: leaf.deliveryId, localRevision, authoritySha256: projected('delivery', leaf)});
    projectionLeaves.push(leaf);
    obligationRows.push({slice: row.slice, requirements: row.requirements, obligations: declared, dependencies: row.dependencies});
  }
  const allIds=new Map([...deliveries.map(item=>[item.deliveryId,item.slice]),
    ...completed.map(item=>[item.leaf.deliveryId,item.slice])]);
  if(allIds.size!==deliveries.length+completed.length || completed.some(item=>deliveries.some(active=>active.slice===item.slice)))
    invalid('active/completed identity collision');
  for(const item of completed) {
    if(item.leaf.dependencies.some(id=>!completed.some(value=>value.leaf.deliveryId===id)))
      invalid(`${item.slice}: completed dependency is missing or pending`);
    obligationRows.push({slice:item.slice,requirements:[...new Set(item.leaf.obligations.map(value=>value.requirement))],
      obligations:item.leaf.obligations,dependencies:item.leaf.dependencies.map(id=>allIds.get(id))});
  }
  const bySlice=new Map([...allIds].map(([id,selector])=>[selector,id]));
  const completedIds=new Set(completed.map(item=>item.leaf.deliveryId));
  const resolveOwner=reference=>{
    const id=reference.startsWith('delivery:')?reference.slice(9):bySlice.get(reference);
    if(!allIds.has(id) || reference.startsWith('delivery:')&&!completedIds.has(id)) invalid('obligation owner is not a current member');
    return id;
  };
  const owners = new Map();
  for (const row of obligationRows) for (const obligation of row.obligations) {
    if (obligation.contribution === 'complete') {
      const id=resolveOwner(obligation.fullOwner);
      if (id !== bySlice.get(row.slice)) invalid(`${row.slice}: complete obligation has another owner`);
      const previous = owners.get(obligation.requirement);
      if (previous && previous !== id) invalid(`${obligation.requirement}: multiple integral owners`);
      owners.set(obligation.requirement,id);
    }
  }
  const dependenciesOf = new Map(obligationRows.map(row => [row.slice, row.dependencies]));
  const visiting=new Set(),visited=new Set();
  const visit=selector=>{
    if(visiting.has(selector)) invalid('cyclic delivery dependencies');
    if(visited.has(selector))return;visiting.add(selector);
    for(const dep of dependenciesOf.get(selector)??[]) {if(!bySlice.has(dep))invalid('delivery dependency missing');visit(dep);}
    visiting.delete(selector);visited.add(selector);
  };
  for(const selector of bySlice.keys())visit(selector);
  const dependsOn = (owner, predecessor) => (dependenciesOf.get(owner) ?? []).some(dep => dep === predecessor || dependsOn(dep, predecessor));
  for (const row of obligationRows) for (const obligation of row.obligations) {
    const owner = owners.get(obligation.requirement);
    if (!owner || resolveOwner(obligation.fullOwner) !== owner) invalid(`${obligation.requirement}: missing or mismatched integral owner`);
    if (obligation.contribution === 'partial' && !dependsOn(allIds.get(owner), row.slice))
      invalid(`${obligation.requirement}: partial owner must depend on earlier contribution`);
  }
  const normativeProjection = {format: 'stnl-preparation-projection-v3', requirementsAuthority: expectedAuthority,
    global: {objective: normalized(global.Objective), strategy: normalized(global.Strategy), risks: plan.sections['Global Risks and Integration'],
      order: deliveries.map(item => item.deliveryId)}, deliveries: projectionLeaves,
    completed:completed.map(item=>item.leaf)};
  const globalReviewProjection = {requirementsAuthority: expectedAuthority, global: normativeProjection.global,
    deliveryIds: deliveries.map(item => item.deliveryId), completed:normativeProjection.completed};
  const artifactHashes = [...artifacts].map(([name, bytes]) => ({path: name, sha256: raw(bytes)})).sort((a, b) => ordinal(a.path, b.path));
  return {authority: {requirementsAuthority: expectedAuthority, preparationRevision, normativeProjection,
    normativeSha256: projected('preparation', normativeProjection),
    globalReviewAuthoritySha256: projected('global-review', globalReviewProjection), deliveries,
    ...(completed.length?{completed:completed.map(item=>({slice:item.slice,deliveryId:item.leaf.deliveryId,
      localRevision:item.localRevision}))}:{}),artifactHashes},
  status: plan.metadata.status, texts, supplied};
}

export function projectInitialPreparation(value) { return project(value).authority; }

function review(value, expectedScope, expectedHash, paths, hashes, label, decisions = []) {
  exact(value, ['scope', 'decision', 'authoritySha256', 'examinedArtifactHashes', 'evidenceDecisions', 'summary'], label);
  if (!['set', 'slice'].includes(value.scope)) invalid(`${label}: invalid scope`);
  if (value.scope !== expectedScope) stale(`${label}: approval scope differs`);
  if (value.decision !== 'approved') {
    if (value.decision === 'pending' || value.decision === 'denied') stale(`${label}: no approval`);
    invalid(`${label}: invalid decision`);
  }
  hash(value.authoritySha256, `${label}.authoritySha256`);
  if (value.authoritySha256 !== expectedHash) stale(`${label}: authority digest differs`);
  array(value.examinedArtifactHashes, `${label}.examinedArtifactHashes`);
  const expectedPaths = [...paths].sort(ordinal);
  for (let i = 0; i < value.examinedArtifactHashes.length; i += 1) {
    const item = exact(value.examinedArtifactHashes[i], ['path', 'sha256'], `${label}.examinedArtifactHashes`);
    string(item.path, `${label}.path`); hash(item.sha256, `${label}.sha256`);
    if (item.path !== expectedPaths[i] || item.sha256 !== hashes.get(item.path)) stale(`${label}: examined bytes differ`);
  }
  if (value.examinedArtifactHashes.length !== expectedPaths.length) stale(`${label}: examined manifest differs`);
  array(value.evidenceDecisions, `${label}.evidenceDecisions`);
  if (!same(value.evidenceDecisions.map(item => {
    exact(item, ['deliveryId', 'evidenceSha256', 'disposition', 'reason'], `${label}.evidenceDecision`);
    uuid(item.deliveryId, `${label}.evidenceDecision.deliveryId`);
    hash(item.evidenceSha256, `${label}.evidenceDecision.evidenceSha256`);
    if (!['retain-current', 'revalidate'].includes(item.disposition)) invalid(`${label}: invalid evidence disposition`);
    populated(item.reason, `${label}.evidenceDecision.reason`);
    return {deliveryId:item.deliveryId,evidenceSha256:item.evidenceSha256,disposition:item.disposition};
  }), decisions)) stale(`${label}: evidence decisions differ from final bytes`);
  populated(value.summary, `${label}.summary`);
  return value;
}

function approvePreparation(value, currentRevision = false) {
  plain(value, 'preparation input');
  if (!Object.hasOwn(value, 'review') || value.review === null) stale('preparation review is absent');
  const {authority, status, texts, supplied:allFiles} = project(value, true, currentRevision);
  if (status !== 'ready') stale('preparation is not ready for approval');
  exact(value.review, ['globalReview', 'deliveries'], 'initial review');
  const hashes = new Map(authority.artifactHashes.map(item => [item.path, item.sha256]));
  review(value.review.globalReview, 'set', authority.globalReviewAuthoritySha256, ['plan.md', 'tasks.md'], hashes, 'global review');
  array(value.review.deliveries, 'delivery reviews');
  if (value.review.deliveries.length !== authority.deliveries.length) stale('delivery review count differs');
  const reviewedDeliveries = [];
  let continuity = null;
  if (currentRevision) {
    const bytes = allFiles.get('continuity.json');
    if (!bytes) invalid('reviewed current preparation requires continuity.json');
    continuity = validateCurrentContinuity(parseCurrentJson(decode(bytes, 'continuity.json')));
    if (continuity.completed.length || continuity.deliveries.length !== authority.deliveries.length
      || continuity.deliveries.some((entry, i) => entry.deliveryId !== authority.deliveries[i].deliveryId
        || entry.slice !== authority.deliveries[i].slice || entry.localRevision !== 1
        || entry.authoritySha256 !== authority.deliveries[i].authoritySha256)) invalid('current continuity/authority mismatch');
  }
  for (let i = 0; i < authority.deliveries.length; i += 1) {
    const target = authority.deliveries[i], supplied = exact(value.review.deliveries[i], ['deliveryId', 'review'], `delivery review ${i}`);
    uuid(supplied.deliveryId, `delivery review ${i}.deliveryId`);
    if (supplied.deliveryId !== target.deliveryId) stale(`delivery review ${i}: identity differs`);
    const current = continuity?.deliveries[i];
    const expectedDecisions = current?.evidence ? [{deliveryId:current.deliveryId,evidenceSha256:current.evidence.sha256,
      disposition:current.validation === 'current'?'retain-current':'revalidate'}] : [];
    if (current?.evidence) {
      const bytes = allFiles.get(current.evidence.path);
      if (!(bytes instanceof Uint8Array) || raw(bytes) !== current.evidence.sha256)
        invalid(`${current.slice}: evidence bytes differ`);
      validateCurrentEvidence(parseCurrentJson(decode(bytes, current.evidence.path)));
    }
    review(supplied.review, 'slice', target.authoritySha256,
      [`plans/${target.slice}.md`, `tasks/${target.slice}.md`], hashes, `delivery review ${target.slice}`, expectedDecisions);
    reviewedDeliveries.push({slice: target.slice, deliveryId: target.deliveryId, localRevision: 1,
      review: parseCurrentJson(canonical(supplied.review))});
  }
  const snapshot = {format: 'stnl-preparation-v3', preparationRevision: authority.preparationRevision,
    requirementsAuthority: authority.requirementsAuthority, normativeSha256: authority.normativeSha256,
    normativeProjection: authority.normativeProjection, globalReview: parseCurrentJson(canonical(value.review.globalReview)),
    deliveries: reviewedDeliveries, completed: [],
    reviewedArtifacts: authority.artifactHashes.map(item => ({path: item.path, sha256: item.sha256, utf8: texts.get(item.path)}))};
  const bytes = Buffer.from(canonical(snapshot) + '\n', 'utf8');
  return {authority, snapshot, bytes, sha256: raw(bytes)};
}
export function approveInitialPreparation(value) { return approvePreparation(value); }
export function projectCurrentPreparation(value) { return project(value, false, true).authority; }
export function approveCurrentPreparation(value) { return approvePreparation(value, true); }

export function validateInitialApprovedPreparation(value) {
  exact(value, ['context', 'requirementsAuthority', 'snapshotBytes'], 'snapshot input');
  hash(value.requirementsAuthority, 'requirementsAuthority');
  logicalArtifactPath(value.context, 'plan.md');
  const bytes = Buffer.from(value.snapshotBytes instanceof Uint8Array ? value.snapshotBytes : invalid('snapshot bytes required'));
  const snapshot = parseCurrentJson(decode(bytes, 'approved-preparation.json'));
  plain(snapshot, 'approved-preparation.json');
  if (!Object.hasOwn(snapshot, 'format')) fail('CURRENT_FORMAT_REQUIRED', 'approved-preparation.json: format required');
  if (snapshot.format === 'stnl-preparation-v2') fail('UNSUPPORTED_FORMAT', 'approved-preparation.json: legacy format');
  if (snapshot.format !== 'stnl-preparation-v3') fail('UNSUPPORTED_FORMAT', 'approved-preparation.json: unsupported format');
  exact(snapshot, ['format', 'preparationRevision', 'requirementsAuthority', 'normativeSha256', 'normativeProjection',
    'globalReview', 'deliveries', 'completed', 'reviewedArtifacts'], 'approved-preparation.json');
  if (snapshot.preparationRevision !== 1 || array(snapshot.completed, 'snapshot completed').length !== 0) invalid('approved-preparation.json: not initial');
  array(snapshot.reviewedArtifacts, 'reviewedArtifacts');
  const artifacts = new Map();
  let previous = null;
  for (const item of snapshot.reviewedArtifacts) {
    exact(item, ['path', 'sha256', 'utf8'], 'reviewed artifact');
    string(item.path, 'reviewed artifact path'); hash(item.sha256, 'reviewed artifact sha256');
    string(item.utf8, 'reviewed artifact utf8', false);
    if (previous !== null && ordinal(previous, item.path) >= 0) invalid('reviewed artifact order/uniqueness');
    previous = item.path;
    const original = Buffer.from(item.utf8, 'utf8');
    if (raw(original) !== item.sha256) invalid(`${item.path}: reviewed raw digest differs`);
    artifacts.set(item.path, original);
  }
  const rebuilt = approveInitialPreparation({context: value.context, requirementsAuthority: value.requirementsAuthority,
    artifacts, review: {globalReview: snapshot.globalReview,
      deliveries: array(snapshot.deliveries, 'snapshot deliveries').map(item => {
        exact(item, ['slice', 'deliveryId', 'localRevision', 'review'], 'snapshot delivery');
        if (item.localRevision !== 1) invalid('snapshot delivery: not initial');
        return {deliveryId: item.deliveryId, review: item.review};
      })}});
  if (!same(snapshot, rebuilt.snapshot)) invalid('approved-preparation.json: projection or binding differs');
  return {authority: rebuilt.authority, snapshot: rebuilt.snapshot, bytes, sha256: raw(bytes)};
}

export function validateReviewedPreparation(value) {
  exact(value, ['context', 'requirementsAuthority', 'snapshotBytes', 'artifacts'], 'currentRevision snapshot input');
  hash(value.requirementsAuthority, 'requirementsAuthority');
  logicalArtifactPath(value.context, 'plan.md');
  const bytes = Buffer.from(value.snapshotBytes instanceof Uint8Array ? value.snapshotBytes
    : invalid('snapshot bytes required'));
  const snapshot = parseCurrentJson(decode(bytes, 'approved-preparation.json'));
  exact(snapshot, ['format', 'preparationRevision', 'requirementsAuthority', 'normativeSha256', 'normativeProjection',
    'globalReview', 'deliveries', 'completed', 'reviewedArtifacts'], 'currentRevision snapshot');
  if (snapshot.format !== 'stnl-preparation-v3' || !Number.isSafeInteger(snapshot.preparationRevision)
    || snapshot.preparationRevision < 1 || array(snapshot.completed, 'snapshot completed').length)
    invalid('currentRevision snapshot: format, revision or completed differs');
  const artifacts = artifactMap(value.artifacts);
  if (artifacts.has('approved-preparation.json') || artifacts.has('activation.json'))
    invalid('currentRevision snapshot: artifacts include seal or activation');
  const reviewed = new Map();
  let previous = null;
  for (const item of array(snapshot.reviewedArtifacts, 'reviewedArtifacts')) {
    exact(item, ['path', 'sha256', 'utf8'], 'reviewed artifact');
    string(item.path, 'reviewed artifact path'); hash(item.sha256, 'reviewed artifact sha256');
    string(item.utf8, 'reviewed artifact utf8', false);
    if (previous !== null && ordinal(previous, item.path) >= 0) invalid('reviewed artifact order');
    previous = item.path;
    const original = Buffer.from(item.utf8, 'utf8');
    if (raw(original) !== item.sha256 || !artifacts.has(item.path)
      || !original.equals(artifacts.get(item.path)))
      invalid(`${item.path}: reviewed bytes differ`);
    reviewed.set(item.path, original);
  }
  const rebuilt = approveCurrentPreparation({context:value.context, requirementsAuthority:value.requirementsAuthority,
    artifacts, review:{globalReview:snapshot.globalReview,
      deliveries:array(snapshot.deliveries, 'snapshot deliveries').map(item => {
        exact(item, ['slice', 'deliveryId', 'localRevision', 'review'], 'snapshot delivery');
        if (item.localRevision !== 1) invalid('snapshot delivery: invalid local revision');
        return {deliveryId:item.deliveryId,review:item.review};
      })}});
  if (!same(snapshot, rebuilt.snapshot) || !bytes.equals(rebuilt.bytes))
    invalid('currentRevision snapshot: projection, review or bytes differ');
  return {authority:rebuilt.authority,snapshot:rebuilt.snapshot,bytes,sha256:raw(bytes)};
}

function currentFailure(code, kind, artifact, field, reason) {
  const error = new Error(`${artifact} ${field}: ${reason}`);
  error.code = code;
  error.diagnostics = [{kind, artifact, field, reason}];
  throw error;
}

function currentCarrier(bytes, name, heading, expectedSections = null) {
  const source = decode(bytes, name).replaceAll('\r\n', '\n').trim();
  const top = /^#[ \t]+File Purpose Header[ \t]*\n+```yaml[ \t]*\n([\s\S]*?)\n```\s*\n+#[ \t]+([^\n]+)\s*\n+/u.exec(source + '\n');
  if (!top || top[2].trim() !== heading) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', name, 'header', 'unrecognized header or title');
  const metadata = currentFields(top[1], HEADER_KEYS, name, 'header', false);
  metadata.owner=typed(metadata.owner);metadata.status=typed(metadata.status);
  if (metadata.owner !== 'stnl-execution-planner' || !['draft', 'ready'].includes(metadata.status))
    currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', name, 'header', 'owner or status differs');
  const body = source.slice(top[0].length).trim();
  if (expectedSections === null) {
    if (!body || /^#{1,6}\s/mu.test(body)) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', name, 'body', 'unexpected heading or empty body');
    return {metadata, body};
  }
  const headers = [...body.matchAll(/^##[ \t]+([^\n]+?)[ \t]*$/gmu)];
  if (headers.length !== expectedSections.length || headers[0]?.index !== 0
    || headers.some((item, index) => item[1].trim() !== expectedSections[index]))
    currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', name, 'sections', 'missing, reordered or foreign section');
  const sections = Object.create(null);
  for (let i = 0; i < headers.length; i += 1) {
    const start = headers[i].index + headers[i][0].length;
    const content = body.slice(start, headers[i + 1]?.index).trim();
    const field = expectedSections[i];
    if (!content || /^#{1,2}\s/mu.test(content)) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', name, field, 'empty or nested top-level section');
    if (/^#{3,6}\s/mu.test(content) && !['Implementation Test Evidence', 'Findings Test Evidence', 'Validation Attempts', 'Validation Findings', 'Prior Validation Overlap'].includes(field))
      currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', name, field, 'unexpected nested heading');
    sections[field] = content;
  }
  return {metadata, sections};
}

function currentFields(body, names, artifact, field, bullet = true) {
  const found = Object.create(null),prose=new Set(['Objective','Strategy','Current action']);
  let last=null,blank=false;
  for (const line of body.replaceAll('\r\n', '\n').trim().split('\n')) {
    if(!line.trim()) {blank=true;continue;}
    const pattern = bullet ? /^\s*[-*+]\s+([^:]+?)\s*:\s*(.*?)\s*$/u : /^\s*([^:]+?)\s*:\s*(.*?)\s*$/u;
    const item = pattern.exec(line);
    if(!item && bullet && prose.has(last) && !/^\s*[-*+#]/u.test(line)) {
      found[last]+=(blank?'\n\n':' ')+line.trim();blank=false;continue;
    }
    if (!item || !names.includes(item[1].trim()) || Object.hasOwn(found, item[1].trim()) || item[2].trim() === '')
      currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, field, 'missing, duplicate or unknown field');
    last=item[1].trim();found[last]=item[2].trim();blank=false;
  }
  if (Object.keys(found).length !== names.length) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, field, 'missing field');
  return found;
}

function typed(value) {
  const trimmed = value.trim();
  return /^`[^`]*`$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

// Preserve inline-code contents and list/paragraph boundaries while allowing
// soft wrapping and presentation whitespace outside those contents.
function currentProse(value, artifact, field) {
  const source = value.replaceAll('\r\n', '\n').trim();
  if (!source || /```|~~~|<!--|-->/u.test(source)) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, field, 'unrecognized prose');
  const blocks=[];
  let active=null;
  const flush=()=>{if(active) blocks.push(active);active=null;};
  for (const line of source.split('\n')) {
    if (!line.trim()) {flush();continue;}
    const bullet=/^\s*[-*+]\s+(.+)$/u.exec(line);
    if (bullet) {flush();active={type:'item',value:bullet[1]};}
    else if (active) active.value+=` ${line.trim()}`;
    else active={type:'paragraph',value:line.trim()};
  }
  flush();
  const normalize=text=>{
    const parts=text.split(/(`[^`]*`)/u);
    if (parts.some((part,index)=>index%2===0 && part.includes('`')))
      currentFailure('INVALID_CURRENT_IMAGE','carrier-syntax',artifact,field,'unbalanced inline code');
    return parts.map((part,index)=>index%2?part:part.replace(/\s+/gu,' ')).join('').trim();
  };
  return blocks.map(block=>`${block.type}:${normalize(block.value)}`);
}

function currentClaims(body, context, artifact, field, typedKind = false) {
  if (/^\s*[-*+]\s+none\s*$/u.test(body)) return [];
  const result = [];
  for (const line of body.replaceAll('\r\n', '\n').trim().split('\n')) {
    const item = /^\s*[-*+]\s+(?:(file|directory)\s*:\s*)?(.+?)\s*$/u.exec(line);
    if (!item || Boolean(item[1]) !== typedKind) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, field, 'invalid claim');
    const claim = typed(item[2]);
    let target;
    try { target = resolveLogicalProductClaim(context, artifact, claim); }
    catch (cause) { currentFailure(cause.code ?? 'UNSAFE_PATH', 'carrier-syntax', artifact, field, 'claim escapes approved product root'); }
    result.push({kind:item[1] ?? null, target});
  }
  if (new Set(result.map(item => `${item.kind}\0${item.target}`)).size !== result.length)
    currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, field, 'duplicate claim');
  return result.sort((a, b) => ordinal(`${a.kind}\0${a.target}`, `${b.kind}\0${b.target}`));
}

function currentTable(body, header, artifact, field) {
  const rows = body.replaceAll('\r\n', '\n').trim().split('\n').filter(line=>line.trim()).map(line => {
    if (!/^\s*\|.*\|\s*$/u.test(line)) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, field, 'invalid table row');
    return line.trim().slice(1, -1).split('|').map(cell => cell.trim());
  });
  const labels = header[0].slice(1, -1).split('|').map(cell => cell.trim());
  if (rows.length < 2 || rows.some(row => row.length !== labels.length || row.some(cell => !cell))
    || rows[0].some((cell, index) => cell !== labels[index])
    || rows[1].some(cell => !/^:?-{3,}:?$/u.test(cell)))
    currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, field, 'invalid table header or separator');
  return rows.slice(2).map(row => row.map(typed));
}

function compareCurrent(left, right, artifact, field, kind = 'authority-mismatch') {
  if (!same(left, right)) currentFailure(kind === 'authority-mismatch' ? 'STALE_APPROVAL' : 'INVALID_CURRENT_IMAGE', kind, artifact, field, 'value differs from approved carrier');
}

function compareProse(left, right, artifact, field) {
  compareCurrent(currentProse(left, artifact, field), currentProse(right, artifact, field), artifact, field);
}

function currentRecipe(body, artifact) {
  const matchLine = /^\s*[-*+]\s+Recipe\s*:\s*([\s\S]+)\s*$/u.exec(body.trim());
  if (!matchLine) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, 'Verification Recipe', 'invalid recipe carrier');
  try { return parseCurrentJson(matchLine[1]); }
  catch { currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, 'Verification Recipe', 'invalid recipe JSON'); }
}

function compareCurrentSections(approved, present, names, artifact, context, {task = false} = {}) {
  for (const field of names) {
    if (field === 'Verification Recipe') compareCurrent(currentRecipe(approved[field], artifact), currentRecipe(present[field], artifact), artifact, field);
    else if (field === 'References') {
      const referenceNames = task
        ? ['Slice', 'Delivery ID', 'Plan', 'Requirements source', 'Requirements authority', 'Plan revision', 'Local revision', 'Global tasks']
        : ['Slice', 'Delivery ID', 'Requirements source', 'Requirements authority', 'Plan revision', 'Local revision', 'Global plan', 'Review state'];
      const before = currentFields(approved[field], referenceNames, artifact, field);
      const after = currentFields(present[field], referenceNames, artifact, field);
      compareCurrent(Object.fromEntries(Object.entries(before).map(([key, value]) => [key, typed(value)])),
        Object.fromEntries(Object.entries(after).map(([key, value]) => [key, typed(value)])), artifact, field);
    } else if (['Authorized Areas', 'Expected Files', 'Existing Inputs'].includes(field)) {
      if (field==='Expected Files' && !same(currentClaims(approved[field],context,artifact,field),currentClaims(present[field],context,artifact,field)))
        currentFailure('UNSUPPORTED_FORMAT','carrier-mismatch',artifact,field,'technical path delta exceeds initial quiet profile');
      compareCurrent(currentClaims(approved[field], context, artifact, field, field === 'Authorized Areas'),
        currentClaims(present[field], context, artifact, field, field === 'Authorized Areas'), artifact, field);
    } else if (field === 'Dependencies') {
      const dependencies=value=>value.trim().split('\n').map(line=>{
        const match=/^\s*[-*+]\s+(.+?)\s*$/u.exec(line);
        if(!match) currentFailure('INVALID_CURRENT_IMAGE','carrier-syntax',artifact,field,'invalid dependency');
        return typed(match[1]);
      });
      compareCurrent(dependencies(approved[field]),dependencies(present[field]),artifact,field);
    } else if (field === 'Acceptance Obligations') {
      const obligations=value=>value.trim().split(/\n(?=\s*[-*+]\s+)/u).map(line=>{
        const parts=line.replace(/^\s*[-*+]\s+/u,'').split(/\s*\|\s*/u);
        const id=typed(parts.shift());
        if (!/^obligation-[0-9]{2,}$/u.test(id)) currentFailure('INVALID_CURRENT_IMAGE','carrier-syntax',artifact,field,'invalid obligation ID');
        const values={};
        for(const part of parts) {
          const match=/^([^:]+):\s*([\s\S]+)$/u.exec(part);
          if(!match || Object.hasOwn(values,match[1].trim()) || !['requirement','contribution','full owner','condition','proof'].includes(match[1].trim()))
            currentFailure('INVALID_CURRENT_IMAGE','carrier-syntax',artifact,field,'invalid obligation field');
          const key=match[1].trim();values[key]=['condition','proof'].includes(key)?currentProse(match[2],artifact,field):typed(match[2]);
        }
        if(Object.keys(values).length!==5) currentFailure('INVALID_CURRENT_IMAGE','carrier-syntax',artifact,field,'missing obligation field');
        return {id,...values};
      });
      compareCurrent(obligations(approved[field]),obligations(present[field]),artifact,field);
    } else if (field === 'Checklist') {
      const steps = value => value.replaceAll('\r\n', '\n').trim().split(/\n(?=\s*[-*+]\s+\[)/u).map(line => {
        line=line.replace(/\n[ \t]*/gu,' ');
        const matchLine = /^\s*[-*+]\s+\[([ xX])\]\s+(`[^`]+`|[0-9]+\.[0-9]+)\s+(.+?)\s*\|\s*obligations\s*:\s*(.+)\s*$/u.exec(line);
        if (!matchLine) currentFailure('INVALID_CURRENT_IMAGE', 'carrier-syntax', artifact, field, 'invalid checklist step');
        const id=typed(matchLine[2]),obligations=matchLine[4].split(/\s*,\s*/u).map(typed);
        if (!/^[0-9]+\.[0-9]+$/u.test(id) || obligations.some(value=>!/^obligation-[0-9]{2,}$/u.test(value))
          || new Set(obligations).size!==obligations.length)
          currentFailure('INVALID_CURRENT_IMAGE','carrier-syntax',artifact,field,'invalid checklist identity or obligations');
        return {id, description:currentProse(matchLine[3], artifact, field), obligations};
      });
      if (!same(steps(approved[field]),steps(present[field])))
        currentFailure('UNSUPPORTED_FORMAT','carrier-mismatch',artifact,field,'technical step delta exceeds initial quiet profile');
    } else compareProse(approved[field], present[field], artifact, field);
  }
}

// An operational image retains the reviewed bytes verbatim in its snapshot.
// This parser compares current carrier meaning without projecting a new review
// fingerprint or making the pristine Initial entry points permissive.
function validateConvertedSnapshotIntrinsic({context,requirementsAuthority,snapshotBytes,allowCompleted=false,retainedEvidence=null}) {
  const bytes=Buffer.from(snapshotBytes instanceof Uint8Array ? snapshotBytes : invalid('snapshot bytes required'));
  const snapshot=parseCurrentJson(decode(bytes,'approved-preparation.json'));
  exact(snapshot,['format','preparationRevision','requirementsAuthority','normativeSha256','normativeProjection',
    'globalReview','deliveries','completed','reviewedArtifacts'],'converted snapshot');
  const completed=array(snapshot.completed,'snapshot completed');
  if(snapshot.format!=='stnl-preparation-v3' || !Number.isSafeInteger(snapshot.preparationRevision)
    || snapshot.preparationRevision<1 || completed.length && (!allowCompleted || snapshot.preparationRevision<2)
    || !bytes.equals(Buffer.from(canonical(snapshot)+'\n'))) invalid('converted snapshot bytes or revision differ');
  if(allowCompleted && !completed.length) invalid('completed profile requires a completed delivery');
  const leaves=array(snapshot.normativeProjection?.completed,'projection completed');
  if(leaves.length!==completed.length || leaves.some((leaf,i)=>leaf.deliveryId!==completed[i].deliveryId))
    invalid('completed projection binding differs');
  const retained=completed.map((item,i)=>{
    exact(item,['deliveryId','slice','localRevision','evidenceSha256'],'snapshot completed');
    uuid(item.deliveryId,'completed deliveryId');hash(item.evidenceSha256,'completed evidenceSha256');
    if(!Number.isSafeInteger(item.localRevision) || item.localRevision<1) invalid('completed local revision');
    return {slice:item.slice,localRevision:item.localRevision,leaf:leaves[i]};
  });
  const reviewed=new Map();let previous=null;
  for(const item of array(snapshot.reviewedArtifacts,'reviewedArtifacts')) {
    exact(item,['path','sha256','utf8'],'reviewed artifact');
    string(item.path,'reviewed artifact path');hash(item.sha256,'reviewed artifact sha256');
    if(previous!==null && ordinal(previous,item.path)>=0) invalid('reviewed artifact order');
    previous=item.path;
    const original=Buffer.from(string(item.utf8,'reviewed artifact utf8',false),'utf8');
    if(raw(original)!==item.sha256) invalid(`${item.path}: reviewed raw digest differs`);
    reviewed.set(item.path,original);
  }
  const local={preparationRevision:snapshot.preparationRevision,
    revisions:new Map(array(snapshot.deliveries,'snapshot deliveries').map(item=>[item.slice,item.localRevision])),
    completed:retained,retainedPass:new Set(snapshot.deliveries.filter(item=>item.review?.evidenceDecisions?.some(
      decision=>decision.deliveryId===item.deliveryId&&decision.disposition==='retain-current')).map(item=>item.slice))};
  const {authority,status}=project({context,requirementsAuthority,artifacts:reviewed},false,true,local);
  if(status!=='ready' || snapshot.preparationRevision!==authority.preparationRevision
    || snapshot.requirementsAuthority!==requirementsAuthority
    || snapshot.normativeSha256!==authority.normativeSha256
    || !same(snapshot.normativeProjection,authority.normativeProjection)
    || !same(snapshot.reviewedArtifacts,authority.artifactHashes.map(item=>({
      path:item.path,sha256:item.sha256,utf8:reviewed.get(item.path).toString('utf8')}))))
    stale('converted snapshot projection or reviewed artifacts differ');
  const hashes=new Map(authority.artifactHashes.map(item=>[item.path,item.sha256]));
  const expectedRetention=retainedEvidence??completed.map(item=>({deliveryId:item.deliveryId,evidenceSha256:item.evidenceSha256}));
  const members=new Set([...snapshot.deliveries,...completed].map(item=>item.deliveryId));
  let previousRetention=null;
  for(const item of array(expectedRetention,'retained evidence')) {
    exact(item,['deliveryId','evidenceSha256'],'retained evidence');
    uuid(item.deliveryId,'retained evidence identity');hash(item.evidenceSha256,'retained evidence digest');
    if(!allowCompleted || !members.has(item.deliveryId)
      || previousRetention!==null && ordinal(previousRetention,item.deliveryId)>=0)
      invalid('retained evidence membership or order differs');
    previousRetention=item.deliveryId;
  }
  if(completed.some(item=>!expectedRetention.some(value=>value.deliveryId===item.deliveryId
    && value.evidenceSha256===item.evidenceSha256))) invalid('completed retention is absent');
  const globalRetention=expectedRetention.filter(item=>{
    const global=snapshot.globalReview.evidenceDecisions.find(value=>value.deliveryId===item.deliveryId);
    const local=snapshot.deliveries.find(value=>value.deliveryId===item.deliveryId)?.review.evidenceDecisions
      .find(value=>value.deliveryId===item.deliveryId&&value.evidenceSha256===item.evidenceSha256);
    if(!global&&!local)stale('retained evidence has no reviewed disposition');
    if(completed.some(value=>value.deliveryId===item.deliveryId)&&!global)stale('completed retention has no set review');
    return Boolean(global);
  }).map(item=>({...item,disposition:snapshot.globalReview.evidenceDecisions.find(value=>value.deliveryId===item.deliveryId).disposition}));
  review(snapshot.globalReview,'set',authority.globalReviewAuthoritySha256,['plan.md','tasks.md'],hashes,'global review',
    globalRetention);
  if(!same(completed.map(item=>[item.slice,item.deliveryId,item.localRevision]),
    (authority.completed??[]).map(item=>[item.slice,item.deliveryId,item.localRevision])))
    invalid('converted completed binding differs');
  if(array(snapshot.deliveries,'snapshot deliveries').length!==authority.deliveries.length)
    invalid('converted snapshot delivery count differs');
  for(let i=0;i<authority.deliveries.length;i++) {
    const item=exact(snapshot.deliveries[i],['slice','deliveryId','localRevision','review'],'snapshot delivery');
    const expected=authority.deliveries[i];
    if(item.slice!==expected.slice || item.deliveryId!==expected.deliveryId || item.localRevision!==expected.localRevision)
      invalid('converted snapshot delivery binding differs');
    review(item.review,'slice',expected.authoritySha256,[`plans/${item.slice}.md`,`tasks/${item.slice}.md`],
      hashes,`delivery review ${item.slice}`,item.review.evidenceDecisions.map(({deliveryId,evidenceSha256,disposition})=>
        ({deliveryId,evidenceSha256,disposition})));
  }
  return {authority,snapshot,bytes,sha256:raw(bytes)};
}

export function validateCurrentPreparation({context, requirementsAuthority, snapshotBytes, artifacts, profile='initial',retainedEvidence=null}) {
  if(!['initial','converted-current','completed-current'].includes(profile)) invalid('unknown current preparation profile');
  const approved=profile==='initial'
    ?validateInitialApprovedPreparation({context,requirementsAuthority,snapshotBytes})
    :validateConvertedSnapshotIntrinsic({context,requirementsAuthority,snapshotBytes,
      allowCompleted:profile==='completed-current',retainedEvidence});
  const current = artifactMap(artifacts);
  const expected = approved.snapshot.reviewedArtifacts.map(item => item.path).sort(ordinal);
  compareCurrent([...current.keys()].sort(ordinal), expected, 'execution', 'artifacts', 'integrity');
  const reviewed = new Map(approved.snapshot.reviewedArtifacts.map(item => [item.path, Buffer.from(item.utf8, 'utf8')]));
  const oldPlan = currentCarrier(reviewed.get('plan.md'), 'plan.md', 'Execution Plan', PLAN_SECTIONS);
  const newPlan = currentCarrier(current.get('plan.md'), 'plan.md', 'Execution Plan', PLAN_SECTIONS);
  compareCurrent(oldPlan.metadata.status, newPlan.metadata.status, 'plan.md', 'status');
  const globalNames = ['Requirements source', 'Requirements authority', 'Plan revision', 'Objective', 'Strategy', 'Review state'];
  const oldGlobal = currentFields(oldPlan.sections['Global Context'], globalNames, 'plan.md', 'Global Context');
  const newGlobal = currentFields(newPlan.sections['Global Context'], globalNames, 'plan.md', 'Global Context');
  compareCurrent(Object.fromEntries(Object.entries(oldGlobal).map(([key, value]) => [key, key === 'Objective' || key === 'Strategy' ? currentProse(value, 'plan.md', key) : typed(value)])),
    Object.fromEntries(Object.entries(newGlobal).map(([key, value]) => [key, key === 'Objective' || key === 'Strategy' ? currentProse(value, 'plan.md', key) : typed(value)])), 'plan.md', 'Global Context');
  const serialRows = rows => rows.map(row => [row[0], currentProse(row[1], 'plan.md', 'Observable delivery'), row[2], row[3],
    currentClaims(row[4].split(/\s*;\s*/u).map(claim => `- ${claim}`).join('\n'), context, 'plan.md', 'Authorized areas', true), row[5]]);
  compareCurrent(serialRows(currentTable(oldPlan.sections['Serial Slice Order'], PLAN_TABLE, 'plan.md', 'Serial Slice Order')),
    serialRows(currentTable(newPlan.sections['Serial Slice Order'], PLAN_TABLE, 'plan.md', 'Serial Slice Order')), 'plan.md', 'Serial Slice Order');
  compareProse(oldPlan.sections['Global Risks and Integration'], newPlan.sections['Global Risks and Integration'], 'plan.md', 'Global Risks and Integration');
  const oldIndex = currentCarrier(reviewed.get('tasks.md'), 'tasks.md', 'Execution Tasks');
  const newIndex = currentCarrier(current.get('tasks.md'), 'tasks.md', 'Execution Tasks');
  compareCurrent(oldIndex.metadata.status, newIndex.metadata.status, 'tasks.md', 'status');
  const beforeRows = currentTable(oldIndex.body, TASK_TABLE, 'tasks.md', 'index');
  const afterRows = currentTable(newIndex.body, TASK_TABLE, 'tasks.md', 'index');
  if (beforeRows.length !== afterRows.length) currentFailure('STALE_APPROVAL', 'authority-mismatch', 'tasks.md', 'index', 'row count differs');
  for (let i = 0; i < beforeRows.length; i += 1) {
    const norm=row=>[row[1],currentProse(row[2],'tasks.md','Delivery'),row[3],row[4]];
    compareCurrent(norm(beforeRows[i]), norm(afterRows[i]), 'tasks.md', `row ${i + 1}`);
  }
  const deliveries = [];
  for (const item of approved.authority.deliveries) {
    const planName = `plans/${item.slice}.md`, taskName = `tasks/${item.slice}.md`;
    const title = item.slice.slice(6);
    const oldDetail = currentCarrier(reviewed.get(planName), planName,
      `Slice ${title} - ${beforeRows.find(row => row[1].startsWith(`${title} - `))?.[1].slice(title.length + 3)}`, DETAIL_SECTIONS);
    const newDetail = currentCarrier(current.get(planName), planName,
      `Slice ${title} - ${beforeRows.find(row => row[1].startsWith(`${title} - `))?.[1].slice(title.length + 3)}`, DETAIL_SECTIONS);
    const oldTask = currentCarrier(reviewed.get(taskName), taskName,
      `Slice ${title} Tasks - ${beforeRows.find(row => row[1].startsWith(`${title} - `))?.[1].slice(title.length + 3)}`, TASK_SECTIONS);
    const newTask = currentCarrier(current.get(taskName), taskName,
      `Slice ${title} Tasks - ${beforeRows.find(row => row[1].startsWith(`${title} - `))?.[1].slice(title.length + 3)}`, TASK_SECTIONS);
    compareCurrent(oldDetail.metadata.status, newDetail.metadata.status, planName, 'status');
    compareCurrent(oldTask.metadata.status, newTask.metadata.status, taskName, 'status');
    compareCurrentSections(oldDetail.sections, newDetail.sections, DETAIL_SECTIONS, planName, context);
    compareCurrentSections(oldTask.sections, newTask.sections, TASK_SECTIONS.slice(0, TASK_SECTIONS.indexOf('Continuity')), taskName, context, {task:true});
    for (const field of ['Operational Changes', 'Scope Expansion', 'Divergences']) {
      if (currentProse(newTask.sections[field], taskName, field).join('') !== 'item:none')
        currentFailure('UNSUPPORTED_FORMAT', 'carrier-mismatch', taskName, field, 'active change exceeds initial quiet profile');
    }
    const continuity = currentFields(newTask.sections.Continuity, ['Current validation', 'Current evidence', 'Current action'], taskName, 'Continuity');
    deliveries.push({slice:item.slice, deliveryId:item.deliveryId, sections:newTask.sections,
      continuity:{validation:typed(continuity['Current validation']), evidence:typed(continuity['Current evidence']), action:continuity['Current action']},
      index:{done:afterRows.find(row => row[1].startsWith(`${title} - `))?.[0], validation:afterRows.find(row => row[1].startsWith(`${title} - `))?.[5], result:afterRows.find(row => row[1].startsWith(`${title} - `))?.[6]}});
  }
  return {authority:approved.authority, snapshot:approved.snapshot,
    currentArtifacts:{plan:newPlan.sections, tasksIndex:afterRows, deliveries}};
}

function assertPrivateLocalDelta({context,slice,original,revised,siblings}) {
  const taskName=`tasks/${slice}.md`;
  const privateFields=new Set(['existingInputs','risksAndStrategy','expectedTests','verificationRecipe']);
  if(Object.keys(original).some(key=>!privateFields.has(key) && !same(original[key],revised[key]))
    || same(original,revised)) fail('REPLAN_REQUIRED','selected delta is transverse or has no normative change');
  const inputPaths=(leaf,artifact)=>[...claims(leaf.existingInputs,context,artifact,'local review inputs').map(item=>item.target),
    ...leaf.verificationRecipe.checks.flatMap(check=>[...check.inputs,...check.args.flatMap(arg=>arg.file?[arg.file]:[]),
      ...(check.executable.file?[check.executable.file]:[])])
      .map(ref=>resolveLogicalProductClaim(context,artifact,ref.path))];
  const priorInputs=new Set(inputPaths(original,taskName)),nextInputs=new Set(inputPaths(revised,taskName));
  const changedInputs=[...new Set([...priorInputs,...nextInputs])].filter(name=>priorInputs.has(name)!==nextInputs.has(name));
  for(const {slice:siblingSlice,leaf} of siblings) {
    const artifact=`tasks/${siblingSlice}.md`,areas=claims(leaf.authorizedAreas,context,artifact,'sibling areas',true);
    const inputs=inputPaths(leaf,artifact);
    if(changedInputs.some(name=>inputs.includes(name)||areas.some(area=>area.kind==='directory'?within(area.target,name):area.target===name)))
      fail('REPLAN_REQUIRED','local review changes a shared input or another delivery output reference');
  }
}

function composeCurrentLocalReviewEvidence({files,updatedFiles,next,taskName,currentTaskBytes,indexBytes}) {
  const slice=next.slice;
  let evidenceDecision=[];
  if(next.evidence) {
    const bundle=parseCurrentJson(decode(files.get(next.evidence.path),next.evidence.path));
    validateCurrentEvidence(bundle);
    bundle.currentAuthoritySha256=next.authoritySha256;
    const formalSource=bundle.validation?.recordFormat==='stnl-task-record-v2'
      ?bundle.objects.find(item=>item.id===bundle.validation.sources[bundle.validation.sources.transport==='native'?'origin':'started']):null;
    const formalCapsule=formalSource?parseCurrentJson(Buffer.from(formalSource.bytesBase64,'base64').toString('utf8')):null;
    const formalRequest=typeof formalCapsule?.validationRequestUtf8==='string'
      ?parseCurrentJson(formalCapsule.validationRequestUtf8):null;
    const currentChecks=bundle.implementation.some(item=>item.recordFormat==='stnl-task-record-v2')
      || ['stnl-current-validation-request-v1','stnl-current-validation-request-v2'].includes(formalRequest?.format);
    // A reviewed publication may compact a closed formal refusal. Its current
    // accepted formal and necessary product witnesses remain literal.
    if(bundle.openFindings.length===0&&bundle.validation?.recordFormat==='stnl-task-record-v2')
      bundle.support=bundle.support.filter(item=>item.kind!=='rejection'||item.origin.operation!=='VALIDATE_SLICE');
    if(currentChecks&&formalRequest?.format==='stnl-current-validation-request-v2'
      &&bundle.findingsChecks.length>0&&bundle.openFindings.length===0) {
      const check=bundle.findingsChecks[0];
      const source=bundle.objects.find(item=>item.id===check.sources[check.sources.transport==='native'?'origin':'started']);
      const capsule=parseCurrentJson(Buffer.from(source.bytesBase64,'base64').toString('utf8'));
      const request=parseCurrentJson(capsule.applyRequestUtf8);
      const roots=new Set([formalRequest.base.auxiliary.cycle,
        ...request.base.openFindings.map(item=>item.originAttempt)]);
      bundle.support=bundle.support.filter(item=>item.kind!=='validation'||roots.has(item.id));
    }
    if((currentChecks||bundle.validation?.recordFormat==='stnl-task-record-v2')
      &&bundle.findingsChecks.length===0&&bundle.openFindings.length===0) {
      const roots=new Set();
      for(const check of bundle.support.filter(item=>item.kind==='findings-check')) {
        const source=bundle.objects.find(item=>item.id===check.sources[check.sources.transport==='native'?'origin':'started']);
        const capsule=parseCurrentJson(Buffer.from(source.bytesBase64,'base64').toString('utf8'));
        const request=parseCurrentJson(capsule.applyRequestUtf8);
        if(request.format==='stnl-current-findings-request-v2') {
          roots.add(request.base.validation.id);
          for(const finding of request.base.openFindings)roots.add(finding.originAttempt);
        }
      }
      bundle.support=bundle.support.filter(item=>item.kind!=='validation'||roots.has(item.id));
    }
    const ids=new Set([...bundle.implementation,...bundle.findingsChecks,...bundle.support,bundle.validation].filter(Boolean)
      .flatMap(item=>Object.values(item.sources).flat()).filter(item=>typeof item==='string'&&HASH.test(item)));
    bundle.objects=bundle.objects.filter(item=>ids.has(item.id));
    const bytes=Buffer.from(canonical(bundle)+'\n','utf8');
    updatedFiles.set(next.evidence.path,bytes);
    next.evidence.sha256=raw(bytes);
    evidenceDecision=[{deliveryId:next.deliveryId,evidenceSha256:next.evidence.sha256,
      disposition:'revalidate',reason:''}];
    const carriers=composeCurrentLocalReviewCarriers({task:Buffer.from(currentTaskBytes).toString('utf8'),
      index:Buffer.from(indexBytes).toString('utf8'),slice,evidenceSha256:currentChecks?next.evidence.path:next.evidence.sha256,
      validationRecords:currentChecks||bundle.validation?.recordFormat==='stnl-task-record-v2'?[...bundle.support.filter(item=>item.kind==='validation'),bundle.validation].filter(Boolean):null});
    updatedFiles.set(taskName,carriers.task);
    updatedFiles.set('tasks.md',carriers.index);
  }
  return evidenceDecision;
}

// A local review replaces one already approved leaf. The proposal is deliberately
// in memory: the existing reviewed snapshot, continuity and publisher remain the
// only official carriers. Approval is supplied separately by an independent reviewer.
export function prepareCurrentLocalReview(input) {
  const {context,requirementsAuthority,previous,slice,planBytes,reviewedTaskBytes,currentTaskBytes}=input;
  if(!SLICE.test(slice)) invalid('local review requires one selected slice');
  const files=new Map([...previous.files].map(([name,bytes])=>[name,Buffer.from(bytes)]));
  const old=validateCurrentImage({activationBytes:previous.activationBytes,files});
  const activation=parseCurrentJson(decode(previous.activationBytes,'activation.json'));
  if(activation.activeAttempt!==null || activation.requirementsAuthority!==requirementsAuthority
    || activation.preparationRevision<=1)
    fail('UNSUPPORTED_FORMAT','local review requires a quiet converted image');
  const selected=old.continuity.deliveries.find(item=>item.slice===slice);
  if(!selected || selected.validation==='uncertain' || selected.normalization!==null)
    fail('UNSUPPORTED_FORMAT','selected S2 is not eligible for one local review');
  const snapshot=parseCurrentJson(decode(files.get('approved-preparation.json'),'approved-preparation.json'));
  const original=snapshot.normativeProjection.deliveries.find(item=>item.deliveryId===selected.deliveryId);
  if([...snapshot.normativeProjection.deliveries,...snapshot.normativeProjection.completed].some(item=>item.deliveryId!==selected.deliveryId
    && item.dependencies.includes(selected.deliveryId)))
    fail('REPLAN_REQUIRED','consumer of selected delivery requires a set review');
  const planName=`plans/${slice}.md`,taskName=`tasks/${slice}.md`;
  const reviewed=new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8,'utf8')]));
  if(!reviewed.has(planName) || !reviewed.has(taskName)) invalid('selected reviewed artifacts absent');
  reviewed.set(planName,Buffer.from(planBytes));
  reviewed.set(taskName,Buffer.from(reviewedTaskBytes));
  const revisions=new Map(snapshot.deliveries.map(item=>[item.slice,item.localRevision]));
  revisions.set(slice,selected.localRevision+1);
  const {authority,status}=project({context,requirementsAuthority,artifacts:reviewed},false,true,
    {preparationRevision:snapshot.preparationRevision+1,revisions,completed:snapshot.completed.map((item,i)=>({slice:item.slice,localRevision:item.localRevision,leaf:snapshot.normativeProjection.completed[i]}))});
  if(status!=='ready' || !same(authority.normativeProjection.global,snapshot.normativeProjection.global)
    || !same(authority.normativeProjection.completed,snapshot.normativeProjection.completed)
    || authority.deliveries.some((item,i)=>item.slice!==slice && (
      !same(item,snapshot.deliveries[i] && {slice:snapshot.deliveries[i].slice,
        deliveryId:snapshot.deliveries[i].deliveryId,localRevision:snapshot.deliveries[i].localRevision,
        authoritySha256:projected('delivery',snapshot.normativeProjection.deliveries[i])})
      || !same(authority.normativeProjection.deliveries[i],snapshot.normativeProjection.deliveries[i]))))
    fail('REPLAN_REQUIRED','local review changes set or another delivery');
  const revised=authority.normativeProjection.deliveries.find(item=>item.deliveryId===selected.deliveryId);
  assertPrivateLocalDelta({context,slice,original,revised,
    siblings:[...snapshot.deliveries,...snapshot.completed].filter(item=>item.deliveryId!==selected.deliveryId)
      .map(item=>({slice:item.slice,leaf:[...snapshot.normativeProjection.deliveries,...snapshot.normativeProjection.completed]
        .find(leaf=>leaf.deliveryId===item.deliveryId)}))});
  const changedPaths=[planName,taskName];
  if(snapshot.reviewedArtifacts.some(item=>!changedPaths.includes(item.path)
    && (authority.artifactHashes.find(hash=>hash.path===item.path)?.sha256!==item.sha256)))
    fail('REPLAN_REQUIRED','unselected reviewed bytes differ');
  const updatedFiles=new Map(files);
  updatedFiles.set(planName,Buffer.from(planBytes));
  updatedFiles.set(taskName,Buffer.from(currentTaskBytes));
  const nextContinuity=structuredClone(old.continuity);
  const next=nextContinuity.deliveries.find(item=>item.deliveryId===selected.deliveryId);
  next.localRevision+=1;
  next.authoritySha256=authority.deliveries.find(item=>item.deliveryId===selected.deliveryId).authoritySha256;
  next.validation=next.evidence===null&&Object.values(next.counters).every(value=>value===0)
    && selected.validation==='unvalidated'?'unvalidated':'revalidation-required';
  const evidenceDecision=composeCurrentLocalReviewEvidence({files,updatedFiles,next,taskName,
    currentTaskBytes,indexBytes:files.get('tasks.md')});
  updatedFiles.set('continuity.json',Buffer.from(canonical(nextContinuity)+'\n','utf8'));
  const hashes=new Map(authority.artifactHashes.map(item=>[item.path,item.sha256]));
  const reviewRequest={scope:'slice',authoritySha256:next.authoritySha256,
    examinedArtifactHashes:changedPaths.sort(ordinal).map(path=>({path,sha256:hashes.get(path)})),
    evidenceDecisions:evidenceDecision};
  return {input,files:updatedFiles,authority,selected,snapshot,reviewed,reviewRequest};
}

function composeCurrentLocalReviewCarriers({task,index,slice,evidenceSha256,validationRecords=null}) {
  const replace=(document,name,body)=>{
    const lines=document.split('\n');
    const start=lines.findIndex(line=>line===`## ${name}`);
    if(start<0) invalid(`Task lacks ${name}`);
    let end=start+1;
    while(end<lines.length && !lines[end].startsWith('## ')) end++;
    return [...lines.slice(0,start+1),'',body,'',...lines.slice(end)].join('\n');
  };
  let next=replace(task,'Continuity',
    `- Current validation: revalidation-required\n- Current evidence: ${evidenceSha256}\n- Current action: VALIDATE_SLICE`);
  for(const section of ['Final Result','Changed Areas','Corrections Applied',
    'Prior Validation Overlap','Effective Validation Base'])
    next=replace(next,section,section==='Final Result'?'- pending':'- none');
  if(validationRecords!==null)next=replace(next,'Validation Attempts',validationRecords.length?validationRecords.map(item=>item.recordUtf8).join('\n\n'):'- none');
  let found=false;
  const rows=index.split('\n').map(line=>{
    if(!/^\| \[[ x]\] \|/u.test(line)) return line;
    const cols=line.slice(1,-1).split('|').map(item=>item.trim());
    if(!cols[1].startsWith(`${slice.slice(6)} - `)) return line;
    found=true;cols[0]='[ ]';cols[5]='pending';cols[6]='pending';
    return `| ${cols.join(' | ')} |`;
  });
  if(!found) invalid('selected Tasks index row absent');
  return {task:Buffer.from(next,'utf8'),index:Buffer.from(rows.join('\n'),'utf8')};
}

export function finalizeCurrentLocalReview({proposal,review:decision}) {
  if(decision===null || decision===undefined) stale('independent local review is absent');
  const fresh=prepareCurrentLocalReview(proposal.input);
  if(!same(fresh.reviewRequest,proposal.reviewRequest)) stale('local proposal changed after review');
  const {snapshot,authority,reviewed,selected}=fresh;
  const hashes=new Map(authority.artifactHashes.map(item=>[item.path,item.sha256]));
  review(decision,'slice',fresh.reviewRequest.authoritySha256,
    fresh.reviewRequest.examinedArtifactHashes.map(item=>item.path),hashes,'local delivery review',
    fresh.reviewRequest.evidenceDecisions.map(({deliveryId,evidenceSha256,disposition})=>
      ({deliveryId,evidenceSha256,disposition})));
  const nextSnapshot={...snapshot,preparationRevision:authority.preparationRevision,
    normativeProjection:authority.normativeProjection,normativeSha256:authority.normativeSha256,
    deliveries:snapshot.deliveries.map(item=>item.deliveryId===selected.deliveryId
      ?{...item,localRevision:item.localRevision+1,review:parseCurrentJson(canonical(decision))}:item),
    reviewedArtifacts:authority.artifactHashes.map(item=>({path:item.path,sha256:item.sha256,
      utf8:reviewed.get(item.path).toString('utf8')}))};
  const files=new Map(fresh.files);
  files.set('approved-preparation.json',Buffer.from(canonical(nextSnapshot)+'\n','utf8'));
  validateCurrentCandidate({files});
  return {files,authority,selected};
}

// Bounded set composition only: Q18 retires the active queue; Q19 reopens one
// completed contribution for a private review; Q20 retains the same integral
// owner/local proof for explicit terminal judgment. The caller owns quiet source
// capture and the full semantic reader gate. No admission or publication here.
export function prepareCurrentSetReplacement(value) {
  exact(value,['context','requirementsAuthority','previous','artifacts','completedDeliveryIds',
    ...(Object.hasOwn(value??{},'terminalValidation')?['terminalValidation']:[])],
    'set replacement input');
  const terminalValidation=Object.hasOwn(value,'terminalValidation')?value.terminalValidation:false;
  if(typeof terminalValidation!=='boolean')invalid('terminal validation selection must be boolean');
  const {context,requirementsAuthority,previous}=value;
  hash(requirementsAuthority,'set replacement requirements authority');
  exact(previous,['activationBytes','files'],'set replacement predecessor');
  const files=artifactMap(previous.files);
  const checked=validateCurrentImage({activationBytes:previous.activationBytes,files});
  const activation=parseCurrentJson(decode(previous.activationBytes,'set replacement activation'));
  const snapshot=parseCurrentJson(decode(files.get('approved-preparation.json'),'approved-preparation.json'));
  const continuity=checked.continuity;
  if(activation.activeAttempt!==null)fail('OWNER_ACTIVE','set replacement requires a quiet predecessor');
  if(snapshot.requirementsAuthority!==requirementsAuthority)changed('set replacement requirements differ');
  const artifacts=artifactMap(value.artifacts);
  const ids=array(value.completedDeliveryIds,'completed selection').map(id=>uuid(id,'completed selection'));
  if(new Set(ids).size!==ids.length)invalid('duplicate completed selection');
  const members=[...continuity.deliveries,...continuity.completed];
  const ordered=[...members].sort((a,b)=>ordinal(a.deliveryId,b.deliveryId));
  if(ids.some(id=>!ordered.some(item=>item.deliveryId===id)))invalid('completed selection has a foreign identity');
  const completedIds=new Set(ids),active=ordered.filter(item=>!completedIds.has(item.deliveryId));
  const retiring=continuity.deliveries.length>0&&active.length===0;
  const reopening=continuity.deliveries.length===0&&active.length===1&&(ids.length>0||terminalValidation);
  if(terminalValidation&&!reopening)fail('REPLAN_REQUIRED','terminal reentry requires one selected completed contribution and empty queue');
  if(!retiring&&!reopening)
    fail('UNSUPPORTED_FORMAT','set replacement supports Q18 retirement, Q19 private reopening or explicit Q20 terminal reentry');
  const selected=reopening?active[0]:null;
  if(selected&&selected.normalization!==null)
    fail('UNSUPPORTED_FORMAT','Q19 requires a quiet contribution without normalization');
  const expectedPaths=['plan.md','tasks.md',...active.flatMap(item=>[`plans/${item.slice}.md`,`tasks/${item.slice}.md`])];
  if(!same([...artifacts.keys()].sort(ordinal),expectedPaths.sort(ordinal)))
    invalid('set replacement reviewed artifact membership differs');
  for(const current of members) {
    if(current.validation!=='current' || current.evidence===null
      || current.normalization && ['reserved','running'].includes(current.normalization.status))
      fail('EVIDENCE_INCOMPLETE',`${current.slice}: set replacement requires inspected current local evidence`);
    const bundle=validateCurrentEvidence(parseCurrentJson(decode(files.get(current.evidence.path),current.evidence.path)));
    if(bundle.validation===null || bundle.openFindings.some(item=>item.severity==='blocking')
      || bundle.openDivergences.length)
      fail('EVIDENCE_INCOMPLETE',`${current.slice}: set replacement requires an unblocked formal contribution`);
  }
  const reviewed=new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8,'utf8')]));
  const retained=new Map();
  for(const decision of [...snapshot.globalReview.evidenceDecisions,
    ...snapshot.deliveries.flatMap(item=>item.review.evidenceDecisions)]) {
    if(!retained.has(decision.deliveryId))retained.set(decision.deliveryId,decision.evidenceSha256);
  }
  for(const current of snapshot.completed)if(!retained.has(current.deliveryId))
    retained.set(current.deliveryId,current.evidenceSha256);
  validateCurrentPreparation({context,requirementsAuthority,
    snapshotBytes:files.get('approved-preparation.json'),
    artifacts:new Map([...files].filter(([name])=>reviewed.has(name))),
    profile:snapshot.completed.length?'completed-current':snapshot.preparationRevision===1?'initial':'converted-current',
    retainedEvidence:snapshot.completed.length?[...retained].sort(([a],[b])=>ordinal(a,b))
      .map(([deliveryId,evidenceSha256])=>({deliveryId,evidenceSha256})):null});
  const preparationRevision=snapshot.preparationRevision+1;
  if(!Number.isSafeInteger(preparationRevision))invalid('set replacement preparation revision exhausted');
  const bySlice=new Map(members.map(current=>[current.slice,current.deliveryId]));
  const byId=new Map(members.map(current=>[current.deliveryId,current.slice]));
  const leaves=new Map([...snapshot.normativeProjection.deliveries,...snapshot.normativeProjection.completed]
    .map(leaf=>[leaf.deliveryId,{...leaf,obligations:leaf.obligations.map(obligation=>{
      const owner=obligation.fullOwner.startsWith('delivery:')?obligation.fullOwner.slice(9):bySlice.get(obligation.fullOwner);
      return {...obligation,fullOwner:completedIds.has(owner)?`delivery:${owner}`:byId.get(owner)};
    })}]));
  const completed=ordered.filter(item=>completedIds.has(item.deliveryId));
  if(terminalValidation&&(selected.lastDiagnostic!==null
    ||!leaves.get(selected.deliveryId).obligations.some(item=>item.contribution==='complete'&&item.fullOwner===selected.slice)))
    fail('REPLAN_REQUIRED','terminal reentry requires the same quiet integral owner');
  const local={preparationRevision,revisions:new Map(active.map(item=>[item.slice,item.localRevision+(terminalValidation?0:1)])),
    completed:completed.map(current=>({slice:current.slice,localRevision:current.localRevision,leaf:leaves.get(current.deliveryId)})),
    retainedPass:new Set(terminalValidation?[selected.slice]:[])};
  let {authority,status}=project({context,requirementsAuthority,artifacts},false,true,local);
  if(status!=='ready')stale('set replacement is not ready for review');
  if(!same(authority.deliveries.map(item=>[item.deliveryId,item.slice]),active.map(item=>[item.deliveryId,item.slice])))
    invalid('set replacement active identities differ from the captured set');
  const beforeGlobal=snapshot.normativeProjection.global,afterGlobal=authority.normativeProjection.global;
  if(['objective','strategy','risks'].some(key=>!same(beforeGlobal[key],afterGlobal[key])))
    fail('UNSUPPORTED_FORMAT','set replacement preserves global objective, strategy and risks');
  if(terminalValidation&&!same(leaves.get(selected.deliveryId),authority.normativeProjection.deliveries[0]))
    fail('REPLAN_REQUIRED','terminal reentry preserves the complete local normative contract');
  if(selected&&!terminalValidation)assertPrivateLocalDelta({context,slice:selected.slice,original:leaves.get(selected.deliveryId),
    revised:authority.normativeProjection.deliveries[0],
    siblings:completed.map(item=>({slice:item.slice,leaf:leaves.get(item.deliveryId)}))});
  const nextContinuity={...structuredClone(continuity),deliveries:structuredClone(active),completed:structuredClone(completed)};
  const proposed=new Map(artifacts),localDecisions=new Map();
  for(const current of nextContinuity.completed) {
    const authoritySha256=projected('delivery',leaves.get(current.deliveryId));
    let bytes=files.get(current.evidence.path);
    if(authoritySha256!==current.authoritySha256) {
      const bundle=parseCurrentJson(decode(bytes,current.evidence.path));
      // Only the current index changes; historical records and objects stay literal.
      bytes=Buffer.from(canonical({...bundle,currentAuthoritySha256:authoritySha256})+'\n','utf8');
    }
    current.authoritySha256=authoritySha256;
    current.evidence.sha256=raw(bytes);
    proposed.set(current.evidence.path,Buffer.from(bytes));
  }
  for(const current of nextContinuity.deliveries) {
    current.localRevision+=terminalValidation?0:1;
    current.authoritySha256=authority.deliveries.find(item=>item.deliveryId===current.deliveryId).authoritySha256;
    if(terminalValidation) {
      const original=files.get(current.evidence.path),bundle=parseCurrentJson(decode(original,current.evidence.path));
      const bytes=bundle.currentAuthoritySha256===current.authoritySha256?original:
        Buffer.from(canonical({...bundle,currentAuthoritySha256:current.authoritySha256})+'\n','utf8');
      current.evidence.sha256=raw(bytes);proposed.set(current.evidence.path,Buffer.from(bytes));
      const taskName=`tasks/${current.slice}.md`;
      const carriers=composeRetainedValidationCarriers({context,current,bundleBytes:bytes,
        taskBytes:artifacts.get(taskName),indexBytes:artifacts.get('tasks.md'),
        priorBundles:nextContinuity.completed.map(item=>({slice:item.slice,bundleBytes:proposed.get(item.evidence.path)}))});
      proposed.set(taskName,carriers.task);proposed.set('tasks.md',carriers.index);
      localDecisions.set(current.deliveryId,[{deliveryId:current.deliveryId,evidenceSha256:current.evidence.sha256,
        disposition:'retain-current',reason:''}]);
      continue;
    }
    current.validation='revalidation-required';
    const taskName=`tasks/${current.slice}.md`;
    localDecisions.set(current.deliveryId,composeCurrentLocalReviewEvidence({files,updatedFiles:proposed,next:current,
      taskName,currentTaskBytes:artifacts.get(taskName),indexBytes:artifacts.get('tasks.md')}));
  }
  // Review the final current carriers, including the exact revalidation digest.
  const finalArtifacts=new Map([...proposed].filter(([name])=>expectedPaths.includes(name)));
  const finalProjection=project({context,requirementsAuthority,artifacts:finalArtifacts},false,true,local);
  if(finalProjection.status!=='ready'||finalProjection.authority.normativeSha256!==authority.normativeSha256)
    invalid('composed current carriers changed the reviewed normative authority');
  authority=finalProjection.authority;
  proposed.set('continuity.json',Buffer.from(canonical(nextContinuity)+'\n','utf8'));
  const hashes=new Map(authority.artifactHashes.map(item=>[item.path,item.sha256]));
  const reviewRequest={globalReview:{scope:'set',authoritySha256:authority.globalReviewAuthoritySha256,
    examinedArtifactHashes:['plan.md','tasks.md'].map(path=>({path,sha256:hashes.get(path)})),
    evidenceDecisions:nextContinuity.completed.map(current=>({deliveryId:current.deliveryId,
      evidenceSha256:current.evidence.sha256,disposition:'retain-current',reason:''}))},
    deliveries:authority.deliveries.map(current=>({deliveryId:current.deliveryId,review:{scope:'slice',
      authoritySha256:current.authoritySha256,
      examinedArtifactHashes:[`plans/${current.slice}.md`,`tasks/${current.slice}.md`].map(path=>({path,sha256:hashes.get(path)})),
      evidenceDecisions:localDecisions.get(current.deliveryId)}}))};
  return {input:value,files:proposed,authority,reviewRequest,
    sourceActivationSha256:raw(previous.activationBytes),
    completed:nextContinuity.completed.map(current=>({deliveryId:current.deliveryId,slice:current.slice,
      localRevision:current.localRevision,evidenceSha256:current.evidence.sha256}))};
}

export function finalizeCurrentSetReplacement({proposal,review:decision}) {
  if(decision===null || decision===undefined)stale('independent set review is absent');
  const fresh=prepareCurrentSetReplacement(proposal.input);
  if(fresh.sourceActivationSha256!==proposal.sourceActivationSha256
    || !same(fresh.reviewRequest,proposal.reviewRequest))stale('set proposal or predecessor changed after review');
  exact(decision,['globalReview','deliveries'],'set replacement review');
  const hashes=new Map(fresh.authority.artifactHashes.map(item=>[item.path,item.sha256]));
  review(decision.globalReview,'set',fresh.authority.globalReviewAuthoritySha256,
    ['plan.md','tasks.md'],hashes,'set replacement global review',
    fresh.reviewRequest.globalReview.evidenceDecisions.map(({deliveryId,evidenceSha256,disposition})=>
      ({deliveryId,evidenceSha256,disposition})));
  if(array(decision.deliveries,'set replacement delivery reviews').length!==fresh.authority.deliveries.length)
    stale('set replacement delivery review count differs');
  const deliveries=fresh.authority.deliveries.map((current,index)=>{
    const local=exact(decision.deliveries[index],['deliveryId','review'],'set replacement delivery review');
    if(local.deliveryId!==current.deliveryId)stale('set replacement delivery review identity differs');
    const request=fresh.reviewRequest.deliveries[index].review;
    review(local.review,'slice',current.authoritySha256,request.examinedArtifactHashes.map(item=>item.path),
      hashes,'set replacement local review',request.evidenceDecisions.map(({deliveryId,evidenceSha256,disposition})=>
        ({deliveryId,evidenceSha256,disposition})));
    return {slice:current.slice,deliveryId:current.deliveryId,localRevision:current.localRevision,
      review:parseCurrentJson(canonical(local.review))};
  });
  const snapshot={format:'stnl-preparation-v3',preparationRevision:fresh.authority.preparationRevision,
    requirementsAuthority:fresh.authority.requirementsAuthority,normativeSha256:fresh.authority.normativeSha256,
    normativeProjection:fresh.authority.normativeProjection,
    globalReview:parseCurrentJson(canonical(decision.globalReview)),deliveries,completed:fresh.completed,
    reviewedArtifacts:fresh.authority.artifactHashes.map(item=>({path:item.path,sha256:item.sha256,
      utf8:fresh.files.get(item.path).toString('utf8')}))};
  const bytes=Buffer.from(canonical(snapshot)+'\n','utf8'),files=new Map(fresh.files);
  files.set('approved-preparation.json',bytes);
  validateCurrentCandidate({files});
  validateCurrentPreparation({context:fresh.input.context,requirementsAuthority:fresh.input.requirementsAuthority,
    snapshotBytes:bytes,artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,files.get(item.path)])),
    profile:fresh.completed.length?'completed-current':'converted-current'});
  return {files,authority:fresh.authority,snapshot,bytes,sha256:raw(bytes)};
}
