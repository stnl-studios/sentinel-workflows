import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {convertedImage} from './current-operational-consumption.mjs';
import {normalizedFormal} from './current-native-normalization.mjs';
import {retireActive} from './current-reader-campaign.mjs';
import {captureCurrentExecution} from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

// Preparation and predecessor captures are authored test setup. Only subsequent
// official tool conclusions can establish the live transport acceptance case.
export async function completedNativeCase(t,{drift=true,sharedInput=false}={}) {
  const image=await convertedImage(t,{kind:'two-s2',behaviorCheck:true,sharedInput}),root=image.f.root,run=promisify(execFile);
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  await run('git',['-C',root,'init','-q']);
  await run('git',['-C',root,'add','.gitignore','requirements.md']);
  await run('git',['-C',root,'-c','user.name=Completed Fixture','-c','user.email=completed@example.invalid',
    'commit','-qm','completed native fixture']);
  const head=(await run('git',['-C',root,'rev-parse','HEAD'])).stdout.trim(),specPath=image.f.specPath;
  await fs.writeFile(path.join(root,'src/greeting.mjs'),'export const greeting="hello"; // A native base\n');
  await fs.writeFile(path.join(root,'src/greeting.test.mjs'),
    'import assert from "node:assert/strict";\nimport {greeting} from "./greeting.mjs";\nassert.equal(greeting,"hello");\n');
  let captured=await captureCurrentExecution(specPath);
  const deliveries=JSON.parse(Buffer.from(captured.files.get('continuity.json'))).deliveries;
  for(const delivery of deliveries)await normalizedFormal({image,root,head,specPath,delivery});
  captured=await captureCurrentExecution(specPath);
  const snapshot=JSON.parse(Buffer.from(captured.files.get('approved-preparation.json')));
  const view={project:root,execution:image.f.execution,specPath,source:specPath,spec:path.dirname(specPath),
    authority:captured.requirementsAuthority,activation:JSON.parse(Buffer.from(captured.activationBytes)),snapshot,
    files:new Map([...captured.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),
    artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8)])),
    continuity:JSON.parse(Buffer.from(captured.files.get('continuity.json')))};
  await retireActive(view,['slice-01']);
  if(drift)await fs.writeFile(path.join(root,'other/greeting.mjs'),'export const greeting="hello"; // B private drift\n');
  return {image,root,head,specPath,delivery:deliveries[1],view};
}
