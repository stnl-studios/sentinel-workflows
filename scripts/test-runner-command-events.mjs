import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveRunnerCommandEvents } from "../skills/workflows/stnl-slice-executor/runtime/runner-command-events.mjs";

test("isolated executor and quality-manager use identical event resolvers", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const relative = "runtime/runner-command-events.mjs";
  const [executor, manager] = await Promise.all([
    fs.readFile(path.join(root, "skills/workflows/stnl-slice-executor", relative)),
    fs.readFile(path.join(root, "skills/workflows/stnl-slice-quality-manager", relative)),
  ]);
  assert.deepEqual(executor, manager);
});

test("Codex and Claude validation-runner contracts require isolated marked verification", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const contracts = await Promise.all([
    fs.readFile(path.join(root, "agents/codex/.codex/agents/stnl_validation_runner.toml"), "utf8"),
    fs.readFile(path.join(root, "agents/claude-code/.claude/agents/stnl-validation-runner.md"), "utf8"),
  ]);
  const requiredInstructions = [
    "Cada verification command deve ocupar sua própria `command_execution`",
    "shell invocation isolada",
    "`item.command` deve começar literalmente com `STNL_VERIFICATION_COMMAND=1`",
    "Execute discovery e inspection primeiro, em chamadas separadas",
    "nunca misture discovery ou inspection com verification na mesma invocation",
    "nunca anexe comandos antes do marker",
    "depois do marker, execute somente o verification command pertinente",
    "`STNL_VERIFICATION_COMMAND=1 npm test`",
    "`git diff ...; STNL_VERIFICATION_COMMAND=1 npm test`",
    "`git diff ... && STNL_VERIFICATION_COMMAND=1 npm test`",
  ];
  for (const contract of contracts) {
    for (const instruction of requiredInstructions) assert.ok(contract.includes(instruction), `missing contract instruction: ${instruction}`);
  }
});

async function fixture(t, commands, operation = "EXECUTE_SLICE") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stnl-command-events-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const name = `001-${operation.toLowerCase()}-slice-01-attempt-1`;
  const semanticResponseFile = path.join(root, `${name}.response.json`);
  const eventsPath = path.join(root, `${name}.events.jsonl`);
  const receiptFile = path.join(root, `${name}.receipt.json`);
  const response = JSON.stringify({ status: "PASS", commands: [{ command: "<invented>", exit: 99 }] });
  await fs.writeFile(semanticResponseFile, response);
  const events = commands.flatMap(({ command, exit }, index) => [
    { operationId: `runner-${name}`, type: "item.started", item: { id: `item_${index}`, type: "command_execution", command, status: "in_progress", exit_code: null } },
    { operationId: `runner-${name}`, type: "item.completed", item: { id: `item_${index}`, type: "command_execution", command, status: exit === 0 ? "completed" : "failed", exit_code: exit } },
  ]);
  await fs.writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  await fs.writeFile(receiptFile, JSON.stringify({
    status: "RUNNER_RESPONSE_CAPTURED", operation, eventsPath, semanticResponseFile,
    semanticResponseSha256: createHash("sha256").update(response).digest("hex"),
    captureFailure: null, error: null, exitCode: 0,
  }));
  return { root, receiptFile, semanticResponseFile, eventsPath };
}

for (const operation of ["EXECUTE_SLICE", "APPLY_FINDINGS", "VALIDATE_SLICE"]) {
  test(`${operation}: completed marked SDK events own exact command and exit`, async (t) => {
    const examples = [
      "STNL_VERIFICATION_COMMAND=1 npm test",
      `/bin/zsh -lc 'STNL_VERIFICATION_COMMAND=1 node -e "console.log(\\\"quoted\\\")"'`,
      "STNL_VERIFICATION_COMMAND=1 cat <<'EOF'\nline with `backticks` && | >\nEOF",
      `STNL_VERIFICATION_COMMAND=1 node -e '${"x".repeat(4096)}'`,
    ];
    const commands = [
      { command: "/bin/zsh -lc 'rg --files'", exit: 0 },
      ...examples.map((command, index) => ({ command, exit: index === 2 ? 7 : 0 })),
    ];
    const files = await fixture(t, commands, operation);
    const recovered = await resolveRunnerCommandEvents({ ...files, operation });
    assert.deepEqual(recovered, commands.slice(1));
    assert.ok(!recovered.some(({ command }) => command.includes("<invented>")));
    assert.deepEqual(JSON.parse(JSON.stringify(recovered)), commands.slice(1));
  });
}

test("explicit replay references select only named completed events, in start order", async (t) => {
  const commands = [
    { command: "/bin/zsh -lc 'rg --files'", exit: 0 },
    { command: "/bin/zsh -lc 'npm test'", exit: 0 },
    { command: "/bin/zsh -lc 'node --test'", exit: 0 },
  ];
  const files = await fixture(t, commands, "VALIDATE_SLICE");
  const options = { ...files, operation: "VALIDATE_SLICE" };
  assert.deepEqual(await resolveRunnerCommandEvents({ ...options, eventIds: ["item_1", "item_2"] }), commands.slice(1));
  await assert.rejects(resolveRunnerCommandEvents({ ...options, eventIds: ["item_2", "item_1"] }), /out of start order/u);
  await assert.rejects(resolveRunnerCommandEvents({ ...options, eventIds: ["item_9"] }), /did not complete/u);
  assert.deepEqual(await resolveRunnerCommandEvents(options), []);
});

test("VALIDATE_SLICE recognizes only standalone commands beginning with the marker", async (t) => {
  const commands = [
    { command: "STNL_VERIFICATION_COMMAND=1 npm test", exit: 0 },
    { command: "npm test", exit: 0 },
    { command: "git diff; STNL_VERIFICATION_COMMAND=1 npm test", exit: 0 },
    { command: "git diff && STNL_VERIFICATION_COMMAND=1 npm test", exit: 0 },
  ];
  const files = await fixture(t, commands, "VALIDATE_SLICE");
  assert.deepEqual(
    await resolveRunnerCommandEvents({ ...files, operation: "VALIDATE_SLICE" }),
    [commands[0]],
  );
});

test("receipt and completion cannot silently diverge", async (t) => {
  const files = await fixture(t, [{ command: "STNL_VERIFICATION_COMMAND=1 npm test", exit: 0 }]);
  await fs.writeFile(files.semanticResponseFile, '{"status":"PASS","commands":[]}');
  await assert.rejects(resolveRunnerCommandEvents({ ...files, operation: "EXECUTE_SLICE" }), /receipt does not bind/u);
});
