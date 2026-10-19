#!/usr/bin/env node
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const RUNNER_NAME='stnl_validation_runner';
function fail(message){throw new Error(message);}
function unavailable(){throw Object.assign(new Error('Current managed workflow execution is not available; use the reviewed EC-1 native operation controller'),{code:'CURRENT_MANAGED_UNAVAILABLE'});}
export async function describeSemanticResponseFile(file) {
  const bytes = await fs.readFile(file);
  let response;
  try { response = JSON.parse(bytes.toString('utf8')); }
  catch { throw Object.assign(new Error('captured semantic runner response is invalid JSON'), { code: 'RUNNER_RESPONSE_SCHEMA_INVALID' }); }
  if (response === null || typeof response !== 'object' || Array.isArray(response)
    || typeof response.status !== 'string') throw Object.assign(new Error('captured semantic runner response has no status'),
      { code: 'RUNNER_RESPONSE_SCHEMA_INVALID' });
  return {
    semanticResponseStatus: response.status,
    semanticResponseSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function readRunnerConfiguration(snapshot) {
  const file = path.join(snapshot, 'agents', 'codex', '.codex', 'agents', `${RUNNER_NAME}.toml`);
  const value = await fs.readFile(file, 'utf8');
  const block = /^developer_instructions = """\n([\s\S]*?)\n"""/mu.exec(value);
  const model = /^model = "([^"]+)"$/mu.exec(value)?.[1];
  const effort = /^model_reasoning_effort = "([^"]+)"$/mu.exec(value)?.[1];
  if (!block || /^name = "([^"]+)"$/mu.exec(value)?.[1] !== RUNNER_NAME
    || model !== 'gpt-6-luna' || effort !== 'medium'
    || /^sandbox_mode\s*=/mu.test(value)) fail('independent runner configuration is invalid');
  return { model, effort, developerInstructions: block[1] };
}

export const invokeIndependentRunner=unavailable;
export const submitRunnerPayload=unavailable;
export const main=unavailable;
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){try{main();}catch(error){process.stderr.write(error.code+': '+error.message+'\n');process.exitCode=1;}}
