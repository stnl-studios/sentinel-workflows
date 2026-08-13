#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { ExecutionContractError, preflightExecutionOperation } from "./execution-state.mjs";

export async function main(arguments_) {
  if (arguments_.length < 2 || arguments_.length > 3) {
    process.stderr.write("usage: validate-execution-state.mjs SPEC_PATH OPERATION [SLICE]\n");
    return 2;
  }
  try {
    const result = await preflightExecutionOperation(arguments_[0], arguments_[1], arguments_[2] ?? null);
    process.stdout.write(`PASS: ${result.operation} preflight state=${result.state}${result.slice === null ? "" : ` slice=${result.slice}`} authority=sha256:${result.currentFingerprint}\n`);
    return 0;
  } catch (error) {
    if (error instanceof ExecutionContractError) {
      if (error.findings.length !== 0) for (const finding of error.findings) process.stderr.write(`BLOCKED: ${finding}\n`);
      else process.stderr.write(`BLOCKED: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

// macOS temporary paths may be presented through the /var -> /private/var alias,
// so lexical absolute-path equality is not a reliable entrypoint check.
const executed = process.argv[1] !== undefined
  && path.basename(process.argv[1]) === path.basename(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
