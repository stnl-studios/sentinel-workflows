import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {convertedImage} from './current-operational-consumption.mjs';
import {begin,reserveDispatch} from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-operation.mjs';

const run=promisify(execFile);
async function git(root,args) {return run('git',['-C',root,...args],{timeout:30000});}

// The legacy preparation and conversion remain the existing offline fixture.
// These cases exercise only the new admission/capture mechanics; they do not
// impersonate a native agent or count as the live smoke's judgment.
export async function nativeOperationCase(test) {
  const image=await convertedImage(test,{kind:'managed-s2'});
  const root=image.f.root;
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  await fs.writeFile(path.join(root,'src/greeting.mjs'),'export const greeting="hello";\n');
  await fs.writeFile(path.join(root,'src/greeting.test.mjs'),
    'import test from "node:test";import assert from "node:assert/strict";import {greeting} from "./greeting.mjs";test("AC-001",()=>assert.equal(greeting,"hello"));\n');
  await git(root,['init','-q']);
  await git(root,['add','.gitignore','requirements.md','src']);
  await git(root,['-c','user.name=EC1 Fixture','-c','user.email=ec1-fixture@example.invalid',
    'commit','-qm','mechanical case']);
  const head=(await git(root,['rev-parse','HEAD'])).stdout.trim();
  const continuity=JSON.parse(await fs.readFile(path.join(image.f.execution,'continuity.json'),'utf8'));
  const delivery=continuity.deliveries.find(item=>item.counters.validationAttempts>0);
  if(!delivery) throw new Error('mechanical S2 fixture lacks selected delivery');
  return {image,root,head,delivery,specPath:image.f.specPath,
    activationId:image.activation.activationId};
}

export async function reservedOperation(test) {
  const fixture=await nativeOperationCase(test);
  const start=await begin({specPath:fixture.specPath,slice:fixture.delivery.slice,
    expectedActivationId:fixture.activationId});
  const dispatch=await reserveDispatch(start.handle);
  return {...fixture,start,dispatch};
}
