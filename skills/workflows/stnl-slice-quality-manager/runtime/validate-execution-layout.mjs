#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { findNonCanonicalExecutionPaths, validateExecutionLayout } from "./execution-state.mjs";

export { findNonCanonicalExecutionPaths, validateExecutionLayout };

async function main(arguments_) {
  if (arguments_.length !== 1) {
    process.stderr.write("usage: validate-execution-layout.mjs SPEC_PATH\n");
    return 2;
  }
  try {
    await validateExecutionLayout(arguments_[0]);
    process.stdout.write("APPROVED: canonical execution layout\n");
    return 0;
  } catch (error) {
    if (Array.isArray(error.findings)) {
      for (const finding of error.findings) {
        process.stderr.write(
          `BLOCKED: non-canonical SPEC path '${finding}'; relocate it outside the SPEC or remove it explicitly\n`,
        );
      }
    } else {
      process.stderr.write(`BLOCKED: ${error.message}\n`);
    }
    return 1;
  }
}

const executed = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (executed) process.exitCode = await main(process.argv.slice(2));
