import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  computeRequirementsAuthority,
  inspectExecutionState,
} from "../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs";
import { installSentinel } from "./lib/sentinel-distribution.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const STATIC_FIXTURE = path.join(import.meta.dirname, "fixtures/validation-environment-selection");
const SOURCE_RESOLVER = path.join(
  ROOT, "skills/workflows/stnl-slice-executor/runtime/resolve-validation-runtime.mjs",
);
let importNonce = 0;

async function temporary(t, prefix) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function replaceAll(text, pairs) {
  return pairs.reduce((value, [before, after]) => value.replaceAll(before, after), text);
}

function replaceSection(text, heading, content) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(## ${escaped}\\n\\n)([\\s\\S]*?)(?=\\n## |$)`, "u");
  assert.match(text, pattern);
  return text.replace(pattern, `$1${content}`);
}

async function materializeRepositoryMarkers(project) {
  for (const component of ["service-api", "web-client"]) {
    const componentRoot = path.join(project, "components", component);
    await fs.rm(path.join(componentRoot, ".git-repository-marker"));
    await fs.mkdir(path.join(componentRoot, ".git"));
    await fs.writeFile(path.join(componentRoot, ".git/HEAD"), "ref: refs/heads/fixture\n", "utf8");
  }
}

async function copyProjectFixture(t, prefix = "stnl environment fixture ") {
  const holder = await temporary(t, prefix);
  const project = path.join(holder, "aggregator with independent repositories");
  await fs.cp(STATIC_FIXTURE, project, { recursive: true });
  await materializeRepositoryMarkers(project);
  return { holder, project, specPath: path.join(project, "requirements.md") };
}

async function renderExecution(project, { blocked = false } = {}) {
  const specPath = path.join(project, "requirements.md");
  const execution = path.join(project, "requirements-execution");
  await fs.mkdir(path.join(execution, "plans"), { recursive: true });
  await fs.mkdir(path.join(execution, "tasks"), { recursive: true });
  const authority = await computeRequirementsAuthority(specPath);

  let plan = await fs.readFile(
    path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8",
  );
  plan = replaceAll(plan, [
    ["`<relative path>`", "`../requirements.md`"], ["sha256:<64hex>", `sha256:${authority}`],
    ["<positive integer>", "1"], ["<compact objective>", "Validate components in their project-defined environments"],
    ["<compact strategy>", "Resolve each component independently before dispatch"],
    ["01 - <name>", "01 - Multi-repository validation"], ["<result>", "sealed component checks"],
    ["<areas>", "components/service-api/src/message.txt; components/web-client/src/message.txt"],
  ]).replace("| AC-001 |", "| AC-001, AC-002 |")
    .replace(/\nFor revision 1,[\s\S]*?\n## Serial Slice Order/u, "\n## Serial Slice Order")
    .replace("status: draft", "status: ready").replaceAll("Review state: pending", "Review state: approved");
  await fs.writeFile(path.join(execution, "plan.md"), plan, "utf8");

  let slicePlan = await fs.readFile(
    path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8",
  );
  slicePlan = replaceAll(slicePlan, [
    ["<Name>", "Multi-repository validation"], ["`<relative path>`", "`../../requirements.md`"],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", "1"],
    ["<One coherent outcome or milestone, how it is observed and validated, and why it is one boundary. Technical layers belong in Tasks.>", "Validate both component sources through separately bound environments."],
    ["<included work>", "API and web focused verification."], ["<excluded work and boundary with later slices>", "No service startup or consumer mutation."],
    ["<path, contract, subsystem, or test area>", "components/*/src/message.txt"], ["<earlier slice or none>", "none"],
    ["<risk and mitigation>", "Wrong environment is rejected before dispatch."], ["<bounded approach>", "One command per component."],
    ["<test, command, suite, or observable check>", "node test.mjs in each selected environment"],
    ["<objective result and preserved boundary>", "Sealed zero exit for both component checks."],
  ]).replace("\n- AC-001\n", "\n- AC-001\n- AC-002\n")
    .replace("status: draft", "status: ready").replaceAll("Review state: pending", "Review state: approved");
  await fs.writeFile(path.join(execution, "plans/slice-01.md"), slicePlan, "utf8");

  let tasks = await fs.readFile(
    path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/tasks.template.md"), "utf8",
  );
  tasks = replaceAll(tasks, [
    ["01 - <name>", "01 - Multi-repository validation"], ["<observable delivery>", "sealed component checks"],
  ]);
  await fs.writeFile(path.join(execution, "tasks.md"), tasks, "utf8");

  let task = await fs.readFile(
    path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8",
  );
  task = replaceAll(task, [
    ["<Name>", "Multi-repository validation"], ["`<relative path>`", "`../../requirements.md`"],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", "1"],
    ["<task>", "Validate API and web sources"], ["<result>", "sealed component checks"],
    ["<areas>", "components/service-api/src/message.txt; components/web-client/src/message.txt"],
    ["<test, command, suite, or observable check>", "node test.mjs in each selected environment"],
  ]).replaceAll("- [ ]", "- [x]");
  task = task.replace(
    " | requirement: AC-001",
    " | requirement: AC-001\n- [x] 1.2 Validate the web source | observable result: sealed web check | expected areas: components/web-client/src/message.txt | requirement: AC-002",
  );
  task = replaceSection(task, "Changed Areas", [
    "- `../../components/service-api/src/message.txt`",
    "- `../../components/web-client/src/message.txt`",
  ].join("\n"));
  task = replaceSection(task, "Diff Summary", "- Prepared representative component sources.");
  if (blocked) {
    task = replaceSection(task, "Delegation Blocker", `- Operation: EXECUTE_SLICE
- Kind: initialization
- State: active
- After record: none
- Pending automatic round: 1/3
- Causes:
  - an earlier host attempt could not initialize the project toolchain
- Required action: resume the same operation after resolving the project environment`);
  }
  await fs.writeFile(path.join(execution, "tasks/slice-01.md"), task, "utf8");
  return { specPath, execution, authority: `sha256:${authority}` };
}

async function installFixture(t, { blocked = false } = {}) {
  const fixture = await copyProjectFixture(t, "stnl installed environment fixture ");
  const rendered = await renderExecution(fixture.project, { blocked });
  await installSentinel({
    repositoryRoot: ROOT, platform: "codex", scope: "project", projectRoot: fixture.project,
    validateSourceContracts: false,
  });
  const relocated = path.join(fixture.holder, "relocated aggregate workspace");
  await fs.rename(fixture.project, relocated);
  const resolverPath = path.join(
    relocated, ".agents/skills/stnl-slice-executor/runtime/resolve-validation-runtime.mjs",
  );
  const harnessPath = path.join(
    relocated, ".agents/skills/stnl-slice-executor/runtime/run-validation-session.mjs",
  );
  importNonce += 1;
  const resolver = await import(`${pathToFileURL(resolverPath).href}?selection=${importNonce}`);
  importNonce += 1;
  const harness = await import(`${pathToFileURL(harnessPath).href}?selection-harness=${importNonce}`);
  return {
    ...fixture, ...rendered, project: relocated,
    specPath: path.join(relocated, "requirements.md"),
    execution: path.join(relocated, "requirements-execution"), resolver, harness,
  };
}

async function sourceResolver() {
  importNonce += 1;
  return import(`${pathToFileURL(SOURCE_RESOLVER).href}?selection-source=${importNonce}`);
}

async function runResolverCli(arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SOURCE_RESOLVER, ...arguments_], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code: Number.isInteger(code) ? code : signal === null ? 1 : 128,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function runCommand(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      const result = {
        code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} exited ${code}: ${result.stderr}`));
    });
  });
}

function apiScope() {
  return {
    scope: "api-check", component: "service-api", cwd: "components/service-api",
    references: ["AGENTS.md", "components/service-api/AGENTS.md"],
  };
}

function webScope() {
  return {
    scope: "web-check", component: "web-client", cwd: "components/web-client",
    references: ["AGENTS.md", "components/web-client/DEVELOPMENT.md"],
  };
}

function requireEnvironmentApi(resolver) {
  assert.equal(
    typeof resolver.discoverValidationEnvironments, "function",
    "resolver must export deterministic multi-repository environment discovery",
  );
  assert.equal(
    typeof resolver.resolveValidationEnvironmentSelection, "function",
    "resolver must export independent environment selection resolution",
  );
}

function allStrings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

function scopeResult(discovery, scope) {
  assert.ok(Array.isArray(discovery.scopes), "discovery must expose per-scope results");
  const result = discovery.scopes.find((entry) => entry.scope === scope);
  assert.ok(result, `discovery omitted ${scope}`);
  return result;
}

function optionFor(scope, predicate) {
  assert.ok(Array.isArray(scope.options));
  const option = scope.options.find(predicate);
  assert.ok(option, `expected concrete option for ${scope.scope}`);
  return option;
}

function selectionEntry(selection, scope) {
  assert.equal(selection.schema, "stnl-validation-environment-selection/v1");
  assert.ok(Array.isArray(selection.entries));
  const entry = selection.entries.find((candidate) => candidate.scope === scope);
  assert.ok(entry, `selection omitted ${scope}`);
  return entry;
}

function planFor(fixture, selection, commands) {
  return {
    schema: "stnl-validation-plan/v1",
    protocol: {
      runner: fixture.resolver.VALIDATION_RUNNER_PROTOCOL,
      harness: fixture.resolver.VALIDATION_HARNESS_PROTOCOL,
      capability: fixture.resolver.VALIDATION_CAPABILITY_IDENTITY,
    },
    operation: "EXECUTE_SLICE", slice: "slice-01", round: "1/3",
    requirementsAuthority: fixture.authority, planRevision: 1,
    discovery: {
      sources: selection.entries.flatMap((entry) => entry.sources.map((source) => source.path)),
      actions: ["follow project profiles and referenced tasks to concrete environments"],
    },
    cwd: ".",
    subjects: ["../../components/service-api/src/message.txt", "../../components/web-client/src/message.txt"],
    commands,
    baselineFingerprint: null, failureConclusion: "VALIDATION_FINDING", replayOriginEvidenceId: null,
    coverage: {
      verificationTypes: "focused component checks", selectedChecks: "component-owned node checks",
      rationale: "exercise independently bound environments", coverage: "both changed component sources",
      filelessReason: null, nonApplicabilityRationale: null,
    },
    findings: null, priorRound: null, assessment: "none",
  };
}

function commandFor(entry, overrides = {}) {
  return {
    argv: ["node", "test.mjs"], cwd: entry.cwd, writePaths: [], writeFiles: [], env: {},
    timeoutMs: 10_000, environmentScope: entry.scope, executionEnvironment: entry.environment,
    ...overrides,
  };
}

function digestFile(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertSameBytes(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: byte length changed`);
  assert.equal(digestFile(actual), digestFile(expected), `${label}: content changed`);
}

function simulatedAuthenticatedDockerEngine(fixture, observedRuns) {
  const imageId = `sha256:${"d".repeat(64)}`;
  return {
    async composeContainers(service) {
      return [{
        ImageID: imageId,
        Labels: {
          "com.docker.compose.service": service,
          "com.docker.compose.project.working_dir": path.join(fixture.project, "shared"),
          "com.docker.compose.project.config_files": path.join(fixture.project, "shared/compose.yml"),
          "com.docker.compose.config-hash": "environment-selection-fixture-config",
        },
      }];
    },
    async image() {
      return {
        Id: imageId,
        RepoDigests: [`sentinel-fixture/api-toolchain@sha256:${"e".repeat(64)}`],
        Config: { WorkingDir: "/workspace/components/service-api" },
      };
    },
    async run(options) {
      observedRuns.push(options);
      return {
        exit: 0,
        stdout: Buffer.from("simulated authenticated Docker check passed\n"),
        stderr: Buffer.alloc(0), stderrForEvidence: Buffer.alloc(0),
        timedOut: false, signaled: false, sandboxViolation: false,
        sandboxEvents: [], sandboxOutcomeUncertain: false,
      };
    },
  };
}

function simulatedAuthenticatedDockerCacheEngine(fixture, observedRuns, snapshotRoots) {
  const imageId = `sha256:${"d".repeat(64)}`;
  return {
    async composeContainers(service) {
      return [{
        ImageID: imageId,
        Labels: {
          "com.docker.compose.service": service,
          "com.docker.compose.project.working_dir": path.join(fixture.project, "shared"),
          "com.docker.compose.project.config_files": path.join(fixture.project, "shared/compose.yml"),
          "com.docker.compose.config-hash": "environment-selection-cache-fixture-config",
        },
      }];
    },
    async image() {
      return {
        Id: imageId,
        RepoDigests: [`sentinel-fixture/api-toolchain@sha256:${"e".repeat(64)}`],
        Config: { WorkingDir: "/workspace/components/service-api" },
      };
    },
    async volume(volumeName) {
      return {
        Name: volumeName, Driver: "local", Scope: "local", Options: null,
        Labels: {
          "com.docker.compose.project": "sentinel-selection",
          "com.docker.compose.volume": "api-deps",
        },
      };
    },
    async snapshotCacheVolumes({ cacheVolumes, destinationRoot }) {
      const snapshotPath = path.join(destinationRoot, "0");
      await fs.mkdir(snapshotPath, { recursive: true });
      await fs.writeFile(path.join(snapshotPath, "cached-input"), "authorized API dependencies\n", "utf8");
      snapshotRoots.push(destinationRoot);
      return cacheVolumes.map((cache) => ({
        ...cache, snapshotPath, snapshotFingerprint: digestFile(Buffer.from("authorized API dependencies\n")),
      }));
    },
    async run(options) {
      observedRuns.push(options);
      let exit = 0;
      try {
        assert.equal(
          (await fs.readFile(path.join(options.copiedRoot, "components/service-api/src/message.txt"), "utf8")).trim(),
          "api source exists",
        );
        assert.equal(
          (await fs.readFile(path.join(options.copiedRoot, "components/web-client/src/message.txt"), "utf8")).trim(),
          "web source exists",
        );
        assert.equal(options.cacheMounts.length, 1);
        assert.equal(options.cacheMounts[0].target, "/var/cache/api-deps");
        assert.equal(
          await fs.readFile(path.join(options.cacheMounts[0].snapshotPath, "cached-input"), "utf8"),
          "authorized API dependencies\n",
        );
      } catch {
        exit = 19;
      }
      return {
        exit,
        stdout: Buffer.from(exit === 0 ? "source and cache identities passed\n" : ""),
        stderr: Buffer.alloc(0), stderrForEvidence: Buffer.alloc(0),
        timedOut: false, signaled: false, sandboxViolation: false,
        sandboxEvents: [], sandboxOutcomeUncertain: false,
      };
    },
  };
}

async function configureAuthorizedApiCache(fixture) {
  await fs.writeFile(path.join(fixture.project, "shared/compose.yml"), `name: sentinel-selection
services:
  api-check:
    image: sentinel-fixture/api-toolchain:1
    working_dir: /workspace/components/service-api
    volumes:
      - api-deps:/var/cache/api-deps
  web-check:
    image: sentinel-fixture/web-toolchain:1
    working_dir: /workspace/components/web-client
volumes:
  api-deps:
`, "utf8");
  await fs.appendFile(
    path.join(fixture.project, "components/service-api/AGENTS.md"),
    "\nThe `api-deps:/var/cache/api-deps` binding is the authorized dependency cache for API checks.\n",
    "utf8",
  );
}

test("discovery keeps the aggregator root and follows real child/profile/task/Compose references", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  requireEnvironmentApi(resolver);
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });

  assert.equal(discovery.schema, "stnl-validation-environment-discovery/v1");
  assert.match(discovery.workspaceIdentity, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(discovery), new RegExp(fixture.project.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  const api = scopeResult(discovery, "api-check");
  assert.equal(api.component, "service-api");
  assert.equal(api.cwd, "components/service-api");
  assert.equal(api.status, "resolved");
  const option = optionFor(api, (entry) => entry.environment?.service === "api-check");
  assert.equal(option.environment.kind, "docker-compose");
  assert.equal(option.environment.composeFile, "shared/compose.yml");
  assert.equal(option.environment.image, "sentinel-fixture/api-toolchain:1");

  const strings = new Set(allStrings(discovery));
  for (const source of [
    "AGENTS.md", "components/service-api/AGENTS.md", ".vscode/launch.json",
    ".vscode/tasks.json", "shared/compose.yml",
  ]) assert.equal(strings.has(source), true, `discovery did not follow ${source}`);
  assert.equal(await fs.stat(path.join(fixture.project, "components/service-api/.git")).then((entry) => entry.isDirectory()), true);
  assert.equal(await fs.stat(path.join(fixture.project, "components/web-client/.git")).then((entry) => entry.isDirectory()), true);
});

test("an unequivocal project instruction selects an existing Compose service without launch or task files", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  await fs.rm(path.join(fixture.project, ".vscode"), { recursive: true, force: true });
  await fs.writeFile(path.join(fixture.project, "AGENTS.md"), `# Aggregate validation instructions

Do not run API validation on the host. Use \`shared/compose.yml\`, service \`api-check\`, for the
\`components/service-api\` component.
`, "utf8");

  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{
      ...apiScope(), references: ["AGENTS.md", "components/service-api/AGENTS.md", "shared/compose.yml"],
    }],
  });
  const api = scopeResult(discovery, "api-check");
  assert.equal(api.status, "resolved", JSON.stringify(api));
  const option = optionFor(api, (entry) => entry.environment?.service === "api-check");
  assert.equal(option.environment.composeFile, "shared/compose.yml");
  assert.equal(option.environment.image, "sentinel-fixture/api-toolchain:1");
  assert.deepEqual(option.environment.authoritySources, ["AGENTS.md"]);
  assert.ok(option.sources.some((source) => source.path === "shared/compose.yml"));
});

test("an operator can directly confirm a referenced Compose service without a previously known option id", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  await fs.rm(path.join(fixture.project, ".vscode"), { recursive: true, force: true });
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{ ...apiScope(), references: ["shared/compose.yml"] }],
  });
  const blocker = resolver.resolveValidationEnvironmentSelection(discovery);
  assert.equal(blocker.schema, "stnl-validation-planning-blocker/v1");
  assert.equal(blocker.code, "ENVIRONMENT_SELECTION_REQUIRED");
  const selection = resolver.resolveValidationEnvironmentSelection(discovery, {
    "api-check": { configurationPath: "shared/compose.yml", service: "api-check" },
  });
  const api = selectionEntry(selection, "api-check");
  assert.equal(api.environment.kind, "docker-compose");
  assert.equal(api.environment.composeFile, "shared/compose.yml");
  assert.equal(api.environment.service, "api-check");
  assert.equal(api.confirmation.configurationPath, "shared/compose.yml");
  assert.equal(api.confirmation.service, "api-check");
  assert.equal(Object.hasOwn(api.confirmation, "cacheVolumes"), false);
  assert.ok(api.sources.some((source) => source.path === "shared/compose.yml"));

  const cli = await runResolverCli([
    "--resolve-environment-selection", JSON.stringify(discovery),
    JSON.stringify({ "api-check": { configurationPath: "shared/compose.yml", service: "api-check" } }),
  ]);
  assert.equal(cli.code, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).entries[0].environment.service, "api-check");
});

test("multiple plausible Compose services remain concrete ambiguity until operator confirmation", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  await fs.rm(path.join(fixture.project, ".vscode"), { recursive: true, force: true });
  await fs.writeFile(path.join(fixture.project, "shared/compose.yml"), `services:
  api-blue:
    image: sentinel-fixture/api-blue:1
    working_dir: /workspace/components/service-api
  api-green:
    image: sentinel-fixture/api-green:1
    working_dir: /workspace/components/service-api
`, "utf8");
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{ ...apiScope(), references: ["shared/compose.yml"] }],
  });
  const api = scopeResult(discovery, "api-check");
  assert.equal(api.status, "ambiguous");
  assert.deepEqual(api.options.map((option) => option.environment.service), ["api-blue", "api-green"]);
  const blocker = resolver.resolveValidationEnvironmentSelection(discovery);
  assert.equal(blocker.schema, "stnl-validation-planning-blocker/v1");
  assert.equal(blocker.requiredAction.options.length, 2);
  const selection = resolver.resolveValidationEnvironmentSelection(discovery, {
    "api-check": { configurationPath: "shared/compose.yml", service: "api-green" },
  });
  assert.equal(selectionEntry(selection, "api-check").environment.service, "api-green");
});

test("a Docker pipeTransport profile contributes references without executing debugger transport", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  await fs.writeFile(path.join(fixture.project, ".vscode/launch.json"), JSON.stringify({
    version: "0.2.0",
    configurations: [{
      name: "API through Docker transport", type: "coreclr", request: "launch",
      cwd: "${workspaceFolder}/components/service-api", preLaunchTask: "verify-api-compose",
      pipeTransport: {
        pipeProgram: "docker", pipeArgs: ["compose", "exec", "api-check"],
        debuggerPath: "/arbitrary/debugger-that-must-not-run",
      },
    }],
  }), "utf8");
  let transportExecutions = 0;
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{ ...apiScope(), references: [".vscode/launch.json"] }],
  }, {
    invokeTransport: async () => { transportExecutions += 1; throw new Error("must not execute transport"); },
  });
  const api = scopeResult(discovery, "api-check");
  assert.equal(api.status, "resolved", JSON.stringify(api));
  assert.equal(optionFor(api, (entry) => entry.environment?.service === "api-check").environment.kind, "docker-compose");
  assert.equal(transportExecutions, 0);
});

test("an explicitly authorized Compose cache is part of the independent selection", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  await configureAuthorizedApiCache(fixture);
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const selection = resolver.resolveValidationEnvironmentSelection(discovery, {
    "api-check": {
      configurationPath: "shared/compose.yml",
      service: "api-check",
      cacheVolumes: [{ source: "api-deps", target: "/var/cache/api-deps" }],
    },
  });
  const api = selectionEntry(selection, "api-check");
  assert.deepEqual(api.environment.cacheVolumes, [{ source: "api-deps", target: "/var/cache/api-deps" }]);
  assert.equal(api.confirmation.configurationPath, "shared/compose.yml");
  assert.equal(api.confirmation.service, "api-check");
  assert.deepEqual(api.confirmation.cacheVolumes, [{ source: "api-deps", target: "/var/cache/api-deps" }]);
  assert.equal(api.sources.some((source) => source.path === "components/service-api/AGENTS.md"), true);
});

test("a cache word elsewhere in project documentation does not authorize a product-data volume", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  await fs.writeFile(path.join(fixture.project, "shared/compose.yml"), `name: sentinel-selection
services:
  api-check:
    image: sentinel-fixture/api-toolchain:1
    working_dir: /workspace/components/service-api
    volumes:
      - database-data:/var/lib/database
volumes:
  database-data:
`, "utf8");
  await fs.appendFile(path.join(fixture.project, "components/service-api/AGENTS.md"), `
Dependency cache policy is documented elsewhere.
The database-data:/var/lib/database binding is not a cache and must never be authorized for validation.
`, "utf8");
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const api = scopeResult(discovery, "api-check");
  const option = optionFor(api, (entry) => entry.environment?.service === "api-check");
  assert.equal(Object.hasOwn(option.environment, "cacheVolumes"), false);
  assert.deepEqual(option.availableCacheVolumes, [{ source: "database-data", target: "/var/lib/database" }]);
});

test("same-named tasks are resolved beside each repository launch profile without cross-repository leakage", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  for (const [component, environment] of [
    ["service-api", "docker"], ["web-client", "host"],
  ]) {
    const vscode = path.join(fixture.project, "components", component, ".vscode");
    await fs.mkdir(vscode, { recursive: true });
    await fs.writeFile(path.join(vscode, "launch.json"), JSON.stringify({
      version: "0.2.0",
      configurations: [{
        name: `${component} profile`, type: "coreclr", request: "launch",
        sentinelComponent: component, cwd: `\${workspaceFolder}/components/${component}`,
        preLaunchTask: "component-check",
      }],
    }), "utf8");
    await fs.writeFile(path.join(vscode, "tasks.json"), JSON.stringify({
      version: "2.0.0",
      tasks: [environment === "host" ? {
        label: "component-check", type: "shell", command: "node",
        args: ["test.mjs"], sentinelExecutionEnvironment: "host",
      } : {
        label: "component-check", type: "shell", command: "docker",
        args: ["compose", "-f", "shared/compose.yml", "run", "--rm", "api-check", "node", "test.mjs"],
        options: { cwd: "${workspaceFolder}" },
      }],
    }), "utf8");
  }
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [
      { ...apiScope(), references: ["components/service-api/.vscode/launch.json"] },
      { ...webScope(), references: ["components/web-client/.vscode/launch.json"] },
    ],
  });
  assert.equal(scopeResult(discovery, "api-check").options[0].environment.kind, "docker-compose");
  assert.equal(scopeResult(discovery, "web-check").options[0].environment.kind, "host");
});

test("a profile is rejected when either its explicit component or cwd contradicts the requested scope", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  await fs.mkdir(path.join(fixture.project, ".config/mismatch"), { recursive: true });
  await fs.writeFile(path.join(fixture.project, ".config/mismatch/launch.json"), JSON.stringify({
    version: "0.2.0",
    configurations: [{
      name: "wrong component", type: "coreclr", request: "launch",
      sentinelComponent: "web-client", cwd: "${workspaceFolder}/components/service-api",
      preLaunchTask: "host-check",
    }],
  }), "utf8");
  await fs.writeFile(path.join(fixture.project, ".config/mismatch/tasks.json"), JSON.stringify({
    version: "2.0.0",
    tasks: [{ label: "host-check", command: "true", sentinelExecutionEnvironment: "host" }],
  }), "utf8");
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{ ...apiScope(), references: [".config/mismatch/launch.json"] }],
  });
  assert.equal(scopeResult(discovery, "api-check").status, "missing");
  assert.equal(scopeResult(discovery, "api-check").options.length, 0);
});

test("the bridge exports no arbitrary environment-selection constructor", async () => {
  const resolver = await sourceResolver();
  assert.equal(resolver.createValidationEnvironmentSelection, undefined);
});

test("selection errors at the CLI boundary are compact planning diagnostics without a Node stack", async () => {
  const result = await runResolverCli(["--resolve-environment-selection", "{}", "{}"]);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^BLOCKED: INVALID_ENVIRONMENT_DISCOVERY:/u);
  assert.doesNotMatch(result.stderr, /\n\s+at |ValidationEnvironmentSelectionError:/u);
});

test("ambiguity returns concrete options and a planning blocker without dispatch or lifecycle mutation", async (t) => {
  const fixture = await installFixture(t);
  requireEnvironmentApi(fixture.resolver);
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskFile);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const web = scopeResult(discovery, "web-check");
  assert.equal(web.status, "ambiguous");
  assert.equal(web.options.length, 2);
  assert.ok(web.options.every((entry) => entry.id && entry.profile && entry.source && entry.environment));
  assert.ok(web.recommendation?.optionId || web.recommendation?.id);
  assert.match(String(web.recommendation?.reason ?? web.recommendation), /compose|project|shared/iu);
  assert.match(web.missingInformation, /select|choose|confirm|profile/iu);

  const blocker = fixture.resolver.resolveValidationEnvironmentSelection(discovery);
  assert.equal(blocker.schema, "stnl-validation-planning-blocker/v1");
  assert.equal(blocker.requiredAction.scope, "web-check");
  assert.ok(Array.isArray(blocker.requiredAction.options));
  assert.equal(blocker.requiredAction.options.length, 2);
  assert.ok(blocker.requiredAction.options.every((entry) => entry.profile && entry.source && entry.environment));
  assert.deepEqual(await fs.readFile(taskFile), before);
  assert.equal((await inspectExecutionState(fixture.specPath)).tasks.get("slice-01").implementationChecks.length, 0);
});

test("resolved selection is independent of planner output and Docker-to-host contradiction dispatches zero commands", async (t) => {
  const fixture = await installFixture(t);
  requireEnvironmentApi(fixture.resolver);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery);
  const api = selectionEntry(selection, "api-check");
  assert.equal(api.environment.kind, "docker-compose");
  let dispatched = 0;
  const contradictory = planFor(fixture, selection, [commandFor(api, {
    executionEnvironment: { kind: "host" },
  })]);
  await assert.rejects(
    fixture.resolver.validateValidationPlan(fixture.specPath, contradictory),
    (error) => /ENVIRONMENT/u.test(error.code) && /selection|required|independent/iu.test(error.message),
  );
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, contradictory, {
      invoke: async () => { dispatched += 1; throw new Error("must not dispatch"); },
    }),
    (error) => /ENVIRONMENT/u.test(error.code) && /selection|required|independent/iu.test(error.message),
  );
  assert.equal(dispatched, 0, "missing independent selection must not dispatch");
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, contradictory, {
      environmentSelection: selection,
      invoke: async () => { dispatched += 1; throw new Error("must not dispatch"); },
    }),
    (error) => /ENVIRONMENT/u.test(error.code) && /before harness dispatch|selection|host/iu.test(error.message),
  );
  assert.equal(dispatched, 0);
  assert.equal((await inspectExecutionState(fixture.specPath)).tasks.get("slice-01").implementationChecks.length, 0);
});

test("simulated authenticated Docker engine receives one coherent plan selected by installed discovery and bridge", async (t) => {
  const fixture = await installFixture(t);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery);
  const api = selectionEntry(selection, "api-check");
  const plan = planFor(fixture, selection, [commandFor(api)]);
  const validated = await fixture.resolver.validateValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
  });
  assert.equal(validated.commands[0].environmentScope, "api-check");

  const observedRuns = [];
  const dockerEngine = simulatedAuthenticatedDockerEngine(fixture, observedRuns);
  let capturedRequest = null;
  let rawEvidence = null;
  let harnessInvocations = 0;
  const bridge = await fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
    invoke: async ([specPath, requestJson]) => {
      harnessInvocations += 1;
      capturedRequest = JSON.parse(requestJson);
      rawEvidence = await fixture.harness.runValidationSession(
        specPath, capturedRequest, { dockerEngine },
      );
      const exit = rawEvidence.provenance.state === "INVALID" ? 1 : 0;
      return {
        exit,
        transport: fixture.resolver.validationResultTransport(`${JSON.stringify(rawEvidence)}\n`, exit, ""),
        errors: "",
      };
    },
  });

  assert.equal(harnessInvocations, 1, "bridge must invoke the simulated authenticated Docker harness once");
  assert.equal(observedRuns.length, 1, "the simulated Docker backend must execute exactly one command");
  assert.equal(bridge.summary.status, "TESTS_PASS", JSON.stringify(bridge.summary));
  assert.equal(bridge.summary.commands[0].environmentScope, "api-check");
  assert.equal(Object.hasOwn(capturedRequest.commands[0], "environmentScope"), false, "harness v10 stays unchanged");
  assert.deepEqual(capturedRequest.commands[0].executionEnvironment, api.environment);
  assert.equal(rawEvidence.provenance.commands[0].executionEnvironment.kind, "docker-compose");
  assert.equal(rawEvidence.provenance.commands[0].executionEnvironment.composeFile, "shared/compose.yml");
  assert.equal(rawEvidence.provenance.commands[0].executionEnvironment.service, "api-check");
  assert.equal(
    rawEvidence.provenance.commands[0].executionEnvironment.imageReference,
    "sentinel-fixture/api-toolchain:1",
  );
  assert.deepEqual(observedRuns[0].argv, ["node", "test.mjs"]);
  assert.equal(observedRuns[0].cwd, "components/service-api");
});

test("selected cache reaches installed snapshot and read-only harness execution with source identity checks", async (t) => {
  const fixture = await installFixture(t);
  await configureAuthorizedApiCache(fixture);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const confirmation = {
    configurationPath: "shared/compose.yml", service: "api-check",
    cacheVolumes: [{ source: "api-deps", target: "/var/cache/api-deps" }],
  };
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, {
    "api-check": confirmation,
  });
  const api = selectionEntry(selection, "api-check");
  const plan = planFor(fixture, selection, [commandFor(api, { argv: ["fixture-check-source-and-cache"] })]);
  const observedRuns = [];
  const snapshotRoots = [];
  let rawEvidence = null;
  const bridge = await fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
    invoke: async ([specPath, requestJson]) => {
      rawEvidence = await fixture.harness.runValidationSession(specPath, JSON.parse(requestJson), {
        dockerEngine: simulatedAuthenticatedDockerCacheEngine(fixture, observedRuns, snapshotRoots),
      });
      const exit = rawEvidence.provenance.state === "INVALID" ? 1 : 0;
      return {
        exit,
        transport: fixture.resolver.validationResultTransport(`${JSON.stringify(rawEvidence)}\n`, exit, ""),
        errors: "",
      };
    },
  });
  assert.equal(bridge.summary.status, "TESTS_PASS", JSON.stringify(bridge.summary));
  assert.equal(observedRuns.length, 1);
  assert.equal(observedRuns[0].cacheMounts.length, 1);
  assert.equal(observedRuns[0].cacheMounts[0].target, "/var/cache/api-deps");
  assert.equal(rawEvidence.provenance.commands[0].executionEnvironment.cacheVolumes[0].source, "api-deps");
  assert.match(
    rawEvidence.provenance.commands[0].executionEnvironment.cacheVolumes[0].snapshotFingerprint,
    /^sha256:[0-9a-f]{64}$/u,
  );
  const subjects = Object.fromEntries(bridge.summary.subjects.map((subject) => [subject.path, subject.expected]));
  assert.equal(
    subjects["../../components/service-api/src/message.txt"],
    digestFile(await fs.readFile(path.join(fixture.project, "components/service-api/src/message.txt"))),
  );
  assert.equal(
    subjects["../../components/web-client/src/message.txt"],
    digestFile(await fs.readFile(path.join(fixture.project, "components/web-client/src/message.txt"))),
  );
  for (const root of snapshotRoots) await assert.rejects(fs.access(root));
});

test("cache divergence executes zero commands while omission uses the selected environment without cache", async (t) => {
  const fixture = await installFixture(t);
  await configureAuthorizedApiCache(fixture);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, {
    "api-check": {
      configurationPath: "shared/compose.yml", service: "api-check",
      cacheVolumes: [{ source: "api-deps", target: "/var/cache/api-deps" }],
    },
  });
  const api = selectionEntry(selection, "api-check");
  for (const environment of [
    { ...api.environment, cacheVolumes: [{ source: "other-cache", target: "/var/cache/api-deps" }] },
    { ...api.environment, cacheVolumes: [{ source: "api-deps", target: "/var/cache/other" }] },
  ]) {
    let dispatched = 0;
    const plan = planFor(fixture, selection, [commandFor(api, {
      executionEnvironment: environment,
    })]);
    await assert.rejects(
      fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
        environmentSelection: selection,
        invoke: async () => { dispatched += 1; throw new Error("cache mismatch must not dispatch"); },
      }),
      (error) => /ENVIRONMENT.*IDENTITY|CACHE/iu.test(error.code),
    );
    assert.equal(dispatched, 0);
  }

  const withoutCache = (({ cacheVolumes: _cacheVolumes, ...environment }) => environment)(api.environment);
  const noCachePlan = planFor(fixture, selection, [commandFor(api, { executionEnvironment: withoutCache })]);
  const observedRuns = [];
  let rawEvidence = null;
  const noCacheBridge = await fixture.resolver.executeValidationPlan(fixture.specPath, noCachePlan, {
    environmentSelection: selection,
    invoke: async ([specPath, requestJson]) => {
      rawEvidence = await fixture.harness.runValidationSession(specPath, JSON.parse(requestJson), {
        dockerEngine: simulatedAuthenticatedDockerEngine(fixture, observedRuns),
      });
      const exit = rawEvidence.provenance.state === "INVALID" ? 1 : 0;
      return {
        exit,
        transport: fixture.resolver.validationResultTransport(`${JSON.stringify(rawEvidence)}\n`, exit, ""),
        errors: "",
      };
    },
  });
  assert.equal(noCacheBridge.summary.status, "TESTS_PASS", JSON.stringify(noCacheBridge.summary));
  assert.equal(observedRuns.length, 1);
  assert.deepEqual(observedRuns[0].cacheMounts, []);

  await assert.rejects(
    Promise.resolve().then(() => fixture.resolver.resolveValidationEnvironmentSelection(discovery, {
      "api-check": {
        configurationPath: "shared/compose.yml", service: "web-check",
        cacheVolumes: [{ source: "api-deps", target: "/var/cache/api-deps" }],
      },
    })),
    (error) => /CHOICE|COMPONENT|SERVICE|CACHE/iu.test(error.code),
  );
});

test("opt-in real Docker snapshots an exclusive cache and checks exact source content through the installed flow", {
  skip: process.env.STNL_REAL_DOCKER !== "1",
}, async (t) => {
  const fixture = await installFixture(t);
  const image = process.env.STNL_REAL_DOCKER_IMAGE ?? "alpine:3.20";
  try {
    await runCommand("docker", ["image", "inspect", image]);
  } catch {
    t.skip(`local Docker image is unavailable: ${image}`);
    return;
  }
  const projectName = `stnlcache${process.pid}${Date.now()}`;
  const volumeName = `${projectName}_api-deps`;
  await runCommand("docker", [
    "volume", "create",
    "--label", `com.docker.compose.project=${projectName}`,
    "--label", "com.docker.compose.volume=api-deps",
    volumeName,
  ]);
  t.after(async () => {
    await runCommand("docker", ["volume", "rm", "-f", volumeName]);
  });
  await runCommand("docker", [
    "run", "--rm", "--network", "none", "-v", `${volumeName}:/cache`, image,
    "/bin/sh", "-c", "printf 'real authorized cache\\n' > /cache/cached-input",
  ]);
  const composePath = path.join(fixture.project, "shared/compose.yml");
  await fs.writeFile(composePath, `name: ${projectName}
services:
  api-check:
    image: ${image}
    working_dir: /workspace/components/service-api
    volumes:
      - api-deps:/var/cache/api-deps
volumes:
  api-deps:
`, "utf8");
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, {
    "api-check": {
      configurationPath: "shared/compose.yml", service: "api-check",
      cacheVolumes: [{ source: "api-deps", target: "/var/cache/api-deps" }],
    },
  });
  const api = selectionEntry(selection, "api-check");
  assert.equal(api.environment.image, image);
  await fs.writeFile(path.join(fixture.project, "components/service-api/verify-real.sh"), `#!/bin/sh
set -eu
test "$(cat /workspace/components/service-api/src/message.txt)" = "api source exists"
test "$(cat /workspace/components/web-client/src/message.txt)" = "web source exists"
test "$(cat /var/cache/api-deps/cached-input)" = "real authorized cache"
`, "utf8");
  const plan = planFor(fixture, selection, [commandFor(api, { argv: ["sh", "verify-real.sh"] })]);
  const bridge = await fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
  });
  assert.equal(bridge.summary.status, "TESTS_PASS", JSON.stringify(bridge.summary));
  assert.equal(bridge.summary.commands[0].environmentScope, "api-check");
  assert.equal(bridge.summary.commands[0].exit, 0);
  assert.equal(bridge.summary.commands[0].executionEnvironment.cacheVolumes[0].source, "api-deps");
  const identities = Object.fromEntries(bridge.summary.subjects.map((subject) => [subject.path, subject.expected]));
  assert.equal(
    identities["../../components/service-api/src/message.txt"],
    digestFile(await fs.readFile(path.join(fixture.project, "components/service-api/src/message.txt"))),
  );
  assert.equal(
    identities["../../components/web-client/src/message.txt"],
    digestFile(await fs.readFile(path.join(fixture.project, "components/web-client/src/message.txt"))),
  );
  assert.equal((await inspectExecutionState(fixture.specPath)).tasks.get("slice-01").implementationChecks.length, 0);
});

test("service, Compose, workspace and component identity mismatches fail before dispatch", async (t) => {
  const fixture = await installFixture(t);
  const foreign = await installFixture(t);
  requireEnvironmentApi(fixture.resolver);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery);
  const api = selectionEntry(selection, "api-check");
  const foreignSelection = foreign.resolver.resolveValidationEnvironmentSelection(
    await foreign.resolver.discoverValidationEnvironments(foreign.specPath, { componentScopes: [apiScope()] }),
  );
  const mismatches = [
    { executionEnvironment: { ...api.environment, service: "web-check" } },
    { executionEnvironment: { ...api.environment, composeFile: "other/compose.yml" } },
    { environmentScope: "web-check" },
  ];
  for (const mutation of mismatches) {
    let dispatched = 0;
    const candidate = planFor(fixture, selection, [commandFor(api, mutation)]);
    await assert.rejects(
      fixture.resolver.executeValidationPlan(fixture.specPath, candidate, {
        environmentSelection: selection,
        invoke: async () => { dispatched += 1; throw new Error("must not dispatch"); },
      }),
      (error) => /ENVIRONMENT/u.test(error.code),
    );
    assert.equal(dispatched, 0);
  }
  let foreignDispatch = 0;
  await assert.rejects(
    fixture.resolver.executeValidationPlan(
      fixture.specPath,
      planFor(fixture, foreignSelection, [commandFor(selectionEntry(foreignSelection, "api-check"))]),
      {
        environmentSelection: foreignSelection,
        invoke: async () => { foreignDispatch += 1; throw new Error("must not dispatch"); },
      },
    ),
    (error) => /ENVIRONMENT/u.test(error.code) && /workspace|authority|selection/iu.test(error.message),
  );
  assert.equal(foreignDispatch, 0);
});

test("multi-environment choice stays scoped per component", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  requireEnvironmentApi(resolver);
  const discovery = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope(), webScope()],
  });
  const web = scopeResult(discovery, "web-check");
  const webHost = optionFor(web, (entry) => entry.environment?.kind === "host");
  const selection = resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": webHost.id });
  const api = selectionEntry(selection, "api-check");
  const selectedWeb = selectionEntry(selection, "web-check");
  assert.equal(api.environment.kind, "docker-compose");
  assert.equal(api.environment.service, "api-check");
  assert.equal(selectedWeb.environment.kind, "host");
  assert.notEqual(api.scope, selectedWeb.scope);
  assert.notDeepEqual(api.sources, selectedWeb.sources);
});

test("selection reuse is accepted while unchanged and rejected after relevant configuration changes", async (t) => {
  const fixture = await installFixture(t);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [apiScope()],
  });
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery);
  const api = selectionEntry(selection, "api-check");
  const plan = planFor(fixture, selection, [commandFor(api)]);
  const first = await fixture.resolver.validateValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
  });
  const second = await fixture.resolver.validateValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
  });
  assert.equal(first.commands[0].environmentScope, "api-check");
  assert.equal(second.commands[0].environmentScope, "api-check");

  await fs.appendFile(path.join(fixture.project, "shared/compose.yml"), "# relevant configuration changed\n", "utf8");
  let dispatched = 0;
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
      environmentSelection: selection,
      invoke: async () => { dispatched += 1; throw new Error("must not dispatch stale selection"); },
    }),
    (error) => /ENVIRONMENT/u.test(error.code) && /stale|changed|identity|fingerprint/iu.test(error.message),
  );
  assert.equal(dispatched, 0);
});

test("missing and unsupported project configuration never falls back to host", async (t) => {
  const fixture = await copyProjectFixture(t);
  const resolver = await sourceResolver();
  requireEnvironmentApi(resolver);
  await fs.mkdir(path.join(fixture.project, "components/unconfigured/src"), { recursive: true });
  await fs.writeFile(path.join(fixture.project, "components/unconfigured/src/value.txt"), "unconfigured\n", "utf8");
  const missing = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{
      scope: "unconfigured", component: "unconfigured", cwd: "components/unconfigured",
      references: ["requirements.md"],
    }],
  });
  assert.equal(scopeResult(missing, "unconfigured").status, "missing");
  const missingBlocker = resolver.resolveValidationEnvironmentSelection(missing);
  assert.equal(missingBlocker.schema, "stnl-validation-planning-blocker/v1");
  assert.match(JSON.stringify(missingBlocker.requiredAction), /file|profile|configuration/iu);
  assert.doesNotMatch(JSON.stringify(missingBlocker), /"kind":"host"/u);

  await fs.mkdir(path.join(fixture.project, ".config/unsupported"), { recursive: true });
  await fs.writeFile(path.join(fixture.project, ".config/unsupported/launch.json"), JSON.stringify({
    version: "0.2.0",
    configurations: [{
      name: "Remote-only", type: "coreclr", request: "launch", sentinelComponent: "remote-only",
      cwd: "${workspaceFolder}/components/unconfigured", pipeTransport: { pipeProgram: "ssh" },
    }],
  }), "utf8");
  const unsupported = await resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{
      scope: "remote-only", component: "remote-only", cwd: "components/unconfigured",
      references: [".config/unsupported/launch.json"],
    }],
  });
  assert.equal(scopeResult(unsupported, "remote-only").status, "unsupported");
  const unsupportedBlocker = resolver.resolveValidationEnvironmentSelection(unsupported);
  assert.equal(unsupportedBlocker.schema, "stnl-validation-planning-blocker/v1");
  assert.match(JSON.stringify(unsupportedBlocker.requiredAction), /unsupported|pipeTransport|ssh|backend/iu);
});

test("explicitly authorized host executes through the installed bridge and preserves correct subject paths", async (t) => {
  const fixture = await installFixture(t);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webDiscovery = scopeResult(discovery, "web-check");
  const hostOption = optionFor(webDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, {
    "web-check": hostOption.id,
  });
  const web = selectionEntry(selection, "web-check");
  const plan = planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]);
  const bridge = await fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
  });
  assert.equal(bridge.summary.status, "TESTS_PASS", JSON.stringify(bridge.summary));
  assert.equal(bridge.summary.commands[0].executionEnvironment.kind, "host");
  const identities = Object.fromEntries(bridge.summary.subjects.map((entry) => [entry.path, entry.expected]));
  assert.match(identities["../../components/service-api/src/message.txt"], /^sha256:[0-9a-f]{64}$/u);
  assert.match(identities["../../components/web-client/src/message.txt"], /^sha256:[0-9a-f]{64}$/u);
  assert.notEqual(identities["../../components/service-api/src/message.txt"], "REMOVED");
  assert.notEqual(identities["../../components/web-client/src/message.txt"], "REMOVED");
});

test("project-relative subject spelling is rejected before it can become a false task-relative REMOVED", async (t) => {
  const fixture = await installFixture(t);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webDiscovery = scopeResult(discovery, "web-check");
  const host = optionFor(webDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": host.id });
  const web = selectionEntry(selection, "web-check");
  const plan = planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]);
  plan.subjects = ["components/service-api/src/message.txt"];
  let dispatched = 0;
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
      environmentSelection: selection,
      invoke: async () => { dispatched += 1; throw new Error("must not dispatch"); },
    }),
    (error) => error.code === "VALIDATION_PLAN_SUBJECT_BASE_MISMATCH",
  );
  assert.equal(dispatched, 0);
});

test("preexisting project-relative Changed Areas can be corrected to real task-relative source identities", async (t) => {
  const fixture = await installFixture(t, { blocked: true });
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webDiscovery = scopeResult(discovery, "web-check");
  const host = optionFor(webDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": host.id });
  const web = selectionEntry(selection, "web-check");
  const historicalBridge = await fixture.resolver.executeValidationPlan(
    fixture.specPath,
    planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]),
    { environmentSelection: selection },
  );
  const historicalEnvelope = Buffer.from(historicalBridge.sealedEvidence, "utf8");
  let historical = await fs.readFile(taskFile, "utf8");
  historical = historical.replace(
    "  - an earlier host attempt could not initialize the project toolchain",
    `  - an earlier host attempt could not initialize the project toolchain\n  - Historical evidence: ${historicalBridge.sealedEvidence}`,
  );
  await fs.writeFile(taskFile, replaceSection(historical, "Changed Areas", [
    "- `components/service-api/src/message.txt`",
    "- `components/web-client/src/message.txt`",
  ].join("\n")), "utf8");

  const checkSources = [
    "IFS= read -r api < ../service-api/src/message.txt",
    "IFS= read -r web < src/message.txt",
    "test \"$api\" = \"api source exists\"",
    "test \"$web\" = \"web source exists\"",
  ].join(" && ");
  const plan = planFor(fixture, selection, [commandFor(web, { argv: ["sh", "-c", checkSources] })]);
  const bridge = await fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
  });

  assert.equal(bridge.summary.status, "TESTS_PASS", JSON.stringify(bridge.summary));
  assert.deepEqual(bridge.pathCorrection, {
    section: "Changed Areas",
    from: [
      "components/service-api/src/message.txt",
      "components/web-client/src/message.txt",
    ],
    to: [
      "../../components/service-api/src/message.txt",
      "../../components/web-client/src/message.txt",
    ],
  });
  const identities = Object.fromEntries(bridge.summary.subjects.map((entry) => [entry.path, entry.expected]));
  assert.equal(
    identities["../../components/service-api/src/message.txt"],
    digestFile(await fs.readFile(path.join(fixture.project, "components/service-api/src/message.txt"))),
  );
  assert.equal(
    identities["../../components/web-client/src/message.txt"],
    digestFile(await fs.readFile(path.join(fixture.project, "components/web-client/src/message.txt"))),
  );
  const candidateHolder = await temporary(t, "stnl path correction candidate ");
  const candidate = path.join(candidateHolder, "requirements-execution");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  const staged = await fixture.resolver.stageValidationBridgeResult(fixture.specPath, bridge, candidate);
  assert.equal(staged.state, "IMPLEMENTED_AWAITING_VALIDATION");
  const candidateTask = await fs.readFile(path.join(candidate, "tasks/slice-01.md"), "utf8");
  assert.match(candidateTask, /## Changed Areas\n\n- `\.\.\/\.\.\/components\/service-api\/src\/message\.txt`/u);
  const historicalOffset = candidateTask.indexOf(historicalEnvelope.toString("utf8"));
  assert.ok(historicalOffset >= 0, "historical evidence envelope disappeared during current metadata correction");
  assertSameBytes(
    Buffer.from(candidateTask.slice(historicalOffset, historicalOffset + historicalEnvelope.length), "utf8"),
    historicalEnvelope,
    "historical evidence envelope",
  );
  await fs.copyFile(path.join(candidate, "tasks/slice-01.md"), taskFile);
  const readBack = await inspectExecutionState(fixture.specPath);
  assert.equal(readBack.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(readBack.tasks.get("slice-01").implementationChecks.at(-1).provenance.evidenceId, bridge.summary.evidenceId);
  assert.equal(readBack.tasks.get("slice-01").delegationBlocker.state, "resolved");
});

test("repeating a preexisting wrong Changed Areas base cannot produce false REMOVED success", async (t) => {
  const fixture = await installFixture(t, { blocked: true });
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const task = await fs.readFile(taskFile, "utf8");
  await fs.writeFile(taskFile, replaceSection(task, "Changed Areas", [
    "- `components/service-api/src/message.txt`",
    "- `components/web-client/src/message.txt`",
  ].join("\n")), "utf8");
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webDiscovery = scopeResult(discovery, "web-check");
  const host = optionFor(webDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": host.id });
  const web = selectionEntry(selection, "web-check");
  const plan = planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]);
  plan.subjects = [
    "components/service-api/src/message.txt",
    "components/web-client/src/message.txt",
  ];
  let dispatched = 0;
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
      environmentSelection: selection,
      invoke: async () => { dispatched += 1; throw new Error("wrong-base plan must not dispatch"); },
    }),
    (error) => /SUBJECT|IDENTITY|AMBIGUOUS|NORMALIZATION/u.test(error.code),
  );
  assert.equal(dispatched, 0);
});

test("two plausible path bases require clarification and execute zero commands", async (t) => {
  const fixture = await installFixture(t, { blocked: true });
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const task = await fs.readFile(taskFile, "utf8");
  await fs.writeFile(taskFile, replaceSection(task, "Changed Areas", "- `slice-01.md`"), "utf8");
  await fs.writeFile(path.join(fixture.project, "slice-01.md"), "a distinct aggregate-relative source\n", "utf8");

  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webDiscovery = scopeResult(discovery, "web-check");
  const host = optionFor(webDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": host.id });
  const web = selectionEntry(selection, "web-check");
  const plan = planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]);
  let dispatched = 0;
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
      environmentSelection: selection,
      invoke: async () => { dispatched += 1; throw new Error("ambiguous path base must not dispatch"); },
    }),
    (error) => /AMBIGUOUS|CLARIFICATION/iu.test(error.code) || /ambiguous|clarif/iu.test(error.message),
  );
  assert.equal(dispatched, 0);
});

test("path-base correction cannot widen Changed Areas to an unrelated existing file", async (t) => {
  const fixture = await installFixture(t, { blocked: true });
  const unrelated = path.join(fixture.project, "components/service-api/src/unrelated.txt");
  await fs.writeFile(unrelated, "real but outside claimed scope\n", "utf8");
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const task = await fs.readFile(taskFile, "utf8");
  await fs.writeFile(
    taskFile,
    replaceSection(task, "Changed Areas", "- `components/service-api/src/message.txt`"),
    "utf8",
  );
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webDiscovery = scopeResult(discovery, "web-check");
  const host = optionFor(webDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": host.id });
  const web = selectionEntry(selection, "web-check");
  const plan = planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]);
  plan.subjects = ["../../components/service-api/src/unrelated.txt"];
  let dispatched = 0;
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
      environmentSelection: selection,
      invoke: async () => { dispatched += 1; throw new Error("scope expansion must not dispatch"); },
    }),
    (error) => /SUBJECT|SCOPE|IDENTITY|CORRECTION/iu.test(error.code),
  );
  assert.equal(dispatched, 0);
});

test("a selected cwd with a symlink ancestor is rejected by the bridge before dispatch", async (t) => {
  const fixture = await installFixture(t);
  const outside = path.join(fixture.holder, "outside component", "nested");
  await fs.mkdir(outside, { recursive: true });
  const linked = path.join(fixture.project, "components/service-api/linked");
  await fs.symlink(path.dirname(outside), linked, "dir");
  await fs.mkdir(path.join(fixture.project, ".config/symlink"), { recursive: true });
  await fs.writeFile(path.join(fixture.project, ".config/symlink/launch.json"), JSON.stringify({
    version: "0.2.0",
    configurations: [{
      name: "linked host", type: "coreclr", request: "launch",
      sentinelComponent: "linked-api", cwd: "${workspaceFolder}/components/service-api/linked/nested",
      preLaunchTask: "linked-check",
    }],
  }), "utf8");
  await fs.writeFile(path.join(fixture.project, ".config/symlink/tasks.json"), JSON.stringify({
    version: "2.0.0",
    tasks: [{ label: "linked-check", command: "true", sentinelExecutionEnvironment: "host" }],
  }), "utf8");
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{
      scope: "linked-check", component: "linked-api",
      cwd: "components/service-api/linked/nested",
      references: [".config/symlink/launch.json"],
    }],
  });
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery);
  const linkedEntry = selectionEntry(selection, "linked-check");
  const plan = planFor(fixture, selection, [commandFor(linkedEntry, { argv: ["true"] })]);
  let dispatched = 0;
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
      environmentSelection: selection,
      invoke: async () => { dispatched += 1; throw new Error("must not dispatch"); },
    }),
    (error) => error.code === "VALIDATION_ENVIRONMENT_COMPONENT_MISMATCH" && /symlink|canonical/iu.test(error.message),
  );
  assert.equal(dispatched, 0);
});

test("legitimate removed subject remains representable without changing the project/task base", async (t) => {
  const fixture = await installFixture(t);
  const removedRelative = "../../components/web-client/src/removed.txt";
  const removedPath = path.join(fixture.project, "components/web-client/src/removed.txt");
  await fs.writeFile(removedPath, "will be legitimately removed\n", "utf8");
  const repository = path.join(fixture.project, "components/web-client");
  await fs.rm(path.join(repository, ".git"), { recursive: true, force: true });
  await runCommand("git", ["init", "-q"], { cwd: repository });
  await runCommand("git", ["add", "src/message.txt", "src/removed.txt"], { cwd: repository });
  await runCommand("git", [
    "-c", "user.name=Sentinel Fixture", "-c", "user.email=fixture@invalid.example",
    "commit", "-qm", "fixture removal baseline",
  ], { cwd: repository });
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  let taskSource = await fs.readFile(taskFile, "utf8");
  taskSource = replaceSection(taskSource, "Changed Areas", [
    "- `../../components/service-api/src/message.txt`",
    "- `../../components/web-client/src/message.txt`",
    `- \`${removedRelative}\``,
  ].join("\n"));
  await fs.writeFile(taskFile, taskSource, "utf8");
  await fs.rm(removedPath);

  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webScopeDiscovery = scopeResult(discovery, "web-check");
  const host = optionFor(webScopeDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": host.id });
  const web = selectionEntry(selection, "web-check");
  const plan = planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]);
  plan.subjects.push(removedRelative);
  const bridge = await fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
  });
  assert.equal(bridge.summary.status, "TESTS_PASS", JSON.stringify(bridge.summary));
  const removed = bridge.summary.subjects.find((entry) => entry.path === removedRelative);
  assert.equal(removed.expected, "REMOVED");
  assert.equal(bridge.summary.status, "TESTS_PASS");
});

test("an absent subject without child-repository removal proof cannot become REMOVED success", async (t) => {
  const fixture = await installFixture(t);
  const absentRelative = "../../components/web-client/src/never-existed.txt";
  const taskFile = path.join(fixture.execution, "tasks/slice-01.md");
  const task = await fs.readFile(taskFile, "utf8");
  await fs.writeFile(taskFile, replaceSection(task, "Changed Areas", [
    "- `../../components/service-api/src/message.txt`",
    `- \`${absentRelative}\``,
  ].join("\n")), "utf8");
  const repository = path.join(fixture.project, "components/web-client");
  await fs.rm(path.join(repository, ".git"), { recursive: true, force: true });
  await runCommand("git", ["init", "-q"], { cwd: repository });
  await runCommand("git", ["add", "src/message.txt"], { cwd: repository });
  await runCommand("git", [
    "-c", "user.name=Sentinel Fixture", "-c", "user.email=fixture@invalid.example",
    "commit", "-qm", "fixture existing source baseline",
  ], { cwd: repository });

  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webDiscovery = scopeResult(discovery, "web-check");
  const host = optionFor(webDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": host.id });
  const web = selectionEntry(selection, "web-check");
  const plan = planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]);
  plan.subjects = ["../../components/service-api/src/message.txt", absentRelative];
  let dispatched = 0;
  await assert.rejects(
    fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
      environmentSelection: selection,
      invoke: async () => { dispatched += 1; throw new Error("unproven removal must not dispatch"); },
    }),
    (error) => /REMOV|SUBJECT.*UNRESOLVED|IDENTITY/iu.test(error.code) || /remov|unresolved|absent/iu.test(error.message),
  );
  assert.equal(dispatched, 0);
});

test("installed blocked resume combines direct Compose, authorized cache, path correction, publication and selection reuse", async (t) => {
  const fixture = await installFixture(t, { blocked: true });
  await fs.rm(path.join(fixture.project, ".vscode"), { recursive: true, force: true });
  await configureAuthorizedApiCache(fixture);
  await fs.writeFile(path.join(fixture.project, "AGENTS.md"), `# Aggregate validation instructions

Host validation is forbidden. Validate \`components/service-api\` with \`shared/compose.yml\`,
service \`api-check\`. The operator separately confirms any authorized cache binding.
`, "utf8");
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const historicalCause = Buffer.from("  - an earlier host attempt could not initialize the project toolchain", "utf8");
  const blockedTask = await fs.readFile(liveTask, "utf8");
  assert.ok(blockedTask.includes(historicalCause));
  await fs.writeFile(liveTask, replaceSection(blockedTask, "Changed Areas", [
    "- `components/service-api/src/message.txt`",
    "- `components/web-client/src/message.txt`",
  ].join("\n")), "utf8");

  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [{
      ...apiScope(), references: ["AGENTS.md", "components/service-api/AGENTS.md", "shared/compose.yml"],
    }],
  });
  const discoveredApi = scopeResult(discovery, "api-check");
  assert.equal(discoveredApi.status, "resolved", JSON.stringify(discoveredApi));
  const confirmation = {
    configurationPath: "shared/compose.yml", service: "api-check",
    cacheVolumes: [{ source: "api-deps", target: "/var/cache/api-deps" }],
  };
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, {
    "api-check": confirmation,
  });
  const api = selectionEntry(selection, "api-check");
  assert.deepEqual(api.environment.cacheVolumes, confirmation.cacheVolumes);

  const rejectedEnvironments = [
    { kind: "host" },
    {
      ...api.environment,
      cacheVolumes: [{ source: "api-deps", target: "/var/cache/not-authorized" }],
    },
  ];
  for (const executionEnvironment of rejectedEnvironments) {
    let invoked = 0;
    const rejected = planFor(fixture, selection, [commandFor(api, { executionEnvironment })]);
    await assert.rejects(
      fixture.resolver.executeValidationPlan(fixture.specPath, rejected, {
        environmentSelection: selection,
        invoke: async () => { invoked += 1; throw new Error("divergent environment must not invoke harness"); },
      }),
      (error) => /ENVIRONMENT/iu.test(error.code),
    );
    assert.equal(invoked, 0);
  }

  const plan = planFor(fixture, selection, [commandFor(api, {
    argv: ["fixture-check-source-and-cache"],
  })]);
  const observedRuns = [];
  const snapshotRoots = [];
  let rawEvidence = null;
  const bridge = await fixture.resolver.executeValidationPlan(fixture.specPath, plan, {
    environmentSelection: selection,
    invoke: async ([specPath, requestJson]) => {
      rawEvidence = await fixture.harness.runValidationSession(specPath, JSON.parse(requestJson), {
        dockerEngine: simulatedAuthenticatedDockerCacheEngine(fixture, observedRuns, snapshotRoots),
      });
      const exit = rawEvidence.provenance.state === "INVALID" ? 1 : 0;
      return {
        exit,
        transport: fixture.resolver.validationResultTransport(`${JSON.stringify(rawEvidence)}\n`, exit, ""),
        errors: "",
      };
    },
  });
  assert.equal(bridge.summary.status, "TESTS_PASS", JSON.stringify(bridge.summary));
  assert.equal(observedRuns.length, 1);
  assert.equal(observedRuns[0].cacheMounts[0].target, "/var/cache/api-deps");
  assert.equal(rawEvidence.provenance.commands[0].executionEnvironment.cacheVolumes[0].source, "api-deps");
  assert.deepEqual(bridge.pathCorrection, {
    section: "Changed Areas",
    from: [
      "components/service-api/src/message.txt",
      "components/web-client/src/message.txt",
    ],
    to: [
      "../../components/service-api/src/message.txt",
      "../../components/web-client/src/message.txt",
    ],
  });
  const subjectHashes = Object.fromEntries(bridge.summary.subjects.map((subject) => [subject.path, subject.expected]));
  assert.equal(
    subjectHashes["../../components/service-api/src/message.txt"],
    digestFile(await fs.readFile(path.join(fixture.project, "components/service-api/src/message.txt"))),
  );
  assert.equal(
    subjectHashes["../../components/web-client/src/message.txt"],
    digestFile(await fs.readFile(path.join(fixture.project, "components/web-client/src/message.txt"))),
  );
  for (const root of snapshotRoots) await assert.rejects(fs.access(root));

  const candidateHolder = await temporary(t, "stnl integrated resume candidate ");
  const candidate = path.join(candidateHolder, "requirements-execution");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  const staged = await fixture.resolver.stageValidationBridgeResult(fixture.specPath, bridge, candidate);
  assert.equal(staged.state, "IMPLEMENTED_AWAITING_VALIDATION");
  const candidateTaskPath = path.join(candidate, "tasks/slice-01.md");
  const candidateTask = await fs.readFile(candidateTaskPath);
  const historicalOffset = candidateTask.indexOf(historicalCause);
  assert.ok(historicalOffset >= 0, "historical blocker cause disappeared from the candidate");
  assertSameBytes(
    candidateTask.subarray(historicalOffset, historicalOffset + historicalCause.length),
    historicalCause,
    "historical blocker cause",
  );
  assert.match(candidateTask.toString("utf8"), /## Changed Areas\n\n- `\.\.\/\.\.\/components\/service-api\/src\/message\.txt`/u);
  await fs.copyFile(candidateTaskPath, liveTask);

  const readBack = await inspectExecutionState(fixture.specPath);
  assert.equal(readBack.state, "IMPLEMENTED_AWAITING_VALIDATION");
  const published = readBack.tasks.get("slice-01").implementationChecks.at(-1);
  assert.equal(published.provenance.evidenceId, bridge.summary.evidenceId);
  assert.deepEqual(
    Object.fromEntries(published.provenance.subjects.map((subject) => [subject.path, subject.expected])),
    subjectHashes,
  );
  assert.equal(readBack.tasks.get("slice-01").delegationBlocker.state, "resolved");

  const formalPlan = planFor(fixture, selection, [commandFor(api, {
    argv: ["fixture-check-source-and-cache"],
  })]);
  formalPlan.operation = "VALIDATE_SLICE";
  formalPlan.round = null;
  formalPlan.assessment = "independent";
  const formal = await fixture.resolver.validateValidationPlan(fixture.specPath, formalPlan, {
    resolved: { skillName: "stnl-slice-quality-manager" }, environmentSelection: selection,
  });
  assert.equal(formal.environmentSelection.fingerprint, selection.fingerprint);
});

test("installed publication appends new evidence, preserves blocker history and confirms read-back", async (t) => {
  const fixture = await installFixture(t, { blocked: true });
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const historical = await fs.readFile(liveTask, "utf8");
  assert.match(historical, /earlier host attempt/u);
  const discovery = await fixture.resolver.discoverValidationEnvironments(fixture.specPath, {
    componentScopes: [webScope()],
  });
  const webDiscovery = scopeResult(discovery, "web-check");
  const host = optionFor(webDiscovery, (entry) => entry.environment?.kind === "host");
  const selection = fixture.resolver.resolveValidationEnvironmentSelection(discovery, { "web-check": host.id });
  const web = selectionEntry(selection, "web-check");
  const bridge = await fixture.resolver.executeValidationPlan(
    fixture.specPath, planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]),
    { environmentSelection: selection },
  );
  assert.equal(bridge.summary.status, "TESTS_PASS", JSON.stringify(bridge.summary));
  assert.equal(bridge.resolution.section, "Delegation Blocker");
  const candidateHolder = await temporary(t, "stnl environment candidate ");
  const candidate = path.join(candidateHolder, "requirements-execution");
  await fs.cp(fixture.execution, candidate, { recursive: true });
  const staged = await fixture.resolver.stageValidationBridgeResult(fixture.specPath, bridge, candidate);
  assert.equal(staged.state, "IMPLEMENTED_AWAITING_VALIDATION");
  await fs.copyFile(path.join(candidate, "tasks/slice-01.md"), liveTask);
  const after = await fs.readFile(liveTask, "utf8");
  assert.match(after, /earlier host attempt/u);
  assert.match(after, /State: resolved/u);
  assert.notEqual(digestFile(after), digestFile(historical));
  const readBack = await inspectExecutionState(fixture.specPath);
  assert.equal(readBack.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(readBack.tasks.get("slice-01").implementationChecks.length, 1);
  assert.equal(
    readBack.tasks.get("slice-01").implementationChecks[0].provenance.evidenceId,
    bridge.summary.evidenceId,
  );
  assert.equal(readBack.tasks.get("slice-01").delegationBlocker.state, "resolved");
  const formalPlan = planFor(fixture, selection, [commandFor(web, { argv: ["true"] })]);
  formalPlan.operation = "VALIDATE_SLICE";
  formalPlan.round = null;
  formalPlan.assessment = "independent";
  const formal = await fixture.resolver.validateValidationPlan(fixture.specPath, formalPlan, {
    resolved: { skillName: "stnl-slice-quality-manager" }, environmentSelection: selection,
  });
  assert.equal(formal.environmentSelection.fingerprint, selection.fingerprint);
});
