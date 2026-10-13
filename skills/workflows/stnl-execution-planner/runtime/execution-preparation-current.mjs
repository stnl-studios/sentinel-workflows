import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCurrentJson, logicalArtifactPath, resolveLogicalProductClaim } from './execution-current.mjs';

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
function carrier(text, filename, heading, expectedSections = null) {
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
    if (!value || /^#{1,6} /mu.test(value)) invalid(`${filename}: empty or hidden section ${found[i][1]}`);
    if (found[i][1] !== 'Verification Recipe') populated(value, `${filename} ${found[i][1]}`);
    sections[found[i][1]] = value;
  }
  return {metadata, sections};
}
function table(body, header, label) {
  const source = lines(body, label);
  if (source.length < 3 || source[0] !== header[0] || source[1] !== header[1]) invalid(`${label}: invalid table header`);
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
function claims(body, context, artifact, label, typed = false, required = false) {
  if (body === '- none' && !required) return [];
  const result = [];
  for (const line of lines(body, label)) {
    const found = typed ? /^- (file|directory): `([^`]+)`$/u.exec(line) : /^- `([^`]+)`$/u.exec(line);
    if (!found) invalid(`${label}: invalid path carrier`);
    const kind = typed ? found[1] : null, rawPath = typed ? found[2] : found[1];
    const target = resolveLogicalProductClaim(context, artifact, rawPath);
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
    const found = /^- (obligation-[0-9]{2,}) \| requirement: ([A-Z][A-Z0-9]*-[0-9]+) \| contribution: (complete|partial) \| full owner: (slice-[0-9]{2,}) \| condition: ([^|]+) \| proof: ([^|]+)$/u.exec(line);
    if (!found) invalid(`${label}: invalid obligation`);
    const item = {id: found[1], requirement: found[2], contribution: found[3], fullOwner: found[4],
      condition: populated(found[5].trim(), label), proof: populated(found[6].trim(), label)};
    slice(item.fullOwner, label);
    const n = Number(item.id.slice('obligation-'.length));
    if (!Number.isSafeInteger(n) || n < 1 || result.some(other => Number(other.id.slice('obligation-'.length)) === n)) invalid(`${label}: duplicate or invalid obligation ID`);
    result.push(item);
  }
  if (!result.length) invalid(`${label}: obligations required`);
  return result;
}
function checklist(body, declared, label) {
  const seen = new Set(), covered = new Set();
  for (const line of lines(body, label)) {
    const found = /^- \[ \] ([0-9]+\.[0-9]+) (\S.*) \| obligations: (obligation-[0-9]{2,}(?:, obligation-[0-9]{2,})*)$/u.exec(line);
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

function project(value, withReview = false) {
  const artifacts = input(value, withReview), context = value.context, expectedAuthority = value.requirementsAuthority;
  const texts = new Map();
  for (const [name, bytes] of artifacts) texts.set(name, decode(bytes, name));
  if (!texts.has('plan.md') || !texts.has('tasks.md')) invalid('preparation requires plan.md and tasks.md');
  const plan = carrier(texts.get('plan.md'), 'plan.md', 'Execution Plan', PLAN_SECTIONS);
  const global = inline(plan.sections['Global Context'], ['Requirements source', 'Requirements authority', 'Plan revision', 'Objective', 'Strategy', 'Review state'], 'plan.md Global Context');
  sourceClaim(global['Requirements source'], context, 'plan.md', 'plan.md Requirements source');
  hash(global['Requirements authority'], 'plan.md authority');
  if (global['Requirements authority'] !== expectedAuthority) changed('plan.md requirements authority differs');
  if (global['Plan revision'] !== '1') invalid('plan.md: initial revision must be 1');
  if (global['Review state'] !== (plan.metadata.status === 'ready' ? 'approved' : 'pending')) invalid('plan.md: review state differs from status');
  const serialRows = table(plan.sections['Serial Slice Order'], PLAN_TABLE, 'plan.md Serial Slice Order').map(columns => {
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
  const indexRows = table(taskIndex.body, TASK_TABLE, 'tasks.md');
  if (indexRows.length !== serialRows.length) invalid('tasks.md row count differs');
  const seen = new Map(), serialIndex = new Map(serialRows.map((row, index) => [row.slice, index]));
  for (let index = 0; index < serialRows.length; index += 1) {
    const row = serialRows[index], columns = indexRows[index], indexIdentity = serial(columns[1], 'tasks.md Slice');
    if (columns[0] !== '[ ]' || columns[5] !== 'pending' || columns[6] !== 'pending'
      || indexIdentity.slice !== row.slice || indexIdentity.name !== row.name
      || columns[2] !== row.delivery || columns[3] !== (row.dependencies.length ? row.dependencies.join(', ') : '-')
      || columns[4] !== `tasks/${row.slice}.md`) invalid(`${row.slice}: Tasks index differs from Plan`);
    const priorIndexes = row.dependencies.map(dep => serialIndex.get(dep));
    if (priorIndexes.some(position => position === undefined || position >= index)
      || priorIndexes.some((position, i) => i > 0 && position <= priorIndexes[i - 1])) invalid(`${row.slice}: dependency is not prior and serial`);
  }
  const deliveries = [], projectionLeaves = [], obligationRows = [];
  for (const row of serialRows) {
    const planName = `plans/${row.slice}.md`, taskName = `tasks/${row.slice}.md`;
    const detail = carrier(texts.get(planName), planName, `Slice ${row.number} - ${row.name}`, DETAIL_SECTIONS);
    const task = carrier(texts.get(taskName), taskName, `Slice ${row.number} Tasks - ${row.name}`, TASK_SECTIONS);
    if (detail.metadata.status !== plan.metadata.status || task.metadata.status !== plan.metadata.status) invalid(`${row.slice}: mixed statuses`);
    const detailRefs = inline(detail.sections.References,
      ['Slice', 'Delivery ID', 'Requirements source', 'Requirements authority', 'Plan revision', 'Local revision', 'Global plan', 'Review state'], `${planName} References`);
    const taskRefs = inline(task.sections.References,
      ['Slice', 'Delivery ID', 'Plan', 'Requirements source', 'Requirements authority', 'Plan revision', 'Local revision', 'Global tasks'], `${taskName} References`);
    if (detailRefs.Slice !== row.number || taskRefs.Slice !== row.number || detailRefs['Plan revision'] !== '1'
      || taskRefs['Plan revision'] !== '1' || detailRefs['Local revision'] !== '1' || taskRefs['Local revision'] !== '1'
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
    checklist(task.sections.Checklist, declared, `${taskName} Checklist`);
    const continuity = inline(task.sections.Continuity, ['Current validation', 'Current evidence', 'Current action'], `${taskName} Continuity`);
    if (continuity['Current validation'] !== 'unvalidated' || continuity['Current evidence'] !== 'none'
      || continuity['Current action'] !== 'implement approved delivery') invalid(`${row.slice}: nonpristine continuity`);
    for (const name of NONE_SECTIONS) if (task.sections[name] !== '- none') invalid(`${row.slice}: nonpristine ${name}`);
    for (const name of ['Changed Areas', 'Diff Summary', 'Final Result']) if (task.sections[name] !== '- pending') invalid(`${row.slice}: nonpristine ${name}`);
    if (task.sections.Result !== row.delivery) invalid(`${row.slice}: observable delivery differs from Task Result`);
    const leaf = {
      deliveryId: detailRefs['Delivery ID'], objectiveAndObservableResult: detail.sections['Objective and Observable Result'],
      requirements: detail.sections.Requirements, includedScope: detail.sections['Included Scope'],
      outOfScopeAndBoundaries: detail.sections['Out of Scope and Boundaries'], authorizedAreas: detail.sections['Authorized Areas'],
      existingInputs: detail.sections['Existing Inputs'], protectedResponsibilities: detail.sections['Protected Responsibilities'],
      dependencies: row.dependencies.map(dep => {
        const source = deliveries.find(item => item.slice === dep);
        if (!source) invalid(`${row.slice}: dependency UUID unavailable`);
        return source.deliveryId;
      }),
      risksAndStrategy: detail.sections['Risks and Strategy'], expectedTests: detail.sections['Expected Tests'],
      verificationRecipe: planRecipe, completionCriterion: detail.sections['Completion Criterion'],
      taskResult: task.sections.Result, obligations: declared,
    };
    deliveries.push({slice: row.slice, deliveryId: leaf.deliveryId, localRevision: 1, authoritySha256: projected('delivery', leaf)});
    projectionLeaves.push(leaf);
    obligationRows.push({slice: row.slice, requirements: row.requirements, obligations: declared, dependencies: row.dependencies});
  }
  const owners = new Map();
  for (const row of obligationRows) for (const obligation of row.obligations) {
    if (obligation.contribution === 'complete') {
      if (obligation.fullOwner !== row.slice) invalid(`${row.slice}: complete obligation has another owner`);
      const previous = owners.get(obligation.requirement);
      if (previous && previous !== row.slice) invalid(`${obligation.requirement}: multiple integral owners`);
      owners.set(obligation.requirement, row.slice);
    }
  }
  const dependenciesOf = new Map(obligationRows.map(row => [row.slice, row.dependencies]));
  const dependsOn = (owner, predecessor) => (dependenciesOf.get(owner) ?? []).some(dep => dep === predecessor || dependsOn(dep, predecessor));
  for (const row of obligationRows) for (const obligation of row.obligations) {
    const owner = owners.get(obligation.requirement);
    if (!owner || obligation.fullOwner !== owner) invalid(`${obligation.requirement}: missing or mismatched integral owner`);
    if (obligation.contribution === 'partial' && (!dependsOn(owner, row.slice)
      || serialIndex.get(owner) <= serialIndex.get(row.slice))) invalid(`${obligation.requirement}: partial owner must depend on earlier contribution`);
  }
  const normativeProjection = {format: 'stnl-preparation-projection-v3', requirementsAuthority: expectedAuthority,
    global: {objective: normalized(global.Objective), strategy: normalized(global.Strategy), risks: plan.sections['Global Risks and Integration'],
      order: deliveries.map(item => item.deliveryId)}, deliveries: projectionLeaves, completed: []};
  const globalReviewProjection = {requirementsAuthority: expectedAuthority, global: normativeProjection.global,
    deliveryIds: deliveries.map(item => item.deliveryId), completed: []};
  const artifactHashes = [...artifacts].map(([name, bytes]) => ({path: name, sha256: raw(bytes)})).sort((a, b) => ordinal(a.path, b.path));
  return {authority: {requirementsAuthority: expectedAuthority, preparationRevision: 1, normativeProjection,
    normativeSha256: projected('preparation', normativeProjection),
    globalReviewAuthoritySha256: projected('global-review', globalReviewProjection), deliveries, artifactHashes},
  status: plan.metadata.status, texts};
}

export function projectInitialPreparation(value) { return project(value).authority; }

function review(value, expectedScope, expectedHash, paths, hashes, label) {
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
  if (value.evidenceDecisions.length !== 0) invalid(`${label}: initial review cannot decide evidence`);
  populated(value.summary, `${label}.summary`);
  return value;
}

export function approveInitialPreparation(value) {
  plain(value, 'preparation input');
  if (!Object.hasOwn(value, 'review') || value.review === null) stale('initial review is absent');
  const {authority, status, texts} = project(value, true);
  if (status !== 'ready') stale('initial preparation is not ready for approval');
  exact(value.review, ['globalReview', 'deliveries'], 'initial review');
  const hashes = new Map(authority.artifactHashes.map(item => [item.path, item.sha256]));
  review(value.review.globalReview, 'set', authority.globalReviewAuthoritySha256, ['plan.md', 'tasks.md'], hashes, 'global review');
  array(value.review.deliveries, 'delivery reviews');
  if (value.review.deliveries.length !== authority.deliveries.length) stale('delivery review count differs');
  const reviewedDeliveries = [];
  for (let i = 0; i < authority.deliveries.length; i += 1) {
    const target = authority.deliveries[i], supplied = exact(value.review.deliveries[i], ['deliveryId', 'review'], `delivery review ${i}`);
    uuid(supplied.deliveryId, `delivery review ${i}.deliveryId`);
    if (supplied.deliveryId !== target.deliveryId) stale(`delivery review ${i}: identity differs`);
    review(supplied.review, 'slice', target.authoritySha256,
      [`plans/${target.slice}.md`, `tasks/${target.slice}.md`], hashes, `delivery review ${target.slice}`);
    reviewedDeliveries.push({slice: target.slice, deliveryId: target.deliveryId, localRevision: 1,
      review: parseCurrentJson(canonical(supplied.review))});
  }
  const snapshot = {format: 'stnl-preparation-v3', preparationRevision: 1,
    requirementsAuthority: authority.requirementsAuthority, normativeSha256: authority.normativeSha256,
    normativeProjection: authority.normativeProjection, globalReview: parseCurrentJson(canonical(value.review.globalReview)),
    deliveries: reviewedDeliveries, completed: [],
    reviewedArtifacts: authority.artifactHashes.map(item => ({path: item.path, sha256: item.sha256, utf8: texts.get(item.path)}))};
  const bytes = Buffer.from(canonical(snapshot) + '\n', 'utf8');
  return {authority, snapshot, bytes, sha256: raw(bytes)};
}

export function validateInitialApprovedPreparation(value) {
  exact(value, ['context', 'requirementsAuthority', 'snapshotBytes'], 'snapshot input');
  hash(value.requirementsAuthority, 'requirementsAuthority');
  logicalArtifactPath(value.context, 'plan.md');
  const bytes = Buffer.from(value.snapshotBytes instanceof Uint8Array ? value.snapshotBytes : invalid('snapshot bytes required'));
  const snapshot = parseCurrentJson(decode(bytes, 'approved-preparation.json'));
  plain(snapshot, 'approved-preparation.json');
  if (!Object.hasOwn(snapshot, 'format')) fail('CURRENT_FORMAT_REQUIRED', 'approved-preparation.json: format required');
  if (snapshot.format === 'stnl-preparation-v2') fail('MIGRATION_REQUIRED', 'approved-preparation.json: legacy format');
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
