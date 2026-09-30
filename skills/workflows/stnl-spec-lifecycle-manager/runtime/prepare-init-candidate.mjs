#!/usr/bin/env node
import { prepareInitCandidate } from './lib/init-candidate.mjs';
import { cliError, helpRequested, printHelp } from './lib/cli.mjs';

const usage = 'prepare-init-candidate.mjs TARGET CANDIDATE';
const args = process.argv.slice(2);
if (helpRequested(args)) printHelp(usage);
else if (args.length !== 2) cliError('expected INIT target and candidate workspace', usage);
else {
  try {
    const result = await prepareInitCandidate({ target: args[0], candidate: args[1] });
    const changed = result.changedFiles.length === 0 ? 'none' : result.changedFiles.join(', ');
    process.stdout.write(`PASS: INIT candidate owner serialization completed at ${result.candidate}; changed files: ${changed}\n`);
  } catch (error) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = 1;
  }
}
