// Shared physical workspace and requirements authority for the current workflow.
// No execution format, retained history or operation interpreter is loaded here.
import {createHash} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {parseStrictJson,readOwnedFile,hasOwnedAllocationEnvelope} from "./execution-publication.mjs";

const HASH_DOMAIN = Buffer.from("stnl-requirements-authority-v1\0", "utf8");

const ACTIVE_TO_CLOSED = new Map([
  ["Objective", "Objective"],
  ["Context", "Context"],
  ["Scope", "Final Scope"],
  ["Out of Scope", "Out of Scope"],
  ["Business Rules", "Business Rules"],
  ["Relevant Contracts", "Important Contracts"],
]);

const CLOSED_RECORD_SECTIONS = new Set([
  "Requirements", "Final Acceptance Criteria", "Durable Decisions", "Relevant Constraints",
  "Relevant Risks", "Durable Resolved Questions",
]);

const PURPOSE_HEADER_FIELDS = ["purpose", "status", "read_when", "do_not_read_when", "contains", "owner", "update_policy"];

export class ExecutionContractError extends Error {
  constructor(message, findings = [], recoveryTargets = [], contractViolation = null) {
    super(message);
    this.name = "ExecutionContractError";
    this.findings = findings;
    this.recoveryTargets = recoveryTargets;
    this.contractViolation = contractViolation;
  }
}

export function isIgnoredMetadata(name) {
  return name === ".DS_Store" || name === "__MACOSX" || name.startsWith("._");
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function requireRealFile(filePath, label) {
  const metadata = await lstatOrNull(filePath);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    throw new ExecutionContractError(`${label} must be a single-link real file: ${filePath}`, [filePath]);
  }
  return filePath;
}

async function assertNoSymlinkComponents(filePath, label) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstatOrNull(current);
    if (metadata === null) break;
    if (metadata.isSymbolicLink()) {
      const allowedDarwinAlias = process.platform === "darwin" && ["/etc", "/tmp", "/var"].includes(current);
      if (!allowedDarwinAlias) throw new ExecutionContractError(`${label} contains a symlink component: ${current}`);
    }
  }
}

export async function resolveCurrentExecutionContext(specPath) {
  const requested = path.resolve(String(specPath));
  await assertNoSymlinkComponents(requested, 'SPEC_PATH');
  const metadata = await lstatOrNull(requested);
  if (metadata === null || metadata.isSymbolicLink()) {
    const error = new ExecutionContractError('SPEC_PATH must be an existing real file or directory', [requested]);
    error.code = 'UNSAFE_PATH'; throw error;
  }
  const physical = await fs.realpath(requested);
  const workspace = await resolvePhysicalExecutionWorkspace(physical);
  const productRoot = await trustedProjectRoot(workspace);
  const operationalRoot = path.join(productRoot, 'tmp', 'sentinel');
  if (pathIsWithin(physical, operationalRoot)) {
    const error = new ExecutionContractError('known EC-1 operational namespace cannot be selected as official SPEC_PATH', [physical, operationalRoot]);
    error.code = 'TEMP_ROOT_UNPROVEN'; throw error;
  }
  let selected = metadata.isDirectory() ? physical : path.dirname(physical);
  while (true) {
    const parent = path.dirname(selected);
    const siblingNames = new Set(await fs.readdir(parent));
    const markers = [`${selected}.copy.json`, `${selected}.publication.json`, `${selected}.owner.json`];
    const generated = /^\.stnl-execution-(?:stage|backup)-([a-f0-9-]{36})$/u.exec(path.basename(selected));
    if (generated) markers.push(path.join(parent, `.stnl-execution-publication-${generated[1]}.json`));
    for (const marker of markers) {
      if (!siblingNames.has(path.basename(marker))) continue;
      let record;
      try { record = parseStrictJson((await readOwnedFile(marker)).bytes.toString('utf8')); }
      catch { const error = new ExecutionContractError('allocation root identity is uncertain; preserve it', [marker]); error.code = 'TEMP_ROOT_UNPROVEN'; throw error; }
      if (!hasOwnedAllocationEnvelope(record, marker)) continue;
      const roots = [record.candidate, record.stage, record.backup, record.retentionRoot].filter(Boolean);
      if (roots.some(root => pathIsWithin(physical, root))) {
        const error = new ExecutionContractError('operational allocation cannot be selected as official SPEC_PATH', [physical, marker]);
        error.code = 'TEMP_ROOT_UNPROVEN'; throw error;
      }
    }
    if (parent === selected) break;
    selected = parent;
  }
  const context = {logicalSpecRoot: workspace.specRoot, logicalAuthorityPath: workspace.authorityPath,
    logicalExecutionRoot: workspace.executionRoot, physicalExecutionRoot: workspace.executionRoot,
    productRoot};
  return {workspace, context};
}

async function resolvePhysicalExecutionWorkspace(physical) {
  const metadata = await lstatOrNull(physical);
  if (metadata.isDirectory()) {
    const authorityPath = path.join(physical, "feature_spec.md");
    await requireRealFile(authorityPath, "workspace feature_spec.md");
    return { kind: "lifecycle", specRoot: physical, authorityPath, executionRoot: path.join(physical, "execution") };
  }
  if (!metadata.isFile()) throw new ExecutionContractError(`SPEC_PATH must be a workspace directory or requirements file: ${physical}`);
  await requireRealFile(physical, "standalone requirements source");
  if (path.basename(physical) === "feature_spec.md") {
    return { kind: "lifecycle", specRoot: path.dirname(physical), authorityPath: physical, executionRoot: path.join(path.dirname(physical), "execution") };
  }
  const parsed = path.parse(physical);
  return { kind: "standalone", specRoot: null, authorityPath: physical, executionRoot: path.join(parsed.dir, `${parsed.name}-execution`) };
}

function normalizeText(value) {
  return String(value).replaceAll("\r\n", "\n").trim();
}

function parsePurpose(text, label) {
  const match = text.match(/^# File Purpose Header\n\n```yaml\n([\s\S]*?)```\n\n/u);
  if (match === null) throw new ExecutionContractError(`${label} is missing the File Purpose Header`);
  const header = new Map();
  for (const line of match[1].split("\n").filter(Boolean)) {
    const field = line.match(/^([a-z_]+): (\S.*)$/u);
    if (field === null || header.has(field[1])) throw new ExecutionContractError(`${label} has a malformed File Purpose Header`);
    header.set(field[1], field[2]);
  }
  const keys = [...header.keys()];
  if (keys.length !== PURPOSE_HEADER_FIELDS.length || keys.some((key, index) => key !== PURPOSE_HEADER_FIELDS[index])) {
    throw new ExecutionContractError(`${label} has non-canonical File Purpose Header fields`);
  }
  return { header, body: text.slice(match[0].length) };
}

function sections(body) {
  const result = new Map();
  const matches = [...body.matchAll(/^## ([^\n]+)\n/gmu)];
  for (let index = 0; index < matches.length; index += 1) {
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length;
    if (result.has(matches[index][1])) throw new ExecutionContractError(`duplicate section: ${matches[index][1]}`);
    result.set(matches[index][1], normalizeText(body.slice(matches[index].index + matches[index][0].length, end)));
  }
  return result;
}

function canonicalRecords(text) {
  const matches = [...text.matchAll(/^### ((?:R|AC|D|C|RK|Q)-[0-9]{3}) — [^\n]+$/gmu)];
  const result = [];
  for (let index = 0; index < matches.length; index += 1) {
    const nextH3 = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const nextH2 = text.indexOf("\n## ", matches[index].index + 1);
    const end = nextH2 >= 0 && nextH2 < nextH3 ? nextH2 : nextH3;
    result.push([matches[index][1], normalizeText(text.slice(matches[index].index, end))]);
  }
  return result;
}

function stableEncode(value) {
  return Buffer.from(JSON.stringify(value), "utf8");
}

async function lifecycleProjection(workspace) {
  const featureText = await fs.readFile(workspace.authorityPath, "utf8");
  const sharedTexts = new Map();
  const shared = path.join(workspace.specRoot, "shared");
  const status = parsePurpose(featureText, 'feature_spec.md').header.get('status');
  const sharedMetadata = status === 'closed' ? null : await lstatOrNull(shared);
  if (sharedMetadata !== null) {
    if (sharedMetadata.isSymbolicLink() || !sharedMetadata.isDirectory()) throw new ExecutionContractError("shared must be a real directory");
    for (const entry of (await fs.readdir(shared, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (isIgnoredMetadata(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".md")) throw new ExecutionContractError(`shared contains a non-canonical authority entry: ${entry.name}`);
      sharedTexts.set(entry.name, await fs.readFile(path.join(shared, entry.name), "utf8"));
    }
  }
  return lifecycleProjectionFromTexts(workspace, featureText, sharedTexts);
}

function lifecycleProjectionFromTexts(workspace, featureText, sharedTexts) {
  const { header, body } = parsePurpose(featureText, "feature_spec.md");
  const status = header.get("status");
  const featureSections = sections(body);
  const h1 = body.match(/^# ([^\n]+)$/mu)?.[1];
  if (!h1) throw new ExecutionContractError("feature_spec.md has no canonical H1");
  const core = [];
  const records = [];
  if (status === "closed") {
    for (const [, closed] of ACTIVE_TO_CLOSED) {
      if (!featureSections.has(closed)) throw new ExecutionContractError(`closed feature_spec.md is missing ${closed}`);
      core.push([closed, featureSections.get(closed)]);
    }
    for (const heading of CLOSED_RECORD_SECTIONS) {
      if (featureSections.has(heading)) records.push(...canonicalRecords(`## ${heading}\n\n${featureSections.get(heading)}\n`));
    }
  } else {
    if (!["draft", "blocked", "ready"].includes(status)) throw new ExecutionContractError(`feature_spec.md has unsupported lifecycle status ${status}`);
    for (const [active, closed] of ACTIVE_TO_CLOSED) {
      if (!featureSections.has(active)) throw new ExecutionContractError(`active feature_spec.md is missing ${active}`);
      core.push([closed, featureSections.get(active)]);
    }
    for (const [name, sharedText] of [...sharedTexts].sort(([left], [right]) => left.localeCompare(right, "en"))) {
      if (isIgnoredMetadata(name)) continue;
      if (!name.endsWith('.md') || name.includes('/') || name.includes('\\')) throw new ExecutionContractError(`shared contains a non-canonical authority entry: ${name}`);
      records.push(...canonicalRecords(parsePurpose(sharedText, name).body));
    }
  }
  records.sort(([left], [right]) => left.localeCompare(right, "en"));
  if (new Set(records.map(([identifier]) => identifier)).size !== records.length) throw new ExecutionContractError("lifecycle authority contains duplicate canonical IDs");
  return { h1, core, records };
}

export function projectCurrentRequirements({workspace, files}) {
  if (!(files instanceof Map) || !workspace || !['lifecycle', 'standalone'].includes(workspace.kind)) {
    const error = new ExecutionContractError('current requirements require a captured documentary Map');
    error.code = 'INVALID_CURRENT_IMAGE'; throw error;
  }
  const allowed = file => file === workspace.authorityPath
    || (workspace.kind === 'lifecycle' && path.dirname(file) === path.join(workspace.specRoot, 'shared')
      && path.basename(file).endsWith('.md'));
  for (const [file, bytes] of files) if (!allowed(file) || !(bytes instanceof Uint8Array)) {
    const error = new ExecutionContractError(`unexpected documentary path or bytes: ${file}`);
    error.code = 'INVALID_CURRENT_IMAGE'; throw error;
  }
  if (!files.has(workspace.authorityPath)) {
    const error = new ExecutionContractError('requirements source is absent from captured documents');
    error.code = 'REQUIREMENTS_CHANGED'; throw error;
  }
  const decode = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const source = files.get(workspace.authorityPath);
  let payload, documentStatus = null;
  if (workspace.kind === 'standalone') payload = source;
  else {
    const sharedTexts = new Map();
    for (const [file, bytes] of files) if (file !== workspace.authorityPath) sharedTexts.set(path.basename(file), decode(bytes));
    const text = decode(source);
    documentStatus = parsePurpose(text, 'feature_spec.md').header.get('status');
    payload = stableEncode(lifecycleProjectionFromTexts(workspace, text, sharedTexts));
  }
  return {requirementsAuthority: `sha256:${createHash('sha256').update(HASH_DOMAIN).update(payload).digest('hex')}`, documentStatus};
}

async function trustedProjectRoot(workspace) {
  const logicalWorkspace = logicalWorkspaceFor(workspace);
  let current = path.dirname(logicalWorkspace.authorityPath);
  for (;;) {
    const marker = await lstatOrNull(path.join(current, ".git"));
    if (marker !== null && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return logicalWorkspace.specRoot ?? path.dirname(logicalWorkspace.authorityPath);
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function logicalWorkspaceFor(workspace) {
  return workspace.logicalWorkspace ?? workspace;
}

export async function resolveExecutionWorkspace(specPath) { return (await resolveCurrentExecutionContext(specPath)).workspace; }
export async function computeRequirementsAuthority(specPath) {
  const {workspace}=await resolveCurrentExecutionContext(specPath);
  const payload=workspace.kind==="standalone"?await fs.readFile(workspace.authorityPath):stableEncode(await lifecycleProjection(workspace));
  return createHash("sha256").update(HASH_DOMAIN).update(payload).digest("hex");
}
