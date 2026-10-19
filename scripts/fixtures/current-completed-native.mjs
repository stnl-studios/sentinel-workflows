import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {currentImage} from './current-operational-consumption.mjs';
import {normalizedFormal} from './current-native-normalization.mjs';
import {restoreCaptureSources} from '../../skills/workflows/stnl-execution-planner/runtime/execution-evidence-proof.mjs';
import {initialArtifacts} from './current-initial-preparation.mjs';
import {retireActive} from './current-reader-campaign.mjs';
import {captureCurrentExecution} from '../../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';

// Preparation and predecessor captures are authored test setup. Only subsequent
// official tool conclusions can establish the live transport acceptance case.
export async function completedNativeCase(t,{drift=true,sharedInput=false,extraOutput=false,spaces=false,retire=true,independent=false}={}) {
  const image=await currentImage(t,{kind:'two-s2',behaviorCheck:true,sharedInput,spaces,independent}),root=image.f.root,run=promisify(execFile);
  await fs.writeFile(path.join(root,'.gitignore'),'/tmp/\n');
  await run('git',['-C',root,'init','-q']);
  await run('git',['-C',root,'add','.gitignore',path.relative(root,image.f.specPath)]);
  await run('git',['-C',root,'-c','user.name=Completed Fixture','-c','user.email=completed@example.invalid',
    'commit','-qm','completed native fixture']);
  const head=(await run('git',['-C',root,'rev-parse','HEAD'])).stdout.trim(),specPath=image.f.specPath;
  await fs.writeFile(path.join(root,'src/greeting.mjs'),'export const greeting="hello"; // A native base\n');
  await fs.writeFile(path.join(root,'src/greeting.test.mjs'),
    'import assert from "node:assert/strict";\nimport {greeting} from "./greeting.mjs";\nassert.equal(greeting,"hello");\n');
  if(extraOutput)await fs.writeFile(path.join(root,'other/obsolete module.mjs'),'export const obsolete=true;\n');
  let captured=await captureCurrentExecution(specPath);
  const deliveries=JSON.parse(Buffer.from(captured.files.get('continuity.json'))).deliveries;
  for(const delivery of deliveries)await normalizedFormal({image,root,head,specPath,delivery},independent
    ?{evidence:`Controlled source proof: the independent ${delivery.slice} greeting passes its prepared node behavior test.`}:{});
  captured=await captureCurrentExecution(specPath);
  const snapshot=JSON.parse(Buffer.from(captured.files.get('approved-preparation.json')));
  const view={project:root,execution:image.f.execution,specPath,source:specPath,spec:path.dirname(specPath),
    authority:captured.requirementsAuthority,activation:JSON.parse(Buffer.from(captured.activationBytes)),snapshot,
    files:new Map([...captured.files].map(([name,bytes])=>[name,Buffer.from(bytes)])),
    artifacts:new Map(snapshot.reviewedArtifacts.map(item=>[item.path,Buffer.from(item.utf8)])),
    continuity:JSON.parse(Buffer.from(captured.files.get('continuity.json')))};
  if(retire)await retireActive(view,['slice-01']);
  const productFile=spaces?'other/greeting output.mjs':'other/greeting.mjs';
  if(drift)await fs.writeFile(path.join(root,productFile),'export const greeting="hello"; // B private drift\n');
  return {image,root,head,specPath,delivery:deliveries[1],view,productFile,testFile:spaces?'other/greeting test.mjs':'other/greeting.test.mjs'};
}

// Shared authoring of the Q19 draft for pure and public preparation tests only.
const decode=bytes=>JSON.parse(Buffer.from(bytes));
const cloneFiles=files=>new Map([...files].map(([name,bytes])=>[name,Buffer.from(bytes)]));
const setSection=(text,name,body)=>text.replace(new RegExp(`(^## ${name}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu'),
  (_,heading)=>heading+body+'\n\n');
export function reopeningInput(source,deliveryId,{terminalValidation=false}={}) {
  const snapshot=decode(source.files.get('approved-preparation.json'));
  const continuity=decode(source.files.get('continuity.json'));
  const member=continuity.completed.find(item=>item.deliveryId===deliveryId),slice=member.slice,number=slice.slice(6);
  const leaf=structuredClone(snapshot.normativeProjection.completed.find(item=>item.deliveryId===deliveryId));
  const members=new Map(continuity.completed.map(item=>[item.deliveryId,item.slice]));
  leaf.obligations=leaf.obligations.map(item=>({...item,
    fullOwner:item.fullOwner==='delivery:'+deliveryId?slice:item.fullOwner}));
  if(!terminalValidation) {
    leaf.verificationRecipe.checks[0].args.splice(1,0,{literal:'--test-reporter=tap'});
    leaf.expectedTests='- node --test --test-reporter=tap other/greeting.test.mjs';
  }
  const revision=snapshot.preparationRevision+1,local=member.localRevision+(terminalValidation?0:1);
  const dependencies=leaf.dependencies.map(id=>members.get(id));
  const refs=group=>path.relative(path.dirname(path.join(source.context.logicalExecutionRoot,`${group}/${slice}.md`)),
    source.context.logicalAuthorityPath).split(path.sep).join('/');
  const retained=terminalValidation?decode(source.files.get(member.evidence.path)):null;
  const scope=retained?decode(restoreCaptureSources('current-validation',retained.validation,
    new Map(retained.objects.map(item=>[item.id,Buffer.from(item.bytesBase64,'base64')]))).validationRequest).scope.paths:['other/greeting.mjs'];
  const expected=scope.map(name=>'- `'+path.relative(path.join(source.context.logicalExecutionRoot,'tasks'),
    path.join(source.context.productRoot,name)).split(path.sep).join('/')+'`').join('\n');
  const templates=initialArtifacts({form:'standalone'});
  let plan=Buffer.from(templates.get('plans/slice-02.md')).toString('utf8').replaceAll('Pay','Greeting').replaceAll('pay','greeting');
  let task=Buffer.from(templates.get('tasks/slice-02.md')).toString('utf8').replaceAll('Pay','Greeting').replaceAll('pay','greeting');
  if(terminalValidation&&number!=='02') {
    plan=plan.replace('Slice 02 -','Slice '+number+' -');task=task.replace('Slice 02 Tasks -','Slice '+number+' Tasks -');
  }
  plan=setSection(plan,'References',`- Slice: ${number}\n- Delivery ID: ${deliveryId}\n- Requirements source: \`${refs('plans')}\`\n- Requirements authority: ${snapshot.requirementsAuthority}\n- Plan revision: ${revision}\n- Local revision: ${local}\n- Global plan: \`../plan.md\`\n- Review state: approved`);
  task=setSection(task,'References',`- Slice: ${number}\n- Delivery ID: ${deliveryId}\n- Plan: \`../plans/${slice}.md\`\n- Requirements source: \`${refs('tasks')}\`\n- Requirements authority: ${snapshot.requirementsAuthority}\n- Plan revision: ${revision}\n- Local revision: ${local}\n- Global tasks: \`../tasks.md\``);
  const planSections={'Objective and Observable Result':leaf.objectiveAndObservableResult,Requirements:leaf.requirements,
    'Included Scope':leaf.includedScope,'Out of Scope and Boundaries':leaf.outOfScopeAndBoundaries,
    'Authorized Areas':leaf.authorizedAreas,'Expected Files':expected,'Existing Inputs':leaf.existingInputs,
    'Protected Responsibilities':leaf.protectedResponsibilities,Dependencies:dependencies.map(value=>'- '+value).join('\n')||'- none',
    'Risks and Strategy':leaf.risksAndStrategy,'Expected Tests':leaf.expectedTests,
    'Verification Recipe':'- Recipe: '+JSON.stringify(leaf.verificationRecipe),'Completion Criterion':leaf.completionCriterion};
  for(const [name,body] of Object.entries(planSections))plan=setSection(plan,name,body);
  const taskSections={Result:leaf.taskResult,'Acceptance Obligations':leaf.obligations.map(item=>
    `- ${item.id} | requirement: ${item.requirement} | contribution: ${item.contribution} | full owner: ${item.fullOwner} | condition: ${item.condition} | proof: ${item.proof}`).join('\n'),
    'Authorized Areas':leaf.authorizedAreas,'Expected Files':expected,'Existing Inputs':leaf.existingInputs,
    'Protected Responsibilities':leaf.protectedResponsibilities,'Expected Tests':leaf.expectedTests,
    'Verification Recipe':'- Recipe: '+JSON.stringify(leaf.verificationRecipe),
    Continuity:'- Current validation: revalidation-required\n- Current evidence: none\n- Current action: VALIDATE_SLICE'};
  for(const [name,body] of Object.entries(taskSections))task=setSection(task,name,body);
  const title=`${number} - Verification`,deps=dependencies.join(', ')||'-';
  const areas=leaf.authorizedAreas.split('\n').map(line=>line.slice(2).replace(/`([^`]+)`/gu,(_,ref)=>
    '`'+path.relative(source.context.logicalExecutionRoot,
      path.resolve(source.context.logicalExecutionRoot,'plans',ref)).split(path.sep).join('/')+'`')).join('; ');
  const requirements=[...new Set(leaf.obligations.map(item=>item.requirement))].join(', ');
  const row=`| ${title} | ${leaf.taskResult} | ${deps} | ${requirements} | ${areas} | plans/${slice}.md |`;
  let globalPlan=Buffer.from(source.files.get('plan.md')).toString('utf8').replace(/^- Plan revision: .+$/mu,'- Plan revision: '+revision);
  globalPlan=setSection(globalPlan,'Serial Slice Order','| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |\n|---|---|---|---|---|---|\n'+row);
  const index=Buffer.from(source.files.get('tasks.md')).toString('utf8').trimEnd()+`\n| [ ] | ${title} | ${leaf.taskResult} | ${deps} | tasks/${slice}.md | pending | pending |\n`;
  return {context:source.context,requirementsAuthority:source.requirementsAuthority,
    previous:{activationBytes:Buffer.from(source.activationBytes),files:cloneFiles(source.files)},
    artifacts:new Map([['plan.md',Buffer.from(globalPlan)],['tasks.md',Buffer.from(index)],
      [`plans/${slice}.md`,Buffer.from(plan)],[`tasks/${slice}.md`,Buffer.from(task)]]),
    completedDeliveryIds:continuity.completed.filter(item=>item.deliveryId!==deliveryId).map(item=>item.deliveryId),
    ...(terminalValidation?{terminalValidation:true}:{})};
}
