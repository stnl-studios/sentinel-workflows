#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ValidationError,
  resumeWorkspaceIdentity,
  validateCloseTransition,
  validateInitTransition,
  validateReadinessTransition,
  validateResumeTransition,
  validateWorkspace,
  workspaceSnapshot,
} from "../skills/stnl-spec-lifecycle-manager/runtime/lib/lifecycle.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(
  ROOT,
  "skills",
  "stnl-spec-lifecycle-manager",
  "examples",
  "validator-fixtures",
);
const VALIDATOR = path.join(
  ROOT,
  "skills",
  "stnl-spec-lifecycle-manager",
  "runtime",
  "validate-spec-lifecycle.mjs",
);

const OPTIONAL_SYMLINK_ERRORS = new Set([
  "EPERM",
  "EACCES",
  "ENOTSUP",
  "EOPNOTSUPP",
  "UNKNOWN",
]);
const OPTIONAL_HARDLINK_ERRORS = new Set([...OPTIONAL_SYMLINK_ERRORS, "EXDEV"]);

// Mapping from the predecessor regression contract to its current evidence.
// `existing` names scenarios already exercised by the catalog/contract suites;
// every ID under `adversarial` is registered in this file. Keeping this list
// explicit prevents a future migration from silently collapsing negative cases.
const REGRESSION_MAPPING = Object.freeze({
  existing: Object.freeze([
    "69 catalog cases and 61 static policy fixtures",
    "coverage matrix: verifies, missing targets, non-requirements, out-of-scope and stale justification",
    "relationship matrix: inverse links, resolved blockers and question classification",
    "root/category symlink and authority hardlink rejection",
    "READINESS external hardlink mutation and all-mode no-mutation checks",
    "canonical CLI modes, help, delimiter, equals and repeated-last-wins grammar",
  ]),
  adversarial: Object.freeze([
    "workspace-bom-rejected",
    "workspace-structural-grammar-matrix",
    "workspace-retirement-reason-matrix",
    "workspace-status-tombstone-matrix",
    "workspace-material-unicode-retirement-valid",
    "resume-authorized-change-matrix",
    "resume-unauthorized-change-matrix",
    "resume-manifest-strict-schema-matrix",
    "resume-manifest-authority-matrix",
    "resume-path-and-alias-matrix",
    "resume-preservation-and-id-matrix",
    "resume-category-tombstone-matrix",
    "transition-external-filesystem-matrix",
    "readiness-scope-and-topology-matrix",
    "close-structural-and-identity-matrix",
    "close-invented-category-matrix",
    "validator-cli-negative-token-values",
  ]),
});

const registeredCases = new Set();

function contractTest(name, operation) {
  assert(!registeredCases.has(name), `duplicate adversarial case registration: ${name}`);
  registeredCases.add(name);
  test(name, operation);
}

function temporary(t, prefix = "stnl lifecycle adversarial ") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function copyFixture(base, fixture, name) {
  const destination = path.join(base, name);
  fs.cpSync(path.join(FIXTURES, fixture), destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  return destination;
}

function replaceOnce(file, before, after) {
  const source = fs.readFileSync(file, "utf8");
  assert(source.includes(before), `${file}: missing mutation source ${JSON.stringify(before)}`);
  fs.writeFileSync(file, source.replace(before, after), "utf8");
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function rawTreeSnapshot(root) {
  const result = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = fs.lstatSync(absolute);
      if (metadata.isSymbolicLink()) {
        result.push([relative, "symlink", fs.readlinkSync(absolute)]);
      } else if (metadata.isDirectory()) {
        result.push([relative, "directory", ""]);
        visit(absolute);
      } else if (metadata.isFile()) {
        result.push([relative, "file", fs.readFileSync(absolute).toString("base64")]);
      } else {
        result.push([relative, "special", `${metadata.mode}:${metadata.size}`]);
      }
    }
  }
  visit(root);
  return result;
}

function expectValidationError(action, diagnostic = null) {
  assert.throws(action, (error) => {
    assert(error instanceof ValidationError || error instanceof Error);
    return diagnostic === null || error.message.includes(diagnostic);
  });
}

function createSymlinkOrSkip(t, target, link, type = "file") {
  try {
    fs.symlinkSync(target, link, process.platform === "win32" ? type : undefined);
    return true;
  } catch (error) {
    if (OPTIONAL_SYMLINK_ERRORS.has(error?.code)) {
      t.skip(`symlinks unavailable on this filesystem (${error.code})`);
      return false;
    }
    throw error;
  }
}

function createHardlinkOrSkip(t, source, link) {
  try {
    fs.linkSync(source, link);
    return true;
  } catch (error) {
    if (OPTIONAL_HARDLINK_ERRORS.has(error?.code)) {
      t.skip(`hardlinks unavailable on this filesystem (${error.code})`);
      return false;
    }
    throw error;
  }
}

async function listenUnixSocketOrSkip(t, server, socket) {
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    return true;
  } catch (error) {
    if (OPTIONAL_SYMLINK_ERRORS.has(error?.code)) {
      t.skip(`Unix-domain sockets unavailable in this environment (${error.code})`);
      return false;
    }
    throw error;
  }
}

function appendClonedRecord(workspace, filename, sourceId, destinationId) {
  const file = path.join(workspace, "shared", filename);
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf(`### ${sourceId} —`);
  assert.notEqual(start, -1, `${filename}: missing ${sourceId}`);
  const next = text.indexOf("\n### ", start + 1);
  const blockEnd = next < 0 ? text.length : next;
  const block = text.slice(start, blockEnd).trimEnd().replaceAll(sourceId, destinationId);
  fs.writeFileSync(file, `${text.trimEnd()}\n\n${block}\n`, "utf8");
  if (destinationId.startsWith("R-")) {
    const feature = path.join(workspace, "feature_spec.md");
    const current = fs.readFileSync(feature, "utf8");
    const requirementBlock = current.match(/^- R-[0-9]{3}(?:\n- R-[0-9]{3})*/mu);
    assert(requirementBlock, "feature requirement index is missing");
    const ids = [
      ...requirementBlock[0].split("\n").map((line) => line.slice(2)),
      destinationId,
    ].sort();
    fs.writeFileSync(feature, current.replace(requirementBlock[0], ids.map((id) => `- ${id}`).join("\n")), "utf8");
  }
}

function removeRecord(workspace, filename, identifier) {
  const file = path.join(workspace, "shared", filename);
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf(`### ${identifier} —`);
  assert.notEqual(start, -1, `${filename}: missing ${identifier}`);
  const next = text.indexOf("\n### ", start + 1);
  const output = `${text.slice(0, start).trimEnd()}\n${next < 0 ? "" : `\n${text.slice(next + 1)}`}`;
  fs.writeFileSync(file, output, "utf8");
  if (identifier.startsWith("R-")) {
    const feature = path.join(workspace, "feature_spec.md");
    replaceOnce(feature, `- ${identifier}\n`, "");
  }
}

function retireRecord(workspace, filename, identifier, from, reason = "The record is no longer applicable, but its canonical identity remains reserved.") {
  const file = path.join(workspace, "shared", filename);
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf(`### ${identifier} —`);
  assert.notEqual(start, -1, `${filename}: missing ${identifier}`);
  const next = text.indexOf("\n### ", start + 1);
  const end = next < 0 ? text.length : next;
  const block = text.slice(start, end);
  assert(block.includes(`- status: ${from}`), `${identifier}: missing source status ${from}`);
  const replacement = block.replace(
    `- status: ${from}`,
    `- status: retired\n- retired_reason: ${reason}`,
  );
  fs.writeFileSync(file, `${text.slice(0, start)}${replacement}${text.slice(end)}`, "utf8");
}

function replaceInRecord(workspace, filename, identifier, before, after) {
  const file = path.join(workspace, "shared", filename);
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf(`### ${identifier} —`);
  assert.notEqual(start, -1, `${filename}: missing ${identifier}`);
  const next = text.indexOf("\n### ", start + 1);
  const end = next < 0 ? text.length : next;
  const block = text.slice(start, end);
  assert(block.includes(before), `${identifier}: missing record mutation source ${JSON.stringify(before)}`);
  fs.writeFileSync(file, `${text.slice(0, start)}${block.replace(before, after)}${text.slice(end)}`, "utf8");
}

function resumeManifestPayload(before, options = {}) {
  const workspace = validateWorkspace(before);
  return {
    schema_version: 1,
    mode: "RESUME",
    workspace_identity: {
      h1: workspace.h1,
      pre_state_sha256: resumeWorkspaceIdentity(before),
    },
    allowed_feature_sections: options.featureSections ?? [],
    allowed_existing_ids: options.existingIds ?? [],
    allowed_new_ids: options.newIds ?? [],
    allowed_status_transitions: (options.statusTransitions ?? []).map(([target, from, to]) => ({
      path: target,
      from,
      to,
    })),
    allowed_record_status_transitions: (options.recordStatusTransitions ?? []).map(
      ([target, id, from, to]) => ({ path: target, id, from, to }),
    ),
  };
}

function writeResumeManifest(file, before, options = {}) {
  const payload = resumeManifestPayload(before, options);
  options.mutate?.(payload);
  write(file, `${JSON.stringify(payload)}\n`);
  return file;
}

function resumeFixture(t, options = {}) {
  const base = temporary(t, "stnl resume adversarial ");
  const before = copyFixture(base, "ready", "before");
  options.prepareBefore?.(before);
  validateWorkspace(before);
  const after = path.join(base, "after");
  fs.cpSync(before, after, { recursive: true, dereference: false });
  options.mutateAfter?.(after);
  let manifest = path.join(base, "resume-manifest.json");
  if (options.manifestIn === "before") manifest = path.join(before, "resume-manifest.json");
  if (options.manifestIn === "after") manifest = path.join(after, "resume-manifest.json");
  if (options.missingManifest) manifest = null;
  else if (options.rawManifest !== undefined) write(manifest, options.rawManifest);
  else writeResumeManifest(manifest, before, options.manifest ?? {});
  return { base, before, after, manifest };
}

function assertResumeFailure(t, options, diagnostic) {
  const fixture = resumeFixture(t, options);
  const beforeSnapshot = rawTreeSnapshot(fixture.before);
  const afterSnapshot = rawTreeSnapshot(fixture.after);
  const manifestBytes = fixture.manifest === null ? null : fs.readFileSync(fixture.manifest);
  expectValidationError(
    () => validateResumeTransition(fixture.before, fixture.after, fixture.manifest),
    diagnostic,
  );
  assert.deepEqual(rawTreeSnapshot(fixture.before), beforeSnapshot, "failed RESUME mutated source");
  assert.deepEqual(rawTreeSnapshot(fixture.after), afterSnapshot, "failed RESUME mutated candidate");
  if (fixture.manifest !== null) {
    assert.deepEqual(fs.readFileSync(fixture.manifest), manifestBytes, "failed RESUME mutated manifest");
  }
  return fixture;
}

function appendClosedClone(workspace, section, sourceId, destinationId) {
  const feature = path.join(workspace, "feature_spec.md");
  const text = fs.readFileSync(feature, "utf8");
  const sectionStart = text.indexOf(`## ${section}\n`);
  assert.notEqual(sectionStart, -1, `closed section missing: ${section}`);
  const sectionEndCandidate = text.indexOf("\n## ", sectionStart + 4);
  const sectionEnd = sectionEndCandidate < 0 ? text.length : sectionEndCandidate;
  const start = text.indexOf(`### ${sourceId} —`, sectionStart);
  assert(start >= sectionStart && start < sectionEnd, `${sourceId} missing from ${section}`);
  const nextRecord = text.indexOf("\n### ", start + 1);
  const blockEnd = nextRecord >= 0 && nextRecord < sectionEnd ? nextRecord : sectionEnd;
  const block = text.slice(start, blockEnd).trimEnd().replaceAll(sourceId, destinationId);
  fs.writeFileSync(
    feature,
    `${text.slice(0, sectionEnd).trimEnd()}\n\n${block}\n${text.slice(sectionEnd).replace(/^\n/u, "")}`,
    "utf8",
  );
}

function replaceInClosedRecord(workspace, identifier, before, after) {
  const feature = path.join(workspace, "feature_spec.md");
  const text = fs.readFileSync(feature, "utf8");
  const start = text.indexOf(`### ${identifier} —`);
  assert.notEqual(start, -1, `closed feature: missing ${identifier}`);
  const nextRecord = text.indexOf("\n### ", start + 1);
  const nextSection = text.indexOf("\n## ", start + 1);
  const candidates = [nextRecord, nextSection].filter((offset) => offset >= 0);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  const block = text.slice(start, end);
  assert(block.includes(before), `${identifier}: missing closed record mutation source ${JSON.stringify(before)}`);
  fs.writeFileSync(feature, `${text.slice(0, start)}${block.replace(before, after)}${text.slice(end)}`, "utf8");
}

contractTest("regression-mapping-is-explicit-and-complete", () => {
  assert(REGRESSION_MAPPING.existing.length > 0);
  assert.deepEqual(
    [...REGRESSION_MAPPING.adversarial].sort(),
    [...registeredCases].filter((name) => name !== "regression-mapping-is-explicit-and-complete").sort(),
  );
});

contractTest("workspace-bom-rejected", (t) => {
  const base = temporary(t, "stnl workspace bom ");
  const workspace = copyFixture(base, "ready", "workspace");
  const feature = path.join(workspace, "feature_spec.md");
  fs.writeFileSync(feature, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(feature)]));
  expectValidationError(() => validateWorkspace(workspace), "missing normalized File Purpose Header");
});

contractTest("workspace-structural-grammar-matrix", async (t) => {
  const cases = [
    {
      name: "active-h1-missing",
      mutate(root) { replaceOnce(path.join(root, "feature_spec.md"), "# Fixture Feature - Feature SPEC\n\n", ""); },
      diagnostic: "canonical '# <name> - Feature SPEC' H1",
    },
    {
      name: "file-purpose-header-placeholder",
      mutate(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "purpose: Template for an active documentary feature SPEC.",
          "purpose: {{CONTENT}}",
        );
      },
      diagnostic: "placeholder content",
    },
    {
      name: "active-arbitrary-preamble",
      mutate(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "# Fixture Feature - Feature SPEC",
          "Arbitrary repository preamble.\n\n# Fixture Feature - Feature SPEC",
        );
      },
      diagnostic: "canonical '# <name> - Feature SPEC' H1",
    },
    {
      name: "active-duplicate-section",
      mutate(root) {
        const file = path.join(root, "feature_spec.md");
        fs.appendFileSync(file, "\n## Objective\n\nDuplicate authority.\n");
      },
      diagnostic: "duplicate section 'Objective'",
    },
    {
      name: "active-section-out-of-order",
      mutate(root) {
        const file = path.join(root, "feature_spec.md");
        let text = fs.readFileSync(file, "utf8");
        text = text.replace("## Objective", "## __TEMP__");
        text = text.replace("## Context", "## Objective");
        text = text.replace("## __TEMP__", "## Context");
        fs.writeFileSync(file, text);
      },
      diagnostic: "out of order",
    },
    {
      name: "active-unexpected-section",
      mutate(root) { fs.appendFileSync(path.join(root, "feature_spec.md"), "\n## Notes\n\nCompeting authority.\n"); },
      diagnostic: "active feature sections must be exactly",
    },
    {
      name: "active-unexpected-nested-heading",
      mutate(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "## Objective\n\nProvide deterministic",
          "## Objective\n\n#### Unexpected subsection\n\nProvide deterministic",
        );
      },
      diagnostic: "level-4 through level-6",
    },
    {
      name: "persisted-broken-references-forbidden",
      mutate(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "blocking_questions: []\n",
          "blocking_questions: []\nbroken_references: []\n",
        );
      },
      diagnostic: "documentary_gaps",
    },
    {
      name: "multiple-metadata-separators",
      mutate(root) {
        replaceOnce(
          path.join(root, "shared", "requirements.md"),
          "- status: in_scope\n\nAn invitation",
          "- status: in_scope\n\n\nAn invitation",
        );
      },
      diagnostic: "exactly one blank line",
    },
    {
      name: "requirement-nested-heading",
      mutate(root) {
        replaceOnce(
          path.join(root, "shared", "requirements.md"),
          "An invitation past `expires_at`",
          "#### Unexpected subsection\n\nAn invitation past `expires_at`",
        );
      },
      diagnostic: "narrative cannot contain nested headings",
    },
    {
      name: "empty-shared-directory",
      mutate(root) {
        fs.rmSync(path.join(root, "shared"), { recursive: true });
        fs.mkdirSync(path.join(root, "shared"));
        const feature = path.join(root, "feature_spec.md");
        let text = fs.readFileSync(feature, "utf8");
        text = text.replace(/artifacts:\n(?:  .*\n)+/u, "artifacts: {}\n");
        text = text.replace(/^- R-001$/mu, "- Not established.");
        text = text.replace("status: ready", "status: draft");
        fs.writeFileSync(feature, text);
      },
      diagnostic: "empty shared/ directory must be absent",
    },
    {
      name: "feature-must-be-regular",
      mutate(root) {
        fs.rmSync(path.join(root, "feature_spec.md"));
        fs.mkdirSync(path.join(root, "feature_spec.md"));
      },
      diagnostic: "real regular file",
    },
    {
      name: "malformed-utf8",
      mutate(root) { fs.writeFileSync(path.join(root, "feature_spec.md"), Buffer.from([0xff, 0xfe, 0xfd])); },
      diagnostic: null,
    },
  ];

  for (const case_ of cases) {
    await t.test(case_.name, () => {
      const base = temporary(t, `stnl workspace grammar ${case_.name} `);
      const workspace = copyFixture(base, "ready", "workspace");
      case_.mutate(workspace);
      const before = rawTreeSnapshot(workspace);
      expectValidationError(() => validateWorkspace(workspace), case_.diagnostic);
      assert.deepEqual(rawTreeSnapshot(workspace), before, `${case_.name}: validation mutated input`);
    });
  }

  await t.test("feature special filesystem entry", async (st) => {
    if (process.platform === "win32") {
      st.skip("Windows named pipes do not materialize as filesystem entries");
      return;
    }
    const base = temporary(st, "stnl socket ");
    const workspace = copyFixture(base, "ready", "workspace");
    const feature = path.join(workspace, "feature_spec.md");
    fs.rmSync(feature);
    const server = net.createServer();
    if (!await listenUnixSocketOrSkip(st, server, feature)) return;
    try {
      expectValidationError(() => validateWorkspace(workspace), "real regular file");
      assert(fs.lstatSync(feature).isSocket());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test("empty shared directory is rejected", () => {
    const base = temporary(t, "stnl empty shared ");
    const workspace = copyFixture(base, "ready", "workspace");
    const feature = path.join(workspace, "feature_spec.md");
    replaceOnce(feature, "status: ready", "status: draft");
    replaceOnce(feature, "- R-001", "- Not established.");
    replaceOnce(
      feature,
      [
        "artifacts:",
        "  requirements: shared/requirements.md",
        "  acceptance_criteria: shared/acceptance-criteria.md",
        "  decisions: shared/decisions.md",
        "  constraints: shared/constraints.md",
        "  risks: shared/risks.md",
        "  questions: shared/questions.md",
      ].join("\n"),
      "artifacts: {}",
    );
    for (const name of fs.readdirSync(path.join(workspace, "shared"))) {
      fs.rmSync(path.join(workspace, "shared", name));
    }
    const before = rawTreeSnapshot(workspace);
    expectValidationError(() => validateWorkspace(workspace), "empty shared/ directory must be absent");
    assert.deepEqual(rawTreeSnapshot(workspace), before);
  });
});

contractTest("workspace-retirement-reason-matrix", async (t) => {
  const sources = [
    ["requirements.md", "R-001", "in_scope"],
    ["acceptance-criteria.md", "AC-001", "active"],
    ["decisions.md", "D-001", "accepted"],
    ["constraints.md", "C-001", "active"],
    ["risks.md", "RK-001", "active"],
  ];
  const placeholders = [
    "...",
    "TBD.",
    "  tBd.  ",
    "TODO: later",
    "To be determined.",
    "To be defined after review.",
    "A definir.",
    "N/A.",
    "Retired.",
    "RETIRADO!",
    "ReMoViDo.",
    "excluído",
    "EXCLUIDO!",
    "removed.",
    "deleted!",
    "unknown?",
    "{{CONTENT}}",
  ];

  for (const [filename, identifier, from] of sources) {
    await t.test(`${identifier} requires a reason`, () => {
      const base = temporary(t, `stnl missing retirement ${identifier} `);
      const workspace = copyFixture(base, "ready", "workspace");
      replaceOnce(path.join(workspace, "shared", filename), `- status: ${from}`, "- status: retired");
      expectValidationError(() => validateWorkspace(workspace), "non-placeholder retired_reason");
    });
    await t.test(`${identifier} rejects placeholder reason`, () => {
      const base = temporary(t, `stnl placeholder retirement ${identifier} `);
      const workspace = copyFixture(base, "ready", "workspace");
      replaceOnce(
        path.join(workspace, "shared", filename),
        `- status: ${from}`,
        "- status: retired\n- retired_reason: TBD",
      );
      expectValidationError(() => validateWorkspace(workspace), "non-placeholder retired_reason");
    });
  }

  for (const [index, reason] of placeholders.entries()) {
    await t.test(`placeholder alias ${index + 1}: ${reason.trim()}`, () => {
      const base = temporary(t, `stnl retirement alias ${index} `);
      const workspace = copyFixture(base, "ready", "workspace");
      appendClonedRecord(workspace, "requirements.md", "R-001", "R-002");
      retireRecord(workspace, "requirements.md", "R-002", "in_scope", reason);
      expectValidationError(() => validateWorkspace(workspace), reason === "{{CONTENT}}" ? "placeholder content" : "non-placeholder retired_reason");
    });
  }

  await t.test("retired_reason is forbidden on active records", () => {
    const base = temporary(t, "stnl active retirement reason ");
    const workspace = copyFixture(base, "ready", "workspace");
    replaceOnce(
      path.join(workspace, "shared", "requirements.md"),
      "- status: in_scope",
      "- status: in_scope\n- retired_reason: This must not exist on an active record.",
    );
    expectValidationError(() => validateWorkspace(workspace), "allowed only for retired records");
  });
});

contractTest("workspace-status-tombstone-matrix", async (t) => {
  const sources = [
    ["requirements.md", "in_scope"],
    ["acceptance-criteria.md", "active"],
    ["decisions.md", "accepted"],
    ["constraints.md", "active"],
    ["risks.md", "active"],
    ["questions.md", "resolved"],
  ];
  for (const [filename, status] of sources) {
    for (const forbidden of ["deleted", "removed", "unknown"]) {
      await t.test(`${filename} rejects status ${forbidden}`, () => {
        const base = temporary(t, `stnl forbidden status ${forbidden} `);
        const workspace = copyFixture(base, "ready", "workspace");
        replaceOnce(path.join(workspace, "shared", filename), `- status: ${status}`, `- status: ${forbidden}`);
        expectValidationError(() => validateWorkspace(workspace), "invalid status");
      });
    }
  }
  await t.test("questions reject generic retired state", () => {
    const base = temporary(t, "stnl retired question ");
    const workspace = copyFixture(base, "ready", "workspace");
    replaceOnce(path.join(workspace, "shared", "questions.md"), "- status: resolved", "- status: retired");
    expectValidationError(() => validateWorkspace(workspace), "invalid status");
  });
});

contractTest("workspace-material-unicode-retirement-valid", (t) => {
  const base = temporary(t, "stnl unicode retirement ");
  const workspace = copyFixture(base, "ready", "workspace");
  appendClonedRecord(workspace, "requirements.md", "R-001", "R-002");
  // Change only R-002's state by targeting its block directly.
  const requirements = path.join(workspace, "shared", "requirements.md");
  let text = fs.readFileSync(requirements, "utf8");
  const start = text.indexOf("### R-002 —");
  const block = text.slice(start).replace("- status: in_scope", "- status: out_of_scope");
  fs.writeFileSync(requirements, `${text.slice(0, start)}${block}`);
  retireRecord(
    workspace,
    "requirements.md",
    "R-002",
    "out_of_scope",
    "新しい仕様がこの要件を恒久的に置き換えました。",
  );
  const validated = validateWorkspace(workspace);
  assert.equal(validated.items.get("R-002").metadata.get("status"), "retired");
});

contractTest("resume-authorized-change-matrix", async (t) => {
  const cases = [
    {
      name: "acceptance criterion body",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "shared", "acceptance-criteria.md"),
          "Ao receber um convite cujo `expires_at` já passou",
          "Ao receber repetidamente um convite cujo `expires_at` já passou",
        );
      },
      manifest: { existingIds: ["AC-001"] },
    },
    {
      name: "feature objective",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "Provide deterministic invitation expiration behavior.",
          "Provide deterministic and auditable invitation expiration behavior.",
        );
      },
      manifest: { featureSections: ["Objective"] },
    },
    {
      name: "new next requirement",
      mutateAfter(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      manifest: { featureSections: ["Requirements"], newIds: ["R-002"] },
    },
    {
      name: "feature header status",
      mutateAfter(root) { replaceOnce(path.join(root, "feature_spec.md"), "status: ready", "status: draft"); },
      manifest: { statusTransitions: [["feature_spec.md", "ready", "draft"]] },
    },
    {
      name: "record terminal status",
      prepareBefore(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      mutateAfter(root) {
        replaceInRecord(root, "requirements.md", "R-002", "- status: out_of_scope", "- status: superseded");
      },
      manifest: {
        existingIds: ["R-002"],
        recordStatusTransitions: [["shared/requirements.md", "R-002", "out_of_scope", "superseded"]],
      },
    },
    {
      name: "record retirement",
      prepareBefore(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      mutateAfter(root) { retireRecord(root, "requirements.md", "R-002", "out_of_scope"); },
      manifest: {
        existingIds: ["R-002"],
        recordStatusTransitions: [["shared/requirements.md", "R-002", "out_of_scope", "retired"]],
      },
    },
    {
      name: "combined minimal authorization",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "Provide deterministic invitation expiration behavior.",
          "Provide deterministic and auditable invitation expiration behavior.",
        );
        replaceOnce(
          path.join(root, "shared", "requirements.md"),
          "according to the service UTC clock",
          "according to the authoritative service UTC clock",
        );
        replaceOnce(
          path.join(root, "shared", "acceptance-criteria.md"),
          "Ao receber um convite",
          "Ao receber repetidamente um convite",
        );
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      manifest: {
        featureSections: ["Objective", "Requirements"],
        existingIds: ["R-001", "AC-001"],
        newIds: ["R-002"],
      },
    },
  ];

  for (const case_ of cases) {
    await t.test(case_.name, () => {
      const fixture = resumeFixture(t, case_);
      const beforeSnapshot = rawTreeSnapshot(fixture.before);
      const afterSnapshot = rawTreeSnapshot(fixture.after);
      const [source, candidate] = validateResumeTransition(fixture.before, fixture.after, fixture.manifest);
      assert.equal(source.root, fs.realpathSync(fixture.before));
      assert.equal(candidate.root, fs.realpathSync(fixture.after));
      assert.deepEqual(rawTreeSnapshot(fixture.before), beforeSnapshot);
      assert.deepEqual(rawTreeSnapshot(fixture.after), afterSnapshot);
    });
  }
});

contractTest("resume-unauthorized-change-matrix", async (t) => {
  const cases = [
    {
      name: "decision rewrite",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "shared", "decisions.md"),
          "All clients observe one deterministic expiration decision.",
          "Clients observe an unrelated replacement decision.",
        );
      },
      diagnostic: "allowed_existing_ids",
    },
    {
      name: "acceptance rewrite",
      mutateAfter(root) {
        replaceOnce(path.join(root, "shared", "acceptance-criteria.md"), "Ao receber um convite", "Ao receber repetidamente um convite");
      },
      diagnostic: "allowed_existing_ids",
    },
    {
      name: "scope rewrite",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "Reject acceptance after the stored expiration timestamp.",
          "Reject acceptance and renewal after the stored expiration timestamp.",
        );
      },
      diagnostic: "allowed_feature_sections",
    },
    {
      name: "metadata rewrite",
      mutateAfter(root) { replaceOnce(path.join(root, "shared", "risks.md"), "- impact: medium", "- impact: low"); },
      diagnostic: "allowed_existing_ids",
    },
    {
      name: "reference rewrite",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "shared", "acceptance-criteria.md"),
          "- references: [D-001, C-001, RK-001]",
          "- references: [D-001, C-001]",
        );
      },
      diagnostic: "allowed_existing_ids",
    },
    {
      name: "undeclared feature header transition",
      mutateAfter(root) { replaceOnce(path.join(root, "feature_spec.md"), "status: ready", "status: draft"); },
      diagnostic: "allowed_status_transitions",
    },
    {
      name: "undeclared record status transition",
      prepareBefore(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      mutateAfter(root) {
        replaceInRecord(root, "requirements.md", "R-002", "- status: out_of_scope", "- status: superseded");
      },
      manifest: { existingIds: ["R-002"] },
      diagnostic: "allowed_record_status_transitions",
    },
    {
      name: "terminal record status reversal",
      prepareBefore(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: superseded");
      },
      mutateAfter(root) {
        replaceInRecord(root, "requirements.md", "R-002", "- status: superseded", "- status: out_of_scope");
      },
      manifest: {
        existingIds: ["R-002"],
        recordStatusTransitions: [["shared/requirements.md", "R-002", "superseded", "out_of_scope"]],
      },
      diagnostic: "is not permitted",
    },
    {
      name: "undeclared addition",
      mutateAfter(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      manifest: { featureSections: ["Requirements"] },
      diagnostic: "allowed_new_ids",
    },
    {
      name: "header metadata rewrite",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "shared", "requirements.md"),
          "purpose: Template for materialized canonical feature requirements.",
          "purpose: Rewritten authority for materialized canonical feature requirements.",
        );
      },
      diagnostic: "File Purpose Header bytes",
    },
  ];

  for (const case_ of cases) {
    await t.test(case_.name, () => {
      assertResumeFailure(t, case_, case_.diagnostic);
    });
  }
});

contractTest("resume-manifest-strict-schema-matrix", async (t) => {
  const mutations = [
    ["wildcard feature authority", (value) => { value.allowed_feature_sections = ["*"]; }, "unknown or generic feature sections"],
    ["all feature authority", (value) => { value.allowed_feature_sections = ["all"]; }, "unknown or generic feature sections"],
    ["generic ID prefix", (value) => { value.allowed_existing_ids = ["R"]; }, "generic authorization"],
    ["duplicate ID", (value) => { value.allowed_existing_ids = ["R-001", "R-001"]; }, "duplicate entries"],
    ["duplicate authority classes", (value) => { value.allowed_existing_ids = ["R-001"]; value.allowed_new_ids = ["R-001"]; }, "duplicate authority"],
    ["unknown root field", (value) => { value.allow_all = true; }, "unknown=['allow_all']"],
    ["wrong mode", (value) => { value.mode = "INIT"; }, "mode must be exactly 'RESUME'"],
    ["legacy removal authority", (value) => { value.allowed_removed_ids = ["R-002"]; }, "unknown=['allowed_removed_ids']"],
    ["wrong H1", (value) => { value.workspace_identity.h1 = "# Another Feature - Feature SPEC"; }, "workspace H1 does not match"],
    ["boolean schema version", (value) => { value.schema_version = true; }, "schema_version must be 1"],
    ["missing field", (value) => { delete value.allowed_new_ids; }, "missing=['allowed_new_ids']"],
    ["feature sections out of order", (value) => { value.allowed_feature_sections = ["Scope", "Objective"]; }, "canonical feature section order"],
    ["IDs out of canonical order", (value) => { value.allowed_existing_ids = ["AC-001", "R-001"]; }, "canonical ID order"],
    ["duplicate status target", (value) => {
      value.allowed_status_transitions = [
        { path: "feature_spec.md", from: "ready", to: "draft" },
        { path: "feature_spec.md", from: "ready", to: "blocked" },
      ];
    }, "duplicate paths"],
    ["record transition lacks ID authority", (value) => {
      value.allowed_record_status_transitions = [
        { path: "shared/requirements.md", id: "R-001", from: "in_scope", to: "superseded" },
      ];
    }, "also require allowed_existing_ids"],
    ["status traversal", (value) => {
      value.allowed_status_transitions = [{ path: "../execution/owned.md", from: "ready", to: "draft" }];
    }, "without traversal"],
    ["direct external path", (value) => {
      value.allowed_status_transitions = [{ path: "execution/owned.md", from: "ready", to: "draft" }];
    }, "without traversal"],
    ["record traversal", (value) => {
      value.allowed_record_status_transitions = [
        { path: "shared/../execution.md", id: "R-001", from: "in_scope", to: "superseded" },
      ];
    }, "without traversal"],
    ["record path type mismatch", (value) => {
      value.allowed_existing_ids = ["R-001"];
      value.allowed_record_status_transitions = [
        { path: "shared/risks.md", id: "R-001", from: "in_scope", to: "superseded" },
      ];
    }, "incompatible with R-001"],
  ];

  for (const [name, mutate, diagnostic] of mutations) {
    await t.test(name, () => {
      assertResumeFailure(t, { manifest: { mutate } }, diagnostic);
    });
  }

  await t.test("malformed JSON", () => {
    assertResumeFailure(t, { rawManifest: "{not-json\n" }, "malformed JSON");
  });
  await t.test("duplicate JSON field", () => {
    assertResumeFailure(t, { rawManifest: '{"schema_version":1,"schema_version":1}' }, "duplicate JSON field");
  });
  await t.test("BOM-prefixed JSON", () => {
    const fixture = resumeFixture(t);
    fs.writeFileSync(
      fixture.manifest,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(fixture.manifest)]),
    );
    const before = rawTreeSnapshot(fixture.before);
    const after = rawTreeSnapshot(fixture.after);
    expectValidationError(
      () => validateResumeTransition(fixture.before, fixture.after, fixture.manifest),
      "malformed JSON",
    );
    assert.deepEqual(rawTreeSnapshot(fixture.before), before);
    assert.deepEqual(rawTreeSnapshot(fixture.after), after);
  });
});

contractTest("resume-manifest-authority-matrix", async (t) => {
  await t.test("missing manifest", () => {
    assertResumeFailure(t, { missingManifest: true }, "requires a pre-state change manifest");
  });
  await t.test("post-facto digest", () => {
    const fixture = resumeFixture(t, {
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "Provide deterministic invitation expiration behavior.",
          "Provide deterministic and auditable invitation expiration behavior.",
        );
      },
    });
    // `resumeFixture` cannot reference its own result while constructing the
    // payload, so rewrite the digest after both roots exist.
    const payload = JSON.parse(fs.readFileSync(fixture.manifest, "utf8"));
    payload.workspace_identity.pre_state_sha256 = resumeWorkspaceIdentity(fixture.after);
    fs.writeFileSync(fixture.manifest, `${JSON.stringify(payload)}\n`);
    expectValidationError(
      () => validateResumeTransition(fixture.before, fixture.after, fixture.manifest),
      "pre-state identity does not match",
    );
  });
  await t.test("existing ID presented as new", () => {
    assertResumeFailure(t, { manifest: { newIds: ["R-001"] } }, "already exist in the pre-state");
  });
  await t.test("new ID presented as existing", () => {
    assertResumeFailure(
      t,
      {
        mutateAfter(root) {
          appendClonedRecord(root, "requirements.md", "R-001", "R-002");
          replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
        },
        manifest: { featureSections: ["Requirements"], existingIds: ["R-002"] },
      },
      "absent from the pre-state",
    );
  });
  await t.test("manifest inside source", () => {
    assertResumeFailure(t, { manifestIn: "before" }, "must be ephemeral");
  });
  await t.test("manifest inside candidate", () => {
    assertResumeFailure(t, { manifestIn: "after" }, "must be ephemeral");
  });
  await t.test("unused existing-ID authority", () => {
    assertResumeFailure(t, { manifest: { existingIds: ["R-001"] } }, "left unused authority");
  });
});

contractTest("resume-path-and-alias-matrix", async (t) => {
  await t.test("manifest file symlink", () => {
    const fixture = resumeFixture(t);
    const link = path.join(fixture.base, "manifest-link.json");
    if (!createSymlinkOrSkip(t, fixture.manifest, link)) return;
    const before = rawTreeSnapshot(fixture.before);
    const after = rawTreeSnapshot(fixture.after);
    expectValidationError(
      () => validateResumeTransition(fixture.before, fixture.after, link),
      "not a symlink",
    );
    assert.deepEqual(rawTreeSnapshot(fixture.before), before);
    assert.deepEqual(rawTreeSnapshot(fixture.after), after);
    assert.equal(fs.readlinkSync(link), fixture.manifest);
  });

  await t.test("ancestor symlinks", () => {
    const base = temporary(t, "stnl resume ancestor alias ");
    const sourceParent = path.join(base, "source-real");
    const candidateParent = path.join(base, "candidate-real");
    const manifestParent = path.join(base, "manifest-real");
    fs.mkdirSync(sourceParent);
    fs.mkdirSync(candidateParent);
    fs.mkdirSync(manifestParent);
    const source = copyFixture(sourceParent, "ready", "workspace");
    const candidate = path.join(candidateParent, "workspace");
    fs.cpSync(source, candidate, { recursive: true });
    const manifest = writeResumeManifest(path.join(manifestParent, "resume.json"), source);
    const sourceAlias = path.join(base, "source-alias");
    const candidateAlias = path.join(base, "candidate-alias");
    const manifestAlias = path.join(base, "manifest-alias");
    if (!createSymlinkOrSkip(t, sourceParent, sourceAlias, "dir")) return;
    if (!createSymlinkOrSkip(t, candidateParent, candidateAlias, "dir")) return;
    if (!createSymlinkOrSkip(t, manifestParent, manifestAlias, "dir")) return;
    const sourceBefore = rawTreeSnapshot(source);
    const candidateBefore = rawTreeSnapshot(candidate);
    for (const [name, action, diagnostic] of [
      ["source", () => validateWorkspace(path.join(sourceAlias, "workspace")), "workspace root must not contain symlink components"],
      ["candidate", () => validateResumeTransition(source, path.join(candidateAlias, "workspace"), manifest), "candidate workspace must not contain symlink components"],
      ["manifest", () => validateResumeTransition(source, candidate, path.join(manifestAlias, "resume.json")), "RESUME manifest must not contain symlink components"],
    ]) {
      expectValidationError(action, diagnostic);
      assert.deepEqual(rawTreeSnapshot(source), sourceBefore, `${name}: source changed`);
      assert.deepEqual(rawTreeSnapshot(candidate), candidateBefore, `${name}: candidate changed`);
    }
  });

  await t.test("explicit traversal components", () => {
    const fixture = resumeFixture(t);
    const detour = path.join(fixture.base, "detour");
    fs.mkdirSync(detour);
    const sourceTraversal = `${detour}${path.sep}..${path.sep}${path.basename(fixture.before)}`;
    const candidateTraversal = `${detour}${path.sep}..${path.sep}${path.basename(fixture.after)}`;
    const manifestTraversal = `${detour}${path.sep}..${path.sep}${path.basename(fixture.manifest)}`;
    expectValidationError(() => validateWorkspace(sourceTraversal), "path traversal");
    expectValidationError(
      () => validateResumeTransition(fixture.before, candidateTraversal, fixture.manifest),
      "candidate workspace must not contain path traversal",
    );
    expectValidationError(
      () => validateResumeTransition(fixture.before, fixture.after, manifestTraversal),
      "RESUME manifest must not contain path traversal",
    );
  });

  for (const [variation, storedName, alternateName, candidateName, candidateAlternate, manifestName, manifestAlternate] of [
    [
      "case",
      "StoredWorkspace",
      "sTOREDwORKSPACE",
      "CandidateWorkspace",
      "cANDIDATEwORKSPACE",
      "ResumeManifest.json",
      "rESUMEmANIFEST.JSON",
    ],
    [
      "normalization",
      "SourcéWorkspace",
      "Source\u0301Workspace",
      "CandidatéWorkspace",
      "Candidate\u0301Workspace",
      "RésumeManifest.json",
      "Re\u0301sumeManifest.json",
    ],
  ]) {
    await t.test(`physical ${variation} alias canonicalizes to stored spelling`, (st) => {
      const base = temporary(st, `stnl physical alias ${variation} `);
      const stored = copyFixture(base, "ready", storedName);
      const alias = path.join(base, alternateName);
      const candidate = copyFixture(base, "ready", candidateName);
      const candidateAlias = path.join(base, candidateAlternate);
      const sourceManifest = writeResumeManifest(path.join(stored, "execution", manifestName), stored);
      const sourceManifestAlias = path.join(stored, "execution", manifestAlternate);
      const candidateManifest = path.join(candidate, "execution", manifestName);
      write(candidateManifest, fs.readFileSync(sourceManifest));
      let samePhysicalEntry = false;
      try {
        const pairs = [
          [alias, stored],
          [candidateAlias, candidate],
          [sourceManifestAlias, sourceManifest],
        ];
        samePhysicalEntry = pairs.every(([leftPath, rightPath]) => {
          const left = fs.lstatSync(leftPath);
          const right = fs.lstatSync(rightPath);
          return left.dev === right.dev && left.ino === right.ino;
        });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (!samePhysicalEntry) {
        st.skip(`filesystem does not expose ${variation}-insensitive physical aliases`);
        return;
      }
      assert.equal(validateWorkspace(alias).root, fs.realpathSync(stored));
      const sourceBefore = rawTreeSnapshot(stored);
      const candidateBefore = rawTreeSnapshot(candidate);
      expectValidationError(
        () => validateResumeTransition(stored, candidateAlias, candidateManifest),
        "must be ephemeral and outside source and candidate workspaces",
      );
      expectValidationError(
        () => validateResumeTransition(stored, candidate, sourceManifestAlias),
        "must be ephemeral and outside source and candidate workspaces",
      );
      assert.deepEqual(rawTreeSnapshot(stored), sourceBefore);
      assert.deepEqual(rawTreeSnapshot(candidate), candidateBefore);
    });
  }
});

contractTest("resume-preservation-and-id-matrix", async (t) => {
  const cases = [
    {
      name: "renumber existing requirement",
      mutateAfter(root) {
        for (const relative of ["feature_spec.md", "shared/requirements.md", "shared/acceptance-criteria.md"]) {
          replaceOnce(path.join(root, relative), "R-001", "R-002");
        }
      },
      manifest: { featureSections: ["Requirements"], existingIds: ["AC-001"], newIds: ["R-002"] },
      diagnostic: "preserving tombstones",
    },
    {
      name: "skip next ID",
      mutateAfter(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-003");
        replaceInRecord(root, "requirements.md", "R-003", "- status: in_scope", "- status: out_of_scope");
      },
      manifest: { featureSections: ["Requirements"], newIds: ["R-003"] },
      diagnostic: "must continue monotonically",
    },
    {
      name: "fill historical gap",
      prepareBefore(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-003");
        replaceInRecord(root, "requirements.md", "R-003", "- status: in_scope", "- status: out_of_scope");
      },
      mutateAfter(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      manifest: { featureSections: ["Requirements"], newIds: ["R-002"] },
      diagnostic: "reused or filled a reserved R ID",
    },
    {
      name: "record order",
      prepareBefore(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      mutateAfter(root) {
        const file = path.join(root, "shared", "requirements.md");
        const text = fs.readFileSync(file, "utf8");
        const first = text.indexOf("### R-001 —");
        const second = text.indexOf("### R-002 —");
        const prefix = text.slice(0, first);
        const firstBlock = text.slice(first, second).trim();
        const secondBlock = text.slice(second).trim();
        fs.writeFileSync(file, `${prefix}${secondBlock}\n\n${firstBlock}\n`);
      },
      diagnostic: "canonical record order",
    },
    {
      name: "canonical title identity",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "shared", "requirements.md"),
          "### R-001 — Expired invitation is rejected",
          "### R-001 — Invented replacement title",
        );
      },
      manifest: { existingIds: ["R-001"] },
      diagnostic: "identity/title",
    },
    {
      name: "feature H1 identity",
      mutateAfter(root) {
        replaceOnce(
          path.join(root, "feature_spec.md"),
          "# Fixture Feature - Feature SPEC",
          "# Invented Replacement Feature - Feature SPEC",
        );
      },
      diagnostic: "feature H1 identity",
    },
    {
      name: "canonical category type swap",
      prepareBefore(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
      },
      mutateAfter(root) {
        removeRecord(root, "requirements.md", "R-002");
        appendClonedRecord(root, "constraints.md", "C-001", "C-002");
      },
      manifest: { featureSections: ["Requirements"], newIds: ["C-002"] },
      diagnostic: "preserving tombstones",
    },
    {
      name: "retired tombstone recreation",
      prepareBefore(root) {
        appendClonedRecord(root, "requirements.md", "R-001", "R-002");
        replaceInRecord(root, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
        retireRecord(root, "requirements.md", "R-002", "out_of_scope");
      },
      mutateAfter(root) {
        replaceInRecord(
          root,
          "requirements.md",
          "R-002",
          "- status: retired\n- retired_reason: The record is no longer applicable, but its canonical identity remains reserved.",
          "- status: out_of_scope",
        );
      },
      manifest: {
        existingIds: ["R-002"],
        recordStatusTransitions: [["shared/requirements.md", "R-002", "retired", "out_of_scope"]],
      },
      diagnostic: "is not permitted",
    },
  ];
  for (const case_ of cases) {
    await t.test(case_.name, () => assertResumeFailure(t, case_, case_.diagnostic));
  }
});

contractTest("resume-category-tombstone-matrix", async (t) => {
  const categories = [
    ["R", "requirements.md", "R-001", "R-002", "in_scope", "out_of_scope"],
    ["AC", "acceptance-criteria.md", "AC-001", "AC-002", "active", "active"],
    ["D", "decisions.md", "D-001", "D-002", "accepted", "accepted"],
    ["C", "constraints.md", "C-001", "C-002", "active", "active"],
    ["RK", "risks.md", "RK-001", "RK-002", "active", "active"],
    ["Q", "questions.md", "Q-001", "Q-002", "resolved", "resolved"],
  ];

  for (const [prefix, filename, sourceId, identifier, clonedStatus, preparedStatus] of categories) {
    const prepare = (root) => {
      appendClonedRecord(root, filename, sourceId, identifier);
      if (clonedStatus !== preparedStatus) {
        replaceInRecord(root, filename, identifier, `- status: ${clonedStatus}`, `- status: ${preparedStatus}`);
      }
    };
    await t.test(`${prefix} physical removal is rejected`, () => {
      assertResumeFailure(
        t,
        {
          prepareBefore: prepare,
          mutateAfter(root) { removeRecord(root, filename, identifier); },
          manifest: { featureSections: prefix === "R" ? ["Requirements"] : [] },
        },
        "preserving tombstones",
      );
    });
    if (prefix !== "Q") {
      await t.test(`${prefix} retirement preserves the tombstone`, () => {
        const fixture = resumeFixture(t, {
          prepareBefore: prepare,
          mutateAfter(root) { retireRecord(root, filename, identifier, preparedStatus); },
          manifest: {
            existingIds: [identifier],
            recordStatusTransitions: [[`shared/${filename}`, identifier, preparedStatus, "retired"]],
          },
        });
        const [, candidate] = validateResumeTransition(fixture.before, fixture.after, fixture.manifest);
        assert.equal(candidate.items.get(identifier).metadata.get("status"), "retired");
      });
    }
  }
});

contractTest("transition-external-filesystem-matrix", async (t) => {
  await t.test("INIT rejects an external path in its candidate", () => {
    const base = temporary(t, "stnl init external ");
    const candidate = copyFixture(base, "ready", "candidate");
    write(path.join(candidate, "execution", "unowned.txt"), "must not be created by INIT\n");
    const before = rawTreeSnapshot(candidate);
    expectValidationError(
      () => validateInitTransition(path.join(base, "absent"), candidate),
      "out-of-contract path",
    );
    assert.deepEqual(rawTreeSnapshot(candidate), before);
  });

  await t.test("RESUME rejects changed external bytes", () => {
    assertResumeFailure(
      t,
      {
        prepareBefore(root) { write(path.join(root, "execution", "retained.txt"), "original\n"); },
        mutateAfter(root) { fs.writeFileSync(path.join(root, "execution", "retained.txt"), "mutated\n"); },
      },
      "outside lifecycle ownership",
    );
  });

  await t.test("RESUME rejects a special external filesystem entry", async (st) => {
    if (process.platform === "win32") {
      st.skip("Windows named pipes do not materialize as filesystem entries");
      return;
    }
    const fixture = resumeFixture(st);
    // Unix socket path limits are much shorter than ordinary filesystem path
    // limits on several platforms, so keep this external entry deliberately
    // short while still placing it outside lifecycle authority.
    const socket = path.join(fixture.after, "s");
    const server = net.createServer();
    if (!await listenUnixSocketOrSkip(st, server, socket)) return;
    try {
      expectValidationError(
        () => validateResumeTransition(fixture.before, fixture.after, fixture.manifest),
        "unsupported filesystem entry",
      );
      assert(fs.lstatSync(socket).isSocket());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test("RESUME rejects byte-identical external hardlink substitution", (st) => {
    const fixture = resumeFixture(st, {
      prepareBefore(root) { write(path.join(root, "execution", "victim.txt"), "byte-identical external state\n"); },
    });
    const victim = path.join(fixture.after, "execution", "victim.txt");
    const outside = path.join(fixture.base, "outside.txt");
    fs.writeFileSync(outside, fs.readFileSync(victim));
    fs.unlinkSync(victim);
    if (!createHardlinkOrSkip(st, outside, victim)) {
      fs.writeFileSync(victim, fs.readFileSync(outside));
      return;
    }
    const bytes = fs.readFileSync(outside);
    expectValidationError(
      () => validateResumeTransition(fixture.before, fixture.after, fixture.manifest),
      "outside lifecycle ownership",
    );
    assert.deepEqual(fs.readFileSync(victim), bytes);
    assert.equal(fs.lstatSync(victim).ino, fs.lstatSync(outside).ino);
  });

  await t.test("RESUME rejects linked lifecycle authority", (st) => {
    const fixture = resumeFixture(st);
    const authority = path.join(fixture.after, "shared", "requirements.md");
    const outside = path.join(fixture.base, "outside-requirements.md");
    fs.writeFileSync(outside, fs.readFileSync(authority));
    fs.unlinkSync(authority);
    if (!createHardlinkOrSkip(st, outside, authority)) {
      fs.writeFileSync(authority, fs.readFileSync(outside));
      return;
    }
    expectValidationError(
      () => validateResumeTransition(fixture.before, fixture.after, fixture.manifest),
      "single-link regular file",
    );
    assert.equal(fs.lstatSync(authority).ino, fs.lstatSync(outside).ino);
  });
});

contractTest("readiness-scope-and-topology-matrix", async (t) => {
  await t.test("LOCAL and GLOBAL accept identical snapshots", () => {
    const base = temporary(t, "stnl readiness identical ");
    const before = copyFixture(base, "ready", "before");
    const after = path.join(base, "after");
    fs.cpSync(before, after, { recursive: true });
    for (const scope of ["LOCAL", "GLOBAL"]) {
      assert.equal(validateReadinessTransition(before, after, scope)[1].status, "ready");
    }
  });

  await t.test("all former scope aliases are rejected", () => {
    const base = temporary(t, "stnl readiness scopes ");
    const before = copyFixture(base, "ready", "before");
    const after = path.join(base, "after");
    fs.cpSync(before, after, { recursive: true });
    for (const scope of ["repository", "localized", "global", "local", "Global", "LOCALIZED"]) {
      expectValidationError(() => validateReadinessTransition(before, after, scope), "scope must be exactly");
    }
  });

  await t.test("OS metadata is excluded without directory-link-count contamination", () => {
    const base = temporary(t, "stnl readiness metadata ");
    const before = copyFixture(base, "ready", "before");
    write(path.join(before, "execution", "retained.txt"), "retained\n");
    const after = path.join(base, "after");
    fs.cpSync(before, after, { recursive: true });
    write(path.join(after, "execution", "__MACOSX", "nested", "ignored.txt"), "ignored\n");
    assert.deepEqual(workspaceSnapshot(before), workspaceSnapshot(after));
    assert.equal(validateReadinessTransition(before, after, "GLOBAL")[1].status, "ready");
  });

  await t.test("equal bytes and link counts with different hardlink peers are rejected", (st) => {
    const base = temporary(st, "stnl readiness peers ");
    const before = copyFixture(base, "ready", "before");
    const after = copyFixture(base, "ready", "after");
    for (const [root, pairs] of [
      [before, [["a.txt", "b.txt"], ["c.txt", "d.txt"]]],
      [after, [["a.txt", "c.txt"], ["b.txt", "d.txt"]]],
    ]) {
      const directory = path.join(root, "execution");
      fs.mkdirSync(directory);
      for (const [sourceName, linkedName] of pairs) {
        const source = path.join(directory, sourceName);
        fs.writeFileSync(source, "same topology bytes\n");
        if (!createHardlinkOrSkip(st, source, path.join(directory, linkedName))) return;
      }
    }
    assert.notDeepEqual(workspaceSnapshot(before), workspaceSnapshot(after));
    expectValidationError(
      () => validateReadinessTransition(before, after, "GLOBAL"),
      "mutated the workspace",
    );
  });
});

contractTest("close-structural-and-identity-matrix", async (t) => {
  const cases = [
    {
      name: "level-4 heading outside record",
      mutate(_before, after) {
        replaceOnce(
          path.join(after, "feature_spec.md"),
          "## Objective\n\nProvide deterministic",
          "## Objective\n\n#### Unexpected subsection\n\nProvide deterministic",
        );
      },
      validateOnly: true,
      diagnostic: "outside a canonical record",
    },
    {
      name: "canonical section preamble",
      mutate(_before, after) {
        replaceOnce(
          path.join(after, "feature_spec.md"),
          "## Durable Decisions\n\n### D-001",
          "## Durable Decisions\n\nInvented canonical preamble.\n\n### D-001",
        );
      },
      validateOnly: true,
      diagnostic: "contains a preamble",
    },
    {
      name: "resolved question discarded",
      mutate(_before, after) {
        const feature = path.join(after, "feature_spec.md");
        const text = fs.readFileSync(feature, "utf8");
        fs.writeFileSync(feature, `${text.replace(/\n## Durable Resolved Questions\n[\s\S]*$/u, "").trimEnd()}\n`);
      },
      diagnostic: "discarded canonical items",
    },
    {
      name: "question answer copied elsewhere does not authorize discard",
      mutate(_before, after) {
        const feature = path.join(after, "feature_spec.md");
        let text = fs.readFileSync(feature, "utf8");
        text = text.replace(/\n## Durable Resolved Questions\n[\s\S]*$/u, "");
        text = text.replace(
          "All clients observe one deterministic expiration decision.",
          "All clients observe one deterministic expiration decision. D-001 explicitly establishes the service UTC clock as authority.",
        );
        fs.writeFileSync(feature, `${text.trimEnd()}\n`);
      },
      diagnostic: "discarded canonical items",
    },
    {
      name: "canonical title changed",
      mutate(_before, after) {
        replaceOnce(
          path.join(after, "feature_spec.md"),
          "### D-001 — Service clock is authoritative",
          "### D-001 — Invented final title",
        );
      },
      diagnostic: "changed canonical content for D-001",
    },
    {
      name: "feature H1 changed",
      mutate(_before, after) {
        replaceOnce(
          path.join(after, "feature_spec.md"),
          "# Fixture Feature - Feature SPEC",
          "# Invented Closed Feature - Feature SPEC",
        );
      },
      diagnostic: "feature H1 identity",
    },
    {
      name: "canonical record bytes changed",
      mutate(_before, after) {
        replaceOnce(
          path.join(after, "feature_spec.md"),
          "Client clocks can diverge and cannot produce a consistent expiration result.\n",
          "Client clocks can diverge and cannot produce a consistent expiration result.  \n",
        );
      },
      diagnostic: "changed canonical content for D-001",
    },
  ];

  for (const case_ of cases) {
    await t.test(case_.name, () => {
      const base = temporary(t, `stnl close ${case_.name} `);
      const before = copyFixture(base, "ready", "before");
      const after = copyFixture(base, "closed", "after");
      case_.mutate(before, after);
      const sourceBefore = rawTreeSnapshot(before);
      const candidateBefore = rawTreeSnapshot(after);
      if (case_.validateOnly) expectValidationError(() => validateWorkspace(after), case_.diagnostic);
      else {
        validateWorkspace(after);
        expectValidationError(() => validateCloseTransition(before, after), case_.diagnostic);
      }
      assert.deepEqual(rawTreeSnapshot(before), sourceBefore);
      assert.deepEqual(rawTreeSnapshot(after), candidateBefore);
    });
  }

  await t.test("retired reason bytes remain canonical", () => {
    const base = temporary(t, "stnl close retired reason ");
    const before = copyFixture(base, "ready", "before");
    appendClonedRecord(before, "requirements.md", "R-001", "R-002");
    replaceInRecord(before, "requirements.md", "R-002", "- status: in_scope", "- status: out_of_scope");
    retireRecord(before, "requirements.md", "R-002", "out_of_scope");
    validateWorkspace(before);

    const after = copyFixture(base, "closed", "after");
    appendClosedClone(after, "Requirements", "R-001", "R-002");
    replaceInClosedRecord(
      after,
      "R-002",
      "- status: in_scope",
      "- status: retired\n- retired_reason: The record is no longer applicable, but its canonical identity remains reserved.",
    );
    validateCloseTransition(before, after);

    replaceInClosedRecord(
      after,
      "R-002",
      "- retired_reason: The record is no longer applicable, but its canonical identity remains reserved.",
      "- retired_reason: Invented replacement rationale during CLOSE.",
    );
    const sourceBefore = rawTreeSnapshot(before);
    const candidateBefore = rawTreeSnapshot(after);
    validateWorkspace(after);
    expectValidationError(() => validateCloseTransition(before, after), "changed canonical content for R-002");
    assert.deepEqual(rawTreeSnapshot(before), sourceBefore);
    assert.deepEqual(rawTreeSnapshot(after), candidateBefore);
  });

  await t.test("external hardlink topology changed", (st) => {
    const base = temporary(st, "stnl close external hardlink ");
    const before = copyFixture(base, "ready", "before");
    const after = copyFixture(base, "closed", "after");
    write(path.join(before, "execution", "retained.txt"), "same bytes\n");
    write(path.join(after, "execution", "retained.txt"), "same bytes\n");
    const outside = path.join(base, "outside.txt");
    fs.writeFileSync(outside, "same bytes\n");
    const victim = path.join(after, "execution", "retained.txt");
    fs.unlinkSync(victim);
    if (!createHardlinkOrSkip(st, outside, victim)) return;
    expectValidationError(() => validateCloseTransition(before, after), "changed an external directory");
    assert.equal(fs.lstatSync(victim).ino, fs.lstatSync(outside).ino);
  });

  await t.test("closed authority hardlink", (st) => {
    const base = temporary(st, "stnl close authority hardlink ");
    const before = copyFixture(base, "ready", "before");
    const after = copyFixture(base, "closed", "after");
    const feature = path.join(after, "feature_spec.md");
    const outside = path.join(base, "outside-feature.md");
    fs.writeFileSync(outside, fs.readFileSync(feature));
    fs.unlinkSync(feature);
    if (!createHardlinkOrSkip(st, outside, feature)) return;
    expectValidationError(() => validateCloseTransition(before, after), "single-link regular file");
    assert.equal(fs.lstatSync(feature).ino, fs.lstatSync(outside).ino);
  });
});

contractTest("close-invented-category-matrix", async (t) => {
  const categories = [
    ["Requirements", "R-001", "R-002"],
    ["Final Acceptance Criteria", "AC-001", "AC-002"],
    ["Durable Decisions", "D-001", "D-002"],
    ["Relevant Constraints", "C-001", "C-002"],
    ["Relevant Risks", "RK-001", "RK-002"],
    ["Durable Resolved Questions", "Q-001", "Q-002"],
  ];
  for (const [section, sourceId, destinationId] of categories) {
    await t.test(destinationId, () => {
      const base = temporary(t, `stnl close invented ${destinationId} `);
      const before = copyFixture(base, "ready", "before");
      const after = copyFixture(base, "closed", "after");
      appendClosedClone(after, section, sourceId, destinationId);
      if (destinationId.startsWith("R-")) {
        replaceInClosedRecord(after, destinationId, "- status: in_scope", "- status: out_of_scope");
      }
      const validated = validateWorkspace(after);
      assert(validated.items.has(destinationId));
      expectValidationError(
        () => validateCloseTransition(before, after),
        "invented canonical items",
      );
    });
  }
});

contractTest("validator-cli-negative-token-values", (t) => {
  const base = temporary(t, "stnl validator negative values ");
  const before = copyFixture(base, "ready", "before");
  const after = copyFixture(base, "ready", "after");
  for (const [option, args] of [
    ["--scope", ["readiness-transition", before, after, "--scope", "-token"]],
    ["--manifest", ["resume-transition", before, after, "--manifest", "-token"]],
  ]) {
    const result = spawnSync(process.execPath, [VALIDATOR, ...args], {
      cwd: base,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(result.status, 2, `${option}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`argument ${option}: expected one argument`, "u"));
  }
});
