#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  canonicalPathWithoutSymlinks,
  resumeWorkspaceIdentity,
  validateWorkspace,
} from './lib/lifecycle.mjs';
import { expandUser, isWithin } from './lib/core.mjs';
import { cliError, helpRequested, printHelp } from './lib/cli.mjs';

const usage = 'create-resume-manifest.mjs SPEC_PATH';
const tokens = process.argv.slice(2);
if (helpRequested(tokens)) printHelp(usage);
else if (tokens.length !== 1) cliError('expected SPEC_PATH', usage);
else {
  try {
    const requested = expandUser(tokens[0]);
    const source = path.basename(requested) === 'feature_spec.md' ? path.dirname(requested) : requested;
    const workspace = validateWorkspace(source);
    if (workspace.closed) throw new Error('RESUME requires an active SPEC');

    const directory = canonicalPathWithoutSymlinks(os.tmpdir(), 'manifest temporary directory');
    if (isWithin(directory, workspace.root)) {
      throw new Error('system temporary directory must be outside the SPEC workspace');
    }
    const output = path.join(directory, `stnl-resume-manifest-${randomUUID()}.json`);

    const payload = {
      schema_version: 1,
      mode: 'RESUME',
      workspace_identity: {
        h1: workspace.h1,
        pre_state_sha256: resumeWorkspaceIdentity(workspace.root),
      },
      allowed_feature_sections: [],
      allowed_existing_ids: [],
      allowed_new_ids: [],
      allowed_status_transitions: [],
      allowed_record_status_transitions: [],
    };
    const descriptor = fs.openSync(output, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    process.stdout.write(`PASS: RESUME manifest template created at ${output}\n`);
  } catch (error) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    process.exitCode = 1;
  }
}
