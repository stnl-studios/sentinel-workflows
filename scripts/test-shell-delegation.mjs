import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const catalog=JSON.parse(await fs.readFile(path.join(root,'scripts/test-catalog.json'),'utf8'));
const bash=spawnSync('which',['bash'],{encoding:'utf8'}).stdout.trim();
const dirname=spawnSync('which',['dirname'],{encoding:'utf8'}).stdout.trim();
assert.ok(bash&&dirname,'bash and dirname are required by the public shell entrypoints');
for(const entry of catalog.delegations??[]) {
  test(`${entry.file}: root resolution, exact delegation, exit propagation and missing node`,async t=>{
    const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'stnl shell delegation '));
    t.after(()=>fs.rm(temporary,{recursive:true,force:true}));
    const bin=path.join(temporary,'bin');
    const checkout=path.join(temporary,'checkout with spaces');
    const script=path.join(checkout,entry.file);
    await fs.mkdir(bin);await fs.mkdir(path.dirname(script),{recursive:true});
    await fs.copyFile(path.join(root,entry.file),script);
    await fs.symlink(dirname,path.join(bin,'dirname'));
    const node=path.join(bin,'node');
    const env={...process.env,PATH:bin};
    for(const code of [0,23]) {
      // This substitute observes argv only; the real target runs once in npm test.
      await fs.writeFile(node,`#!/bin/sh\nprintf '%s\\n' "$@"\nexit ${code}\n`,{mode:0o755});
      const result=spawnSync(bash,[script],{cwd:temporary,env,encoding:'utf8'});
      assert.equal(result.status,code,result.stderr);
      assert.equal(result.stdout,`--test\n${path.join(checkout,entry.target)}\n`);
    }
    await fs.unlink(node);
    const missing=spawnSync(bash,[script],{cwd:temporary,env,encoding:'utf8'});
    assert.equal(missing.status,1);
    assert.match(missing.stderr,/FAIL: node is unavailable/u);
    assert.equal(missing.stdout,'');
  });
}
