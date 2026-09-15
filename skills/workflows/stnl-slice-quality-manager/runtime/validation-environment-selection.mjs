import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  computeRequirementsAuthority,
  resolveExecutionWorkspace,
} from "./execution-state.mjs";

export const VALIDATION_ENVIRONMENT_DISCOVERY_SCHEMA = "stnl-validation-environment-discovery/v1";
export const VALIDATION_ENVIRONMENT_SELECTION_SCHEMA = "stnl-validation-environment-selection/v1";
export const VALIDATION_PLANNING_BLOCKER_SCHEMA = "stnl-validation-planning-blocker/v1";

const COMPOSE_NAMES = new Set(["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"]);
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;

export class ValidationEnvironmentSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ValidationEnvironmentSelectionError";
    this.code = code;
  }
}

function environmentFail(code, message) {
  throw new ValidationEnvironmentSelectionError(code, `validation environment selection rejected before harness dispatch: ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(domain, value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical([domain, value]))).digest("hex")}`;
}

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizedRelative(value, label) {
  if (value === ".") return value;
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")
    || value.endsWith("/") || path.posix.isAbsolute(value) || path.posix.normalize(value) !== value
    || value === ".." || value.startsWith("../")) {
    environmentFail("INVALID_ENVIRONMENT_DISCOVERY_SCOPE", `${label} must be a normalized project-relative path`);
  }
  return value;
}

async function lstatOrNull(target) {
  try { return await fs.lstat(target); } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

async function aggregateRoot(specPath) {
  const workspace = await resolveExecutionWorkspace(specPath);
  let current = path.dirname(workspace.authorityPath);
  for (;;) {
    const marker = await lstatOrNull(path.join(current, ".git"));
    if (marker !== null && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) return fs.realpath(current);
    const parent = path.dirname(current);
    if (parent === current) return fs.realpath(workspace.specRoot ?? path.dirname(workspace.authorityPath));
    current = parent;
  }
}

async function admittedFile(root, relative) {
  const normalized = normalizedRelative(relative, "environment discovery reference");
  const target = path.resolve(root, normalized);
  if (!within(target, root)) environmentFail("ENVIRONMENT_REFERENCE_ESCAPE", `${relative} escapes the aggregate workspace`);
  const metadata = await lstatOrNull(target);
  if (metadata === null) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    environmentFail("INVALID_ENVIRONMENT_REFERENCE", `${relative} must be a single-link project file`);
  }
  const canonicalTarget = await fs.realpath(target);
  if (canonicalTarget !== target || !within(canonicalTarget, root)) {
    environmentFail("INVALID_ENVIRONMENT_REFERENCE", `${relative} is not canonically contained in the aggregate workspace`);
  }
  const bytes = await fs.readFile(target);
  return Object.freeze({
    path: normalized,
    identity: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    text: bytes.toString("utf8"),
  });
}

async function admittedDirectory(root, relative, component) {
  const target = path.resolve(root, normalizedRelative(relative, "selected component cwd"));
  if (!within(target, root)) {
    environmentFail("VALIDATION_ENVIRONMENT_COMPONENT_MISMATCH", `${component} cwd is outside the aggregate workspace`);
  }
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const metadata = await lstatOrNull(current);
    if (metadata?.isSymbolicLink()) {
      environmentFail("VALIDATION_ENVIRONMENT_COMPONENT_MISMATCH", `${component} cwd traverses a symlink`);
    }
    if (metadata === null || !metadata.isDirectory()) {
      environmentFail("VALIDATION_ENVIRONMENT_COMPONENT_MISMATCH", `${component} cwd is absent from the aggregate workspace`);
    }
  }
  const canonicalTarget = await fs.realpath(target);
  if (canonicalTarget !== target || !within(canonicalTarget, root)) {
    environmentFail("VALIDATION_ENVIRONMENT_COMPONENT_MISMATCH", `${component} cwd is not canonically contained in the aggregate workspace`);
  }
  return target;
}

function jsonWithoutComments(source, label) {
  let parsed;
  try {
    parsed = JSON.parse(source.replace(/^\s*\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, ""));
  } catch {
    environmentFail("UNSUPPORTED_ENVIRONMENT_CONFIGURATION", `${label} is not supported JSON/JSONC`);
  }
  return parsed;
}

function referencedPaths(source) {
  const candidates = source.match(/(?:^|[`'"(\s])((?:\.?[A-Za-z0-9_-][A-Za-z0-9_./-]*\/)?[A-Za-z0-9_.-]+\.(?:json|jsonc|md|yml|yaml))(?:$|[`'"),\s])/gmu) ?? [];
  return candidates.map((entry) => entry.trim().replace(/^[`'"(]/u, "").replace(/[`'"),]$/u, ""))
    .filter((entry) => !entry.startsWith("/") && !entry.startsWith("../"));
}

function workspaceRelative(value, fallback = ".") {
  if (typeof value !== "string") return fallback;
  const replaced = value.replace(/^\$\{workspaceFolder\}\/?/u, "").replace(/^\$\{workspaceRoot\}\/?/u, "");
  return replaced === "" ? "." : replaced;
}

function composeImage(source, service) {
  if (source.includes("\t")) return null;
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const servicesIndex = lines.findIndex((line) => /^services:\s*(?:#.*)?$/u.test(line));
  if (servicesIndex < 0) return null;
  const servicePattern = new RegExp(`^  ${service.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:\\s*(?:#.*)?$`, "u");
  const serviceIndex = lines.findIndex((line, index) => index > servicesIndex && servicePattern.test(line));
  if (serviceIndex < 0) return null;
  for (let index = serviceIndex + 1; index < lines.length; index += 1) {
    if (/^  \S/u.test(lines[index])) break;
    const match = /^    image:\s*(.+?)\s*$/u.exec(lines[index]);
    if (match === null) continue;
    let image = match[1].replace(/\s+#.*$/u, "").trim();
    if ((image.startsWith("\"") && image.endsWith("\"")) || (image.startsWith("'") && image.endsWith("'"))) image = image.slice(1, -1);
    return image.includes("${") ? null : image;
  }
  return null;
}

function composeScalar(value) {
  let scalar = value.trim().replace(/\s+#.*$/u, "").trim();
  if ((scalar.startsWith("\"") && scalar.endsWith("\"")) || (scalar.startsWith("'") && scalar.endsWith("'"))) {
    scalar = scalar.slice(1, -1);
  }
  return scalar.includes("${") ? null : scalar;
}

function composeConfiguration(source) {
  if (source.includes("\t")) return null;
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const meaningful = lines.map((text, index) => ({ text, index, indent: text.match(/^ */u)[0].length }))
    .filter(({ text }) => text.trim().length !== 0 && !text.trimStart().startsWith("#"));
  const servicesLines = meaningful.filter(({ text, indent }) => indent === 0 && text.trim() === "services:");
  if (servicesLines.length !== 1) return null;
  const afterServices = meaningful.filter(({ index }) => index > servicesLines[0].index);
  const servicesEnd = afterServices.find(({ indent }) => indent === 0)?.index ?? lines.length;
  const section = afterServices.filter(({ index }) => index < servicesEnd);
  const serviceIndent = section.reduce((minimum, entry) => Math.min(minimum, entry.indent), Infinity);
  if (!Number.isFinite(serviceIndent) || serviceIndent <= 0) return null;
  const headers = section.filter(({ indent, text }) => indent === serviceIndent
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}:\s*$/u.test(text.trim()));
  const services = [];
  for (const header of headers) {
    const service = header.text.trim().slice(0, -1);
    const afterService = section.filter(({ index }) => index > header.index);
    const serviceEnd = afterService.find(({ indent }) => indent <= serviceIndent)?.index ?? servicesEnd;
    const body = afterService.filter(({ index }) => index < serviceEnd);
    const propertyIndent = body.reduce((minimum, entry) => Math.min(minimum, entry.indent), Infinity);
    const imageLines = body.filter(({ indent, text }) => indent === propertyIndent && /^image\s*:/u.test(text.trim()));
    if (imageLines.length !== 1) continue;
    const image = composeScalar(imageLines[0].text.trim().replace(/^image\s*:/u, ""));
    if (image === null || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u.test(image)
      || image.includes("..") || image.endsWith("/") || image.endsWith(":")) continue;
    const workingLines = body.filter(({ indent, text }) => indent === propertyIndent && /^working_dir\s*:/u.test(text.trim()));
    const workingDirectory = workingLines.length === 1
      ? composeScalar(workingLines[0].text.trim().replace(/^working_dir\s*:/u, "")) : null;
    const volumeProperties = body.filter(({ indent, text }) => indent === propertyIndent && text.trim() === "volumes:");
    const volumes = [];
    if (volumeProperties.length === 1) {
      const afterVolumes = body.filter(({ index }) => index > volumeProperties[0].index);
      const volumesEnd = afterVolumes.find(({ indent }) => indent <= propertyIndent)?.index ?? serviceEnd;
      const volumeLines = afterVolumes.filter(({ index }) => index < volumesEnd);
      const volumeIndent = volumeLines.reduce((minimum, entry) => Math.min(minimum, entry.indent), Infinity);
      for (const { text, indent } of volumeLines) {
        if (indent !== volumeIndent) continue;
        const scalar = text.trim();
        if (!scalar.startsWith("- ") || scalar.includes("${") || scalar.includes("#")) continue;
        const parts = scalar.slice(2).trim().split(":");
        if (parts.length < 2 || parts.length > 3 || !SAFE_SCOPE.test(parts[0])
          || !path.posix.isAbsolute(parts[1]) || path.posix.normalize(parts[1]) !== parts[1]
          || (parts.length === 3 && !new Set(["ro", "rw"]).has(parts[2]))) continue;
        volumes.push({ source: parts[0], target: parts[1] });
      }
    }
    services.push({ service, image, workingDirectory, volumes });
  }
  const nameLines = meaningful.filter(({ text, indent }) => indent === 0 && /^name\s*:/u.test(text.trim()));
  const projectName = nameLines.length === 1
    ? composeScalar(nameLines[0].text.trim().replace(/^name\s*:/u, "")) : null;
  const topVolumes = meaningful.filter(({ text, indent }) => indent === 0 && text.trim() === "volumes:");
  const declaredVolumes = new Set();
  if (topVolumes.length === 1) {
    const afterTop = meaningful.filter(({ index }) => index > topVolumes[0].index);
    const topEnd = afterTop.find(({ indent }) => indent === 0)?.index ?? lines.length;
    const body = afterTop.filter(({ index }) => index < topEnd);
    const directIndent = body.reduce((minimum, entry) => Math.min(minimum, entry.indent), Infinity);
    for (const { text, indent } of body) {
      if (indent !== directIndent) continue;
      const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,127}):\s*$/u.exec(text.trim());
      if (match !== null) declaredVolumes.add(match[1]);
    }
  }
  return { projectName, declaredVolumes, services };
}

function scopeSourcePaths(scope, sourceRecords) {
  const queue = [...scope.references];
  const paths = new Set();
  for (let cursor = 0; cursor < queue.length && cursor < 64; cursor += 1) {
    const relative = queue[cursor];
    const record = sourceRecords.get(relative);
    if (record === undefined || paths.has(relative)) continue;
    paths.add(relative);
    for (const reference of referencedPaths(record.text)) if (!queue.includes(reference)) queue.push(reference);
    if (/launch\.jsonc?$/u.test(relative)) {
      for (const name of ["tasks.json", "tasks.jsonc"]) {
        const tasks = path.posix.join(path.posix.dirname(relative), name);
        if (!queue.includes(tasks)) queue.push(tasks);
      }
    }
  }
  return [...paths];
}

function documentedAuthoritySources(paths, sourceRecords, composeFile, service) {
  return paths.filter((relative) => {
    if (COMPOSE_NAMES.has(path.posix.basename(relative)) || /(?:launch|tasks)\.jsonc?$/u.test(relative)) return false;
    const text = sourceRecords.get(relative)?.text ?? "";
    return text.includes(composeFile) && text.includes(service);
  }).sort((left, right) => left.localeCompare(right, "en"));
}

function availableCacheVolumes(configuration, service) {
  if (!SAFE_SCOPE.test(configuration.projectName ?? "")) return [];
  return service.volumes.filter((entry) => configuration.declaredVolumes.has(entry.source))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function composeOption(scope, composeFile, sourceRecords, configuration, service, paths) {
  const availableCaches = availableCacheVolumes(configuration, service);
  const authoritySources = documentedAuthoritySources(paths, sourceRecords, composeFile, service.service);
  const environment = {
    kind: "docker-compose", composeFile, service: service.service, image: service.image, authoritySources,
  };
  const material = { profile: `Compose service ${service.service}`, source: composeFile, environment };
  return Object.freeze({
    id: digest("stnl-validation-environment-option-v1", { scope: scope.scope, ...material }),
    ...material,
    availableCacheVolumes: Object.freeze(availableCaches.map((entry) => Object.freeze({ ...entry }))),
    sources: Object.freeze(paths.filter((entry) => sourceRecords.has(entry))
      .map((entry) => sourceIdentity(sourceRecords.get(entry)))
      .sort((left, right) => left.path.localeCompare(right.path, "en"))),
  });
}

function taskEnvironment(task, taskSource, sourceRecords, root) {
  if (task?.sentinelExecutionEnvironment === "host") return { environment: { kind: "host" }, supported: true };
  const tokens = [task?.command, ...(Array.isArray(task?.args) ? task.args : [])].filter((entry) => typeof entry === "string");
  if (tokens[0] !== "docker" || tokens[1] !== "compose") return { environment: null, supported: false };
  let composeToken = null;
  for (let index = 2; index < tokens.length; index += 1) {
    if (tokens[index] === "-f" || tokens[index] === "--file") composeToken = tokens[index + 1] ?? null;
  }
  const runIndex = tokens.indexOf("run");
  if (composeToken === null || runIndex < 0) return { environment: null, supported: false };
  let serviceIndex = runIndex + 1;
  while (tokens[serviceIndex]?.startsWith("-") === true) serviceIndex += 1;
  const service = tokens[serviceIndex];
  if (!SAFE_SCOPE.test(service ?? "")) return { environment: null, supported: false };
  const taskCwd = workspaceRelative(task?.options?.cwd, path.posix.dirname(taskSource));
  const composeFile = path.posix.normalize(path.posix.join(taskCwd === "." ? "" : taskCwd, composeToken));
  if (composeFile.startsWith("../") || !COMPOSE_NAMES.has(path.posix.basename(composeFile))) {
    return { environment: null, supported: false };
  }
  const compose = sourceRecords.get(composeFile);
  const image = compose === undefined ? null : composeImage(compose.text, service);
  if (image === null) return { environment: null, supported: false, referenced: composeFile };
  return {
    supported: true,
    referenced: composeFile,
    environment: {
      kind: "docker-compose", composeFile, service, image,
      authoritySources: [taskSource],
    },
  };
}

function sourceIdentity(record) {
  return Object.freeze({ path: record.path, identity: record.identity });
}

export async function discoverValidationEnvironments(specPath, request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)
    || Object.keys(request).sort().join(",") !== "componentScopes"
    || !Array.isArray(request.componentScopes) || request.componentScopes.length === 0) {
    environmentFail("INVALID_ENVIRONMENT_DISCOVERY_SCOPE", "componentScopes must be a non-empty array");
  }
  const root = await aggregateRoot(specPath);
  const workspace = await resolveExecutionWorkspace(specPath);
  const requirementsAuthority = `sha256:${await computeRequirementsAuthority(specPath)}`;
  const workspaceIdentity = digest("stnl-validation-aggregate-workspace-v1", {
    root, authorityPath: path.relative(root, workspace.authorityPath),
  });
  const scopes = request.componentScopes.map((scope, index) => {
    if (scope === null || typeof scope !== "object" || Array.isArray(scope)
      || Object.keys(scope).sort().join(",") !== "component,cwd,references,scope"
      || !SAFE_SCOPE.test(scope.scope ?? "") || !SAFE_SCOPE.test(scope.component ?? "")
      || !Array.isArray(scope.references) || scope.references.length === 0) {
      environmentFail("INVALID_ENVIRONMENT_DISCOVERY_SCOPE", `component scope ${index + 1} is malformed`);
    }
    return {
      scope: scope.scope, component: scope.component, cwd: normalizedRelative(scope.cwd, "component cwd"),
      references: scope.references.map((entry) => normalizedRelative(entry, "component reference")),
    };
  });
  if (new Set(scopes.map((scope) => scope.scope)).size !== scopes.length) {
    environmentFail("INVALID_ENVIRONMENT_DISCOVERY_SCOPE", "component scope names must be unique");
  }

  const queue = [...new Set(scopes.flatMap((scope) => scope.references))];
  const sourceRecords = new Map();
  for (let cursor = 0; cursor < queue.length && cursor < 64; cursor += 1) {
    const relative = queue[cursor];
    if (sourceRecords.has(relative)) continue;
    const record = await admittedFile(root, relative);
    if (record === null) continue;
    sourceRecords.set(relative, record);
    for (const reference of referencedPaths(record.text)) if (!queue.includes(reference)) queue.push(reference);
    if (/launch\.jsonc?$/u.test(relative)) {
      for (const name of ["tasks.json", "tasks.jsonc"]) {
        const tasks = path.posix.join(path.posix.dirname(relative), name);
        if (!queue.includes(tasks)) queue.push(tasks);
      }
    }
  }
  // Compose paths are discovered through task arguments, so load them before option resolution.
  for (const [relative, record] of [...sourceRecords]) {
    if (!/tasks\.jsonc?$/u.test(relative)) continue;
    const parsed = jsonWithoutComments(record.text, relative);
    for (const task of Array.isArray(parsed?.tasks) ? parsed.tasks : []) {
      const tokens = [task?.command, ...(Array.isArray(task?.args) ? task.args : [])];
      for (let index = 0; index < tokens.length; index += 1) {
        if (tokens[index] !== "-f" && tokens[index] !== "--file") continue;
        const taskCwd = workspaceRelative(task?.options?.cwd, path.posix.dirname(relative));
        const candidate = path.posix.normalize(path.posix.join(taskCwd === "." ? "" : taskCwd, tokens[index + 1]));
        if (!candidate.startsWith("../") && !sourceRecords.has(candidate)) {
          const admitted = await admittedFile(root, candidate);
          if (admitted !== null) sourceRecords.set(candidate, admitted);
        }
      }
    }
  }

  const tasks = new Map();
  for (const [relative, record] of sourceRecords) {
    if (!/tasks\.jsonc?$/u.test(relative)) continue;
    const parsed = jsonWithoutComments(record.text, relative);
    for (const task of Array.isArray(parsed?.tasks) ? parsed.tasks : []) {
      if (typeof task?.label === "string") tasks.set(`${relative}\0${task.label}`, { task, source: relative });
    }
  }
  const profiles = [];
  for (const [relative, record] of sourceRecords) {
    if (!/(?:launch|unsupported-launch)\.jsonc?$/u.test(relative)) continue;
    const parsed = jsonWithoutComments(record.text, relative);
    for (const profile of Array.isArray(parsed?.configurations) ? parsed.configurations : []) {
      profiles.push({ profile, source: relative });
    }
  }

  const scopeResults = scopes.map((scope) => {
    const options = [];
    const unsupported = [];
    const paths = scopeSourcePaths(scope, sourceRecords);
    for (const candidate of profiles) {
      const profileCwd = workspaceRelative(candidate.profile?.cwd, ".");
      const hasComponent = typeof candidate.profile?.sentinelComponent === "string";
      const hasCwd = typeof candidate.profile?.cwd === "string";
      if ((hasComponent && candidate.profile.sentinelComponent !== scope.component)
        || (hasCwd && profileCwd !== scope.cwd) || (!hasComponent && !hasCwd)) continue;
      if (candidate.profile?.pipeTransport !== undefined
        && path.posix.basename(candidate.profile.pipeTransport?.pipeProgram ?? "") !== "docker") {
        unsupported.push(`${candidate.profile.name ?? "unnamed profile"}: pipeTransport/${candidate.profile.pipeTransport?.pipeProgram ?? "unsupported backend"}`);
        continue;
      }
      const taskBase = path.posix.dirname(candidate.source);
      const linked = ["tasks.json", "tasks.jsonc"]
        .map((name) => tasks.get(`${path.posix.join(taskBase, name)}\0${candidate.profile?.preLaunchTask}`))
        .find((entry) => entry !== undefined);
      if (linked === undefined) {
        unsupported.push(`${candidate.profile.name ?? "unnamed profile"}: referenced task is missing`);
        continue;
      }
      const resolved = taskEnvironment(linked.task, linked.source, sourceRecords, root);
      if (!resolved.supported || resolved.environment === null) {
        unsupported.push(`${candidate.profile.name ?? "unnamed profile"}: task uses an unsupported execution backend`);
        continue;
      }
      const scopeSourcePaths = [...new Set([
        ...scope.references.filter((entry) => sourceRecords.has(entry)), candidate.source, linked.source,
        ...(resolved.referenced === undefined ? [] : [resolved.referenced]),
      ])].sort((left, right) => left.localeCompare(right, "en"));
      const environment = resolved.environment.kind === "docker-compose"
        ? { ...resolved.environment, authoritySources: [candidate.source, linked.source].sort() }
        : resolved.environment;
      const material = { profile: candidate.profile.name, source: candidate.source, environment };
      const configuration = environment.kind === "docker-compose"
        ? composeConfiguration(sourceRecords.get(environment.composeFile)?.text ?? "") : null;
      const service = configuration?.services.find((entry) => entry.service === environment.service);
      const availableCaches = service === undefined ? [] : availableCacheVolumes(configuration, service);
      options.push(Object.freeze({
        id: digest("stnl-validation-environment-option-v1", { scope: scope.scope, ...material }),
        ...material,
        availableCacheVolumes: Object.freeze(availableCaches.map((entry) => Object.freeze({ ...entry }))),
        sources: Object.freeze(scopeSourcePaths.map((entry) => sourceIdentity(sourceRecords.get(entry)))),
      }));
    }
    const existingComposeServices = new Set(options.filter((option) => option.environment.kind === "docker-compose")
      .map((option) => `${option.environment.composeFile}\0${option.environment.service}`));
    for (const composeFile of paths.filter((entry) => COMPOSE_NAMES.has(path.posix.basename(entry)))) {
      const configuration = composeConfiguration(sourceRecords.get(composeFile)?.text ?? "");
      if (configuration === null) {
        unsupported.push(`${composeFile}: Compose structure is not supported`);
        continue;
      }
      const cwdTarget = `/workspace/${scope.cwd === "." ? "" : scope.cwd}`.replace(/\/$/u, "");
      const matched = configuration.services.filter((entry) => entry.service === scope.scope
        || entry.service === scope.component || entry.workingDirectory === cwdTarget
        || documentedAuthoritySources(paths, sourceRecords, composeFile, entry.service).length !== 0);
      const plausible = matched.length !== 0 ? matched : configuration.services;
      for (const service of plausible) {
        if (existingComposeServices.has(`${composeFile}\0${service.service}`)) continue;
        options.push(composeOption(scope, composeFile, sourceRecords, configuration, service, paths));
      }
    }
    options.sort((left, right) => left.profile.localeCompare(right.profile, "en"));
    const requiresConfirmation = options.length === 1 && options[0].environment.kind === "docker-compose"
      && options[0].environment.authoritySources.length === 0;
    const status = requiresConfirmation ? "confirmation-required"
      : options.length === 1 ? "resolved" : options.length > 1 ? "ambiguous"
        : unsupported.length > 0 ? "unsupported" : "missing";
    const recommended = options.find((option) => option.environment.kind === "docker-compose") ?? options[0] ?? null;
    return Object.freeze({
      scope: scope.scope, component: scope.component, cwd: scope.cwd, status,
      options: Object.freeze(options),
      recommendation: recommended === null ? null : Object.freeze({
        optionId: recommended.id,
        reason: recommended.environment.kind === "docker-compose"
          ? "Compose matches the shared project-defined environment" : "the project explicitly authorizes this host profile",
      }),
      missingInformation: status === "ambiguous" ? `select or confirm one project profile for ${scope.scope}`
        : status === "confirmation-required" ? `confirm the inspected Compose file and service for ${scope.scope}`
        : status === "missing" ? `identify the project file or profile that authorizes ${scope.scope}`
          : status === "unsupported" ? `the discovered profile uses an unsupported backend: ${unsupported.join("; ")}` : null,
      unsupported: Object.freeze(unsupported),
    });
  });
  const sources = Object.freeze([...sourceRecords.values()].map(sourceIdentity).sort((left, right) => left.path.localeCompare(right.path, "en")));
  const material = {
    schema: VALIDATION_ENVIRONMENT_DISCOVERY_SCHEMA, workspaceIdentity, requirementsAuthority,
    sources, scopes: Object.freeze(scopeResults),
  };
  return Object.freeze({ ...material, fingerprint: digest("stnl-validation-environment-discovery-v1", material) });
}

function planningBlocker(scope) {
  return Object.freeze({
    schema: VALIDATION_PLANNING_BLOCKER_SCHEMA,
    code: new Set(["ambiguous", "confirmation-required"]).has(scope.status)
      ? "ENVIRONMENT_SELECTION_REQUIRED" : "ENVIRONMENT_CONFIGURATION_REQUIRED",
    message: scope.missingInformation,
    requiredAction: Object.freeze({
      scope: scope.scope, component: scope.component, cwd: scope.cwd,
      options: scope.options,
      recommendation: scope.recommendation,
      missingInformation: scope.missingInformation,
    }),
  });
}

function normalizeCacheChoice(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    environmentFail("INVALID_ENVIRONMENT_CHOICE", `${label} must be a non-empty cache binding array`);
  }
  const normalized = value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "source,target"
      || !SAFE_SCOPE.test(entry.source ?? "") || typeof entry.target !== "string"
      || !path.posix.isAbsolute(entry.target) || path.posix.normalize(entry.target) !== entry.target
      || entry.target === "/" || entry.target.endsWith("/")) {
      environmentFail("INVALID_ENVIRONMENT_CHOICE", `${label} cache binding ${index + 1} is malformed`);
    }
    return Object.freeze({ source: entry.source, target: entry.target });
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  if (new Set(normalized.map((entry) => `${entry.source}\0${entry.target}`)).size !== normalized.length) {
    environmentFail("INVALID_ENVIRONMENT_CHOICE", `${label} cache bindings must be unique`);
  }
  return normalized;
}

function directChoice(scope, choice) {
  const keys = Object.hasOwn(choice, "cacheVolumes")
    ? "cacheVolumes,configurationPath,service" : "configurationPath,service";
  if (choice === null || typeof choice !== "object" || Array.isArray(choice)
    || Object.keys(choice).sort().join(",") !== keys) {
    environmentFail("INVALID_ENVIRONMENT_CHOICE", `direct choice for ${scope.scope} is malformed`);
  }
  const configurationPath = normalizedRelative(choice.configurationPath, "direct environment configuration");
  if (!COMPOSE_NAMES.has(path.posix.basename(configurationPath)) || !SAFE_SCOPE.test(choice.service ?? "")) {
    environmentFail("INVALID_ENVIRONMENT_CHOICE", `direct choice for ${scope.scope} must identify a supported Compose file and service`);
  }
  const option = scope.options.find((entry) => entry.environment?.kind === "docker-compose"
    && entry.environment.composeFile === configurationPath && entry.environment.service === choice.service);
  if (option === undefined) {
    environmentFail("INVALID_ENVIRONMENT_CHOICE", `direct choice for ${scope.scope} does not match an inspected project Compose service`);
  }
  const requestedCaches = Object.hasOwn(choice, "cacheVolumes")
    ? normalizeCacheChoice(choice.cacheVolumes, `direct choice for ${scope.scope}`) : null;
  if (requestedCaches !== null && requestedCaches.some((requested) => !(option.availableCacheVolumes ?? [])
    .some((available) => available.source === requested.source && available.target === requested.target))) {
    environmentFail("INVALID_ENVIRONMENT_CHOICE", `direct choice for ${scope.scope} requests a cache not declared for the selected Compose service/project`);
  }
  const environment = requestedCaches === null ? option.environment : Object.freeze({
    ...option.environment, cacheVolumes: Object.freeze(requestedCaches),
  });
  const confirmation = Object.freeze({
    configurationPath, service: choice.service,
    ...(requestedCaches === null ? {} : { cacheVolumes: Object.freeze(requestedCaches) }),
  });
  return { option, environment, confirmation };
}

export function resolveValidationEnvironmentSelection(discovery, choices = {}) {
  if (discovery?.schema !== VALIDATION_ENVIRONMENT_DISCOVERY_SCHEMA || !HASH.test(discovery.fingerprint ?? "")
    || discovery.fingerprint !== digest("stnl-validation-environment-discovery-v1", (({ fingerprint: _fingerprint, ...value }) => value)(discovery))
    || choices === null || typeof choices !== "object" || Array.isArray(choices)) {
    environmentFail("INVALID_ENVIRONMENT_DISCOVERY", "discovery or choices are malformed or altered");
  }
  const entries = [];
  for (const scope of discovery.scopes) {
    const choice = choices[scope.scope];
    if (scope.status !== "resolved" && choice === undefined) return planningBlocker(scope);
    let option;
    let environment;
    let confirmation = null;
    if (choice !== null && typeof choice === "object" && !Array.isArray(choice)) {
      ({ option, environment, confirmation } = directChoice(scope, choice));
    } else {
      option = choice === undefined ? scope.options[0] : scope.options.find((entry) => entry.id === choice);
      if (option === undefined) environmentFail("INVALID_ENVIRONMENT_CHOICE", `choice for ${scope.scope} is not one of the discovered options`);
      if (option.environment?.kind === "docker-compose" && option.environment.authoritySources.length === 0) {
        environmentFail("INVALID_ENVIRONMENT_CHOICE", `choice for ${scope.scope} requires explicit Compose file and service confirmation`);
      }
      environment = option.environment;
    }
    entries.push(Object.freeze({
      scope: scope.scope, component: scope.component, cwd: scope.cwd,
      environment, sources: option.sources, confirmation,
    }));
  }
  const material = {
    schema: VALIDATION_ENVIRONMENT_SELECTION_SCHEMA,
    workspaceIdentity: discovery.workspaceIdentity,
    requirementsAuthority: discovery.requirementsAuthority,
    discoveryFingerprint: discovery.fingerprint,
    entries: Object.freeze(entries),
  };
  return Object.freeze({ ...material, fingerprint: digest("stnl-validation-environment-selection-v1", material) });
}

export async function validateValidationEnvironmentSelection(specPath, selection) {
  if (selection?.schema !== VALIDATION_ENVIRONMENT_SELECTION_SCHEMA || !HASH.test(selection.fingerprint ?? "")) {
    environmentFail("VALIDATION_ENVIRONMENT_SELECTION_REQUIRED", "a resolved independent selection is required");
  }
  const { fingerprint: _fingerprint, ...material } = selection;
  if (selection.fingerprint !== digest("stnl-validation-environment-selection-v1", material)) {
    environmentFail("VALIDATION_ENVIRONMENT_SELECTION_TAMPERED", "selection fingerprint is invalid");
  }
  const root = await aggregateRoot(specPath);
  const workspace = await resolveExecutionWorkspace(specPath);
  const workspaceIdentity = digest("stnl-validation-aggregate-workspace-v1", {
    root, authorityPath: path.relative(root, workspace.authorityPath),
  });
  if (selection.workspaceIdentity !== workspaceIdentity
    || selection.requirementsAuthority !== `sha256:${await computeRequirementsAuthority(specPath)}`) {
    environmentFail("VALIDATION_ENVIRONMENT_WORKSPACE_MISMATCH", "selection belongs to another workspace or requirements authority");
  }
  if (!Array.isArray(selection.entries) || selection.entries.length === 0
    || new Set(selection.entries.map((entry) => entry.scope)).size !== selection.entries.length) {
    environmentFail("INVALID_VALIDATION_ENVIRONMENT_SELECTION", "selection entries are missing or duplicated");
  }
  for (const entry of selection.entries) {
    if (!SAFE_SCOPE.test(entry.scope ?? "") || !SAFE_SCOPE.test(entry.component ?? "")
      || normalizedRelative(entry.cwd, "selected component cwd") !== entry.cwd
      || !Array.isArray(entry.sources) || entry.sources.length === 0) {
      environmentFail("INVALID_VALIDATION_ENVIRONMENT_SELECTION", "selection entry is malformed");
    }
    await admittedDirectory(root, entry.cwd, entry.component);
    for (const source of entry.sources) {
      const current = await admittedFile(root, source.path);
      if (current === null || current.identity !== source.identity) {
        environmentFail("VALIDATION_ENVIRONMENT_SELECTION_STALE", `environment authority changed or disappeared: ${source.path}`);
      }
    }
  }
  return selection;
}

export function enforceValidationEnvironmentSelection(plan, selection) {
  if (selection?.schema !== VALIDATION_ENVIRONMENT_SELECTION_SCHEMA) {
    environmentFail("VALIDATION_ENVIRONMENT_SELECTION_REQUIRED", "planner output cannot authorize its own execution environment");
  }
  const entries = new Map(selection.entries.map((entry) => [entry.scope, entry]));
  for (const [index, command] of plan.commands.entries()) {
    const entry = entries.get(command.environmentScope);
    if (entry === undefined) {
      environmentFail("VALIDATION_ENVIRONMENT_SCOPE_MISMATCH", `command ${index + 1} references another component or an unknown environment scope`);
    }
    if (command.cwd !== entry.cwd) {
      environmentFail("VALIDATION_ENVIRONMENT_COMPONENT_MISMATCH", `command ${index + 1} cwd differs from selected component ${entry.component}`);
    }
    const { cacheVolumes: selectedCaches = [], ...selectedEnvironment } = entry.environment;
    const { cacheVolumes: commandCaches = [], ...commandEnvironment } = command.executionEnvironment;
    if (JSON.stringify(canonical(commandEnvironment)) !== JSON.stringify(canonical(selectedEnvironment))) {
      environmentFail("VALIDATION_ENVIRONMENT_IDENTITY_MISMATCH", `command ${index + 1} environment contradicts the independently selected environment`);
    }
    if (commandCaches.some((requested) => !selectedCaches.some((authorized) => (
      requested.source === authorized.source && requested.target === authorized.target
    )))) {
      environmentFail("VALIDATION_ENVIRONMENT_CACHE_MISMATCH", `command ${index + 1} requests a cache outside the independently selected environment`);
    }
    const declaredSources = new Set(plan.discovery.sources);
    if (entry.sources.some((source) => !declaredSources.has(source.path))) {
      environmentFail("VALIDATION_ENVIRONMENT_DISCOVERY_MISMATCH", `command ${index + 1} omits selected environment authority from plan discovery`);
    }
  }
  return selection;
}
