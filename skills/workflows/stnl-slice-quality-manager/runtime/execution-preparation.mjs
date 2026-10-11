import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const sha256 = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const PLAN = ['Global Context', 'Serial Slice Order', 'Global Risks and Integration'];
const DETAIL = ['References', 'Objective and Observable Result', 'Requirements', 'Included Scope',
  'Out of Scope and Boundaries', 'Authorized Areas', 'Expected Files', 'Existing Inputs', 'Protected Responsibilities',
  'Dependencies', 'Risks and Strategy', 'Expected Tests', 'Completion Criterion'];
const RECORDS = ['Changed Areas', 'Scope Expansion', 'Prior Validation Overlap', 'Divergences', 'Delegation Blocker',
  'Implementation Test Evidence', 'Findings Test Evidence', 'Validation Attempts', 'Validation Findings',
  'Corrections Applied', 'Effective Validation Base', 'Diff Summary', 'Final Result'];
const TASK = ['References', 'Result', 'Acceptance Obligations', 'Authorized Areas', 'Expected Files', 'Existing Inputs',
  'Protected Responsibilities', 'Checklist', 'Expected Tests', 'Operational Changes', ...RECORDS];
const reject = message => { throw new Error(`preparation contract: ${message}`); };
const normalized = value => value.replaceAll('\r\n', '\n').trim();

import { parseStrictJson, readOwnedFile, assertOwnedOperationalCandidate, assertOwnedPreparationCandidate } from './execution-publication.mjs';
export { parseStrictJson };

function keys(object, names, label) {
  if (!object || Array.isArray(object) || typeof object !== 'object'
    || Object.keys(object).sort().join('\0') !== [...names].sort().join('\0')) reject(`${label} has unknown or missing fields`);
}
function populated(value, label) {
  if (typeof value !== 'string' || !value.trim() || /<[^>]*>|\b(?:TODO|TBD)\b/u.test(value)) reject(`${label} is not populated`);
  return value;
}
function inlineFields(body, label) {
  const result = {};
  for (const line of body.split('\n')) {
    const match = /^- ([^:]+): (\S.*)$/u.exec(line);
    if (!match || Object.hasOwn(result, match[1])) reject(`${label} has ambiguous fields`);
    result[match[1]] = populated(match[2], `${label} ${match[1]}`);
  }
  return result;
}

export function parsePreparationArtifact(text, artifact) {
  if (typeof text !== 'string' || text.includes('\0')) reject(`${artifact} is not UTF-8 text`);
  const source = text.replaceAll('\r\n', '\n');
  const header = /^# File Purpose Header\n\n```yaml\n([\s\S]*?)```\n\n/u.exec(source);
  if (!header) reject(`${artifact} has no purpose header`);
  const metadata = inlineFields(header[1].trim().split('\n').map(line => `- ${line}`).join('\n'), artifact);
  keys(metadata, ['purpose', 'status', 'read_when', 'do_not_read_when', 'contains', 'owner', 'update_policy'], artifact);
  if (!['draft', 'ready'].includes(metadata.status) || metadata.owner !== 'stnl-execution-planner') reject(`${artifact} has incompatible owner/status (legacy preparation preserved)`);
  const body = source.slice(header[0].length);
  if (/```|~~~|<!--|-->|\r/u.test(body)) reject(`${artifact} contains hidden or ambiguous carriers`);
  const heading = /^# ([^\n]+)\n\n/u.exec(body);
  if (!heading) reject(`${artifact} has no canonical primary heading`);
  const remainder = body.slice(heading[0].length);
  if (!remainder.startsWith('## ')) reject(`${artifact} has text outside sections`);
  const matches = [...remainder.matchAll(/^## ([^\n]+)\n/gmu)];
  const sections = {};
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1];
    if (Object.hasOwn(sections, name)) reject(`${artifact} duplicates ${name}`);
    const value = normalized(remainder.slice(matches[index].index + matches[index][0].length, matches[index + 1]?.index));
    if (!value) reject(`${artifact} ${name} is empty`);
    sections[name] = RECORDS.includes(name) ? value : populated(value, `${artifact} ${name}`);
    if (/^#{1,2} /mu.test(value)) reject(`${artifact} has a concealed heading`);
  }
  const kind = artifact === 'plan.md' ? 'plan' : artifact.startsWith('plans/') ? 'detail' : 'task';
  const expected = kind === 'plan' ? PLAN : kind === 'detail' ? DETAIL : TASK;
  if (Object.keys(sections).join('\0') !== expected.join('\0')) reject(`${artifact} has unknown, missing or unordered sections (legacy preparation preserved)`);
  const fields = inlineFields(sections[kind === 'plan' ? 'Global Context' : 'References'], artifact);
  if (!HASH.test(fields['Requirements authority']) || !/^[1-9][0-9]*$/u.test(fields['Plan revision'] ?? '')) reject(`${artifact} has invalid authority/revision`);
  const allowed = kind === 'plan'
    ? ['Requirements source', 'Requirements authority', 'Plan revision', 'Objective', 'Strategy', 'Review state', 'Replan reason', 'Revision mode', 'Supersedes open slices']
    : kind === 'detail' ? ['Slice', 'Requirements source', 'Requirements authority', 'Plan revision', 'Global plan', 'Review state', 'Delivery ID']
      : ['Slice', 'Plan', 'Requirements source', 'Requirements authority', 'Plan revision', 'Global tasks', 'Delivery ID'];
  const required = kind === 'plan' ? allowed.slice(0, 6) : allowed;
  if (required.some(key => !Object.hasOwn(fields, key))) reject(`${artifact} has a missing reference field`);
  if (Object.keys(fields).some(key => !allowed.includes(key))) reject(`${artifact} has an unknown reference field`);
  if (kind !== 'plan' && !UUID.test(fields['Delivery ID'] ?? '')) reject(`${artifact} requires runtime delivery identity`);
  return { kind, heading: heading[1], metadata, fields, sections };
}

export function preparationPathClaims(body, label) {
  if (body === '- none') return [];
  const claims = body.split('\n').map(line => /^- (?:(?:directory|file): )?`([^`]+)`$/u.exec(line)?.[1]);
  if (claims.some(claim => !claim || claim.includes('\\') || path.posix.isAbsolute(claim)
    || path.posix.normalize(claim) !== claim || claim === '.') || new Set(claims).size !== claims.length) reject(`${label} requires distinct artifact-relative paths`);
  return claims;
}

function obligations(body, label) {
  const rows = body.split('\n').map(line => {
    const match = /^- (obligation-[0-9]{2,}) \| requirement: ([A-Z][A-Z0-9]*-[0-9]+) \| contribution: (complete|partial) \| full owner: (slice-[0-9]{2,}) \| condition: ([^|]+) \| proof: ([^|]+)$/u.exec(line);
    if (!match) reject(`${label} has malformed acceptance obligation`);
    return { id: match[1], requirement: match[2], contribution: match[3], fullOwner: match[4], condition: populated(match[5].trim(), label), proof: populated(match[6].trim(), label) };
  });
  if (!rows.length || new Set(rows.map(row => row.id)).size !== rows.length) reject(`${label} has no distinct obligations`);
  return rows;
}

export function preparationChecklist(body, declared, label) {
  const rows = body.split('\n').map(line => {
    const match = /^- \[([ x])\] ([0-9]+\.[0-9]+) ([^|]+) \| obligations: (obligation-[0-9]{2,}(?:, obligation-[0-9]{2,})*)$/u.exec(line);
    if (!match) reject(`${label} has malformed operational step`);
    const ids = match[4].split(', ');
    if (new Set(ids).size !== ids.length || ids.some(id => !declared.some(row => row.id === id))) reject(`${label} has unknown or duplicate obligation association`);
    return { done: match[1] === 'x', id: match[2], action: populated(match[3].trim(), label), obligations: ids };
  });
  if (!rows.length || new Set(rows.map(row => row.id)).size !== rows.length
    || declared.some(row => !rows.some(step => step.obligations.includes(row.id)))) reject(`${label} loses an obligation or duplicates a step`);
  return rows;
}

// This projection binds explicit protected carriers. It does not judge review independence
// or infer whether an apparently technical step changes a protected responsibility.
export function parsePreparationTableRow(line, count, label) {
  if (typeof line !== 'string' || line !== line.trim() || !line.startsWith('|') || !line.endsWith('|')) reject(`${label} contains text outside its table carrier`);
  const columns = line.slice(1, -1).split('|').map(value => value.trim());
  if (columns.length !== count || columns.some(value => value === '')) reject(`${label} has an ambiguous table carrier`);
  return columns;
}

export function projectPreparationAuthority(artifacts) {
  const entries = artifacts instanceof Map ? [...artifacts] : Object.entries(artifacts);
  const texts = new Map(entries);
  const parsed = new Map(entries.filter(([name]) => name !== 'tasks.md').map(([name, text]) => [name, parsePreparationArtifact(text, name)]));
  const global = parsed.get('plan.md');
  if (!global || !texts.has('tasks.md')) reject('Plan and Tasks must be produced together');
  const table = global.sections['Serial Slice Order'].split('\n');
  if (table[0] !== '| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |'
    || table[1] !== '|---|---|---|---|---|---|') reject('noncanonical serial order table');
  const order = table.slice(2).map(line => {
    const columns = parsePreparationTableRow(line, 6, 'Serial Slice Order');
    const slice = /^([0-9]{2,}) - \S.*$/u.exec(columns[0])?.[1];
    if (columns.length !== 6 || !slice || columns[5] !== `plans/slice-${slice}.md`) reject('invalid serial slice');
    preparationAreaClaims(columns[4].split('; ').map(area => '- ' + area).join('\n'));
    return { slice: `slice-${slice}`, delivery: populated(columns[1], 'delivery'), dependencies: columns[2], requirements: columns[3], areas: columns[4] };
  });
  if (!order.length || new Set(order.map(row => row.slice)).size !== order.length) reject('missing/duplicate serial slices');
  const expected = ['plan.md', 'tasks.md', ...order.flatMap(row => [`plans/${row.slice}.md`, `tasks/${row.slice}.md`])].sort();
  if (entries.map(([name]) => name).sort().join('\0') !== expected.join('\0')) reject('artifact manifest does not match serial slices');
  const taskIndex = texts.get('tasks.md').replaceAll('\r\n', '\n');
  const indexHeader = /^# File Purpose Header\n\n```yaml\n([\s\S]*?)```\n\n# Execution Tasks\n\n/u.exec(taskIndex);
  if (!indexHeader || /```|~~~|<!--|-->/u.test(taskIndex.slice(indexHeader[0].length))) reject('tasks.md contains hidden or unknown carriers');
  const indexMeta = inlineFields(indexHeader[1].trim().split('\n').map(line => `- ${line}`).join('\n'), 'tasks.md');
  keys(indexMeta, ['purpose', 'status', 'read_when', 'do_not_read_when', 'contains', 'owner', 'update_policy'], 'tasks.md');
  if (indexMeta.owner !== 'stnl-execution-planner' || !['draft', 'ready'].includes(indexMeta.status)) reject('legacy Tasks owner/status preserved');
  const indexLines = taskIndex.slice(indexHeader[0].length).trim().split('\n');
  if (indexLines[0] !== '| Done | Slice | Delivery | Dependencies | Detail | Validation | Result |' || indexLines[1] !== '|---|---|---|---|---|---|---|') reject('tasks.md has noncanonical table');
  const indexNorm = indexLines.slice(2).map((line, index) => {
    const columns = parsePreparationTableRow(line, 7, 'Tasks index'); const row = order[index];
    if (!row || columns.length !== 7 || !/^\[[ x]\]$/u.test(columns[0]) || !columns[1].startsWith(row.slice.slice(6) + ' - ')
      || columns[4] !== `tasks/${row.slice}.md` || columns[2] !== row.delivery || columns[3] !== row.dependencies) reject('Tasks index differs from Plan delivery/dependency/order');
    return { slice: columns[1], delivery: columns[2], dependencies: columns[3], detail: columns[4] };
  });
  if (indexNorm.length !== order.length) reject('Tasks index omits a delivery');
  const deliveries = [];
  const projection = { format: 'stnl-preparation-projection-v2', global: { ...global.fields }, risks: global.sections['Global Risks and Integration'], order, tasksIndex: indexNorm, deliveries: [] };
  delete projection.global['Review state'];
  const completeOwners = new Map();
  for (const row of order) {
    const detail = parsed.get(`plans/${row.slice}.md`); const task = parsed.get(`tasks/${row.slice}.md`);
    const id = detail.fields['Delivery ID'];
    if (task.fields['Delivery ID'] !== id || deliveries.some(entry => entry.deliveryId === id)) reject(`${row.slice} delivery identity differs or is duplicated`);
    for (const entry of [detail, task]) {
      if (entry.fields.Slice !== row.slice.slice(6)) reject(`${row.slice} declares another slice`);
      if (entry.fields['Requirements authority'] !== detail.fields['Requirements authority']
        || entry.fields['Plan revision'] !== detail.fields['Plan revision']) reject(`${row.slice} authority pair differs`);
    }
    const globalAreas = preparationAreaClaims(row.areas.split('; ').map(area => '- ' + area).join('\n'));
    const detailAreas = preparationAreaClaims(detail.sections['Authorized Areas']);
    if (JSON.stringify(globalAreas) !== JSON.stringify(detailAreas.map(area => ({ kind: area.kind, path: path.posix.normalize(path.posix.join('plans', area.path)) })))) reject(`${row.slice} authorization differs between global and detailed Plan`);
    const declared = obligations(task.sections['Acceptance Obligations'], row.slice);
    preparationChecklist(task.sections.Checklist, declared, row.slice);
    const operative = ['Expected Files', 'Checklist', 'Operational Changes', ...RECORDS];
    const norm = Object.fromEntries(Object.entries(task.sections).filter(([name]) => !operative.includes(name)));
    const detailNorm = { ...detail.sections }; delete detailNorm['Expected Files'];
    detailNorm.References = { ...detail.fields }; delete detailNorm.References['Review state'];
    norm.References = task.fields;
    for (const carrier of ['Authorized Areas', 'Expected Files', 'Existing Inputs']) {
      if (carrier === 'Authorized Areas') { preparationAreaClaims(detail.sections[carrier]); preparationAreaClaims(task.sections[carrier]); }
      preparationPathClaims(detail.sections[carrier], `${row.slice} plan ${carrier}`);
      preparationPathClaims(task.sections[carrier], `${row.slice} task ${carrier}`);
      if (carrier !== 'Expected Files' && detail.sections[carrier] !== task.sections[carrier]) reject(`${row.slice} ${carrier} differs between Plan and Task`);
    }
    const dependencies = row.dependencies === '-' ? [] : row.dependencies.split(', ').map(value => value.startsWith('slice-') ? value : `slice-${value.padStart(2, '0')}`);
    if (dependencies.some(dep => !order.slice(0, order.indexOf(row)).some(prior => prior.slice === dep))) reject(`${row.slice} has an invalid dependency`);
    for (const obligation of declared) {
      if (!new RegExp(`\\b${obligation.requirement}\\b`, 'u').test(detail.sections.Requirements) || !row.requirements.includes(obligation.requirement)) reject(`${row.slice} obligation is not mapped by its Plan`);
      if (obligation.contribution === 'complete' && obligation.fullOwner !== row.slice) reject(`${row.slice} claims another full owner`);
      if (obligation.contribution === 'complete') {
        const previous = completeOwners.get(obligation.requirement); const revision = Number(task.fields['Plan revision']);
        if (previous && previous.revision === revision && previous.slice !== row.slice) reject('ambiguous integral requirement ownership');
        if (!previous || previous.revision < revision) completeOwners.set(obligation.requirement, { slice: row.slice, revision });
      }
    }
    deliveries.push({ slice: row.slice, deliveryId: id });
    projection.deliveries.push({ slice: row.slice, deliveryId: id, plan: detailNorm, task: norm, obligations: declared });
  }
  for (const delivery of projection.deliveries) for (const obligation of delivery.obligations) {
    if (Number(delivery.task.References['Plan revision']) === Number(global.fields['Plan revision']) && completeOwners.get(obligation.requirement)?.slice !== obligation.fullOwner) reject(`${obligation.requirement} has no declared integral owner`);
  }
  return { normativeProjection: projection, normativeSha256: sha256(JSON.stringify(projection)),
    requirementsAuthority: global.fields['Requirements authority'], preparationRevision: Number(global.fields['Plan revision']), deliveries };
}

export async function readPreparationArtifacts(root) {
  const result = new Map();
  for (const name of ['plan.md', 'tasks.md', 'plans', 'tasks']) {
    const target = path.join(root, name);
    const names = name.endsWith('.md') ? [name] : (await fs.readdir(target)).sort().map(file => `${name}/${file}`);
    for (const relative of names) {
      if (!/^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(relative)) reject(`unrecognized preparation artifact ${relative}`);
      const file = path.join(root, relative); const metadata = await fs.lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) reject(`unsafe preparation artifact ${relative}`);
      const { bytes } = await readOwnedFile(file); const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!Buffer.from(utf8).equals(bytes)) reject(`UTF-8 roundtrip failed ${relative}`);
      result.set(relative, utf8);
    }
  }
  return new Map([...result].sort(([left], [right]) => left.localeCompare(right, 'en')));
}

export function validateApprovedPreparation(snapshot) {
  keys(snapshot, ['format', 'preparationRevision', 'requirementsAuthority', 'normativeSha256', 'reviewDecision', 'deliveries', 'normativeProjection', 'reviewedArtifacts'], 'snapshot');
  if (snapshot.format !== 'stnl-preparation-v2') reject('legacy snapshot is incompatible');
  keys(snapshot.reviewDecision, ['operation', 'status', 'examined', 'summary'], 'review decision');
  if (snapshot.reviewDecision.operation !== 'REVIEW_PLAN' || snapshot.reviewDecision.status !== 'approved'
    || JSON.stringify(snapshot.reviewDecision.examined) !== JSON.stringify(['requirements', 'plans', 'tasks', 'initial checklist', 'proof capability'])) reject('joint independent review decision required');
  populated(snapshot.reviewDecision.summary, 'review summary');
  if (!Array.isArray(snapshot.reviewedArtifacts)) reject('reviewed artifacts required');
  const artifacts = new Map();
  for (const record of snapshot.reviewedArtifacts) {
    keys(record, ['path', 'sha256', 'utf8'], 'reviewed artifact');
    if (typeof record.utf8 !== 'string' || sha256(Buffer.from(record.utf8)) !== record.sha256 || artifacts.has(record.path)) reject('reviewed bytes differ or duplicate');
    artifacts.set(record.path, record.utf8);
  }
  const authority = projectPreparationAuthority(artifacts);
  for (const name of ['preparationRevision', 'requirementsAuthority', 'normativeSha256', 'normativeProjection', 'deliveries']) {
    if (JSON.stringify(snapshot[name]) !== JSON.stringify(authority[name])) reject(`snapshot ${name} differs from final review`);
  }
  return authority;
}

export async function captureApprovedPreparation({ candidateExecutionRoot, reviewDecision }) {
  const { resolveExecutionWorkspace } = await import('./execution-state.mjs');
  const { marker } = await assertOwnedPreparationCandidate({ candidateExecutionRoot, resolveWorkspace: resolveExecutionWorkspace });
  if (marker.operation !== 'REVIEW_PLAN') reject('only the joint reviewer can capture approval');
  const artifacts = await readPreparationArtifacts(candidateExecutionRoot);
  const authority = projectPreparationAuthority(artifacts);
  if (!/^status: ready$/mu.test(artifacts.get('tasks.md'))) reject('joint review must approve the final Tasks index');
  for (const [name, text] of artifacts) if (name !== 'tasks.md') {
    const parsed = parsePreparationArtifact(text, name);
    if (parsed.metadata.status !== 'ready' || (parsed.kind !== 'task' && parsed.fields['Review state'] !== 'approved')) reject('review must approve the final Plan and Tasks before snapshot');
  }
  const snapshot = { format: 'stnl-preparation-v2', ...authority, reviewDecision,
    reviewedArtifacts: [...artifacts].map(([name, utf8]) => ({ path: name, sha256: sha256(Buffer.from(utf8)), utf8 })) };
  validateApprovedPreparation(snapshot);
  await fs.writeFile(path.join(candidateExecutionRoot, 'approved-preparation.json'), JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return snapshot;
}

export async function assignDeliveryIdentities(candidateExecutionRoot, marker) {
  const { resolveExecutionWorkspace } = await import('./execution-state.mjs');
  const owned = await assertOwnedPreparationCandidate({ candidateExecutionRoot, resolveWorkspace: resolveExecutionWorkspace });
  if (JSON.stringify(owned.marker) !== JSON.stringify(marker)) reject('delivery identity producer requires its exact candidate marker');
  for (const file of (await fs.readdir(path.join(candidateExecutionRoot, 'plans'))).sort()) {
    if (!/^slice-[0-9]{2,}\.md$/u.test(file)) reject('noncanonical detailed plan');
    const planFile = path.join(candidateExecutionRoot, 'plans', file); const taskFile = path.join(candidateExecutionRoot, 'tasks', file);
    const plan = await fs.readFile(planFile, 'utf8'); const task = await fs.readFile(taskFile, 'utf8');
    const existing = plan.match(/^- Delivery ID: (.+)$/mu)?.[1]; const taskId = task.match(/^- Delivery ID: (.+)$/mu)?.[1];
    if (existing && (!UUID.test(existing) || (taskId && taskId !== existing))) reject('conflicting delivery identity');
    const id = marker.historicalSlices.includes(path.basename(file, '.md')) ? existing : marker.deliveryIds[file] ?? randomUUID();
    marker.deliveryIds[file] = id;
    for (const [target, text] of [[planFile, plan], [taskFile, task]]) {
      const revised = text.match(/^- Delivery ID: /mu) ? text.replace(/^- Delivery ID: .+$/mu, `- Delivery ID: ${id}`)
        : text.replace(/(## References\n\n)/u, `$1- Delivery ID: ${id}\n`);
      if (revised !== text) await fs.writeFile(target, revised, 'utf8');
    }
  }
}

function operationalImage(artifacts, slice) {
  const task = parsePreparationArtifact(artifacts.get(`tasks/${slice}.md`), `tasks/${slice}.md`);
  const plan = parsePreparationArtifact(artifacts.get(`plans/${slice}.md`), `plans/${slice}.md`);
  return { checklist: task.sections.Checklist.replaceAll('- [x]', '- [ ]'), expectedFiles: task.sections['Expected Files'], planExpectedFiles: plan.sections['Expected Files'] };
}

// Typed operational scope check shared by execution and validation publishers.
// The caller supplies the trusted admitted owner, never model-authored metadata.
export function assertOperationalTaskHistory(beforeText, afterText, owner, operation) {
  const before = parsePreparationArtifact(beforeText, `tasks/${owner.slice}.md`);
  const after = parsePreparationArtifact(afterText, `tasks/${owner.slice}.md`);
  for (const heading of ['Operational Changes', 'Implementation Test Evidence', 'Findings Test Evidence', 'Validation Attempts']) {
    const previous = before.sections[heading]; const next = after.sections[heading];
    if (previous === next) continue;
    if (previous !== '- none' && !next.startsWith(previous + '\n')) reject(`${heading} rewrote historical records`);
    if (heading === 'Operational Changes') continue;
    const added = previous === '- none' ? next : next.slice(previous.length).trim();
    for (const record of added.split(/(?=^### )/mu).filter(value => value.trim())) {
      for (const [field, expected] of [['Delivery ID', owner.deliveryId], ['Preparation revision', String(owner.preparationRevision)],
        ['Normative sha256', owner.normativeSha256], ['Operation attempt ID', owner.operationAttemptId], ['Origin activation ID', owner.originActivationId]]) {
        if (!record.split('\n').includes(`- ${field}: ${expected}`)) reject(`new evidence ${field} differs from admitted owner`);
      }
      if ((heading === 'Validation Attempts') !== (operation === 'VALIDATE_SLICE')
        || (heading === 'Implementation Test Evidence' && operation !== 'EXECUTE_SLICE')
        || (heading === 'Findings Test Evidence' && operation !== 'APPLY_FINDINGS')) reject('operation attempted to write another evidence authority');
    }
  }
  for (const heading of ['Changed Areas', 'Corrections Applied']) {
    const previous = before.sections[heading];
    if (!['- none', '- pending'].includes(previous) && previous.split('\n').some(line => !after.sections[heading].split('\n').includes(line))) reject(`${heading} erased historical implementation scope`);
  }
  if (operation !== 'VALIDATE_SLICE' && ['Validation Findings', 'Effective Validation Base', 'Final Result'].some(heading => before.sections[heading] !== after.sections[heading])) reject('execution cannot change formal validation authority');
}

export async function updateOperationalChecklist({ candidateExecutionRoot, slice, reason, checklist, expectedFiles = null }) {
  populated(reason, 'operational change reason');
  const { resolveExecutionWorkspace, readExecutionActivation } = await import('./execution-state.mjs');
  const { marker } = await assertOwnedOperationalCandidate({ candidateExecutionRoot, slice,
    resolveWorkspace: resolveExecutionWorkspace, readActivated: readExecutionActivation });
  if (!['EXECUTE_SLICE', 'APPLY_FINDINGS'].includes(marker.owner.operation)) reject('checklist delta requires implementation ownership');
  const beforeArtifacts = await readPreparationArtifacts(candidateExecutionRoot);
  const beforeAuthority = projectPreparationAuthority(beforeArtifacts);
  const taskPath = `tasks/${slice}.md`; const planPath = `plans/${slice}.md`;
  if (!beforeArtifacts.has(taskPath)) reject('operational change selects absent delivery');
  const beforeImage = operationalImage(beforeArtifacts, slice);
  let taskText = beforeArtifacts.get(taskPath);
  const replaceCarrier = (text, carrier, value) => text.replace(new RegExp(`(^## ${carrier}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'mu'), `$1${value}\n\n`);
  taskText = replaceCarrier(taskText, 'Checklist', checklist);
  if (expectedFiles !== null) {
    preparationPathClaims(expectedFiles, 'expected files');
    taskText = replaceCarrier(taskText, 'Expected Files', expectedFiles);
    beforeArtifacts.set(planPath, replaceCarrier(beforeArtifacts.get(planPath), 'Expected Files', expectedFiles));
  }
  beforeArtifacts.set(taskPath, taskText);
  const afterAuthority = projectPreparationAuthority(beforeArtifacts);
  if (afterAuthority.normativeSha256 !== beforeAuthority.normativeSha256) reject('operational change altered normative authority');
  const afterImage = operationalImage(beforeArtifacts, slice);
  const existing = parsePreparationArtifact(taskText, taskPath).sections['Operational Changes'];
  const ids = [...existing.matchAll(/^### operational-change-([0-9]{2,})$/gmu)].map(match => Number(match[1]));
  const id = `operational-change-${String(ids.length + 1).padStart(2, '0')}`;
  const record = `### ${id}\n- Reason: ${reason}\n- Affected steps: ${afterImage.checklist.split('\n').map(line => line.match(/^- \[ \] ([0-9]+\.[0-9]+)/u)?.[1]).join(', ')}\n- Before sha256: ${sha256(JSON.stringify(beforeImage))}\n- After sha256: ${sha256(JSON.stringify(afterImage))}\n- Obligation associations: ${checklist.split('\n').map(line => line.slice(line.indexOf(' | obligations: ') + 16)).join('; ')}\n- Expected files: ${expectedFiles === null ? 'unchanged' : preparationPathClaims(expectedFiles, 'expected files').join(', ') || 'none'}`;
  taskText = replaceCarrier(taskText, 'Operational Changes', existing === '- none' ? record : `${existing}\n\n${record}`);
  await fs.writeFile(path.join(candidateExecutionRoot, taskPath), taskText);
  if (expectedFiles !== null) await fs.writeFile(path.join(candidateExecutionRoot, planPath), beforeArtifacts.get(planPath));
  return { id, beforeSha256: sha256(JSON.stringify(beforeImage)), afterSha256: sha256(JSON.stringify(afterImage)), normativeSha256: beforeAuthority.normativeSha256 };
}

export async function validateOperationalChanges(root, snapshot) {
  const current = await readPreparationArtifacts(root);
  const initial = new Map(snapshot.reviewedArtifacts.map(record => [record.path, record.utf8]));
  for (const { slice } of snapshot.deliveries) {
    const initialHash = sha256(JSON.stringify(operationalImage(initial, slice)));
    const currentHash = sha256(JSON.stringify(operationalImage(current, slice)));
    const task = parsePreparationArtifact(current.get(`tasks/${slice}.md`), `tasks/${slice}.md`);
    const changes = task.sections['Operational Changes'];
    if (changes === '- none') { if (currentHash !== initialHash) reject('technical checklist/forecast change requires operational delta'); continue; }
    const records = changes.split(/(?=^### operational-change-)/mu).filter(value => value.trim());
    let expected = initialHash;
    for (let index = 0; index < records.length; index += 1) {
      const prefix = `### operational-change-${String(index + 1).padStart(2, '0')}\n`;
      if (!records[index].startsWith(prefix)) reject('nonsequential operational changes');
      const fields = inlineFields(records[index].slice(prefix.length).trim(), 'operational change');
      keys(fields, ['Reason', 'Affected steps', 'Before sha256', 'After sha256', 'Obligation associations', 'Expected files'], 'operational change');
      if (fields['Before sha256'] !== expected || !HASH.test(fields['After sha256'])) reject('operational delta hash chain differs');
      expected = fields['After sha256'];
    }
    if (currentHash !== expected) reject('current operational image differs from recorded delta');
  }
}

export function preparationAreaClaims(body) {
  preparationPathClaims(body, 'Authorized Areas');
  if (body === '- none') reject('a delivery requires explicit authorized areas');
  return body.split('\n').map(line => {
    const match = /^- (directory|file): `([^`]+)`$/u.exec(line);
    if (!match) reject('Authorized Areas require explicit directory or file kind');
    return { kind: match[1], path: match[2] };
  });
}
