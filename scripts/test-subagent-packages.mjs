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
const DISTRIBUTION_ROOT = path.join(REPOSITORY_ROOT, "templates", "subagents");
const LEGACY_DIRECTORY = ["context", "scout"].join("-");

const RUNNER_DESCRIPTION =
  "Runner barato e isolado para checks de implementação, checks de findings e validação formal independente de uma slice.";
const SCOUT_DESCRIPTION =
  "Read-only exception scout for one explicitly authorized lifecycle evidence gap; never auto-select or delegate.";
const RUNNER_CONTRACT_SHA256 =
  "9ebacae64041b7510d0fbcdcd3ed431525e4d8f861985072966362e3f793951a";
const SCOUT_CONTRACT_SHA256 =
  "d9119fb83e790db7f18a6090dd3e7ae925bf01de15d6309a201941049c20970d";

const PLATFORMS = {
  codex: {
    directory: "codex",
    ownRoot: ".codex",
    foreignRoot: ".claude",
    files: [
      ".codex/agents/stnl_spec_context_scout.toml",
      ".codex/agents/stnl_validation_runner.toml",
    ],
  },
  "claude-code": {
    directory: "claude-code",
    ownRoot: ".claude",
    foreignRoot: ".codex",
    files: [
      ".claude/agents/stnl-spec-context-scout.md",
      ".claude/agents/stnl-validation-runner.md",
    ],
  },
};

class PackageContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageContractError";
  }
}

function reject(message) {
  throw new PackageContractError(message);
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

async function validateCodexPackage(root) {
  const config = PLATFORMS.codex;
  if (await exists(path.join(root, config.foreignRoot))) {
    reject("Codex package contains Claude files");
  }
  if (await exists(path.join(root, LEGACY_DIRECTORY))) {
    reject("Codex package contains the removed intermediate directory");
  }
  assertExactFiles(await listFiles(root), config.files, "Codex package");

  const runnerPath = path.join(root, ".codex", "agents", "stnl_validation_runner.toml");
  const scoutPath = path.join(root, ".codex", "agents", "stnl_spec_context_scout.toml");
  const runner = parseTomlAdapter(await readFile(runnerPath, "utf8"), "Codex runner");
  const scout = parseTomlAdapter(await readFile(scoutPath, "utf8"), "Codex scout");
  assert.deepEqual(runner.metadata, {
    name: "stnl_validation_runner",
    description: RUNNER_DESCRIPTION,
    model: "gpt-5.4-mini",
    model_reasoning_effort: "medium",
    sandbox_mode: "workspace-write",
    agents: { max_depth: 1 },
  });
  assert.deepEqual(scout.metadata, {
    name: "stnl_spec_context_scout",
    description: SCOUT_DESCRIPTION,
    model: "gpt-5.4-mini",
    model_reasoning_effort: "medium",
    sandbox_mode: "read-only",
    approval_policy: "never",
    web_search: "disabled",
    agents: { max_depth: 1 },
  });
  assertContract(runner.contract, RUNNER_CONTRACT_SHA256, "Codex runner");
  assertContract(scout.contract, SCOUT_CONTRACT_SHA256, "Codex scout");
  return { runner: runner.contract, scout: scout.contract };
}

async function validateClaudePackage(root) {
  const config = PLATFORMS["claude-code"];
  if (await exists(path.join(root, config.foreignRoot))) {
    reject("Claude Code package contains Codex files");
  }
  if (await exists(path.join(root, LEGACY_DIRECTORY))) {
    reject("Claude Code package contains the removed intermediate directory");
  }
  assertExactFiles(await listFiles(root), config.files, "Claude Code package");

  const runnerPath = path.join(root, ".claude", "agents", "stnl-validation-runner.md");
  const scoutPath = path.join(root, ".claude", "agents", "stnl-spec-context-scout.md");
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
  assertContract(runner.contract, RUNNER_CONTRACT_SHA256, "Claude runner");
  assertContract(scout.contract, SCOUT_CONTRACT_SHA256, "Claude scout");
  return { runner: runner.contract, scout: scout.contract };
}

async function validateReadme(root) {
  const readme = await readFile(path.join(root, "README.md"), "utf8");
  const required = [
    "copie somente o conteúdo de `codex/`",
    ".codex/agents/stnl_validation_runner.toml",
    ".codex/agents/stnl_spec_context_scout.toml",
    "copie somente o conteúdo de `claude-code/`",
    ".claude/agents/stnl-validation-runner.md",
    ".claude/agents/stnl-spec-context-scout.md",
    "Uma única cópia instala os dois subagentes da plataforma escolhida.",
    "Nunca copie os adaptadores das duas plataformas para o mesmo projeto",
  ];
  for (const marker of required) {
    assert.ok(readme.includes(marker), `subagent README lacks ${JSON.stringify(marker)}`);
  }
  for (const platform of ["codex", "claude-code"]) {
    const removedReference = `${LEGACY_DIRECTORY}/${platform}/`;
    assert.ok(!readme.includes(removedReference), `subagent README retains ${removedReference}`);
  }
}

async function validateDistribution(root) {
  if (await exists(path.join(root, LEGACY_DIRECTORY))) {
    reject("removed intermediate directory was recreated");
  }
  const expectedFiles = [
    "README.md",
    ...PLATFORMS.codex.files.map((file) => `codex/${file}`),
    ...PLATFORMS["claude-code"].files.map((file) => `claude-code/${file}`),
  ];
  assertExactFiles(await listFiles(root), expectedFiles, "subagent distribution");
  await validateReadme(root);
  const codex = await validateCodexPackage(path.join(root, "codex"));
  const claude = await validateClaudePackage(path.join(root, "claude-code"));
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

async function withDistributionFixture(operation) {
  return withTemporaryDirectory("stnl subagents distribution ", async (temporaryRoot) => {
    const fixture = path.join(temporaryRoot, "distribution with spaces");
    await cp(DISTRIBUTION_ROOT, fixture, { recursive: true });
    return operation(fixture);
  });
}

async function withPlatformFixture(platform, operation) {
  return withTemporaryDirectory(`stnl ${platform} package `, async (temporaryRoot) => {
    const fixture = path.join(temporaryRoot, "consumer project with spaces");
    await cp(path.join(DISTRIBUTION_ROOT, PLATFORMS[platform].directory), fixture, {
      recursive: true,
    });
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

async function expectRejectedDistribution(mutate) {
  await withDistributionFixture(async (fixture) => {
    await mutate(fixture);
    await assert.rejects(() => validateDistribution(fixture));
  });
}

test("canonical distribution contains exactly two complete platform bundles", async () => {
  await validateDistribution(DISTRIBUTION_ROOT);
});

test("Codex installs both agents from only the Codex folder", async () => {
  await withPlatformFixture("codex", validateCodexPackage);
});

test("Claude Code installs both agents from only the Claude Code folder", async () => {
  await withPlatformFixture("claude-code", validateClaudePackage);
});

test("rejects a Codex bundle missing its scout", async () => {
  await expectRejectedDistribution((fixture) =>
    rm(path.join(fixture, "codex", ".codex", "agents", "stnl_spec_context_scout.toml")),
  );
});

test("rejects a Claude Code bundle missing its runner", async () => {
  await expectRejectedDistribution((fixture) =>
    rm(path.join(fixture, "claude-code", ".claude", "agents", "stnl-validation-runner.md")),
  );
});

test("rejects an agent moved to the wrong directory", async () => {
  await expectRejectedDistribution(async (fixture) => {
    const source = path.join(fixture, "codex", ".codex", "agents", "stnl_spec_context_scout.toml");
    const destination = path.join(fixture, "codex", ".codex", "stnl_spec_context_scout.toml");
    await rename(source, destination);
  });
});

test("rejects an agent file with the wrong installed name", async () => {
  await expectRejectedDistribution(async (fixture) => {
    const agents = path.join(fixture, "claude-code", ".claude", "agents");
    await rename(
      path.join(agents, "stnl-spec-context-scout.md"),
      path.join(agents, "stnl_spec_context_scout.md"),
    );
  });
});

test("rejects an altered internal agent identity", async () => {
  await expectRejectedDistribution((fixture) =>
    replaceOnce(
      path.join(fixture, "codex", ".codex", "agents", "stnl_validation_runner.toml"),
      'name = "stnl_validation_runner"',
      'name = "other_runner"',
    ),
  );
});

test("rejects a package mixing platform adapters", async () => {
  await withPlatformFixture("codex", async (fixture) => {
    const foreignDirectory = path.join(fixture, ".claude", "agents");
    await mkdir(foreignDirectory, { recursive: true });
    await cp(
      path.join(
        DISTRIBUTION_ROOT,
        "claude-code",
        ".claude",
        "agents",
        "stnl-validation-runner.md",
      ),
      path.join(foreignDirectory, "stnl-validation-runner.md"),
    );
    await assert.rejects(() => validateCodexPackage(fixture));
  });
});

test("rejects recreation of the removed intermediate directory", async () => {
  await expectRejectedDistribution((fixture) =>
    mkdir(path.join(fixture, LEGACY_DIRECTORY, "codex"), { recursive: true }),
  );
});

test("rejects documentation pointing to the removed package layout", async () => {
  await expectRejectedDistribution(async (fixture) => {
    const readme = path.join(fixture, "README.md");
    const text = await readFile(readme, "utf8");
    await writeFile(
      readme,
      `${text}\nCopie o conteúdo de \`${LEGACY_DIRECTORY}/codex/\`.\n`,
      "utf8",
    );
  });
});

test("rejects a modified complete contract body", async () => {
  await expectRejectedDistribution((fixture) =>
    replaceOnce(
      path.join(fixture, "codex", ".codex", "agents", "stnl_spec_context_scout.toml"),
      "Search and inspect; do not decide, design, plan, mutate, or persist.",
      "Search and inspect; you may decide and persist.",
    ),
  );
});

test("rejects altered Claude tools", async () => {
  await expectRejectedDistribution((fixture) =>
    replaceOnce(
      path.join(fixture, "claude-code", ".claude", "agents", "stnl-spec-context-scout.md"),
      "tools: Read, Glob, Grep",
      "tools: Read, Glob, Grep, Bash",
    ),
  );
});

test("rejects an altered Codex model", async () => {
  await expectRejectedDistribution((fixture) =>
    replaceOnce(
      path.join(fixture, "codex", ".codex", "agents", "stnl_validation_runner.toml"),
      'model = "gpt-5.4-mini"',
      'model = "gpt-5.4"',
    ),
  );
});

test("rejects altered Claude effort", async () => {
  await expectRejectedDistribution((fixture) =>
    replaceOnce(
      path.join(fixture, "claude-code", ".claude", "agents", "stnl-validation-runner.md"),
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
    await expectRejectedDistribution((fixture) =>
      replaceOnce(
        path.join(fixture, "codex", ".codex", "agents", "stnl_spec_context_scout.toml"),
        before,
        after,
      ),
    );
  });
}

test("rejects duplicated agents", async () => {
  await expectRejectedDistribution(async (fixture) => {
    const agents = path.join(fixture, "codex", ".codex", "agents");
    await cp(
      path.join(agents, "stnl_validation_runner.toml"),
      path.join(agents, "stnl_validation_runner_copy.toml"),
    );
  });
});
