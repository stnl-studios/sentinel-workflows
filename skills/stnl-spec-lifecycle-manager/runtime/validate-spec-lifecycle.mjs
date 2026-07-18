#!/usr/bin/env node
import {
  ValidationError,
  validateCloseTransition,
  validateInitTransition,
  validateReadinessTransition,
  validateResumeTransition,
  validateWorkspace,
} from './lib/lifecycle.mjs';
import { cliError, helpRequested, parseOptions, printHelp } from './lib/cli.mjs';

const usage = 'validate-spec-lifecycle.mjs {workspace,init-transition,resume-transition,readiness-transition,close-transition} ...';
const tokens = process.argv.slice(2);
const wantsHelp = helpRequested(tokens);
const command = tokens.shift();
const commands = new Set(['workspace', 'init-transition', 'resume-transition', 'readiness-transition', 'close-transition']);
if (wantsHelp) printHelp(usage);
else if (!command) cliError('the following arguments are required: command', usage);
else if (!commands.has(command)) cliError(`argument command: invalid choice: '${command}'`, usage);
else {
  let parsed;
  let expected;
  if (command === 'resume-transition') { parsed = parseOptions(tokens, { '--manifest': { required: true } }); expected = 2; }
  else if (command === 'readiness-transition') { parsed = parseOptions(tokens, { '--scope': { required: true, choices: ['LOCAL', 'GLOBAL'] } }); expected = 2; }
  else { parsed = parseOptions(tokens, {}); expected = command === 'workspace' ? 1 : 2; }
  if (parsed.error) cliError(parsed.error, usage);
  else if (parsed.positional.length !== expected) cliError(`expected ${expected} positional argument${expected === 1 ? '' : 's'}`, usage);
  else {
    try {
      if (command === 'workspace') {
        const workspace = validateWorkspace(parsed.positional[0]);
        process.stdout.write(`PASS: ${workspace.root} status=${workspace.status} ids=${workspace.items.size}\n`);
      } else if (command === 'init-transition') {
        const workspace = validateInitTransition(...parsed.positional);
        process.stdout.write(`PASS: INIT published ${workspace.root} status=${workspace.status} ids=${workspace.items.size}\n`);
      } else if (command === 'resume-transition') {
        const [before, after] = validateResumeTransition(...parsed.positional, parsed.options['--manifest']);
        process.stdout.write(`PASS: RESUME ${before.root} -> ${after.root} preserved IDs and external paths\n`);
      } else if (command === 'readiness-transition') {
        const [before, after] = validateReadinessTransition(...parsed.positional, parsed.options['--scope']);
        process.stdout.write(`PASS: READINESS ${parsed.options['--scope']} ${before.root} -> ${after.root} was read-only\n`);
      } else {
        const [before, after] = validateCloseTransition(...parsed.positional);
        process.stdout.write(`PASS: CLOSE ${before.root} -> ${after.root} preserved exact authority and external directories\n`);
      }
    } catch (error) {
      if (error instanceof ValidationError || error instanceof Error) {
        process.stderr.write(`FAIL: ${error.message}\n`);
        process.exitCode = 1;
      } else throw error;
    }
  }
}
