#!/usr/bin/env node
import { readinessSnapshot } from './lib/readiness-result.mjs';

if (process.argv.length !== 3 || new Set(['-h', '--help']).has(process.argv[2])) {
  process.stdout.write('usage: readiness-snapshot.mjs SPEC_PATH\n');
  process.exitCode = process.argv.length === 3 ? 0 : 2;
} else {
  try { process.stdout.write(`${JSON.stringify(readinessSnapshot(process.argv[2]))}\n`); }
  catch (error) { process.stderr.write(`FAIL: ${error.message}\n`); process.exitCode = 1; }
}
