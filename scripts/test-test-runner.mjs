import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'stnl-test-runner-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const sub of ['scripts/lib','skills/workflows','benchmarks/sentinel-todo/seed/test'])await fs.mkdir(path.join(dir,sub),{recursive:true});
  for(const file of ['scripts/run-tests.mjs','scripts/lib/test-catalog.mjs'])await fs.copyFile(path.join(root,file),path.join(dir,file));
  await fs.writeFile(path.join(dir,'scripts/test-a.mjs'),'process.exitCode=Number(process.env.FIRST_EXIT??0);\n');
  await fs.writeFile(path.join(dir,'scripts/test-b.mjs'),'console.log("second file ran");\n');
  await fs.writeFile(path.join(dir,'scripts/validate.sh'),'test "$1" = --structure-only || exit 9\nexit "${STRUCTURE_EXIT:-0}"\n');
  await fs.writeFile(path.join(dir,'scripts/test-catalog.json'),JSON.stringify({format:'sentinel-test-catalog-v1',files:['scripts/test-a.mjs','scripts/test-b.mjs'],excluded:[]}));
  return dir;
}
for(const [name,env,expected] of [['green',{},0],['failed first file',{FIRST_EXIT:'7'},1],['failed structure',{STRUCTURE_EXIT:'6'},1]]) {
  test(`runner records every duration/status and structural result: ${name}`,async t=>{
    const dir=await fixture(t),report=path.join(dir,'report.json');
    const child=spawnSync(process.execPath,['scripts/run-tests.mjs'],{cwd:dir,env:{...process.env,FIRST_EXIT:'0',STRUCTURE_EXIT:'0',...env,SENTINEL_TEST_REPORT:report},encoding:'utf8'});
    assert.equal(child.status,expected,child.stderr);
    assert.match(child.stdout,/second file ran/u);
    const result=JSON.parse(await fs.readFile(report,'utf8'));
    assert.equal(result.status,expected?'failed':'passed');
    assert.equal(result.results.length,3);
    assert.ok(Number.isFinite(result.durationSeconds)&&result.durationSeconds>0);
    for(const entry of result.results) {
      assert.ok(Number.isFinite(entry.durationSeconds)&&entry.durationSeconds>=0);
      assert.equal(entry.status,entry.exitCode?'failed':'passed');
    }
    assert.equal(result.results[0].exitCode,Number(env.FIRST_EXIT??0));
    assert.equal(result.results[2].exitCode,Number(env.STRUCTURE_EXIT??0));
    assert.equal(child.stdout.split('[test-result] ').length-1,3);
  });
}
test('runner fails closed before executing uncatalogued tests',async t=>{
  const dir=await fixture(t);
  await fs.writeFile(path.join(dir,'scripts/test-new.mjs'),'throw new Error("must not execute");');
  const child=spawnSync(process.execPath,['scripts/run-tests.mjs'],{cwd:dir,encoding:'utf8'});
  assert.equal(child.status,1);assert.match(child.stderr,/Uncatalogued test files/u);
  assert.doesNotMatch(child.stdout,/second file ran|\[test-result\]/u);
});
for(const firstExit of [0,7])test(`delegation status requires both target and contract success (target exit ${firstExit})`,async t=>{
  const dir=await fixture(t),report=path.join(dir,'report.json');
  await fs.writeFile(path.join(dir,'scripts/test-a.sh'),'exit 99\n');
  await fs.writeFile(path.join(dir,'scripts/test-shell-delegation.mjs'),'console.log("delegation contract ran");\n');
  const catalogFile=path.join(dir,'scripts/test-catalog.json');
  const catalog=JSON.parse(await fs.readFile(catalogFile,'utf8'));
  catalog.files.push('scripts/test-shell-delegation.mjs');
  catalog.delegations=[{file:'scripts/test-a.sh',target:'scripts/test-a.mjs',coveredBy:'scripts/test-shell-delegation.mjs',reason:'mock delegation for runner accounting'}];
  await fs.writeFile(catalogFile,JSON.stringify(catalog));
  const child=spawnSync(process.execPath,['scripts/run-tests.mjs'],{cwd:dir,env:{...process.env,FIRST_EXIT:String(firstExit),STRUCTURE_EXIT:'0',SENTINEL_TEST_REPORT:report},encoding:'utf8'});
  assert.equal(child.status,firstExit?1:0,child.stderr);
  const result=JSON.parse(await fs.readFile(report,'utf8'));
  const entry=result.results.find(item=>item.file==='scripts/test-a.sh');
  assert.equal(entry.status,firstExit?'failed-delegation':'passed-delegation');
  assert.equal(entry.durationSeconds,0);
  assert.equal(entry.coveredBy,'scripts/test-shell-delegation.mjs');
});
