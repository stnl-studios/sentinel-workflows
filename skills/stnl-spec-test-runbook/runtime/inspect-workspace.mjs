#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectWorkspace, parseStrictJson } from "./lib/core.mjs";

export async function main(arguments_) {
  if (arguments_.length < 3 || arguments_.length > 4) {
    process.stderr.write("usage: inspect-workspace.mjs SPEC_PATH RUNBOOK_SCOPE RUNBOOK_SELECTION_JSON [RUNBOOK_OPTIONS_JSON]\n");
    return 2;
  }
  try {
    const result = await inspectWorkspace(
      arguments_[0],
      arguments_[1],
      parseStrictJson(arguments_[2], "RUNBOOK_SELECTION"),
      arguments_[3] === undefined ? {} : parseStrictJson(arguments_[3], "RUNBOOK_OPTIONS"),
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`BLOCKED: ${error.message}\n`);
    return 1;
  }
}

const executed = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
