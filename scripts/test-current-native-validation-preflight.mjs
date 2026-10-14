import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {convertedImage} from './fixtures/current-operational-consumption.mjs';
import {concludeSecond,probe} from './fixtures/current-native-validation-preflight.mjs';
import {captureCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const modules=['stnl-slice-executor','stnl-slice-quality-manager'].map(name=>
  path.join(repo,'skills/workflows',name,'runtime/current-native-validation-capture.mjs'));
const deliveryIds=image=>JSON.parse(image.candidate.files.get('continuity.json')).deliveries.map(item=>item.deliveryId);
async function privateParent(image,label) {
  const parent=path.join(image.f.root,`preflight-${label}`);
  await fs.mkdir(parent);
  return parent;
}
async function officialBytes(image) {
  const activation=await fs.readFile(path.join(image.f.execution,'activation.json'));
  const declared=JSON.parse(activation);
  return {activation,
    artifacts:await Promise.all(declared.artifacts.map(async item=>
      [item.path,await fs.readFile(path.join(image.f.execution,item.path))])),
    first:await fs.readFile(path.join(image.f.root,'src/unpredicted.mjs')),
    firstForecast:await fs.readFile(path.join(image.f.root,'src/greeting.mjs')),
    second:await fs.readFile(path.join(image.f.root,'other/greeting.mjs'))};
}
const completeFirstForecast=image=>fs.writeFile(path.join(image.f.root,'src/greeting.mjs'),
  'export const greeting = "hello";\n');

test('P01 BLOCKED em outra delivery recusa factory antes de origin e recipe',async t=>{
  for(const drift of [false,true]) {
    const image=await convertedImage(t,{kind:'two-s2'});
    await completeFirstForecast(image);
    await concludeSecond(image,'BLOCKED');
    if(drift) await fs.appendFile(path.join(image.f.root,'src/unpredicted.mjs'),
      '// drift in first delivery after BLOCKED\n');
    const before=await officialBytes(image);
    for(const [index,modulePath] of modules.entries()) {
      const result=await probe({modulePath,specPath:image.f.specPath,deliveryId:deliveryIds(image)[0],
        captureParent:await privateParent(image,`factory-${drift}-${index}`),mode:'factory'});
      assert.equal(result.accepted,false,JSON.stringify(result));
      assert.equal(result.error?.code,'UNSUPPORTED_FORMAT');
      assert.match(result.error.message,/slice-02.*BLOCKED/u);
      assert.deepEqual(result.calls,[]);
      assert.deepEqual(result.privateAdded,[]);
    }
    const after=await officialBytes(image);
    assert.deepEqual(after,before,'rejected factory did not change official image or product');
  }
});

test('P02 BLOCKED incorporado após bind recusa antes de executar recipe',async t=>{
  const image=await convertedImage(t,{kind:'two-s2'});
  await completeFirstForecast(image);
  let settled=null;
  const result=await probe({modulePath:modules[0],specPath:image.f.specPath,
    deliveryId:deliveryIds(image)[0],captureParent:await privateParent(image,'run-blocked'),
    mode:'wait-run',onReady:async()=>{
      await concludeSecond(image,'BLOCKED');
      settled=await officialBytes(image);
    }});
  assert.equal(result.accepted,false,JSON.stringify(result));
  assert.equal(result.error?.code,'UNSUPPORTED_FORMAT');
  assert.match(result.error.message,/slice-02.*BLOCKED/u);
  assert.deepEqual(result.calls,[],'no recipe subprocess after known BLOCKED');
  assert.equal(result.privateAdded.length,1,'origin was created before later incorporation');
  assert.ok(result.privateFiles.includes('round-1.origin.json'));
  assert.ok(result.privateFiles.includes('round-1.agent.json'));
  assert.ok(!result.privateFiles.includes('round-1.verification.json'));
  assert.deepEqual(await officialBytes(image),settled);
});

test('P03 outra formal PASS muda activation e recusa sessão antiga antes da recipe',async t=>{
  const image=await convertedImage(t,{kind:'two-s2'});
  await completeFirstForecast(image);
  let settled=null;
  const result=await probe({modulePath:modules[1],specPath:image.f.specPath,
    deliveryId:deliveryIds(image)[0],captureParent:await privateParent(image,'run-stale'),
    mode:'wait-run',onReady:async()=>{
      await concludeSecond(image,'PASS');
      settled=await officialBytes(image);
    }});
  assert.equal(result.accepted,false,JSON.stringify(result));
  assert.equal(result.error?.code,'EVIDENCE_STALE');
  assert.deepEqual(result.calls,[],'changed activation is detected before recipe subprocess');
  assert.equal(result.privateAdded.length,1);
  assert.ok(!result.privateFiles.includes('round-1.verification.json'));
  assert.deepEqual(await officialBytes(image),settled);
});

test('P04 all-PASS quiet images still execute real S1 and S2 recipes',async t=>{
  for(const [kind,modulePath] of [['native-s1',modules[0]],['managed-s2',modules[1]]]) {
    const image=await convertedImage(t,{kind});
    if(kind==='managed-s2') await fs.writeFile(path.join(image.f.root,'src/greeting.mjs'),
      'export const greeting = "hello";\n');
    if(kind==='native-s1') {
      const quiet=await captureCurrentExecution(image.f.specPath);
      assert.equal(quiet.inspection.state,'VALIDATION_BLOCKED');
      assert.equal(quiet.inspection.deliveries[0].formalStatus,'PASS');
    }
    const result=await probe({modulePath,specPath:image.f.specPath,
      deliveryId:deliveryIds(image)[0],captureParent:await privateParent(image,kind),mode:'measure'});
    assert.equal(result.accepted,true,JSON.stringify(result));
    assert.equal(result.measured.status,'completed');
    assert.ok(result.calls.length>0,'real recipe subprocess was invoked');
    assert.ok(result.measured.commands.every(item=>item.exit===0));
    assert.ok(result.privateFiles.includes('round-1.verification.json'));
  }
});
