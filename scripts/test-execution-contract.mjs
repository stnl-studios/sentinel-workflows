import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {computeRequirementsAuthority,inspectExecutionState} from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {parseSemanticExecutionPayload,assertRunnerVerdictConsistency} from '../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs';
import {captureRunnerResponse} from '../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
const ROOT=path.resolve(import.meta.dirname,'..');
async function temporary(t,prefix='stnl-contract-'){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),prefix)));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test("success verdicts reconcile every mechanical exit without suppressing legitimate failures", () => {
  for (const operation of ["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]) {
    const success = operation === "VALIDATE_SLICE" ? "PASS" : "TESTS_PASS";
    assert.doesNotThrow(() => assertRunnerVerdictConsistency(operation, success, [{ exit: 0 }]));
    for (const exits of [[1, 0, 0, 0], [1, 0], [1, 0, 1]]) {
      assert.throws(() => assertRunnerVerdictConsistency(operation, success, exits.map((exit) => ({ command: "check", exit }))),
        (error) => error.code === "RUNNER_VERDICT_EVIDENCE_CONFLICT" && error.failedCommands.length === exits.filter(Boolean).length);
    }
    const failure = operation === "VALIDATE_SLICE" ? "NEEDS_FIX" : "TESTS_FAIL";
    assert.doesNotThrow(() => assertRunnerVerdictConsistency(operation, failure, [{ exit: 1 }]));
    assert.doesNotThrow(() => assertRunnerVerdictConsistency(operation, "BLOCKED", [{ exit: 1 }]));
  }
});


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
    const optional = branch.title === "VALIDATE_SLICE" ? [] : ["filelessReason", "automaticCheckRound"];
    assert.deepEqual(Object.keys(branch.properties).sort(), [...branch.required, ...optional].sort());
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
    if (operation === "APPLY_FINDINGS") {
      for (const roundTwoOnlyField of ["priorRoundFailure", "correctionApplied", "inSliceRationale"]) {
        assert.equal(Object.hasOwn(schema.properties, roundTwoOnlyField), false);
        assert.equal(Object.hasOwn(branch.properties, roundTwoOnlyField), false);
        assert.equal(branch.required.includes(roundTwoOnlyField), false);
      }
    }
    const commandSchema = schema.properties.commands;
    assert.equal(commandSchema.type, "array");
    assert.equal(commandSchema.items.additionalProperties, false);
    assert.deepEqual(Object.keys(commandSchema.items.properties).sort(), ["command", "exit"]);
    assert.deepEqual([...commandSchema.items.required].sort(), ["command", "exit"]);
  }
});


test("planning coverage has one reference for full AC delivery and bounded requirement contributions", async () => {
  const planner = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/SKILL.md"), "utf8");
  const reviewer = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-plan-reviewer/SKILL.md"), "utf8");
  const global = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/plan.template.md"), "utf8");
  const detail = await fs.readFile(path.join(ROOT, "skills/workflows/stnl-execution-planner/templates/slice-plan.template.md"), "utf8");
  assert.match(planner, /Every condition has an integral owner and proof capable of observing it/);
  assert.match(planner, /Never invent a requirement ID or claim full acceptance for partial work/);
  assert.match(reviewer, /exact requirement ID and observable condition, complete\/partial contributions and integral owners/);
  assert.match(reviewer, /structurally valid test that observes a different property is insufficient/);
  assert.match(global, /Requirements \| Authorized areas \| Detailed plan/);
  assert.match(global, /only joint independent REVIEW_PLAN activates execution/);
  assert.match(detail, /Assigning an AC to this slice commits it to the complete criterion/u);
  assert.match(detail, /existing requirement ID[\s\S]{0,160}bounded partial result/u);
  assert.match(detail, /every AC must have a complete delivery/u);
  assert.match(detail, /preparation[\s\S]{0,160}authorized implementation and test paths/u);
  assert.match(detail, /partial contribution still requires checks for its own observable result/u);
  assert.match(detail, /Do not invent requirement IDs/u);
  assert.doesNotMatch(reviewer, /For each slice requiring executable evidence/u, "replace the former separate coverage rule rather than stacking it");
});


test("SPEC_PATH rejects directory and file traversal through symlink ancestors", async (t) => {
  const root = await temporary(t);
  const real = path.join(root, "real-project");
  const fixture = { root: real, requirements: path.join(real, "requirements.md"), execution: path.join(real, "requirements-execution") };
  await fs.mkdir(real, { recursive: true });
  await fs.mkdir(path.join(real, ".git"));
  await fs.writeFile(fixture.requirements, "# Requirements\n\n- AC-001: observable behavior\n", "utf8");
  const alias = path.join(root, "alias-project");
  await fs.symlink(real, alias, "dir");
  await assert.rejects(inspectExecutionState(alias), /symlink component/u);
  await assert.rejects(inspectExecutionState(path.join(alias, "requirements.md")), /symlink component/u);
});



test("lifecycle shared-only changes stale planning and deterministic lifecycle CLOSE preserves the fingerprint", async (t) => {
  const readySource = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/ready");
  const closedSource = path.join(ROOT, "skills/workflows/stnl-spec-lifecycle-manager/examples/validator-fixtures/closed");
  const root = await temporary(t);
  const ready = path.join(root,"ready");
  const closed = path.join(root,"closed");
  await fs.cp(readySource,ready,{recursive:true});await fs.cp(closedSource,closed,{recursive:true});
  const activeHash = await computeRequirementsAuthority(ready);
  assert.equal(await computeRequirementsAuthority(closed), activeHash, "lossless lifecycle CLOSE changed semantic authority");
  const requirement = path.join(ready, "shared/requirements.md");
  await fs.writeFile(requirement, (await fs.readFile(requirement, "utf8")).replace("Expired invitation is rejected", "Expired invitation is rejected with audit"));
  assert.notEqual(await computeRequirementsAuthority(ready), activeHash, "shared-only authority mutation was ignored");
});



test('APPLY judgment rejects malformed fields and unsupported diagnostics',async()=>{
 const schema=JSON.parse(await fs.readFile(path.join(ROOT,'skills/workflows/stnl-slice-executor/runtime/runner-apply-findings-response.schema.json')));
 const response=Object.fromEntries(schema.required.map(key=>[key,'checked']));Object.assign(response,{status:'TESTS_PASS',automaticCheckRound:'1/3',commands:[{command:'node --test',exit:0}]});
 assert.doesNotThrow(()=>parseSemanticExecutionPayload(JSON.stringify(response),'APPLY_FINDINGS'));
 assert.throws(()=>parseSemanticExecutionPayload('{broken JSON','APPLY_FINDINGS'));
 const missing={...response};delete missing.findingsVerified;
 for(const malformed of [missing,{...response,findingsVerified:[]},{...response,commands:[{command:'node --test',exit:'0'}]},{...response,unknown:1},{...response,findingsCycle:'attempt-01'}])assert.throws(()=>parseSemanticExecutionPayload(JSON.stringify(malformed),'APPLY_FINDINGS'));
});
