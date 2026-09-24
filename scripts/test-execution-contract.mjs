import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { watch, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  deriveNormalHandoff,
  EXECUTION_WORKFLOW_SKILLS,
  ExecutionContractError,
  computeRequirementsAuthority,
  inspectExecutionState,
  preflightExecutionOperation,
  repairExecutionContract,
  validateExecutionCandidate,
  workflowSkillForOperation,
} from "../skills/workflows/stnl-slice-quality-manager/runtime/execution-state.mjs";
import { preparePlanCandidate } from "../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs";
import { serializePlanPathClaims } from "../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs";
import { prepareValidationCandidate } from "../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs";
import { publishValidationCandidate } from "../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs";
import { resolveExecutionWorkspace as resolveMaterializerExecutionWorkspace } from "../skills/workflows/stnl-task-materializer/runtime/execution-state.mjs";
import { prepareTaskMaterializationCandidate } from "../skills/workflows/stnl-task-materializer/runtime/prepare-task-candidate.mjs";
import { publishTaskMaterializationCandidate } from "../skills/workflows/stnl-task-materializer/runtime/publish-task-candidate.mjs";
import { serializeTaskPathClaims } from "../skills/workflows/stnl-task-materializer/runtime/serialize-task-paths.mjs";
import {
  serializeRunnerEvidence,
  serializeRunnerManifest,
  serializeRunnerRecord,
  serializeRunnerResponse,
  serializeExecutionScopeClaims,
  serializeRunnerExecutionBundleFromResponse,
  serializeRunnerValidationBundle,
  serializeRunnerValidationBundleFromResponse,
} from "../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs";
import { captureRunnerResponse } from "../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs";
import { prepareExecutionCopy, publishExecutionCopy } from "../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs";
import { EXECUTION_OPERATION_SKILLS, WORKFLOW_OPERATIONS } from "./lib/skill-registry.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKILLS = [
  "stnl-execution-planner", "stnl-plan-reviewer", "stnl-task-materializer", "stnl-task-reviewer",
  "stnl-slice-executor", "stnl-slice-quality-manager",
];

async function temporary(t, prefix = "stnl-execution-contract-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("deterministic runner response capture preserves the final object and rejects wrappers", async (t) => {
  const root = await temporary(t, "stnl-runner-response-capture-");
  const structured = path.join(root, "runner.jsonl");
  const output = path.join(root, "semantic-response.json");
  const semantic = {
    status: "TESTS_PASS",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  };
  const structuredOutput = [
    { type: "thread.started" },
    { type: "item.completed", item: { type: "command_execution", exit_code: 0 } },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(semantic) } },
    { type: "turn.completed" },
  ].map((event) => JSON.stringify(event)).join("\n");
  await fs.writeFile(structured, `${structuredOutput}\n`, "utf8");

  const captured = await captureRunnerResponse({ structuredOutputFile: structured, outputFile: output });
  assert.equal(captured.status, "PASS");
  assert.equal(await fs.readFile(output, "utf8"), JSON.stringify(semantic));

  const wrappedStructured = path.join(root, "wrapped.jsonl");
  const wrappedOutput = path.join(root, "wrapped-response.json");
  await fs.writeFile(wrappedStructured, `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(JSON.stringify(semantic)) },
  })}\n`, "utf8");
  await assert.rejects(
    captureRunnerResponse({ structuredOutputFile: wrappedStructured, outputFile: wrappedOutput }),
    /must be one JSON object, not a JSON string/u,
  );
  await assert.rejects(fs.lstat(wrappedOutput));

  const proseStructured = path.join(root, "prose.jsonl");
  await fs.writeFile(proseStructured, `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "runner summary" },
  })}\n`, "utf8");
  await assert.rejects(
    captureRunnerResponse({ structuredOutputFile: proseStructured, outputFile: path.join(root, "prose-response.json") }),
    /final runner message is not valid JSON/u,
  );
});

test("runner response schema closes every semantic operation shape", async () => {
  const schemaPath = path.join(
    ROOT,
    "skills/workflows/stnl-slice-executor/runtime/runner-semantic-response.schema.json",
  );
  const schema = JSON.parse(await fs.readFile(schemaPath, "utf8"));
  assert.equal(schema.oneOf.length, 3);
  for (const branch of schema.oneOf) {
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(Object.keys(branch.properties).sort(), [...branch.required].sort());
    assert.deepEqual(Object.keys(branch.properties.commands), ["$ref"]);
  }
  const commandSchema = schema.$defs.commands.items;
  assert.equal(commandSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(commandSchema.properties).sort(), ["command", "exit"]);
  assert.deepEqual([...commandSchema.required].sort(), ["command", "exit"]);
});

test("provider response schemas use one closed object root per operation", async () => {
  const runtime = path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime");
  const schemas = [
    ["EXECUTE_SLICE", "runner-execute-response.schema.json"],
    ["APPLY_FINDINGS", "runner-apply-findings-response.schema.json"],
    ["VALIDATE_SLICE", "runner-validate-response.schema.json"],
  ];
  const logical = JSON.parse(await fs.readFile(path.join(runtime, "runner-semantic-response.schema.json"), "utf8"));
  for (const [operation, filename] of schemas) {
    const schema = JSON.parse(await fs.readFile(path.join(runtime, filename), "utf8"));
    const branch = logical.oneOf.find((candidate) => candidate.title === operation);
    assert.ok(branch);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(branch.properties).sort());
    assert.deepEqual([...schema.required].sort(), [...branch.required].sort());
    const commandSchema = schema.properties.commands;
    assert.equal(commandSchema.type, "array");
    assert.equal(commandSchema.items.additionalProperties, false);
    assert.deepEqual(Object.keys(commandSchema.items.properties).sort(), ["command", "exit"]);
    assert.deepEqual([...commandSchema.items.required].sort(), ["command", "exit"]);
  }
});

test("SPEC_PATH rejects directory and file traversal through symlink ancestors", async (t) => {
  const root = await temporary(t);
  const real = path.join(root, "real-project");
  const fixture = { root: real, requirements: path.join(real, "requirements.md"), execution: path.join(real, "requirements-execution") };
  await fs.mkdir(real, { recursive: true });
  await fs.writeFile(fixture.requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  await renderArtifacts(fixture);
  const alias = path.join(root, "alias-project");
  await fs.symlink(real, alias, "dir");
  await assert.rejects(inspectExecutionState(alias), /symlink component/u);
  await assert.rejects(inspectExecutionState(path.join(alias, "requirements.md")), /symlink component/u);
});

test("deterministic plan serializer rebases detailed claims from global physical targets before validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const physicalTarget = path.join(fixture.root, "src", "serializer-target.mjs");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, "export const target = true;\n", "utf8");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailedClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: globalClaim, detail: globalClaim });

  const candidateRoot = path.join(await temporary(t, "stnl-plan-serializer-candidate-"), "execution");
  const liveDetailBytes = await fs.readFile(path.join(fixture.execution, "plans", "slice-01.md"));
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /invalid artifact-relative implementation path|possible path-basis error/u,
  );
  await assert.rejects(
    serializePlanPathClaims({
      specPath: fixture.execution,
      candidateExecutionRoot: candidateRoot,
    }),
    /workspace feature_spec\.md must be a single-link real file/u,
    "passing executionRoot as SPEC_PATH makes the official resolver seek execution/feature_spec.md",
  );

  const first = await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.equal(first.status, "PASS");
  assert.equal(first.serializedClaims, 1);
  assert.equal(first.candidateValidation.state, "PLANNED_READY");
  assert.equal(first.candidateValidation.currentFingerprint, await computeRequirementsAuthority(fixture.requirements));
  assert.deepEqual(first.changedPaths, [path.join(candidateRoot, "plans", "slice-01.md")]);
  const serialized = await fs.readFile(path.join(candidateRoot, "plans", "slice-01.md"), "utf8");
  assert.equal(serialized.includes(`\`${detailedClaim}\``), true);
  assert.equal(
    await fs.realpath(path.resolve(path.dirname(path.join(fixture.execution, "plans", "slice-01.md")), detailedClaim)),
    await fs.realpath(physicalTarget),
  );
  await assert.doesNotReject(validateExecutionCandidate(fixture.requirements, candidateRoot));

  const canonicalBytes = await fs.readFile(path.join(candidateRoot, "plans", "slice-01.md"));
  const second = await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.deepEqual(second.changedPaths, []);
  assert.deepEqual(await fs.readFile(path.join(candidateRoot, "plans", "slice-01.md")), canonicalBytes);

  const invalidCandidateRoot = path.join(await temporary(t, "stnl-plan-serializer-invalid-state-"), "execution");
  await fs.cp(candidateRoot, invalidCandidateRoot, { recursive: true });
  const invalidDetailPath = path.join(invalidCandidateRoot, "plans", "slice-01.md");
  const invalidDetailBefore = await fs.readFile(invalidDetailPath, "utf8");
  await fs.writeFile(invalidDetailPath, invalidDetailBefore
    .replace("status: ready", "status: draft")
    .replace("Review state: approved", "Review state: pending"), "utf8");
  const invalidDetailSnapshot = await fs.readFile(invalidDetailPath);
  await assert.rejects(
    serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: invalidCandidateRoot }),
    /ready global plan retains a draft detailed plan/u,
  );
  assert.deepEqual(await fs.readFile(invalidDetailPath), invalidDetailSnapshot);
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "plans", "slice-01.md")), liveDetailBytes);

  const ambiguousRoot = path.join(await temporary(t, "stnl-plan-serializer-ambiguous-"), "execution");
  await fs.cp(candidateRoot, ambiguousRoot, { recursive: true });
  const ambiguousPath = path.join(ambiguousRoot, "plans", "slice-01.md");
  const ambiguousBefore = await fs.readFile(ambiguousPath);
  await fs.writeFile(ambiguousPath, ambiguousBefore.toString("utf8").replace(
    `\`${detailedClaim}\` — example implementation`,
    `\`${detailedClaim}\`; \`another-target.mjs\` — example implementation`,
  ), "utf8");
  const ambiguousSnapshot = await fs.readFile(ambiguousPath);
  assert.notDeepEqual(ambiguousSnapshot, ambiguousBefore);
  assert.match(ambiguousSnapshot.toString("utf8"), /another-target\.mjs/u);
  await assert.rejects(
    serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: ambiguousRoot }),
    /contains more path claims than its global slice row|has 2 path claims but its global slice row has 1/u,
  );
  assert.deepEqual(await fs.readFile(ambiguousPath), ambiguousSnapshot);

  const malformedRoot = path.join(await temporary(t, "stnl-plan-serializer-malformed-"), "execution");
  await fs.cp(candidateRoot, malformedRoot, { recursive: true });
  const malformedPlan = path.join(malformedRoot, "plan.md");
  const malformedBefore = await fs.readFile(malformedPlan);
  await fs.writeFile(malformedPlan, malformedBefore.toString("utf8").replace(
    globalClaim,
    "../../src/serializer-target.mjs",
  ), "utf8");
  const malformedSnapshot = await fs.readFile(malformedPlan);
  await assert.rejects(
    serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: malformedRoot }),
    /possible path-basis error/u,
  );
  assert.deepEqual(await fs.readFile(malformedPlan), malformedSnapshot);
});

test("deterministic plan candidate preparation serializes template headers before strict validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "draft" });
  const physicalTarget = path.join(fixture.root, "src", "example.txt");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, "export const target = true;\n", "utf8");
  const candidateRoot = path.join(await temporary(t, "stnl-plan-header-candidate-"), "execution");
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });

  const planPath = path.join(candidateRoot, "plan.md");
  const detailPath = path.join(candidateRoot, "plans", "slice-01.md");
  const planBefore = await fs.readFile(planPath, "utf8");
  const detailBefore = await fs.readFile(detailPath, "utf8");
  const planHeader = planBefore.match(/^# File Purpose Header\n\n```yaml\n[\s\S]*?^```\n\n/mu)?.[0];
  const detailHeader = detailBefore.match(/^# File Purpose Header\n\n```yaml\n[\s\S]*?^```\n\n/mu)?.[0];
  assert.ok(planHeader);
  assert.ok(detailHeader);
  await fs.writeFile(planPath, planBefore.slice(planHeader.length), "utf8");
  await fs.writeFile(detailPath, detailBefore.slice(detailHeader.length), "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /File Purpose Header/u,
  );

  const prepared = await preparePlanCandidate({ candidateExecutionRoot: candidateRoot });
  assert.equal(prepared.status, "PASS");
  assert.deepEqual([...prepared.changedPaths].sort(), [planPath, detailPath].sort());
  assert.equal((await fs.readFile(planPath, "utf8")).endsWith(planBefore.slice(planHeader.length)), true);
  assert.equal((await fs.readFile(detailPath, "utf8")).endsWith(detailBefore.slice(detailHeader.length)), true);
  const state = await validateExecutionCandidate(fixture.requirements, candidateRoot);
  assert.equal(state.state, "PLANNED_DRAFT");
  const canonicalPlan = await fs.readFile(planPath, "utf8");
  const canonicalDetail = await fs.readFile(detailPath, "utf8");
  assert.deepEqual((await preparePlanCandidate({ candidateExecutionRoot: candidateRoot })).changedPaths, []);
  assert.deepEqual(await fs.readFile(planPath, "utf8"), canonicalPlan);
  assert.deepEqual(await fs.readFile(detailPath, "utf8"), canonicalDetail);

  const conflictingRoot = await copyDirectory(
    candidateRoot,
    path.join(await temporary(t, "stnl-plan-header-conflict-"), "execution"),
  );
  const conflictingPlanPath = path.join(conflictingRoot, "plan.md");
  const conflictingPlanBefore = await fs.readFile(conflictingPlanPath, "utf8");
  const canonicalUpdatePolicy = planHeader.match(/^update_policy: .+$/mu)?.[0];
  assert.ok(canonicalUpdatePolicy);
  const modelUpdatePolicy = canonicalUpdatePolicy.replace("REVIEW_PLAN corrects ", "REVIEW_PLAN corrects only ");
  assert.notEqual(modelUpdatePolicy, canonicalUpdatePolicy);
  const conflictingPlan = conflictingPlanBefore.replace(canonicalUpdatePolicy, modelUpdatePolicy);
  await fs.writeFile(conflictingPlanPath, conflictingPlan, "utf8");
  const conflictingHeader = conflictingPlan.match(/^# File Purpose Header\n\n```yaml\n[\s\S]*?^```\n\n/mu)?.[0];
  assert.ok(conflictingHeader);
  const conflictingBody = conflictingPlan.slice(conflictingHeader.length);

  const normalized = await preparePlanCandidate({ candidateExecutionRoot: conflictingRoot });
  assert.equal(normalized.status, "PASS");
  assert.deepEqual(normalized.changedPaths, [conflictingPlanPath]);
  const normalizedPlan = await fs.readFile(conflictingPlanPath, "utf8");
  assert.equal(normalizedPlan, canonicalPlan);
  assert.equal(normalizedPlan.slice(planHeader.length), conflictingBody);
  assert.equal((await validateExecutionCandidate(fixture.requirements, conflictingRoot)).state, "PLANNED_DRAFT");
  assert.deepEqual((await preparePlanCandidate({ candidateExecutionRoot: conflictingRoot })).changedPaths, []);

  const readyRoot = path.join(await temporary(t, "stnl-plan-header-ready-"), "execution");
  await fs.cp(candidateRoot, readyRoot, { recursive: true });
  for (const relativePath of ["plan.md", "plans/slice-01.md"]) {
    const file = path.join(readyRoot, relativePath);
    const content = await fs.readFile(file, "utf8");
    await fs.writeFile(file, content.replace("status: draft\n", "status: ready\n"), "utf8");
  }
  const readyPrepared = await preparePlanCandidate({ candidateExecutionRoot: readyRoot });
  assert.equal(readyPrepared.status, "PASS");
  assert.deepEqual(readyPrepared.changedPaths, []);
  assert.match(await fs.readFile(path.join(readyRoot, "plan.md"), "utf8"), /^status: ready$/mu);
  assert.match(await fs.readFile(path.join(readyRoot, "plans", "slice-01.md"), "utf8"), /^status: ready$/mu);

  const malformedRoot = path.join(await temporary(t, "stnl-plan-header-malformed-"), "execution");
  await fs.cp(conflictingRoot, malformedRoot, { recursive: true });
  const malformedPath = path.join(malformedRoot, "plan.md");
  const malformedBefore = await fs.readFile(malformedPath, "utf8");
  await fs.writeFile(malformedPath, malformedBefore.replace("status: draft\n", "status: draft\nstatus: ready\n"), "utf8");
  const malformedSnapshot = await fs.readFile(malformedPath, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, malformedRoot),
    /File Purpose Header/u,
  );
  await assert.rejects(
    preparePlanCandidate({ candidateExecutionRoot: malformedRoot }),
    /malformed or conflicting File Purpose Header/u,
  );
  assert.deepEqual(await fs.readFile(malformedPath, "utf8"), malformedSnapshot);
});

test("deterministic plan serializer canonicalizes repository-relative semantic targets before strict validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const physicalTarget = path.join(fixture.root, "src", "semantic-target.mjs");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, "export const target = true;\n", "utf8");

  const candidateRoot = path.join(await temporary(t, "stnl-plan-semantic-candidate-"), "execution");
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });
  const candidateFixture = { ...fixture, execution: candidateRoot };
  await fs.rm(fixture.execution, { recursive: true });
  await setImplementationAreas(candidateFixture, {
    global: "src/semantic-target.mjs",
    detail: "src/semantic-target.mjs",
  });

  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /artifact-relative implementation path/u,
  );
  const serialized = await serializePlanPathClaims({
    specPath: fixture.requirements,
    candidateExecutionRoot: candidateRoot,
  });
  assert.equal(serialized.status, "PASS");
  assert.equal(serialized.candidateValidation.state, "PLANNED_READY");
  assert.deepEqual(serialized.changedPaths.slice().sort(), [
    path.join(candidateRoot, "plan.md"),
    path.join(candidateRoot, "plans/slice-01.md"),
  ].sort());
  const global = await fs.readFile(path.join(candidateRoot, "plan.md"), "utf8");
  const detail = await fs.readFile(path.join(candidateRoot, "plans/slice-01.md"), "utf8");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  assert.equal(global.includes(`\`${globalClaim}\``), true);
  assert.equal(detail.includes(`\`${detailClaim}\``), true);
  assert.equal(serialized.candidateValidation.currentFingerprint, await computeRequirementsAuthority(fixture.requirements));

  const escapedDelimiterRoot = path.join(await temporary(t, "stnl-plan-semantic-escaped-"), "execution");
  await fs.cp(candidateRoot, escapedDelimiterRoot, { recursive: true });
  const escapedPlanPath = path.join(escapedDelimiterRoot, "plan.md");
  const escapedBefore = await fs.readFile(escapedPlanPath, "utf8");
  const escapedCarrier = ["`", "src/semantic-target.mjs", "\\", "`"].join("");
  await fs.writeFile(
    escapedPlanPath,
    escapedBefore.replace(`\`${globalClaim}\``, escapedCarrier),
    "utf8",
  );
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, escapedDelimiterRoot),
    /artifact-relative implementation path/u,
  );
  const escapedSerialized = await serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: escapedDelimiterRoot });
  assert.equal(escapedSerialized.candidateValidation.state, "PLANNED_READY");
  const escapedCanonicalPlan = await fs.readFile(escapedPlanPath, "utf8");
  assert.equal(escapedCanonicalPlan.includes(`\`${globalClaim}\``), true);
  assert.equal(
    (await validateExecutionCandidate(fixture.requirements, escapedDelimiterRoot)).state,
    "PLANNED_READY",
  );

  const malformedRoot = path.join(await temporary(t, "stnl-plan-semantic-malformed-"), "execution");
  await fs.cp(candidateRoot, malformedRoot, { recursive: true });
  const malformedPlan = path.join(malformedRoot, "plan.md");
  const malformedBefore = await fs.readFile(malformedPlan);
  await fs.writeFile(
    malformedPlan,
    malformedBefore.toString("utf8").replace(globalClaim, "src/../semantic-target.mjs"),
    "utf8",
  );
  const malformedSnapshot = await fs.readFile(malformedPlan);
  await assert.rejects(
    serializePlanPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: malformedRoot }),
    /semantic physical implementation target must be a normalized repository-relative path/u,
  );
  assert.deepEqual(await fs.readFile(malformedPlan), malformedSnapshot);
});

test("deterministic task serializer rebases approved plan targets before validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const physicalTarget = path.join(fixture.root, "src", "example.txt");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  const taskClaim = path.relative(path.join(fixture.execution, "tasks"), physicalTarget).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: globalClaim, detail: detailClaim, task: globalClaim });

  const candidateRoot = path.join(await temporary(t, "stnl-task-serializer-candidate-"), "execution");
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /possible path-basis error|resolves inside the lifecycle SPEC workspace/u,
  );

  const first = await serializeTaskPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.equal(first.status, "PASS");
  assert.equal(first.serializedClaims, 1);
  assert.deepEqual(first.changedPaths, [path.join(candidateRoot, "tasks", "slice-01.md")]);
  const serialized = await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md"), "utf8");
  assert.equal(serialized.includes(`\`${taskClaim}\``), true);
  assert.match(serialized, /example implementation/u);
  assert.equal(
    await fs.realpath(path.resolve(path.dirname(path.join(fixture.execution, "tasks", "slice-01.md")), taskClaim)),
    await fs.realpath(physicalTarget),
  );
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidateRoot)).state, "MATERIALIZED_PRISTINE");

  const canonicalBytes = await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md"));
  const second = await serializeTaskPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: candidateRoot });
  assert.deepEqual(second.changedPaths, []);
  assert.deepEqual(await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md")), canonicalBytes);

  const ambiguousRoot = path.join(await temporary(t, "stnl-task-serializer-ambiguous-"), "execution");
  await fs.cp(candidateRoot, ambiguousRoot, { recursive: true });
  const ambiguousPath = path.join(ambiguousRoot, "tasks", "slice-01.md");
  const ambiguousBefore = await fs.readFile(ambiguousPath);
  await fs.writeFile(ambiguousPath, ambiguousBefore.toString("utf8").replace(
    /(\| expected areas: )`[^`\n]+`/u,
    `$1\`${taskClaim}\`; \`another-target.mjs\``,
  ), "utf8");
  const ambiguousSnapshot = await fs.readFile(ambiguousPath);
  assert.notDeepEqual(ambiguousSnapshot, ambiguousBefore);
  assert.match(ambiguousSnapshot.toString("utf8"), /another-target\.mjs/u);
  await assert.rejects(
    serializeTaskPathClaims({ specPath: fixture.requirements, candidateExecutionRoot: ambiguousRoot }),
    /has 2 path claims but its approved plan has 1/u,
  );
  assert.deepEqual(await fs.readFile(ambiguousPath), ambiguousSnapshot);

  const malformed = await nestedLifecycleWorkspace(t);
  const malformedTarget = path.join(malformed.root, "src", "example.txt");
  const malformedGlobal = path.relative(malformed.execution, malformedTarget).split(path.sep).join("/");
  const malformedDetail = path.relative(path.join(malformed.execution, "plans"), malformedTarget).split(path.sep).join("/");
  await setImplementationAreas(malformed, {
    global: malformedGlobal,
    detail: malformedDetail.replace(/^\.\.\//u, ""),
    task: malformedGlobal,
  });
  const malformedRoot = path.join(await temporary(t, "stnl-task-serializer-malformed-"), "execution");
  await fs.cp(malformed.execution, malformedRoot, { recursive: true });
  const malformedTask = path.join(malformedRoot, "tasks", "slice-01.md");
  const malformedBefore = await fs.readFile(malformedTask);
  await assert.rejects(
    serializeTaskPathClaims({ specPath: malformed.requirements, candidateExecutionRoot: malformedRoot }),
    /possible path-basis error/u,
  );
  assert.deepEqual(await fs.readFile(malformedTask), malformedBefore);
});

test("deterministic runner evidence serializer emits physical task-relative SHA-256 tuples", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const workspace = fixture.root;
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const physicalTarget = path.join(workspace, "src/example.txt");
  const claim = path.relative(path.dirname(taskArtifact), physicalTarget).split(path.sep).join("/");
  const expected = `  - \`${claim}\` | sha256:${VALIDATED_HASH}`;

  const serialized = await serializeRunnerEvidence({
    workspace,
    taskArtifact,
    targets: [physicalTarget],
  });
  assert.equal(serialized, expected);
  assert.equal(
    await fs.realpath(path.resolve(path.dirname(taskArtifact), claim)),
    await fs.realpath(physicalTarget),
  );
  assert.equal(
    await serializeRunnerEvidence({ workspace, taskArtifact, targets: [physicalTarget] }),
    serialized,
  );
  const record = await serializeRunnerRecord({
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [
      { command: "node --test test/example.test.mjs", exit: 0 },
      { command: "git diff --check", exit: 1 },
    ],
  });
  assert.equal(
    record,
    `- Tested state:\n${expected}\n- Commands:\n  - \`node --test test/example.test.mjs\` | exit:0\n  - \`git diff --check\` | exit:1`,
  );
  assert.equal(record.includes("`- Tested state:`"), false);
  const manifest = await serializeRunnerManifest({
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  assert.equal(
    manifest,
    `- Files:\n${expected}\n- Authoritative commands:\n  - \`node --test test/example.test.mjs\` | exit:0`,
  );
  const manifestCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--manifest",
    "--workspace", workspace,
    "--spec-path", fixture.requirements,
    "--slice", "1",
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs",
    "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(manifestCli.status, 0, manifestCli.stderr);
  assert.equal(manifestCli.stdout.trimEnd(), manifest);
  await assert.rejects(
    serializeRunnerManifest({ workspace, taskArtifact, targets: [physicalTarget], commands: [] }),
    /at least one authoritative command/u,
  );
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs",
    "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trimEnd(), record.slice(0, record.indexOf("\n- Commands:")) + "\n- Commands:\n  - `node --test test/example.test.mjs` | exit:0");
  const help = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--help",
  ], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--response --operation/u);
  assert.match(help.stdout, /--value "semantic value"/u);
  assert.match(help.stdout, /--manifest --workspace/u);
  const tokenizedCommands = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--target", physicalTarget,
    "--command", "node", "--test", "test/example.test.mjs", "--exit", "0",
    "--command", "git", "diff", "--check", "--exit", "1",
  ], { encoding: "utf8" });
  assert.equal(tokenizedCommands.status, 0, tokenizedCommands.stderr);
  assert.equal(tokenizedCommands.stdout.trimEnd(), record);
  const derivedRecord = await serializeRunnerRecord({
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  const derivedCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--spec-path", fixture.requirements,
    "--slice", "1",
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs",
    "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(derivedCli.status, 0, derivedCli.stderr);
  assert.equal(derivedCli.stdout.trimEnd(), derivedRecord);
  const ambiguousInputs = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--spec-path", fixture.requirements,
    "--slice", "1",
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs",
    "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(ambiguousInputs.status, 1);
  assert.match(ambiguousInputs.stderr, /use --task-artifact or --spec-path with --slice, not both/u);
  const responseFields = {
    Operation: "EXECUTE_SLICE",
    Status: "TESTS_PASS",
    "Automatic check round": "1/3",
    HEAD: "none",
    "Tested scope": "malformed semantic scope",
    "Discovery sources": "task and package scripts",
    "Discovery actions": "read-only inspection",
    "Verification types considered": "unit tests",
    "Non-applicability rationale": "none",
    "No verification-command confirmation": "not applicable",
    "Result of each command and exit code": "all passed",
    "Selected checks": "node --test test/example.test.mjs",
    "Selection rationale": "directly covers the changed behavior",
    Coverage: "changed behavior",
    Failures: "none",
    "Evidence or failure summary": "focused tests passed",
    "Affected files or behaviors": "example behavior",
    Blockers: "none",
    "Unexpected workspace effects": "none",
    "Persistence summary": "record persisted",
  };
  const response = await serializeRunnerResponse({
    operation: "EXECUTE_SLICE",
    fields: responseFields,
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  assert.equal(response.startsWith("Operation: EXECUTE_SLICE\nStatus: TESTS_PASS\nAutomatic check round: 1/3"), true);
  assert.equal(response.includes(`Tested scope: ${claim}`), true);
  assert.equal(response.includes("malformed semantic scope"), false);
  assert.match(response, /^Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}$/mu);
  assert.match(response, /^Commands:\n  - `node --test test\/example\.test\.mjs` \| exit:0$/mu);
  assert.equal(response.includes("Operação:"), false);
  const responseFromSemanticValues = await serializeRunnerResponse({
    operation: "EXECUTE_SLICE",
    values: Object.entries(responseFields)
      .filter(([label]) => label !== "Operation")
      .map(([, value]) => value),
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  assert.equal(responseFromSemanticValues, response);
  const validationValues = [
    "initial",
    "PASS",
    "slice-01: src/example.txt",
    "fixture-head",
    "focused validation passed",
    "none",
    "none",
    "none",
    "none",
    "attempt persisted",
  ];
  const validationBundle = await serializeRunnerValidationBundle({
    operation: "VALIDATE_SLICE",
    values: validationValues,
    workspace,
    taskArtifact,
    targets: [physicalTarget],
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
  });
  assert.match(validationBundle, /- Runner response:\nOperation: VALIDATE_SLICE\nType: initial\nStatus: PASS/u);
  assert.match(validationBundle, /- Tested record:\n- Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}/u);
  assert.match(validationBundle, /- Formal manifest:\n- Files:\n  - `[^`]+` \| sha256:[0-9a-f]{64}/u);
  assert.match(validationBundle, /- Authoritative commands:\n  - `node --test test\/example\.test\.mjs` \| exit:0/u);
  await fs.writeFile(
    taskArtifact,
    (await fs.readFile(taskArtifact, "utf8")).replace("## Changed Areas\n\n- pending", `## Changed Areas\n\n- \`${claim}\``),
    "utf8",
  );
  const semanticValidationResponse = JSON.stringify({
    status: "PASS",
    head: "fixture-head",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    evidence: "focused validation passed",
    findingReferences: "none",
    findingDispositions: "none",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "semantic result returned",
  });
  const semanticResponseRoot = await temporary(t, "stnl-validation-semantic-response-");
  const semanticResponseFile = path.join(semanticResponseRoot, "response.txt");
  await fs.writeFile(semanticResponseFile, `${semanticValidationResponse}\n`, "utf8");
  const officialValidationPreflight = `node "${path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs")}" "${fixture.requirements}" VALIDATE_SLICE 1`;
  const derivedValidationBundle = await serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: semanticValidationResponse,
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  });
  assert.match(derivedValidationBundle, /- Runner response:\nOperation: VALIDATE_SLICE\nType: initial\nStatus: PASS/u);
  assert.equal(derivedValidationBundle.includes(`  - \`${claim}\` | sha256:`), true);
  assert.match(derivedValidationBundle, /- Tested record:[\s\S]+sha256:[0-9a-f]{64}/u);
  assert.equal(
    derivedValidationBundle.split(`  - \`${officialValidationPreflight}\` | exit:0`).length - 1,
    3,
    "producer must persist the canonical official preflight in every generated section",
  );
  assert.equal(
    derivedValidationBundle.includes(
      `- Authoritative commands:\n  - \`${officialValidationPreflight}\` | exit:0\n  - \`node --test test/example.test.mjs\` | exit:0`,
    ),
    true,
  );
  const taskBeforeOverlap = await fs.readFile(taskArtifact, "utf8");
  const overlapTask = replaceSection(
    taskBeforeOverlap,
    "Prior Validation Overlap",
    `### overlap-01\n\n- Prior slice: slice-01\n- Paths: \`${claim}\`\n- Affected behavior: Preserve the previously validated behavior.\n- Regressions: Re-run the focused regression.`,
  );
  await fs.writeFile(taskArtifact, overlapTask, "utf8");
  try {
    const overlapBundle = await serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: semanticValidationResponse,
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    });
    assert.equal(overlapBundle.includes(`  - \`${claim}\` | sha256:`), true);
    assert.equal(await fs.readFile(taskArtifact, "utf8"), overlapTask);

    const semanticOverlapTask = overlapTask.replace(
      `- Prior slice: slice-01\n- Paths: \`${claim}\`\n- Affected behavior: Preserve the previously validated behavior.\n- Regressions: Re-run the focused regression.`,
      `- Slice 01 overlap: \`${claim}\`; Preserve the previously validated behavior and re-run the focused regression.`,
    );
    await fs.writeFile(taskArtifact, semanticOverlapTask, "utf8");
    const semanticOverlapBundle = await serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: semanticValidationResponse,
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    });
    assert.equal(semanticOverlapBundle.includes(`  - \`${claim}\` | sha256:`), true);
    assert.equal(await fs.readFile(taskArtifact, "utf8"), semanticOverlapTask);
    await fs.writeFile(taskArtifact, overlapTask, "utf8");

    await fs.writeFile(
      taskArtifact,
      overlapTask.replace(`- Paths: \`${claim}\``, `- Paths: \`${claim}\`, ${claim}`),
      "utf8",
    );
    await assert.rejects(
      serializeRunnerValidationBundleFromResponse({
        operation: "VALIDATE_SLICE",
        response: semanticValidationResponse,
        workspace,
        taskArtifact,
        specPath: fixture.requirements,
        slice: "1",
      }),
      /Prior Validation Overlap Paths must be comma-separated raw paths or balanced Markdown path claims/u,
    );
  } finally {
    await fs.writeFile(taskArtifact, taskBeforeOverlap, "utf8");
  }
  const emptyFindingSynonymResponse = JSON.stringify({
    ...JSON.parse(semanticValidationResponse),
    findingDispositions: "unchanged",
  });
  const emptyFindingBundle = await serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: emptyFindingSynonymResponse,
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  });
  assert.match(emptyFindingBundle, /Finding references: none\nFinding dispositions: none/u);
  assert.equal(emptyFindingBundle.includes("unchanged"), false);
  const markdownScalarResponse = JSON.stringify({
    ...JSON.parse(semanticValidationResponse),
    blockers: "Runner returned `PASS` with `format`.",
  });
  const markdownScalarBundle = await serializeRunnerValidationBundleFromResponse({
    operation: "VALIDATE_SLICE",
    response: markdownScalarResponse,
    workspace,
    taskArtifact,
    specPath: fixture.requirements,
    slice: "1",
  });
  assert.match(markdownScalarBundle, /\nBlockers: Runner returned PASS with format\.\n/u);
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: JSON.stringify({
        ...JSON.parse(semanticValidationResponse),
        blockers: "Runner returned `PASS.",
      }),
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    }),
    /unbalanced Markdown code delimiters/u,
  );
  const derivedValidationCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--validation-bundle", "--operation", "VALIDATE_SLICE",
    "--workspace", workspace,
    "--spec-path", fixture.requirements,
    "--slice", "1",
    "--semantic-response-file", semanticResponseFile,
  ], { encoding: "utf8" });
  assert.equal(derivedValidationCli.status, 0, derivedValidationCli.stderr);
  assert.equal(derivedValidationCli.stdout.trimEnd(), derivedValidationBundle);
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: JSON.stringify({
        ...JSON.parse(semanticValidationResponse),
        commands: [{ command: "validate-execution-state.mjs SPEC_PATH VALIDATE_SLICE 1", exit: 0 }],
      }),
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    }),
    /launcher-owned official preflight/u,
  );
  const semanticExecutionPayload = {
    status: "TESTS_PASS",
    automaticCheckRound: "1/3",
    head: "fixture-head",
    discoverySources: "task and package scripts",
    discoveryActions: "read-only inspection",
    verificationTypesConsidered: "unit tests",
    nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "not applicable",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    resultOfEachCommandAndExitCode: "all passed",
    selectedChecks: "node --test test/example.test.mjs",
    selectionRationale: "directly covers the changed behavior",
    coverage: "changed behavior",
    failures: "none",
    priorRoundFailure: "none",
    correctionApplied: "none",
    inSliceRationale: "none",
    evidenceOrFailureSummary: "focused tests passed",
    affectedFilesOrBehaviors: "example behavior",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "record persisted",
  };
  const semanticExecutionResponse = JSON.stringify(semanticExecutionPayload);
  const executionBundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE",
    response: semanticExecutionResponse,
    workspace,
    taskArtifact,
  });
  assert.match(executionBundle, /^### implementation-check-01\n- Automatic check round: 1\/3\n- Status: TESTS_PASS/mu);
  assert.match(executionBundle, new RegExp(`Tested scope: ${claim.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`));
  assert.match(executionBundle, /Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}/u);
  assert.match(executionBundle, /- Commands:\n  - `node --test test\/example\.test\.mjs` \| exit:0/u);
  const canonicalCandidate = path.join(await temporary(t, "stnl-execution-check-candidate-"), "execution");
  await fs.cp(fixture.execution, canonicalCandidate, { recursive: true });
  const canonicalCandidateTask = path.join(canonicalCandidate, "tasks/slice-01.md");
  let canonicalCandidateText = await fs.readFile(canonicalCandidateTask, "utf8");
  canonicalCandidateText = canonicalCandidateText.replace("- [ ] 1.1", "- [x] 1.1");
  canonicalCandidateText = replaceSection(canonicalCandidateText, "Implementation Test Evidence", executionBundle);
  await fs.writeFile(canonicalCandidateTask, canonicalCandidateText, "utf8");
  assert.equal(
    (await validateExecutionCandidate(fixture.requirements, canonicalCandidate)).state,
    "IMPLEMENTED_AWAITING_VALIDATION",
  );
  const malformedCheckCandidate = path.join(await temporary(t, "stnl-execution-check-malformed-"), "execution");
  await fs.cp(canonicalCandidate, malformedCheckCandidate, { recursive: true });
  const malformedCheckTask = path.join(malformedCheckCandidate, "tasks/slice-01.md");
  await fs.writeFile(
    malformedCheckTask,
    (await fs.readFile(malformedCheckTask, "utf8")).replace(
      "- Failures: none",
      "- Evidence or failure summary: unexpected response-only label\n- Failures: none",
    ),
    "utf8",
  );
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, malformedCheckCandidate),
    /unknown field 'Evidence or failure summary'/u,
  );
  const canonicalTaskBytes = await fs.readFile(taskArtifact, "utf8");
  const aliasedTaskBytes = canonicalTaskBytes.replace(
    `## Changed Areas\n\n- \`${claim}\``,
    "## Changed Areas\n\n- `src/example.txt`",
  );
  await fs.writeFile(taskArtifact, aliasedTaskBytes, "utf8");
  const scopeSerialization = await serializeExecutionScopeClaims({ workspace, taskArtifact });
  assert.equal(scopeSerialization.status, "PASS");
  assert.equal(scopeSerialization.serializedClaims, 1);
  assert.ok((await fs.readFile(taskArtifact, "utf8")).includes(`## Changed Areas\n\n- \`${claim}\``));
  await fs.writeFile(taskArtifact, aliasedTaskBytes, "utf8");
  await fs.mkdir(path.join(fixture.execution, "tasks", "src"), { recursive: true });
  await fs.writeFile(path.join(fixture.execution, "tasks", "src/example.txt"), "ambiguous\n", "utf8");
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: semanticExecutionResponse,
      workspace,
      taskArtifact,
    }),
    /ambiguous across task and workspace bases/u,
  );
  await fs.rm(path.join(fixture.execution, "tasks", "src"), { recursive: true, force: true });
  await fs.writeFile(taskArtifact, canonicalTaskBytes, "utf8");
  const semanticBlockedExecutionResponse = JSON.stringify({
    ...semanticExecutionPayload,
    status: "BLOCKED",
    commands: [],
  });
  const blockedExecutionBundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE",
    response: semanticBlockedExecutionResponse,
    workspace,
    taskArtifact,
  });
  assert.match(blockedExecutionBundle, /^### implementation-check-01\n- Automatic check round: 1\/3\n- Status: BLOCKED/mu);
  assert.match(blockedExecutionBundle, /- Commands: none/u);
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: `Operation: EXECUTE_SLICE\n${semanticExecutionResponse}`,
      workspace,
      taskArtifact,
    }),
    /canonical JSON object/u,
  );
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: JSON.stringify({ ...semanticExecutionPayload, translatedStatus: "TESTS_PASS" }),
      workspace,
      taskArtifact,
    }),
    /unknown semantic execution payload field/u,
  );
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: JSON.stringify({ ...semanticExecutionPayload, commands: [{ command: "node --test", exit: "0" }] }),
      workspace,
      taskArtifact,
    }),
    /exit must be an integer/u,
  );
  const multiCommandRecordCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--record",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--target", physicalTarget,
    "--command", "node --test test/example.test.mjs", "--exit", "0",
    "--command", "node --test test/todo-store.test.mjs", "--exit", "0",
  ], { encoding: "utf8" });
  assert.equal(multiCommandRecordCli.status, 0, multiCommandRecordCli.stderr);
  assert.match(multiCommandRecordCli.stdout, /- `node --test test\/example\.test\.mjs` \| exit:0\n  - `node --test test\/todo-store\.test\.mjs` \| exit:0/u);
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: JSON.stringify({
        ...JSON.parse(semanticValidationResponse),
        verifiedScope: "localized scope",
      }),
      workspace,
      taskArtifact,
    }),
    /unknown semantic validation payload field: verifiedScope/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: `Type: initial\n${semanticValidationResponse}`,
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    }),
    /single raw JSON object/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundleFromResponse({
      operation: "VALIDATE_SLICE",
      response: [
        "Status: PASS",
        "Escopo verificado: localized scope",
        "HEAD: fixture-head",
        "Commands:",
        "  - `node --test test/example.test.mjs` | exit:0",
        "Evidence: focused validation passed",
        "Finding references: none",
        "Finding dispositions: none",
        "Blockers: none",
        "Unexpected workspace effects: none",
        "Persistence summary: semantic result returned",
      ].join("\n"),
      workspace,
      taskArtifact,
      specPath: fixture.requirements,
      slice: "1",
    }),
    /single raw JSON object/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundle({
      operation: "EXECUTE_SLICE",
      values: validationValues,
      workspace,
      taskArtifact,
      targets: [physicalTarget],
      commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    }),
    /validation bundle operation must be VALIDATE_SLICE/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundle({
      operation: "VALIDATE_SLICE",
      values: validationValues.slice(0, -1),
      workspace,
      taskArtifact,
      targets: [physicalTarget],
      commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    }),
    /exactly 10 values/u,
  );
  await assert.rejects(
    serializeRunnerValidationBundle({
      operation: "VALIDATE_SLICE",
      values: validationValues,
      workspace,
      taskArtifact,
      targets: [physicalTarget, physicalTarget],
      commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    }),
    /duplicate (?:task-relative claim|physical target)/u,
  );
  const validationBundleCliArgs = [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--validation-bundle", "--operation", "VALIDATE_SLICE",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
  ];
  for (const value of validationValues) validationBundleCliArgs.push("--value", value);
  validationBundleCliArgs.push("--target", physicalTarget, "--command", "node", "--test", "test/example.test.mjs", "--exit", "0");
  const validationBundleCli = spawnSync(process.execPath, validationBundleCliArgs, { encoding: "utf8" });
  assert.equal(validationBundleCli.status, 0, validationBundleCli.stderr);
  assert.equal(validationBundleCli.stdout.trimEnd(), validationBundle);
  const responseCliArgs = [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--response", "--operation", "EXECUTE_SLICE",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
  ];
  for (const [label, value] of Object.entries(responseFields)) {
    if (label !== "Operation") responseCliArgs.push("--value", value);
  }
  responseCliArgs.push("--target", physicalTarget, "--command", "node", "--test", "test/example.test.mjs", "--exit", "0");
  const responseCli = spawnSync(process.execPath, responseCliArgs, { encoding: "utf8" });
  assert.equal(responseCli.status, 0, responseCli.stderr);
  assert.equal(responseCli.stdout.trimEnd(), response);
  const translatedLabelCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"),
    "--response", "--operation", "EXECUTE_SLICE",
    "--workspace", workspace,
    "--task-artifact", taskArtifact,
    "--field", "Tipo de validação=1/3",
  ], { encoding: "utf8" });
  assert.equal(translatedLabelCli.status, 1);
  assert.match(translatedLabelCli.stderr, /unknown option --field/u);
  await assert.rejects(
    serializeRunnerResponse({ operation: "EXECUTE_SLICE", fields: { ...responseFields, Operation: "Operação" }, workspace, taskArtifact, targets: [physicalTarget], commands: [{ command: "node --test", exit: 0 }] }),
    /response Operation must be EXECUTE_SLICE/u,
  );
  await assert.rejects(
    serializeRunnerRecord({ workspace, taskArtifact, targets: [physicalTarget], commands: [{ command: "node `bad`", exit: 0 }] }),
    /single-line command without backticks/u,
  );
  await assert.rejects(
    serializeRunnerRecord({ workspace, taskArtifact, targets: [physicalTarget], commands: [] }),
    /at least one executed command/u,
  );
  await assert.rejects(
    serializeRunnerEvidence({ workspace, taskArtifact, targets: [physicalTarget, physicalTarget] }),
    /duplicate (?:task-relative claim|physical target)/u,
  );
  await assert.rejects(
    serializeRunnerEvidence({ workspace, taskArtifact, targets: [path.join(workspace, "src/missing.txt")] }),
    /not available/u,
  );

  const candidateRoot = path.join(await temporary(t, "stnl-runner-evidence-invalid-"), "execution");
  await fs.cp(fixture.execution, candidateRoot, { recursive: true });
  const candidateTask = path.join(candidateRoot, "tasks/slice-01.md");
  let invalidTask = await fs.readFile(candidateTask, "utf8");
  invalidTask = invalidTask.replace("- [ ] 1.1", "- [x] 1.1");
  invalidTask = replaceSection(invalidTask, "Changed Areas", "- `../../src/example.txt`");
  invalidTask = replaceSection(
    invalidTask,
    "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "TESTS_PASS", 1).replace(
      `sha256:${VALIDATED_HASH}`,
      `sha256:${"a".repeat(63)}`,
    ),
  );
  await fs.writeFile(candidateTask, invalidTask, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /malformed Tested state|unexpected nested or continuation content under Tested state/u,
  );
});

test("execution producer blocks omitted Changed Areas without inferring scope from the worktree", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskArtifact, "utf8");
  assert.match(before, /## Changed Areas\n\n- pending\n/u);
  await assert.rejects(
    serializeExecutionScopeClaims({ workspace: fixture.root, taskArtifact }),
    /Changed Areas cannot remain pending after execution work/u,
  );
  assert.equal(await fs.readFile(taskArtifact, "utf8"), before);

  const executorSkill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  assert.match(executorSkill, /`Changed Areas` MUST NOT remain the pristine `- pending` sentinel/u);
});

test("execution evidence is produced on a same-depth candidate and published as one task replacement", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveBefore = await fs.readFile(liveTask, "utf8");
  const prepared = await prepareExecutionCopy({ specPath: fixture.requirements, slice: "slice-01" });
  t.after(() => fs.rm(prepared.candidateRoot, { recursive: true, force: true }));
  assert.equal(path.dirname(prepared.candidateRoot), path.dirname(fixture.requirements));
  assert.equal(path.relative(prepared.candidateTaskArtifact, path.join(fixture.root, "src/example.txt")),
    path.relative(liveTask, path.join(fixture.root, "src/example.txt")));
  const target = path.join(fixture.root, "src/example.txt");
  const claim = path.relative(path.dirname(liveTask), target).split(path.sep).join("/");
  let candidateText = await fs.readFile(prepared.candidateTaskArtifact, "utf8");
  candidateText = candidateText.replace("- [ ] 1.1", "- [x] 1.1");
  candidateText = replaceSection(candidateText, "Changed Areas", `- \`${claim}\``);
  await fs.writeFile(prepared.candidateTaskArtifact, candidateText, "utf8");
  const response = JSON.stringify({
    status: "TESTS_PASS", automaticCheckRound: "1/3", head: "fixture-head",
    discoverySources: "task and package scripts", discoveryActions: "read-only inspection",
    verificationTypesConsidered: "unit tests", nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "not applicable",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    resultOfEachCommandAndExitCode: "all passed", selectedChecks: "node --test test/example.test.mjs",
    selectionRationale: "direct coverage", coverage: "changed behavior", failures: "none",
    priorRoundFailure: "none", correctionApplied: "none", inSliceRationale: "none",
    evidenceOrFailureSummary: "focused tests passed", affectedFilesOrBehaviors: "example behavior",
    blockers: "none", unexpectedWorkspaceEffects: "none", persistenceSummary: "record persisted",
  });
  const record = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE", response, workspace: fixture.root,
    taskArtifact: prepared.candidateTaskArtifact,
  });
  candidateText = await fs.readFile(prepared.candidateTaskArtifact, "utf8");
  await fs.writeFile(prepared.candidateTaskArtifact,
    replaceSection(candidateText, "Implementation Test Evidence", record), "utf8");
  assert.equal(await fs.readFile(liveTask, "utf8"), liveBefore);
  assert.equal((await validateExecutionCandidate(fixture.requirements, prepared.candidateExecutionRoot)).state,
    "IMPLEMENTED_AWAITING_VALIDATION");
  const published = await publishExecutionCopy({ specPath: fixture.requirements,
    slice: "slice-01", candidateRoot: prepared.candidateRoot });
  assert.equal(published.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.match(await fs.readFile(liveTask, "utf8"), /### implementation-check-01/u);
  await assert.rejects(fs.stat(prepared.candidateRoot), { code: "ENOENT" });
});

test("materializer candidate preparation copies the complete execution tree into an isolated root", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const prepared = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  assert.equal(prepared.status, "PASS");
  assert.notEqual(prepared.candidateExecutionRoot, await fs.realpath(fixture.execution));
  assert.equal(
    path.relative(await fs.realpath(fixture.execution), prepared.candidateExecutionRoot).startsWith(`..${path.sep}`),
    true,
  );
  for (const relative of ["plan.md", "plans/slice-01.md", "tasks.md", "tasks/slice-01.md"]) {
    assert.deepEqual(
      await fs.readFile(path.join(prepared.candidateExecutionRoot, relative)),
      await fs.readFile(path.join(fixture.execution, relative)),
    );
  }
  assert.equal(prepared.copiedEntries > 0, true);
  const alias = path.join(path.dirname(fixture.requirements), "requirements-alias");
  await fs.symlink(fixture.requirements, alias, "dir");
  await assert.rejects(
    prepareTaskMaterializationCandidate({ specPath: alias }),
    /symlink component/u,
  );
});

test("candidate helper CLIs execute from a frozen skill path containing spaces", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const root = await temporary(t, "stnl-helper-path-space-");
  const bundle = path.join(root, "frozen skill bundle");
  await fs.mkdir(bundle);
  for (const skill of ["stnl-execution-planner", "stnl-task-materializer"]) {
    await fs.cp(path.join(ROOT, "skills/workflows", skill), path.join(bundle, skill), { recursive: true });
  }
  const environment = { ...process.env, TMPDIR: root };
  const preparer = path.join(bundle, "stnl-task-materializer/runtime/prepare-task-candidate.mjs");
  const prepared = spawnSync(process.execPath, [preparer, "--prepare", "--spec-path", fixture.requirements], {
    encoding: "utf8", env: environment,
  });
  assert.equal(prepared.status, 0, prepared.stderr);
  const result = JSON.parse(prepared.stdout);
  assert.equal(result.status, "PASS");
  assert.equal(path.dirname(result.candidateExecutionRoot), root);
  assert.equal((await fs.lstat(path.join(result.candidateExecutionRoot, "plan.md"))).isFile(), true);
  for (const helper of [
    "stnl-execution-planner/runtime/prepare-plan-candidate.mjs",
    "stnl-execution-planner/runtime/serialize-plan-paths.mjs",
    "stnl-task-materializer/runtime/serialize-task-paths.mjs",
  ]) {
    const invoked = spawnSync(process.execPath, [path.join(bundle, helper)], { encoding: "utf8", env: environment });
    assert.notEqual(invoked.status, 0, `${helper} silently skipped its CLI guard`);
    assert.match(invoked.stderr, /usage:/u);
  }
});

test("materializer candidate publication revalidates and never publishes hard-linked execution files", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const prepared = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  const candidateState = await validateExecutionCandidate(fixture.requirements, prepared.candidateExecutionRoot);
  assert.equal(candidateState.state, "MATERIALIZED_PRISTINE");
  const published = await publishTaskMaterializationCandidate({
    specPath: fixture.requirements,
    candidateExecutionRoot: prepared.candidateExecutionRoot,
  });
  assert.equal(published.status, "PASS");
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  const liveTasks = path.join(fixture.execution, "tasks.md");
  const candidateTasks = path.join(prepared.candidateExecutionRoot, "tasks.md");
  const liveMetadata = await fs.lstat(liveTasks);
  const candidateMetadata = await fs.lstat(candidateTasks);
  assert.equal(liveMetadata.isFile(), true);
  assert.equal(candidateMetadata.isFile(), true);
  assert.equal(liveMetadata.nlink, 1);
  assert.equal(candidateMetadata.nlink, 1);
  assert.notEqual(liveMetadata.ino, candidateMetadata.ino);
  assert.deepEqual(await fs.readFile(liveTasks), await fs.readFile(candidateTasks));
});

test("materializer publication serializes task paths before strict candidate validation", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const prepared = await prepareTaskMaterializationCandidate({ specPath: fixture.requirements });
  const target = path.join(fixture.root, "src/example.txt");
  const taskPath = path.join(prepared.candidateExecutionRoot, "tasks/slice-01.md");
  const liveTaskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const canonicalTaskClaim = path.relative(path.dirname(liveTaskPath), target).split(path.sep).join("/");
  const malformedClaim = canonicalTaskClaim.replace(/^\.\.\//u, "");
  assert.notEqual(canonicalTaskClaim, malformedClaim);
  const before = await fs.readFile(taskPath, "utf8");
  const malformed = before.replace(`\`${canonicalTaskClaim}\``, `\`${malformedClaim}\``);
  assert.notEqual(malformed, before);
  await fs.writeFile(taskPath, malformed, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, prepared.candidateExecutionRoot),
    /possible path-basis error|artifact-relative implementation path/u,
  );

  const published = await publishTaskMaterializationCandidate({
    specPath: fixture.requirements,
    candidateExecutionRoot: prepared.candidateExecutionRoot,
  });
  assert.equal(published.status, "PASS");
  assert.equal(published.serializedTaskPaths, 1);
  const liveTask = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  assert.equal(liveTask.includes(`\`${canonicalTaskClaim}\``), true);
  assert.equal(liveTask.includes(`\`${malformedClaim}\``), false);
});

async function copyDirectory(source, destination) {
  await fs.cp(source, destination, { recursive: true });
  return destination;
}

function gitShowText(revision, file) {
  const result = spawnSync("git", ["show", `${revision}:${file}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function spawnResult(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, options);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function replaceAll(text, values) {
  let result = text;
  for (const [from, to] of values) result = result.replaceAll(from, to);
  return result;
}

async function standaloneWorkspace(t, { count = 1 } = {}) {
  const root = await temporary(t);
  const requirements = path.join(root, "requirements.md");
  await fs.writeFile(requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  const execution = path.join(root, "requirements-execution");
  return { root, requirements, execution, count };
}

async function rebasePlanClaimToTask({ specPath, planArtifact, planClaim, slice = "01" }) {
  const { executionRoot } = await resolveMaterializerExecutionWorkspace(specPath);
  const physicalTarget = path.resolve(path.dirname(planArtifact), planClaim);
  const taskPath = path.join(executionRoot, "tasks", `slice-${slice}.md`);
  const taskClaim = path.relative(path.dirname(taskPath), physicalTarget).split(path.sep).join("/");
  return { executionRoot, physicalTarget, taskPath, taskClaim };
}

function headerReady(text) {
  return text.replace("status: draft", "status: ready").replaceAll("Review state: pending", "Review state: approved");
}

function omitInitialRecoveryFields(text) {
  return text.replace(/\nFor revision 1,[\s\S]*?\n## Serial Slice Order/u, "\n## Serial Slice Order");
}

function setPlanReviewState(text, ready) {
  return text
    .replace(/^status: (?:draft|ready)$/mu, `status: ${ready ? "ready" : "draft"}`)
    .replace(/^- Review state: (?:pending|approved)$/gmu, `- Review state: ${ready ? "approved" : "pending"}`);
}

async function renderTasks(fixture, { revision = 1, fingerprint = null } = {}) {
  const authority = fingerprint ?? await computeRequirementsAuthority(fixture.requirements);
  const requirementsMetadata = await fs.stat(fixture.requirements);
  const authorityPath = requirementsMetadata.isDirectory() ? path.join(fixture.requirements, "feature_spec.md") : fixture.requirements;
  const detailSource = path.relative(path.join(fixture.execution, "plans"), authorityPath).split(path.sep).join("/");
  const implementationRoot = fixture.root ?? (requirementsMetadata.isDirectory() ? fixture.requirements : path.dirname(fixture.requirements));
  const taskImplementationPath = path.relative(
    path.join(fixture.execution, "tasks"),
    path.join(implementationRoot, "src/example.txt"),
  ).split(path.sep).join("/");
  await fs.mkdir(path.join(fixture.execution, "tasks"), { recursive: true });
  const tasksTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/tasks.template.md"), "utf8");
  const tasks = replaceAll(tasksTemplate, [
    ["01 - <name>", "01 - Delivery"], ["<observable delivery>", "observable result"],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks.md"), tasks);
  const taskTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  const task = replaceAll(taskTemplate, [
    ["<Name>", "Delivery"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", String(revision)],
    ["<task>", "Implement behavior"], ["<result>", "observable result"],
    ["`<artifact-relative path>`; <optional conceptual area>", `\`${taskImplementationPath}\`; example implementation`],
    ["<test, command, suite, or observable check>", "node --test"],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-01.md"), task);
}

async function renderArtifacts(fixture, { materialized = true, planStatus = "ready", revision = 1, fingerprint = null } = {}) {
  const authority = fingerprint ?? await computeRequirementsAuthority(fixture.requirements);
  const requirementsMetadata = await fs.stat(fixture.requirements);
  const authorityPath = requirementsMetadata.isDirectory() ? path.join(fixture.requirements, "feature_spec.md") : fixture.requirements;
  const globalSource = path.relative(fixture.execution, authorityPath).split(path.sep).join("/");
  const detailSource = path.relative(path.join(fixture.execution, "plans"), authorityPath).split(path.sep).join("/");
  const implementationRoot = fixture.root ?? (requirementsMetadata.isDirectory() ? fixture.requirements : path.dirname(fixture.requirements));
  const implementationTarget = path.join(implementationRoot, "src/example.txt");
  const globalImplementationPath = path.relative(fixture.execution, implementationTarget).split(path.sep).join("/");
  const detailImplementationPath = path.relative(path.join(fixture.execution, "plans"), implementationTarget).split(path.sep).join("/");
  await fs.mkdir(path.join(fixture.execution, "plans"), { recursive: true });
  const planTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  let global = omitInitialRecoveryFields(replaceAll(planTemplate, [
    ["`<relative path>`", `\`${globalSource}\``], ["sha256:<64hex>", `sha256:${authority}`],
    ["<positive integer>", String(revision)], ["<compact objective>", "Deliver observable behavior"],
    ["<compact strategy>", "Implement and validate serially"], ["01 - <name>", "01 - Delivery"],
    ["<result>", "observable result"],
    ["Model-selected physical target (repository-relative before serialization): `<repository-relative physical target>`; <optional conceptual area> (plain-text description)", `\`${globalImplementationPath}\`; example implementation (plain-text description)`],
  ]));
  if (planStatus === "ready") global = headerReady(global);
  await fs.writeFile(path.join(fixture.execution, "plan.md"), global);
  const slicePlanTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  let slicePlan = replaceAll(slicePlanTemplate, [
    ["<Name>", "Delivery"], ["`<relative path>`", `\`${detailSource}\``],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", String(revision)],
    ["<One coherent delivery and how it is observed.>", "Deliver observable behavior."],
    ["<included work>", "Implement the approved behavior."], ["<excluded work and boundary with later slices>", "No unrelated work."],
    ["`<artifact-relative path>` — <optional contract, subsystem, test area, or explanation>", `\`${detailImplementationPath}\` — example implementation`],
    ["<earlier slice or none>", "none"],
    ["<risk and mitigation>", "Low risk; focused validation."], ["<bounded approach>", "One bounded change."],
    ["<test, command, suite, or observable check>", "node --test"], ["<objective result and preserved boundary>", "Behavior is observable and bounded."],
  ]);
  if (planStatus === "ready") slicePlan = headerReady(slicePlan);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-01.md"), slicePlan);
  if (!materialized) return { authority };
  await renderTasks(fixture, { revision, fingerprint: authority });
  await fs.mkdir(path.dirname(implementationTarget), { recursive: true });
  await fs.writeFile(implementationTarget, VALIDATED_CONTENT, "utf8");
  return { authority };
}

async function setImplementationAreas(fixture, { global, detail, task } = {}) {
  if (global !== undefined) {
    await editPlan(fixture, (value) => value.replace(
      /`[^`\n]+`; example implementation/u,
      `\`${global}\`; example implementation`,
    ));
  }
  if (detail !== undefined) {
    await editSlicePlan(fixture, "slice-01", (value) => value.replace(
      /`[^`\n]+` — example implementation/u,
      `\`${detail}\` — example implementation`,
    ));
  }
  if (task !== undefined) {
    await editTask(fixture, (value) => value.replace(
      /(\| expected areas: )`[^`\n]+`; example implementation( \| requirement:)/u,
      `$1\`${task}\`; example implementation$2`,
    ));
  }
}

async function nestedLifecycleWorkspace(t, { materialized = true, planStatus = "ready" } = {}) {
  const root = await temporary(t, "stnl-path-semantics-");
  const repository = path.join(root, "repository with space ü");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const requirements = await copyDirectory(
    path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"),
    path.join(repository, "specs", "área segura", "feature Ω"),
  );
  const fixture = { root: repository, repository, requirements, execution: path.join(requirements, "execution") };
  await fs.mkdir(path.join(repository, "scripts"), { recursive: true });
  await fs.writeFile(path.join(repository, "scripts/validate.sh"), "#!/bin/sh\n", "utf8");
  await fs.mkdir(path.join(repository, "skills/workflows"), { recursive: true });
  await fs.writeFile(path.join(repository, "skills/workflows/example.mjs"), "export {};\n", "utf8");
  await renderArtifacts(fixture, { materialized, planStatus });
  return fixture;
}

async function editTask(fixture, transform) {
  const file = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(file, "utf8");
  await fs.writeFile(file, transform(before), "utf8");
}

async function editTasksIndex(fixture, transform) {
  const file = path.join(fixture.execution, "tasks.md");
  const before = await fs.readFile(file, "utf8");
  await fs.writeFile(file, transform(before), "utf8");
}

async function editPlan(fixture, transform) {
  const file = path.join(fixture.execution, "plan.md");
  await fs.writeFile(file, transform(await fs.readFile(file, "utf8")), "utf8");
}

async function editSlicePlan(fixture, slice, transform) {
  const file = path.join(fixture.execution, "plans", `${slice}.md`);
  await fs.writeFile(file, transform(await fs.readFile(file, "utf8")), "utf8");
}

function reviseAuthority(text, oldHash, newHash, oldRevision, newRevision) {
  return text.replaceAll(`sha256:${oldHash}`, `sha256:${newHash}`).replaceAll(`Plan revision: ${oldRevision}`, `Plan revision: ${newRevision}`);
}

async function stagePristineReplacement(fixture, oldHash, newHash, { ready = false } = {}) {
  await editPlan(fixture, (value) => {
    let result = reviseAuthority(value, oldHash, newHash, 1, 2).replace("- Review state: approved", `- Review state: ${ready ? "approved" : "pending"}`);
    result = result.replace("status: ready", `status: ${ready ? "ready" : "draft"}`);
    return result.replace("- Objective: Deliver observable behavior", `- Revision mode: pristine-replacement\n- Replan reason: task review found a plan-level defect\n- Supersedes open slices: none\n- Objective: Deliver observable behavior`);
  });
  await editSlicePlan(fixture, "slice-01", (value) => reviseAuthority(value, oldHash, newHash, 1, 2).replace("status: ready", `status: ${ready ? "ready" : "draft"}`).replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`));
}

async function replacePlanningOnly(fixture, oldHash, newHash, { ready = false } = {}) {
  await editPlan(fixture, (value) => setPlanReviewState(
    reviseAuthority(value, oldHash, newHash, 1, 1)
      .replace("- Objective: Deliver observable behavior", "- Objective: Deliver replacement planning authority"),
    ready,
  ));
  await editSlicePlan(fixture, "slice-01", (value) => setPlanReviewState(
    reviseAuthority(value, oldHash, newHash, 1, 1)
      .replace("Deliver observable behavior.", "Deliver replacement planning authority."),
    ready,
  ));
}

async function appendRecoveryPlan(fixture, oldHash, newHash, { ready = false, supersedes = "slice-01 -> slice-02" } = {}) {
  await editPlan(fixture, (value) => {
    let result = reviseAuthority(value, oldHash, newHash, 1, 2).replace("status: ready", `status: ${ready ? "ready" : "draft"}`).replace("- Review state: approved", `- Review state: ${ready ? "approved" : "pending"}`);
    result = result.replace("- Objective: Deliver observable behavior", `- Revision mode: append-only-extension\n- Replan reason: requirements or integration authority changed\n- Supersedes open slices: ${supersedes}\n- Objective: Deliver observable behavior`);
    return result.replace(
      "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |",
      "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |\n| 02 - Recovery | reconciled result | 01 | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-02.md |",
    );
  });
  // Historical plan/task authority remains immutable.
  await editSlicePlan(fixture, "slice-01", (value) => reviseAuthority(value, newHash, oldHash, 2, 1));
  const source = await fs.readFile(path.join(fixture.execution, "plans/slice-01.md"), "utf8");
  let appended = source
    .replaceAll("Slice 01", "Slice 02")
    .replaceAll("- Slice: 01", "- Slice: 02")
    .replaceAll("Delivery", "Recovery")
    .replaceAll(`sha256:${oldHash}`, `sha256:${newHash}`)
    .replaceAll("Plan revision: 1", "Plan revision: 2")
    .replace("status: ready", `status: ${ready ? "ready" : "draft"}`)
    .replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-02.md"), appended, "utf8");
}

async function commitAppendRecovery(fixture, oldHash, newHash, { resolveDivergence = false } = {}) {
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Final Result", "- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 2");
    if (resolveDivergence) result = replaceSection(result, "Divergences", `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: resolved")}\n- Resolution: plan revision 2 committed recovery slice-02`);
    return result;
  });
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | SUPERSEDED | SUPERSEDED |\n| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |",
  ));
  const template = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  const appended = replaceAll(template, [
    ["Slice 01", "Slice 02"], ["- Slice: 01", "- Slice: 02"], ["<Name>", "Recovery"],
    ["plans/slice-01.md", "plans/slice-02.md"], ["`<relative path>`", "`../../requirements.md`"],
    ["sha256:<64hex>", `sha256:${newHash}`], ["<positive integer>", "2"],
    ["<task>", "Reconcile behavior"], ["<result>", "reconciled result"],
    ["`<artifact-relative path>`; <optional conceptual area>", "`../../src/example.txt`; example implementation"],
    ["<test, command, suite, or observable check>", "node --test"],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-02.md"), appended, "utf8");
}

async function addSecondPristineSlice(fixture) {
  await editPlan(fixture, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |\n| 02 - Later | later result | 01 | AC-001 | `../src/later.txt`; later implementation (plain-text description) | plans/slice-02.md |",
  ));
  const plan = (await fs.readFile(path.join(fixture.execution, "plans/slice-01.md"), "utf8"))
    .replaceAll("Slice 01", "Slice 02").replaceAll("- Slice: 01", "- Slice: 02").replaceAll("Delivery", "Later");
  await fs.writeFile(path.join(fixture.execution, "plans/slice-02.md"), plan, "utf8");
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |\n| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |",
  ));
  const task = (await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8"))
    .replaceAll("Slice 01", "Slice 02").replaceAll("- Slice: 01", "- Slice: 02")
    .replaceAll("plans/slice-01.md", "plans/slice-02.md").replaceAll("Delivery", "Later").replace("1.1", "2.1");
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-02.md"), task, "utf8");
}

async function stageThirdRecovery(fixture, authority, { ready = false } = {}) {
  await editPlan(fixture, (value) => value
    .replace("status: ready", `status: ${ready ? "ready" : "draft"}`)
    .replace("Plan revision: 2", "Plan revision: 3")
    .replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`)
    .replace("- Supersedes open slices: slice-01 -> slice-02", "- Supersedes open slices: slice-02 -> slice-03")
    .replace(
      "| 02 - Recovery | reconciled result | 01 | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-02.md |",
      "| 02 - Recovery | reconciled result | 01 | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-02.md |\n| 03 - Recovery | reconciled result | 02 | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-03.md |",
    ));
  let plan = await fs.readFile(path.join(fixture.execution, "plans/slice-02.md"), "utf8");
  plan = plan.replaceAll("Slice 02", "Slice 03").replaceAll("- Slice: 02", "- Slice: 03")
    .replace("Plan revision: 2", "Plan revision: 3")
    .replace("status: ready", `status: ${ready ? "ready" : "draft"}`)
    .replace("Review state: approved", `Review state: ${ready ? "approved" : "pending"}`)
    .replaceAll(`sha256:${authority}`, `sha256:${authority}`);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-03.md"), plan, "utf8");
}

async function commitThirdRecovery(fixture, authority) {
  const secondPath = path.join(fixture.execution, "tasks/slice-02.md");
  await fs.writeFile(secondPath, replaceSection(await fs.readFile(secondPath, "utf8"), "Final Result", "- SUPERSEDED\n- Superseded by: slice-03\n- Plan revision: 3"), "utf8");
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |",
    "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | SUPERSEDED | SUPERSEDED |\n| [ ] | 03 - Recovery | reconciled result | 02 | tasks/slice-03.md | pending | pending |",
  ));
  const template = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/templates/slice-tasks.template.md"), "utf8");
  const third = replaceAll(template, [
    ["Slice 01", "Slice 03"], ["- Slice: 01", "- Slice: 03"], ["<Name>", "Recovery"],
    ["plans/slice-01.md", "plans/slice-03.md"], ["`<relative path>`", "`../../requirements.md`"],
    ["sha256:<64hex>", `sha256:${authority}`], ["<positive integer>", "3"],
    ["<task>", "Reconcile behavior again"], ["<result>", "reconciled result"],
    ["`<artifact-relative path>`; <optional conceptual area>", "`../../src/example.txt`; example implementation"],
    ["<test, command, suite, or observable check>", "node --test"], ["1.1", "3.1"],
  ]);
  await fs.writeFile(path.join(fixture.execution, "tasks/slice-03.md"), third, "utf8");
}

function replaceSection(text, heading, content) {
  const pattern = new RegExp(`(## ${heading}\\n\\n)[\\s\\S]*?(?=\\n## |$)`, "u");
  assert.match(text, pattern);
  return text.replace(pattern, `$1${content}\n`);
}

const ACTIVE_FINDING = `### finding-01

- Severity: blocking
- State: active
- Origin: attempt-01
- Problem: Observable behavior is wrong.
- Evidence: Focused validation reproduced the mismatch.
- Impact: AC-001 is not satisfied.
- Related authority: AC-001 and slice-01
- Expected correction: Produce the required behavior.`;

const ACTIVE_FINDING_02 = ACTIVE_FINDING
  .replaceAll("finding-01", "finding-02")
  .replace("Observable behavior is wrong.", "A second observable behavior is wrong.");

const ACTIVE_DIVERGENCE = `### divergence-01

- Severity: blocking
- State: active
- Origin: EXECUTE_SLICE
- Problem: Approved scope omits a required dependency.
- Evidence: The implementation cannot remain inside the slice.
- Required authority operation: REPLAN`;

function attemptRecord(number, status, { type = number === 1 ? "initial" : "revalidation", references = "none", dispositions = "none", command = "node --test", evidence = `Objective ${status} evidence.` } = {}) {
  const id = String(number).padStart(2, "0");
  const commands = status === "BLOCKED" ? "- Commands: none" : `- Commands:\n  - \`${command}\` | exit:0`;
  return `### attempt-${id}

- Type: ${type}
- Status: ${status}
- HEAD: fixture
- Verified scope: ../../src/example.txt
- ${commands.slice(2)}
- Evidence: ${evidence}
- Finding references: ${references}
- Finding dispositions: ${dispositions}
- Blockers: none
- Unexpected workspace effects: none
- Persistence summary: ${status} persisted.`;
}

function checkRecord(prefix, number, status, round, { cycle = null } = {}) {
  const id = String(number).padStart(2, "0");
  const commands = new Set(["TESTS_NOT_APPLICABLE", "BLOCKED"]).has(status)
    ? "- Commands: none"
    : `- Commands:\n  - \`node --test\` | exit:${status === "TESTS_PASS" ? 0 : 1}`;
  const findings = prefix === "findings-check" ? `
- Findings cycle: ${cycle}
- Finding IDs: finding-01
- Findings verified: finding-01
- Corrections covered: ../../src/example.txt
- Regressions: none
- Unsupported active findings: none` : "";
  const nonApplicable = status === "TESTS_NOT_APPLICABLE" ? `
- Non-applicability rationale: no executable verification applies to this documentary-only change
- No verification-command confirmation: no verification command was executed` : "";
  return `### ${prefix}-${id}

- Automatic check round: ${round}/3
- Status: ${status}
- HEAD: fixture
- Tested scope: ../../src/example.txt
- Tested state:
  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}
- Discovery sources: approved task and repository tests
- Discovery actions: inspected applicable test commands
- Verification types considered: focused automated test
${commands}
- Selected checks: node --test
- Selection rationale: focused authoritative behavior check
- Coverage: AC-001 observable behavior
- Failures: ${status === "TESTS_FAIL" ? "observable mismatch" : "none"}
- Blockers: ${status === "BLOCKED" ? "external prerequisite unavailable" : "none"}
- Unexpected workspace effects: none
- Persistence summary: ${status} persisted.${round > 1 ? `
- Prior-round failure: prior verification command failed
- Correction applied: bounded objective correction
- Correction paths: ../../src/example.txt
- Updated scope: ../../src/example.txt
- In-slice rationale: correction remains within AC-001` : ""}${findings}${nonApplicable}`;
}

const PASS_ATTEMPT = attemptRecord(1, "PASS");
const NEEDS_FIX_ATTEMPT = attemptRecord(1, "NEEDS_FIX", { references: "finding-01", dispositions: "finding-01=active" });
const BLOCKED_ATTEMPT = attemptRecord(1, "BLOCKED");

const VALIDATED_CONTENT = "validated behavior\n";
const VALIDATED_HASH = createHash("sha256").update(VALIDATED_CONTENT).digest("hex");

async function writeValidatedPath(fixture, relative = "../../src/example.txt", content = VALIDATED_CONTENT) {
  const target = path.resolve(fixture.execution, "tasks", relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

function passBase({ attempt = 1, relative = "../../src/example.txt", hash = VALIDATED_HASH, removed = false } = {}) {
  const identifier = `attempt-${String(attempt).padStart(2, "0")}`;
  return `- Origin attempt: ${identifier}
- Attempt type: ${attempt === 1 ? "initial" : "revalidation"}
- HEAD: fixture
- Result: PASS
- Files:
  - \`${relative}\` | ${removed ? "REMOVED" : `sha256:${hash}`}
- Authoritative commands:
  - \`node --test\` | exit:0
- Evidence summary: Objective PASS evidence.`;
}

const PASS_BASE = passBase();

function publishPassResult(text) {
  return replaceSection(
    replaceSection(text, "Diff Summary", "- Implemented and validated the observable behavior."),
    "Final Result",
    "- PASS",
  );
}

function delegationBlocker(operation, kind, { state = "active", after = "none", resolution = null } = {}) {
  return `- Operation: ${operation}
- Kind: ${kind}
- State: ${state}
- After record: ${after}
- Causes:
  - configured independent runner could not produce a valid result
- Required action: retry the same operation after restoring the runner${resolution === null ? "" : `\n- Resolution: ${resolution}`}`;
}

async function rejectedWithRecovery(promise, expected) {
  let captured = null;
  await assert.rejects(promise, (error) => {
    captured = error;
    assert.match(error.message, expected);
    return true;
  });
  assert.ok(captured instanceof ExecutionContractError);
  return captured;
}

function assertRecoveryTarget(result, expected) {
  const target = result.recoveryTargets.find((candidate) => (
    candidate.operation === expected.operation && candidate.slice === (expected.slice ?? null)
  ));
  assert.ok(target, `missing recovery target ${expected.operation} ${expected.slice ?? "unscoped"}`);
  for (const [field, value] of Object.entries(expected)) assert.equal(target[field], value, `${field} disagrees`);
  return target;
}

async function passFirstSlice(fixture) {
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await writeValidatedPath(fixture);
}

async function prepareFindingsCorrection(fixture, findingIdsLabel = "Finding IDs") {
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    const check = checkRecord("findings-check", 1, "TESTS_NOT_APPLICABLE", 1, { cycle: "attempt-01" })
      .replace("- Finding IDs: finding-01", `- ${findingIdsLabel}: finding-01`);
    return replaceSection(result, "Findings Test Evidence", check);
  });
}

test("all execution skills bundle byte-identical self-contained state runtimes", async () => {
  const stateSkills = [...SKILLS, "stnl-spec-roadmap", "stnl-spec-test-runbook"];
  for (const [name, skillNames] of [["execution-state.mjs", stateSkills], ["validate-execution-state.mjs", SKILLS]]) {
    const copies = await Promise.all(skillNames.map((skill) => fs.readFile(path.join(ROOT, "skills", "workflows", skill, "runtime", name))));
    for (const copy of copies.slice(1)) assert.deepEqual(copy, copies[0], `${name} copies differ`);
    const source = copies[0].toString("utf8");
    assert.doesNotMatch(source, /stnl-spec-lifecycle-manager|\.\.\/\.\.\//u);
  }
});

test("distributed validation evidence serializers remain byte-identical across isolated skills", async () => {
  const executor = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs"));
  const qualityManager = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/serialize-runner-evidence.mjs"));
  assert.deepEqual(qualityManager, executor);
});

test("an isolated copied skill runs the stable self-contained preflight CLI", async (t) => {
  const root = await temporary(t);
  const copied = path.join(root, "copied-skill");
  await fs.mkdir(path.join(copied, "runtime"), { recursive: true });
  for (const name of ["execution-state.mjs", "validate-execution-state.mjs"]) {
    await fs.copyFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime", name), path.join(copied, "runtime", name));
  }
  const requirements = path.join(root, "requirements.md");
  await fs.writeFile(requirements, "# Isolated requirements\n");
  const result = spawnSync(process.execPath, [path.join(copied, "runtime/validate-execution-state.mjs"), requirements, "PLAN"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^PASS: PLAN preflight state=EMPTY authority=sha256:[0-9a-f]{64}$/mu);

  const materialized = await standaloneWorkspace(t);
  await renderArtifacts(materialized);
  const afterMaterialize = spawnSync(process.execPath, [
    path.join(copied, "runtime/validate-execution-state.mjs"),
    materialized.requirements,
    "--handoff-after",
    "MATERIALIZE_TASKS",
  ], { encoding: "utf8", cwd: root });
  assert.equal(afterMaterialize.status, 0, afterMaterialize.stderr);
  const materializeTransition = JSON.parse(afterMaterialize.stdout);
  assert.equal(materializeTransition.normal_handoff.workflowSkill, "stnl-task-reviewer");
  assert.equal(materializeTransition.normal_handoff.invocation, "OPERATION=REVIEW_TASKS");
  assert.deepEqual(new Set(materializeTransition.legal_operations.map(({ operation }) => operation)), new Set([
    "REVIEW_TASKS", "EXECUTE_SLICE", "REPLAN",
  ]));

  const afterReview = spawnSync(process.execPath, [
    path.join(copied, "runtime/validate-execution-state.mjs"),
    materialized.requirements,
    "--handoff-after",
    "REVIEW_TASKS",
  ], { encoding: "utf8", cwd: root });
  assert.equal(afterReview.status, 0, afterReview.stderr);
  const reviewTransition = JSON.parse(afterReview.stdout);
  assert.equal(reviewTransition.normal_handoff.workflowSkill, "stnl-slice-executor");
  assert.equal(reviewTransition.normal_handoff.invocation, "OPERATION=EXECUTE_SLICE");
  assert.equal(reviewTransition.normal_handoff.slice, "slice-01");
});

test("every touched model-authored execution writer requires candidate validation and strict readback", async () => {
  for (const skill of SKILLS) {
    const source = await fs.readFile(path.join(ROOT, `skills/workflows/${skill}/SKILL.md`), "utf8");
    if (["stnl-execution-planner", "stnl-plan-reviewer"].includes(skill)) {
      assert.match(source, /serialize-plan-paths\.mjs[\s\S]{0,500}official `validateExecutionCandidate` authority/u, skill);
      assert.doesNotMatch(source, /validate-execution-state\.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>/u, skill);
    } else {
      assert.match(source, /validate-execution-state\.mjs" <SPEC_PATH> --candidate <CANDIDATE_EXECUTION_ROOT>/u, skill);
      assert.match(source, /contract\/model(?:-| )(?:enforced|enforcement|owned)/u, skill);
    }
    assert.match(source, /strict(?:ly)? read(?:back| back)/u, skill);
    assert.match(source, /Findings IDs[\s\S]{0,180}Check discovery sources[\s\S]{0,80}Check discovery actions[\s\S]{0,240}--repair-known-contract/u, skill);
  }
});

test("executor producer instructions require complete computed Tested state digests", async () => {
  const skill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-slice-executor/SKILL.md"), "utf8");
  assert.match(skill, /file-backed[\s\S]{0,260}digest[\s\S]{0,260}64[- ]hex/u);
  assert.match(skill, /Never hand-type, truncate/u);
});

test("the last VALIDATE_SLICE owns bounded global semantic review before terminal PASS", async () => {
  const source = await fs.readFile(
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/SKILL.md"),
    "utf8",
  );
  assert.match(source, /last open effective slice[\s\S]{0,700}global plan and serial order[\s\S]{0,500}Effective Validation Bases/iu);
  assert.match(source, /global requirements coverage[\s\S]{0,180}current authority[\s\S]{0,180}cross-slice consistency[\s\S]{0,220}integration or stabilization/iu);
  assert.match(source, /Missing authority, strategy, or unmaterialized integration work[\s\S]{0,180}`BLOCKED`[\s\S]{0,160}`REPLAN`/iu);
  assert.doesNotMatch(source, /GLOBAL_VALIDATE|FINALIZE_EXECUTION|stnl-execution-closer|OPERATION=CLOSE/u);
});

test("actual templates render a machine-unambiguous MATERIALIZED_PRISTINE task", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const task = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"), "utf8");
  assert.doesNotMatch(task, /^### (?:implementation-check|findings-check|attempt)-/gmu);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_TASKS")).state, "MATERIALIZED_PRISTINE");
});

test("normal workflow sequence is operation-aware and preserves independent legality", async (t) => {
  const registryProjection = Object.fromEntries(Object.entries(WORKFLOW_OPERATIONS)
    .filter(([skill]) => EXECUTION_OPERATION_SKILLS.includes(skill))
    .flatMap(([skill, operations]) => operations
      .map((operation) => [operation, skill])));
  assert.deepEqual(EXECUTION_WORKFLOW_SKILLS, registryProjection);
  for (const [operation, skill] of Object.entries(registryProjection)) assert.equal(workflowSkillForOperation(operation), skill);
  assert.throws(() => workflowSkillForOperation("GENERATE_RUNBOOK"), /no workflow skill owns/u);
  assert.throws(() => workflowSkillForOperation("INIT"), /no workflow skill owns/u);
  assert.throws(() => workflowSkillForOperation("RECONCILE"), /no workflow skill owns/u);

  const empty = await standaloneWorkspace(t);
  const emptyState = await inspectExecutionState(empty.requirements);
  assert.deepEqual(emptyState.legalOperations.map(({ operation }) => operation), ["PLAN"]);
  assert.deepEqual(emptyState.normalHandoff, {
    workflowSkill: "stnl-execution-planner",
    operation: "PLAN",
    invocation: "OPERATION=PLAN",
    slice: null,
  });

  const draft = await standaloneWorkspace(t);
  await renderArtifacts(draft, { materialized: false, planStatus: "draft" });
  const draftState = await inspectExecutionState(draft.requirements);
  assert.deepEqual(draftState.legalOperations.map(({ operation }) => operation), ["REVIEW_PLAN", "REPLAN"]);
  assert.equal(deriveNormalHandoff(draftState, "PLAN").workflowSkill, "stnl-plan-reviewer");
  assert.equal(deriveNormalHandoff(draftState, "PLAN").invocation, "OPERATION=REVIEW_PLAN");

  const ready = await standaloneWorkspace(t);
  await renderArtifacts(ready, { materialized: false, planStatus: "ready" });
  const readyState = await inspectExecutionState(ready.requirements);
  assert.deepEqual(readyState.legalOperations.map(({ operation }) => operation), ["REVIEW_PLAN", "MATERIALIZE_TASKS", "REPLAN"]);
  assert.equal(deriveNormalHandoff(readyState, "REVIEW_PLAN").workflowSkill, "stnl-task-materializer");
  assert.equal(deriveNormalHandoff(readyState, "REVIEW_PLAN").invocation, "OPERATION=MATERIALIZE_TASKS");

  const materialized = await standaloneWorkspace(t);
  await renderArtifacts(materialized);
  const materializedState = await inspectExecutionState(materialized.requirements);
  assert.deepEqual(materializedState.legalOperations.map(({ operation }) => operation), ["REVIEW_TASKS", "REPLAN", "EXECUTE_SLICE"]);
  assert.equal(materializedState.normalHandoff, null, "persisted state alone cannot prove whether task review ran");
  const afterMaterialize = deriveNormalHandoff(materializedState, "MATERIALIZE_TASKS");
  assert.equal(afterMaterialize.workflowSkill, "stnl-task-reviewer");
  assert.equal(afterMaterialize.invocation, "OPERATION=REVIEW_TASKS");
  assert.equal(afterMaterialize.slice, null);
  const afterReview = deriveNormalHandoff(materializedState, "REVIEW_TASKS");
  assert.equal(afterReview.workflowSkill, "stnl-slice-executor");
  assert.equal(afterReview.invocation, "OPERATION=EXECUTE_SLICE");
  assert.equal(afterReview.slice, "slice-01");
});

test("PLAN requires active lifecycle ready while standalone EMPTY remains available", async (t) => {
  const root = await temporary(t, "stnl-lifecycle-plan-gate-");
  const lifecycleFixtures = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures");
  const ready = await copyDirectory(path.join(lifecycleFixtures, "ready"), path.join(root, "ready"));
  assert.equal((await preflightExecutionOperation(ready, "PLAN")).state, "EMPTY");

  const draft = await copyDirectory(path.join(lifecycleFixtures, "ready"), path.join(root, "draft"));
  const draftFeature = path.join(draft, "feature_spec.md");
  await fs.writeFile(draftFeature, (await fs.readFile(draftFeature, "utf8")).replace("status: ready", "status: draft"), "utf8");
  const draftInspection = await inspectExecutionState(draft);
  assert.equal(draftInspection.state, "EMPTY");
  assert.equal(draftInspection.lifecycleStatus, "draft");
  assert.deepEqual(draftInspection.legalOperations, []);
  assert.equal(draftInspection.normalHandoff, null);
  await assert.rejects(preflightExecutionOperation(draft, "PLAN"), /lifecycle status draft.*PLAN requires ready/u);

  const blocked = await copyDirectory(path.join(lifecycleFixtures, "blocked"), path.join(root, "blocked"));
  const blockedInspection = await inspectExecutionState(blocked);
  assert.equal(blockedInspection.state, "EMPTY");
  assert.equal(blockedInspection.lifecycleStatus, "blocked");
  assert.deepEqual(blockedInspection.legalOperations, []);
  assert.equal(blockedInspection.normalHandoff, null);
  await assert.rejects(preflightExecutionOperation(blocked, "PLAN"), /lifecycle status blocked.*PLAN requires ready/u);

  const standalone = await standaloneWorkspace(t);
  assert.equal((await preflightExecutionOperation(standalone.requirements, "PLAN")).state, "EMPTY");
});

test("requirements changes during pending REPLAN draft or ready recover through REQUIREMENTS_CHANGED", async (t) => {
  for (const ready of [false, true]) {
    const root = await temporary(t, `stnl-pending-authority-${ready ? "ready" : "draft"}-`);
    const fixtureRoot = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready");
    const workspace = await copyDirectory(fixtureRoot, path.join(root, "spec"));
    const fixture = { requirements: workspace, execution: path.join(workspace, "execution") };
    const { authority } = await renderArtifacts(fixture);
    await stagePristineReplacement(fixture, authority, authority, { ready });
    assert.equal((await inspectExecutionState(workspace)).state, ready ? "PENDING_REPLAN_READY" : "PENDING_REPLAN_DRAFT");
    const pendingPlan = await fs.readFile(path.join(fixture.execution, "plan.md"));

    const requirements = path.join(workspace, "shared/requirements.md");
    await fs.appendFile(requirements, "\nDocumentary requirement clarified by lifecycle RESUME.\n", "utf8");
    const changed = await inspectExecutionState(workspace);
    assert.equal(changed.state, "REQUIREMENTS_CHANGED");
    assertRecoveryTarget(changed, { operation: "REPLAN", slice: null, owner: "requirements-authority" });
    await assert.rejects(
      preflightExecutionOperation(workspace, ready ? "MATERIALIZE_TASKS" : "REVIEW_PLAN"),
      /not legal from REQUIREMENTS_CHANGED/u,
    );
    assert.deepEqual(await fs.readFile(path.join(fixture.execution, "plan.md")), pendingPlan);
  }
});

test("MATERIALIZE_TASKS hands preserved validable frontiers to concrete validation", async (t) => {
  const implemented = await standaloneWorkspace(t);
  await renderArtifacts(implemented);
  await editTask(implemented, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  const implementedState = await inspectExecutionState(implemented.requirements);
  assert.deepEqual(deriveNormalHandoff(implementedState, "MATERIALIZE_TASKS"), {
    workflowSkill: "stnl-slice-quality-manager",
    operation: "VALIDATE_SLICE",
    invocation: "OPERATION=VALIDATE_SLICE",
    slice: "slice-01",
  });

  const corrected = await standaloneWorkspace(t);
  await renderArtifacts(corrected);
  await prepareFindingsCorrection(corrected);
  const correctedState = await inspectExecutionState(corrected.requirements);
  assert.deepEqual(deriveNormalHandoff(correctedState, "MATERIALIZE_TASKS"), {
    workflowSkill: "stnl-slice-quality-manager",
    operation: "VALIDATE_SLICE",
    invocation: "OPERATION=VALIDATE_SLICE",
    slice: "slice-01",
  });
});

test("RESUME remains lifecycle recovery authority before execution REPLAN is derived", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const lifecycleDivergence = ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: RESUME");
  await editTask(fixture, (value) => replaceSection(value, "Divergences", lifecycleDivergence));
  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "DIVERGENCE_BLOCKED");
  assert.deepEqual(blocked.legalOperations, []);
  assert.deepEqual(blocked.requiredRecoveryHandoff, {
    owner: "lifecycle",
    operation: null,
    invocation: "MODE=RESUME",
    slice: "slice-01",
    record: "divergence-01",
  });
  assert.equal(JSON.stringify(blocked).includes("OPERATION=RESUME"), false);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "REPLAN"), /lifecycle MODE=RESUME/u);
});

test("two lifecycle RESUME records preserve both identities while sharing one handoff", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const first = ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: RESUME");
  const second = first.replaceAll("divergence-01", "divergence-02").replace(
    "Approved scope omits a required dependency.",
    "A second persisted authority divergence requires lifecycle recovery.",
  );
  await editTask(fixture, (value) => replaceSection(value, "Divergences", `${first}\n\n${second}`));
  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "DIVERGENCE_BLOCKED");
  assert.deepEqual(blocked.recoveryTargets.map(({ record }) => record), ["divergence-01", "divergence-02"]);
  assert.deepEqual(blocked.legalOperations, []);
  assert.deepEqual(blocked.requiredRecoveryHandoff, {
    owner: "lifecycle",
    operation: null,
    invocation: "MODE=RESUME",
    slice: "slice-01",
    record: null,
  });
});

test("exact legacy Findings IDs corruption is structured, mechanically repaired, and semantically neutral", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskPath, "utf8");

  let strictError;
  await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
    strictError = error;
    assert.equal(error.contractViolation.kind, "non-canonical-field");
    assert.equal(error.contractViolation.record, "findings-check-01");
    assert.equal(error.contractViolation.expectedField, "Finding IDs");
    assert.equal(error.contractViolation.foundField, "Findings IDs");
    assert.equal(error.contractViolation.repairability, "mechanical");
    return true;
  });
  assert.ok(strictError instanceof ExecutionContractError);

  const repair = await repairExecutionContract(fixture.requirements);
  assert.equal(repair.status, "REPAIRED");
  assert.equal(repair.repairs.length, 1);
  const after = await fs.readFile(taskPath, "utf8");
  assert.equal(after, before.replace("- Findings IDs: finding-01", "- Finding IDs: finding-01"));
  assert.equal(after.replace("- Finding IDs: finding-01", "- Findings IDs: finding-01"), before);

  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "FINDINGS_CORRECTED");
  assert.deepEqual(recovered.activeFindings, ["slice-01:finding-01"]);
  assert.equal(recovered.tasks.get("slice-01").attempts.length, 1);
  assert.equal(recovered.tasks.get("slice-01").findingsChecks.length, 1);
  assert.equal(recovered.tasks.get("slice-01").findings[0].state, "active");
  assert.equal(recovered.tasks.get("slice-01").base.present, false);
  assert.equal(recovered.tasks.get("slice-01").final.result, "pending");
  assert.equal(recovered.normalHandoff.invocation, "OPERATION=VALIDATE_SLICE");
  assert.equal(recovered.normalHandoff.slice, "slice-01");
});

test("exact historical discovery label pair is losslessly repaired while ambiguity stays blocked", async (t) => {
  const legacy = await standaloneWorkspace(t);
  await renderArtifacts(legacy);
  await editTask(legacy, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace("- Discovery sources:", "- Check discovery sources:")
      .replace("- Discovery actions:", "- Check discovery actions:"));
  });
  const taskPath = path.join(legacy.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskPath, "utf8");
  await assert.rejects(inspectExecutionState(legacy.requirements), (error) => {
    assert.equal(error.contractViolation.kind, "legacy-discovery-labels");
    assert.equal(error.contractViolation.repairability, "mechanical");
    return true;
  });
  const repair = await repairExecutionContract(legacy.requirements);
  assert.equal(repair.status, "REPAIRED");
  const after = await fs.readFile(taskPath, "utf8");
  assert.equal(after, before
    .replace("- Check discovery sources:", "- Discovery sources:")
    .replace("- Check discovery actions:", "- Discovery actions:"));
  assert.equal((await inspectExecutionState(legacy.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const coexistence = await standaloneWorkspace(t);
  await renderArtifacts(coexistence);
  await editTask(coexistence, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace("- Discovery sources:", "- Discovery sources: canonical\n- Check discovery sources:")
      .replace("- Discovery actions:", "- Discovery actions: canonical\n- Check discovery actions:"));
  });
  await assert.rejects(inspectExecutionState(coexistence.requirements), (error) => {
    assert.equal(error.contractViolation.repairability, "blocked");
    return true;
  });

  const typo = await standaloneWorkspace(t);
  await renderArtifacts(typo);
  await editTask(typo, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace("- Discovery sources:", "- Discovery sourcez:"));
  });
  await assert.rejects(inspectExecutionState(typo.requirements), /Discovery sources|unknown field/u);
});

test("one explicit repair pass handles every approved alias in one task artifact", async (t) => {
  const sameRecord = await standaloneWorkspace(t);
  await renderArtifacts(sameRecord);
  await prepareFindingsCorrection(sameRecord, "Findings IDs");
  await editTask(sameRecord, (value) => value
    .replace("- Discovery sources:", "- Check discovery sources:")
    .replace("- Discovery actions:", "- Check discovery actions:"));
  const sameRecordPath = path.join(sameRecord.execution, "tasks/slice-01.md");
  const sameRecordBefore = await fs.readFile(sameRecordPath, "utf8");
  const sameRecordRepair = await repairExecutionContract(sameRecord.requirements);
  assert.equal(sameRecordRepair.status, "REPAIRED");
  assert.equal(sameRecordRepair.repairs.length, 2);
  assert.equal(await fs.readFile(sameRecordPath, "utf8"), sameRecordBefore
    .replace("- Check discovery sources:", "- Discovery sources:")
    .replace("- Check discovery actions:", "- Discovery actions:")
    .replace("- Findings IDs:", "- Finding IDs:"));
  assert.equal((await inspectExecutionState(sameRecord.requirements)).state, "FINDINGS_CORRECTED");

  const multipleRecords = await standaloneWorkspace(t);
  await renderArtifacts(multipleRecords);
  await editTask(multipleRecords, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    const legacy = (record) => record
      .replace("- Discovery sources:", "- Check discovery sources:")
      .replace("- Discovery actions:", "- Check discovery actions:");
    return replaceSection(result, "Implementation Test Evidence", [
      legacy(checkRecord("implementation-check", 1, "TESTS_FAIL", 1)),
      legacy(checkRecord("implementation-check", 2, "TESTS_PASS", 2)),
    ].join("\n\n"));
  });
  const multipleRepair = await repairExecutionContract(multipleRecords.requirements);
  assert.equal(multipleRepair.status, "REPAIRED");
  assert.equal(multipleRepair.repairs.length, 2);
  assert.equal((await inspectExecutionState(multipleRecords.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("contract repair never overwrites a writer in the final source-to-publication window", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");

  // Keep the source-to-publication window open without changing the artifact grammar.
  await editTask(fixture, (value) => value.replace(
    "- Problem: Observable behavior is wrong.",
    `- Problem: ${"x".repeat(32 * 1024 * 1024)}`,
  ));

  const concurrentBytes = Buffer.from("CONCURRENT WRITER WON\n", "utf8");
  let mutationResolve;
  let mutationReject;
  const mutation = new Promise((resolve, reject) => {
    mutationResolve = resolve;
    mutationReject = reject;
  });
  let fired = false;
  const watcher = watch(path.dirname(taskPath), (_event, filename) => {
    if (fired || filename === null
      || !String(filename).startsWith("slice-01.md.stnl-contract-repair-")) return;
    fired = true;
    fs.writeFile(taskPath, concurrentBytes).then(mutationResolve, mutationReject);
  });
  t.after(() => watcher.close());

  const outcome = await repairExecutionContract(fixture.requirements).then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
  await mutation;
  assert.equal(fired, true);
  assert.ok(outcome.error instanceof ExecutionContractError,
    `repair unexpectedly published: ${JSON.stringify(outcome.result)}`);
  assert.match(outcome.error.message, /source changed|concurrent source|publication aborted/u);
  assert.deepEqual(await fs.readFile(taskPath), concurrentBytes);
});

test("contract repair rejects a source mutation at critical-section entry", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  await editTask(fixture, (value) => value.replace(
    "- Problem: Observable behavior is wrong.",
    `- Problem: ${"x".repeat(32 * 1024 * 1024)}`,
  ));

  const lockPath = `${fixture.execution}.stnl-contract-repair.lock`;
  const concurrentBytes = Buffer.from("PRE-CRITICAL WRITER WON\n", "utf8");
  let fired = false;
  let mutation = null;
  const watcher = watch(path.dirname(lockPath), (_event, filename) => {
    if (fired || filename === null || String(filename) !== path.basename(lockPath)) return;
    fired = true;
    mutation = fs.writeFile(taskPath, concurrentBytes);
  });
  t.after(() => watcher.close());

  const outcome = await repairExecutionContract(fixture.requirements).then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
  assert.equal(fired, true);
  await mutation;
  assert.ok(outcome.error instanceof ExecutionContractError,
    `repair unexpectedly published: ${JSON.stringify(outcome.result)}`);
  assert.match(outcome.error.message, /source changed|concurrent source|publication aborted/u);
  assert.deepEqual(await fs.readFile(taskPath), concurrentBytes);
});

test("strict readback failure rolls back only the repair-owned publication", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const tasksIndexPath = path.join(fixture.execution, "tasks.md");
  await editTask(fixture, (value) => value.replace(
    "- Problem: Observable behavior is wrong.",
    `- Problem: ${"x".repeat(32 * 1024 * 1024)}`,
  ));
  const sourceBytes = await fs.readFile(taskPath);
  const foreignIndexBytes = Buffer.from("CONCURRENT TASK INDEX WON\n", "utf8");

  let fired = false;
  let mutation = null;
  const watcher = watch(path.dirname(taskPath), (_event, filename) => {
    if (fired || filename === null
      || !String(filename).startsWith("slice-01.md.stnl-contract-repair-stage-")) return;
    fired = true;
    writeFileSync(tasksIndexPath, foreignIndexBytes);
    mutation = Promise.resolve();
  });
  t.after(() => watcher.close());

  const outcome = await spawnResult(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "--repair-known-contract",
  ], { cwd: fixture.root });
  assert.equal(fired, true);
  await mutation;
  assert.equal(outcome.status, 1, `repair unexpectedly passed strict readback: ${outcome.stdout}`);
  assert.match(outcome.stderr, /BLOCKED:/u);
  assert.deepEqual(await fs.readFile(taskPath), sourceBytes, "owned publication was not rolled back");
  assert.deepEqual(await fs.readFile(tasksIndexPath), foreignIndexBytes, "foreign readback mutation was overwritten");
});

test("contract repair preserves a foreign replacement of its lock identity", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  await editTask(fixture, (value) => value.replace(
    "- Problem: Observable behavior is wrong.",
    `- Problem: ${"x".repeat(32 * 1024 * 1024)}`,
  ));
  const sourceBytes = await fs.readFile(taskPath);
  const lockPath = `${fixture.execution}.stnl-contract-repair.lock`;
  const displacedLockPath = `${lockPath}.displaced-by-test`;
  const foreignLockBytes = Buffer.from("FOREIGN LOCK OWNER\n", "utf8");

  let fired = false;
  let mutation = null;
  const watcher = watch(path.dirname(taskPath), (_event, filename) => {
    if (fired || filename === null
      || !String(filename).startsWith("slice-01.md.stnl-contract-repair-stage-")) return;
    fired = true;
    mutation = fs.rename(lockPath, displacedLockPath)
      .then(() => fs.writeFile(lockPath, foreignLockBytes));
  });
  t.after(() => watcher.close());

  const outcome = await repairExecutionContract(fixture.requirements).then(
    (result) => ({ result, error: null }),
    (error) => ({ result: null, error }),
  );
  assert.equal(fired, true);
  await mutation;
  assert.ok(outcome.error instanceof ExecutionContractError,
    `repair ignored lock replacement: ${JSON.stringify(outcome.result)}`);
  assert.match(outcome.error.message, /lock ownership changed|foreign lock preserved/u);
  assert.deepEqual(await fs.readFile(taskPath), sourceBytes);
  assert.deepEqual(await fs.readFile(lockPath), foreignLockBytes);
});

test("official 98545e4 lifecycle-root execution is explicit legacy and never EMPTY", async (t) => {
  const root = await temporary(t, "stnl-old-root-execution-");
  const readyFixture = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready");
  const workspace = await copyDirectory(readyFixture, path.join(root, "spec"));
  const historicalRoot = ["skills", "stnl-spec-execution-manager", "templates"].join("/");
  const planIndex = replaceAll(gitShowText("98545e4", `${historicalRoot}/plan-index.template.md`), [
    ["<workspace path>", workspace], ["01 - <name>", "01 - Delivery"],
    ["<one-line observable outcome>", "observable result"],
  ]);
  const tasksIndex = replaceAll(gitShowText("98545e4", `${historicalRoot}/tasks-index.template.md`), [
    ["01 - <name>", "01 - Delivery"], ["<count or compact summary>", "one task"],
  ]);
  const phasePlan = replaceAll(gitShowText("98545e4", `${historicalRoot}/phase-plan.template.md`), [
    ["<Name>", "Delivery"], ["<One observable outcome.>", "Observable result."],
  ]);
  const phaseTasks = replaceAll(gitShowText("98545e4", `${historicalRoot}/phase-tasks.template.md`), [
    ["<Name>", "Delivery"], ["<task>", "Implement behavior"],
  ]);
  await fs.mkdir(path.join(workspace, "plans"));
  await fs.mkdir(path.join(workspace, "tasks"));
  await fs.writeFile(path.join(workspace, "plan.md"), planIndex);
  await fs.writeFile(path.join(workspace, "tasks.md"), tasksIndex);
  await fs.writeFile(path.join(workspace, "plans/plan-01.md"), phasePlan);
  await fs.writeFile(path.join(workspace, "tasks/tasks-01.md"), phaseTasks);

  for (const operation of [
    () => inspectExecutionState(workspace),
    () => preflightExecutionOperation(workspace, "PLAN"),
  ]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error.contractViolation?.kind, "legacy-execution-contract");
      assert.equal(error.contractViolation?.classification, "structurally-incompatible");
      assert.equal(error.contractViolation?.repairability, "blocked");
      assert.equal(error.contractViolation?.reason, "official-lifecycle-root-execution-generation");
      return true;
    });
  }
});

test("tasks prose is editable while its canonical table remains machine authority", async (t) => {
  for (const mutate of [
    (value) => value.replace("This is the sole global progress authority.", "This is the sole global progress authority!"),
    (value) => value
      .replace(/Use only `\[ \]`[\s\S]*?explicit `SLICE`\./u, "The table below is the global progress record; select every slice explicitly.")
      .replace(/After materialization,[\s\S]*?(?=\n?$)/u, "History remains append-only after execution work starts."),
    (value) => value.replace("\n\n| Done |", "\n\n\n| Done |").replace("| pending | pending |\n\n", "| pending | pending |\n   \n"),
    (value) => value.replace("\n\n| Done |", "\n\nEditorial notation `A | B | C` is explanatory prose.\n\n| Done |"),
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTasksIndex(fixture, mutate);
    assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  }
});

test("non-rendered tasks prose cannot create authority and row-like residue cannot mask it", async (t) => {
  for (const wrapper of [
    (table) => `\`\`\`md\n${table}\`\`\`\n`,
    (table) => `<!--\n${table}-->\n`,
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTasksIndex(fixture, (value) => value.replace(
      /(\| Done \| Slice \| Delivery \| Dependencies \| Detail \| Validation \| Result \|\n\|---\|---\|---\|---\|---\|---\|---\|\n(?:\|[^\n]+\|\n)+)/u,
      (table) => wrapper(table),
    ));
    await assert.rejects(inspectExecutionState(fixture.requirements), /canonical table header/u);
  }

  const editorial = await standaloneWorkspace(t);
  await renderArtifacts(editorial);
  await editTasksIndex(editorial, (value) => value.replace(
    "\n\n| Done |",
    "\n\n```md\n# Editorial example\n| fake | table | row |\n```\n\n<!--\n# Commented example\n| fake | table | row |\n-->\n\n| Done |",
  ));
  assert.equal((await inspectExecutionState(editorial.requirements)).state, "MATERIALIZED_PRISTINE");

  for (const residue of [
    "[ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "<!-- editorial marker --> [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "[ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending | <!-- editorial marker -->",
  ]) {
    const rowLikeResidue = await standaloneWorkspace(t);
    await renderArtifacts(rowLikeResidue);
    await editTasksIndex(rowLikeResidue, (value) => `${value}\n${residue}\n`);
    await assert.rejects(inspectExecutionState(rowLikeResidue.requirements), /unexpected structural row/u);
  }
});

test("legacy classification requires a complete historical producer signature", async (t) => {
  for (const insertion of [
    "```md\n# Delivery Plan Index\n```",
    "Historical example: \n# Delivery Plan Index",
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editPlan(fixture, (value) => value.replace(
      "- <risk, boundary, or explicit final integration slice>",
      `- no material integration risk\n\n${insertion}`,
    ));
    assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
  }

  const missingAuthority = await standaloneWorkspace(t);
  await renderArtifacts(missingAuthority);
  await editPlan(missingAuthority, (value) => value
    .replace(/^- Requirements authority: sha256:[0-9a-f]{64}\n/mu, "")
    .replace(/^- Plan revision: [0-9]+\n/mu, ""));
  await assert.rejects(inspectExecutionState(missingAuthority.requirements), (error) => {
    assert.equal(error.contractViolation, null);
    return /Requirements authority/u.test(error.message);
  });

  const hybrid = await standaloneWorkspace(t);
  await renderArtifacts(hybrid);
  await editPlan(hybrid, (value) => value.replace("# Execution Plan", "# Delivery Plan Index"));
  await assert.rejects(inspectExecutionState(hybrid.requirements), (error) => {
    assert.equal(error.contractViolation, null);
    return /non-canonical primary heading/u.test(error.message);
  });
});

test("the fabricated tasks prose pair is not a historical producer signature", async (t) => {
  const currentIntroduction = "Use only `[ ]` and `[x]`. This is the sole global progress authority. `PASS` and `SUPERSEDED` are terminal; only `PASS` is successful validation. A suggested eligible slice never selects it; every slice operation requires explicit `SLICE`.";
  const currentHistory = "After materialization, historical plans and task records are immutable. A wholly pristine canonical set may be atomically replaced only by explicit approved replanning. After any operational evidence, the index cannot be recreated and historical checklists cannot be rematerialized: an approved append-only revision adds only monotonically numbered rows/files. A current valid `PASS` atomically changes its selected row to `[x]`, validation `PASS`, result `PASS`. The same approved-replan materialization that appends a replacement slice may terminalize its named open predecessor as `[x]`, validation `SUPERSEDED`, result `SUPERSEDED`; it never changes a prior `PASS`.";
  const fabricatedIntroduction = "Use only `[ ]` and `[x]`. This is the sole global progress authority. Every slice operation requires explicit `SLICE`.";
  const fabricatedHistory = "Plans are immutable after materialization; only a current valid `PASS` may complete a selected row.";
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTasksIndex(fixture, (value) => value
    .replace(currentIntroduction, fabricatedIntroduction)
    .replace(currentHistory, fabricatedHistory));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("the exact e45e41d split-plan producer remains explicit blocked legacy", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const authoritySource = path.relative(fixture.execution, fixture.requirements).split(path.sep).join("/");
  const detailSource = path.relative(path.join(fixture.execution, "plans"), fixture.requirements).split(path.sep).join("/");
  await fs.mkdir(path.join(fixture.execution, "plans"), { recursive: true });
  const historicalPlannerRoot = ["skills", "stnl-execution-planner", "templates"].join("/");
  let plan = replaceAll(gitShowText("e45e41d", `${historicalPlannerRoot}/plan.template.md`), [
    ["`<relative path>`", `\`${authoritySource}\``], ["01 - <name>", "01 - Delivery"],
    ["<compact objective>", "Deliver observable behavior"], ["<compact strategy>", "Implement serially"],
    ["<result>", "observable result"], ["<areas>", "src/example.txt"],
  ]);
  plan = headerReady(plan);
  let detail = replaceAll(gitShowText("e45e41d", `${historicalPlannerRoot}/slice-plan.template.md`), [
    ["`<relative path>`", `\`${detailSource}\``], ["<Name>", "Delivery"],
  ]);
  detail = headerReady(detail);
  await fs.writeFile(path.join(fixture.execution, "plan.md"), plan);
  await fs.writeFile(path.join(fixture.execution, "plans/slice-01.md"), detail);
  await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
    assert.equal(error.contractViolation?.kind, "legacy-execution-contract");
    assert.equal(error.contractViolation?.reason, "known-split-plan-before-authority-fields");
    return true;
  });
});

test("current and e45e41d hybrid plan structure remains a current violation", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editPlan(fixture, (value) => value
    .replace(
      "update_policy: PLAN creates revision 1; REPLAN drafts a replacement or extension; REVIEW_PLAN corrects the mutable draft and changes it to ready.",
      "update_policy: PLAN creates as draft; REVIEW_PLAN corrects and changes status to ready.",
    )
    .replace(/^- Requirements authority: sha256:[0-9a-f]{64}\n/mu, "")
    .replace(/^- Plan revision: [0-9]+\n/mu, "")
    .replace(
      "\n\n## Serial Slice Order",
      "\n\nFor revision 1, including a planning-only replacement before tasks exist, omit the following historical recovery fields.\n\n- Replan reason: <REPLAN_REASON>\n- Revision mode: pristine-replacement | append-only-extension\n- Supersedes open slices: <slice-NN -> slice-NN mappings or none>\n\n## Serial Slice Order",
    ));
  await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
    assert.equal(error.contractViolation, null);
    return /Requirements authority/u.test(error.message);
  });
});

test("preflight is read-only and exact safe contract repair is an explicit deterministic action", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await prepareFindingsCorrection(fixture, "Findings IDs");
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const before = await fs.readFile(taskPath);
  for (const [operation, slice] of [["VALIDATE_SLICE", "1"], ["REPLAN", null], ["DELETE", null]]) {
    await assert.rejects(preflightExecutionOperation(fixture.requirements, operation, slice), (error) => {
      assert.equal(error.contractViolation.repairability, "mechanical");
      return true;
    });
    assert.deepEqual(await fs.readFile(taskPath), before, `${operation} preflight mutated live execution`);
  }
  const repair = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "--repair-known-contract",
  ], { encoding: "utf8", cwd: fixture.root });
  assert.equal(repair.status, 0, repair.stderr);
  assert.match(repair.stdout, /^PASS: contract repair status=REPAIRED repairs=1 state=FINDINGS_CORRECTED$/mu);
  const result = await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1");
  assert.equal(result.state, "FINDINGS_CORRECTED");
  assert.equal(result.slice, "slice-01");
});

for (const malformed of [
  {
    name: "canonical and legacy labels coexist",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Finding IDs: finding-01\n- Findings IDs: finding-01"),
    reason: "canonical-and-alias-conflict",
  },
  {
    name: "canonical label is duplicated",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Finding IDs: finding-01\n- Finding IDs: finding-01"),
    reason: "duplicate-canonical-field",
  },
  {
    name: "legacy label is duplicated",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Findings IDs: finding-01\n- Findings IDs: finding-01"),
    reason: "duplicate-legacy-field",
  },
  {
    name: "unknown typo is not fuzzily repaired",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Finding Identifierz: finding-01"),
    reason: "unknown-or-missing-field",
  },
  {
    name: "legacy label has an empty value",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Findings IDs: "),
    reason: "invalid-repair-value",
  },
  {
    name: "legacy label does not name a declared finding",
    mutate: (record) => record.replace("- Finding IDs: finding-01", "- Findings IDs: arbitrary-text"),
    reason: "invalid-repair-value",
  },
]) {
  test(`malformed findings contract blocks without mutation: ${malformed.name}`, async (t) => {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await prepareFindingsCorrection(fixture);
    await editTask(fixture, (value) => malformed.mutate(value));
    const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
    const before = await fs.readFile(taskPath);
    await assert.rejects(preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1"), (error) => {
      assert.equal(error.contractViolation.repairability, "blocked");
      assert.equal(error.contractViolation.reason, malformed.reason);
      assert.deepEqual(error.recoveryTargets, []);
      return true;
    });
    assert.deepEqual(await fs.readFile(taskPath), before);
  });
}

test("candidate validation rejects unreadable mutations and preserves live execution bytes", async (t) => {
  for (const [name, mutate] of [
    ["legacy findings field", (value) => value.replace("- Finding IDs: finding-01", "- Findings IDs: finding-01")],
    ["second required field class", (value) => value.replace("- HEAD: fixture", "- HEADs: fixture")],
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await prepareFindingsCorrection(fixture);
    const liveBefore = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"));
    const candidate = path.join(fixture.root, `candidate-${name.replaceAll(" ", "-")}`);
    await copyDirectory(fixture.execution, candidate);
    const candidateTask = path.join(candidate, "tasks/slice-01.md");
    await fs.writeFile(candidateTask, mutate(await fs.readFile(candidateTask, "utf8")), "utf8");
    await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), ExecutionContractError);
    assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")), liveBefore);
  }
});

test("successful model-owned candidate publication has strict success and live readback proof", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveBefore = await fs.readFile(liveTask);
  const candidate = path.join(fixture.root, "successful-candidate");
  await copyDirectory(fixture.execution, candidate);
  const candidateTask = path.join(candidate, "tasks/slice-01.md");
  let candidateText = await fs.readFile(candidateTask, "utf8");
  candidateText = candidateText.replace("- [ ] 1.1", "- [x] 1.1");
  candidateText = replaceSection(candidateText, "Changed Areas", "- `../../src/example.txt`");
  candidateText = replaceSection(candidateText, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  await fs.writeFile(candidateTask, candidateText, "utf8");

  const candidateState = await validateExecutionCandidate(fixture.requirements, candidate);
  assert.equal(candidateState.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(await fs.readFile(liveTask), liveBefore, "candidate validation published implicitly");

  // Publication remains model-owned; this test performs the authorized selected-task copy only after candidate PASS.
  await fs.copyFile(candidateTask, liveTask);
  const published = await inspectExecutionState(fixture.requirements);
  assert.equal(published.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(published.tasks.get("slice-01").implementationChecks.at(-1).status, "TESTS_PASS");

  const liveArtifacts = [
    path.join(fixture.execution, "plan.md"),
    path.join(fixture.execution, "plans/slice-01.md"),
    path.join(fixture.execution, "tasks.md"),
    liveTask,
  ];
  const beforeReadback = await Promise.all(liveArtifacts.map((file) => fs.readFile(file)));
  const readbackResult = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "--handoff-after",
    "EXECUTE_SLICE",
  ], { encoding: "utf8" });
  assert.equal(readbackResult.status, 0, readbackResult.stderr);
  const readback = JSON.parse(readbackResult.stdout);
  assert.equal(readback.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(readback.normal_handoff.invocation, "OPERATION=VALIDATE_SLICE");
  assert.equal(readback.normal_handoff.slice, "slice-01");
  assert.equal(readback.legal_operations.some(({ operation }) => operation === "VALIDATE_SLICE"), true);
  assert.equal(readback.legal_operations.some(({ operation }) => operation === "EXECUTE_SLICE"), false);
  assert.equal(readback.mandatory_recovery, null);
  assert.equal(readback.required_recovery_handoff, null);
  assert.deepEqual(await Promise.all(liveArtifacts.map((file) => fs.readFile(file))), beforeReadback, "handoff readback mutated live execution artifacts");

  await assert.rejects(
    preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"),
    /not legal/u,
    "published implementation unexpectedly permitted a second EXECUTE_SLICE",
  );
});

test("candidate shadows use external OS temp, preserve standalone logical paths, and clean owned storage", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await passFirstSlice(fixture);
  const candidate = await copyDirectory(fixture.execution, path.join(fixture.root, "valid-candidate"));
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveSource = path.join(fixture.root, "src/example.txt");
  const liveTaskBefore = await fs.readFile(liveTask);
  const liveSourceBefore = await fs.readFile(liveSource);
  const controlledTemp = await temporary(t, "stnl-candidate-storage-");
  const originalTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = controlledTemp;
  t.after(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTmpdir;
  });

  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "COMPLETE");
  assert.deepEqual(await fs.readdir(controlledTemp), [], "successful candidate left owned temp storage");

  const invalidCandidate = await copyDirectory(fixture.execution, path.join(fixture.root, "invalid-candidate"));
  await fs.writeFile(path.join(invalidCandidate, "scratch.md"), "reject\n", "utf8");
  let rejection;
  await assert.rejects(validateExecutionCandidate(fixture.requirements, invalidCandidate), (error) => {
    rejection = error;
    return error instanceof ExecutionContractError && error.findings.some((finding) => finding.endsWith(`${path.sep}scratch.md`));
  });
  const physicalFinding = rejection.findings.find((finding) => finding.endsWith(`${path.sep}scratch.md`));
  const relativeFinding = path.relative(controlledTemp, physicalFinding);
  assert.ok(relativeFinding !== "" && !relativeFinding.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeFinding));
  const shadowName = relativeFinding.split(path.sep)[0];
  assert.match(shadowName, /^\.stnl-execution-candidate-/u);
  await assert.rejects(fs.stat(path.join(controlledTemp, shadowName)), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(controlledTemp), [], "rejected candidate left owned temp storage");

  const formerLocalPrefix = `.${path.basename(fixture.root)}.stnl-execution-candidate-`;
  assert.deepEqual(
    (await fs.readdir(path.dirname(fixture.root))).filter((name) => name.startsWith(formerLocalPrefix)),
    [],
    "candidate shadow appeared beside the standalone workspace",
  );
  assert.deepEqual(await fs.readFile(liveTask), liveTaskBefore, "candidate validation changed the live task");
  assert.deepEqual(await fs.readFile(liveSource), liveSourceBefore, "candidate validation changed the live source");

  const nestedCandidate = path.join(fixture.execution, "candidate-inside-live-execution");
  await fs.mkdir(nestedCandidate);
  await assert.rejects(validateExecutionCandidate(fixture.requirements, nestedCandidate), /must be isolated from live execution artifacts/u);
  await fs.rm(nestedCandidate, { recursive: true });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, fixture.root), /must be isolated from live execution artifacts/u);
});

test("artifact-relative planning paths reject lifecycle-local candidates before publication", async (t) => {
  const initial = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "draft" });
  const candidate = await copyDirectory(initial.execution, path.join(path.dirname(initial.repository), "initial plan candidate"));
  const candidateFixture = { ...initial, execution: candidate };
  const requirementsBefore = await fs.readFile(path.join(initial.requirements, "feature_spec.md"));
  await setImplementationAreas(initial, { global: "scripts/validate.sh" });
  assert.equal((await preflightExecutionOperation(initial.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");
  await fs.rm(initial.execution, { recursive: true });
  await setImplementationAreas(candidateFixture, { global: "scripts/validate.sh" });
  await assert.rejects(validateExecutionCandidate(initial.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /artifact="specs\/área segura\/feature Ω\/execution\/plan\.md"/u);
    assert.match(error.message, /field="Serial Slice Order 01 Expected areas"/u);
    assert.match(error.message, /raw="scripts\/validate\.sh"/u);
    assert.match(error.message, /resolves inside the execution root/u);
    assert.match(error.message, /trusted-root=/u);
    return true;
  });
  await assert.rejects(fs.stat(initial.execution), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(path.join(initial.requirements, "feature_spec.md")), requirementsBefore);

  const reviewed = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const reviewedCandidate = await copyDirectory(reviewed.execution, path.join(path.dirname(reviewed.repository), "reviewed plan candidate"));
  const reviewedFixture = { ...reviewed, execution: reviewedCandidate };
  const liveBefore = await Promise.all([
    fs.readFile(path.join(reviewed.execution, "plan.md")),
    fs.readFile(path.join(reviewed.execution, "plans/slice-01.md")),
  ]);
  await setImplementationAreas(reviewedFixture, { detail: "../../skills/workflows/example.mjs" });
  await assert.rejects(validateExecutionCandidate(reviewed.requirements, reviewedCandidate), (error) => {
    assert.match(error.message, /field="Likely Areas"/u);
    assert.match(error.message, /resolves inside the lifecycle SPEC workspace/u);
    assert.match(error.message, /existing-project-target=/u);
    return true;
  });
  const correctExisting = path.relative(
    path.join(reviewed.requirements, "execution/plans"),
    path.join(reviewed.repository, "scripts/validate.sh"),
  ).split(path.sep).join("/");
  await setImplementationAreas(reviewedFixture, { detail: correctExisting });
  assert.equal((await validateExecutionCandidate(reviewed.requirements, reviewedCandidate)).state, "PLANNED_READY");
  assert.deepEqual(await Promise.all([
    fs.readFile(path.join(reviewed.execution, "plan.md")),
    fs.readFile(path.join(reviewed.execution, "plans/slice-01.md")),
  ]), liveBefore);
});

test("planning path carriers distinguish concrete paths from conceptual descriptions", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const implementationTarget = path.join(fixture.repository, "scripts/validate.sh");
  const globalClaim = path.relative(fixture.execution, implementationTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), implementationTarget).split(path.sep).join("/");

  await setImplementationAreas(fixture, { global: globalClaim, detail: detailClaim });
  await editPlan(fixture, (value) => value.replace("example implementation", "list command behavior"));
  await editSlicePlan(fixture, "slice-01", (value) => value.replace("example implementation", "list command behavior"));
  const candidate = await copyDirectory(fixture.execution, path.join(path.dirname(fixture.repository), "path carrier candidate"));
  const candidateFixture = { ...fixture, execution: candidate };
  await fs.rm(fixture.execution, { recursive: true });

  assert.equal(path.resolve(fixture.execution, globalClaim), implementationTarget, "P04 global claim resolves to the physical target");
  assert.equal(path.resolve(fixture.execution, "plans", detailClaim), implementationTarget, "P01/P05 detailed claim resolves to the physical target");
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "PLANNED_READY", "P01/P02/P04/P05 valid path claims and plain-text concepts pass");

  await editSlicePlan(candidateFixture, "slice-01", (value) => value.replace(
    /`[^`\n]+` — list command behavior/u,
    "`list` — list command behavior",
  ));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /field="Likely Areas"/u);
    assert.match(error.message, /raw="list"/u);
    assert.match(error.message, /resolves inside the execution root/u);
    return true;
  }, "P03 conceptual code span remains a rejected path claim");
});

test("planning claims use the containing artifact basis", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  const implementationTarget = path.join(fixture.repository, "src", "cli.mjs");
  await fs.mkdir(path.dirname(implementationTarget), { recursive: true });
  await fs.writeFile(implementationTarget, "#!/usr/bin/env node\n", "utf8");

  const candidate = await copyDirectory(fixture.execution, path.join(path.dirname(fixture.repository), "pilot-11-plan-candidate"));
  const candidateFixture = { ...fixture, execution: candidate };
  await fs.rm(fixture.execution, { recursive: true });

  const plannerSkill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/SKILL.md"), "utf8");
  const globalTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  const detailedTemplate = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  assert.match(plannerSkill, /These carriers are implementation-only/u);
  assert.match(plannerSkill, /nearest ancestor of the normalized requirements source that contains a real `\.git` marker/u);
  assert.match(plannerSkill, /`SPEC_PATH` is not necessarily the project root/u);
  assert.match(plannerSkill, /raw global `Expected areas` selections are semantic repository-relative inputs, not yet persisted artifact-relative claims/u);
  assert.match(plannerSkill, /never apply this artifact-relative readback to the raw semantic input before serialization/u);
  assert.match(globalTemplate, /Model-selected physical target \(repository-relative before serialization\)/u);
  assert.match(detailedTemplate, /Implementation filesystem path \(outside generated execution artifacts\)/u);

  const globalClaim = path.relative(fixture.execution, implementationTarget).split(path.sep).join("/");
  const detailDirectory = path.join(fixture.requirements, "execution", "plans");
  const detailClaim = path.relative(detailDirectory, implementationTarget).split(path.sep).join("/");
  const wrongResolved = path.join(fixture.repository, "specs", "src", "cli.mjs");
  const wrongDetailClaim = path.relative(detailDirectory, wrongResolved).split(path.sep).join("/");

  await setImplementationAreas(candidateFixture, { global: "execution/plan.md", detail: wrongDetailClaim });
  const invalidGlobalBefore = await fs.readFile(path.join(candidate, "plan.md"));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /field="Serial Slice Order 01 Expected areas"/u);
    assert.match(error.message, /raw="execution\/plan\.md"/u);
    assert.match(error.message, /resolves inside the execution root/u);
    return true;
  });
  assert.deepEqual(await fs.readFile(path.join(candidate, "plan.md")), invalidGlobalBefore);

  await setImplementationAreas(candidateFixture, { global: globalClaim });
  const invalidDetailBefore = await fs.readFile(path.join(candidate, "plans/slice-01.md"));
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /field="Likely Areas"/u);
    assert.ok(error.message.includes(`raw=${JSON.stringify(wrongDetailClaim)}`));
    assert.ok(error.message.includes(`resolved=${JSON.stringify(wrongResolved)}`));
    assert.match(error.message, /possible path-basis error: artifact-relative target is absent while the same project-root target exists/u);
    assert.ok(error.message.includes(`existing-project-target=${JSON.stringify(implementationTarget)}`));
    return true;
  });
  assert.deepEqual(await fs.readFile(path.join(candidate, "plans/slice-01.md")), invalidDetailBefore);

  await setImplementationAreas(candidateFixture, { detail: detailClaim });
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "PLANNED_READY");
});

test("materialization and task-review gates preserve valid future artifact-relative paths", async (t) => {
  const materializerSkill = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-task-materializer/SKILL.md"), "utf8");
  assert.match(materializerSkill, /resolveExecutionWorkspace\(SPEC_PATH\)/u);
  assert.match(materializerSkill, /taskPath = path\.join\(executionRoot, "tasks", "slice-NN\.md"\)/u);
  assert.doesNotMatch(materializerSkill, /path\.join\(SPEC_PATH, "execution"/u);
  assert.doesNotMatch(materializerSkill, /benchmark-case-a|todo-service\.mjs/u);
  assert.match(materializerSkill, /runtime\/prepare-task-candidate\.mjs/u);

  const planOnly = await nestedLifecycleWorkspace(t, { materialized: false, planStatus: "ready" });
  await setImplementationAreas(planOnly, { global: "scripts/validate.sh" });
  const invalidPlanBefore = await fs.readFile(path.join(planOnly.execution, "plan.md"));
  await assert.rejects(
    preflightExecutionOperation(planOnly.requirements, "MATERIALIZE_TASKS"),
    /resolves inside the execution root/u,
  );
  assert.deepEqual(await fs.readFile(path.join(planOnly.execution, "plan.md")), invalidPlanBefore);

  const fixture = await nestedLifecycleWorkspace(t);
  const candidate = await copyDirectory(fixture.execution, path.join(path.dirname(fixture.repository), "task review candidate"));
  const candidateFixture = { ...fixture, execution: candidate };
  const liveBefore = await Promise.all([
    fs.readFile(path.join(fixture.execution, "plan.md")),
    fs.readFile(path.join(fixture.execution, "plans/slice-01.md")),
    fs.readFile(path.join(fixture.execution, "tasks.md")),
    fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")),
  ]);
  const futureTarget = path.join(fixture.repository, "skills/workflows/stnl-user-story-refiner/runtime/refine.mjs");
  const shortFuture = "../../skills/workflows/stnl-user-story-refiner/runtime/refine.mjs";
  await setImplementationAreas(candidateFixture, { task: shortFuture });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.match(error.message, /field="Checklist 1\.1 expected areas"/u);
    assert.match(error.message, /resolves inside the lifecycle SPEC workspace/u);
    return true;
  });
  const taskFuture = path.relative(path.join(fixture.execution, "tasks"), futureTarget).split(path.sep).join("/");
  await setImplementationAreas(candidateFixture, { task: taskFuture });
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "MATERIALIZED_PRISTINE");
  await assert.rejects(fs.stat(futureTarget), { code: "ENOENT" });
  assert.deepEqual(await Promise.all([
    fs.readFile(path.join(fixture.execution, "plan.md")),
    fs.readFile(path.join(fixture.execution, "plans/slice-01.md")),
    fs.readFile(path.join(fixture.execution, "tasks.md")),
    fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")),
  ]), liveBefore);

  await setImplementationAreas(fixture, { task: shortFuture });
  const invalidTaskBefore = await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_TASKS")).state, "MATERIALIZED_PRISTINE");
  await assert.rejects(
    preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"),
    /resolves inside the lifecycle SPEC workspace/u,
  );
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-01.md")), invalidTaskBefore);
});

test("materializer rebases PLAN claims from the official execution workspace for every SPEC_PATH form", async (t) => {
  const lifecycle = await nestedLifecycleWorkspace(t);
  const lifecycleFeature = path.join(lifecycle.requirements, "feature_spec.md");
  const physicalTarget = path.join(lifecycle.repository, "src/example.txt");
  const planArtifact = path.join(lifecycle.execution, "plan.md");
  const planClaim = path.relative(path.dirname(planArtifact), physicalTarget).split(path.sep).join("/");

  const directoryRebase = await rebasePlanClaimToTask({
    specPath: lifecycle.requirements,
    planArtifact,
    planClaim,
  });
  assert.equal(directoryRebase.executionRoot, lifecycle.execution, "R1 lifecycle directory executionRoot");
  assert.equal(directoryRebase.taskPath, path.join(lifecycle.execution, "tasks/slice-01.md"), "R1 lifecycle directory taskPath");
  assert.equal(path.resolve(path.dirname(directoryRebase.taskPath), directoryRebase.taskClaim), physicalTarget, "R1 task claim resolves to the PLAN physical target");
  assert.notEqual(directoryRebase.taskClaim, planClaim, "R4 PLAN and TASK claims use different artifact bases");
  assert.equal(path.resolve(path.dirname(planArtifact), planClaim), physicalTarget, "R4 PLAN claim resolves to the physical target");

  const directoryCandidate = await copyDirectory(lifecycle.execution, path.join(path.dirname(lifecycle.repository), "directory-form-candidate"));
  await setImplementationAreas({ ...lifecycle, execution: directoryCandidate }, {
    global: planClaim,
    task: directoryRebase.taskClaim,
  });
  assert.equal((await validateExecutionCandidate(lifecycle.requirements, directoryCandidate)).state, "MATERIALIZED_PRISTINE", "R1 lifecycle directory candidate");

  const directRebase = await rebasePlanClaimToTask({
    specPath: lifecycleFeature,
    planArtifact,
    planClaim,
  });
  assert.equal(directRebase.executionRoot, lifecycle.execution, "R2 direct feature_spec.md executionRoot");
  assert.equal(directRebase.taskPath, directoryRebase.taskPath, "R2 direct feature_spec.md taskPath matches directory form");
  assert.equal(path.resolve(path.dirname(directRebase.taskPath), directRebase.taskClaim), physicalTarget, "R2 direct feature_spec.md claim resolves to the physical target");
  const directCandidate = await copyDirectory(lifecycle.execution, path.join(path.dirname(lifecycle.repository), "direct-form-candidate"));
  await setImplementationAreas({ ...lifecycle, execution: directCandidate }, { task: directRebase.taskClaim });
  assert.equal((await validateExecutionCandidate(lifecycleFeature, directCandidate)).state, "MATERIALIZED_PRISTINE", "R2 direct feature_spec.md candidate");

  const copiedPlanCandidate = await copyDirectory(lifecycle.execution, path.join(path.dirname(lifecycle.repository), "copied-plan-basis-candidate"));
  await setImplementationAreas({ ...lifecycle, execution: copiedPlanCandidate }, { task: planClaim });
  await assert.rejects(validateExecutionCandidate(lifecycleFeature, copiedPlanCandidate), /artifact-relative implementation path/u, "R5 copied PLAN basis remains invalid for TASK validation");

  const legacyDirectTaskPath = path.join(lifecycleFeature, "execution", "tasks", "slice-01.md");
  const legacyDirectClaim = path.relative(path.dirname(legacyDirectTaskPath), physicalTarget).split(path.sep).join("/");
  assert.notEqual(legacyDirectClaim, directRebase.taskClaim, "R2 old SPEC_PATH/execution basis differs for direct feature_spec.md");
  const legacyDirectCandidate = await copyDirectory(lifecycle.execution, path.join(path.dirname(lifecycle.repository), "legacy-direct-candidate"));
  await setImplementationAreas({ ...lifecycle, execution: legacyDirectCandidate }, { task: legacyDirectClaim });
  await assert.rejects(validateExecutionCandidate(lifecycleFeature, legacyDirectCandidate), /artifact-relative implementation path/u, "R2 old direct-file basis is rejected");

  const standaloneRoot = await temporary(t, "stnl-materializer-standalone-");
  const standaloneRepository = path.join(standaloneRoot, "repository");
  await fs.mkdir(path.join(standaloneRepository, ".git"), { recursive: true });
  const standaloneRequirements = path.join(standaloneRepository, "requirements/feature-x.md");
  await fs.mkdir(path.dirname(standaloneRequirements), { recursive: true });
  await fs.writeFile(standaloneRequirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  const standalone = {
    root: standaloneRepository,
    repository: standaloneRepository,
    requirements: standaloneRequirements,
    execution: path.join(path.dirname(standaloneRequirements), "feature-x-execution"),
  };
  await renderArtifacts(standalone);
  const standaloneTarget = path.join(standaloneRepository, "src/example.txt");
  const standalonePlan = path.join(standalone.execution, "plan.md");
  const standalonePlanClaim = path.relative(path.dirname(standalonePlan), standaloneTarget).split(path.sep).join("/");
  const standaloneRebase = await rebasePlanClaimToTask({
    specPath: standaloneRequirements,
    planArtifact: standalonePlan,
    planClaim: standalonePlanClaim,
  });
  assert.equal(standaloneRebase.executionRoot, standalone.execution, "R3 standalone requirements executionRoot");
  assert.equal(standaloneRebase.taskPath, path.join(standalone.execution, "tasks/slice-01.md"), "R3 standalone requirements taskPath");
  assert.equal(path.resolve(path.dirname(standaloneRebase.taskPath), standaloneRebase.taskClaim), standaloneTarget, "R3 standalone claim resolves to the physical target");
  const standaloneCandidate = await copyDirectory(standalone.execution, path.join(standaloneRoot, "standalone-form-candidate"));
  await setImplementationAreas({ ...standalone, execution: standaloneCandidate }, { task: standaloneRebase.taskClaim });
  assert.equal((await validateExecutionCandidate(standaloneRequirements, standaloneCandidate)).state, "MATERIALIZED_PRISTINE", "R3 standalone requirements candidate");

  const legacyStandaloneTaskPath = path.join(standaloneRequirements, "execution", "tasks", "slice-01.md");
  const legacyStandaloneClaim = path.relative(path.dirname(legacyStandaloneTaskPath), standaloneTarget).split(path.sep).join("/");
  assert.notEqual(legacyStandaloneClaim, standaloneRebase.taskClaim, "R3 old SPEC_PATH/execution basis differs for standalone requirements");
  const legacyStandaloneCandidate = await copyDirectory(standalone.execution, path.join(standaloneRoot, "legacy-standalone-candidate"));
  await setImplementationAreas({ ...standalone, execution: legacyStandaloneCandidate }, { task: legacyStandaloneClaim });
  await assert.rejects(validateExecutionCandidate(standaloneRequirements, legacyStandaloneCandidate), /artifact-relative implementation path/u, "R3 old standalone-file basis is rejected");
});

test("standalone path basis, Unicode, future targets, and symlink safety stay deterministic", async (t) => {
  const root = await temporary(t, "stnl-standalone-paths-");
  const repository = path.join(root, "repository with space ü");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const requirements = path.join(repository, "docs/nested/requirements.md");
  await fs.mkdir(path.dirname(requirements), { recursive: true });
  await fs.writeFile(requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  const fixture = {
    root: repository,
    repository,
    requirements,
    execution: path.join(path.dirname(requirements), "requirements-execution"),
  };
  await fs.mkdir(path.join(repository, "scripts"), { recursive: true });
  const existingTarget = path.join(repository, "scripts/validate.sh");
  await fs.writeFile(existingTarget, "#!/bin/sh\n", "utf8");
  await fs.mkdir(path.join(repository, "skills/workflows"), { recursive: true });
  await renderArtifacts(fixture);
  const candidate = await copyDirectory(fixture.execution, path.join(root, "standalone candidate"));
  const candidateFixture = { ...fixture, execution: candidate };
  const areasFor = (target) => ({
    global: path.relative(fixture.execution, target).split(path.sep).join("/"),
    detail: path.relative(path.join(fixture.execution, "plans"), target).split(path.sep).join("/"),
    task: path.relative(path.join(fixture.execution, "tasks"), target).split(path.sep).join("/"),
  });

  await setImplementationAreas(candidateFixture, areasFor(existingTarget));
  assert.equal((await validateExecutionCandidate(requirements, candidate)).state, "MATERIALIZED_PRISTINE");

  const shortDetail = areasFor(existingTarget).detail.replace(/^\.\.\//u, "");
  await setImplementationAreas(candidateFixture, { detail: shortDetail });
  await assert.rejects(validateExecutionCandidate(requirements, candidate), (error) => {
    assert.match(error.message, /possible path-basis error/u);
    assert.match(error.message, /existing-project-target=/u);
    return true;
  });

  const unicodeLocal = path.join(path.dirname(requirements), "área local/arquivo Ω.txt");
  await fs.mkdir(path.dirname(unicodeLocal), { recursive: true });
  await fs.writeFile(unicodeLocal, "local\n", "utf8");
  await setImplementationAreas(candidateFixture, areasFor(unicodeLocal));
  assert.equal((await validateExecutionCandidate(requirements, candidate)).state, "MATERIALIZED_PRISTINE");

  const futureTarget = path.join(repository, "skills/workflows/stnl-user-story-refiner/novo Ω.mjs");
  await setImplementationAreas(candidateFixture, areasFor(futureTarget));
  assert.equal((await validateExecutionCandidate(requirements, candidate)).state, "MATERIALIZED_PRISTINE");
  await assert.rejects(fs.stat(futureTarget), { code: "ENOENT" });

  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(repository, "linked"), "dir");
  const symlinkFuture = path.join(repository, "linked/future.txt");
  await setImplementationAreas(candidateFixture, areasFor(symlinkFuture));
  await assert.rejects(validateExecutionCandidate(requirements, candidate), /traverses a symlink/u);

  await setImplementationAreas(candidateFixture, { global: "/absolute/path.txt" });
  await assert.rejects(validateExecutionCandidate(requirements, candidate), /not a normalized relative path/u);
  await setImplementationAreas(candidateFixture, { global: "../../../../../../escaped.txt" });
  await assert.rejects(validateExecutionCandidate(requirements, candidate), /escapes its trusted workspace/u);
});

test("semantic auxiliary runner output is serialized by the deterministic execution producer before persistence", async (t) => {
  const contracts = await Promise.all([
    fs.readFile(path.join(ROOT, "agents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8"),
    fs.readFile(path.join(ROOT, "agents/codex/.codex/agents/stnl_validation_runner.toml"), "utf8"),
  ]);
  const persisted = checkRecord("implementation-check", 1, "TESTS_PASS", 1);
  for (const [runnerField, recordField] of [
    ['"automaticCheckRound":', "- Automatic check round: 1/3"],
    ['"status":', "- Status: TESTS_PASS"],
    ['"discoverySources":', "- Discovery sources:"],
    ['"discoveryActions":', "- Discovery actions:"],
    ['"verificationTypesConsidered":', "- Verification types considered:"],
    ['"commands":', "- Commands:"],
    ['"selectedChecks":', "- Selected checks:"],
  ]) {
    for (const contract of contracts) assert.ok(contract.includes(runnerField), runnerField);
    assert.ok(persisted.includes(recordField), recordField);
  }
  assert.match(persisted, /^- Tested scope: \S.*$/mu);
  assert.match(persisted, /^- Tested state:\n  - `[^`]+` \| sha256:[0-9a-f]{64}$/mu);
  assert.match(persisted, /^- Commands:\n  - `[^`]+` \| exit:0$/mu);
  assert.doesNotMatch(persisted, /^- Fileless reason:/mu);
  const filelessPersisted = persisted.replace(
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    "- Tested state: none\n- Fileless reason: no repository file participates in the observable state",
  );
  assert.match(filelessPersisted, /^- Tested state: none\n- Fileless reason: \S.*$/mu);
  const findingsPersisted = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" });
  assert.match(findingsPersisted, /^- Findings verified: finding-01$/mu);
  assert.match(findingsPersisted, /^- Unsupported active findings: none$/mu);
  const correctionPersisted = checkRecord("implementation-check", 2, "TESTS_PASS", 2);
  assert.match(correctionPersisted, /^- Correction paths: \.\.\/\.\.\/src\/example\.txt$/mu);

  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const candidate = path.join(fixture.root, "runner-round-trip-candidate");
  await copyDirectory(fixture.execution, candidate);
  const taskPath = path.join(candidate, "tasks/slice-01.md");
  let task = await fs.readFile(taskPath, "utf8");
  task = task.replace("- [ ] 1.1", "- [x] 1.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Implementation Test Evidence", persisted);
  await fs.writeFile(taskPath, task, "utf8");
  const candidateResult = await validateExecutionCandidate(fixture.requirements, candidate);
  assert.equal(candidateResult.state, "IMPLEMENTED_AWAITING_VALIDATION");
  await fs.copyFile(taskPath, path.join(fixture.execution, "tasks/slice-01.md"));
  const parsed = await inspectExecutionState(fixture.requirements);
  assert.equal(parsed.tasks.get("slice-01").implementationChecks[0].round, 1);
  assert.equal(parsed.tasks.get("slice-01").implementationChecks[0].testedState[0].path, "../../src/example.txt");
  assert.deepEqual(parsed.tasks.get("slice-01").implementationChecks[0].commands, [{ command: "node --test", exit: 0 }]);
});

test("validation candidate preparation writes canonical attempt and PASS base before strict validation", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const physicalTarget = path.join(fixture.root, "src", "validation target Ω.mjs");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, VALIDATED_CONTENT, "utf8");

  const liveTask = path.join(fixture.execution, "tasks", "slice-01.md");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  const taskClaim = path.relative(path.dirname(liveTask), physicalTarget).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: globalClaim, detail: detailClaim, task: taskClaim });
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", `- \`${taskClaim}\``);
    result = replaceSection(result, "Implementation Test Evidence", replaceAll(
      checkRecord("implementation-check", 1, "TESTS_PASS", 1),
      [["../../src/example.txt", taskClaim]],
    ));
    return replaceSection(result, "Diff Summary", "- Implemented the approved observable behavior.");
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const responseRoot = await temporary(t, "stnl-validation-canonical-response-");
  const semanticResponseFile = path.join(responseRoot, "response.json");
  const fullHead = "0123456789abcdef0123456789abcdef01234567";
  const semanticResponse = JSON.stringify({
    status: "PASS",
    head: fullHead,
    commands: [{ command: "node --test test/cli.test.mjs", exit: 0 }],
    evidence: "focused validation passed",
    findingReferences: "none",
    findingDispositions: "none",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "formal result returned",
  });
  await fs.writeFile(semanticResponseFile, semanticResponse, "utf8");

  const candidateParent = await temporary(t, "stnl-validation-candidate-root-");
  const candidateRoot = path.join(candidateParent, "execution");
  await copyDirectory(fixture.execution, candidateRoot);
  const prepared = await prepareValidationCandidate({
    specPath: fixture.requirements,
    slice: "1",
    workspace: fixture.root,
    candidateExecutionRoot: candidateRoot,
    semanticResponseFile,
  });
  assert.equal(prepared.status, "PREPARED");
  assert.equal(prepared.formalStatus, "PASS");
  assert.equal(prepared.attemptId, "attempt-01");
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidateRoot)).state, "COMPLETE");

  const candidateTask = path.join(candidateRoot, "tasks", "slice-01.md");
  const candidateText = await fs.readFile(candidateTask, "utf8");
  const baseStart = candidateText.indexOf("## Effective Validation Base\n\n");
  const baseEnd = candidateText.indexOf("\n## ", baseStart + 1);
  const base = candidateText.slice(baseStart, baseEnd < 0 ? candidateText.length : baseEnd);
  assert.ok(base.includes(`- HEAD: ${fullHead}`));
  assert.ok(base.includes(`- Origin attempt: ${prepared.attemptId}`));
  assert.ok(candidateText.includes(`- HEAD: ${fullHead}`));
  assert.ok(candidateText.includes(`- \`${taskClaim}\` | sha256:${VALIDATED_HASH}`));
  assert.equal(await fs.realpath(path.resolve(path.dirname(liveTask), taskClaim)), await fs.realpath(physicalTarget));

  const truncatedHead = `${fullHead.slice(0, 30)}deadbeef`;
  const tamperedText = candidateText.replace(
    `## Effective Validation Base\n\n- Origin attempt: ${prepared.attemptId}\n- Attempt type: initial\n- HEAD: ${fullHead}`,
    `## Effective Validation Base\n\n- Origin attempt: ${prepared.attemptId}\n- Attempt type: initial\n- HEAD: ${truncatedHead}`,
  );
  assert.notEqual(tamperedText, candidateText, "the causal mismatch fixture must alter only the base HEAD");
  await fs.writeFile(candidateTask, tamperedText, "utf8");
  await assert.rejects(
    validateExecutionCandidate(fixture.requirements, candidateRoot),
    /Effective Validation Base HEAD disagrees with its origin attempt/u,
  );
  await assert.rejects(
    prepareValidationCandidate({
      specPath: fixture.requirements,
      slice: "1",
      workspace: fixture.root,
      candidateExecutionRoot: candidateRoot,
      semanticResponseFile,
    }),
    /candidate Validation Attempts must remain byte-identical to live authority/u,
  );
  assert.equal(await fs.readFile(candidateTask, "utf8"), tamperedText, "preparation must not repair a rejected candidate");

  const malformedCandidateRoot = path.join(candidateParent, "malformed-execution");
  await copyDirectory(fixture.execution, malformedCandidateRoot);
  const malformedTask = path.join(malformedCandidateRoot, "tasks", "slice-01.md");
  const malformedBefore = await fs.readFile(malformedTask, "utf8");
  const malformedResponseFile = path.join(responseRoot, "malformed.json");
  await fs.writeFile(malformedResponseFile, JSON.stringify({
    status: "PASS",
    head: "",
    commands: [{ command: "node --test test/cli.test.mjs", exit: 0 }],
    evidence: "focused validation passed",
    findingReferences: "none",
    findingDispositions: "none",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "formal result returned",
  }), "utf8");
  await assert.rejects(
    prepareValidationCandidate({
      specPath: fixture.requirements,
      slice: "1",
      workspace: fixture.root,
      candidateExecutionRoot: malformedCandidateRoot,
      semanticResponseFile: malformedResponseFile,
    }),
    /head must be a complete single-line scalar/u,
  );
  assert.equal(await fs.readFile(malformedTask, "utf8"), malformedBefore, "malformed semantic input must not create a candidate record");
});

test("validation publisher accepts its own complete candidate after the materializer rejects it", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const physicalTarget = path.join(fixture.root, "src", "validation target.mjs");
  await fs.mkdir(path.dirname(physicalTarget), { recursive: true });
  await fs.writeFile(physicalTarget, VALIDATED_CONTENT, "utf8");

  const liveTask = path.join(fixture.execution, "tasks", "slice-01.md");
  const globalClaim = path.relative(fixture.execution, physicalTarget).split(path.sep).join("/");
  const detailClaim = path.relative(path.join(fixture.execution, "plans"), physicalTarget).split(path.sep).join("/");
  const taskClaim = path.relative(path.dirname(liveTask), physicalTarget).split(path.sep).join("/");
  await setImplementationAreas(fixture, { global: globalClaim, detail: detailClaim, task: taskClaim });
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- \`" + taskClaim + "\`");
    result = replaceSection(result, "Implementation Test Evidence", replaceAll(
      checkRecord("implementation-check", 1, "TESTS_PASS", 1),
      [["../../src/example.txt", taskClaim]],
    ));
    return replaceSection(result, "Diff Summary", "- Implemented the approved observable behavior.");
  });

  const responseRoot = await temporary(t, "stnl-validation-publish-response-");
  const semanticResponseFile = path.join(responseRoot, "response.json");
  await fs.writeFile(semanticResponseFile, JSON.stringify({
    status: "PASS",
    head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "node --test test/cli.test.mjs", exit: 0 }],
    evidence: "focused validation passed",
    findingReferences: "none",
    findingDispositions: "none",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "formal result returned",
  }), "utf8");

  const candidateParent = await temporary(t, "stnl-validation-publish-candidate-");
  const candidateRoot = path.join(candidateParent, "execution");
  await copyDirectory(fixture.execution, candidateRoot);
  const prepared = await prepareValidationCandidate({
    specPath: fixture.requirements,
    slice: "1",
    workspace: fixture.root,
    candidateExecutionRoot: candidateRoot,
    semanticResponseFile,
  });
  assert.equal(prepared.formalStatus, "PASS");
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidateRoot)).state, "COMPLETE");

  const liveTaskBefore = await fs.readFile(liveTask);
  const liveIndexPath = path.join(fixture.execution, "tasks.md");
  const liveIndexBefore = await fs.readFile(liveIndexPath);
  await assert.rejects(
    publishTaskMaterializationCandidate({
      specPath: fixture.requirements,
      candidateExecutionRoot: candidateRoot,
    }),
    /slice-01 historical task changed during materialization/u,
  );
  assert.deepEqual(await fs.readFile(liveTask), liveTaskBefore);
  assert.deepEqual(await fs.readFile(liveIndexPath), liveIndexBefore);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const preparedCandidateBeforePublish = await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md"));
  const controllerResult = await publishValidationCandidate({
    specPath: fixture.requirements,
    slice: "slice-01",
    candidateExecutionRoot: candidateRoot,
  });
  assert.equal(controllerResult.status, "PASS");
  assert.equal(controllerResult.state, "COMPLETE");
  assert.deepEqual(await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md")), preparedCandidateBeforePublish,
    "strict publisher must publish the already prepared candidate without rewriting it");
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
  assert.deepEqual(
    await fs.readFile(path.join(fixture.execution, "tasks", "slice-01.md")),
    await fs.readFile(path.join(candidateRoot, "tasks", "slice-01.md")),
  );
  assert.deepEqual(
    await fs.readFile(path.join(fixture.execution, "tasks.md")),
    await fs.readFile(path.join(candidateRoot, "tasks.md")),
  );
});

test("validation candidate preparation preserves a new semantic NEEDS_FIX finding for strict ownership validation", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const liveTask = path.join(fixture.execution, "tasks", "slice-01.md");
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Diff Summary", "- Implementation is complete but the independent validation found a blocking mismatch.");
  });
  const responseRoot = await temporary(t, "stnl-validation-needs-fix-response-");
  const semanticResponseFile = path.join(responseRoot, "response.json");
  await fs.writeFile(semanticResponseFile, JSON.stringify({
    status: "NEEDS_FIX",
    head: "0123456789abcdef0123456789abcdef01234567",
    commands: [{ command: "node --test test/cli.test.mjs", exit: 0 }],
    evidence: "validation reproduced a behavior mismatch",
    findingReferences: "finding-01",
    findingDispositions: "finding-01=active",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "finding requires correction",
  }), "utf8");
  const candidateParent = await temporary(t, "stnl-validation-needs-fix-candidate-");
  const candidateRoot = path.join(candidateParent, "execution");
  await copyDirectory(fixture.execution, candidateRoot);
  const candidateTask = path.join(candidateRoot, "tasks", "slice-01.md");
  await fs.writeFile(candidateTask, replaceSection(await fs.readFile(candidateTask, "utf8"), "Validation Findings", ACTIVE_FINDING), "utf8");

  assert.equal(await fs.readFile(liveTask, "utf8").then((value) => value.includes("### attempt-01")), false);
  const prepared = await prepareValidationCandidate({
    specPath: fixture.requirements,
    slice: "slice-01",
    workspace: fixture.root,
    candidateExecutionRoot: candidateRoot,
    semanticResponseFile,
  });
  assert.equal(prepared.formalStatus, "NEEDS_FIX");
  const published = await publishValidationCandidate({
    specPath: fixture.requirements,
    slice: "slice-01",
    candidateExecutionRoot: candidateRoot,
  });
  assert.equal(published.status, "PASS");
  assert.equal(published.state, "VALIDATION_NEEDS_FIX");
  const taskText = await fs.readFile(candidateTask, "utf8");
  assert.ok(taskText.includes("- Finding references: finding-01"));
  assert.ok(taskText.includes("- Finding dispositions: finding-01=active"));
  assert.match(taskText, /## Effective Validation Base\n\n- none/u);
  assert.match(taskText, /## Final Result\n\n- pending/u);
  assert.equal((await fs.readFile(path.join(candidateRoot, "tasks.md"), "utf8")).includes("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |"), true);
  const readback = await inspectExecutionState(fixture.requirements);
  assert.equal(readback.state, "VALIDATION_NEEDS_FIX");
  assert.equal(deriveNormalHandoff(readback, "VALIDATE_SLICE")?.operation, "APPLY_FINDINGS");
  assert.equal((await fs.readFile(path.join(fixture.execution, "tasks.md"), "utf8"))
    .includes("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |"), true);
});

test("formal validation output round-trips through NEEDS_FIX, correction, PASS, base, final, and handoff", async (t) => {
  const runnerContract = await fs.readFile(path.join(ROOT, "agents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8");
  for (const fieldName of ["return one raw JSON object with exactly the lowerCamelCase semantic keys", '"status": "PASS | NEEDS_FIX | BLOCKED"', '"head": "<semantic value>"', '"commands": [{"command": "<full command>", "exit": 0}]', '"findingReferences": "<semantic value>"', '"findingDispositions": "<semantic value>"']) {
    assert.ok(runnerContract.includes(fieldName), fieldName);
  }
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");

  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  const needsFix = await inspectExecutionState(fixture.requirements);
  assert.equal(needsFix.state, "VALIDATION_NEEDS_FIX");
  const needsFixHandoff = deriveNormalHandoff(needsFix, "VALIDATE_SLICE");
  assert.equal(needsFixHandoff.operation, "APPLY_FINDINGS");
  assert.equal(needsFixHandoff.slice, "slice-01");

  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Corrections Applied", "- `../../src/example.txt`");
    return replaceSection(result, "Findings Test Evidence", checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" }));
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "FINDINGS_CORRECTED");

  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "PASS", { references: "finding-01", dispositions: "finding-01=resolved" })}`);
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed the correction.`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await writeValidatedPath(fixture);
  const complete = await inspectExecutionState(fixture.requirements);
  assert.equal(complete.state, "COMPLETE");
  assert.equal(complete.tasks.get("slice-01").base.present, true);
  assert.equal(complete.tasks.get("slice-01").base.paths[0], "../../src/example.txt");
  assert.equal(complete.tasks.get("slice-01").final.result, "PASS");
  assert.equal(deriveNormalHandoff(complete, "VALIDATE_SLICE"), null);
  assert.deepEqual(complete.legalOperations, [{ operation: "REPLAN", slice: null }]);
});

test("an intermediate PASS hands off to the next serial execution frontier", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await passFirstSlice(fixture);
  const state = await inspectExecutionState(fixture.requirements);
  assert.equal(state.state, "EXECUTION_STARTED");
  assert.deepEqual(deriveNormalHandoff(state, "VALIDATE_SLICE"), {
    workflowSkill: "stnl-slice-executor",
    operation: "EXECUTE_SLICE",
    invocation: "OPERATION=EXECUTE_SLICE",
    slice: "slice-02",
  });
});

test("real planner and materializer templates round-trip through review and materialization handoffs", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture, { materialized: false, planStatus: "draft" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");
  await editPlan(fixture, (value) => headerReady(value));
  await editSlicePlan(fixture, "slice-01", (value) => headerReady(value));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PLANNED_READY");
  await renderTasks(fixture, { revision: 1, fingerprint: authority });
  const materialized = await inspectExecutionState(fixture.requirements);
  assert.equal(materialized.state, "MATERIALIZED_PRISTINE");
  assert.deepEqual(deriveNormalHandoff(materialized, "MATERIALIZE_TASKS"), {
    workflowSkill: "stnl-task-reviewer",
    operation: "REVIEW_TASKS",
    invocation: "OPERATION=REVIEW_TASKS",
    slice: null,
  });
});

test("distributed execution schemas and runtime agree on corrected semantic boundaries", async (t) => {
  const schemaPaths = [
    "stnl-slice-executor", "stnl-slice-quality-manager", "stnl-task-materializer",
  ].map((skill) => path.join(ROOT, `skills/workflows/${skill}/references/execution-record-schema.md`));
  const schemas = await Promise.all(schemaPaths.map((schemaPath) => fs.readFile(schemaPath, "utf8")));
  for (const schema of schemas.slice(1)) assert.equal(schema, schemas[0]);
  for (const rule of [
    /Scalar summaries are compact opaque inline values/u,
    /`Finding IDs` is one non-empty lexicographically ordered set/u,
    /exact `Tested state: none`[\s\S]{0,120}`Fileless reason`/u,
    /exact historical pair `Check discovery sources` \/ `Check discovery actions`/u,
    /At most one current base exists and it originates from the current `PASS` attempt/u,
    /`Finding references` uses exact `none` or `finding-NN, finding-NN`/u,
    /`Finding dispositions` uses exact `none` or `finding-NN=(?:active\|resolved\|superseded), finding-NN=(?:active\|resolved\|superseded)`/u,
    /`Findings verified` is exact `none` or a canonical subset of `Finding IDs`/u,
    /`Unsupported active findings` is deterministically every active finding at the named cycle not present in `Findings verified`/u,
    /file-backed `Correction paths` is an exact comma-space-delimited normalized ordered set, while exact `none` is permitted only for the corresponding fileless correction/u,
    /In `TESTS_PASS`, exact `none` is forbidden specifically for `Tested scope`, `Verification types considered`, `Selected checks`, and `Coverage`/u,
    /Candidate validation rejects terminal implementation evidence with an incomplete checklist/u,
    /exactly one mandatory target, `stnl-slice-executor \/ EXECUTE_SLICE \/ <affected slice>`/u,
    /The first `PASS` attempt is terminal/u,
  ]) assert.match(schemas[0], rule);

  const accepted = await standaloneWorkspace(t);
  await renderArtifacts(accepted);
  await editTask(accepted, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await inspectExecutionState(accepted.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await editTask(accepted, (value) => value.replace("- Tested scope: ../../src/example.txt", "- Tested scope:\n  - ../../src/example.txt"));
  await assert.rejects(inspectExecutionState(accepted.requirements), /Tested scope|unexpected nested/u);
});

test("execution producer serializes automatic correction fields and excludes findings-only labels", async (t) => {
  const fixture = await nestedLifecycleWorkspace(t);
  const taskArtifact = path.join(fixture.execution, "tasks/slice-01.md");
  const physicalTarget = path.join(fixture.root, "src/example.txt");
  const claim = path.relative(path.dirname(taskArtifact), physicalTarget).split(path.sep).join("/");
  await editTask(fixture, (value) => replaceSection(
    replaceSection(value, "Changed Areas", `- \`${claim}\``),
    "Corrections Applied",
    `- \`${claim}\``,
  ));

  const roundTwoPayload = {
    status: "TESTS_PASS",
    automaticCheckRound: "2/3",
    head: "fixture-head",
    discoverySources: "task and package scripts",
    discoveryActions: "read-only inspection",
    verificationTypesConsidered: "unit tests",
    nonApplicabilityRationale: "none",
    noVerificationCommandConfirmation: "not applicable",
    commands: [{ command: "node --test test/example.test.mjs", exit: 0 }],
    resultOfEachCommandAndExitCode: "all passed after the bounded correction",
    selectedChecks: "node --test test/example.test.mjs",
    selectionRationale: "directly covers the changed behavior",
    coverage: "changed behavior",
    failures: "none",
    priorRoundFailure: "round one implementation evidence was rejected by the strict schema",
    correctionApplied: "updated the implementation evidence serialization fields",
    inSliceRationale: "the correction remains within the approved slice",
    evidenceOrFailureSummary: "focused tests passed after correction",
    affectedFilesOrBehaviors: "example behavior",
    blockers: "none",
    unexpectedWorkspaceEffects: "none",
    persistenceSummary: "record persisted",
  };
  await assert.rejects(
    serializeRunnerExecutionBundleFromResponse({
      operation: "EXECUTE_SLICE",
      response: JSON.stringify({ ...roundTwoPayload, correctionsCovered: claim }),
      workspace: fixture.root,
      taskArtifact,
    }),
    /unknown semantic execution payload field: correctionsCovered/u,
  );

  const bundle = await serializeRunnerExecutionBundleFromResponse({
    operation: "EXECUTE_SLICE",
    response: JSON.stringify(roundTwoPayload),
    workspace: fixture.root,
    taskArtifact,
  });
  assert.match(bundle, /Automatic check round: 2\/3/u);
  assert.match(bundle, /Prior-round failure: round one implementation evidence was rejected by the strict schema/u);
  assert.match(bundle, /Correction applied: updated the implementation evidence serialization fields/u);
  const escapedClaim = claim.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  assert.match(bundle, new RegExp(`Correction paths: ${escapedClaim}`));
  assert.match(bundle, new RegExp(`Updated scope: ${escapedClaim}`));
  assert.match(bundle, /In-slice rationale: the correction remains within the approved slice/u);
  assert.doesNotMatch(bundle, /Corrections covered:/u);
});

test("duplicate or unknown task sections cannot hide operational records", async (t) => {
  const duplicate = await standaloneWorkspace(t);
  await renderArtifacts(duplicate);
  await editTask(duplicate, (value) => value.replace("## Validation Findings\n\n- none", `## Validation Findings

### finding-01

- Severity: blocking
- State: active
- Origin: attempt-99
- Problem: hidden record
- Evidence: duplicate section
- Impact: ambiguous state
- Related authority: AC-001
- Expected correction: remove duplicate

## Validation Findings

- none`));
  await assert.rejects(inspectExecutionState(duplicate.requirements), /duplicate section/u);

  const unknown = await standaloneWorkspace(t);
  await renderArtifacts(unknown);
  await editTask(unknown, (value) => value.replace("## Final Result", "## Unknown Operational State\n\n- none\n\n## Final Result"));
  await assert.rejects(inspectExecutionState(unknown.requirements), /non-canonical sections/u);
});

test("execution artifacts enforce purpose owners and canonical cross-references", async (t) => {
  const owner = await standaloneWorkspace(t);
  await renderArtifacts(owner);
  await editTask(owner, (value) => value.replace("owner: stnl-task-materializer", "owner: unrelated-owner"));
  await assert.rejects(inspectExecutionState(owner.requirements), /wrong File Purpose Header owner/u);

  for (const [from, to, expected] of [
    ["- Requirements source: `../../requirements.md`", "- Requirements source: `../../user-owned.md`", /non-canonical Requirements source/u],
    ["- Plan: `../plans/slice-01.md`", "- Plan: `../plans/slice-99.md`", /non-canonical Plan/u],
    ["- Global tasks: `../tasks.md`", "- Global tasks: `../other.md`", /non-canonical Global tasks/u],
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => value.replace(from, to));
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }
  const plan = await standaloneWorkspace(t);
  await renderArtifacts(plan);
  await editSlicePlan(plan, "slice-01", (value) => value.replace("- Global plan: `../plan.md`", "- Global plan: `../other.md`"));
  await assert.rejects(inspectExecutionState(plan.requirements), /non-canonical Global plan/u);
});

test("plan-only materialization preflight parses every detailed plan and review state", async (t) => {
  const malformed = await standaloneWorkspace(t);
  await renderArtifacts(malformed, { materialized: false });
  await fs.writeFile(path.join(malformed.execution, "plans/slice-01.md"), "utterly malformed\n", "utf8");
  await assert.rejects(preflightExecutionOperation(malformed.requirements, "MATERIALIZE_TASKS"), /File Purpose Header/u);

  const draft = await standaloneWorkspace(t);
  await renderArtifacts(draft, { materialized: false });
  await editSlicePlan(draft, "slice-01", (value) => value.replace("status: ready", "status: draft").replace("Review state: approved", "Review state: pending"));
  await assert.rejects(preflightExecutionOperation(draft.requirements, "MATERIALIZE_TASKS"), /ready global plan retains a draft detailed plan/u);
});

test("planning-only REPLAN atomically replaces revision 1 and returns through review and initial materialization", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture, { materialized: false, planStatus: "draft" });
  const initial = await inspectExecutionState(fixture.requirements);
  assert.equal(initial.state, "PLANNED_DRAFT");
  assertRecoveryTarget(initial, { operation: "REPLAN", slice: null, owner: "planning-authority" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "PLANNED_DRAFT");

  await replacePlanningOnly(fixture, authority, authority);
  const replacement = await inspectExecutionState(fixture.requirements);
  assert.equal(replacement.state, "PLANNED_DRAFT");
  assert.equal(replacement.globalPlan.revision, 1);
  assert.equal(replacement.globalPlan.revisionMode, null);
  assert.deepEqual(replacement.globalPlan.supersessionMappings, []);
  await assert.rejects(fs.stat(path.join(fixture.execution, "tasks.md")), { code: "ENOENT" });

  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PLANNED_DRAFT");
  await editPlan(fixture, (value) => setPlanReviewState(value, true));
  await editSlicePlan(fixture, "slice-01", (value) => setPlanReviewState(value, true));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PLANNED_READY");
  await renderTasks(fixture, { revision: 1, fingerprint: authority });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("reviewed planning made stale before tasks replans without historical recovery metadata", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture, { materialized: false, planStatus: "ready" });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "PLANNED_READY");
  await fs.appendFile(fixture.requirements, "- AC-002: authority changed before materialization\n");
  const stale = await inspectExecutionState(fixture.requirements);
  assert.equal(stale.state, "REQUIREMENTS_CHANGED");
  assert.deepEqual(stale.recoveryTargets.map(({ operation, slice }) => ({ operation, slice })), [{ operation: "REPLAN", slice: null }]);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "REQUIREMENTS_CHANGED");

  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await replacePlanningOnly(fixture, oldHash, newHash);
  const replacement = await inspectExecutionState(fixture.requirements);
  assert.equal(replacement.state, "PLANNED_DRAFT");
  assert.equal(replacement.globalPlan.revision, 1);
  assert.equal(replacement.globalPlan.revisionMode, null);
  await editPlan(fixture, (value) => setPlanReviewState(value, true));
  await editSlicePlan(fixture, "slice-01", (value) => setPlanReviewState(value, true));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PLANNED_READY");
  await renderTasks(fixture, { revision: 1, fingerprint: newHash });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("planning-only replacement rejects historical REPLAN fields and obsolete competing plans", async (t) => {
  const historical = await standaloneWorkspace(t);
  await renderArtifacts(historical, { materialized: false, planStatus: "draft" });
  await editPlan(historical, (value) => value.replace(
    "- Objective: Deliver observable behavior",
    "- Revision mode: pristine-replacement\n- Replan reason: invalid history before tasks\n- Supersedes open slices: none\n- Objective: Deliver observable behavior",
  ));
  await assert.rejects(inspectExecutionState(historical.requirements), /planning-only REPLAN must omit historical recovery revision fields/u);

  const obsolete = await standaloneWorkspace(t);
  await renderArtifacts(obsolete, { materialized: false, planStatus: "draft" });
  const stalePlan = (await fs.readFile(path.join(obsolete.execution, "plans/slice-01.md"), "utf8"))
    .replaceAll("Slice 01", "Slice 02").replaceAll("- Slice: 01", "- Slice: 02");
  await fs.writeFile(path.join(obsolete.execution, "plans/slice-02.md"), stalePlan, "utf8");
  await assert.rejects(inspectExecutionState(obsolete.requirements), /plans directory does not exactly match the current Serial Slice Order/u);
  await fs.rm(path.join(obsolete.execution, "plans/slice-02.md"));
  assert.equal((await inspectExecutionState(obsolete.requirements)).state, "PLANNED_DRAFT");
});

test("controlled execution artifacts reject hardlinks without mutating external bytes", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const taskPath = path.join(fixture.execution, "tasks/slice-01.md");
  const external = path.join(fixture.root, "user-owned.md");
  const bytes = await fs.readFile(taskPath);
  await fs.writeFile(external, bytes);
  await fs.rm(taskPath);
  await fs.link(external, taskPath);
  await assert.rejects(inspectExecutionState(fixture.requirements), /single-link real file/u);
  assert.deepEqual(await fs.readFile(external), bytes);
});

test("fake operational headings and non-sequential records never classify as pristine", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Validation Attempts", "### attempt-01\n\n- Type: initial\n- Status: <PASS>"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /placeholder/u);
});

test("pristine REVIEW_TASKS replan dead end has draft, review, and atomic materialization preflights", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "MATERIALIZED_PRISTINE");
  await fs.appendFile(fixture.requirements, "- AC-002: clarified planning boundary\n");
  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await stagePristineReplacement(fixture, oldHash, newHash);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-01", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  await editTask(fixture, (value) => reviseAuthority(value, oldHash, newHash, 1, 2));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("pending REPLAN requires canonical fields, one revision increment, and valid supersession mappings", async (t) => {
  async function pending({ authorityChange = false } = {}) {
    const fixture = await standaloneWorkspace(t);
    const { authority: oldHash } = await renderArtifacts(fixture);
    if (authorityChange) await fs.appendFile(fixture.requirements, "- AC-002: revised authority\n");
    const newHash = await computeRequirementsAuthority(fixture.requirements);
    await appendRecoveryPlan(fixture, oldHash, newHash);
    return fixture;
  }

  const missingReason = await pending();
  await editPlan(missingReason, (value) => value.replace(/^- Replan reason:.*\n/mu, ""));
  await assert.rejects(inspectExecutionState(missingReason.requirements), /Replan reason/u);

  const placeholderReason = await pending();
  await editPlan(placeholderReason, (value) => value.replace("- Replan reason: requirements or integration authority changed", "- Replan reason: pending"));
  await assert.rejects(inspectExecutionState(placeholderReason.requirements), /Replan reason must be objective/u);

  const nonIncrementing = await pending();
  await editPlan(nonIncrementing, (value) => value.replace("Plan revision: 2", "Plan revision: 1"));
  await editSlicePlan(nonIncrementing, "slice-02", (value) => value.replace("Plan revision: 2", "Plan revision: 1"));
  await assert.rejects(preflightExecutionOperation(nonIncrementing.requirements, "MATERIALIZE_TASKS"), /increment Plan revision by exactly one/u);

  const invalidTarget = await pending();
  await editPlan(invalidTarget, (value) => value.replace("slice-01 -> slice-02", "slice-01 -> slice-03"));
  await assert.rejects(inspectExecutionState(invalidTarget.requirements), /target slice-03 is not a newly appended later slice/u);

  const missingStaleMapping = await pending({ authorityChange: true });
  await editPlan(missingStaleMapping, (value) => value.replace("- Supersedes open slices: slice-01 -> slice-02", "- Supersedes open slices: none"));
  await assert.rejects(inspectExecutionState(missingStaleMapping.requirements), /does not supersede every prior-revision open slice/u);

  const missingSameAuthorityMapping = await pending();
  await editPlan(missingSameAuthorityMapping, (value) => value.replace("- Supersedes open slices: slice-01 -> slice-02", "- Supersedes open slices: none"));
  await assert.rejects(preflightExecutionOperation(missingSameAuthorityMapping.requirements, "MATERIALIZE_TASKS"), /does not supersede every prior-revision open slice/u);

  const fakeCommitted = await standaloneWorkspace(t);
  await renderArtifacts(fakeCommitted);
  await editPlan(fakeCommitted, (value) => value.replace("- Objective: Deliver observable behavior", "- Revision mode: append-only-extension\n- Replan reason: fake metadata\n- Supersedes open slices: none\n- Objective: Deliver observable behavior"));
  await assert.rejects(inspectExecutionState(fakeCommitted.requirements), /lacks historical and current-revision tasks/u);

  const invalidInitial = await standaloneWorkspace(t);
  await renderArtifacts(invalidInitial, { materialized: false });
  await editPlan(invalidInitial, (value) => value.replace("Plan revision: 1", "Plan revision: 4"));
  await assert.rejects(inspectExecutionState(invalidInitial.requirements), /planning-only authority must use Plan revision 1/u);

  const mixedReplacement = await standaloneWorkspace(t);
  const { authority: mixedAuthority } = await renderArtifacts(mixedReplacement);
  await addSecondPristineSlice(mixedReplacement);
  await stagePristineReplacement(mixedReplacement, mixedAuthority, mixedAuthority, { ready: true });
  await editSlicePlan(mixedReplacement, "slice-02", (value) => value.replace("status: ready", "status: ready"));
  await assert.rejects(preflightExecutionOperation(mixedReplacement.requirements, "MATERIALIZE_TASKS"), /candidate plans do not all match/u);
});

test("requirements authority detects unchanged and stale planning at every requested boundary A-E", async (t) => {
  const variants = ["before-materialization", "after-materialization", "partial-execution", "after-pass"];
  for (const variant of variants) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture, { materialized: variant !== "before-materialization" });
    const before = await inspectExecutionState(fixture.requirements);
    assert.equal(before.stale, false, `${variant}: unchanged authority was stale`);
    if (variant === "partial-execution") {
      await editTask(fixture, (value) => replaceSection(value, "Changed Areas", "- `../../src/example.txt`"));
    } else if (variant === "after-pass") {
      await editTask(fixture, (value) => {
        let result = value.replace("- [ ] 1.1", "- [x] 1.1");
        result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
        result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
        result = replaceSection(result, "Effective Validation Base", PASS_BASE);
        return publishPassResult(result);
      });
      await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
      await writeValidatedPath(fixture);
      assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
    }
    await fs.appendFile(fixture.requirements, "- AC-002: changed authority\n");
    const stale = await inspectExecutionState(fixture.requirements);
    assert.equal(stale.state, "REQUIREMENTS_CHANGED", `${variant}: stale authority continued silently`);
    await assert.rejects(preflightExecutionOperation(fixture.requirements, variant === "before-materialization" ? "MATERIALIZE_TASKS" : "EXECUTE_SLICE", variant === "before-materialization" ? null : "1"), /not legal/u);
  }
});

test("lifecycle shared-only changes stale planning and deterministic lifecycle CLOSE preserves the fingerprint", async (t) => {
  const readySource = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready");
  const closedSource = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/closed");
  const root = await temporary(t);
  const ready = await copyDirectory(readySource, path.join(root, "ready"));
  const closed = await copyDirectory(closedSource, path.join(root, "closed"));
  const activeHash = await computeRequirementsAuthority(ready);
  assert.equal(await computeRequirementsAuthority(closed), activeHash, "lossless lifecycle CLOSE changed semantic authority");
  const requirement = path.join(ready, "shared/requirements.md");
  await fs.writeFile(requirement, (await fs.readFile(requirement, "utf8")).replace("Expired invitation is rejected", "Expired invitation is rejected with audit"));
  assert.notEqual(await computeRequirementsAuthority(ready), activeHash, "shared-only authority mutation was ignored");
});

test("finding resolution is historical while only active blocking findings block", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_NEEDS_FIX");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1")).state, "VALIDATION_NEEDS_FIX");
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed the correction.`);
    result = result.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "PASS", { references: "finding-01", dispositions: "finding-01=resolved" })}`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  await writeValidatedPath(fixture);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
});

test("partial finding correction may revalidate NEEDS_FIX before eventual PASS dispositions", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const secondFinding = ACTIVE_FINDING.replaceAll("finding-01", "finding-02").replace("Origin: attempt-01", "Origin: attempt-02").replace("Observable behavior is wrong.", "Regression behavior is wrong.");
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "NEEDS_FIX", { references: "finding-01, finding-02", dispositions: "finding-01=resolved, finding-02=active" })}`);
    return replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed correction.\n\n${secondFinding}`);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_NEEDS_FIX");
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "NEEDS_FIX", { references: "finding-01, finding-02", dispositions: "finding-01=resolved, finding-02=active" })}\n\n${attemptRecord(3, "PASS", { references: "finding-01, finding-02", dispositions: "finding-01=resolved, finding-02=resolved" })}`);
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-02 confirmed correction.\n\n${secondFinding.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-03 confirmed correction.`);
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 3 }));
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  await writeValidatedPath(fixture);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE");
});

test("active divergence blocks, resolved divergence remains auditable, and wrong lifecycle fields reject", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "DIVERGENCE_BLOCKED");
  await editTask(fixture, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: resolved")}\n- Resolution: plan revision 2 committed recovery slice-02`));
  await assert.rejects(inspectExecutionState(fixture.requirements), /resolution has no committed supersession owner/u);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE}\n- Resolution: invalid for active state`));
  await assert.rejects(inspectExecutionState(fixture.requirements), /active state cannot contain resolution fields/u);
  await editTask(fixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE.replace("Required authority operation: REPLAN", "Required authority operation: DELETE_MANUALLY")));
  await assert.rejects(inspectExecutionState(fixture.requirements), /invalid Required authority operation/u);

  const forged = await standaloneWorkspace(t);
  await renderArtifacts(forged);
  const successor = ACTIVE_DIVERGENCE.replaceAll("divergence-01", "divergence-02").replace("- State: active", "- State: resolved")
    + "\n- Resolution: plan revision 2 committed recovery slice-02";
  await editTask(forged, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: superseded")}\n- Superseded by: divergence-02\n\n${successor}`));
  await assert.rejects(inspectExecutionState(forged.requirements), /no committed (?:supersession|recovery) owner/u);

  const committed = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(committed);
  await appendRecoveryPlan(committed, authority, authority, { ready: true });
  await commitAppendRecovery(committed, authority, authority);
  await editTask(committed, (value) => replaceSection(value, "Divergences", `${ACTIVE_DIVERGENCE.replace("- State: active", "- State: superseded")}\n- Superseded by: divergence-02\n\n${successor}`));
  assert.equal((await inspectExecutionState(committed.requirements)).state, "EXECUTION_STARTED");
});

test("stale delegation blockers cannot reopen terminal auxiliary phases", async (t) => {
  for (const status of ["TESTS_PASS", "TESTS_NOT_APPLICABLE"]) {
    for (const kind of ["Implementation", "Findings"]) {
      const fixture = await standaloneWorkspace(t);
      await renderArtifacts(fixture);
      const implementation = kind === "Implementation";
      const prefix = implementation ? "implementation-check" : "findings-check";
      await editTask(fixture, (value) => {
        let result = value.replace("- [ ] 1.1", "- [x] 1.1");
        if (!implementation) {
          result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
          result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
        }
        result = replaceSection(result, `${kind} Test Evidence`, checkRecord(prefix, 1, status, 1, { cycle: "attempt-01" }));
        return replaceSection(result, "Delegation Blocker", delegationBlocker(implementation ? "EXECUTE_SLICE" : "APPLY_FINDINGS", "initialization", { after: `${prefix}-01` }));
      });
      await assert.rejects(inspectExecutionState(fixture.requirements), /stale .* Delegation Blocker/u);
    }
  }
});

test("third TESTS_FAIL has only formal validation continuation for implementation and findings", async (t) => {
  for (const kind of ["Implementation", "Findings"]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    const prefix = kind === "Implementation" ? "implementation-check" : "findings-check";
    if (kind === "Findings") await editTask(fixture, (value) => replaceSection(value, "Validation Findings", ACTIVE_FINDING));
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
      result = replaceSection(result, `${kind} Test Evidence`, [1, 2, 3].map((round) => checkRecord(prefix, round, "TESTS_FAIL", round, { cycle: "attempt-01" })).join("\n\n"));
      if (kind === "Findings") {
        result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
      }
      return result;
    });
    const state = await inspectExecutionState(fixture.requirements);
    assert.equal(state.state, kind === "Implementation" ? "IMPLEMENTATION_RETRY_EXHAUSTED" : "FINDINGS_RETRY_EXHAUSTED");
    assertRecoveryTarget(state, {
      operation: "VALIDATE_SLICE",
      slice: "slice-01",
      owner: "retry-exhaustion",
      record: `${prefix}-03`,
      round: 3,
      retryState: state.state,
    });
    assert.equal(state.normalHandoff, null);
    assert.deepEqual(state.requiredRecoveryHandoff, {
      workflowSkill: "stnl-slice-quality-manager",
      operation: "VALIDATE_SLICE",
      invocation: "OPERATION=VALIDATE_SLICE",
      slice: "slice-01",
    });
    const handoff = spawnSync(process.execPath, [
      path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs"),
      fixture.requirements,
      "--handoff-after",
      kind === "Implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS",
    ], { encoding: "utf8", cwd: fixture.root });
    assert.equal(handoff.status, 0, handoff.stderr);
    const transition = JSON.parse(handoff.stdout);
    assert.equal(transition.normal_handoff, null);
    assert.deepEqual(transition.required_recovery_handoff, {
      workflowSkill: "stnl-slice-quality-manager",
      operation: "VALIDATE_SLICE",
      invocation: "OPERATION=VALIDATE_SLICE",
      slice: "slice-01",
    });
    await assert.rejects(preflightExecutionOperation(fixture.requirements, kind === "Implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS", "1"), /not legal/u);
    if (kind === "Implementation") {
      const invalidSlice = await rejectedWithRecovery(
        preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "01"),
        /SLICE must be one unsigned decimal number without prefix; legal next operation is VALIDATE_SLICE for slice-01/u,
      );
      assertRecoveryTarget(invalidSlice, { operation: "VALIDATE_SLICE", slice: "slice-01" });
    }
    assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, state.state);

    const blocked = await standaloneWorkspace(t);
    await renderArtifacts(blocked);
    await editTask(blocked, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, `${kind} Test Evidence`, [1, 2, 3].map((round) => checkRecord(prefix, round, "TESTS_FAIL", round, { cycle: "attempt-01" })).join("\n\n"));
      if (kind === "Findings") {
        result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
        result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
      }
      return replaceSection(result, "Delegation Blocker", delegationBlocker(kind === "Implementation" ? "EXECUTE_SLICE" : "APPLY_FINDINGS", "initialization", { after: `${prefix}-03` }));
    });
    await assert.rejects(inspectExecutionState(blocked.requirements), /cannot resume .* after third-failure exhaustion/u);

    const diverged = await standaloneWorkspace(t);
    await renderArtifacts(diverged);
    await editTask(diverged, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, `${kind} Test Evidence`, [1, 2, 3].map((round) => checkRecord(prefix, round, "TESTS_FAIL", round, { cycle: "attempt-01" })).join("\n\n"));
      result = replaceSection(result, "Divergences", ACTIVE_DIVERGENCE);
      if (kind === "Findings") {
        result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
        result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
      }
      return result;
    });
    await assert.rejects(inspectExecutionState(diverged.requirements), /cannot combine third-failure exhaustion/u);
  }
});

test("automatic check rounds reject skipped, duplicate, non-initial, and post-terminal records", async (t) => {
  const invalidSequences = [
    [checkRecord("implementation-check", 1, "TESTS_PASS", 2), /start its automatic check cycle at round 1\/3/u],
    [checkRecord("implementation-check", 1, "TESTS_FAIL", 1), /unterminated implementation automatic correction cycle/u],
    [`${checkRecord("implementation-check", 1, "TESTS_FAIL", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 3)}`, /round 2\/3/u],
    [`${checkRecord("implementation-check", 1, "TESTS_FAIL", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 1)}`, /round 2\/3/u],
    [`${checkRecord("implementation-check", 1, "TESTS_PASS", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 1)}`, /after terminal automatic-check record/u],
    [`${checkRecord("implementation-check", 1, "TESTS_FAIL", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 2).replace("- Correction applied: bounded objective correction\n", "")}`, /Correction applied/u],
  ];
  for (const [sequence, expected] of invalidSequences) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", sequence));
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }
});

test("EXECUTE_SLICE preflight permits the next automatic round only after an in-scope correction is persisted", async (t) => {
  const uncorrected = await standaloneWorkspace(t);
  await renderArtifacts(uncorrected);
  await editTask(uncorrected, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
  });
  await assert.rejects(
    preflightExecutionOperation(uncorrected.requirements, "EXECUTE_SLICE", "1"),
    /unterminated implementation automatic correction cycle/u,
  );

  const corrected = await standaloneWorkspace(t);
  await renderArtifacts(corrected);
  await editTask(corrected, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
  });
  const preflight = await preflightExecutionOperation(corrected.requirements, "EXECUTE_SLICE", "1");
  assert.equal(preflight.state, "EXECUTION_STARTED");
  assert.deepEqual(preflight.legalOperations, [{ operation: "REPLAN", slice: null }, { operation: "EXECUTE_SLICE", slice: "slice-01" }]);
});

test("only the first open serial slice may own operational phase", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  const laterPath = path.join(fixture.execution, "tasks/slice-02.md");
  let later = await fs.readFile(laterPath, "utf8");
  later = later.replace("- [ ] 2.1", "- [x] 2.1");
  later = replaceSection(later, "Changed Areas", "- `../../src/example.txt`");
  later = replaceSection(later, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  await fs.writeFile(laterPath, later, "utf8");
  await assert.rejects(inspectExecutionState(fixture.requirements), /contains operational state after the serial frontier slice-01/u);
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1"), /contains operational state after the serial frontier slice-01/u);

  const laterPass = await standaloneWorkspace(t);
  await renderArtifacts(laterPass);
  await addSecondPristineSlice(laterPass);
  const laterPassPath = path.join(laterPass.execution, "tasks/slice-02.md");
  let passed = await fs.readFile(laterPassPath, "utf8");
  passed = passed.replace("- [ ] 2.1", "- [x] 2.1");
  passed = replaceSection(passed, "Changed Areas", "- `../../src/example.txt`");
  passed = replaceSection(passed, "Validation Attempts", PASS_ATTEMPT);
  passed = replaceSection(passed, "Effective Validation Base", PASS_BASE);
  passed = publishPassResult(passed);
  await fs.writeFile(laterPassPath, passed, "utf8");
  await editTasksIndex(laterPass, (value) => value.replace(
    "| [ ] | 02 - Later | later result | 01 | tasks/slice-02.md | pending | pending |",
    "| [x] | 02 - Later | later result | 01 | tasks/slice-02.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(laterPass.requirements), /contains operational state after the serial frontier slice-01/u);
});

test("incomplete execution finalization is rejected for candidates and live history recovers only through its executor slice", async (t) => {
  const planning = await standaloneWorkspace(t);
  await renderArtifacts(planning, { materialized: false, planStatus: "draft" });
  const planningCandidate = await copyDirectory(planning.execution, path.join(planning.root, "planning-candidate"));
  assert.equal((await validateExecutionCandidate(planning.requirements, planningCandidate)).state, "PLANNED_DRAFT");

  for (const status of ["TESTS_PASS", "TESTS_NOT_APPLICABLE"]) {
    const prevention = await standaloneWorkspace(t);
    await renderArtifacts(prevention);
    const interruptedCandidate = await copyDirectory(
      prevention.execution,
      path.join(prevention.root, `interrupted-before-finalization-${status.toLowerCase()}`),
    );
    const interruptedTask = path.join(interruptedCandidate, "tasks/slice-01.md");
    let interrupted = await fs.readFile(interruptedTask, "utf8");
    interrupted = interrupted.replace("- [ ] 1.1", "- [x] 1.1");
    interrupted = replaceSection(interrupted, "Changed Areas", "- `../../src/example.txt`");
    await fs.writeFile(interruptedTask, interrupted, "utf8");
    const interruptionState = await validateExecutionCandidate(prevention.requirements, interruptedCandidate);
    assert.equal(interruptionState.state, "EXECUTION_STARTED");
    assert.deepEqual(interruptionState.legalOperations, [
      { operation: "REPLAN", slice: null },
      { operation: "EXECUTE_SLICE", slice: "slice-01" },
    ]);

    const invalidCandidate = await copyDirectory(
      prevention.execution,
      path.join(prevention.root, `invalid-finalization-${status.toLowerCase()}`),
    );
    const invalidCandidateTask = path.join(invalidCandidate, "tasks/slice-01.md");
    let invalid = await fs.readFile(invalidCandidateTask, "utf8");
    invalid = replaceSection(invalid, "Changed Areas", "- `../../src/example.txt`");
    invalid = replaceSection(invalid, "Implementation Test Evidence", checkRecord("implementation-check", 1, status, 1));
    await fs.writeFile(invalidCandidateTask, invalid, "utf8");
    await assert.rejects(
      validateExecutionCandidate(prevention.requirements, invalidCandidate),
      /candidate cannot finalize execution for slice-01 while its mandatory checklist is incomplete/u,
    );
    await fs.copyFile(invalidCandidateTask, path.join(prevention.execution, "tasks/slice-01.md"));
    const persistedInconsistency = await inspectExecutionState(prevention.requirements);
    assertRecoveryTarget(persistedInconsistency, {
      operation: "EXECUTE_SLICE",
      slice: "slice-01",
      owner: "stnl-slice-executor",
      record: "implementation-check-01",
      round: 1,
      sameOperationResumeRequired: true,
    });
    await editTask(prevention, (value) => value.replace("- [ ] 1.1", "- [x] 1.1"));
    assert.equal(
      (await preflightExecutionOperation(prevention.requirements, "VALIDATE_SLICE", "1")).state,
      "IMPLEMENTED_AWAITING_VALIDATION",
    );
  }

  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });

  const inconsistent = await inspectExecutionState(fixture.requirements);
  assert.equal(inconsistent.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(inconsistent.legalOperations, [{ operation: "EXECUTE_SLICE", slice: "slice-01" }]);
  assert.equal(inconsistent.normalHandoff, null);
  assert.deepEqual(inconsistent.requiredRecoveryHandoff, null);
  assertRecoveryTarget(inconsistent, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "stnl-slice-executor",
    record: "implementation-check-01",
    round: 1,
    sameOperationResumeRequired: true,
  });

  for (let invocation = 0; invocation < 2; invocation += 1) {
    const resumed = await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1");
    assert.equal(resumed.state, "IMPLEMENTED_AWAITING_VALIDATION");
    assert.equal(resumed.mandatoryRecovery.slice, "slice-01");
  }
  const acceptedCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "EXECUTE_SLICE",
    "1",
  ], { encoding: "utf8" });
  assert.equal(acceptedCli.status, 0, acceptedCli.stderr);
  const acceptedMetadata = JSON.parse(acceptedCli.stdout.split("\n")
    .find((line) => line.startsWith("MANDATORY_RECOVERY: ")).slice("MANDATORY_RECOVERY: ".length));
  assert.deepEqual(acceptedMetadata, inconsistent.mandatoryRecovery);
  for (const [operation, slice] of [["EXECUTE_SLICE", "2"], ["VALIDATE_SLICE", "1"], ["REPLAN", null]]) {
    const rejected = await rejectedWithRecovery(
      preflightExecutionOperation(fixture.requirements, operation, slice),
      /legal next operation is EXECUTE_SLICE for slice-01/u,
    );
    assertRecoveryTarget(rejected, {
      operation: "EXECUTE_SLICE",
      slice: "slice-01",
      owner: "stnl-slice-executor",
      record: "implementation-check-01",
      round: 1,
      sameOperationResumeRequired: true,
    });
  }
  const unsupported = await rejectedWithRecovery(
    preflightExecutionOperation(fixture.requirements, "RESUME_SLICE", "1"),
    /unsupported operation RESUME_SLICE; legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  assertRecoveryTarget(unsupported, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "stnl-slice-executor",
  });
  const rejectedCli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-quality-manager/runtime/validate-execution-state.mjs"),
    fixture.requirements,
    "VALIDATE_SLICE",
    "1",
  ], { encoding: "utf8" });
  assert.equal(rejectedCli.status, 1);
  const rejectedMetadata = JSON.parse(rejectedCli.stderr.split("\n")
    .find((line) => line.startsWith("RECOVERY_TARGETS: ")).slice("RECOVERY_TARGETS: ".length));
  assert.deepEqual(rejectedMetadata, inconsistent.recoveryTargets);

  const recoveredCandidate = await copyDirectory(fixture.execution, path.join(fixture.root, "recovered-candidate"));
  const recoveredCandidateTask = path.join(recoveredCandidate, "tasks/slice-01.md");
  await fs.writeFile(
    recoveredCandidateTask,
    (await fs.readFile(recoveredCandidateTask, "utf8")).replace("- [ ] 1.1", "- [x] 1.1"),
    "utf8",
  );
  const recoveredCandidateState = await validateExecutionCandidate(fixture.requirements, recoveredCandidate);
  assert.equal(recoveredCandidateState.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(recoveredCandidateState.mandatoryRecovery, null);
  await fs.copyFile(recoveredCandidateTask, path.join(fixture.execution, "tasks/slice-01.md"));

  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal(recovered.mandatoryRecovery, null);
  assertRecoveryTarget(recovered, {
    operation: "VALIDATE_SLICE",
    slice: "slice-01",
    owner: "implementation-check",
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await assert.rejects(
    preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"),
    /legal next operations are VALIDATE_SLICE for slice-01 or REPLAN/u,
  );
});

test("incomplete checklist recovery overrides only validation-bound implementation retry and delegation states", async (t) => {
  const exhausted = await standaloneWorkspace(t);
  await renderArtifacts(exhausted);
  await editTask(exhausted, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    return replaceSection(
      result,
      "Implementation Test Evidence",
      [1, 2, 3].map((round) => checkRecord("implementation-check", round, "TESTS_FAIL", round)).join("\n\n"),
    );
  });
  const exhaustedCandidate = await copyDirectory(exhausted.execution, path.join(exhausted.root, "exhausted-invalid-candidate"));
  await assert.rejects(
    validateExecutionCandidate(exhausted.requirements, exhaustedCandidate),
    /candidate cannot finalize execution for slice-01 while its mandatory checklist is incomplete/u,
  );
  const exhaustedState = await inspectExecutionState(exhausted.requirements);
  assert.equal(exhaustedState.state, "IMPLEMENTATION_RETRY_EXHAUSTED");
  assertRecoveryTarget(exhaustedState, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "stnl-slice-executor",
    record: "implementation-check-03",
    round: 3,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(exhausted.requirements, "EXECUTE_SLICE", "1")).state, "IMPLEMENTATION_RETRY_EXHAUSTED");
  await rejectedWithRecovery(
    preflightExecutionOperation(exhausted.requirements, "VALIDATE_SLICE", "1"),
    /legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  await editTask(exhausted, (value) => value.replace("- [ ] 1.1", "- [x] 1.1"));
  const exhaustedRecovered = await inspectExecutionState(exhausted.requirements);
  assert.equal(exhaustedRecovered.state, "IMPLEMENTATION_RETRY_EXHAUSTED");
  assertRecoveryTarget(exhaustedRecovered, {
    operation: "VALIDATE_SLICE",
    slice: "slice-01",
    owner: "retry-exhaustion",
  });
  await assert.rejects(preflightExecutionOperation(exhausted.requirements, "EXECUTE_SLICE", "1"), /not legal/u);
  assert.equal((await preflightExecutionOperation(exhausted.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTATION_RETRY_EXHAUSTED");

  const delegatedValidation = await standaloneWorkspace(t);
  await renderArtifacts(delegatedValidation);
  await editTask(delegatedValidation, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("VALIDATE_SLICE", "initialization"));
  });
  const delegatedInvalidCandidate = await copyDirectory(
    delegatedValidation.execution,
    path.join(delegatedValidation.root, "delegated-validation-invalid-candidate"),
  );
  await assert.rejects(
    validateExecutionCandidate(delegatedValidation.requirements, delegatedInvalidCandidate),
    /candidate cannot finalize execution for slice-01 while its mandatory checklist is incomplete/u,
  );
  const delegatedState = await inspectExecutionState(delegatedValidation.requirements);
  assert.equal(delegatedState.state, "RUNNER_INITIALIZATION_BLOCKED");
  assertRecoveryTarget(delegatedState, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "stnl-slice-executor",
    record: "implementation-check-01",
    round: 1,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(delegatedValidation.requirements, "EXECUTE_SLICE", "1")).state, "RUNNER_INITIALIZATION_BLOCKED");
  await editTask(delegatedValidation, (value) => value.replace("- [ ] 1.1", "- [x] 1.1"));
  const delegatedRecovered = await inspectExecutionState(delegatedValidation.requirements);
  assertRecoveryTarget(delegatedRecovered, {
    operation: "VALIDATE_SLICE",
    slice: "slice-01",
    owner: "delegation-blocker",
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(delegatedValidation.requirements, "VALIDATE_SLICE", "1")).state, "RUNNER_INITIALIZATION_BLOCKED");
});

test("file-backed Tested state rejects a truncated SHA-256 digest", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    const malformed = checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace(`sha256:${VALIDATED_HASH}`, `sha256:${VALIDATED_HASH.slice(1)}`);
    return replaceSection(result, "Implementation Test Evidence", malformed);
  });
  await assert.rejects(
    inspectExecutionState(fixture.requirements),
    /implementation-check-01 has (?:malformed Tested state|unexpected nested or continuation content under Tested state)/u,
  );
});

test("terminal auxiliary outcomes and scoped blocker resumes have exact phases", async (t) => {
  const implemented = await standaloneWorkspace(t);
  await renderArtifacts(implemented);
  await editTask(implemented, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await inspectExecutionState(implemented.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await assert.rejects(preflightExecutionOperation(implemented.requirements, "EXECUTE_SLICE", "1"), /legal next operations are VALIDATE_SLICE for slice-01 or REPLAN/u);
  assert.equal((await preflightExecutionOperation(implemented.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const corrected = await standaloneWorkspace(t);
  await renderArtifacts(corrected);
  await editTask(corrected, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    return replaceSection(result, "Findings Test Evidence", checkRecord("findings-check", 1, "TESTS_NOT_APPLICABLE", 1, { cycle: "attempt-01" }));
  });
  assert.equal((await inspectExecutionState(corrected.requirements)).state, "FINDINGS_CORRECTED");
  await assert.rejects(preflightExecutionOperation(corrected.requirements, "APPLY_FINDINGS", "1"), /not legal from FINDINGS_CORRECTED/u);
  assert.equal((await preflightExecutionOperation(corrected.requirements, "VALIDATE_SLICE", "1")).state, "FINDINGS_CORRECTED");

  const initialized = await standaloneWorkspace(t);
  await renderArtifacts(initialized);
  await editTask(initialized, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization"));
  });
  const initializedState = await inspectExecutionState(initialized.requirements);
  assert.equal(initializedState.state, "RUNNER_INITIALIZATION_BLOCKED");
  assert.deepEqual(initializedState.mandatoryRecovery, initializedState.recoveryTargets[0]);
  assert.deepEqual(initializedState.legalOperations, [{ operation: "EXECUTE_SLICE", slice: "slice-01" }]);
  assert.equal(initializedState.normalHandoff, null);
  assertRecoveryTarget(initializedState, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "delegation-blocker",
    record: null,
    round: null,
    retryState: null,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(initialized.requirements, "EXECUTE_SLICE", "1")).state, "RUNNER_INITIALIZATION_BLOCKED");
  const wrongOperation = await rejectedWithRecovery(
    preflightExecutionOperation(initialized.requirements, "REPLAN"),
    /legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  assertRecoveryTarget(wrongOperation, { operation: "EXECUTE_SLICE", slice: "slice-01" });
  const unsupportedOperation = await rejectedWithRecovery(
    preflightExecutionOperation(initialized.requirements, "DELETE_MANUALLY"),
    /unsupported operation DELETE_MANUALLY; legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  assertRecoveryTarget(unsupportedOperation, { operation: "EXECUTE_SLICE", slice: "slice-01" });
  const wrongSlice = await rejectedWithRecovery(
    preflightExecutionOperation(initialized.requirements, "EXECUTE_SLICE", "2"),
    /legal next operation is EXECUTE_SLICE for slice-01/u,
  );
  assertRecoveryTarget(wrongSlice, { operation: "EXECUTE_SLICE", slice: "slice-01" });
  const cli = spawnSync(process.execPath, [
    path.join(ROOT, "skills/workflows/stnl-slice-executor/runtime/validate-execution-state.mjs"),
    initialized.requirements,
    "REPLAN",
  ], { encoding: "utf8" });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /legal next operation is EXECUTE_SLICE for slice-01/u);
  await editTask(initialized, (value) => {
    let result = replaceSection(value, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization", { state: "resolved", resolution: "implementation-check-01 returned a valid result" }));
  });
  assert.equal((await inspectExecutionState(initialized.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const malformed = await standaloneWorkspace(t);
  await renderArtifacts(malformed);
  await editTask(malformed, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("VALIDATE_SLICE", "malformed-output"));
  });
  const malformedState = await inspectExecutionState(malformed.requirements);
  assert.equal(malformedState.state, "RUNNER_RESULT_BLOCKED");
  assert.deepEqual(malformedState.mandatoryRecovery, malformedState.recoveryTargets[0]);
  assert.equal(malformedState.normalHandoff, null);
  assertRecoveryTarget(malformedState, {
    operation: "VALIDATE_SLICE",
    slice: "slice-01",
    owner: "delegation-blocker",
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(malformed.requirements, "VALIDATE_SLICE", "1")).state, "RUNNER_RESULT_BLOCKED");
});

test("APPLY_FINDINGS recovery remains bound to persisted slice-02 and exposes auxiliary round ownership", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await passFirstSlice(fixture);
  const second = path.join(fixture.execution, "tasks/slice-02.md");
  let task = await fs.readFile(second, "utf8");
  task = task.replace("- [ ] 2.1", "- [x] 2.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Validation Attempts", NEEDS_FIX_ATTEMPT);
  task = replaceSection(task, "Validation Findings", ACTIVE_FINDING);
  task = replaceSection(task, "Delegation Blocker", delegationBlocker("APPLY_FINDINGS", "initialization"));
  await fs.writeFile(second, task, "utf8");

  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "RUNNER_INITIALIZATION_BLOCKED");
  assertRecoveryTarget(blocked, {
    operation: "APPLY_FINDINGS",
    slice: "slice-02",
    owner: "delegation-blocker",
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "2")).state, "RUNNER_INITIALIZATION_BLOCKED");
  await rejectedWithRecovery(
    preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "2"),
    /legal next operation is APPLY_FINDINGS for slice-02/u,
  );

  task = await fs.readFile(second, "utf8");
  task = replaceSection(task, "Delegation Blocker", "- none");
  task = replaceSection(task, "Corrections Applied", "- `../../src/example.txt`");
  task = replaceSection(task, "Findings Test Evidence", checkRecord("findings-check", 1, "BLOCKED", 1, { cycle: "attempt-01" }));
  await fs.writeFile(second, task, "utf8");
  const auxiliary = await inspectExecutionState(fixture.requirements);
  assert.equal(auxiliary.state, "AUXILIARY_BLOCKED");
  assertRecoveryTarget(auxiliary, {
    operation: "APPLY_FINDINGS",
    slice: "slice-02",
    owner: "auxiliary-check",
    record: "findings-check-01",
    round: 1,
    sameOperationResumeRequired: true,
  });
});

test("an executor delegation blocker remains narrowly resumable when later validation history would otherwise deadlock it", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization"));
  });

  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "RUNNER_INITIALIZATION_BLOCKED");
  assertRecoveryTarget(blocked, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "delegation-blocker",
    record: null,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1")).state, "RUNNER_INITIALIZATION_BLOCKED");
  await rejectedWithRecovery(
    preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1"),
    /legal next operation is EXECUTE_SLICE for slice-01/u,
  );

  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization", {
      state: "resolved",
      resolution: "implementation-check-01 returned a valid result",
    }));
  });
  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "VALIDATION_NEEDS_FIX");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1")).state, "VALIDATION_NEEDS_FIX");
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"), /not legal/u);
});

test("auxiliary BLOCKED resumes only its originating operation and later records clear it", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "BLOCKED", 1));
  });
  const blocked = await inspectExecutionState(fixture.requirements);
  assert.equal(blocked.state, "AUXILIARY_BLOCKED");
  assertRecoveryTarget(blocked, {
    operation: "EXECUTE_SLICE",
    slice: "slice-01",
    owner: "auxiliary-check",
    record: "implementation-check-01",
    round: 1,
    sameOperationResumeRequired: true,
  });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1")).state, "AUXILIARY_BLOCKED");
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "APPLY_FINDINGS", "1"), /legal next operation is EXECUTE_SLICE for slice-01/u);
  await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", `${checkRecord("implementation-check", 1, "BLOCKED", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 1)}`));
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("append-only requirements recovery preserves history and requires later PASS ownership", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Divergences", ACTIVE_DIVERGENCE);
  });
  await fs.appendFile(fixture.requirements, "- AC-002: changed after partial execution\n");
  const newHash = await computeRequirementsAuthority(fixture.requirements);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "REQUIREMENTS_CHANGED");
  await appendRecoveryPlan(fixture, oldHash, newHash);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-02", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  await commitAppendRecovery(fixture, oldHash, newHash, { resolveDivergence: true });
  const recovered = await inspectExecutionState(fixture.requirements);
  assert.equal(recovered.state, "EXECUTION_STARTED");
  assert.equal(recovered.tasks.get("slice-01").divergences[0].state, "resolved");
  // Terminalizing the replacement without PASS ownership is an impossible corrective request.
  const replacementPath = path.join(fixture.execution, "tasks/slice-02.md");
  let impossibleReplacement = await fs.readFile(replacementPath, "utf8");
  impossibleReplacement = impossibleReplacement.replace("- [ ] 1.1", "- [x] 1.1");
  impossibleReplacement = replaceSection(impossibleReplacement, "Changed Areas", "- `../../src/example.txt`");
  impossibleReplacement = impossibleReplacement.replace("## Final Result\n\n- pending", "## Final Result\n\n- SUPERSEDED\n- Superseded by: slice-02\n- Plan revision: 2");
  await fs.writeFile(replacementPath, impossibleReplacement, "utf8");
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |", "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | SUPERSEDED | SUPERSEDED |"));
  await assert.rejects(inspectExecutionState(fixture.requirements), /committed supersessions do not exactly match|invalid later replacement slice/u);
});

test("a later missing integration slice has an executable append-only REPLAN path", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "COMPLETE");
  await appendRecoveryPlan(fixture, authority, authority, { supersedes: "none" });
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
});

test("superseded historical paths become terminal only through a later current-authority PASS", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority: oldHash } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Changed Areas", "- `../../src/example.txt`"));
  await fs.appendFile(fixture.requirements, "- AC-002: corrective integration\n");
  const newHash = await computeRequirementsAuthority(fixture.requirements);
  await appendRecoveryPlan(fixture, oldHash, newHash, { ready: true });
  await commitAppendRecovery(fixture, oldHash, newHash);
  const second = path.join(fixture.execution, "tasks/slice-02.md");
  let task = await fs.readFile(second, "utf8");
  task = task.replace("- [ ] 1.1", "- [x] 1.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Validation Attempts", PASS_ATTEMPT);
  task = replaceSection(task, "Effective Validation Base", PASS_BASE);
  task = publishPassResult(task);
  await fs.writeFile(second, task);
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | pending | pending |", "| [x] | 02 - Recovery | reconciled result | 01 | tasks/slice-02.md | PASS | PASS |"));
  await writeValidatedPath(fixture);
  const complete = await inspectExecutionState(fixture.requirements);
  assert.deepEqual(complete.legalOperations, [{ operation: "REPLAN", slice: null }]);
  assert.equal(complete.normalHandoff, null);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "COMPLETE", "terminal recovery must permit a corrective replan from COMPLETE");
});

test("repeated append-only REPLAN preserves older supersession revisions and commits exact current mappings", async (t) => {
  const fixture = await standaloneWorkspace(t);
  const { authority } = await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Changed Areas", "- `../../src/example.txt`"));
  await appendRecoveryPlan(fixture, authority, authority, { ready: true });
  await commitAppendRecovery(fixture, authority, authority);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "EXECUTION_STARTED");

  await stageThirdRecovery(fixture, authority);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REVIEW_PLAN")).state, "PENDING_REPLAN_DRAFT");
  await editPlan(fixture, (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  await editSlicePlan(fixture, "slice-03", (value) => value.replace("status: draft", "status: ready").replace("Review state: pending", "Review state: approved"));
  assert.equal((await preflightExecutionOperation(fixture.requirements, "MATERIALIZE_TASKS")).state, "PENDING_REPLAN_READY");
  await commitThirdRecovery(fixture, authority);
  const committed = await inspectExecutionState(fixture.requirements);
  assert.equal(committed.state, "EXECUTION_STARTED");
  assert.equal(committed.tasks.get("slice-01").final.planRevision, 2);
  assert.equal(committed.tasks.get("slice-02").final.planRevision, 3);

  const omittedMapping = await standaloneWorkspace(t);
  const { authority: omittedAuthority } = await renderArtifacts(omittedMapping);
  await appendRecoveryPlan(omittedMapping, omittedAuthority, omittedAuthority, { ready: true });
  await commitAppendRecovery(omittedMapping, omittedAuthority, omittedAuthority);
  await editPlan(omittedMapping, (value) => value.replace("- Supersedes open slices: slice-01 -> slice-02", "- Supersedes open slices: none"));
  await assert.rejects(inspectExecutionState(omittedMapping.requirements), /committed supersessions do not exactly match/u);
});

test("attempt/check numbering, unresolved blockers at PASS, and structural gates reject deterministically", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => replaceSection(value, "Implementation Test Evidence", checkRecord("implementation-check", 2, "TESTS_PASS", 1)));
  await assert.rejects(inspectExecutionState(fixture.requirements), /contiguous from 01/u);

  const findingFixture = await standaloneWorkspace(t);
  await renderArtifacts(findingFixture);
  await editTask(findingFixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${NEEDS_FIX_ATTEMPT}\n\n${attemptRecord(2, "PASS", { references: "finding-01", dispositions: "finding-01=active" })}`);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await assert.rejects(inspectExecutionState(findingFixture.requirements), /active blocker/u);

  const divergenceFixture = await standaloneWorkspace(t);
  await renderArtifacts(divergenceFixture);
  await editTask(divergenceFixture, (value) => replaceSection(value, "Divergences", ACTIVE_DIVERGENCE));
  assert.equal((await inspectExecutionState(divergenceFixture.requirements)).state, "DIVERGENCE_BLOCKED");

  const incompleteAttempt = await standaloneWorkspace(t);
  await renderArtifacts(incompleteAttempt);
  await editTask(incompleteAttempt, (value) => {
    let result = replaceSection(value, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  await assert.rejects(inspectExecutionState(incompleteAttempt.requirements), /Validation Attempts before the mandatory checklist is complete/u);

  const backward = await standaloneWorkspace(t);
  await renderArtifacts(backward);
  const finding2 = ACTIVE_FINDING.replaceAll("finding-01", "finding-02").replace("- State: active", "- State: superseded") + "\n- Superseded by: finding-01";
  const finding3 = ACTIVE_FINDING.replaceAll("finding-01", "finding-03");
  await editTask(backward, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    return replaceSection(result, "Validation Findings", `${ACTIVE_FINDING}\n\n${finding2}\n\n${finding3}`);
  });
  await assert.rejects(inspectExecutionState(backward.requirements), /finding-02 has invalid Superseded by/u);

  const pendingPass = await standaloneWorkspace(t);
  await renderArtifacts(pendingPass);
  await editTask(pendingPass, (value) => replaceSection(value.replace("- [ ] 1.1", "- [x] 1.1"), "Validation Attempts", PASS_ATTEMPT));
  await assert.rejects(inspectExecutionState(pendingPass.requirements), /latest PASS attempt was not published atomically/u);

  const malformedBases = [
    [PASS_BASE.replace("- Attempt type: initial", "- Attempt type: revalidation"), /Attempt type disagrees/u],
    [PASS_BASE.replace("- HEAD: fixture", "- HEAD: unrelated"), /HEAD disagrees/u],
    [PASS_BASE.replace("  - `..\/..\/src\/example.txt` | sha256:", "  - malformed | sha256:"), /malformed Files manifest/u],
    [PASS_BASE.replace("- Evidence summary: Objective PASS evidence.", "- Evidence summary: pending"), /Evidence summary/u],
  ];
  for (const [invalidBase, expected] of malformedBases) {
    const malformed = await standaloneWorkspace(t);
    await renderArtifacts(malformed);
    await editTask(malformed, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
      result = replaceSection(result, "Effective Validation Base", invalidBase);
      return publishPassResult(result);
    });
    await assert.rejects(inspectExecutionState(malformed.requirements), expected);
  }

  const malformedClaims = [
    ["- `../../src/example.txt`\n  - `../../src/hidden.txt`", /canonical task-relative path claims/u],
    ["- `../../src/example.txt`\n- arbitrary prose", /canonical task-relative path claims/u],
    ["- `../../src/z.txt`\n- `../../src/a.txt`", /not lexicographically ordered/u],
    ["- `../../src/example.txt`\n- `../../src/example.txt`", /duplicate path claims/u],
  ];
  for (const [claims, expected] of malformedClaims) {
    const malformed = await standaloneWorkspace(t);
    await renderArtifacts(malformed);
    await editTask(malformed, (value) => replaceSection(value, "Changed Areas", claims));
    await assert.rejects(inspectExecutionState(malformed.requirements), expected);
  }

  const unlistedCorrection = await standaloneWorkspace(t);
  await renderArtifacts(unlistedCorrection);
  await editTask(unlistedCorrection, (value) => {
    let result = replaceSection(value, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Corrections Applied", "- `../../src/other.txt`");
  });
  await assert.rejects(inspectExecutionState(unlistedCorrection.requirements), /correction path is absent from Changed Areas/u);
});

test("Effective Validation Base commands and evidence are exact provenance of the owning PASS attempt", async (t) => {
  for (const [mutation, expected] of [
    [(base) => base.replace("`node --test`", "`node --test --test-name-pattern provenance`"), /authoritative commands disagree with its origin attempt/u],
    [(base) => base.replace("Objective PASS evidence.", "Different claimed PASS evidence."), /Evidence summary disagrees with its origin attempt/u],
    [(base) => `${base}\n- Authoritative commands:\n  - \`conflicting command\` | exit:0`, /exactly one Authoritative commands|unexpected content after Evidence summary/u],
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
      result = replaceSection(result, "Effective Validation Base", mutation(PASS_BASE));
      result = replaceSection(result, "Diff Summary", "- Implemented and validated the observable behavior.");
      return replaceSection(result, "Final Result", "- PASS");
    });
    await editTasksIndex(fixture, (value) => value.replace(
      "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
      "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
    ));
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }
});

test("fileless PASS uses an explicit none manifest with objective reason and evidence", async (t) => {
  const filelessAttempt = attemptRecord(1, "PASS", { evidence: "validated observable behavior" });
  const filelessCheck = checkRecord("implementation-check", 1, "TESTS_PASS", 1)
    .replace(`- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`, "- Tested state: none\n- Fileless reason: no repository file participates in the observable configuration state");
  const filelessBase = `- Origin attempt: attempt-01
- Attempt type: initial
- HEAD: fixture
- Result: PASS
- Files: none
- Fileless reason: the slice changes no repository file and validates an externally observable configuration state
- Authoritative commands:
  - \`node --test\` | exit:0
- Evidence summary: validated observable behavior`;

  const valid = await standaloneWorkspace(t);
  await renderArtifacts(valid);
  await editTask(valid, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- none");
    return replaceSection(result, "Implementation Test Evidence", filelessCheck);
  });
  assert.equal((await inspectExecutionState(valid.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.equal((await preflightExecutionOperation(valid.requirements, "VALIDATE_SLICE", "1")).state, "IMPLEMENTED_AWAITING_VALIDATION");
  await editTask(valid, (value) => {
    let result = value;
    result = replaceSection(result, "Validation Attempts", filelessAttempt);
    result = replaceSection(result, "Effective Validation Base", filelessBase);
    return publishPassResult(result);
  });
  await editTasksIndex(valid, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  assert.equal((await inspectExecutionState(valid.requirements)).state, "COMPLETE");

  for (const [name, baseMutation, error, attemptMutation = (attempt) => attempt] of [
    ["missing reason", (base) => base.replace(/^- Fileless reason:.*\n/mu, ""), /Fileless reason/u],
    ["placeholder reason", (base) => base.replace(/^- Fileless reason:.*$/mu, "- Fileless reason: pending"), /Fileless reason/u],
    ["whitespace reason", (base) => base.replace(/^- Fileless reason:.*$/mu, "- Fileless reason:   "), /Fileless reason/u],
    ["placeholder evidence", (base) => base.replace("- Evidence summary: validated observable behavior", "- Evidence summary: pending"), /Evidence summary/u],
    [
      "whitespace attempt and base evidence",
      (base) => base.replace("- Evidence summary: validated observable behavior", "- Evidence summary:   "),
      /Evidence|Evidence summary/u,
      (attempt) => attempt.replace("- Evidence: validated observable behavior", "- Evidence:   "),
    ],
  ]) {
    const invalid = await standaloneWorkspace(t);
    await renderArtifacts(invalid);
    await editTask(invalid, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- none");
      result = replaceSection(result, "Implementation Test Evidence", filelessCheck);
      result = replaceSection(result, "Validation Attempts", attemptMutation(filelessAttempt));
      result = replaceSection(result, "Effective Validation Base", baseMutation(filelessBase));
      return publishPassResult(result);
    });
    await editTasksIndex(invalid, (value) => value.replace(
      "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
      "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
    ));
    await assert.rejects(inspectExecutionState(invalid.requirements), error, name);
  }
});

test("fileless APPLY_FINDINGS needs objective evidence but no fabricated path", async (t) => {
  const fileless = (record) => record.replace(
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    "- Tested state: none\n- Fileless reason: the correction changes observable authority without filesystem ownership",
  ).replace("- Corrections covered: ../../src/example.txt", "- Corrections covered: objective authority-only correction");

  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- none");
    result = replaceSection(result, "Corrections Applied", "- none");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    return replaceSection(result, "Findings Test Evidence", fileless(
      checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" }),
    ));
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "FINDINGS_CORRECTED");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "FINDINGS_CORRECTED");

  const retried = await standaloneWorkspace(t);
  await renderArtifacts(retried);
  await editTask(retried, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- none");
    result = replaceSection(result, "Corrections Applied", "- none");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    const first = fileless(checkRecord("findings-check", 1, "TESTS_FAIL", 1, { cycle: "attempt-01" }));
    const second = fileless(checkRecord("findings-check", 2, "TESTS_PASS", 2, { cycle: "attempt-01" }))
      .replace("- Correction paths: ../../src/example.txt", "- Correction paths: none")
      .replace("- Correction applied: bounded objective correction", "- Correction applied: corrected authority-only behavior with no filesystem ownership");
    return replaceSection(result, "Findings Test Evidence", `${first}\n\n${second}`);
  });
  assert.equal((await inspectExecutionState(retried.requirements)).state, "FINDINGS_CORRECTED");
});

test("only the current state-driving auxiliary check controls fileless Changed Areas", async (t) => {
  const fileless = (record) => record.replace(
    `- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    "- Tested state: none\n- Fileless reason: no repository file participates in current tested state",
  );

  const contradiction = await standaloneWorkspace(t);
  await renderArtifacts(contradiction);
  await editTask(contradiction, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", fileless(
      checkRecord("implementation-check", 1, "TESTS_PASS", 1),
    ));
  });
  await assert.rejects(inspectExecutionState(contradiction.requirements), /current fileless.*Changed Areas: none/u);

  const mixedHistory = await standaloneWorkspace(t);
  await renderArtifacts(mixedHistory);
  await editTask(mixedHistory, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    const historical = fileless(checkRecord("implementation-check", 1, "TESTS_FAIL", 1));
    const current = checkRecord("implementation-check", 2, "TESTS_PASS", 2);
    return replaceSection(result, "Implementation Test Evidence", `${historical}\n\n${current}`);
  });
  assert.equal((await inspectExecutionState(mixedHistory.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("Final Result accepts one exact terminal authority and rejects masked conflicts", async (t) => {
  for (const invalid of [
    "- PASS\n- pending",
    "- PASS\n- PASS",
    "- pending\n- PASS",
    "- PASS\n- SUPERSEDED",
    "- PASS\n- terminal: PASS",
  ]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
      result = replaceSection(result, "Effective Validation Base", PASS_BASE);
      result = replaceSection(result, "Diff Summary", "- Implemented and validated the observable behavior.");
      return replaceSection(result, "Final Result", invalid);
    });
    await editTasksIndex(fixture, (value) => value.replace(
      "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
      "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
    ));
    await assert.rejects(inspectExecutionState(fixture.requirements), /Final Result is malformed/u);
  }
});

test("canonical execution tables and checklists reject every unexpected structural row", async (t) => {
  const malformedPlan = await standaloneWorkspace(t);
  await renderArtifacts(malformedPlan);
  await editPlan(malformedPlan, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |\n| malformed serial row |",
  ));
  await assert.rejects(inspectExecutionState(malformedPlan.requirements), /Serial Slice Order.*malformed row/u);

  const malformedTasks = await standaloneWorkspace(t);
  await renderArtifacts(malformedTasks);
  await editTasksIndex(malformedTasks, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |\n| unexpected task row |",
  ));
  await assert.rejects(inspectExecutionState(malformedTasks.requirements), /tasks\.md has malformed row/u);

  const nonPipePlan = await standaloneWorkspace(t);
  await renderArtifacts(nonPipePlan);
  await editPlan(nonPipePlan, (value) => value.replace(
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |",
    "| 01 - Delivery | observable result | - | AC-001 | `../src/example.txt`; example implementation (plain-text description) | plans/slice-01.md |\nmalformed serial row without pipes",
  ));
  await assert.rejects(inspectExecutionState(nonPipePlan.requirements), /Serial Slice Order.*unexpected structural row/u);

  const nonPipeTasks = await standaloneWorkspace(t);
  await renderArtifacts(nonPipeTasks);
  await editTasksIndex(nonPipeTasks, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |\nmalformed task row without pipes",
  ));
  assert.equal((await inspectExecutionState(nonPipeTasks.requirements)).state, "MATERIALIZED_PRISTINE");

  const malformedChecklist = await standaloneWorkspace(t);
  await renderArtifacts(malformedChecklist);
  await editTask(malformedChecklist, (value) => value.replace(
    "- [ ] 1.1 Implement behavior | observable result: observable result | expected areas: `../../src/example.txt`; example implementation | requirement: AC-001",
    "- [ ] 1.1 Implement behavior | observable result: observable result | expected areas: `../../src/example.txt`; example implementation | requirement: AC-001\n- [ ] malformed checklist row",
  ));
  await assert.rejects(inspectExecutionState(malformedChecklist.requirements), /malformed Checklist row/u);
});

test("scalar summaries stay inline while Tested state and Commands stay structurally scoped", async (t) => {
  const valid = await standaloneWorkspace(t);
  await renderArtifacts(valid);
  await editTask(valid, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await inspectExecutionState(valid.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");

  const mutations = [
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope:   "), /Tested scope/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n- Tested scope:"), /exactly one 'Tested scope' field/u],
    [(record) => `${record}\n- Fileless reason:`, /Fileless reason/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n  additional scope"), /unexpected nested or continuation/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n    - nested scalar value"), /unexpected nested/u],
    [(record) => record.replace("- Selected checks: node --test", "- Selected checks: node --test\n\t- nested scalar value"), /unexpected nested/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n  * second value"), /unexpected nested/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n  + second value"), /unexpected nested/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope: ../../src/example.txt\n  1. second value"), /unexpected nested/u],
    [(record) => record.replace("- Tested scope: ../../src/example.txt", "- Tested scope:\n  - ../../src/example.txt"), /Tested scope|unexpected nested/u],
    [(record) => record.replace(
      `  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
      `  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
    ), /duplicate Tested state paths/u],
    [(record) => record.replace(
      `  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`,
      `  - \`../../src/z.txt\` | sha256:${VALIDATED_HASH}\n  - \`../../src/a.txt\` | sha256:${VALIDATED_HASH}`,
    ), /Tested state paths are not lexicographically ordered/u],
    [(record) => record.replace("`../../src/example.txt`", "`../../../outside.txt`"), /unsafe Tested state path/u],
    [(record) => record
      .replace("- Commands:\n  - `node --test` | exit:0", "- Commands:")
      .replace("- Selected checks: node --test", "- Selected checks: focused check\n  - `node --test` | exit:0"), /Commands|unexpected nested/u],
  ];
  for (const [mutate, expected] of mutations) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      return replaceSection(result, "Implementation Test Evidence", mutate(checkRecord("implementation-check", 1, "TESTS_PASS", 1)));
    });
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }

  const whitespaceReason = await standaloneWorkspace(t);
  await renderArtifacts(whitespaceReason);
  await editTask(whitespaceReason, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- none");
    const fileless = checkRecord("implementation-check", 1, "TESTS_PASS", 1)
      .replace(`- Tested state:\n  - \`../../src/example.txt\` | sha256:${VALIDATED_HASH}`, "- Tested state: none\n- Fileless reason:   ");
    return replaceSection(result, "Implementation Test Evidence", fileless);
  });
  await assert.rejects(inspectExecutionState(whitespaceReason.requirements), /Fileless reason/u);

  const attemptNested = await standaloneWorkspace(t);
  await renderArtifacts(attemptNested);
  await editTask(attemptNested, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT.replace(
      "- Verified scope: ../../src/example.txt",
      "- Verified scope: ../../src/example.txt\n  additional scope\n  - `hidden command` | exit:0",
    ));
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  await assert.rejects(inspectExecutionState(attemptNested.requirements), /unexpected nested/u);
});

test("Finding IDs are canonical ordered sets tied to declared findings and their cycle", async (t) => {
  const prepare = async (value) => {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (task) => {
      let result = task.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
      result = replaceSection(result, "Validation Attempts", attemptRecord(1, "NEEDS_FIX", {
        references: "finding-01, finding-02",
        dispositions: "finding-01=active, finding-02=active",
      }));
      result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING}\n\n${ACTIVE_FINDING_02}`);
      const check = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" })
        .replace("- Finding IDs: finding-01", `- Finding IDs: ${value}`)
        .replace("- Findings verified: finding-01", `- Findings verified: ${value}`);
      return replaceSection(result, "Findings Test Evidence", check);
    });
    return fixture;
  };

  const valid = await prepare("finding-01, finding-02");
  assert.equal((await inspectExecutionState(valid.requirements)).state, "FINDINGS_CORRECTED");
  for (const [value, expected] of [
    ["finding-01, finding-01", /duplicate Finding IDs/u],
    ["finding-02, finding-01", /Finding IDs are not lexicographically ordered/u],
    ["finding-01, finding-99", /undeclared Finding ID finding-99/u],
    ["finding-01,finding-02", /malformed Finding IDs/u],
  ]) {
    const fixture = await prepare(value);
    await assert.rejects(inspectExecutionState(fixture.requirements), expected);
  }
});

test("Findings verified may be a canonical subset while unsupported reconciles active authority", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", NEEDS_FIX_ATTEMPT);
    result = replaceSection(result, "Validation Findings", ACTIVE_FINDING);
    const partial = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" })
      .replace("- Findings verified: finding-01", "- Findings verified: none")
      .replace("- Unsupported active findings: none", "- Unsupported active findings: finding-01");
    return replaceSection(result, "Findings Test Evidence", partial);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "FINDINGS_CORRECTED");

  const invalid = await standaloneWorkspace(t);
  await renderArtifacts(invalid);
  await editTask(invalid, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", attemptRecord(1, "NEEDS_FIX", {
      references: "finding-01, finding-02",
      dispositions: "finding-01=active, finding-02=active",
    }));
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING}\n\n${ACTIVE_FINDING_02}`);
    const check = checkRecord("findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" })
      .replace("- Findings verified: finding-01", "- Findings verified: finding-02")
      .replace("- Unsupported active findings: none", "- Unsupported active findings: finding-01");
    return replaceSection(result, "Findings Test Evidence", check);
  });
  await assert.rejects(inspectExecutionState(invalid.requirements), /Findings verified.*subset/u);
});

test("TESTS_PASS rejects none only in the four objective summary fields", async (t) => {
  for (const fieldName of ["Tested scope", "Verification types considered", "Selected checks", "Coverage"]) {
    const fixture = await standaloneWorkspace(t);
    await renderArtifacts(fixture);
    await editTask(fixture, (value) => {
      let result = value.replace("- [ ] 1.1", "- [x] 1.1");
      result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
      const check = checkRecord("implementation-check", 1, "TESTS_PASS", 1)
        .replace(new RegExp(`^- ${fieldName}:.*$`, "mu"), `- ${fieldName}: none`);
      return replaceSection(result, "Implementation Test Evidence", check);
    });
    await assert.rejects(inspectExecutionState(fixture.requirements), new RegExp(fieldName, "u"));
  }

  const canonical = await standaloneWorkspace(t);
  await renderArtifacts(canonical);
  await editTask(canonical, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  assert.equal((await inspectExecutionState(canonical.requirements)).state, "IMPLEMENTED_AWAITING_VALIDATION");
});

test("a finding is active at origin and terminalizes only under later authority", async (t) => {
  const resolvedAtOrigin = await standaloneWorkspace(t);
  await renderArtifacts(resolvedAtOrigin);
  await editTask(resolvedAtOrigin, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${attemptRecord(1, "NEEDS_FIX", {
      references: "finding-01", dispositions: "finding-01=resolved",
    })}\n\n${attemptRecord(2, "PASS", {
      references: "finding-01", dispositions: "finding-01=resolved",
    })}`);
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING.replace("- State: active", "- State: resolved")}\n- Resolution: attempt-01 claimed immediate resolution.`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await editTasksIndex(resolvedAtOrigin, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(resolvedAtOrigin.requirements), /strictly later|later formal attempt/u);

  const supersededAtOrigin = await standaloneWorkspace(t);
  await renderArtifacts(supersededAtOrigin);
  const superseded = `${ACTIVE_FINDING.replace("- State: active", "- State: superseded")}\n- Superseded by: finding-02`;
  await editTask(supersededAtOrigin, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", attemptRecord(1, "NEEDS_FIX", {
      references: "finding-01, finding-02",
      dispositions: "finding-01=superseded, finding-02=active",
    }));
    return replaceSection(result, "Validation Findings", `${superseded}\n\n${ACTIVE_FINDING_02}`);
  });
  await assert.rejects(inspectExecutionState(supersededAtOrigin.requirements), /origin must be strictly later/u);
});

test("the first formal PASS is terminal for its slice", async (t) => {
  const passPass = await standaloneWorkspace(t);
  await renderArtifacts(passPass);
  await editTask(passPass, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${PASS_ATTEMPT}\n\n${attemptRecord(2, "PASS")}`);
    result = replaceSection(result, "Effective Validation Base", passBase({ attempt: 2 }));
    return publishPassResult(result);
  });
  await editTasksIndex(passPass, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(passPass.requirements), /attempt-01 PASS is terminal/u);

  const passNeedsFix = await standaloneWorkspace(t);
  await renderArtifacts(passNeedsFix);
  const laterFinding = ACTIVE_FINDING.replace("Origin: attempt-01", "Origin: attempt-02");
  await editTask(passNeedsFix, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", `${PASS_ATTEMPT}\n\n${attemptRecord(2, "NEEDS_FIX", {
      references: "finding-01", dispositions: "finding-01=active",
    })}`);
    return replaceSection(result, "Validation Findings", laterFinding);
  });
  await assert.rejects(inspectExecutionState(passNeedsFix.requirements), /attempt-01 PASS is terminal/u);
});

test("work, corrections, findings authority, terminal diff, and blocker resolution reconcile exactly", async (t) => {
  const pendingChanged = await standaloneWorkspace(t);
  await renderArtifacts(pendingChanged);
  await editTask(pendingChanged, (value) => replaceSection(
    value.replace("- [ ] 1.1", "- [x] 1.1"),
    "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "TESTS_PASS", 1),
  ));
  await assert.rejects(inspectExecutionState(pendingChanged.requirements), /Changed Areas cannot remain pending after work/u);

  const noCorrections = await standaloneWorkspace(t);
  await renderArtifacts(noCorrections);
  await prepareFindingsCorrection(noCorrections);
  await editTask(noCorrections, (value) => replaceSection(value, "Corrections Applied", "- none"));
  await assert.rejects(inspectExecutionState(noCorrections.requirements), /Findings Test Evidence requires Corrections Applied/u);

  const wrongRoundPath = await standaloneWorkspace(t);
  await renderArtifacts(wrongRoundPath);
  await editTask(wrongRoundPath, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    const records = `${checkRecord("implementation-check", 1, "TESTS_FAIL", 1)}\n\n${checkRecord("implementation-check", 2, "TESTS_PASS", 2).replace("- Correction paths: ../../src/example.txt", "- Correction paths: ../../src/other.txt")}`;
    return replaceSection(result, "Implementation Test Evidence", records);
  });
  await assert.rejects(inspectExecutionState(wrongRoundPath.requirements), /Correction paths.*Corrections Applied/u);

  const wrongAttemptIds = await standaloneWorkspace(t);
  await renderArtifacts(wrongAttemptIds);
  await editTask(wrongAttemptIds, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", attemptRecord(1, "NEEDS_FIX", {
      references: "finding-99",
      dispositions: "finding-99=active",
    }));
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  await assert.rejects(inspectExecutionState(wrongAttemptIds.requirements), /undeclared finding-99/u);

  const contradictoryTimeline = await standaloneWorkspace(t);
  await renderArtifacts(contradictoryTimeline);
  await editTask(contradictoryTimeline, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", [
      NEEDS_FIX_ATTEMPT,
      attemptRecord(2, "NEEDS_FIX", { references: "finding-01", dispositions: "finding-01=resolved" }),
      attemptRecord(3, "NEEDS_FIX", { references: "finding-01", dispositions: "finding-01=active" }),
    ].join("\n\n"));
    return replaceSection(result, "Validation Findings", ACTIVE_FINDING);
  });
  await assert.rejects(inspectExecutionState(contradictoryTimeline.requirements), /disposition contradicts.*timeline/u);

  const historicalUnsupported = await standaloneWorkspace(t);
  await renderArtifacts(historicalUnsupported);
  await editTask(historicalUnsupported, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Corrections Applied", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", [
      attemptRecord(1, "NEEDS_FIX", {
        references: "finding-01, finding-02",
        dispositions: "finding-01=active, finding-02=active",
      }),
      attemptRecord(2, "NEEDS_FIX", {
        references: "finding-01, finding-02",
        dispositions: "finding-01=active, finding-02=active",
      }),
    ].join("\n\n"));
    result = replaceSection(result, "Validation Findings", `${ACTIVE_FINDING}\n\n${ACTIVE_FINDING_02}`);
    return replaceSection(result, "Findings Test Evidence", checkRecord(
      "findings-check", 1, "TESTS_PASS", 1, { cycle: "attempt-01" },
    ));
  });
  await assert.rejects(inspectExecutionState(historicalUnsupported.requirements), /Unsupported active findings contradict/u);

  const unsupportedContradiction = await standaloneWorkspace(t);
  await renderArtifacts(unsupportedContradiction);
  await prepareFindingsCorrection(unsupportedContradiction);
  await editTask(unsupportedContradiction, (value) => value.replace(
    "- Unsupported active findings: none",
    "- Unsupported active findings: finding-01",
  ));
  await assert.rejects(inspectExecutionState(unsupportedContradiction.requirements), /Unsupported active findings contradict/u);

  const pendingDiff = await standaloneWorkspace(t);
  await renderArtifacts(pendingDiff);
  await editTask(pendingDiff, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return replaceSection(result, "Final Result", "- PASS");
  });
  await editTasksIndex(pendingDiff, (value) => value.replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ));
  await assert.rejects(inspectExecutionState(pendingDiff.requirements), /terminal PASS requires a non-placeholder Diff Summary/u);

  const blockerWithPendingChangedAreas = await standaloneWorkspace(t);
  await renderArtifacts(blockerWithPendingChangedAreas);
  await editTask(blockerWithPendingChangedAreas, (value) => replaceSection(
    value,
    "Delegation Blocker",
    delegationBlocker("EXECUTE_SLICE", "initialization"),
  ));
  await assert.rejects(inspectExecutionState(blockerWithPendingChangedAreas.requirements), /Changed Areas cannot remain pending after work/u);

  const diffWithPendingChangedAreas = await standaloneWorkspace(t);
  await renderArtifacts(diffWithPendingChangedAreas);
  await editTask(diffWithPendingChangedAreas, (value) => replaceSection(
    value,
    "Diff Summary",
    "- Implemented the observable behavior.",
  ));
  await assert.rejects(inspectExecutionState(diffWithPendingChangedAreas.requirements), /Changed Areas cannot remain pending after work/u);

  const wrongResolution = await standaloneWorkspace(t);
  await renderArtifacts(wrongResolution);
  await editTask(wrongResolution, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
    return replaceSection(result, "Delegation Blocker", delegationBlocker("EXECUTE_SLICE", "initialization", {
      state: "resolved",
      resolution: "attempt-01 returned a valid result",
    }));
  });
  await assert.rejects(inspectExecutionState(wrongResolution.requirements), /Resolution must name implementation-check-01/u);
});

test("formal BLOCKED and selected-slice gates have only legal recovery transitions", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await editTask(fixture, (value) => {
    let checked = value.replace("- [ ] 1.1", "- [x] 1.1");
    checked = replaceSection(checked, "Changed Areas", "- `../../src/example.txt`");
    return replaceSection(checked, "Validation Attempts", BLOCKED_ATTEMPT);
  });
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "VALIDATION_BLOCKED");
  assertRecoveryTarget(await inspectExecutionState(fixture.requirements), {
    operation: "VALIDATE_SLICE", slice: "slice-01", owner: "validation-attempt", record: "attempt-01",
  });
  await assert.rejects(preflightExecutionOperation(fixture.requirements, "EXECUTE_SLICE", "1"), /not legal/u);
  assert.equal((await preflightExecutionOperation(fixture.requirements, "VALIDATE_SLICE", "1")).state, "VALIDATION_BLOCKED");
  assert.equal((await preflightExecutionOperation(fixture.requirements, "REPLAN")).state, "VALIDATION_BLOCKED");

});

test("non-canonical execution residue blocks preflight while arbitrary external SPEC siblings remain untouched", async (t) => {
  const root = await temporary(t);
  const workspace = await copyDirectory(path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"), path.join(root, "spec"));
  const fixture = { requirements: workspace, execution: path.join(workspace, "execution") };
  await renderArtifacts(fixture);
  const external = path.join(workspace, "user-owned.bin");
  await fs.writeFile(external, Buffer.from([1, 2, 3]));
  assert.equal((await inspectExecutionState(workspace)).state, "MATERIALIZED_PRISTINE");
  const residue = path.join(fixture.execution, "scratch.md");
  await fs.writeFile(residue, "preserve\n");
  await assert.rejects(inspectExecutionState(workspace), (error) => error instanceof ExecutionContractError && error.findings.includes(residue));
  await assert.rejects(preflightExecutionOperation(workspace, "EXECUTE_SLICE", "1"), (error) => error instanceof ExecutionContractError && error.findings.includes(residue));
  await assert.rejects(preflightExecutionOperation(workspace, "VALIDATE_SLICE", "1"), (error) => error instanceof ExecutionContractError && error.findings.includes(residue));
  assert.deepEqual(await fs.readFile(external), Buffer.from([1, 2, 3]));
  assert.equal(await fs.readFile(residue, "utf8"), "preserve\n");

  const escaped = await standaloneWorkspace(t);
  await renderArtifacts(escaped);
  await editTask(escaped, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../../outside.txt`");
    return replaceSection(result, "Implementation Test Evidence", checkRecord("implementation-check", 1, "TESTS_PASS", 1));
  });
  await assert.rejects(preflightExecutionOperation(escaped.requirements, "VALIDATE_SLICE", "1"), /unsafe validation-owned path/u);
});

test("Effective Validation Base ownership reproducer covers path basis, hash, drift, and strict readback", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const target = await writeValidatedPath(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveIndex = path.join(fixture.execution, "tasks.md");
  const liveBefore = await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]);

  const terminalCandidate = async (name, { baseRelative = "../../src/example.txt", hash = VALIDATED_HASH } = {}) => {
    const candidate = await copyDirectory(fixture.execution, path.join(fixture.root, name));
    const candidateTask = path.join(candidate, "tasks/slice-01.md");
    let task = await fs.readFile(candidateTask, "utf8");
    task = task.replace("- [ ] 1.1", "- [x] 1.1");
    task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
    task = replaceSection(task, "Validation Attempts", PASS_ATTEMPT);
    task = replaceSection(task, "Effective Validation Base", passBase({ relative: baseRelative, hash }));
    await fs.writeFile(candidateTask, publishPassResult(task), "utf8");
    await fs.writeFile(path.join(candidate, "tasks.md"), (await fs.readFile(path.join(candidate, "tasks.md"), "utf8")).replace(
      "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
      "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
    ), "utf8");
    return candidate;
  };

  const correct = await terminalCandidate("candidate-correct");
  assert.equal((await validateExecutionCandidate(fixture.requirements, correct)).state, "COMPLETE", "R1 correct candidate");
  assert.deepEqual(await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]), liveBefore, "candidate validation published implicitly");

  const wrongBasis = await terminalCandidate("candidate-wrong-basis", { baseRelative: "src/example.txt" });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, wrongBasis), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match|changed\/corrected path with no validation owner/u);
    return true;
  });
  assert.deepEqual(await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]), liveBefore, "wrong-basis candidate published implicitly");

  const wrongHash = await terminalCandidate("candidate-wrong-hash", { hash: "0".repeat(64) });
  await assert.rejects(validateExecutionCandidate(fixture.requirements, wrongHash), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match/u);
    assert.equal(error.findings.some((item) => item.includes("expected sha256:") && item.includes("current sha256:")), true);
    return true;
  });

  await fs.copyFile(path.join(correct, "tasks/slice-01.md"), liveTask);
  await fs.copyFile(path.join(correct, "tasks.md"), liveIndex);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "COMPLETE", "R5 strict readback without drift");

  await fs.writeFile(target, "post-PASS drift\n", "utf8");
  await assert.rejects(inspectExecutionState(fixture.requirements), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match/u);
    assert.equal(error.recoveryTargets.some(({ operation, owner }) => operation === "REPLAN" && owner === "terminal-integrity"), true);
    return true;
  });
});

test("candidate validation permits declared later-slice ownership of a historical overlap", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  await addSecondPristineSlice(fixture);
  await passFirstSlice(fixture);

  const currentContent = "later validated behavior\n";
  const currentHash = createHash("sha256").update(currentContent).digest("hex");
  await writeValidatedPath(fixture, "../../src/example.txt", currentContent);

  const candidate = await copyDirectory(fixture.execution, path.join(fixture.root, "historical-overlap-candidate"));
  const candidateTask = path.join(candidate, "tasks/slice-02.md");
  let task = await fs.readFile(candidateTask, "utf8");
  task = task.replace("- [ ] 2.1", "- [x] 2.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(
    task,
    "Prior Validation Overlap",
    "### overlap-01\n\n- Prior slice: slice-01\n- Paths: ../../src/example.txt\n- Affected behavior: Preserve the previously validated CLI behavior.\n- Regressions: Re-run the focused CLI regression against the changed test file.",
  );
  task = replaceSection(
    task,
    "Implementation Test Evidence",
    checkRecord("implementation-check", 1, "TESTS_PASS", 1).replaceAll(`sha256:${VALIDATED_HASH}`, `sha256:${currentHash}`),
  );
  await fs.writeFile(candidateTask, task, "utf8");

  const liveTask = await fs.readFile(path.join(fixture.execution, "tasks/slice-02.md"));
  assert.equal((await validateExecutionCandidate(fixture.requirements, candidate)).state, "IMPLEMENTED_AWAITING_VALIDATION");
  assert.deepEqual(await fs.readFile(path.join(fixture.execution, "tasks/slice-02.md")), liveTask);

  const invalidCurrent = await copyDirectory(candidate, path.join(fixture.root, "historical-overlap-invalid-current"));
  const invalidTaskPath = path.join(invalidCurrent, "tasks/slice-02.md");
  await fs.writeFile(
    invalidTaskPath,
    (await fs.readFile(invalidTaskPath, "utf8")).replaceAll(`sha256:${currentHash}`, `sha256:${"0".repeat(64)}`),
    "utf8",
  );
  await assert.rejects(validateExecutionCandidate(fixture.requirements, invalidCurrent), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /file-backed candidate evidence expected/u);
    assert.equal(error.findings.some((item) => item.includes("slice-02") || item.includes("tasks/slice-02.md")), true);
    return true;
  });
});

test("terminal inspection detects hash drift and REMOVED reappearance without rewriting PASS history", async (t) => {
  const matching = await standaloneWorkspace(t);
  await renderArtifacts(matching);
  await editTask(matching, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return publishPassResult(result);
  });
  await editTasksIndex(matching, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  const target = await writeValidatedPath(matching);
  const complete = await inspectExecutionState(matching.requirements);
  assert.equal(complete.state, "COMPLETE");
  assert.equal(complete.normalHandoff, null);
  assert.deepEqual(complete.legalOperations, [{ operation: "REPLAN", slice: null }]);
  const taskPath = path.join(matching.execution, "tasks/slice-01.md");
  const historyBeforeDrift = await fs.readFile(taskPath);
  await fs.writeFile(target, "drifted behavior\n");
  await assert.rejects(inspectExecutionState(matching.requirements), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match/u);
    assert.equal(error.findings.some((item) => item.includes(target)
      && item.includes("slice-01") && item.includes("expected sha256:") && item.includes("current sha256:")), true);
    assert.deepEqual(error.recoveryTargets.map(({ operation, slice, owner }) => ({ operation, slice, owner })), [
      { operation: "REPLAN", slice: null, owner: "terminal-integrity" },
    ]);
    return true;
  });
  assert.deepEqual(await fs.readFile(taskPath), historyBeforeDrift, "terminal drift inspection rewrote PASS history");
  assert.equal((await preflightExecutionOperation(matching.requirements, "REPLAN")).state, "COMPLETE");

  const removed = await standaloneWorkspace(t);
  await renderArtifacts(removed);
  await editTask(removed, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/removed.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", passBase({ relative: "../../src/removed.txt", removed: true }));
    return publishPassResult(result);
  });
  await editTasksIndex(removed, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  assert.equal((await inspectExecutionState(removed.requirements)).state, "COMPLETE");
  await writeValidatedPath(removed, "../../src/removed.txt");
  await assert.rejects(inspectExecutionState(removed.requirements), (error) => error instanceof ExecutionContractError
    && error.findings.some((item) => item.includes("slice-01") && item.includes("expected REMOVED, current sha256:"))
    && error.recoveryTargets.some((target_) => target_.operation === "REPLAN"));

  const unowned = await standaloneWorkspace(t);
  await renderArtifacts(unowned);
  await editTask(unowned, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", "- `../../src/example.txt`\n- `../../src/unowned.txt`");
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", PASS_BASE);
    return publishPassResult(result);
  });
  await assert.rejects(inspectExecutionState(unowned.requirements), /changed\/corrected path with no validation owner/u);
});

test("terminal candidates reject invalid final ownership and preserve live execution bytes", async (t) => {
  const fixture = await standaloneWorkspace(t);
  await renderArtifacts(fixture);
  const liveTask = path.join(fixture.execution, "tasks/slice-01.md");
  const liveIndex = path.join(fixture.execution, "tasks.md");
  const liveBefore = await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]);
  const candidate = await copyDirectory(fixture.execution, path.join(fixture.root, "terminal-candidate"));
  const candidateTask = path.join(candidate, "tasks/slice-01.md");
  let task = await fs.readFile(candidateTask, "utf8");
  task = task.replace("- [ ] 1.1", "- [x] 1.1");
  task = replaceSection(task, "Changed Areas", "- `../../src/example.txt`");
  task = replaceSection(task, "Validation Attempts", PASS_ATTEMPT);
  task = replaceSection(task, "Effective Validation Base", PASS_BASE);
  await fs.writeFile(candidateTask, publishPassResult(task), "utf8");
  const candidateIndex = path.join(candidate, "tasks.md");
  await fs.writeFile(candidateIndex, (await fs.readFile(candidateIndex, "utf8")).replace(
    "| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |",
    "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |",
  ), "utf8");
  await writeValidatedPath(fixture, "../../src/example.txt", "candidate hash mismatch\n");

  await assert.rejects(validateExecutionCandidate(fixture.requirements, candidate), (error) => {
    assert.ok(error instanceof ExecutionContractError);
    assert.match(error.message, /final validation ownership does not match/u);
    assert.equal(error.findings.some((item) => item.includes("slice-01")
      && item.includes("expected sha256:") && item.includes("current sha256:")), true);
    return true;
  });
  assert.deepEqual(await Promise.all([fs.readFile(liveTask), fs.readFile(liveIndex)]), liveBefore);
  assert.equal((await inspectExecutionState(fixture.requirements)).state, "MATERIALIZED_PRISTINE");
});

test("terminal integrity trusts repository-owned paths outside a nested SPEC and rejects repository escape", async (t) => {
  const root = await temporary(t);
  const repository = path.join(root, "repository with space ü");
  await fs.mkdir(path.join(repository, ".git"), { recursive: true });
  const workspace = await copyDirectory(
    path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready"),
    path.join(repository, "specs", "área segura", "feature Ω"),
  );
  const fixture = { root: repository, requirements: workspace, execution: path.join(workspace, "execution") };
  await renderArtifacts(fixture);
  const taskDirectory = path.join(fixture.execution, "tasks");
  const ownedPath = path.join(repository, "src/example.txt");
  const ownedRelative = path.relative(taskDirectory, ownedPath).split(path.sep).join("/");
  await fs.mkdir(path.dirname(ownedPath), { recursive: true });
  await fs.writeFile(ownedPath, VALIDATED_CONTENT);
  await editTask(fixture, (value) => {
    let result = value.replace("- [ ] 1.1", "- [x] 1.1");
    result = replaceSection(result, "Changed Areas", `- \`${ownedRelative}\``);
    result = replaceSection(result, "Validation Attempts", PASS_ATTEMPT);
    result = replaceSection(result, "Effective Validation Base", passBase({ relative: ownedRelative }));
    return publishPassResult(result);
  });
  await editTasksIndex(fixture, (value) => value.replace("| [ ] | 01 - Delivery | observable result | - | tasks/slice-01.md | pending | pending |", "| [x] | 01 - Delivery | observable result | - | tasks/slice-01.md | PASS | PASS |"));
  assert.equal((await inspectExecutionState(workspace)).state, "COMPLETE");
  const candidate = await copyDirectory(fixture.execution, path.join(root, "nested lifecycle candidate"));
  assert.equal((await validateExecutionCandidate(workspace, candidate)).state, "COMPLETE");
  const formerLocalPrefix = `.${path.basename(workspace)}.stnl-execution-candidate-`;
  assert.deepEqual(
    (await fs.readdir(path.dirname(workspace))).filter((name) => name.startsWith(formerLocalPrefix)),
    [],
    "candidate shadow appeared beside the nested lifecycle SPEC",
  );

  const escapedPath = path.join(root, "escaped.txt");
  const escapedRelative = path.relative(taskDirectory, escapedPath).split(path.sep).join("/");
  await fs.writeFile(escapedPath, VALIDATED_CONTENT);
  await editTask(fixture, (value) => {
    let result = replaceSection(value, "Changed Areas", `- \`${escapedRelative}\``);
    result = replaceSection(result, "Effective Validation Base", passBase({ relative: escapedRelative }));
    return result;
  });
  await assert.rejects(inspectExecutionState(workspace), /unsafe validation-owned path/u);
});
