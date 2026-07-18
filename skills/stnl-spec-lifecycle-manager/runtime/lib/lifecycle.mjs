import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  ValidationError,
  canonicalPathWithoutSymlinks,
  compareCodePoints,
  expandUser,
  fail,
  filesystemComponentKey,
  isOsMetadata,
  lexists,
  lstatOrNull,
  sorted,
} from './core.mjs';
import { exactObject, parseStrictJson } from './strict-json.mjs';

// TextDecoder strips a leading UTF-8 BOM unless ignoreBOM is enabled.  The
// predecessor runtime decoded with strict UTF-8 and therefore preserved U+FEFF
// as content, which makes BOM-prefixed Markdown and JSON fail their canonical
// grammars instead of silently normalizing input bytes.
const lifecycleUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decodeLifecycleUtf8(buffer) {
  return lifecycleUtf8.decode(buffer);
}

export { ValidationError, canonicalPathWithoutSymlinks, filesystemComponentKey, isOsMetadata };

export const HEADER_FIELDS = [
  'purpose', 'status', 'read_when', 'do_not_read_when', 'contains', 'owner', 'update_policy',
];
const HEADER_STATUSES = new Set(['draft', 'ready', 'blocked', 'done', 'closed', 'not_applicable']);
const FEATURE_ACTIVE_STATUSES = new Set(['draft', 'ready', 'blocked']);
const CANONICAL_PREFIXES = ['R', 'AC', 'D', 'C', 'RK', 'Q'];
const CANONICAL_ID_SOURCE = '(?:AC|RK|R|D|C|Q)-[0-9]{3}';
const CANONICAL_ID_RE = new RegExp(`^${CANONICAL_ID_SOURCE}$`, 'u');
const CANONICAL_HEADING_RE = new RegExp(`^### (?<id>${CANONICAL_ID_SOURCE}) — (?<title>\\S.*)$`, 'u');
const METADATA_RE = /^- (?<field>[a-z_]+): (?<value>.+)$/u;
const TEMPLATE_PLACEHOLDER_RE = /\{\{(?:FEATURE_NAME|OBJECTIVE|ITEM_TITLE|CONTENT)\}\}/u;

const RESUME_MANIFEST_VERSION = 1;
const RESUME_MANIFEST_FIELDS = new Set([
  'schema_version', 'mode', 'workspace_identity', 'allowed_feature_sections',
  'allowed_existing_ids', 'allowed_new_ids', 'allowed_status_transitions',
  'allowed_record_status_transitions',
]);
const RESUME_IDENTITY_FIELDS = new Set(['h1', 'pre_state_sha256']);
const RESUME_STATUS_TRANSITION_FIELDS = new Set(['path', 'from', 'to']);
const RESUME_RECORD_STATUS_TRANSITION_FIELDS = new Set(['path', 'id', 'from', 'to']);
const RESUME_STATUS_PATH_RE = /^(?:feature_spec\.md|shared\/(?:requirements|acceptance-criteria|decisions|constraints|risks|questions)\.md)$/u;
const RESUME_RECORD_STATUS_TRANSITIONS = new Map([
  ['R', new Set(['in_scope\0out_of_scope', 'out_of_scope\0in_scope', 'in_scope\0superseded', 'out_of_scope\0superseded', 'in_scope\0retired', 'out_of_scope\0retired'])],
  ['AC', new Set(['active\0superseded', 'active\0dropped', 'active\0retired'])],
  ['D', new Set(['accepted\0superseded', 'accepted\0retired'])],
  ['C', new Set(['active\0retired'])],
  ['RK', new Set(['active\0retired'])],
  ['Q', new Set(['open\0resolved', 'open\0bypassed', 'open\0dropped'])],
]);

function category(key, filename, prefix, rootHeading, fields, required, statuses, sections = []) {
  return { key, filename, prefix, rootHeading, fields, required, statuses: new Set(statuses), sections };
}

export const CATEGORIES = [
  category('requirements', 'requirements.md', 'R', 'Requirements', ['status', 'retired_reason', 'coverage_justification', 'references'], ['status'], ['in_scope', 'out_of_scope', 'superseded', 'retired']),
  category('acceptance_criteria', 'acceptance-criteria.md', 'AC', 'Acceptance Criteria', ['status', 'retired_reason', 'verifies', 'blocked_by', 'references'], ['status', 'verifies'], ['active', 'superseded', 'dropped', 'retired']),
  category('decisions', 'decisions.md', 'D', 'Decisions', ['status', 'retired_reason', 'references'], ['status'], ['accepted', 'superseded', 'retired'], ['Contexto', 'Decisão', 'Impacto']),
  category('constraints', 'constraints.md', 'C', 'Constraints', ['status', 'retired_reason', 'references'], ['status'], ['active', 'retired'], ['Restrição', 'Razão']),
  category('risks', 'risks.md', 'RK', 'Risks', ['status', 'retired_reason', 'impact', 'references'], ['status', 'impact'], ['active', 'retired'], ['Risco', 'Mitigação']),
  category('questions', 'questions.md', 'Q', 'Questions', ['status', 'classification', 'blocks', 'resolved_by', 'linked_decision', 'references'], ['status', 'classification'], ['open', 'resolved', 'bypassed', 'dropped'], ['Pergunta', 'Por que importa', 'Resolução']),
];
const CATEGORY_BY_KEY = new Map(CATEGORIES.map((value) => [value.key, value]));
const CATEGORY_BY_FILENAME = new Map(CATEGORIES.map((value) => [value.filename, value]));
const CATEGORY_BY_PREFIX = new Map(CATEGORIES.map((value) => [value.prefix, value]));
const CATEGORY_ORDER = CATEGORIES.map((value) => value.key);
const EXPECTED_ARTIFACT_PATHS = new Map(CATEGORIES.map((value) => [value.key, `shared/${value.filename}`]));
const CLOSED_SECTION_PREFIX = new Map([
  ['Requirements', 'R'], ['Final Acceptance Criteria', 'AC'], ['Durable Decisions', 'D'],
  ['Relevant Constraints', 'C'], ['Relevant Risks', 'RK'], ['Durable Resolved Questions', 'Q'],
]);

export const ACTIVE_SECTIONS = [
  'Objective', 'Context', 'Scope', 'Out of Scope', 'Requirements', 'Business Rules',
  'Relevant Contracts', 'Canonical Artifact Index', 'Blockers', 'Selective Reading',
];
const CLOSED_CORE_SECTIONS = [
  'Objective', 'Context', 'Final Scope', 'Out of Scope', 'Requirements', 'Business Rules',
  'Important Contracts',
];

function splitLines(text) {
  const source = String(text);
  const lines = source.split(/\r\n|\n|\r/u);
  if (/(?:\r\n|\n|\r)$/u.test(source)) lines.pop();
  return lines;
}

export function normalize(text) {
  const lines = splitLines(String(text).trim()).map((line) => line.trimEnd());
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

function containsTemplatePlaceholder(text) {
  return TEMPLATE_PLACEHOLDER_RE.test(text);
}

function isNonMaterialRetiredReason(text) {
  if (containsTemplatePlaceholder(text)) return true;
  const normalized = text.trim().toLocaleLowerCase('und').normalize('NFKD').replace(/\p{M}/gu, '');
  if (![...normalized].some((character) => /[\p{L}\p{N}]/u.test(character))) return true;
  const words = normalized.match(/[a-z0-9]+/gu) ?? [];
  if (!words.length) return false;
  const compact = words.join('');
  const aliases = new Set([
    'adefinir', 'archived', 'arquivado', 'arquivada', 'deleted', 'excluida', 'none', 'na',
    'notapplicable', 'notprovided', 'obsolete', 'obsoleta', 'obsoleto', 'pending',
    'placeholder', 'pordefinir', 'retirado', 'retirada', 'retirados', 'retiradas', 'retired',
    'removido', 'removida', 'removidos', 'removidas', 'excluido', 'excluidos', 'excluidas',
    'semmotivo', 'tbd', 'tobedefined', 'tobedetermined', 'todo', 'todolater', 'unknown', 'removed',
  ]);
  if (aliases.has(compact)) return true;
  const prefixes = [
    ['a', 'definir'], ['a', 'ser', 'definida'], ['a', 'ser', 'definido'], ['not', 'provided'],
    ['por', 'definir'], ['por', 'determinar'], ['sem', 'motivo'], ['to', 'be', 'defined'],
    ['to', 'be', 'determined'],
  ];
  return ['pending', 'placeholder', 'tbd', 'todo'].includes(words[0])
    || prefixes.some((prefix) => prefix.every((word, index) => words[index] === word));
}

function readText(file) {
  const metadata = lstatOrNull(file);
  if (metadata === null || !metadata.isFile()) fail('required file does not exist', file);
  return decodeLifecycleUtf8(fs.readFileSync(file));
}

export function parseFilePurposeHeader(file) {
  const text = readText(file);
  const match = text.match(/^# File Purpose Header\n\n```yaml\n([\s\S]*?)```\n/u);
  if (match === null) fail('missing normalized File Purpose Header', file);
  const data = Object.create(null);
  const order = [];
  for (const line of splitLines(match[1])) {
    if (!line.trim() || !line.includes(':')) fail('malformed File Purpose Header line', file);
    const separator = line.indexOf(':');
    const field = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (Object.hasOwn(data, field)) fail(`duplicate File Purpose Header field ${field}`, file);
    order.push(field);
    data[field] = value;
  }
  if (JSON.stringify(order) !== JSON.stringify(HEADER_FIELDS)) {
    fail(`File Purpose Header fields must be [${HEADER_FIELDS.map((field) => `'${field}'`).join(', ')}]`, file);
  }
  const empty = HEADER_FIELDS.filter((field) => !data[field]);
  if (empty.length) fail(`File Purpose Header fields must be non-empty: [${empty.map((field) => `'${field}'`).join(', ')}]`, file);
  const placeholders = HEADER_FIELDS.filter((field) => containsTemplatePlaceholder(data[field]));
  if (placeholders.length) fail(`File Purpose Header fields contain placeholder content: [${placeholders.map((field) => `'${field}'`).join(', ')}]`, file);
  if (!HEADER_STATUSES.has(data.status)) fail(`invalid File Purpose Header status '${data.status}'`, file);
  if (data.owner !== 'stnl-spec-lifecycle-manager') fail('wrong File Purpose Header owner', file);
  return [data, text.slice(match[0].length)];
}

function validateFeatureRoot(text, file) {
  if (!text.startsWith('\n') || text.startsWith('\n\n')) {
    fail('feature H1 must be the first semantic content after the File Purpose Header', file);
  }
  const semantic = text.slice(1);
  const firstLine = splitLines(semantic)[0] ?? '';
  if (!/^# \S(?:.*\S)? - Feature SPEC$/u.test(firstLine)) {
    fail("feature must start with canonical '# <name> - Feature SPEC' H1", file);
  }
  if (containsTemplatePlaceholder(firstLine)) fail('feature H1 contains placeholder content', file);
  const headings = semantic.match(/^# .+$/gmu) ?? [];
  if (headings.length !== 1 || headings[0] !== firstLine) fail('feature must contain exactly one canonical H1', file);
  return semantic;
}

function h2Sections(text, file) {
  const regex = /^## (?<name>[^\n]+)\n/gmu;
  const matches = [...text.matchAll(regex)];
  const sections = new Map();
  const order = [];
  matches.forEach((match, index) => {
    const name = match.groups.name.trim();
    if (sections.has(name)) fail(`duplicate section '${name}'`, file);
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    sections.set(name, normalize(text.slice(match.index + match[0].length, end)));
    order.push(name);
  });
  return [sections, order];
}

function requireSections(sections, order, required, file) {
  const missing = required.filter((name) => !sections.has(name));
  if (missing.length) fail(`missing required sections: [${missing.map((name) => `'${name}'`).join(', ')}]`, file);
  const positions = required.map((name) => order.indexOf(name));
  if (positions.some((position, index) => index > 0 && position < positions[index - 1])) {
    fail(`required sections are out of order: [${required.map((name) => `'${name}'`).join(', ')}]`, file);
  }
  for (const name of required) {
    if (!sections.get(name)) fail(`section '${name}' is empty`, file);
    if (containsTemplatePlaceholder(sections.get(name))) fail(`section '${name}' contains placeholder content`, file);
  }
}

function validateContext(section, file) {
  const matches = [...section.matchAll(/^### (?<name>Facts|Hypotheses)\n/gmu)];
  if (matches.map((match) => match.groups.name).join('\0') !== 'Facts\0Hypotheses') {
    fail('Context must contain Facts then Hypotheses headings exactly once', file);
  }
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : section.length;
    if (!normalize(section.slice(match.index + match[0].length, end))) {
      fail(`Context subsection ${match.groups.name} is empty`, file);
    }
  });
}

function extractYamlFence(section, label, file) {
  const match = normalize(section).match(/^```yaml\n([\s\S]*?)\n```$/u);
  if (match === null) fail(`${label} must contain exactly one compact YAML block`, file);
  return splitLines(match[1]);
}

function parseArtifactIndex(section, file) {
  const lines = extractYamlFence(section, 'Canonical Artifact Index', file);
  if (lines.length === 1 && lines[0] === 'artifacts: {}') return new Map();
  if (!lines.length || lines[0] !== 'artifacts:') {
    fail("artifact index must start with 'artifacts:' or be 'artifacts: {}'", file);
  }
  const artifacts = new Map();
  const order = [];
  for (const line of lines.slice(1)) {
    const match = line.match(/^  ([a-z_]+): (shared\/[a-z-]+\.md)$/u);
    if (match === null) fail(`malformed artifact index entry '${line}'`, file);
    const [, key, value] = match;
    if (!CATEGORY_BY_KEY.has(key)) fail(`unknown artifact category '${key}'`, file);
    if (artifacts.has(key)) fail(`duplicate artifact category '${key}'`, file);
    if (value !== EXPECTED_ARTIFACT_PATHS.get(key)) fail(`wrong path for artifact category '${key}'`, file);
    artifacts.set(key, value);
    order.push(key);
  }
  const expected = CATEGORY_ORDER.filter((key) => artifacts.has(key));
  if (order.join('\0') !== expected.join('\0')) fail('artifact categories are not in deterministic order', file);
  return artifacts;
}

function parseIdArray(value, field, file, { allowedPrefixes = null, allowEmpty = false } = {}) {
  if (!value.startsWith('[') || !value.endsWith(']')) fail(`${field} must use [ID-001, ID-002] array syntax`, file);
  const inner = value.slice(1, -1);
  const values = inner ? inner.split(', ') : [];
  if (!values.length && !allowEmpty) fail(`optional empty ${field} must be omitted`, file);
  if (value !== `[${values.join(', ')}]`) fail(`${field} array spacing is not canonical`, file);
  if (new Set(values).size !== values.length) fail(`${field} contains duplicate IDs`, file);
  for (const identifier of values) {
    if (!CANONICAL_ID_RE.test(identifier)) fail(`${field} contains malformed canonical ID '${identifier}'`, file);
    const prefix = identifier.split('-', 1)[0];
    if (allowedPrefixes !== null && !allowedPrefixes.has(prefix)) fail(`${field} contains incompatible prefix in ${identifier}`, file);
  }
  return values;
}

function parseRequirementIndex(section, file) {
  const lines = splitLines(normalize(section));
  if (lines.length === 1 && lines[0] === '- Not established.') return [];
  const identifiers = [];
  for (const line of lines) {
    const match = line.match(/^- (R-[0-9]{3})$/u);
    if (match === null) fail("Requirements must be a derived '- R-###' index or '- Not established.'", file);
    identifiers.push(match[1]);
  }
  if (new Set(identifiers).size !== identifiers.length) fail('Requirements index contains duplicate IDs', file);
  if (identifiers.join('\0') !== sorted(identifiers).join('\0')) fail('Requirements index must be sorted', file);
  return identifiers;
}

function parseBlockers(section, file) {
  const lines = extractYamlFence(section, 'Blockers', file);
  if (lines.length < 2) fail('Blockers must define blocking_questions and documentary_gaps', file);
  const blocking = lines[0].match(/^blocking_questions: (\[.*\])$/u);
  if (blocking === null) fail('Blockers fields are missing or out of order', file);
  const blockingQuestions = parseIdArray(blocking[1], 'blocking_questions', file, { allowedPrefixes: new Set(['Q']), allowEmpty: true });
  let gaps;
  if (lines[1] === 'documentary_gaps: []') {
    if (lines.length !== 2) fail('unexpected content after documentary_gaps', file);
    gaps = [];
  } else if (lines[1] === 'documentary_gaps:') {
    gaps = [];
    for (const line of lines.slice(2)) {
      const match = line.match(/^  - (\S.*)$/u);
      if (match === null) fail(`malformed documentary gap '${line}'`, file);
      const value = match[1].trim();
      if (!value || ['none', 'n/a', 'null'].includes(value.toLocaleLowerCase('und'))) {
        fail('documentary_gaps contains a non-material placeholder', file);
      }
      gaps.push(value);
    }
    if (!gaps.length) fail('empty documentary_gaps list must use []', file);
    if (new Set(gaps).size !== gaps.length) fail('documentary_gaps contains duplicates', file);
  } else {
    fail('documentary_gaps is malformed or out of order', file);
  }
  return [blockingQuestions, gaps];
}

function parseNarrativeSections(narrative, valueCategory, file) {
  if (!valueCategory.sections.length) {
    if (/^#{1,6} /mu.test(narrative)) fail(`${valueCategory.prefix} narrative cannot contain nested headings`, file);
    return new Map();
  }
  const all = [...narrative.matchAll(/^(?<marks>#{1,6}) (?<name>[^\n]+)\n/gmu)];
  if (all.some((match) => match.groups.marks !== '####')) {
    fail(`${valueCategory.prefix} narrative sections must use only canonical level-4 headings`, file);
  }
  const matches = [...narrative.matchAll(/^#### (?<name>[^\n]+)\n/gmu)];
  const names = matches.map((match) => match.groups.name);
  if (names.join('\0') !== valueCategory.sections.join('\0')) {
    fail(`${valueCategory.prefix} narrative sections must be [${valueCategory.sections.map((name) => `'${name}'`).join(', ')}]`, file);
  }
  const sections = new Map();
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : narrative.length;
    const content = normalize(narrative.slice(match.index + match[0].length, end));
    if (!content || containsTemplatePlaceholder(content)) fail(`section '${match.groups.name}' is empty or placeholder`, file);
    sections.set(match.groups.name, content);
  });
  return sections;
}

function canonicalIdSort(left, right) {
  const [leftPrefix, leftSuffix] = left.split('-');
  const [rightPrefix, rightSuffix] = right.split('-');
  return CANONICAL_PREFIXES.indexOf(leftPrefix) - CANONICAL_PREFIXES.indexOf(rightPrefix)
    || Number(leftSuffix) - Number(rightSuffix);
}

function itemPreservationSignature(item) {
  const metadata = item.category.fields.filter((field) => item.metadata.has(field)).map((field) => [field, item.metadata.get(field)]);
  const sections = item.category.sections.map((name) => [name, item.sections.get(name) ?? '']);
  return JSON.stringify([item.title, metadata, item.rawNarrative, sections]);
}

function parseItems(text, file, { expectedPrefix = null, sharedFile = false } = {}) {
  const h3 = [...text.matchAll(/^### (?<heading>[^\n]+)$/gmu)];
  const h2 = [...text.matchAll(/^## (?<heading>[^\n]+)$/gmu)];
  const canonical = [];
  for (const match of h3) {
    const full = `### ${match.groups.heading}`;
    const parsed = full.match(CANONICAL_HEADING_RE);
    if (parsed === null) {
      const beginsLikeId = new RegExp(`^(?:${CANONICAL_ID_SOURCE})\\b`, 'u').test(match.groups.heading);
      if (sharedFile || beginsLikeId) fail(`non-canonical item heading '${full}'`, file);
      continue;
    }
    canonical.push([match, parsed]);
  }
  const items = [];
  const seen = new Set();
  for (const [match, parsed] of canonical) {
    const identifier = parsed.groups.id;
    const prefix = identifier.split('-', 1)[0];
    if (expectedPrefix !== null && prefix !== expectedPrefix) fail(`prefix ${prefix} is incompatible with this category file`, file);
    const valueCategory = CATEGORY_BY_PREFIX.get(prefix);
    if (containsTemplatePlaceholder(parsed.groups.title)) fail(`${identifier} title contains placeholder content`, file);
    if (seen.has(identifier)) fail(`duplicate canonical ID ${identifier}`, file);
    seen.add(identifier);
    const nextH3 = h3.find((candidate) => candidate.index > match.index)?.index ?? text.length;
    const nextH2 = h2.find((candidate) => candidate.index > match.index)?.index ?? text.length;
    const end = sharedFile ? nextH3 : Math.min(nextH3, nextH2);
    const body = text.slice(match.index + match[0].length, end);
    if (!body.startsWith('\n\n')) fail(`${identifier} must have one blank line before metadata`, file);
    const lines = splitLines(body.slice(2));
    const metadataLines = [];
    let index = 0;
    while (index < lines.length && lines[index].startsWith('- ')) {
      const metadataMatch = lines[index].match(METADATA_RE);
      if (metadataMatch === null) fail(`malformed metadata line in ${identifier}: '${lines[index]}'`, file);
      metadataLines.push([metadataMatch.groups.field, metadataMatch.groups.value]);
      index += 1;
    }
    if (!metadataLines.length) fail(`${identifier} has no metadata`, file);
    if (index >= lines.length || lines[index] !== '') fail(`${identifier} metadata must be followed by one blank line`, file);
    const rawNarrativeLines = lines.slice(index + 1);
    while (rawNarrativeLines.length && rawNarrativeLines.at(-1) === '') rawNarrativeLines.pop();
    const rawNarrative = rawNarrativeLines.join('\n');
    const narrative = normalize(rawNarrative);
    if (!narrative) fail(`${identifier} has no narrative content`, file);
    if (lines[index + 1] === '') fail(`${identifier} metadata must be followed by exactly one blank line`, file);
    if (containsTemplatePlaceholder(body)) fail(`${identifier} contains placeholder content`, file);
    if (/^```(?:yaml|yml|markdown)\s*$/gimu.test(narrative)) fail(`${identifier} contains a forbidden item wrapper`, file);
    if (/^\s*-?\s*id\s*:/gimu.test(body)) fail(`${identifier} repeats its ID in the item body`, file);

    const fieldOrder = metadataLines.map(([field]) => field);
    if (new Set(fieldOrder).size !== fieldOrder.length) fail(`${identifier} contains duplicate metadata fields`, file);
    const unknown = fieldOrder.filter((field) => !valueCategory.fields.includes(field));
    if (unknown.length) fail(`${identifier} contains unsupported metadata fields [${unknown.map((field) => `'${field}'`).join(', ')}]`, file);
    const expectedOrder = valueCategory.fields.filter((field) => fieldOrder.includes(field));
    if (fieldOrder.join('\0') !== expectedOrder.join('\0')) fail(`${identifier} metadata order must be [${expectedOrder.map((field) => `'${field}'`).join(', ')}]`, file);
    const missing = valueCategory.required.filter((field) => !fieldOrder.includes(field));
    if (missing.length) fail(`${identifier} is missing required metadata [${missing.map((field) => `'${field}'`).join(', ')}]`, file);
    if (fieldOrder[0] !== 'status') fail(`${identifier} metadata must start with status`, file);

    const metadata = new Map();
    for (const [field, rawValue] of metadataLines) {
      if (rawValue.toLocaleLowerCase('und') === 'null') fail(`${identifier} uses null for ${field}; omit non-applicable optional fields`, file);
      if (field === 'verifies') metadata.set(field, parseIdArray(rawValue, field, file, { allowedPrefixes: new Set(['R']) }));
      else if (field === 'blocked_by') metadata.set(field, parseIdArray(rawValue, field, file, { allowedPrefixes: new Set(['Q']) }));
      else if (field === 'blocks') metadata.set(field, parseIdArray(rawValue, field, file, { allowedPrefixes: new Set(['AC']), allowEmpty: true }));
      else if (field === 'references') metadata.set(field, parseIdArray(rawValue, field, file));
      else metadata.set(field, rawValue);
    }
    const status = metadata.get('status');
    if (!valueCategory.statuses.has(status)) fail(`${identifier} has invalid status '${status}'`, file);
    const retiredReason = metadata.get('retired_reason');
    if (status === 'retired') {
      if (typeof retiredReason !== 'string' || !retiredReason.trim() || isNonMaterialRetiredReason(retiredReason)) {
        fail(`${identifier} retired state requires a non-placeholder retired_reason`, file);
      }
    } else if (retiredReason !== undefined) fail(`${identifier} retired_reason is allowed only for retired records`, file);
    if (prefix === 'RK' && !new Set(['low', 'medium', 'high']).has(metadata.get('impact'))) fail(`${identifier} has invalid impact '${metadata.get('impact')}'`, file);
    const references = metadata.get('references') ?? [];
    if (references.includes(identifier)) fail(`${identifier} has an improper self-reference`, file);
    const sections = parseNarrativeSections(narrative, valueCategory, file);
    if (prefix === 'R' && metadata.has('coverage_justification')) {
      const justification = metadata.get('coverage_justification');
      if (status !== 'in_scope') fail(`${identifier} coverage_justification is allowed only for in_scope requirements`, file);
      if (typeof justification !== 'string') fail(`${identifier} coverage_justification must be textual`, file);
      if (new Set(['none', 'n/a', 'not applicable', 'pending', 'tbd', 'unknown']).has(justification.trim().toLocaleLowerCase('und')) || containsTemplatePlaceholder(justification)) {
        fail(`${identifier} coverage_justification contains placeholder content`, file);
      }
    }
    if (prefix === 'Q') {
      const classification = metadata.get('classification');
      if (!new Set(['blocking', 'non_blocking', 'irrelevant']).has(classification)) fail(`${identifier} has invalid classification '${classification}'`, file);
      const resolvedBy = metadata.get('resolved_by');
      const linkedDecision = metadata.get('linked_decision');
      const resolution = sections.get('Resolução');
      if (status === 'open') {
        if (classification === 'irrelevant') fail(`${identifier} irrelevant questions cannot remain open`, file);
        if (classification === 'blocking' && !metadata.has('blocks')) fail(`${identifier} open blocking state requires blocks`, file);
        if (classification !== 'blocking' && metadata.has('blocks')) fail(`${identifier} non-blocking open state cannot contain blocks`, file);
        if (resolvedBy !== undefined || linkedDecision !== undefined) fail(`${identifier} open state cannot contain final-state metadata`, file);
        if (resolution !== 'Pendente.') fail(`${identifier} open state must use 'Pendente.' resolution`, file);
      } else {
        if (metadata.has('blocks')) fail(`${identifier} final state cannot contain blocks`, file);
        if (!new Set(['answer', 'decision', 'constraint', 'scope_change']).has(resolvedBy)) fail(`${identifier} final state requires valid resolved_by`, file);
        if (new Set(['pendente.', 'pending', 'tbd', 'none', 'n/a', 'unknown']).has(resolution.trim().toLocaleLowerCase('und')) || containsTemplatePlaceholder(resolution)) fail(`${identifier} final state requires an explicit non-placeholder resolution`, file);
        if (status === 'dropped' && resolvedBy !== 'scope_change') fail(`${identifier} dropped state requires resolved_by: scope_change`, file);
        if (classification === 'irrelevant' && status !== 'dropped') fail(`${identifier} irrelevant classification requires dropped status`, file);
        if (resolvedBy === 'decision') {
          if (typeof linkedDecision !== 'string' || !/^D-[0-9]{3}$/u.test(linkedDecision)) fail(`${identifier} decision resolution requires linked_decision: D-*`, file);
        } else if (linkedDecision !== undefined) fail(`${identifier} linked_decision requires resolved_by: decision`, file);
      }
    }
    let parentSection = null;
    if (!sharedFile) {
      const preceding = h2.filter((candidate) => candidate.index < match.index);
      parentSection = preceding.length ? preceding.at(-1).groups.heading : null;
      if (CLOSED_SECTION_PREFIX.get(parentSection ?? '') !== prefix) fail(`${identifier} is under incompatible closed section '${parentSection}'`, file);
    }
    items.push({ identifier, title: parsed.groups.title, category: valueCategory, metadata, narrative, rawNarrative, sections, path: file, parentSection });
  }
  return items;
}

function parseSharedFile(file, valueCategory) {
  let [header, text] = parseFilePurposeHeader(file);
  if (text.startsWith('\n')) text = text.slice(1);
  if (/^```(?:yaml|yml)\s*$/gimu.test(text)) fail('shared category files cannot contain YAML beyond the File Purpose Header', file);
  const rootHeading = `# ${valueCategory.rootHeading}`;
  if (!text.startsWith(`${rootHeading}\n\n`)) fail(`shared category file must start with '# ${valueCategory.rootHeading}' root heading`, file);
  const headings = text.match(/^# .+$/gmu) ?? [];
  if (headings.length !== 1 || headings[0] !== rootHeading) fail('shared category file must contain exactly one expected root heading', file);
  if (/^## .+$/mu.test(text)) fail('shared category files cannot contain extra level-2 headings', file);
  const region = text.slice(rootHeading.length + 2);
  const firstItem = region.match(/^### .+$/mu);
  if (firstItem === null) fail('materialized category file is semantically empty', file);
  if (normalize(region.slice(0, firstItem.index))) fail('shared category file contains content before the first canonical item', file);
  const items = parseItems(text, file, { expectedPrefix: valueCategory.prefix, sharedFile: true });
  if (!items.length) fail('materialized category file is semantically empty', file);
  if (valueCategory.prefix === 'Q') {
    const hasBlocking = items.some((item) => item.metadata.get('status') === 'open' && item.metadata.get('classification') === 'blocking');
    const expected = hasBlocking ? 'blocked' : 'ready';
    if (header.status !== expected) fail(`questions header status must be ${expected}`, file);
  } else if (header.status !== 'ready') fail('materialized non-question category header status must be ready', file);
  return items;
}

function collectRelationshipState(items) {
  const missing = new Set();
  const errors = [];
  const questionPairs = new Set();
  const criterionPairs = new Set();
  for (const item of items.values()) {
    for (const field of ['verifies', 'blocks', 'blocked_by', 'references']) {
      if (!item.metadata.has(field)) continue;
      const values = item.metadata.get(field);
      if (!Array.isArray(values)) continue;
      for (const target of values) if (!items.has(target)) missing.add(target);
      if (field === 'references' && item.category.prefix === 'R' && values.some((target) => target.startsWith('AC-'))) {
        errors.push(`${item.identifier} duplicates coverage through references; AC.verifies is authoritative`);
      }
      if (field === 'references' && item.category.prefix === 'AC' && values.some((target) => target.startsWith('R-'))) {
        errors.push(`${item.identifier} duplicates verifies through references`);
      }
      if (field === 'verifies') {
        if (item.category.prefix !== 'AC') {
          errors.push(`${item.identifier} uses verifies outside an acceptance criterion`);
          continue;
        }
        for (const target of values) {
          const targetItem = items.get(target);
          if (item.metadata.get('status') === 'active' && targetItem && targetItem.metadata.get('status') !== 'in_scope') {
            errors.push(`${item.identifier} verifies non-in-scope requirement ${target}`);
          }
        }
      } else if (field === 'blocks') {
        if (item.category.prefix !== 'Q') {
          errors.push(`${item.identifier} uses blocks outside a question`);
          continue;
        }
        if (item.metadata.get('status') !== 'open') {
          errors.push(`${item.identifier} non-open question cannot contain blocks`);
          continue;
        }
        for (const target of values) questionPairs.add(`${item.identifier}\0${target}`);
      } else if (field === 'blocked_by') {
        if (item.category.prefix !== 'AC') {
          errors.push(`${item.identifier} uses blocked_by outside an acceptance criterion`);
          continue;
        }
        if (item.metadata.get('status') !== 'active') {
          errors.push(`${item.identifier} non-active acceptance criterion cannot contain blocked_by`);
          continue;
        }
        for (const target of values) {
          const targetItem = items.get(target);
          if (targetItem && targetItem.metadata.get('status') !== 'open') errors.push(`${item.identifier} blocked_by points to non-open question ${target}`);
          criterionPairs.add(`${target}\0${item.identifier}`);
        }
      }
    }
    const linked = item.metadata.get('linked_decision');
    if (typeof linked === 'string' && !items.has(linked)) missing.add(linked);
  }
  for (const pair of sorted([...questionPairs].filter((value) => !criterionPairs.has(value)))) {
    const [question, criterion] = pair.split('\0');
    errors.push(`missing inverse blocked_by link for ${question} -> ${criterion}`);
  }
  for (const pair of sorted([...criterionPairs].filter((value) => !questionPairs.has(value)))) {
    const [question, criterion] = pair.split('\0');
    errors.push(`missing inverse blocks link for ${question} -> ${criterion}`);
  }
  return [missing, errors];
}

function validateRequirementCoverage(items, file, { complete }) {
  const requirements = new Map([...items].filter(([, item]) => item.category.prefix === 'R' && item.metadata.get('status') === 'in_scope'));
  const criteria = new Map([...items].filter(([, item]) => item.category.prefix === 'AC' && item.metadata.get('status') === 'active'));
  const covered = new Map([...requirements.keys()].map((identifier) => [identifier, []]));
  for (const criterion of criteria.values()) {
    const verifies = criterion.metadata.get('verifies');
    if (!Array.isArray(verifies) || !verifies.length) fail(`${criterion.identifier} active criterion must verify at least one requirement`, file);
    for (const requirement of verifies) if (covered.has(requirement)) covered.get(requirement).push(criterion.identifier);
  }
  for (const [identifier, requirement] of requirements) {
    const justification = requirement.metadata.get('coverage_justification');
    if (covered.get(identifier).length && justification !== undefined) fail(`${identifier} has stale coverage_justification despite active AC coverage`, file);
    if (complete && !covered.get(identifier).length && justification === undefined) fail(`${identifier} has no active AC coverage or formal coverage_justification`, file);
  }
  if (complete && !requirements.size) fail('ready or closed SPEC requires at least one in-scope requirement', file);
  if (complete && !criteria.size) fail('ready or closed SPEC requires at least one active acceptance criterion', file);
}

function validateActive(root, feature, header, originalText) {
  if (!FEATURE_ACTIVE_STATUSES.has(header.status)) fail(`active feature status must be one of ['blocked', 'draft', 'ready']`, feature);
  const text = validateFeatureRoot(originalText, feature);
  const [sections, order] = h2Sections(text, feature);
  requireSections(sections, order, ACTIVE_SECTIONS, feature);
  if (order.join('\0') !== ACTIVE_SECTIONS.join('\0')) fail(`active feature sections must be exactly [${ACTIVE_SECTIONS.map((name) => `'${name}'`).join(', ')}]`, feature);
  if ((text.match(/^```(?:yaml|yml)\s*$/gimu) ?? []).length !== 2) fail('active feature YAML is limited to Artifact Index and Blockers', feature);
  const h3 = [...text.matchAll(/^### ([^\n]+)$/gmu)].map((match) => match[1]);
  if (h3.join('\0') !== 'Facts\0Hypotheses') fail('active feature permits only Context Facts and Hypotheses level-3 headings', feature);
  if (/^#{4,6} /mu.test(text)) fail('active feature cannot contain nested level-4 through level-6 headings', feature);
  validateContext(sections.get('Context'), feature);
  const artifacts = parseArtifactIndex(sections.get('Canonical Artifact Index'), feature);
  const requirementIndex = parseRequirementIndex(sections.get('Requirements'), feature);
  const [blockingIndex, gaps] = parseBlockers(sections.get('Blockers'), feature);

  const shared = path.join(root, 'shared');
  const actualCategories = new Map();
  if (lexists(shared)) {
    const sharedMetadata = fs.lstatSync(shared);
    if (!sharedMetadata.isDirectory() || sharedMetadata.isSymbolicLink()) fail('shared must be a real directory', shared);
    for (const name of sorted(fs.readdirSync(shared))) {
      const child = path.join(shared, name);
      if (isOsMetadata(path.relative(root, child))) continue;
      const metadata = fs.lstatSync(child);
      if (metadata.isSymbolicLink() || !metadata.isFile() || !CATEGORY_BY_FILENAME.has(name)) fail(`unexpected lifecycle artifact '${name}'`, child);
      if (metadata.nlink !== 1) fail('lifecycle authority must be a single-link regular file', child);
      actualCategories.set(CATEGORY_BY_FILENAME.get(name).key, child);
    }
    if (!actualCategories.size) fail('empty shared/ directory must be absent', shared);
  }
  const artifactKeys = sorted(artifacts.keys());
  const actualKeys = sorted(actualCategories.keys());
  if (artifactKeys.join('\0') !== actualKeys.join('\0')) {
    fail(`artifact index does not exactly match materialized categories; index=[${artifactKeys.map((key) => `'${key}'`).join(', ')}], files=[${actualKeys.map((key) => `'${key}'`).join(', ')}]`, feature);
  }
  for (const [key, relative] of artifacts) if (path.join(root, ...relative.split('/')) !== actualCategories.get(key)) fail(`indexed artifact path does not resolve for ${key}`, feature);

  const items = new Map();
  for (const valueCategory of CATEGORIES) {
    const categoryPath = actualCategories.get(valueCategory.key);
    if (!categoryPath) continue;
    for (const item of parseSharedFile(categoryPath, valueCategory)) {
      if (items.has(item.identifier)) fail(`duplicate canonical ID across workspace: ${item.identifier}`, categoryPath);
      items.set(item.identifier, item);
    }
  }
  const actualOpen = sorted([...items].filter(([, item]) => item.category.prefix === 'Q' && item.metadata.get('status') === 'open').map(([identifier]) => identifier));
  const actualBlocking = sorted([...items].filter(([, item]) => item.category.prefix === 'Q' && item.metadata.get('status') === 'open' && item.metadata.get('classification') === 'blocking').map(([identifier]) => identifier));
  if (blockingIndex.join('\0') !== actualBlocking.join('\0')) fail(`blocking_questions must exactly equal [${actualBlocking.map((value) => `'${value}'`).join(', ')}]`, feature);
  if (blockingIndex.join('\0') !== sorted(blockingIndex).join('\0')) fail('blocking_questions must be sorted', feature);
  const actualRequirements = sorted([...items].filter(([, item]) => item.category.prefix === 'R').map(([identifier]) => identifier));
  if (requirementIndex.join('\0') !== actualRequirements.join('\0')) fail(`Requirements index must exactly equal [${actualRequirements.map((value) => `'${value}'`).join(', ')}]`, feature);
  if (!actualRequirements.length && sections.get('Requirements') !== '- Not established.') fail("a workspace without canonical requirements must use '- Not established.'", feature);
  const [missing, relationshipErrors] = collectRelationshipState(items);
  if (missing.size) fail(`calculated broken_references: [${sorted(missing).map((value) => `'${value}'`).join(', ')}]`, feature);
  if (relationshipErrors.length) fail(relationshipErrors[0], feature);
  validateRequirementCoverage(items, feature, { complete: header.status === 'ready' });
  if (header.status === 'ready') {
    if (!artifacts.has('requirements')) fail('ready SPEC requires indexed requirements', feature);
    if (!artifacts.has('acceptance_criteria')) fail('ready SPEC requires indexed acceptance criteria', feature);
    const activeCriteria = [...items.values()].filter((item) => item.category.prefix === 'AC' && item.metadata.get('status') === 'active');
    if (!activeCriteria.length) fail('ready SPEC requires at least one active acceptance criterion', feature);
    if (activeCriteria.some((item) => item.metadata.has('blocked_by'))) fail('ready SPEC cannot have active acceptance criteria blocked_by open questions', feature);
  }
  const blockersPresent = actualBlocking.length || gaps.length;
  if (actualBlocking.length && header.status !== 'blocked') fail('an open blocking question requires feature status blocked', feature);
  if (header.status === 'ready' && blockersPresent) fail('a ready SPEC cannot have blocking questions or documentary gaps', feature);
  if (header.status === 'blocked' && !blockersPresent) fail('blocked feature status requires an indexed documentary blocker', feature);
  return { root, h1: splitLines(text)[0], status: header.status, closed: false, items, sections, artifacts, openQuestions: actualOpen, blockingQuestions: actualBlocking, brokenReferences: sorted(missing), documentaryGaps: gaps };
}

function validateClosed(root, feature, header, originalText) {
  if (header.status !== 'closed') fail('closed validator requires feature status closed', feature);
  if (lexists(path.join(root, 'shared'))) fail('closed workspace retains shared/ lifecycle residue', path.join(root, 'shared'));
  const text = validateFeatureRoot(originalText, feature);
  const [sections, order] = h2Sections(text, feature);
  requireSections(sections, order, CLOSED_CORE_SECTIONS, feature);
  const allowed = ['Objective', 'Context', 'Final Scope', 'Out of Scope', 'Requirements', 'Business Rules', 'Final Acceptance Criteria', 'Durable Decisions', 'Relevant Constraints', 'Relevant Risks', 'Important Contracts', 'Durable Resolved Questions'];
  const expected = allowed.filter((name) => sections.has(name));
  if (order.join('\0') !== expected.join('\0')) fail(`closed feature sections must follow [${expected.map((name) => `'${name}'`).join(', ')}]`, feature);
  if (/^```(?:yaml|yml)\s*$/gimu.test(text)) fail('closed feature cannot contain YAML beyond the File Purpose Header', feature);
  for (const match of text.matchAll(/^### ([^\n]+)$/gmu)) {
    const heading = match[1];
    if (heading === 'Facts' || heading === 'Hypotheses') continue;
    if (!CANONICAL_HEADING_RE.test(`### ${heading}`)) fail(`closed feature contains non-canonical level-3 heading '${heading}'`, feature);
  }
  if (/^#{5,6} /mu.test(text)) fail('closed feature cannot contain level-5 or level-6 headings', feature);
  const h2 = [...text.matchAll(/^## [^\n]+$/gmu)];
  const h3 = [...text.matchAll(/^### [^\n]+$/gmu)];
  for (const h4 of text.matchAll(/^#### [^\n]+$/gmu)) {
    const previousH2 = h2.filter((match) => match.index < h4.index).at(-1);
    const previousH3 = h3.filter((match) => match.index < h4.index).at(-1);
    if (!previousH3 || !CANONICAL_HEADING_RE.test(previousH3[0]) || (previousH2 && previousH3.index < previousH2.index)) fail('closed feature has a level-4 heading outside a canonical record', feature);
  }
  validateContext(sections.get('Context'), feature);
  for (const forbidden of ['Canonical Artifact Index', 'Blockers', 'Selective Reading']) if (sections.has(forbidden)) fail(`closed feature retains active-only section '${forbidden}'`, feature);
  const items = new Map();
  for (const item of parseItems(text, feature)) {
    if (items.has(item.identifier)) fail(`duplicate canonical ID in closed workspace: ${item.identifier}`, feature);
    items.set(item.identifier, item);
  }
  for (const [sectionName, prefix] of CLOSED_SECTION_PREFIX) {
    if (!sections.has(sectionName)) continue;
    const firstLine = splitLines(sections.get(sectionName))[0];
    if (!new RegExp(`^### ${prefix}-[0-9]{3} — \\S.*$`, 'u').test(firstLine)) fail(`closed canonical section '${sectionName}' contains a preamble`, feature);
    if (![...items.values()].some((item) => item.category.prefix === prefix)) fail(`closed feature contains empty canonical section '${sectionName}'`, feature);
  }
  const [missing, relationshipErrors] = collectRelationshipState(items);
  if (missing.size) fail(`closed feature has broken internal references: [${sorted(missing).map((value) => `'${value}'`).join(', ')}]`, feature);
  if (relationshipErrors.length) fail(relationshipErrors[0], feature);
  if ([...items.values()].some((item) => item.category.prefix === 'Q' && item.metadata.get('status') === 'open')) fail('closed feature contains an open question', feature);
  validateRequirementCoverage(items, feature, { complete: true });
  return { root, h1: splitLines(text)[0], status: 'closed', closed: true, items, sections, artifacts: new Map(), openQuestions: [], blockingQuestions: [], brokenReferences: [], documentaryGaps: [] };
}

export function validateWorkspace(value) {
  const requested = expandUser(value);
  const requestedMetadata = lstatOrNull(requested);
  if (requestedMetadata?.isSymbolicLink()) fail('workspace root must not be a symlink', requested);
  const root = canonicalPathWithoutSymlinks(requested, 'workspace root');
  const rootMetadata = lstatOrNull(root);
  if (rootMetadata === null || !rootMetadata.isDirectory()) fail('workspace root must be a real directory', root);
  const feature = path.join(root, 'feature_spec.md');
  const metadata = lstatOrNull(feature);
  if (metadata === null) fail('required file does not exist', feature);
  if (metadata.isSymbolicLink()) fail('feature_spec.md must be a real file', feature);
  if (!metadata.isFile()) fail('feature_spec.md must be a real regular file', feature);
  if (metadata.nlink !== 1) fail('feature_spec.md must be a single-link regular file', feature);
  const [header, text] = parseFilePurposeHeader(feature);
  return header.status === 'closed' ? validateClosed(root, feature, header, text) : validateActive(root, feature, header, text);
}

function walkTree(root) {
  const result = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory)) {
      const child = path.join(directory, name);
      result.push(child);
      const metadata = fs.lstatSync(child);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) visit(child);
    }
  }
  visit(root);
  return sorted(result, (value) => path.relative(root, value).split(path.sep).join('/'));
}

function filesystemSnapshot(root, { externalOnly }) {
  const inventory = [];
  const linkGroups = new Map();
  for (const entry of walkTree(root)) {
    const relative = path.relative(root, entry).split(path.sep).join('/');
    if (isOsMetadata(relative)) continue;
    const metadata = fs.lstatSync(entry);
    let kind;
    let linkKey = null;
    if (metadata.isSymbolicLink()) { kind = 'symlink'; linkKey = `${metadata.dev}:${metadata.ino}`; }
    else if (metadata.isDirectory()) kind = 'directory';
    else if (metadata.isFile()) { kind = 'file'; linkKey = `${metadata.dev}:${metadata.ino}`; }
    else fail('workspace contains an unsupported filesystem entry', entry);
    if (linkKey !== null) {
      if (!linkGroups.has(linkKey)) linkGroups.set(linkKey, []);
      linkGroups.get(linkKey).push(relative);
    }
    inventory.push({ entry, relative, kind, linkCount: linkKey === null ? 0 : metadata.nlink, linkKey });
  }
  const snapshot = [];
  for (const value of inventory) {
    const parts = value.relative.split('/');
    if (externalOnly && (parts[0] === 'shared' || value.relative === 'feature_spec.md')) continue;
    const peers = value.linkKey === null ? [] : sorted(linkGroups.get(value.linkKey));
    let payload = '';
    if (value.kind === 'symlink') payload = fs.readlinkSync(value.entry).split(path.sep).join('/');
    else if (value.kind === 'file') payload = createHash('sha256').update(fs.readFileSync(value.entry)).digest('hex');
    snapshot.push([value.kind, value.relative, payload, value.linkCount, peers]);
  }
  return snapshot;
}

export function externalSnapshot(root) { return filesystemSnapshot(root, { externalOnly: true }); }
export function workspaceSnapshot(root) { return filesystemSnapshot(root, { externalOnly: false }); }

export function resumeWorkspaceIdentity(value) {
  const workspace = validateWorkspace(value);
  const encoded = Buffer.from(JSON.stringify(workspaceSnapshot(workspace.root)), 'utf8');
  return createHash('sha256').update(Buffer.from('stnl-resume-pre-state-v1\0', 'utf8')).update(encoded).digest('hex');
}

function requireExactFields(value, fields, label) {
  return exactObject(value, fields, label, 'RESUME manifest');
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value) fail(`RESUME manifest ${label} must be a non-empty string`);
  return value;
}

function requireUniqueStringArray(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) fail(`RESUME manifest ${label} must be an array of strings`);
  if (new Set(value).size !== value.length) fail(`RESUME manifest ${label} contains duplicate entries`);
  return [...value];
}

function manifestPath(value, label) {
  const result = requireString(value, label);
  if (!RESUME_STATUS_PATH_RE.test(result)) fail(`RESUME manifest ${label} must be an exact lifecycle path without traversal: '${result}'`);
  return result;
}

function loadResumeManifest(manifestValue, before, afterRoot) {
  if (manifestValue === null || manifestValue === undefined) fail('RESUME transition requires a pre-state change manifest');
  const requested = expandUser(manifestValue);
  const requestedMetadata = lstatOrNull(requested);
  if (requestedMetadata?.isSymbolicLink()) fail('RESUME manifest must be a real file, not a symlink', requested);
  const resolved = canonicalPathWithoutSymlinks(requested, 'RESUME manifest');
  const metadata = lstatOrNull(resolved);
  if (metadata === null || !metadata.isFile()) fail('RESUME manifest file does not exist', resolved);
  const candidateRoot = canonicalPathWithoutSymlinks(expandUser(afterRoot), 'candidate workspace');
  const relativeBefore = path.relative(before.root, resolved);
  const relativeCandidate = path.relative(candidateRoot, resolved);
  const inside = (relative) => relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  if (inside(relativeBefore) || inside(relativeCandidate)) fail('RESUME manifest must be ephemeral and outside source and candidate workspaces', resolved);
  let root;
  try {
    root = parseStrictJson(decodeLifecycleUtf8(fs.readFileSync(resolved)), (key) => `RESUME manifest contains duplicate JSON field '${key}'`);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail(`RESUME manifest is malformed JSON: ${error.message}`, resolved);
  }
  root = requireExactFields(root, RESUME_MANIFEST_FIELDS, 'root');
  if (!Number.isInteger(root.schema_version) || root.schema_version !== RESUME_MANIFEST_VERSION) fail(`RESUME manifest schema_version must be ${RESUME_MANIFEST_VERSION}`);
  if (root.mode !== 'RESUME') fail("RESUME manifest mode must be exactly 'RESUME'");
  const identity = requireExactFields(root.workspace_identity, RESUME_IDENTITY_FIELDS, 'workspace_identity');
  const workspaceH1 = requireString(identity.h1, 'workspace_identity.h1');
  const preStateSha256 = requireString(identity.pre_state_sha256, 'workspace_identity.pre_state_sha256');
  if (!/^[0-9a-f]{64}$/u.test(preStateSha256)) fail('RESUME manifest workspace_identity.pre_state_sha256 must be lowercase SHA-256');
  if (workspaceH1 !== before.h1) fail('RESUME manifest workspace H1 does not match the pre-state workspace');
  if (preStateSha256 !== resumeWorkspaceIdentity(before.root)) fail('RESUME manifest pre-state identity does not match the source workspace');
  const featureSections = requireUniqueStringArray(root.allowed_feature_sections, 'allowed_feature_sections');
  const unknownSections = featureSections.filter((name) => !ACTIVE_SECTIONS.includes(name));
  if (unknownSections.length) fail(`RESUME manifest contains unknown or generic feature sections: [${unknownSections.map((name) => `'${name}'`).join(', ')}]`);
  const expectedSectionOrder = ACTIVE_SECTIONS.filter((name) => featureSections.includes(name));
  if (featureSections.join('\0') !== expectedSectionOrder.join('\0')) fail('RESUME manifest allowed_feature_sections must follow canonical feature section order');
  const idArrays = Object.create(null);
  for (const field of ['allowed_existing_ids', 'allowed_new_ids']) {
    const entries = requireUniqueStringArray(root[field], field);
    const malformed = entries.filter((identifier) => !CANONICAL_ID_RE.test(identifier));
    if (malformed.length) fail(`RESUME manifest ${field} contains malformed IDs or generic authorization: [${malformed.map((value) => `'${value}'`).join(', ')}]`);
    if (entries.join('\0') !== [...entries].sort(canonicalIdSort).join('\0')) fail(`RESUME manifest ${field} must use canonical ID order`);
    idArrays[field] = entries;
  }
  const allIds = [...idArrays.allowed_existing_ids, ...idArrays.allowed_new_ids];
  if (new Set(allIds).size !== allIds.length) fail('RESUME manifest gives duplicate authority to an ID across change classes');
  if (!Array.isArray(root.allowed_status_transitions)) fail('RESUME manifest allowed_status_transitions must be an array');
  const statusTransitions = root.allowed_status_transitions.map((entry, index) => {
    const mapping = requireExactFields(entry, RESUME_STATUS_TRANSITION_FIELDS, `allowed_status_transitions[${index}]`);
    const transitionPath = manifestPath(mapping.path, `allowed_status_transitions[${index}].path`);
    const from = requireString(mapping.from, `allowed_status_transitions[${index}].from`);
    const to = requireString(mapping.to, `allowed_status_transitions[${index}].to`);
    if (!HEADER_STATUSES.has(from) || !HEADER_STATUSES.has(to)) fail(`RESUME manifest status transition for ${transitionPath} contains an invalid status`);
    if (from === to) fail(`RESUME manifest status transition for ${transitionPath} must change status`);
    return { path: transitionPath, before: from, after: to };
  });
  const statusPaths = statusTransitions.map((transition) => transition.path);
  if (new Set(statusPaths).size !== statusPaths.length) fail('RESUME manifest allowed_status_transitions contains duplicate paths');
  if (statusPaths.join('\0') !== sorted(statusPaths).join('\0')) fail('RESUME manifest allowed_status_transitions must use canonical path order');
  if (!Array.isArray(root.allowed_record_status_transitions)) fail('RESUME manifest allowed_record_status_transitions must be an array');
  const recordTransitions = root.allowed_record_status_transitions.map((entry, index) => {
    const mapping = requireExactFields(entry, RESUME_RECORD_STATUS_TRANSITION_FIELDS, `allowed_record_status_transitions[${index}]`);
    const transitionPath = manifestPath(mapping.path, `allowed_record_status_transitions[${index}].path`);
    if (transitionPath === 'feature_spec.md') fail('RESUME manifest record status transitions must target shared category files');
    const identifier = requireString(mapping.id, `allowed_record_status_transitions[${index}].id`);
    if (!CANONICAL_ID_RE.test(identifier)) fail(`RESUME manifest record status transition contains malformed ID '${identifier}'`);
    const from = requireString(mapping.from, `allowed_record_status_transitions[${index}].from`);
    const to = requireString(mapping.to, `allowed_record_status_transitions[${index}].to`);
    const valueCategory = CATEGORY_BY_PREFIX.get(identifier.split('-', 1)[0]);
    if (transitionPath !== EXPECTED_ARTIFACT_PATHS.get(valueCategory.key)) fail(`RESUME manifest record status transition path '${transitionPath}' is incompatible with ${identifier}`);
    if (!valueCategory.statuses.has(from) || !valueCategory.statuses.has(to)) fail(`RESUME manifest record status transition for ${identifier} has an invalid status`);
    if (from === to) fail(`RESUME manifest record status transition for ${identifier} must change status`);
    if (!RESUME_RECORD_STATUS_TRANSITIONS.get(valueCategory.prefix).has(`${from}\0${to}`)) fail(`RESUME manifest record status transition for ${identifier} is not permitted: ${from} -> ${to}`);
    return { path: transitionPath, identifier, before: from, after: to };
  });
  const recordTargets = recordTransitions.map((transition) => `${transition.path}\0${transition.identifier}`);
  if (new Set(recordTargets).size !== recordTargets.length) fail('RESUME manifest allowed_record_status_transitions contains duplicate targets');
  if (recordTargets.join('\0') !== sorted(recordTargets).join('\0')) fail('RESUME manifest allowed_record_status_transitions must use canonical path and ID order');
  const unauthorized = [...new Set(recordTransitions.map((transition) => transition.identifier).filter((identifier) => !idArrays.allowed_existing_ids.includes(identifier)))].sort(canonicalIdSort);
  if (unauthorized.length) fail(`RESUME manifest record status transitions also require allowed_existing_ids authority: [${unauthorized.map((value) => `'${value}'`).join(', ')}]`);
  return { workspaceH1, preStateSha256, featureSections, existingIds: idArrays.allowed_existing_ids, newIds: idArrays.allowed_new_ids, statusTransitions, recordStatusTransitions: recordTransitions };
}

function rawHeaderAndBody(file) {
  const raw = decodeLifecycleUtf8(fs.readFileSync(file));
  const match = raw.match(/^# File Purpose Header\n\n```yaml\n[\s\S]*?```\n/u);
  if (match === null) fail('missing normalized File Purpose Header', file);
  return [match[0], raw.slice(match[0].length)];
}

function headerWithoutStatus(header, file) {
  let replacements = 0;
  const result = header.replace(/^status: [^\n]+$/mu, () => { replacements += 1; return 'status: <RESUME_STATUS>'; });
  if (replacements !== 1) fail('File Purpose Header status is missing', file);
  return result;
}

function rawFeatureState(file) {
  const [header, body] = rawHeaderAndBody(file);
  const matches = [...body.matchAll(/^## (?<name>[^\n]+)\n/gmu)];
  if (!matches.length) fail('feature has no canonical sections', file);
  const sections = new Map();
  const order = [];
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    sections.set(match.groups.name, body.slice(match.index, end));
    order.push(match.groups.name);
  });
  return { header, preamble: body.slice(0, matches[0].index), sections, order };
}

function rawSharedState(file) {
  const raw = decodeLifecycleUtf8(fs.readFileSync(file));
  const [header, body] = rawHeaderAndBody(file);
  const matches = [...body.matchAll(new RegExp(`^### (?<id>${CANONICAL_ID_SOURCE}) — [^\\n]+\\n`, 'gmu'))];
  if (!matches.length) fail('materialized category file is semantically empty', file);
  const blocks = new Map();
  const separators = new Map();
  const order = [];
  matches.forEach((match, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    const segment = body.slice(match.index, end);
    const block = segment.replace(/\n+$/u, '');
    blocks.set(match.groups.id, block);
    separators.set(match.groups.id, segment.slice(block.length));
    order.push(match.groups.id);
  });
  return { header, preamble: body.slice(0, matches[0].index), blocks, separators, order, raw };
}

function lifecyclePaths(workspace) {
  const result = new Map([['feature_spec.md', path.join(workspace.root, 'feature_spec.md')]]);
  for (const relative of workspace.artifacts.values()) result.set(relative, path.join(workspace.root, ...relative.split('/')));
  return result;
}

function statusTransitions(before, after) {
  const source = lifecyclePaths(before);
  const candidate = lifecyclePaths(after);
  const result = [];
  for (const relative of sorted([...source.keys()].filter((key) => candidate.has(key)))) {
    const [sourceHeader] = parseFilePurposeHeader(source.get(relative));
    const [candidateHeader] = parseFilePurposeHeader(candidate.get(relative));
    if (sourceHeader.status !== candidateHeader.status) result.push({ path: relative, before: sourceHeader.status, after: candidateHeader.status });
  }
  return result;
}

function recordStatusTransitions(before, after) {
  const identifiers = [...before.items.keys()].filter((identifier) => after.items.has(identifier)).sort(canonicalIdSort);
  const result = [];
  for (const identifier of identifiers) {
    const source = before.items.get(identifier);
    const candidate = after.items.get(identifier);
    const from = source.metadata.get('status');
    const to = candidate.metadata.get('status');
    if (from !== to) result.push({ path: path.relative(after.root, candidate.path).split(path.sep).join('/'), identifier, before: from, after: to });
  }
  return result.sort((left, right) => compareCodePoints(`${left.path}\0${left.identifier}`, `${right.path}\0${right.identifier}`));
}

function same(value, other) { return JSON.stringify(value) === JSON.stringify(other); }

function validateResumePreservation(before, after, manifest) {
  const sourceFeature = rawFeatureState(path.join(before.root, 'feature_spec.md'));
  const candidateFeature = rawFeatureState(path.join(after.root, 'feature_spec.md'));
  const featurePath = path.join(after.root, 'feature_spec.md');
  if (sourceFeature.preamble !== candidateFeature.preamble) fail('RESUME changed the feature H1 or structural preamble', featurePath);
  if (!same(sourceFeature.order, candidateFeature.order)) fail('RESUME changed feature section headers or order', featurePath);
  const changedSections = sourceFeature.order.filter((name) => sourceFeature.sections.get(name) !== candidateFeature.sections.get(name));
  if (!same(changedSections, manifest.featureSections)) fail(`RESUME feature section changes do not exactly match allowed_feature_sections; actual=[${changedSections.map((name) => `'${name}'`).join(', ')}], allowed=[${manifest.featureSections.map((name) => `'${name}'`).join(', ')}]`, featurePath);
  const sourcePaths = lifecyclePaths(before);
  const candidatePaths = lifecyclePaths(after);
  const actualStatus = statusTransitions(before, after);
  if (!same(actualStatus, manifest.statusTransitions)) fail('RESUME File Purpose Header status changes do not exactly match allowed_status_transitions', featurePath);
  const actualRecordStatus = recordStatusTransitions(before, after);
  if (!same(actualRecordStatus, manifest.recordStatusTransitions)) fail('RESUME canonical record status changes do not exactly match allowed_record_status_transitions', featurePath);
  const transitioned = new Set(actualStatus.map((transition) => transition.path));
  for (const relative of sorted([...sourcePaths.keys()].filter((key) => candidatePaths.has(key)))) {
    const [sourceHeader] = rawHeaderAndBody(sourcePaths.get(relative));
    const [candidateHeader] = rawHeaderAndBody(candidatePaths.get(relative));
    if (sourceHeader !== candidateHeader && !transitioned.has(relative)) fail(`RESUME changed unauthorized File Purpose Header bytes in ${relative}`, candidatePaths.get(relative));
    if (headerWithoutStatus(sourceHeader, sourcePaths.get(relative)) !== headerWithoutStatus(candidateHeader, candidatePaths.get(relative))) fail(`RESUME changed unauthorized File Purpose Header bytes in ${relative}`, candidatePaths.get(relative));
  }
  const sourceShared = new Map([...sourcePaths].filter(([relative]) => relative !== 'feature_spec.md').map(([relative, file]) => [relative, rawSharedState(file)]));
  const candidateShared = new Map([...candidatePaths].filter(([relative]) => relative !== 'feature_spec.md').map(([relative, file]) => [relative, rawSharedState(file)]));
  const changedExisting = new Set();
  for (const relative of sorted([...sourceShared.keys()].filter((key) => candidateShared.has(key)))) {
    const source = sourceShared.get(relative);
    const candidate = candidateShared.get(relative);
    if (source.preamble !== candidate.preamble) fail(`RESUME changed shared-file structural header bytes in ${relative}`, candidatePaths.get(relative));
    const appended = candidate.order.filter((identifier) => !before.items.has(identifier)).sort(canonicalIdSort);
    if (!same(candidate.order, [...source.order, ...appended])) fail(`RESUME changed canonical record order in ${relative}`, candidatePaths.get(relative));
    for (const identifier of [...source.blocks.keys()].filter((key) => candidate.blocks.has(key)).sort(canonicalIdSort)) {
      if (source.blocks.get(identifier) !== candidate.blocks.get(identifier)) changedExisting.add(identifier);
      const sourceIndex = source.order.indexOf(identifier);
      const candidateIndex = candidate.order.indexOf(identifier);
      const sourceNext = source.order[sourceIndex + 1] ?? null;
      const candidateNext = candidate.order[candidateIndex + 1] ?? null;
      if (sourceNext === candidateNext && source.separators.get(identifier) !== candidate.separators.get(identifier)) fail(`RESUME changed unauthorized record boundary bytes after ${identifier}`, candidatePaths.get(relative));
    }
    const noBlockChanges = [...source.blocks].every(([key, block]) => candidate.blocks.get(key) === block);
    if (source.raw !== candidate.raw && same(source.order, candidate.order) && noBlockChanges && source.header === candidate.header) fail(`RESUME changed unauthorized shared-file bytes in ${relative}`, candidatePaths.get(relative));
  }
  const actualNew = [...after.items.keys()].filter((identifier) => !before.items.has(identifier));
  const actualRemoved = [...before.items.keys()].filter((identifier) => !after.items.has(identifier)).sort(canonicalIdSort);
  if (actualRemoved.length) fail(`RESUME removed canonical IDs instead of preserving tombstones: [${actualRemoved.map((value) => `'${value}'`).join(', ')}]`, featurePath);
  if (!same([...changedExisting].sort(canonicalIdSort), manifest.existingIds)) fail('RESUME changed existing IDs outside allowed_existing_ids or left unused authority', featurePath);
  if (!same([...actualNew].sort(canonicalIdSort), [...manifest.newIds].sort(canonicalIdSort))) fail('RESUME new IDs do not exactly match allowed_new_ids', featurePath);
}

export function validateInitTransition(beforeRoot, afterRoot) {
  const before = expandUser(beforeRoot);
  if (lexists(before)) fail('INIT destination must not exist', before);
  const after = validateWorkspace(afterRoot);
  if (after.closed) fail('INIT cannot publish a closed SPEC', path.join(after.root, 'feature_spec.md'));
  for (const name of fs.readdirSync(after.root)) {
    const child = path.join(after.root, name);
    if (isOsMetadata(path.relative(after.root, child))) continue;
    if (!new Set(['feature_spec.md', 'shared']).has(name)) fail(`INIT created an out-of-contract path '${name}'`, child);
  }
  return after;
}

export function validateResumeTransition(beforeRoot, afterRoot, manifestPath) {
  const before = validateWorkspace(beforeRoot);
  const manifest = loadResumeManifest(manifestPath, before, afterRoot);
  const after = validateWorkspace(afterRoot);
  const feature = path.join(after.root, 'feature_spec.md');
  if (before.closed || after.closed) fail('RESUME requires active source and candidate workspaces', feature);
  if (before.h1 !== after.h1) fail('RESUME changed the feature H1 identity', feature);
  const beforeIds = new Set(before.items.keys());
  const afterIds = new Set(after.items.keys());
  const removed = [...beforeIds].filter((identifier) => !afterIds.has(identifier)).sort(canonicalIdSort);
  if (removed.length) fail(`RESUME removed canonical IDs instead of preserving tombstones: [${removed.map((value) => `'${value}'`).join(', ')}]`, feature);
  const unknownExisting = manifest.existingIds.filter((identifier) => !beforeIds.has(identifier));
  if (unknownExisting.length) fail(`RESUME manifest allowed_existing_ids are absent from the pre-state: [${unknownExisting.map((value) => `'${value}'`).join(', ')}]`);
  const collidingNew = manifest.newIds.filter((identifier) => beforeIds.has(identifier));
  if (collidingNew.length) fail(`RESUME manifest allowed_new_ids already exist in the pre-state: [${collidingNew.map((value) => `'${value}'`).join(', ')}]`);
  for (const identifier of [...beforeIds].filter((value) => afterIds.has(value)).sort(canonicalIdSort)) {
    const source = before.items.get(identifier);
    const candidate = after.items.get(identifier);
    if (source.category.key !== candidate.category.key) fail(`RESUME changed canonical type for ${identifier}`, candidate.path);
    if (source.title !== candidate.title) fail(`RESUME changed canonical identity/title for ${identifier}`, candidate.path);
  }
  const newIds = [...afterIds].filter((identifier) => !beforeIds.has(identifier)).sort(canonicalIdSort);
  for (const prefix of CANONICAL_PREFIXES) {
    const previous = [...beforeIds].filter((identifier) => identifier.startsWith(`${prefix}-`)).map((identifier) => Number(identifier.split('-').at(-1)));
    const highest = previous.length ? Math.max(...previous) : 0;
    const invalid = newIds.filter((identifier) => identifier.startsWith(`${prefix}-`) && Number(identifier.split('-').at(-1)) <= highest);
    if (invalid.length) fail(`RESUME reused or filled a reserved ${prefix} ID at/below ${prefix}-${String(highest).padStart(3, '0')}: [${invalid.map((value) => `'${value}'`).join(', ')}]`, feature);
    const suffixes = newIds.filter((identifier) => identifier.startsWith(`${prefix}-`)).map((identifier) => Number(identifier.split('-').at(-1))).sort((a, b) => a - b);
    const expected = Array.from({ length: suffixes.length }, (_, index) => highest + index + 1);
    if (!same(suffixes, expected)) fail(`RESUME new ${prefix} IDs must continue monotonically from ${prefix}-${String(highest + 1).padStart(3, '0')}`, feature);
  }
  validateResumePreservation(before, after, manifest);
  if (!same(externalSnapshot(before.root), externalSnapshot(after.root))) fail('RESUME changed a directory outside lifecycle ownership', after.root);
  return [before, after];
}

export function validateReadinessTransition(beforeRoot, afterRoot, scope) {
  if (!new Set(['LOCAL', 'GLOBAL']).has(scope)) fail("READINESS scope must be exactly 'LOCAL' or 'GLOBAL'");
  const before = validateWorkspace(beforeRoot);
  const after = validateWorkspace(afterRoot);
  if (before.closed || after.closed) fail('READINESS operates only on active SPEC workspaces', path.join(after.root, 'feature_spec.md'));
  if (!same(workspaceSnapshot(before.root), workspaceSnapshot(after.root))) fail(`READINESS ${scope} check mutated the workspace`, after.root);
  return [before, after];
}

export function validateCloseTransition(beforeRoot, afterRoot) {
  const before = validateWorkspace(beforeRoot);
  if (before.closed || before.status !== 'ready') fail('CLOSE source must be an active ready SPEC', path.join(before.root, 'feature_spec.md'));
  if (before.openQuestions.length || before.brokenReferences.length || before.documentaryGaps.length) fail('CLOSE source still has documentary blockers', path.join(before.root, 'feature_spec.md'));
  const after = validateWorkspace(afterRoot);
  const feature = path.join(after.root, 'feature_spec.md');
  if (!after.closed) fail('CLOSE result must have feature status closed', feature);
  if (before.h1 !== after.h1) fail('CLOSE changed the feature H1 identity', feature);
  const mapping = new Map([['Objective', 'Objective'], ['Context', 'Context'], ['Scope', 'Final Scope'], ['Out of Scope', 'Out of Scope'], ['Business Rules', 'Business Rules'], ['Relevant Contracts', 'Important Contracts']]);
  for (const [sourceName, finalName] of mapping) if (normalize(before.sections.get(sourceName)) !== normalize(after.sections.get(finalName))) fail(`CLOSE lost or changed durable section '${sourceName}'`, feature);
  const missing = [...before.items.keys()].filter((identifier) => !after.items.has(identifier)).sort(canonicalIdSort);
  const extra = [...after.items.keys()].filter((identifier) => !before.items.has(identifier)).sort(canonicalIdSort);
  if (missing.length) fail(`CLOSE discarded canonical items: [${missing.map((value) => `'${value}'`).join(', ')}]`, feature);
  if (extra.length) fail(`CLOSE invented canonical items: [${extra.map((value) => `'${value}'`).join(', ')}]`, feature);
  for (const [identifier, source] of before.items) if (itemPreservationSignature(source) !== itemPreservationSignature(after.items.get(identifier))) fail(`CLOSE changed canonical content for ${identifier}`, feature);
  if (!same(externalSnapshot(before.root), externalSnapshot(after.root))) fail('CLOSE changed an external directory, including execution/', after.root);
  return [before, after];
}
