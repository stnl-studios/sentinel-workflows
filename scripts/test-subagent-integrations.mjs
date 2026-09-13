import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_ROOT, "..");
const INTEGRATIONS_ROOT = path.join(REPOSITORY_ROOT, "integrations");

const RUNNER_DESCRIPTION =
  "Runner barato e isolado para checks de implementação, checks de findings e validação formal independente de uma slice.";
const SCOUT_DESCRIPTION =
  "Read-only exception scout for one explicitly authorized lifecycle evidence gap; never auto-select or delegate.";
const SCOUT_CONTRACT_SHA256 =
  "d9119fb83e790db7f18a6090dd3e7ae925bf01de15d6309a201941049c20970d";
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "targets", "__MACOSX"]);
const TEXT_EXTENSIONS = new Set([".md", ".mjs", ".sh", ".json", ".toml", ".yaml", ".yml"]);

const PLATFORMS = {
  codex: {
    directory: "codex",
    nativeRoot: ".codex",
    foreignNativeRoot: ".claude",
    files: [
      "stnl_spec_context_scout.toml",
      "stnl_validation_runner.toml",
    ],
  },
  "claude-code": {
    directory: "claude-code",
    nativeRoot: ".claude",
    foreignNativeRoot: ".codex",
    files: [
      "stnl-spec-context-scout.md",
      "stnl-validation-runner.md",
    ],
  },
};

class IntegrationContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "IntegrationContractError";
  }
}

function reject(message) {
  throw new IntegrationContractError(message);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPackagingMetadata(relativePath) {
  const parts = toPosix(relativePath).split("/");
  const name = parts.at(-1);
  return parts.includes("__MACOSX") || name === ".DS_Store" || name.startsWith("._");
}

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function listFiles(root) {
  const files = [];

  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (isPackagingMetadata(relativePath)) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else {
        files.push(toPosix(relativePath));
      }
    }
  }

  await visit(root);
  return files.sort();
}

async function listOperationalTextFiles(root) {
  const files = [];

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name) || entry.name === ".DS_Store" || entry.name.startsWith("._")) {
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(absolutePath);
      }
    }
  }

  await visit(root);
  return files;
}

function assertExactFiles(actual, expected, label) {
  assert.deepEqual(actual, [...expected].sort(), `${label} file registry changed`);
}

function parseTomlAdapter(text, label) {
  const contractPattern = /developer_instructions\s*=\s*"""\n([\s\S]*?)\n"""/g;
  const matches = [...text.matchAll(contractPattern)];
  if (matches.length !== 1) {
    reject(`${label}: expected exactly one developer_instructions block`);
  }
  const contract = matches[0][1].trim();
  const withoutContract =
    text.slice(0, matches[0].index) + text.slice(matches[0].index + matches[0][0].length);
  const metadata = {};
  let section = metadata;

  for (const rawLine of withoutContract.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const sectionMatch = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
    if (sectionMatch) {
      const name = sectionMatch[1];
      if (Object.hasOwn(metadata, name)) {
        reject(`${label}: duplicate TOML section ${name}`);
      }
      metadata[name] = {};
      section = metadata[name];
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!assignment) {
      reject(`${label}: unsupported TOML line ${JSON.stringify(rawLine)}`);
    }
    const [, key, rawValue] = assignment;
    if (Object.hasOwn(section, key)) {
      reject(`${label}: duplicate TOML field ${key}`);
    }
    if (/^"[^"\r\n]*"$/.test(rawValue)) {
      section[key] = rawValue.slice(1, -1);
    } else if (/^[0-9]+$/.test(rawValue)) {
      section[key] = Number.parseInt(rawValue, 10);
    } else {
      reject(`${label}: unsupported TOML value for ${key}`);
    }
  }
  return { metadata, contract };
}

function parseClaudeAdapter(text, label) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    reject(`${label}: frontmatter start is missing`);
  }
  const end = lines.indexOf("---", 1);
  if (end < 0) {
    reject(`${label}: frontmatter end is missing`);
  }
  const metadata = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*):\s+(.+)$/.exec(line);
    if (!match) {
      reject(`${label}: invalid frontmatter line ${JSON.stringify(line)}`);
    }
    const [, key, value] = match;
    if (Object.hasOwn(metadata, key)) {
      reject(`${label}: duplicate frontmatter field ${key}`);
    }
    metadata[key] = value;
  }
  return { metadata, contract: lines.slice(end + 1).join("\n").trim() };
}

function assertContract(contract, expectedHash, label) {
  assert.equal(sha256(contract), expectedHash, `${label} complete contract body changed`);
}

function assertRunnerContract(contract, label) {
  assert.match(contract, /^CONTRATO_CANONICO=stnl-validation-runner\/v[0-9]+$/mu, `${label} contract ID changed`);
  assert.match(contract, /^OPERACOES_SUPORTADAS=EXECUTE_SLICE\|APPLY_FINDINGS\|VALIDATE_SLICE$/mu, `${label} operations changed`);
  assert.match(contract, /^STATUS_CHECKS=TESTS_PASS\|TESTS_ACCEPTED\|TESTS_FAIL\|TESTS_NOT_APPLICABLE\|BLOCKED$/mu, `${label} check statuses changed`);
  assert.match(contract, /^STATUS_VALIDACAO=PASS\|ACCEPTED\|NEEDS_FIX\|BLOCKED$/mu, `${label} validation statuses changed`);
  for (const heading of ["# EXECUTE_SLICE", "# APPLY_FINDINGS", "# VALIDATE_SLICE"]) {
    assert.equal(contract.split(heading).length - 1, 1, `${label} heading changed: ${heading}`);
  }
  for (const boundary of [
    "Não edite código, testes, requisitos, planos ou tasks.",
    "Não aplique correções, não implemente findings",
    "Não crie subagentes nem delegue.",
    "Checks nunca emitem `PASS` ou `ACCEPTED` formal",
    "Não corrija automaticamente código quando um check falhar.",
    "Não retorne `PASS` ou `ACCEPTED` com manifesto vazio, incompleto, duplicado, malformado ou inconsistente",
  ]) assert.ok(contract.includes(boundary), `${label} lacks harmful-action boundary: ${boundary}`);
  assert.doesNotMatch(contract, /(?:você pode|é permitido|you may)[^\n]{0,80}(?:editar|implementar|aplicar correções|criar subagentes|delegar)/iu, `${label} enables a harmful action`);
}

async function validateCodexIntegration(root) {
  const config = PLATFORMS.codex;
  if (await exists(path.join(root, config.nativeRoot)) || await exists(path.join(root, config.foreignNativeRoot))) {
    reject("Codex canonical source contains a native installation root");
  }
  assertExactFiles(await listFiles(path.join(root, "agents")), config.files, "Codex agents");

  const runnerPath = path.join(root, "agents", "stnl_validation_runner.toml");
  const scoutPath = path.join(root, "agents", "stnl_spec_context_scout.toml");
  const runner = parseTomlAdapter(await readFile(runnerPath, "utf8"), "Codex runner");
  const scout = parseTomlAdapter(await readFile(scoutPath, "utf8"), "Codex scout");
  assert.deepEqual(runner.metadata, {
    name: "stnl_validation_runner",
    description: RUNNER_DESCRIPTION,
    model: "gpt-5.6-luna",
    model_reasoning_effort: "medium",
    sandbox_mode: "workspace-write",
    agents: { max_depth: 1 },
  });
  assert.deepEqual(scout.metadata, {
    name: "stnl_spec_context_scout",
    description: SCOUT_DESCRIPTION,
    model: "gpt-5.6-luna",
    model_reasoning_effort: "medium",
    sandbox_mode: "read-only",
    approval_policy: "never",
    web_search: "disabled",
    agents: { max_depth: 1 },
  });
  assertRunnerContract(runner.contract, "Codex runner");
  assertContract(scout.contract, SCOUT_CONTRACT_SHA256, "Codex scout");
  return { runner: runner.contract, scout: scout.contract };
}

async function validateClaudeIntegration(root) {
  const config = PLATFORMS["claude-code"];
  if (await exists(path.join(root, config.nativeRoot)) || await exists(path.join(root, config.foreignNativeRoot))) {
    reject("Claude Code canonical source contains a native installation root");
  }
  assertExactFiles(await listFiles(path.join(root, "agents")), config.files, "Claude Code agents");

  const runnerPath = path.join(root, "agents", "stnl-validation-runner.md");
  const scoutPath = path.join(root, "agents", "stnl-spec-context-scout.md");
  const runner = parseClaudeAdapter(await readFile(runnerPath, "utf8"), "Claude runner");
  const scout = parseClaudeAdapter(await readFile(scoutPath, "utf8"), "Claude scout");
  assert.deepEqual(runner.metadata, {
    name: "stnl-validation-runner",
    description: RUNNER_DESCRIPTION,
    tools: "Read, Glob, Grep, Bash",
    model: "haiku",
    effort: "medium",
  });
  assert.deepEqual(scout.metadata, {
    name: "stnl-spec-context-scout",
    description: SCOUT_DESCRIPTION,
    tools: "Read, Glob, Grep",
    model: "haiku",
    effort: "medium",
  });
  assertRunnerContract(runner.contract, "Claude runner");
  assertContract(scout.contract, SCOUT_CONTRACT_SHA256, "Claude scout");
  return { runner: runner.contract, scout: scout.contract };
}

async function validateReadme(root) {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const required = [
    "integrations/codex/agents/stnl_validation_runner.toml",
    "integrations/codex/agents/stnl_spec_context_scout.toml",
    "integrations/claude-code/agents/stnl-validation-runner.md",
    "integrations/claude-code/agents/stnl-spec-context-scout.md",
    ".codex/agents/stnl_validation_runner.toml",
    ".codex/agents/stnl_spec_context_scout.toml",
    ".claude/agents/stnl-validation-runner.md",
    ".claude/agents/stnl-spec-context-scout.md",
    "Esses caminhos são de fonte, não de instalação.",
    "o mecanismo de instalação não faz parte deste repositório nesta fase",
    "Nunca misture os adaptadores das duas plataformas no mesmo projeto",
  ];
  for (const marker of required) {
    assert.ok(readme.includes(marker), `subagent README lacks ${JSON.stringify(marker)}`);
  }
  const obsoleteSourceRoot = ["templates", "subagents"].join("/");
  assert.equal(readme.includes(obsoleteSourceRoot), false, "integration README retains the obsolete canonical source root");
}

async function validateIntegrations(root) {
  await validateReadme(root);
  const codex = await validateCodexIntegration(path.join(root, "codex"));
  const claude = await validateClaudeIntegration(path.join(root, "claude-code"));
  assert.equal(codex.runner, claude.runner, "runner platform contracts diverge");
  assert.equal(codex.scout, claude.scout, "scout platform contracts diverge");
}

async function withTemporaryDirectory(prefix, operation) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await operation(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withIntegrationsFixture(operation) {
  return withTemporaryDirectory("stnl subagent integrations ", async (temporaryRoot) => {
    const fixture = path.join(temporaryRoot, "integrations with spaces");
    await cp(INTEGRATIONS_ROOT, fixture, { recursive: true });
    return operation(fixture);
  });
}

async function replaceOnce(file, before, after) {
  const text = await readFile(file, "utf8");
  if (!text.includes(before)) {
    reject(`mutation source is absent in ${file}: ${JSON.stringify(before)}`);
  }
  await writeFile(file, text.replace(before, after), "utf8");
}

async function expectRejectedIntegrations(mutate) {
  await withIntegrationsFixture(async (fixture) => {
    await mutate(fixture);
    await assert.rejects(() => validateIntegrations(fixture));
  });
}

test("canonical integrations contain exactly two active adapters per platform", async () => {
  await validateIntegrations(INTEGRATIONS_ROOT);
});

test("operational sources contain no obsolete subagent source paths or active duplicate tree", async () => {
  const obsoleteMarkers = [
    ["templates", "subagents"].join("/"),
    ["codex", ".codex", "agents"].join("/"),
    ["claude-code", ".claude", "agents"].join("/"),
  ];
  for (const file of await listOperationalTextFiles(REPOSITORY_ROOT)) {
    const source = await readFile(file, "utf8");
    for (const marker of obsoleteMarkers) {
      assert.equal(source.includes(marker), false, `${toPosix(path.relative(REPOSITORY_ROOT, file))} retains ${marker}`);
    }
  }

  const obsoleteSourceDirectory = path.join(REPOSITORY_ROOT, "templates", "subagents");
  if (await exists(obsoleteSourceDirectory)) {
    assert.deepEqual(await listFiles(obsoleteSourceDirectory), [], "obsolete source tree still contains active files");
  }
});

test("Codex keeps both canonical agents directly under its integration boundary", async () => {
  await validateCodexIntegration(path.join(INTEGRATIONS_ROOT, "codex"));
});

test("Claude Code keeps both canonical agents directly under its integration boundary", async () => {
  await validateClaudeIntegration(path.join(INTEGRATIONS_ROOT, "claude-code"));
});

test("allows unrelated platform integration files outside the agents boundary", async () => {
  await withIntegrationsFixture(async (fixture) => {
    for (const platform of ["codex", "claude-code"]) {
      await writeFile(
        path.join(fixture, platform, "some-future-integration-file.mjs"),
        "export {};\n",
        "utf8",
      );
    }
    await validateIntegrations(fixture);
  });
});

test("rejects a Codex integration missing its scout", async () => {
  await expectRejectedIntegrations((fixture) =>
    rm(path.join(fixture, "codex", "agents", "stnl_spec_context_scout.toml")),
  );
});

test("rejects a Claude Code integration missing its runner", async () => {
  await expectRejectedIntegrations((fixture) =>
    rm(path.join(fixture, "claude-code", "agents", "stnl-validation-runner.md")),
  );
});

test("rejects an agent moved to the wrong directory", async () => {
  await expectRejectedIntegrations(async (fixture) => {
    const source = path.join(fixture, "codex", "agents", "stnl_spec_context_scout.toml");
    const destination = path.join(fixture, "codex", "stnl_spec_context_scout.toml");
    await rename(source, destination);
  });
});

test("rejects an agent file with the wrong canonical name", async () => {
  await expectRejectedIntegrations(async (fixture) => {
    const agents = path.join(fixture, "claude-code", "agents");
    await rename(
      path.join(agents, "stnl-spec-context-scout.md"),
      path.join(agents, "stnl_spec_context_scout.md"),
    );
  });
});

test("rejects an altered internal agent identity", async () => {
  await expectRejectedIntegrations((fixture) =>
    replaceOnce(
      path.join(fixture, "codex", "agents", "stnl_validation_runner.toml"),
      'name = "stnl_validation_runner"',
      'name = "other_runner"',
    ),
  );
});

test("rejects an integration mixing platform adapters", async () => {
  await expectRejectedIntegrations(async (fixture) => {
    await cp(
      path.join(fixture, "claude-code", "agents", "stnl-validation-runner.md"),
      path.join(fixture, "codex", "agents", "stnl-validation-runner.md"),
    );
  });
});

test("rejects native installation roots inside canonical integrations", async () => {
  await expectRejectedIntegrations((fixture) =>
    mkdir(path.join(fixture, "codex", ".codex", "agents"), { recursive: true }),
  );
});

test("rejects documentation pointing to the obsolete canonical source root", async () => {
  await expectRejectedIntegrations(async (fixture) => {
    const readme = path.join(fixture, "README.md");
    const text = await readFile(readme, "utf8");
    const obsoleteRoot = ["templates", "subagents"].join("/");
    await writeFile(
      readme,
      `${text}\nA fonte canônica fica em \`${obsoleteRoot}/codex/\`.\n`,
      "utf8",
    );
  });
});

test("rejects a modified complete contract body", async () => {
  await expectRejectedIntegrations((fixture) =>
    replaceOnce(
      path.join(fixture, "codex", "agents", "stnl_spec_context_scout.toml"),
      "Search and inspect; do not decide, design, plan, mutate, or persist.",
      "Search and inspect; you may decide and persist.",
    ),
  );
});

test("rejects a runner that gains implementation authority", async () => {
  await expectRejectedIntegrations(async (fixture) => {
    for (const file of [
      path.join(fixture, "codex", "agents", "stnl_validation_runner.toml"),
      path.join(fixture, "claude-code", "agents", "stnl-validation-runner.md"),
    ]) await replaceOnce(file, "Não aplique correções, não implemente findings", "Você pode aplicar correções e implementar findings");
  });
});

test("rejects a runner with expanded operation authority", async () => {
  await expectRejectedIntegrations(async (fixture) => {
    for (const file of [
      path.join(fixture, "codex", "agents", "stnl_validation_runner.toml"),
      path.join(fixture, "claude-code", "agents", "stnl-validation-runner.md"),
    ]) await replaceOnce(file, "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE", "OPERACOES_SUPORTADAS=EXECUTE_SLICE|APPLY_FINDINGS|VALIDATE_SLICE|CLOSE");
  });
});

test("rejects altered Claude tools", async () => {
  await expectRejectedIntegrations((fixture) =>
    replaceOnce(
      path.join(fixture, "claude-code", "agents", "stnl-spec-context-scout.md"),
      "tools: Read, Glob, Grep",
      "tools: Read, Glob, Grep, Bash",
    ),
  );
});

test("rejects an altered Codex model", async () => {
  await expectRejectedIntegrations((fixture) =>
    replaceOnce(
      path.join(fixture, "codex", "agents", "stnl_validation_runner.toml"),
      'model = "gpt-5.6-luna"',
      'model = "gpt-5.6-sol"',
    ),
  );
});

test("rejects altered Claude effort", async () => {
  await expectRejectedIntegrations((fixture) =>
    replaceOnce(
      path.join(fixture, "claude-code", "agents", "stnl-validation-runner.md"),
      "effort: medium",
      "effort: high",
    ),
  );
});

for (const [label, before, after] of [
  ["sandbox", 'sandbox_mode = "read-only"', 'sandbox_mode = "workspace-write"'],
  ["approval policy", 'approval_policy = "never"', 'approval_policy = "on-request"'],
  ["web-search permission", 'web_search = "disabled"', 'web_search = "enabled"'],
  ["delegation depth", "max_depth = 1", "max_depth = 2"],
]) {
  test(`rejects altered Codex scout ${label}`, async () => {
    await expectRejectedIntegrations((fixture) =>
      replaceOnce(
        path.join(fixture, "codex", "agents", "stnl_spec_context_scout.toml"),
        before,
        after,
      ),
    );
  });
}

test("rejects an unexpected duplicated agent file inside the agents boundary", async () => {
  await expectRejectedIntegrations(async (fixture) => {
    const agents = path.join(fixture, "codex", "agents");
    await cp(
      path.join(agents, "stnl_validation_runner.toml"),
      path.join(agents, "stnl_validation_runner_copy.toml"),
    );
  });
});
