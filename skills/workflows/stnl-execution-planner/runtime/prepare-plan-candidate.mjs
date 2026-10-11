#!/usr/bin/env node

import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assignDeliveryIdentities, parseStrictJson, parsePreparationArtifact } from './execution-preparation.mjs';
import { resolveExecutionWorkspace, computeRequirementsAuthority } from './execution-state.mjs';
import { captureExecutionTree, assertOwnedPreparationCandidate } from './execution-publication.mjs';

const RUNTIME_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.dirname(RUNTIME_ROOT);
const PLAN_TEMPLATE = path.join(SKILL_ROOT, "templates", "plan.template.md");
const SLICE_PLAN_TEMPLATE = path.join(SKILL_ROOT, "templates", "slice-plan.template.md");
const HEADER_PATTERN = /^# File Purpose Header\n\n```yaml\n([\s\S]*?)^```\n\n/mu;

function blocked(message) {
  throw new Error(`plan candidate preparation blocked: ${message}`);
}

async function readRegularFile(file, label) {
  const metadata = await fs.lstat(file).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile()) {
    blocked(`${label} is not a real regular file: ${file}`);
  }
  return fs.readFile(file, "utf8");
}

function canonicalHeader(template, label) {
  const match = HEADER_PATTERN.exec(template);
  if (match === null) blocked(`${label} template has no canonical File Purpose Header`);
  return match[0];
}

function parseHeaderFields(block, label) {
  const match = HEADER_PATTERN.exec(block);
  if (match === null || match.index !== 0 || match[0] !== block) {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }
  const lines = match[1].split("\n");
  if (lines.at(-1) === "") lines.pop();
  const fields = new Map();
  for (const line of lines) {
    const field = /^([a-z][a-z0-9_]*): (\S.*)$/u.exec(line);
    if (field === null || fields.has(field[1])) {
      blocked(`${label} has a malformed or conflicting File Purpose Header`);
    }
    fields.set(field[1], field[2]);
  }
  return fields;
}

function prepareHeader(text, header, label) {
  const match = HEADER_PATTERN.exec(text);
  if (match === null) {
    if (text.includes("# File Purpose Header")) {
      blocked(`${label} has a malformed or conflicting File Purpose Header`);
    }
    return `${header}${text}`;
  }
  if (match.index !== 0) {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }

  const sourceFields = parseHeaderFields(match[0], label);
  const canonicalFields = parseHeaderFields(header, `${label} template`);
  const sourceKeys = [...sourceFields.keys()].sort();
  const canonicalKeys = [...canonicalFields.keys()].sort();
  if (JSON.stringify(sourceKeys) !== JSON.stringify(canonicalKeys)) {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }
  const status = sourceFields.get("status");
  if (status !== "draft" && status !== "ready") {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }
  const remainder = text.slice(match[0].length);
  if (/^# File Purpose Header(?:\n|$)/mu.test(remainder)) {
    blocked(`${label} has a malformed or conflicting File Purpose Header`);
  }
  const canonicalForStatus = header.replace(/^status: draft$/mu, `status: ${status}`);
  return `${canonicalForStatus}${remainder}`;
}

async function writeAtomically(file, text) {
  const temporary = `${file}.stnl-purpose-header-${process.pid}.tmp`;
  await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function assertPreparationCandidate(candidateExecutionRoot, specPath = null) {
  return assertOwnedPreparationCandidate({ candidateExecutionRoot, specPath, resolveWorkspace: resolveExecutionWorkspace });
}

async function prepareReviewedSupersessions(candidate, marker) {
  if (marker.operation !== 'REVIEW_PLAN') return;
  const global = parsePreparationArtifact(await fs.readFile(path.join(candidate, 'plan.md'), 'utf8'), 'plan.md');
  if (global.fields['Revision mode'] !== 'append-only-extension') return;
  const mappings = global.fields['Supersedes open slices'];
  if (mappings === 'none') return;
  let index = await fs.readFile(path.join(candidate, 'tasks.md'), 'utf8');
  for (const mapping of mappings.split(', ')) {
    const pair = /^(slice-[0-9]{2,}) -> (slice-[0-9]{2,})$/u.exec(mapping);
    if (!pair) blocked('malformed declared supersession');
    const [, source, target] = pair;
    const taskFile = path.join(candidate, 'tasks', source + '.md');
    const text = await fs.readFile(taskFile, 'utf8');
    const task = parsePreparationArtifact(text, `tasks/${source}.md`);
    if (task.sections['Final Result'] === '- PASS') blocked('review cannot supersede historical PASS');
    const result = `- SUPERSEDED\n- Superseded by: ${target}\n- Plan revision: ${global.fields['Plan revision']}`;
    const revised = text.replace(/(^## Final Result\n\n)[\s\S]*$/mu, `$1${result}\n`);
    if (revised !== text) await fs.writeFile(taskFile, revised, 'utf8');
    const rows = index.split('\n');
    const position = rows.findIndex(row => row.startsWith('| [') && row.split('|')[5]?.trim() === `tasks/${source}.md`);
    if (position < 0) blocked('supersession lacks historical progress row');
    const cells = rows[position].split('|'); cells[1] = ' [x] '; cells[6] = ' SUPERSEDED '; cells[7] = ' SUPERSEDED ';
    rows[position] = cells.join('|'); index = rows.join('\n');
  }
  await fs.writeFile(path.join(candidate, 'tasks.md'), index, 'utf8');
}

export async function preparePlanCandidate({ candidateExecutionRoot }) {
  const { root: candidate, marker, workspace } = await assertPreparationCandidate(candidateExecutionRoot);
  const candidateMetadata = await fs.lstat(candidate).catch(() => null);
  if (candidateMetadata === null || candidateMetadata.isSymbolicLink() || !candidateMetadata.isDirectory()) {
    blocked(`candidate execution root is not a real directory: ${candidate}`);
  }

  const [planTemplate, slicePlanTemplate] = await Promise.all([
    readRegularFile(PLAN_TEMPLATE, "plan template"),
    readRegularFile(SLICE_PLAN_TEMPLATE, "slice-plan template"),
  ]);
  const headers = {
    plan: canonicalHeader(planTemplate, "plan"),
    slice: canonicalHeader(slicePlanTemplate, "slice-plan"),
  };
  const artifacts = [{
    path: path.join(candidate, "plan.md"),
    header: headers.plan,
    label: "candidate plan.md",
  }];
  const plansDirectory = path.join(candidate, "plans");
  const directoryMetadata = await fs.lstat(plansDirectory).catch(() => null);
  if (directoryMetadata !== null) {
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      blocked(`candidate plans directory is not a real directory: ${plansDirectory}`);
    }
    const entries = await fs.readdir(plansDirectory, { withFileTypes: true });
    for (const entry of entries.filter((item) => /^slice-\d+\.md$/u.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      artifacts.push({
        path: path.join(plansDirectory, entry.name),
        header: headers.slice,
        label: `candidate ${entry.name}`,
      });
    }
  }

  artifacts.push({ path: path.join(candidate, 'tasks.md'),
    header: canonicalHeader(await readRegularFile(path.join(SKILL_ROOT, 'templates/tasks.template.md'), 'tasks template'), 'tasks'), label: 'candidate tasks.md' });
  const taskHeader = canonicalHeader(await readRegularFile(path.join(SKILL_ROOT, 'templates/slice-tasks.template.md'), 'task template'), 'task');
  for (const entry of await fs.readdir(path.join(candidate, 'tasks'))) {
    if (!/^slice-\d+\.md$/u.test(entry)) blocked('noncanonical task artifact');
    artifacts.push({ path: path.join(candidate, 'tasks', entry), header: taskHeader, label: entry });
  }
  const preparedArtifacts = [];
  for (const artifact of artifacts) {
    const before = await readRegularFile(artifact.path, artifact.label);
    let after = prepareHeader(before, artifact.header, artifact.label);
    const relative = path.relative(candidate, artifact.path).split(path.sep).join('/');
    const slice = /^(?:plans|tasks)\/(slice-[0-9]{2,})\.md$/u.exec(relative)?.[1];
    if (!slice || !marker.historicalSlices.includes(slice)) {
      const set = (name, value) => {
        const line = `- ${name}: ${value}`;
        const pattern = new RegExp(`^- ${name}: .+$`, 'mu');
        if (pattern.test(after)) after = after.replace(pattern, line);
        else after = after.replace(/(^## (?:Global Context|References)\n\n)/mu, `$1${line}\n`);
      };
      if (relative !== 'tasks.md') {
        set('Requirements source', '`' + path.relative(path.dirname(path.join(workspace.executionRoot, relative)), workspace.authorityPath).split(path.sep).join('/') + '`');
        set('Requirements authority', `sha256:${await computeRequirementsAuthority(marker.specPath)}`);
        set('Plan revision', String(marker.preparationRevision));
      }
      if (slice) {
        set('Slice', slice.slice(6));
        if (relative.startsWith('plans/')) set('Global plan', '`../plan.md`');
        else { set('Plan', '`../plans/' + slice + '.md`'); set('Global tasks', '`../tasks.md`'); }
      }
      if (marker.operation !== 'REVIEW_PLAN') {
        after = after.replace('status: ready', 'status: draft').replace('- Review state: approved', '- Review state: pending');
        if (relative === 'plan.md' && marker.revisionMode) {
          set('Revision mode', marker.revisionMode);
          if (!after.includes('- Supersedes open slices:')) set('Supersedes open slices', 'none');
        }
      }
    }
    preparedArtifacts.push({ path: artifact.path, before, after });
  }

  const changedPaths = [];
  for (const artifact of preparedArtifacts) {
    if (artifact.after === artifact.before) continue;
    await writeAtomically(artifact.path, artifact.after);
    changedPaths.push(artifact.path);
  }
  await assignDeliveryIdentities(candidate, marker);
  await prepareReviewedSupersessions(candidate, marker);
  await fs.writeFile(`${candidate}.owner.json`, JSON.stringify(marker) + '\n', { mode: 0o600 });
  return Object.freeze({
    status: "PASS",
    changedPaths: Object.freeze(changedPaths),
  });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 2 || arguments_[0] !== "--candidate-execution-root") {
    throw new Error("usage: prepare-plan-candidate.mjs --candidate-execution-root CANDIDATE_EXECUTION_ROOT");
  }
  const result = await preparePlanCandidate({ candidateExecutionRoot: arguments_[1] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
