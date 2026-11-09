import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
test('external SQL gate fails explicitly without enabling it; no silent skip or database process',async()=>{
 const result=await run(process.execPath,['scripts/verify-native-sqlserver.mjs'],{env:{PATH:process.env.PATH}}).then(()=>null,error=>error);
 assert.ok(result);assert.equal(result.code,1);
 assert.match(result.stderr,/STNL_NATIVE_SQLSERVER_BLOCKED_OR_FAILED/);
 assert.doesNotMatch(result.stdout,/STNL_NATIVE_SQLSERVER_RESULT|passed|PASS/);
});
test('SQL adapter contract is exercised offline with mocked subprocesses',async()=>{
 const result=await run('python3',['-B','scripts/fixtures/python-sqlserver-native/checks/offline_contract.py']);
 assert.match(result.stderr,/Ran 17 tests/);assert.match(result.stderr,/OK/);
});
test('external gate is explicit, source-bound and separate from ordinary offline test entry',async()=>{
 const packageJson=JSON.parse(await fs.readFile('package.json','utf8'));
 assert.equal(packageJson.scripts.test,'node scripts/run-tests.mjs');
 assert.equal(packageJson.scripts['verify:sqlserver-native'],'node scripts/verify-native-sqlserver.mjs');
 const catalog=JSON.parse(await fs.readFile('scripts/test-catalog.json','utf8'));
 assert.ok(catalog.files.includes('scripts/test-sqlserver-bridge-contract.mjs'));
 assert.ok(!catalog.files.includes('scripts/verify-native-sqlserver.mjs'));
 const source=await fs.readFile('scripts/verify-native-sqlserver.mjs','utf8');
 assert.match(source,/exact source must be committed and clean/);
 assert.match(source,/unchangedLedger/);assert.match(source,/syntheticProtocolJudgments:true/);
 assert.match(source,/emulatedCompatibilityOnly/);
 assert.doesNotMatch(source,/\.skip\(|docker.*(?:run|start)|spawn_agent|reconcile/i);
});
test('CLI refuses unsafe credential formats before creating evidence or touching Docker',async()=>{
 const base={PATH:process.env.PATH,STNL_SQLSERVER_NATIVE:'1',STNL_SQLSERVER_EULA_ACCEPTED:'yes',STNL_SQLSERVER_ROUTE:'local-docker-emulated',STNL_SQLSERVER_RUN_ID:'123',STNL_SQLSERVER_CONTAINER:'stnl-synthetic-offline',STNL_SQLSERVER_CONTAINER_ID:'a'.repeat(64),STNL_SQLSERVER_DOCKER_CONTEXT:'default'};
 for(const value of ['Stnl!'+ 'a'.repeat(47)+'&','Stnl!'+ 'a'.repeat(48)+'\n','Stnl!'+ 'a'.repeat(48)+'&amp;']) {
  const result=await run(process.execPath,['scripts/verify-native-sqlserver.mjs'],{env:{...base,SQLCMDPASSWORD:value}}).then(()=>null,error=>error);
  assert.equal(result?.code,1);assert.match(result.stderr,/safe generated format/);assert.ok(!result.stderr.includes(value));assert.equal(result.stdout,'');
 }
});
