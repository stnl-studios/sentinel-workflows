#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  checkDistributableSkill,
  LIFECYCLE_DISTRIBUTION_POLICY,
} from "./lib/check-distributable-skill.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_SKILL_ROOT = join(REPOSITORY_ROOT, "skills", "stnl-spec-lifecycle-manager");
const ENTRYPOINTS = Object.freeze({
  validator: "validate-spec-lifecycle.mjs",
  attestation: "create-readiness-attestation.mjs",
  renderer: "build-closed-spec.mjs",
  publisher: "publish-spec-lifecycle.mjs",
});

async function assertSelfContained(skillRoot) {
  assert.deepEqual(
    await checkDistributableSkill(skillRoot, LIFECYCLE_DISTRIBUTION_POLICY),
    [],
  );
}

function runNode(entrypoint, args, options = {}) {
  const result = spawnSync(process.execPath, [entrypoint, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: options.emptyPath ?? process.env.PATH,
      ...options.env,
    },
    timeout: options.timeout ?? 20_000,
  });
  return result;
}

function assertCliPass(result, label) {
  assert.equal(result.error, undefined, `${label} failed to start: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `${label} failed (status=${result.status}, signal=${result.signal})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /^PASS:/mu, `${label} did not emit the PASS contract`);
}

async function writeResumeManifest(installedSkill, workspace, manifestPath) {
  const lifecycleUrl = pathToFileURL(
    join(installedSkill, "runtime", "lib", "lifecycle.mjs"),
  ).href;
  const { resumeWorkspaceIdentity, validateWorkspace } = await import(`${lifecycleUrl}?isolated=${Date.now()}`);
  const validated = await Promise.resolve(validateWorkspace(workspace));
  const preStateSha256 = await Promise.resolve(resumeWorkspaceIdentity(workspace));
  const payload = {
    schema_version: 1,
    mode: "RESUME",
    workspace_identity: {
      h1: validated.h1,
      pre_state_sha256: preStateSha256,
    },
    allowed_feature_sections: [],
    allowed_existing_ids: [],
    allowed_new_ids: [],
    allowed_status_transitions: [],
    allowed_record_status_transitions: [],
  };
  await writeFile(manifestPath, `${JSON.stringify(payload)}\n`, "utf8");
}

test("distributed lifecycle skill is statically self-contained", async () => {
  await assertSelfContained(SOURCE_SKILL_ROOT);
});

test("self-containment checker accepts portable path syntax without false positives", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stnl portable path controls "));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await cp(SOURCE_SKILL_ROOT, temporaryRoot, { recursive: true, verbatimSymlinks: true });
  const readme = join(temporaryRoot, "README.md");
  await writeFile(
    readme,
    `${await readFile(readme, "utf8")}\n${[
      "https://example.com/api/v1/resources",
      "docs/core/CONTRACTS.md",
      "<SKILL_ROOT>/runtime/validate-spec-lifecycle.mjs",
      "C:relative\\not-absolute",
      "/api/v1",
      "Documentation may spell import(variable), require('module'), or createRequire without executing them.",
    ].join("\n")}\n`,
  );
  const controls = join(temporaryRoot, "runtime", "test", "checker-safe-controls.mjs");
  const target = join(temporaryRoot, "runtime", "test", "checker-safe-target.mjs");
  await writeFile(target, "export const value = 1;\n");
  await writeFile(
    controls,
    `${[
      '// import(variable), require("module"), and createRequire are documentation only.',
      '// Negative example only: import "left-pad";',
      '// Negative dynamic-code examples only: eval("..."); Function("..."); process.getBuiltinModule("node:vm").',
      'const documentation = "import(variable) require(\'module\') createRequire";',
      'const dynamicCodeDocumentation = "eval Function process.getBuiltinModule node:vm";',
      'const templateDocumentation = `Negative example only: import "left-pad";`;',
      'const dynamicCodeTemplateDocumentation = `eval("import(dependency)") Function("return import(dependency)")`;',
      'const escapedTemplateDocumentation = `Escaped expression: \\${await import("left-pad")}`;',
      'const regularExpressionDocumentation = /import\\s*\\(\"left-pad\"\\)/u;',
      'const taggedTemplateRegexDocumentation = String.raw`${/import\\(\"left-pad\"\\)/u.test("none")}`;',
      'const controlValue = "value";',
      'if (controlValue) /import "left-pad"/.test(controlValue);',
      'if (controlValue) controlValue.toString(); else /import "left-pad"/.test(controlValue);',
      'do /import(dependency)/.test(controlValue); while (false);',
      'let controlIterations = 0;',
      'while (controlIterations++ < 1) /import(dependency)/.test(controlValue);',
      'for (let controlIndex = 0; controlIndex < 1; controlIndex += 1) /Function("return import(dependency)")/.test(controlValue);',
      'const importer = { import: (value) => value };',
      'const ordinaryMethodResult = importer.import("left-pad");',
      'export const load = () => import("./checker-safe-target.mjs");',
      'export const nestedLoad = () => `outer ${`inner ${import("./checker-safe-target.mjs")}`}`;',
      'export { documentation, dynamicCodeDocumentation, templateDocumentation, dynamicCodeTemplateDocumentation, escapedTemplateDocumentation, regularExpressionDocumentation, taggedTemplateRegexDocumentation, ordinaryMethodResult };',
    ].join("\n")}\n`,
  );
  await assertSelfContained(temporaryRoot);
});

test("self-containment checker rejects operational distribution mutations", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stnl self containment mutations "));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const mutations = [
    {
      name: "missing entrypoint",
      expected: "missing runtime entrypoint",
      apply: (root) => rm(join(root, "runtime", ENTRYPOINTS.validator)),
    },
    {
      name: "external module",
      expected: "external module import",
      apply: (root) =>
        writeFile(join(root, "runtime", "lib", "external-mutation.mjs"), 'import "left-pad";\n'),
    },
    {
      name: "external module with string-named binding",
      expected: "external module import",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "external-string-binding-mutation.mjs"),
          'import { "default" as dependency } from "left-pad";\nexport { dependency };\n',
        ),
    },
    {
      name: "external module after astral identifier",
      expected: "external module import",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "external-after-astral-mutation.mjs"),
          'const 𐐀 = 1;\nimport "left-pad";\nexport { 𐐀 };\n',
        ),
    },
    {
      name: "external module after string division",
      expected: "external module import",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "external-after-division-mutation.mjs"),
          'const ratio = "value" / 2;\nimport "left-pad";\nexport { ratio };\n',
        ),
    },
    {
      name: "escaping import",
      expected: "import escapes the distributed skill",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "escape-mutation.mjs"),
          'import "../../../../outside.mjs";\n',
        ),
    },
    {
      name: "nonliteral dynamic import",
      expected: "non-literal dynamic import is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "dynamic-mutation.mjs"),
          'const specifier = "./core.mjs";\nexport const load = () => import(specifier);\n',
        ),
    },
    {
      name: "nonliteral dynamic import after postfix division",
      expected: "non-literal dynamic import is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "postfix-division-dynamic-mutation.mjs"),
          'const dependency = "left-pad";\nlet value = 1;\nexport const loaded = value++ / import(dependency);\n',
        ),
    },
    {
      name: "dynamic import hidden in eval",
      expected: "dynamic code loading is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "eval-dynamic-mutation.mjs"),
          'const dependency = "left-pad";\nexport const load = () => eval("import(dependency)");\n',
        ),
    },
    {
      name: "dynamic import hidden in Function",
      expected: "dynamic code loading is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "function-dynamic-mutation.mjs"),
          'const dependency = "left-pad";\nexport const load = Function("return import(dependency)");\n',
        ),
    },
    {
      name: "dynamic import hidden in indirect eval",
      expected: "dynamic code loading is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "indirect-eval-dynamic-mutation.mjs"),
          'const dependency = "left-pad";\nexport const load = () => (0, eval)("import(dependency)");\n',
        ),
    },
    {
      name: "dynamic import hidden in Function constructor alias",
      expected: "dynamic code loading is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "constructor-dynamic-mutation.mjs"),
          'const dependency = "left-pad";\nconst DynamicFunction = (() => {}).constructor;\nexport const load = DynamicFunction("return import(dependency)");\n',
        ),
    },
    {
      name: "dynamic import hidden in computed eval access",
      expected: "dynamic code loading is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "computed-eval-dynamic-mutation.mjs"),
          'const dependency = "left-pad";\nexport const load = () => globalThis["eval"]("import(dependency)");\n',
        ),
    },
    {
      name: "dynamic code module",
      expected: "dynamic code module is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "vm-dynamic-mutation.mjs"),
          'import { Script } from "node:vm";\nexport const load = (source) => new Script(source);\n',
        ),
    },
    {
      name: "process builtin loader",
      expected: "dynamic code loading is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "builtin-loader-mutation.mjs"),
          'export const moduleApi = process.getBuiltinModule("node:module");\n',
        ),
    },
    {
      name: "dynamic import in template expression",
      expected: "non-literal dynamic import is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "template-expression-dynamic-mutation.mjs"),
          'const dependency = "left-pad";\nexport const loaded = `${await import(dependency)}`;\n',
        ),
    },
    {
      name: "dynamic import in nested template expression",
      expected: "non-literal dynamic import is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "nested-template-expression-dynamic-mutation.mjs"),
          'const dependency = "left-pad";\nexport const loaded = `outer ${`inner ${await import(dependency)}`}`;\n',
        ),
    },
    {
      name: "template dynamic import",
      expected: "non-literal dynamic import is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "template-dynamic-mutation.mjs"),
          'const name = "core";\nexport const load = () => import(`./${name}.mjs`);\n',
        ),
    },
    {
      name: "createRequire bridge",
      expected: "createRequire is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "create-require-mutation.mjs"),
          'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);\nexport { require };\n',
        ),
    },
    {
      name: "CommonJS require",
      expected: "CommonJS require is forbidden",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "commonjs-mutation.mjs"),
          'export const filesystem = require("node:fs");\n',
        ),
    },
    {
      name: "repository scripts dependency",
      expected: "repository-relative scripts dependency",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\n../../scripts/runtime.mjs\n`);
      },
    },
    {
      name: "legacy executable",
      expected: "Python runtime reference",
      apply: async (root) => {
        const path = join(root, "README.md");
        const executable = ["py", "thon3"].join("");
        await writeFile(path, `${await readFile(path, "utf8")}\n${executable} tool.py\n`);
      },
    },
    {
      name: "package installation",
      expected: "package installation instruction",
      apply: async (root) => {
        const path = join(root, "README.md");
        const command = ["npm", "install", "dependency"].join(" ");
        await writeFile(path, `${await readFile(path, "utf8")}\n${command}\n`);
      },
    },
    {
      name: "macOS host absolute path",
      expected: "host-specific absolute path",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\n/Users/example/repository/tool\n`);
      },
    },
    {
      name: "Linux home absolute path",
      expected: "host-specific absolute path",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\n/home/alice/repository/tool\n`);
      },
    },
    {
      name: "Linux root absolute path",
      expected: "host-specific absolute path",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\n/root/repository/tool\n`);
      },
    },
    {
      name: "generic POSIX absolute path",
      expected: "host-specific absolute path",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\n/custom/location/repository/tool\n`);
      },
    },
    {
      name: "Windows drive absolute path",
      expected: "host-specific absolute path",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\nD:\\work\\repository\\tool\n`);
      },
    },
    {
      name: "Windows forward-slash drive absolute path",
      expected: "host-specific absolute path",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\nE:/work/repository/tool\n`);
      },
    },
    {
      name: "Windows UNC absolute path",
      expected: "host-specific absolute path",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\n\\\\server\\share\\repository\\tool\n`);
      },
    },
    {
      name: "Windows slash UNC absolute path",
      expected: "host-specific absolute path",
      apply: async (root) => {
        const path = join(root, "README.md");
        await writeFile(path, `${await readFile(path, "utf8")}\n//server/share/repository/tool\n`);
      },
    },
    {
      name: "operational child process",
      expected: "operational runtime must not execute external commands",
      apply: (root) =>
        writeFile(
          join(root, "runtime", "lib", "process-mutation.mjs"),
          'import "node:child_process";\n',
        ),
    },
    {
      name: "package manifest",
      expected: "must not require package.json",
      apply: (root) => writeFile(join(root, "package.json"), "{}\n"),
    },
    {
      name: "nested package manifest",
      expected: "must not require package.json",
      apply: async (root) => {
        const directory = join(root, "runtime", "vendor");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "package.json"), "{}\n");
      },
    },
    {
      name: "nested dependency lockfile",
      expected: "must not contain dependency lockfile",
      apply: async (root) => {
        const directory = join(root, "examples", "nested");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "package-lock.json"), "{}\n");
      },
    },
    {
      name: "runtime JavaScript source",
      expected: "unsupported executable source format",
      apply: (root) => writeFile(join(root, "runtime", "lib", "hidden-runtime.js"), "export const hidden = true;\n"),
    },
    {
      name: "extensionless runtime module",
      expected: "runtime file must use an allowed source format",
      apply: async (root) => {
        await writeFile(
          join(root, "runtime", "lib", "hidden-runtime-module"),
          'import "left-pad";\nexport const hidden = true;\n',
        );
        await writeFile(
          join(root, "runtime", "lib", "extensionless-import.mjs"),
          'import "./hidden-runtime-module";\n',
        );
      },
    },
    {
      name: "runtime shell source",
      expected: "unsupported executable source format",
      apply: (root) => writeFile(join(root, "runtime", "hidden-runtime.sh"), "node runtime.mjs\n"),
    },
    {
      name: "os metadata",
      expected: "contains OS metadata",
      apply: (root) => writeFile(join(root, ".DS_Store"), "metadata"),
    },
  ];

  for (const mutation of mutations) {
    await t.test(mutation.name, async () => {
      const root = join(temporaryRoot, mutation.name);
      await mkdir(root, { recursive: true });
      await cp(SOURCE_SKILL_ROOT, root, { recursive: true, verbatimSymlinks: true });
      await mutation.apply(root);
      const findings = await checkDistributableSkill(root, LIFECYCLE_DISTRIBUTION_POLICY);
      assert(
        findings.some((finding) => finding.includes(mutation.expected)),
        `${mutation.name} was not rejected as ${mutation.expected}: ${findings.join(" | ")}`,
      );
    });
  }
});

test("copying only the skill supports INIT, RESUME, READINESS, CLOSE, and recovery", async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "stnl isolated distribution "));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const installedSkill = join(temporaryRoot, "installed skills", "lifecycle skill with spaces");
  const consumer = join(temporaryRoot, "consumer project with spaces");
  const emptyPath = join(temporaryRoot, "empty executable path");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(installedSkill), { recursive: true });
  await mkdir(consumer, { recursive: true });
  await mkdir(emptyPath, { recursive: true });
  await cp(SOURCE_SKILL_ROOT, installedSkill, { recursive: true, verbatimSymlinks: true });
  await assertSelfContained(installedSkill);

  const runtime = join(installedSkill, "runtime");
  const commands = Object.fromEntries(
    Object.entries(ENTRYPOINTS).map(([name, file]) => [name, join(runtime, file)]),
  );
  const readyFixture = join(
    installedSkill,
    "examples",
    "validator-fixtures",
    "ready",
  );

  const initCandidate = join(consumer, "candidate init with spaces");
  const activeTarget = join(consumer, "published spec with spaces");
  await cp(readyFixture, initCandidate, { recursive: true, verbatimSymlinks: true });
  assertCliPass(
    runNode(commands.publisher, ["INIT", activeTarget, initCandidate], {
      cwd: consumer,
      emptyPath,
    }),
    "isolated INIT",
  );
  assertCliPass(
    runNode(commands.validator, ["workspace", activeTarget], { cwd: consumer, emptyPath }),
    "isolated workspace validation",
  );

  const resumeCandidate = join(consumer, "candidate resume with spaces");
  const resumeManifest = join(consumer, "resume manifest with spaces.json");
  await cp(activeTarget, resumeCandidate, { recursive: true, verbatimSymlinks: true });
  await writeResumeManifest(installedSkill, activeTarget, resumeManifest);
  assertCliPass(
    runNode(
      commands.publisher,
      ["RESUME", activeTarget, resumeCandidate, "--manifest", resumeManifest],
      { cwd: consumer, emptyPath },
    ),
    "isolated RESUME",
  );

  const readinessBefore = join(consumer, "readiness before");
  const readinessAfter = join(consumer, "readiness after");
  await cp(activeTarget, readinessBefore, { recursive: true, verbatimSymlinks: true });
  await cp(activeTarget, readinessAfter, { recursive: true, verbatimSymlinks: true });
  assertCliPass(
    runNode(
      commands.validator,
      ["readiness-transition", readinessBefore, readinessAfter, "--scope", "GLOBAL"],
      { cwd: consumer, emptyPath },
    ),
    "isolated READINESS",
  );

  const attestation = join(consumer, "readiness attestation with spaces.json");
  assertCliPass(
    runNode(
      commands.attestation,
      [activeTarget, attestation, "--scope", "GLOBAL", "--verdict", "READY"],
      { cwd: consumer, emptyPath },
    ),
    "isolated readiness attestation",
  );

  const closeCandidate = join(consumer, "candidate close with spaces");
  assertCliPass(
    runNode(
      commands.renderer,
      [activeTarget, closeCandidate, "--readiness-attestation", attestation],
      { cwd: consumer, emptyPath },
    ),
    "isolated deterministic renderer",
  );
  assertCliPass(
    runNode(
      commands.publisher,
      ["CLOSE", activeTarget, closeCandidate, "--readiness-attestation", attestation],
      { cwd: consumer, emptyPath },
    ),
    "isolated CLOSE",
  );
  assert.equal(
    await stat(attestation).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error))),
    null,
    "terminal CLOSE must delete its ephemeral readiness attestation",
  );
  const closedValidation = runNode(commands.validator, ["workspace", activeTarget], {
    cwd: consumer,
    emptyPath,
  });
  assertCliPass(closedValidation, "isolated closed workspace validation");
  assert.match(closedValidation.stdout, /status=closed/u);

  const recoveryCandidate = join(consumer, "recovery candidate with spaces");
  const recoveryTarget = join(consumer, "recovery target with spaces");
  await cp(readyFixture, recoveryCandidate, { recursive: true, verbatimSymlinks: true });
  const crashed = runNode(commands.publisher, ["INIT", recoveryTarget, recoveryCandidate], {
    cwd: consumer,
    emptyPath,
    env: {
      STNL_PUBLISHER_TEST_ONLY_CRASH_AT_CHECKPOINT: "JOURNAL_PREPARED",
      STNL_PUBLISHER_TEST_ONLY_ACKNOWLEDGE_PROCESS_KILL:
        "YES_THIS_IS_AN_ISOLATED_PUBLISHER_CRASH_TEST",
    },
  });
  assert.equal(crashed.error, undefined, `crash process failed to start: ${crashed.error?.message}`);
  assert.notEqual(crashed.status, 0, "the crash checkpoint unexpectedly committed");
  const recoveryInvocation = runNode(
    commands.publisher,
    ["INIT", recoveryTarget, recoveryCandidate],
    { cwd: consumer, emptyPath },
  );
  assert.equal(recoveryInvocation.status, 1, recoveryInvocation.stderr);
  assert.match(
    recoveryInvocation.stderr,
    /FAIL: INIT destination already exists:/u,
    "retry did not recover the prepared INIT before applying normal idempotency rules",
  );
  assertCliPass(
    runNode(commands.validator, ["workspace", recoveryTarget], { cwd: consumer, emptyPath }),
    "isolated recovered workspace validation",
  );
  const recoveryResidues = (await readdir(consumer)).filter(
    (name) =>
      name.startsWith(".recovery target with spaces.lifecycle-journal") ||
      name.startsWith(".recovery target with spaces.lifecycle-stage-") ||
      name.startsWith(".recovery target with spaces.lifecycle-backup-"),
  );
  assert.deepEqual(recoveryResidues, [], "recovery left journal, stage, or backup residue");
  const releasedLock = JSON.parse(
    await readFile(join(consumer, ".recovery target with spaces.lifecycle.lock"), "utf8"),
  );
  assert.equal(releasedLock.state, "released");
  assert.match(releasedLock.operation_id, /^[0-9a-f]{32}$/u);
  assert.equal(
    releasedLock.transaction_id,
    null,
    "the post-recovery retry failed before allocating a new transaction",
  );
});
