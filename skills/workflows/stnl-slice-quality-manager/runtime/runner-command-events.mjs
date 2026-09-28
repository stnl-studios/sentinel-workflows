import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const VERIFICATION_PREFIX = /^(?:\/bin\/(?:zsh|bash|sh) -lc ['"])?STNL_VERIFICATION_COMMAND=1 [\s\S]+/u;

function fail(message) { throw new Error(`runner command evidence: ${message}`); }

// The runner chooses checks by marking their execution. The SDK, not the
// semantic response, supplies the literal command and observed exit.
export async function resolveRunnerCommandEvents({ receiptFile, semanticResponseFile, operation, eventIds = null }) {
  if (typeof receiptFile !== "string" || !path.isAbsolute(receiptFile)) fail("receipt path must be absolute");
  const receipt = JSON.parse(await fs.readFile(receiptFile, "utf8"));
  const responseBytes = await fs.readFile(semanticResponseFile);
  const responseHash = createHash("sha256").update(responseBytes).digest("hex");
  if (receipt.status !== "RUNNER_RESPONSE_CAPTURED" || receipt.operation !== operation
    || receipt.semanticResponseFile !== await fs.realpath(semanticResponseFile)
    || receipt.semanticResponseSha256 !== responseHash || receipt.captureFailure !== null
    || receipt.error !== null || receipt.exitCode !== 0 || typeof receipt.eventsPath !== "string"
    || !path.isAbsolute(receipt.eventsPath)) fail("receipt does not bind this captured response and operation");
  const eventsPath = await fs.realpath(receipt.eventsPath);
  if (path.dirname(eventsPath) !== path.dirname(await fs.realpath(receiptFile))) fail("events and receipt must share an operation directory");
  const starts = new Map();
  const completed = new Map();
  let eventOperationId = null;
  for (const [index, line] of (await fs.readFile(eventsPath, "utf8")).split("\n").entries()) {
    if (line === "") continue;
    let event;
    try { event = JSON.parse(line); } catch { fail(`invalid JSONL line ${index + 1}`); }
    if (typeof event.operationId !== "string" || !event.operationId.startsWith("runner-")) fail("invalid SDK operation identity");
    if (eventOperationId === null) eventOperationId = event.operationId;
    if (event.operationId !== eventOperationId) fail("mixed SDK operation identities");
    const item = event.item;
    if (item?.type !== "command_execution") continue;
    if (typeof item.id !== "string" || !/^item_[0-9]+$/u.test(item.id)) fail("invalid command event identity");
    if (event.type === "item.started") {
      if (starts.has(item.id) || typeof item.command !== "string" || item.command.length === 0) fail("duplicate or invalid command start");
      starts.set(item.id, { command: item.command, ordinal: starts.size });
    } else if (event.type === "item.completed") {
      if (completed.has(item.id) || !starts.has(item.id) || item.command !== starts.get(item.id).command
        || !new Set(["completed", "failed"]).has(item.status)
        || !Number.isSafeInteger(item.exit_code)) fail("incomplete or inconsistent command completion");
      completed.set(item.id, { id: item.id, command: item.command, exit: item.exit_code, ordinal: starts.get(item.id).ordinal });
    }
  }
  if (eventOperationId === null || !eventOperationId.endsWith(path.basename(eventsPath, ".events.jsonl"))) {
    fail("events file does not match its SDK operation identity");
  }
  let selected;
  if (eventIds === null) {
    selected = [...starts].filter(([, item]) => VERIFICATION_PREFIX.test(item.command)).map(([id]) => id);
  } else {
    if (!Array.isArray(eventIds) || eventIds.length === 0 || new Set(eventIds).size !== eventIds.length) fail("event references must be unique and nonempty");
    selected = eventIds;
  }
  const commands = selected.map((id) => {
    const event = completed.get(id);
    if (event === undefined) fail(`selected verification event ${id} did not complete`);
    return event;
  });
  if (commands.some((event, index) => index > 0 && event.ordinal <= commands[index - 1].ordinal)) fail("verification events are out of start order");
  return commands.map(({ command, exit }) => ({ command, exit }));
}
