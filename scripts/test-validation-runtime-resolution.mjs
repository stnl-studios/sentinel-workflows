import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { installSentinel } from "./lib/sentinel-distribution.mjs";
import { validateValidationCapabilitySource } from "./lib/validation-capability.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OWNERS = ["stnl-slice-executor", "stnl-slice-quality-manager"];
let moduleNonce = 0;

function platformSkillRoot(platform) {
  return platform === "codex" ? path.join(".agents", "skills") : path.join(".claude", "skills");
}

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return fs.realpath(directory);
}

async function installFixture(t, { platform = "codex", scope = "project", relocate = false } = {}) {
  const holder = await temporaryDirectory(t, `stnl runtime ${platform} ${scope} `);
  let installationRoot = path.join(holder, `${scope} installation with spaces`);
  await fs.mkdir(installationRoot);
  await installSentinel({
    repositoryRoot: ROOT,
    platform,
    scope,
    ...(scope === "project" ? { projectRoot: installationRoot } : { homeDirectory: () => installationRoot }),
  });
  if (relocate) {
    const relocated = path.join(holder, "relocated root unrelated to platform conventions");
    await fs.rename(installationRoot, relocated);
    installationRoot = relocated;
  }
  return { installationRoot, platform };
}

function loadedResolverPath(fixture, skillName) {
  const loadedSkillResource = path.join(
    fixture.installationRoot,
    platformSkillRoot(fixture.platform),
    skillName,
    "SKILL.md",
  );
  return path.join(path.dirname(loadedSkillResource), "runtime", "resolve-validation-runtime.mjs");
}

async function loadResolver(fixture, skillName) {
  const resolverPath = loadedResolverPath(fixture, skillName);
  moduleNonce += 1;
  const module = await import(`${pathToFileURL(resolverPath).href}?test=${moduleNonce}`);
  return { module, resolverPath };
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function expectResolutionCode(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.equal(error?.name, "ValidationRuntimeResolutionError");
    assert.equal(error?.code, code);
    return true;
  });
}

test("installed Codex and Claude user/project skills self-resolve and import after relocation and paths with spaces", async (t) => {
  const sourceCapability = await validateValidationCapabilitySource(ROOT);
  const installations = [
    { platform: "codex", scope: "user" },
    { platform: "claude-code", scope: "user", relocate: true },
    { platform: "codex", scope: "project", relocate: true },
    { platform: "claude-code", scope: "project" },
  ];
  for (const options of installations) {
    const fixture = await installFixture(t, options);
    for (const owner of OWNERS) {
      const { module, resolverPath } = await loadResolver(fixture, owner);
      const resolved = await module.resolveOwnValidationRuntime();
      const canonicalSkillRoot = await fs.realpath(path.dirname(path.dirname(resolverPath)));
      assert.equal(resolved.skillName, owner);
      assert.equal(resolved.skillRoot, canonicalSkillRoot);
      assert.equal(resolved.entrypoint, "runtime/run-validation-session.mjs");
      assert.equal(resolved.runnerProtocol, "stnl-validation-runner/v10");
      assert.equal(resolved.harnessProtocol, "stnl-validation-harness/v10");
      assert.equal(resolved.capabilityIdentity, sourceCapability.identity);
      assert.equal(resolved.packageIdentity, sourceCapability.packages[owner].fingerprint);
      assert.equal(resolved.packageCoherent, true);
      assert.equal(isWithin(resolved.runtimePath, canonicalSkillRoot), true);
      assert.equal(resolved.runtimePath, await fs.realpath(resolved.runtimePath));
      moduleNonce += 1;
      const runtime = await import(`${pathToFileURL(resolved.runtimePath).href}?installed=${moduleNonce}`);
      assert.equal(typeof runtime.runValidationSession, "function");
      assert.equal(typeof runtime.main, "function");
      assert.equal(runtime.VALIDATION_RUNNER_PROTOCOL, resolved.runnerProtocol);
      assert.equal(runtime.VALIDATION_HARNESS_PROTOCOL, resolved.harnessProtocol);

      const cli = spawnSync(process.execPath, [resolverPath, "--resolve"], { encoding: "utf8" });
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(cli.stdout.trim(), resolved.runtimePath);
      const capabilities = spawnSync(process.execPath, [resolverPath, "--capabilities"], { encoding: "utf8" });
      assert.equal(capabilities.status, 0, capabilities.stderr);
      assert.deepEqual(JSON.parse(capabilities.stdout), {
        runner: "stnl-validation-runner/v10", harness: "stnl-validation-harness/v10",
        capability: sourceCapability.identity,
        packageIdentity: sourceCapability.packages[owner].fingerprint,
        packageCoherent: true,
      });
    }
  }
});

test("installed resolver detects same-v10 package byte drift before dispatch", async (t) => {
  const fixture = await installFixture(t, { platform: "codex", scope: "project" });
  const { module, resolverPath } = await loadResolver(fixture, "stnl-slice-executor");
  const current = await module.resolveOwnValidationRuntime();
  assert.equal(current.packageCoherent, true);
  const statePath = path.join(path.dirname(path.dirname(resolverPath)), "runtime/execution-state.mjs");
  await fs.appendFile(statePath, "\n// same nominal v10, different bytes\n", "utf8");
  const drifted = await module.resolveOwnValidationRuntime();
  assert.equal(drifted.runnerProtocol, "stnl-validation-runner/v10");
  assert.equal(drifted.harnessProtocol, "stnl-validation-harness/v10");
  assert.equal(drifted.capabilityIdentity, current.capabilityIdentity);
  assert.notEqual(drifted.packageIdentity, current.packageIdentity);
  assert.equal(drifted.packageCoherent, false);
  const capabilities = spawnSync(process.execPath, [resolverPath, "--capabilities"], { encoding: "utf8" });
  assert.equal(capabilities.status, 1, capabilities.stderr);
  assert.equal(JSON.parse(capabilities.stdout).packageCoherent, false);
});

test("installed resolver detects an adulterated validation capability manifest", async (t) => {
  const fixture = await installFixture(t, { platform: "claude-code", scope: "project" });
  const { module, resolverPath } = await loadResolver(fixture, "stnl-slice-quality-manager");
  const manifestPath = path.join(path.dirname(path.dirname(resolverPath)), "runtime/validation-capability.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.identity = `sha256:${"0".repeat(64)}`;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
  const drifted = await module.resolveOwnValidationRuntime();
  assert.equal(drifted.packageCoherent, false);
  assert.equal(drifted.packageIdentity, null);
});

test("installed resolver dispatches the owning runtime without a caller-supplied root or harness path", async (t) => {
  const fixture = await installFixture(t, { platform: "codex", scope: "project" });
  const { module, resolverPath } = await loadResolver(fixture, "stnl-slice-executor");
  const external = path.join(await temporaryDirectory(t, "stnl injected runtime "), "external.mjs");
  await fs.writeFile(external, "export const injected = true;\n", "utf8");
  await expectResolutionCode(
    module.resolveOwnValidationRuntime({ skillRoot: path.dirname(external), runtimePath: external }),
    "CALLER_RUNTIME_PATH_FORBIDDEN",
  );
  const dispatched = spawnSync(process.execPath, [resolverPath, "unused-spec", "{}"], { encoding: "utf8" });
  assert.equal(dispatched.status, 1);
  assert.match(dispatched.stderr, /validation session request field mismatch/u);
  assert.match(dispatched.stderr, /MALFORMED_HARNESS_OUTPUT/u);
  assert.equal(dispatched.stdout, "");
  assert.doesNotMatch(dispatched.stderr, /external\.mjs/u);
});

test("internal validation entrypoint declaration fails closed when it escapes the installed skill", async (t) => {
  const fixture = await installFixture(t, { platform: "claude-code", scope: "project" });
  const skillRoot = path.dirname(path.dirname(loadedResolverPath(fixture, "stnl-slice-quality-manager")));
  const skillFile = path.join(skillRoot, "SKILL.md");
  const original = await fs.readFile(skillFile, "utf8");
  await fs.writeFile(skillFile, original.replace(
    "validation-runtime: runtime/run-validation-session.mjs",
    "validation-runtime: ../external-validation-runtime.mjs",
  ), "utf8");
  const { module } = await loadResolver(fixture, "stnl-slice-quality-manager");
  await expectResolutionCode(module.resolveOwnValidationRuntime(), "INVALID_VALIDATION_RUNTIME_ENTRYPOINT");
});

test("installed resolver fails deterministically when the declared runtime is missing", async (t) => {
  const fixture = await installFixture(t, { platform: "codex", scope: "user" });
  const { module } = await loadResolver(fixture, "stnl-slice-executor");
  const resolved = await module.resolveOwnValidationRuntime();
  await fs.rm(resolved.runtimePath);
  await expectResolutionCode(module.resolveOwnValidationRuntime(), "VALIDATION_RUNTIME_MISSING");
});

test("installed resolver rejects a mixed current runner and incompatible harness before dispatch", async (t) => {
  const fixture = await installFixture(t, { platform: "codex", scope: "project" });
  const runtimePath = path.join(
    path.dirname(path.dirname(loadedResolverPath(fixture, "stnl-slice-executor"))),
    "runtime/run-validation-session.mjs",
  );
  const source = await fs.readFile(runtimePath, "utf8");
  await fs.writeFile(runtimePath, source.replace(
    'export const VALIDATION_HARNESS_PROTOCOL = "stnl-validation-harness/v10";',
    'export const VALIDATION_HARNESS_PROTOCOL = "stnl-validation-harness/v9";',
  ), "utf8");
  const { module } = await loadResolver(fixture, "stnl-slice-executor");
  await expectResolutionCode(module.resolveOwnValidationRuntime(), "INCOMPATIBLE_VALIDATION_PROTOCOL");
});

test("installed resolver rejects a declared runtime symlink that escapes its skill package", async (t) => {
  const fixture = await installFixture(t, { platform: "claude-code", scope: "user" });
  const { module } = await loadResolver(fixture, "stnl-slice-quality-manager");
  const resolved = await module.resolveOwnValidationRuntime();
  const externalRoot = await temporaryDirectory(t, "stnl external harness ");
  const externalRuntime = path.join(externalRoot, "run-validation-session.mjs");
  await fs.writeFile(externalRuntime, "export const escaped = true;\n", "utf8");
  await fs.rm(resolved.runtimePath);
  await fs.symlink(externalRuntime, resolved.runtimePath);
  await expectResolutionCode(module.resolveOwnValidationRuntime(), "VALIDATION_RUNTIME_ESCAPE");
});
