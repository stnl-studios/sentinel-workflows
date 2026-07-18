#!/usr/bin/env node
import { buildClosedCandidate } from './lib/closed-spec.mjs';
import { cliError, helpRequested, parseOptions, printHelp } from './lib/cli.mjs';

const usage = 'build-closed-spec.mjs source candidate --readiness-attestation READINESS_ATTESTATION';
const tokens = process.argv.slice(2);
const parsed = parseOptions(tokens, {
  '--readiness-attestation': { required: true },
});
if (helpRequested(tokens)) printHelp(usage);
else if (parsed.error) cliError(parsed.error, usage);
else if (parsed.positional.length !== 2) cliError('expected source and candidate', usage);
else {
  try {
    const built = buildClosedCandidate(parsed.positional[0], parsed.positional[1], {
      readinessAttestation: parsed.options['--readiness-attestation'],
    });
    process.stdout.write(`PASS: deterministic CLOSE candidate built at ${built}\n`);
  } catch (error) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = 1;
  }
}
