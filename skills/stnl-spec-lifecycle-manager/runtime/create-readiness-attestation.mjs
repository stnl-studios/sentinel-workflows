#!/usr/bin/env node
import { createReadinessAttestation } from './lib/readiness.mjs';
import { cliError, helpRequested, parseOptions, printHelp } from './lib/cli.mjs';

const usage = 'create-readiness-attestation.mjs source attestation --scope SCOPE --verdict VERDICT';
const tokens = process.argv.slice(2);
const parsed = parseOptions(tokens, {
  '--scope': { required: true },
  '--verdict': { required: true },
});
if (helpRequested(tokens)) printHelp(usage);
else if (parsed.error) cliError(parsed.error, usage);
else if (parsed.positional.length !== 2) cliError('expected source and attestation', usage);
else {
  try {
    const output = createReadinessAttestation(parsed.positional[0], parsed.positional[1], {
      scope: parsed.options['--scope'],
      verdict: parsed.options['--verdict'],
    });
    process.stdout.write(`PASS: readiness attestation created at ${output}\n`);
  } catch (error) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = 1;
  }
}
