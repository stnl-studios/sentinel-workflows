// Legacy producer fixture for L2.6. It calls the real preparation writers and
// contains no node:test registration or import of a test entrypoint.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {preparePreparationCandidate} from '../../skills/workflows/stnl-execution-planner/runtime/prepare-task-candidate.mjs';
import {publishPreparationCandidate} from '../../skills/workflows/stnl-execution-planner/runtime/publish-task-candidate.mjs';
import {computeRequirementsAuthority, resolveExecutionWorkspace, readExecutionActivation} from '../../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import {projectPreparationAuthority, readPreparationArtifacts} from '../../skills/workflows/stnl-execution-planner/runtime/execution-preparation.mjs';
import {preparePlanCandidate} from '../../skills/workflows/stnl-execution-planner/runtime/prepare-plan-candidate.mjs';
import {serializePlanPathClaims} from '../../skills/workflows/stnl-execution-planner/runtime/serialize-plan-paths.mjs';
import {projectConversionPreparation} from '../../skills/workflows/stnl-execution-planner/runtime/execution-preparation-current.mjs';
import {beginPreparedExecutionOperation,readRunnerVerification,validateExecutionCandidate} from '../../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {startNativeRunnerCapture,bindNativeRunnerIdentity,runNativeRunnerVerification,captureNativeRunnerResult} from '../../skills/workflows/stnl-slice-executor/runtime/capture-runner-response.mjs';
import {prepareExecutionCopy,publishExecutionCopy} from '../../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';
import {serializeRunnerExecutionBundleFromResponse,insertExecutionEvidenceInCandidate} from '../../skills/workflows/stnl-slice-executor/runtime/serialize-runner-evidence.mjs';
import {prepareValidationCopy} from '../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-copy.mjs';
import {prepareValidationCandidate} from '../../skills/workflows/stnl-slice-quality-manager/runtime/prepare-validation-candidate.mjs';
import {publishValidationCandidate} from '../../skills/workflows/stnl-slice-quality-manager/runtime/publish-validation-candidate.mjs';
import {verificationCommand} from '../../skills/workflows/stnl-slice-executor/runtime/runner-verification.mjs';
import {withManagedExample} from './managed-execution-example.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const reviewDecision = { operation: 'REVIEW_PLAN', status: 'approved', examined: ['requirements', 'plans', 'tasks', 'initial checklist', 'proof capability'],
  summary: 'Offline review fixture: AC-001 requires an observable export; serial ownership, protected responsibilities and node --test export behavior checked. This simulated decision does not certify independent model judgment.' };
const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills/workflows/stnl-execution-planner/templates');
const replace = (text, values) => values.reduce((result, [a, b]) => result.replaceAll(a, b), text);
export const verificationBody = ({file='src/greeting.test.mjs', kind='product', inputs=[], files=null, cwd='.'}={}) => '- Recipe: ' + JSON.stringify({format:'stnl-verification-recipe-v1',base:'workspace',cwd,
  checks:[{id:'verification-01',executable:{literal:'node'},args:[{literal:'--test'},...(files ?? [file]).map(path=>({file:{kind,path}}))],inputs:inputs.map(path=>({kind:'input',path}))}],
  dependencyReview:'Reviewed direct proof references and indirect imports/configuration; all dependencies explicitly contained in approved product areas or Existing Inputs.'});
export async function fixture({ parent = path.join(repo, 'tmp'), test = null, form = 'standalone', fileless = false,
  retiredSelector = false } = {}) {
  await fs.mkdir(parent, {recursive:true});
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'stnl-p1b-test-')));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'src'));
  assert.ok(['standalone', 'nested-standalone', 'lifecycle-directory', 'lifecycle-file'].includes(form));
  let specPath = path.join(root, form === 'nested-standalone' ? 'docs/área Ω/requirements.md' : 'requirements.md');
  if (form.startsWith('lifecycle-')) {
    const directory = path.join(root, 'specs/área Ω/feature');
    await fs.cp(path.join(templateRoot, '../../stnl-spec-lifecycle-manager/examples/validator-fixtures/ready'), directory, { recursive: true });
    specPath = form === 'lifecycle-directory' ? directory : path.join(directory, 'feature_spec.md');
  } else {
    await fs.mkdir(path.dirname(specPath), { recursive: true });
    await fs.writeFile(specPath,fileless
      ? '# Requirements\n\nAC-001: Run the fixed arithmetic command successfully without creating product files.\n'
      : '# Requirements\n\nAC-001: Export a deterministic greeting. Verify by node --test.\n');
  }
  const workspace = await resolveExecutionWorkspace(specPath);
  const authority = await computeRequirementsAuthority(specPath);
  const prepared = await preparePreparationCandidate({ specPath, operation: 'PLAN' });
  const candidate = prepared.candidateExecutionRoot;
  for (const dir of ['plans', 'tasks']) await fs.mkdir(path.join(candidate, dir));
  const authorityPath = form === 'lifecycle-directory' ? path.join(specPath, 'feature_spec.md') : specPath;
  const identity = file => [['`<relative path>`', '`' + path.relative(path.dirname(path.join(workspace.executionRoot, file)), authorityPath).split(path.sep).join('/') + '`'],
    ['sha256:<64hex>', `sha256:${authority}`], ['<positive integer>', '1']];
  const rendering = [
    ['plan.template.md', 'plan.md', [['<compact objective>', 'Deliver a deterministic greeting.'], ['<compact strategy>', 'One serial implementation and test delivery.'], ['01 - <name>', '01 - Greeting'], ['<result>', 'Export observed by a prepared node test.'],
      ['directory: `<repository-relative physical target>`', 'directory: `src`'], ['<risk, boundary, or explicit final integration slice>', 'No auth, persistence or public protocol changes.']]],
    ['slice-plan.template.md', 'plans/slice-01.md', [['<Name>', 'Greeting'], ['<One coherent delivery and how it is observed.>', 'Export observed by node --test.'], ['<included work>', 'Create the greeting and its prepared check.'], ['<excluded work and boundary with later slices>', 'No authentication or persistence changes.'], ['`<artifact-relative authorized subtree or exact file>`', '`src`'], ['`<artifact-relative predicted file>`', '`src/greeting.mjs`'], ['<auth, persistence and public-contract boundaries requiring semantic review>', 'No authentication or persistence changes.'], ['<earlier slice or none>', 'none'], ['<risk and mitigation>', 'Export compatibility: assert value.'], ['<bounded approach>', 'Prepare a bounded module and node test.'], ['<test, command, suite, or observable check>', 'node --test src/greeting.test.mjs'], ['<verification file>', 'src/greeting.test.mjs'], ['<reviewed indirect dependencies>', 'The prepared test imports src/unpredicted.mjs inside the authorized product area; no external indirect inputs.'], ['<objective result and preserved boundary>', 'AC-001 observed with protected responsibilities preserved.']]],
    ['tasks.template.md', 'tasks.md', [['01 - <name>', '01 - Greeting'], ['<observable delivery>', 'Export observed by a prepared node test.']]],
    ['slice-tasks.template.md', 'tasks/slice-01.md', [['<Name>', 'Greeting'], ['<Local observable delivery and its practical outcome.>', 'Export observed by a prepared node test.'], ['<observable condition>', 'Greeting equals hello'], ['<required evidence>', 'node --test src/greeting.test.mjs observes export value'], ['`<artifact-relative authorized subtree or exact file>`', '`src`'], ['`<artifact-relative predicted file>`', '`src/greeting.mjs`'], ['<protected semantic responsibility and exclusion>', 'No authentication or persistence changes.'], ['<technical action>', 'Implement greeting and prepared test'], ['<test, command, suite, or observable check>', 'node --test src/greeting.test.mjs'], ['<verification file>', 'src/greeting.test.mjs'], ['<reviewed indirect dependencies>', 'The prepared test imports src/unpredicted.mjs inside the authorized product area; no external indirect inputs.']]],
  ];
  for (const [template, file, values] of rendering) await fs.writeFile(path.join(candidate, file), replace(await fs.readFile(path.join(templateRoot, template), 'utf8'), [...identity(file), ...values]));
  if(retiredSelector) {
    assert.equal(fileless,false,'retired selector fixture uses an ordinary approved preparation');
    const planFile=path.join(candidate,'plan.md'),indexFile=path.join(candidate,'tasks.md');
    const plan=await fs.readFile(planFile,'utf8'),index=await fs.readFile(indexFile,'utf8');
    const orderTable=plan.match(/\| Slice \| Observable delivery[\s\S]*?\| plans\/slice-01\.md \|/u)?.[0];
    assert.ok(orderTable,'initial approved selector table');
    await fs.writeFile(planFile,setPreparationSection(plan,'Serial Slice Order',
      orderTable+'\n| 02 - Completion | Confirm the prepared greeting result. | slice-01 | AC-001 | directory: `src` | plans/slice-02.md |'));
    await fs.writeFile(indexFile,index.replace(/(\| \[ \] \| 01 - Greeting \|[^\n]+\n)/u,
      '$1| [ ] | 02 - Completion | Confirm the prepared greeting result. | slice-01 | tasks/slice-02.md | pending | pending |\n'));
    const firstTask=path.join(candidate,'tasks/slice-01.md');
    const originalTask=await fs.readFile(firstTask,'utf8');
    await fs.writeFile(firstTask,originalTask.replace('contribution: complete | full owner: slice-01',
      'contribution: partial | full owner: slice-02'));
    const detail=(await fs.readFile(path.join(candidate,'plans/slice-01.md'),'utf8'))
      .replace('Slice 01 - Greeting','Slice 02 - Completion').replace('- Slice: 01','- Slice: 02')
      .replace('## Dependencies\n\n- none','## Dependencies\n\n- slice-01');
    await fs.writeFile(path.join(candidate,'plans/slice-02.md'),detail);
    await fs.writeFile(path.join(candidate,'tasks/slice-02.md'),originalTask
      .replace('Slice 01 Tasks - Greeting','Slice 02 Tasks - Completion').replace('- Slice: 01','- Slice: 02')
      .replaceAll('slice-01.md','slice-02.md').replace('full owner: slice-01','full owner: slice-02')
      .replace('## Result\n\nExport observed by a prepared node test.',
        '## Result\n\nConfirm the prepared greeting result.'));
  }
  if(fileless) {
    const recipe={format:'stnl-verification-recipe-v1',base:'workspace',cwd:'.',checks:[
      {id:'verification-01',executable:{literal:'node'},args:[{literal:'-e'},
        {literal:'if (2 + 2 !== 4) process.exit(1)'}],inputs:[]}],
    dependencyReview:'The command uses Node and literal arithmetic only; no product file or indirect input is required.'};
    const edits={
      'plan.md':{'Global Context':`- Requirements source: \`${path.relative(workspace.executionRoot,authorityPath).split(path.sep).join('/')}\`\n- Requirements authority: sha256:${authority}\n- Plan revision: 1\n- Objective: Run the fixed arithmetic command without product files.\n- Strategy: One fileless delivery with a prepared literal recipe.\n- Review state: pending`,
        'Serial Slice Order':'| Slice | Observable delivery | Dependencies | Requirements | Authorized areas | Detailed plan |\n|---|---|---|---|---|---|\n| 01 - Arithmetic | Arithmetic command exits zero without product files. | - | AC-001 | directory: `src` | plans/slice-01.md |'},
      'plans/slice-01.md':{'Objective and Observable Result':'Arithmetic command exits zero with an empty product directory.',
        'Included Scope':'- Run the prepared literal arithmetic command; leave product files absent.',
        'Expected Files':'- none','Existing Inputs':'- none',
        'Expected Tests':'- node -e verifies the fixed arithmetic expression.',
        'Verification Recipe':`- Recipe: ${JSON.stringify(recipe)}`,
        'Completion Criterion':'- AC-001 exits zero and the product directory remains empty.'},
      'tasks/slice-01.md':{'Result':'Arithmetic command exits zero without product files.',
        'Acceptance Obligations':'- obligation-01 | requirement: AC-001 | contribution: complete | full owner: slice-01 | condition: arithmetic command exits zero with no product file | proof: prepared literal Node command',
        'Expected Files':'- none','Existing Inputs':'- none',
        'Expected Tests':'- node -e verifies the fixed arithmetic expression.',
        'Checklist':'- [ ] 1.1 Run the prepared arithmetic check without product changes | obligations: obligation-01',
        'Verification Recipe':`- Recipe: ${JSON.stringify(recipe)}`},
    };
    for(const [name,sections] of Object.entries(edits)) {
      let content=await fs.readFile(path.join(candidate,name),'utf8');
      for(const [heading,body] of Object.entries(sections)) content=setPreparationSection(content,heading,body);
      content=content.replace('# Slice 01 - Greeting','# Slice 01 - Arithmetic')
        .replace('# Slice 01 Tasks - Greeting','# Slice 01 Tasks - Arithmetic');
      await fs.writeFile(path.join(candidate,name),content);
    }
    const index=path.join(candidate,'tasks.md');
    await fs.writeFile(index,(await fs.readFile(index,'utf8')).replaceAll('Export observed by a prepared node test.',
      'Arithmetic command exits zero without product files.').replace('01 - Greeting','01 - Arithmetic'));
  }
  const f = { root, specPath, requirements: specPath, execution: workspace.executionRoot, workspace, candidate, test, authority, fileless };
  if(retiredSelector) await normalizePreparation(f,candidate);
  if (test) {
    test.after(() => fs.rm(root, { recursive: true, force: true }));
    retainPreparation(f, candidate);
  }
  return f;
}
export function retainPreparation(f, root) {
  if (f.test && root) f.test.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(root + '.owner.json', { force: true });
  });
  return root;
}
export async function prepareFixtureCandidate(f, operation, options = {}) {
  const prepared = await preparePreparationCandidate({ specPath: f.specPath, operation, ...options });
  retainPreparation(f, prepared.candidateExecutionRoot);
  return prepared.candidateExecutionRoot;
}
export async function publishFixtureCandidate(f, candidateExecutionRoot, options = {}) {
  const published = await publishPreparationCandidate({ specPath: f.specPath, candidateExecutionRoot, ...options });
  retainPreparation(f, published.retainedBackup);
  return published;
}
function sameContinuity(snapshot, reason) {
  const first=snapshot.deliveries[0];
  return '| Slice | Prior delivery ID | Relation | Prior preparation revision | Reason | Affected verification |\n'
    + '|---|---|---|---|---|---|\n'
    + `| ${first.slice} | ${first.deliveryId} | same | ${snapshot.preparationRevision} | ${reason} | revalidate |`;
}
export const setPreparationSection = (text, heading, body) => {
  const pattern = new RegExp(`(^## ${heading}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'mu');
  assert.match(text, pattern, `section ${heading} exists`);
  return text.replace(pattern, (_, prefix) => `${prefix}${body}\n\n`);
};
export async function editPreparation(root, name, mutate) {
  const file = path.join(root, name), before = await fs.readFile(file, 'utf8'), after = mutate(before);
  assert.notEqual(after, before, `${name}: stimulus-applied`);
  await fs.writeFile(file, after);
}
export async function normalizePreparation(f, root) {
  await preparePlanCandidate({ candidateExecutionRoot: root });
  await serializePlanPathClaims({ specPath: f.specPath, candidateExecutionRoot: root });
}
export async function projectPreparationAuthorityFrom(root) {
  return projectPreparationAuthority(await readPreparationArtifacts(root));
}
export async function approveFixture(f) {
  await publishFixtureCandidate(f, f.candidate);
  const review = await prepareFixtureCandidate(f, 'REVIEW_PLAN');
  await reviewFixtureCandidate(f, review);
  return readExecutionActivation(f.specPath);
}

export async function revisedS0(test) {
  const f=await fixture({test});
  await approveFixture(f);
  const previous=JSON.parse(await fs.readFile(path.join(f.execution,'approved-preparation.json')));
  await fs.appendFile(f.specPath,'\nDocumentary clarification: the same AC-001 delivery remains observable.\n');
  f.authority=await computeRequirementsAuthority(f.specPath);
  const candidate=await prepareFixtureCandidate(f,'REPLAN');
  await editPreparation(candidate,'plan.md',text=>setPreparationSection(text.replace('- Review state: approved',
    '- Review state: approved\n- Replan reason: Preserve the serial delivery under the clarified authority.'),
    'Delivery Continuity',sameContinuity(previous,'Preserve the serial delivery under clarified authority.')));
  const draft=await publishFixtureCandidate(f,candidate);
  const markerBytes=await fs.readFile(draft.allocation);
  const marker=JSON.parse(markerBytes);
  const snapshotPath=marker.retention.retainedPaths.find(item=>path.basename(item.path)==='slice-01-snapshot.json')?.path;
  assert.ok(snapshotPath,'producer-retained selector snapshot');
  const snapshotBytes=await fs.readFile(snapshotPath);
  assert.ok(marker.retention.retainedPaths.some(item=>item.path===snapshotPath && item.sha256===sha(snapshotBytes)));
  const review=await prepareFixtureCandidate(f,'REVIEW_PLAN');
  await reviewFixtureCandidate(f,review);
  const controls=new Map([[draft.allocation,markerBytes],[snapshotPath,snapshotBytes]]);
  const selectorHistory=[{revision:1,allocationRef:{path:path.relative(f.execution,draft.allocation).split(path.sep).join('/'),
    allocationId:marker.allocationId,sha256:sha(Buffer.from(JSON.stringify(marker.retention)))},
  snapshotRef:{path:path.relative(f.execution,snapshotPath).split(path.sep).join('/'),sha256:sha(snapshotBytes)}}];
  const input=await captureLegacy(f,{controls,selectorHistory});
  return {f,input};
}
export async function retiredSelectorS0(test) {
  const f=await fixture({test,retiredSelector:true});
  await approveFixture(f);
  const previous=JSON.parse(await fs.readFile(path.join(f.execution,'approved-preparation.json')));
  assert.deepEqual(previous.normativeProjection.order.map(item=>item.slice),['slice-01','slice-02']);
  await fs.appendFile(f.specPath,'\nClarification: the first delivery alone covers AC-001.\n');
  f.authority=await computeRequirementsAuthority(f.specPath);
  const candidate=await prepareFixtureCandidate(f,'REPLAN');
  await editPreparation(candidate,'plan.md',text=>{
    const onlyFirst=text.match(/\| Slice \| Observable delivery[\s\S]*?\| plans\/slice-01\.md \|/u)?.[0];
    assert.ok(onlyFirst,'REPLAN preserves first selector');
    return setPreparationSection(text,'Serial Slice Order',onlyFirst);
  });
  await editPreparation(candidate,'tasks.md',text=>text.replace(/^\| \[ \] \| 02 - Completion \|.*\n/mu,''));
  await editPreparation(candidate,'tasks/slice-01.md',text=>text.replace(
    'contribution: partial | full owner: slice-02','contribution: complete | full owner: slice-01'));
  await editPreparation(candidate,'plan.md',text=>setPreparationSection(text.replace('- Review state: approved',
    '- Review state: approved\n- Replan reason: Retire the second selector while preserving the first delivery.'),'Delivery Continuity',
    sameContinuity(previous,'Retain the first delivery after removing the second selector.')));
  await fs.rm(path.join(candidate,'plans/slice-02.md'));
  await fs.rm(path.join(candidate,'tasks/slice-02.md'));
  await normalizePreparation(f,candidate);
  const draft=await publishFixtureCandidate(f,candidate);
  const markerBytes=await fs.readFile(draft.allocation),marker=JSON.parse(markerBytes);
  const snapshotPath=marker.retention.retainedPaths.find(item=>path.basename(item.path)==='slice-01-snapshot.json')?.path;
  assert.ok(snapshotPath,'producer-retained selector snapshot');
  const snapshotBytes=await fs.readFile(snapshotPath);
  assert.equal(sha(snapshotBytes),marker.retention.retainedPaths.find(item=>item.path===snapshotPath)?.sha256);
  const review=await prepareFixtureCandidate(f,'REVIEW_PLAN');
  await reviewFixtureCandidate(f,review);
  const controls=new Map([[draft.allocation,markerBytes],[snapshotPath,snapshotBytes]]);
  const selectorHistory=[{revision:1,allocationRef:{path:path.relative(f.execution,draft.allocation).split(path.sep).join('/'),
    allocationId:marker.allocationId,sha256:sha(Buffer.from(JSON.stringify(marker.retention)))},
  snapshotRef:{path:path.relative(f.execution,snapshotPath).split(path.sep).join('/'),sha256:sha(snapshotBytes)}}];
  return {f,input:await captureLegacy(f,{controls,selectorHistory})};
}
export async function reviewFixtureCandidate(f, root) {
  for (const [name, text] of await readPreparationArtifacts(root)) await fs.writeFile(path.join(root, name), text.replace('status: draft', 'status: ready').replace('- Review state: pending', '- Review state: approved'));
  return publishFixtureCandidate(f, root, { reviewDecision:f.fileless
    ?{...reviewDecision,summary:'Offline review fixture: AC-001 is a literal arithmetic command with empty product domain and a prepared Node recipe; the independent judgment remains a declared stimulus.'}
    :reviewDecision });
}

export const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const order = (a,b) => a < b ? -1 : a > b ? 1 : 0;

// The caller supplies only explicitly linked controls. This routine neither
// scans backup directories nor supplies a missing receipt/marker from a label.
export async function captureLegacy(f,{controls=new Map(),managedContexts=new Map(),selectorHistory=[],imports}={}) {
  // Baseline retention is produced at preparation time, before any operation.
  // Capture its explicit closure even for pristine S0; it is not consumption.
  const linkedControls=await continuityControls(f);
  for(const [name,bytes] of controls) {
    if(linkedControls.has(name)) assert.deepEqual(linkedControls.get(name),bytes,'captured control bytes agree');
    linkedControls.set(name,bytes);
  }
  const execution=f.workspace.executionRoot;
  const activationBytes=await fs.readFile(path.join(execution,'activation.json'));
  const activation=JSON.parse(activationBytes);
  const files=new Map([['activation.json',activationBytes]]);
  for(const {path:relative} of activation.artifacts) files.set(relative,
    await fs.readFile(path.join(execution,...relative.split('/'))));
  const treeFiles=[];
  for(const relative of ['plans','tasks']) treeFiles.push({path:relative,type:'directory'});
  for(const relative of [...files.keys()].sort(order)) {
    const stat=await fs.lstat(path.join(execution,...relative.split('/')));
    assert.ok(stat.isFile() && !stat.isSymbolicLink(),`${relative}: regular official file`);
    treeFiles.push({path:relative,type:'file',sha256:sha(files.get(relative)),mode:stat.mode & 0o777});
  }
  const stat=await fs.lstat(execution);
  const authorityPath=f.specPath.endsWith('.md')?f.specPath:path.join(f.specPath,'feature_spec.md');
  const context={logicalSpecRoot:path.basename(authorityPath)==='feature_spec.md'?path.dirname(authorityPath):null,
    logicalAuthorityPath:authorityPath,logicalExecutionRoot:execution,physicalExecutionRoot:execution,productRoot:f.root};
  const requirementsFiles=new Map([[authorityPath,await fs.readFile(authorityPath)]]);
  if(context.logicalSpecRoot!==null) {
    const shared=path.join(context.logicalSpecRoot,'shared');
    const names=await fs.readdir(shared).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for(const name of names.filter(name=>name.endsWith('.md')).sort(order))
      requirementsFiles.set(path.join(shared,name),await fs.readFile(path.join(shared,name)));
  }
  const source={format:'stnl-legacy-conversion-capture-v1',
    requirementsFiles,files,
    tree:{identity:{dev:String(stat.dev),ino:String(stat.ino)},files:treeFiles},
    controls:linkedControls,managedContexts:new Map(managedContexts),selectorHistory,imports:imports??activation.artifacts
      .filter(item=>item.path.startsWith('tasks/')).map(({path:task})=>({slice:path.basename(task,'.md'),
        implementation:[],validation:null,objects:new Map(),boundary:null}))};
  const currentAuthority=await computeRequirementsAuthority(f.specPath);
  assert.equal(currentAuthority,f.authority,'captured requirements match published preparation authority');
  return {context,requirementsAuthority:`sha256:${currentAuthority}`,source,
    observedWork:await observeWork(f.root,f.observedRoots??['src'])};
}

// Product observation is an independent filesystem preimage. In particular,
// its mode is only the migration-time mode, never a v1 tested mode.
export async function observeWork(root,roots=['src']) {
  const entries=[],visited=new Set();
  async function visit(relative) {
    if(visited.has(relative)) return;
    visited.add(relative);
    const absolute=path.join(root,...relative.split('/'));
    const stat=await fs.lstat(absolute).catch(error=>{if(error.code==='ENOENT') return null;throw error;});
    if(stat===null) {entries.push({path:relative,kind:'absent'});return;}
    if(stat.isDirectory()) {
      const children=(await fs.readdir(absolute)).sort(order);
      entries.push({path:relative,kind:'directory',children});
      for(const child of children) await visit(`${relative}/${child}`);
    } else {
      assert.ok(stat.isFile() && !stat.isSymbolicLink(),`${relative}: regular product file`);
      entries.push({path:relative,kind:'file',sha256:sha(await fs.readFile(absolute)),mode:stat.mode & 0o777});
    }
  }
  for(const root of roots) await visit(root);
  return {format:'stnl-current-work-v1',entries:entries.sort((a,b)=>order(a.path,b.path))};
}

// A simulated reviewer binds an independently inspected proposal to the exact
// bytes it was given. Assertions about IDs, counters and outcomes live in the
// focal test and never use this projection as their expected value.
export function reviewProposal(proposal,{context,requirementsAuthority}) {
  const authority=projectConversionPreparation({context,requirementsAuthority,artifacts:proposal.files});
  const examined=names=>names.sort(order).map(name=>({path:name,sha256:sha(proposal.files.get(name))}));
  const decisionFor=id=>proposal.proposedDecisions.filter(item=>item.deliveryId===id)
    .map(item=>({...item,reason:'Reviewed exact captured legacy proof and final conversion disposition.'}));
  return {proposalSha256:proposal.proposalSha256,
    globalReview:{scope:'set',decision:'approved',authoritySha256:authority.globalReviewAuthoritySha256,
      examinedArtifactHashes:examined(['plan.md','tasks.md']),evidenceDecisions:[],
      summary:'Independent fixture review of final conversion bytes and preserved source identity.'},
    deliveries:authority.deliveries.map(item=>({deliveryId:item.deliveryId,review:{scope:'slice',decision:'approved',
      authoritySha256:item.authoritySha256,
      examinedArtifactHashes:examined([`plans/${item.slice}.md`,`tasks/${item.slice}.md`]),
      evidenceDecisions:decisionFor(item.deliveryId),summary:'Reviewed final delivery carriers and evidence disposition.'}}))};
}

const readJson=async name=>JSON.parse(await fs.readFile(name,'utf8'));
const updateSection=(text,heading,body)=>{
  const marker=new RegExp(`(^## ${heading}\\n\\n)[\\s\\S]*?(?=^## |$(?![\\s\\S]))`,'mu');
  assert.match(text,marker);
  return text.replace(marker,(_,prefix)=>`${prefix}${body}\n\n`);
};

async function nativeStart(f,owner,candidateTaskArtifact=null) {
  const start=await startNativeRunnerCapture({specPath:f.specPath,owner,workspace:f.root,
    captureParent:f.root,candidateTaskArtifact});
  const agentId=`l26-native-${randomUUID()}`;
  await bindNativeRunnerIdentity({...start,agentId});
  return {start,agentId};
}

async function nativeRound({start,agentId},response,changedAreas=null) {
  const observed=await runNativeRunnerVerification({originFile:start.originFile});
  assert.equal(observed.status,'completed');
  const captured=await captureNativeRunnerResult({originFile:start.originFile,
    result:{agentId,status:'completed',finalResponse:JSON.stringify(response)},changedAreas});
  return {start,agentId,captured,observed};
}

async function withOwner(f,owner,action) {
  const ownerFile=path.join(f.root,`l26-owner-${owner.operationAttemptId}.json`);
  await fs.writeFile(ownerFile,JSON.stringify({specPath:f.specPath,owner}));
  const previous=process.env.STNL_OPERATION_OWNER_FILE;
  process.env.STNL_OPERATION_OWNER_FILE=ownerFile;
  try {return await action();}
  finally {if(previous===undefined) delete process.env.STNL_OPERATION_OWNER_FILE;
    else process.env.STNL_OPERATION_OWNER_FILE=previous;}
}

const activeFinding=`### finding-01

- Severity: blocking
- State: active
- Origin: attempt-01
- Problem: The reviewed result needs an explicit independent semantic confirmation.
- Evidence: The prepared command passed but the semantic review requested correction.
- Impact: AC-001 remains unresolved.
- Related authority: AC-001 and slice-01
- Expected correction: Recheck the prepared result and resolve this finding.`;

export async function nativeFindingCycle(test,{fileless=false,activeAdvisoryAfterPass=false}={}) {
  const seeded=await nativeFilePass(test,{stopAfterImplementation:true,fileless});
  const {f}=seeded;
  const advisory=activeFinding.replace('finding-01','finding-02')
    .replace('- Severity: blocking','- Severity: advisory')
    .replace('AC-001 remains unresolved.','A follow-up observation is recommended.');
  async function formal(status,findings,dispositions,references='finding-01') {
    const installed=await readExecutionActivation(f.specPath);
    const admission=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',installed.activation.activationId);
    return withOwner(f,admission.owner,async()=>{
      const start=await nativeStart(f,admission.owner);
      const parent=await fs.mkdtemp(path.join(f.root,'l26-finding-formal-'));
      f.test?.after(()=>fs.rm(parent,{recursive:true,force:true}));
      const copy=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:admission.owner});
      if(findings!==null) await fs.writeFile(path.join(copy.candidateExecutionRoot,'tasks/slice-01.md'),
        updateSection(await fs.readFile(path.join(copy.candidateExecutionRoot,'tasks/slice-01.md'),'utf8'),
          'Validation Findings',findings));
      const recipe=await readRunnerVerification(f.specPath,'slice-01');
      const response={status,head:'offline-working-tree',commands:recipe.checks.map(check=>
        ({command:verificationCommand(check),exit:0})),
        evidence:'Prepared assertion executed; independent semantic finding is a declared offline stimulus.',
        findingReferences:references,findingDispositions:dispositions,
        blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve formal finding history'};
      const round=await nativeRound(start,response);
      const prepared=await prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,
        candidateExecutionRoot:copy.candidateExecutionRoot,...round.captured});
      assert.equal(prepared.formalStatus,status);
      const publication=await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',
        candidateExecutionRoot:copy.candidateExecutionRoot,owner:admission.owner});
      assert.equal(publication.publication,'confirmed');
      return {admission,round,publication};
    });
  }
  await formal('NEEDS_FIX',activeAdvisoryAfterPass?`${activeFinding}\n\n${advisory}`:activeFinding,
    activeAdvisoryAfterPass?'finding-01=active, finding-02=active':'finding-01=active',
    activeAdvisoryAfterPass?'finding-01, finding-02':'finding-01');
  const afterNeedsFix=await captureLegacy(f,{controls:await continuityControls(f)});
  const installed=await readExecutionActivation(f.specPath);
  const apply=await beginPreparedExecutionOperation(f.specPath,'APPLY_FINDINGS','1',installed.activation.activationId);
  const start=await nativeStart(f,apply.owner);
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:apply.owner});
  f.test?.after(()=>fs.rm(copy.candidateRoot,{recursive:true,force:true}));
  const target=path.join(f.root,'src/greeting.test.mjs');
  if(!fileless) await fs.appendFile(target,'// reviewed semantic recheck\n');
  const claim=fileless?null:path.relative(path.join(f.execution,'tasks'),target).split(path.sep).join('/');
  await fs.writeFile(copy.candidateTaskArtifact,updateSection(
    await fs.readFile(copy.candidateTaskArtifact,'utf8'),'Corrections Applied',fileless?'- none':`- \`${claim}\``));
  const recipe=await readRunnerVerification(f.specPath,'slice-01');
  const response={status:'TESTS_PASS',automaticCheckRound:'1/3',head:'offline-working-tree',
    discoverySources:'approved Task and active finding',discoveryActions:'rechecked the prepared assertion',
    verificationTypesConsidered:'prepared Node assertion',nonApplicabilityRationale:'none',
    noVerificationCommandConfirmation:'none',commands:recipe.checks.map(check=>({command:verificationCommand(check),exit:0})),
    resultOfEachCommandAndExitCode:'Prepared assertion exited 0',selectedChecks:verificationCommand(recipe.checks[0]),
    selectionRationale:'Recheck AC-001 export',coverage:'AC-001 export value',failures:'none',
    evidenceOrFailureSummary:fileless?'Prepared arithmetic command rechecked':'Prepared assertion rechecked hello',
    affectedFilesOrBehaviors:fileless?'No product file changed':'greeting assertion',
    blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve concluded findings check',
    findingsCycle:'attempt-01',findingsVerified:'finding-01',
    correctionsCovered:fileless?'Reconciled semantic evidence without product file changes':'Reviewed assertion updated within the authorized area',
    regressionsSelected:fileless?'Prepared literal arithmetic check':'Prepared exact greeting assertion',
    unsupportedActiveFindings:activeAdvisoryAfterPass?'finding-02':'none',
    ...(fileless?{filelessReason:'The approved result is a literal arithmetic check with no product files.'}:{} )};
  const applyRound=await nativeRound(start,response,fileless?[]:null);
  const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'APPLY_FINDINGS',
    response:JSON.stringify(response),workspace:f.root,taskArtifact:copy.candidateTaskArtifact,...applyRound.captured});
  await insertExecutionEvidenceInCandidate({taskArtifact:copy.candidateTaskArtifact,operation:'APPLY_FINDINGS',bundle,
    validateProspectiveTask:text=>validateExecutionCandidate(f.specPath,copy.candidateExecutionRoot,[text])});
  const applyPublication=await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:copy.candidateRoot});
  assert.equal(applyPublication.publication,'confirmed');
  const afterApply=await captureLegacy(f,{controls:await continuityControls(f)});
  assert.match(afterApply.source.files.get('tasks/slice-01.md').toString('utf8'),/- State: active/u);
  const resolved=activeFinding.replace('- State: active','- State: resolved')
    +'\n- Resolution: attempt-02 verified the reviewed correction.';
  const finalFindings=activeAdvisoryAfterPass?`${resolved}\n\n${advisory}`:resolved;
  const last=await formal('PASS',finalFindings,activeAdvisoryAfterPass
    ?'finding-01=resolved, finding-02=active':'finding-01=resolved',activeAdvisoryAfterPass
      ?'finding-01, finding-02':'finding-01');
  let final;
  if(fileless) final=await nativeFilelessImportedInput(f,seeded.initialBoundary,last.round,last.publication);
  else {
    const closed=await nativeBoundary(f,last.round,last.publication);
    final=await captureLegacy(f,{controls:closed.controls,imports:[{slice:'slice-01',
      implementation:[],validation:null,objects:new Map(),boundary:closed.boundary}]});
  }
  return {f,afterNeedsFix,afterApply,final,last};
}

// File-backed S2 is an operational positive: no fixture edits activation,
// receipt, tested manifest, owner, publication marker or historical file mode.
export async function nativeFilePass(test,{stopAfterImplementation=false,fileless=false,existing=null,form='standalone',absentForecast=false}={}) {
  const f=existing??await fixture({test,fileless,form});
  assert.equal(f.fileless,fileless);
  if(absentForecast) {
    assert.equal(fileless,true);assert.equal(existing,null);
    const forecast=path.relative(path.join(f.execution,'tasks'),path.join(f.root,'src/optional.mjs')).split(path.sep).join('/');
    for(const directory of ['plans','tasks']) {
      const file=path.join(f.candidate,directory,'slice-01.md');
      await fs.writeFile(file,setPreparationSection(await fs.readFile(file,'utf8'),'Expected Files',`- \`${forecast}\``));
    }
    await fs.rmdir(path.join(f.root,'src'));
  }
  const initial=existing?await readExecutionActivation(f.specPath):await approveFixture(f);
  const implemented=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',initial.activation.activationId);
  const firstStart=await nativeStart(f,implemented.owner);
  const copy=await prepareExecutionCopy({specPath:f.specPath,slice:'slice-01',owner:implemented.owner});
  f.test?.after(()=>fs.rm(copy.candidateRoot,{recursive:true,force:true}));
  const modulePath=path.join(f.root,'src/unpredicted.mjs');
  const testPath=path.join(f.root,'src/greeting.test.mjs');
  if(!fileless) {
    await fs.writeFile(modulePath,'export const greeting="hello";\n');
    await fs.writeFile(testPath,'import test from "node:test";import assert from "node:assert/strict";import {greeting} from "./unpredicted.mjs";test("AC-001",()=>assert.equal(greeting,"hello"));\n');
  }
  const changed=fileless?[]:[modulePath,testPath].map(name=>path.relative(path.join(f.execution,'tasks'),name).split(path.sep).join('/')).sort(order);
  let task=await fs.readFile(copy.candidateTaskArtifact,'utf8');
  task=task.replace('- [ ] 1.1','- [x] 1.1');
  task=updateSection(task,'Changed Areas',fileless?'- none':changed.map(name=>`- \`${name}\``).join('\n'));
  task=updateSection(task,'Diff Summary',fileless
    ?'- Completed the prepared arithmetic check without product file changes.'
    :'- Implemented the approved greeting with its prepared assertion.');
  await fs.writeFile(copy.candidateTaskArtifact,task);
  const firstRecipe=await readRunnerVerification(f.specPath,'slice-01');
  const command=verificationCommand(firstRecipe.checks[0]);
  const implementationResponse={status:'TESTS_PASS',automaticCheckRound:'1/3',head:'offline-working-tree',
    discoverySources:'approved Task and prepared assertion',discoveryActions:'checked the declared greeting result',
    verificationTypesConsidered:'prepared Node assertion',nonApplicabilityRationale:'none',
    noVerificationCommandConfirmation:'none',commands:[{command,exit:0}],resultOfEachCommandAndExitCode:'Prepared assertion exited 0',
    selectedChecks:command,selectionRationale:'Observe AC-001 export',coverage:'AC-001 export value',failures:'none',
    priorRoundFailure:'none',correctionApplied:'none',inSliceRationale:'none',
    evidenceOrFailureSummary:fileless?'Prepared arithmetic command exited zero':'Prepared assertion observed hello',
    affectedFilesOrBehaviors:fileless?'No product file changed':'greeting module and assertion',
    blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve concluded native check',
    ...(fileless?{filelessReason:'The approved result is a literal arithmetic check with no product files.'}:{} )};
  const first=await nativeRound(firstStart,implementationResponse,changed);
  const bundle=await serializeRunnerExecutionBundleFromResponse({operation:'EXECUTE_SLICE',
    response:JSON.stringify(implementationResponse),workspace:f.root,taskArtifact:copy.candidateTaskArtifact,...first.captured});
  await insertExecutionEvidenceInCandidate({taskArtifact:copy.candidateTaskArtifact,operation:'EXECUTE_SLICE',bundle,
    validateProspectiveTask:text=>validateExecutionCandidate(f.specPath,copy.candidateExecutionRoot,[text])});
  const implementationPublication=await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:copy.candidateRoot});
  assert.equal(implementationPublication.publication,'confirmed');
  const initialBoundary=fileless?await nativeBoundary(f,first,implementationPublication):null;
  if(stopAfterImplementation) return {f,implemented,first,implementationPublication,initialBoundary};

  const {formal,formalRound,formalPublication,boundary,controls}=await nativeFormalPass(f,fileless);
  if(fileless) {
    const input=await nativeFilelessImportedInput(f,initialBoundary,formalRound,formalPublication);
    return {f,input,implemented,first,implementationPublication,formal,formalRound,formalPublication};
  }
  const input=await captureLegacy(f,{controls,imports:[{slice:'slice-01',implementation:[],validation:null,
    objects:new Map(),boundary}]});
  return {f,input,implemented,first,implementationPublication,formal,formalRound,formalPublication};
}

async function nativeFormalPass(f,fileless=false) {
  const installed=await readExecutionActivation(f.specPath);
  assert.equal(installed.activation.activeAttempt,null);
  const formal=await beginPreparedExecutionOperation(f.specPath,'VALIDATE_SLICE','1',installed.activation.activationId);
  const ownerFile=path.join(f.root,'l26-formal-owner.json');
  await fs.writeFile(ownerFile,JSON.stringify({specPath:f.specPath,owner:formal.owner}));
  const previous=process.env.STNL_OPERATION_OWNER_FILE;
  process.env.STNL_OPERATION_OWNER_FILE=ownerFile;
  let formalRound,formalPublication;
  try {
    const formalStart=await nativeStart(f,formal.owner);
    const parent=await fs.mkdtemp(path.join(f.root,'l26-formal-'));
    const candidate=await prepareValidationCopy({specPath:f.specPath,slice:'slice-01',candidateParent:parent,owner:formal.owner});
    f.test?.after(()=>fs.rm(parent,{recursive:true,force:true}));
    const formalRecipe=await readRunnerVerification(f.specPath,'slice-01');
    const formalCommand=verificationCommand(formalRecipe.checks[0]);
    const response={status:'PASS',head:'offline-working-tree',commands:[{command:formalCommand,exit:0}],
      evidence:fileless?'Prepared literal Node arithmetic check executed; independent semantic judgment is a declared offline stimulus.'
        :'Prepared Node assertion executed; independent semantic judgment is a declared offline stimulus.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',
      persistenceSummary:'Preserve concluded formal PASS'};
    formalRound=await nativeRound(formalStart,response);
    const prepared=await prepareValidationCandidate({specPath:f.specPath,slice:'slice-01',workspace:f.root,
      candidateExecutionRoot:candidate.candidateExecutionRoot,...formalRound.captured});
    assert.equal(prepared.formalStatus,'PASS');
    formalPublication=await publishValidationCandidate({specPath:f.specPath,slice:'slice-01',
      candidateExecutionRoot:candidate.candidateExecutionRoot,owner:formal.owner});
  } finally {
    if(previous===undefined) delete process.env.STNL_OPERATION_OWNER_FILE;
    else process.env.STNL_OPERATION_OWNER_FILE=previous;
  }
  assert.equal(formalPublication.publication,'confirmed');
  const terminal=await readExecutionActivation(f.specPath);
  assert.equal(terminal.activation.activeAttempt,null);
  assert.equal(terminal.activation.lastAttempt.operationAttemptId,formal.owner.operationAttemptId);
  const {boundary,controls}=await nativeBoundary(f,formalRound,formalPublication);
  return {formal,formalRound,formalPublication,boundary,controls};
}

// A real implementation check is retained by REPLAN. The admitted formal
// validation closes the revised delivery without inventing a second check.
export async function nativeHistoricalHighWater(test) {
  const first=await nativeFilePass(test,{stopAfterImplementation:true});
  const {f}=first;
  const previous=JSON.parse(await fs.readFile(path.join(f.execution,'approved-preparation.json')));
  await fs.appendFile(f.specPath,'\nDocumentary clarification: the approved greeting remains the same delivery.\n');
  f.authority=await computeRequirementsAuthority(f.specPath);
  const replan=await prepareFixtureCandidate(f,'REPLAN',{revisionMode:'same-delivery-revision'});
  await editPreparation(replan,'plan.md',text=>setPreparationSection(text.replace('- Review state: approved',
    '- Review state: approved\n- Replan reason: Preserve the greeting under clarified requirements.'),
    'Delivery Continuity',sameContinuity(previous,'Preserve the greeting under clarified requirements.')));
  await normalizePreparation(f,replan);
  const draft=await publishFixtureCandidate(f,replan);
  const markerBytes=await fs.readFile(draft.allocation),marker=JSON.parse(markerBytes);
  const snapshotPath=marker.retention.retainedPaths.find(item=>path.basename(item.path)==='slice-01-snapshot.json')?.path;
  assert.ok(snapshotPath,'producer-retained selector snapshot');
  const snapshotBytes=await fs.readFile(snapshotPath);
  assert.ok(marker.retention.retainedPaths.some(item=>item.path===snapshotPath && item.sha256===sha(snapshotBytes)));
  const witness={revision:1,allocationRef:{path:path.relative(f.execution,draft.allocation).split(path.sep).join('/'),
    allocationId:marker.allocationId,sha256:sha(Buffer.from(JSON.stringify(marker.retention)))},
  snapshotRef:{path:path.relative(f.execution,snapshotPath).split(path.sep).join('/'),sha256:sha(snapshotBytes)}};
  const review=await prepareFixtureCandidate(f,'REVIEW_PLAN');
  await reviewFixtureCandidate(f,review);
  const {formal,formalRound,formalPublication,boundary,controls:formalControls}=await nativeFormalPass(f);
  const controls=new Map(formalControls);
  controls.set(draft.allocation,markerBytes);controls.set(snapshotPath,snapshotBytes);
  const input=await captureLegacy(f,{controls,selectorHistory:[witness],imports:[{slice:'slice-01',
    implementation:[],validation:null,objects:new Map(),boundary}]});
  const continuity=JSON.parse(input.source.files.get('continuity.json'));
  assert.equal(continuity.deliveries[0].history.length,1,'producer retained first revision task');
  return {f,input,first,formal,formalRound,formalPublication,witness,history:continuity.deliveries[0].history[0]};
}

async function nativeFilelessImportedInput(f,initialBoundary,formalRound,formalPublication) {
  const {boundary,controls}=await nativeBoundary(f,formalRound,formalPublication);
    assert.ok(initialBoundary?.boundary && initialBoundary?.controls,'captured auxiliary native closure');
    const combined=new Map([...initialBoundary.controls,...controls]);
    const officialTask=await fs.readFile(path.join(f.execution,'tasks/slice-01.md'),'utf8');
    const approvedBytes=await fs.readFile(path.join(f.execution,'approved-preparation.json'));
    const old=JSON.parse(approvedBytes),oldLeaf=old.normativeProjection.deliveries[0];
    const plan=oldLeaf.plan,taskNorm=oldLeaf.task;
    const leaf={deliveryId:oldLeaf.deliveryId,objectiveAndObservableResult:plan['Objective and Observable Result'],
      requirements:plan.Requirements,includedScope:plan['Included Scope'],
      outOfScopeAndBoundaries:plan['Out of Scope and Boundaries'],authorizedAreas:plan['Authorized Areas'],
      existingInputs:plan['Existing Inputs'],protectedResponsibilities:plan['Protected Responsibilities'],
      dependencies:[],risksAndStrategy:plan['Risks and Strategy'],expectedTests:plan['Expected Tests'],
      verificationRecipe:JSON.parse(plan['Verification Recipe'].slice('- Recipe: '.length)),
      completionCriterion:plan['Completion Criterion'],taskResult:taskNorm.Result,obligations:oldLeaf.obligations};
    const contract={delivery:leaf,context:{requirementsAuthority:`sha256:${f.authority}`,
      objective:old.normativeProjection.global.Objective,strategy:old.normativeProjection.global.Strategy,
      risks:old.normativeProjection.risks},terminal:null,recipe:leaf.verificationRecipe};
    const objects=new Map();
    const put=bytes=>{const id=sha(bytes);objects.set(id,bytes);return id;};
    put(approvedBytes);
    const record=(kind,capture)=>{
      const {round,boundary:link,controls:raws}=capture;
      const heading=kind==='validation'?'Validation Attempts':'Implementation Test Evidence';
      const marker=`## ${heading}\n\n`,at=officialTask.indexOf(marker)+marker.length;
      assert.ok(at>=marker.length);
      const end=officialTask.indexOf('\n## ',at);
      const section=officialTask.slice(at,end<0?undefined:end).trim();
      const recordUtf8=section.split(/(?=^### [a-z-]+-[0-9]{2,}$)/mu).map(item=>item.trim()).filter(Boolean).at(-1);
      const id=/^### ([a-z-]+-[0-9]{2,})$/mu.exec(recordUtf8)?.[1];
      assert.ok(id);
      const read=name=>{const bytes=raws.get(name);assert.ok(bytes,`${name}: captured raw`);return bytes.toString('utf8');};
      const receipt=JSON.parse(read(link.receiptPath));
      const origin=JSON.parse(read(link.originPath));
      const manifest=JSON.parse(read(link.manifestPath));
      assert.equal(manifest.entries.some(item=>item.kind==='file'),false,'fileless producer manifest');
      const testedWork={format:'stnl-current-work-v1',entries:manifest.entries.filter(item=>item.kind!=='absent'
        || !manifest.entries.some(parent=>parent.path!==item.path && item.path.startsWith(`${parent.path}/`)
          && ['absent','directory'].includes(parent.kind))).map(item=>item.kind==='directory'
        ?{path:item.path,kind:'directory',children:manifest.entries.filter(child=>child.kind!=='absent'
          && path.posix.dirname(child.path)===item.path).map(child=>path.posix.basename(child.path)).sort(order)}
        :{path:item.path,kind:'absent'}).sort((a,b)=>order(a.path,b.path))};
      const source={transport:'native',rawResponse:put(raws.get(link.responsePath)),
        receipt:put(raws.get(link.receiptPath)),verificationObservation:put(raws.get(link.observationPath)),
        origin:put(Buffer.from(JSON.stringify({format:'stnl-native-imported-origin-bundle-v1',
          originUtf8:read(link.originPath),dispatchUtf8:read(link.closure.dispatchPath),
          workManifestUtf8:read(link.manifestPath),publicationUtf8:read(link.publicationPath)})+'\n')),
        agentBinding:put(Buffer.from(JSON.stringify({format:'stnl-native-agent-bundle-v1',
          agentUtf8:read(link.closure.agentPath),claimUtf8:read(link.closure.claimPath)})+'\n')),
        concludedToolResult:put(raws.get(link.closure.resultPath)),removalProofs:[],
        legacyPreparation:sha(approvedBytes)};
      return {kind,recordFormat:'stnl-task-record-v1-imported',id,
        origin:{operationAttemptId:receipt.owner.operationAttemptId,deliveryId:receipt.owner.deliveryId,
          slice:receipt.slice,operation:receipt.operation,preparationRevision:receipt.owner.preparationRevision,
          localRevision:null,normativeSha256:receipt.owner.normativeSha256,
          originActivationId:receipt.owner.originActivationId,transport:'native',
          dispatchId:origin.dispatchId,runnerId:receipt.threadId},
        contract,recordUtf8,testedWork,sources:source};
    };
    const implementation=record('implementation-check',{boundary:initialBoundary.boundary,controls:initialBoundary.controls});
    const validation=record('validation',{round:formalRound,boundary,controls});
    const input=await captureLegacy(f,{controls:combined,imports:[{slice:'slice-01',implementation:[implementation],
      validation,objects,boundary:null}]});
    return input;
}

export async function managedBlockedAfterNativeFile(test) {
  const seeded=await nativeFilePass(test,{stopAfterImplementation:true});
  const {f}=seeded;
  const checks=(await readRunnerVerification(f.specPath,'slice-01')).checks;
  const response={status:'BLOCKED',head:'offline-working-tree',
    commands:checks.map(check=>({command:verificationCommand(check),exit:0})),
    evidence:'Prepared assertion executed; independent semantic BLOCKED is an offline stimulus.',
    findingReferences:'none',findingDispositions:'none',blockers:'Controlled unavailable semantic prerequisite',
    unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve blocked formal reassessment'};
  const produced=await withManagedExample(f,'VALIDATE_SLICE',response,async managed=>{
    const receipt=await managed.dispatch('Validate the reviewed greeting and report the blocked premise.');
    assert.equal(receipt.status,'RUNNER_RESPONSE_CAPTURED');
    const finalized=await managed.finalize();
    assert.equal(finalized.published,true);
    return {receipt,finalized,tmpdir:managed.tmpdir,context:managed.context};
  });
  const terminal=await readExecutionActivation(f.specPath);
  assert.equal(terminal.activation.activeAttempt,null);
  assert.equal(terminal.activation.lastAttempt.operationAttemptId,produced.context.owner.operationAttemptId);
  assert.equal(produced.finalized.publication.status,'confirmed');
  const controls=await continuityControls(f);
  const input=await captureLegacy(f,{controls});
  return {...seeded,produced,input};
}

export async function managedMalformedOwnerActive(test) {
  const seeded=await nativeFilePass(test,{stopAfterImplementation:true});
  const {f}=seeded;
  const produced=await withManagedExample(f,'VALIDATE_SLICE','{ invalid final response',async managed=>{
    const receipt=await managed.dispatch('Validate the reviewed greeting.');
    assert.equal(receipt.status,'RUNNER_RESULT_BLOCKED');
    assert.equal(receipt.captureFailureCode,'RUNNER_RESPONSE_SCHEMA_INVALID');
    const finalized=await managed.finalize();
    return {receipt,finalized,context:managed.context};
  });
  const activation=await readExecutionActivation(f.specPath);
  assert.equal(activation.activation.activeAttempt.operationAttemptId,produced.context.owner.operationAttemptId);
  const input=await captureLegacy(f);
  return {...seeded,produced,input};
}

async function continuityControls(f) {
  const controls=new Map();
  const continuity=await readJson(path.join(f.execution,'continuity.json'));
  for(const delivery of continuity.deliveries) {
    const refs=[delivery.baseline?.allocationRef?.path,delivery.baseline?.manifestRef?.path,
      ...delivery.history.flatMap(item=>[item.allocationRef.path,item.taskRef.path,item.snapshotRef.path])].filter(Boolean);
    for(const ref of refs) {
      const absolute=path.resolve(f.execution,ref);
      controls.set(absolute,await fs.readFile(absolute));
    }
  }
  return controls;
}

async function nativeBoundary(f,round,publication) {
  const controls=new Map();
  const add=async name=>{assert.ok(path.isAbsolute(name) && path.normalize(name)===name);
    controls.set(name,await fs.readFile(name));return name;};
  const originPath=await add(round.start.originFile),root=path.dirname(originPath);
  const receiptPath=await add(round.captured.receiptFile);
  const responsePath=await add(round.captured.semanticResponseFile);
  const observationPath=await add(path.join(root,`round-${round.start.attempt}.verification.json`));
  const publicationPath=await add(publication.allocation);
  const marker=JSON.parse(controls.get(publicationPath));
  assert.equal(marker.format,'stnl-execution-publication-owner-v1');
  assert.equal(marker.confirmation.terminalOperationAttemptId,round.start.owner.operationAttemptId);
  const manifests=[];
  for(const row of marker.retention.retainedPaths) {
    if(!row.path.endsWith('.json')) continue;
    const bytes=await fs.readFile(row.path);
    let value;try {value=JSON.parse(bytes);}catch {continue;}
    if(value.format==='stnl-work-continuation-v1' && value.operationAttemptId===round.start.owner.operationAttemptId)
      manifests.push({path:row.path,bytes,value});
  }
  assert.equal(manifests.length,1,'one producer-retained formal tested manifest');
  const manifestPath=manifests[0].path;
  controls.set(manifestPath,manifests[0].bytes);
  for(const entry of manifests[0].value.entries) if(entry.kind==='file') await add(entry.storedPath);
  const dispatchPath=await add(path.join(root,'owner.json'));
  const agentPath=await add(path.join(root,`round-${round.start.attempt}.agent.json`));
  const resultPath=await add(path.join(root,`round-${round.start.attempt}.tool-result.json`));
  const runnerMarker=await readJson(`${root}.publication.json`);
  const agentHash=createHash('sha256').update(round.agentId).digest('hex');
  const claims=(runnerMarker.controlFiles??[]).filter(name=>name.endsWith(`.native-agent-${agentHash}.json`));
  assert.equal(claims.length,1,'one producer-linked native claim');
  const claimPath=await add(claims[0]);
  for(const [name,bytes] of await continuityControls(f)) controls.set(name,bytes);
  return {controls,boundary:{transport:'native',receiptPath,responsePath,observationPath,manifestPath,
    publicationPath,originPath,closure:{dispatchPath,agentPath,claimPath,resultPath}}};
}

// The broker removes active.json at close. Its real bytes are retained in the
// capture before close, while the supervisor is read only after close.
async function managedBoundary(f,produced) {
  const controls=new Map([[produced.activePath,produced.activeBytes]]);
  const add=async name=>{assert.ok(path.isAbsolute(name) && path.normalize(name)===name);
    controls.set(name,await fs.readFile(name));return name;};
  const {receipt,tmpdir,finalized,context}=produced;
  const stem=`${String(receipt.sequence).padStart(3,'0')}-${receipt.operation.toLowerCase()}-${receipt.slice}-attempt-${receipt.attempt}`;
  const receiptPath=await add(receipt.receiptFile);
  const responsePath=await add(receipt.semanticResponseFile);
  const observationPath=await add(path.join(tmpdir,`${stem}.verification.json`));
  const publicationPath=await add(finalized.publication.allocation);
  const marker=JSON.parse(controls.get(publicationPath));
  assert.equal(marker.confirmation.terminalOperationAttemptId,context.owner.operationAttemptId);
  const manifests=[];
  for(const row of marker.retention.retainedPaths) {
    if(!row.path.endsWith('.json')) continue;
    const bytes=await fs.readFile(row.path);
    let value;try {value=JSON.parse(bytes);}catch {continue;}
    if(value.format==='stnl-work-continuation-v1' && value.operationAttemptId===context.owner.operationAttemptId)
      manifests.push({path:row.path,bytes,value});
  }
  assert.equal(manifests.length,1,'one producer-retained managed tested manifest');
  const manifestPath=manifests[0].path;
  controls.set(manifestPath,manifests[0].bytes);
  for(const entry of manifests[0].value.entries) if(entry.kind==='file') await add(entry.storedPath);
  const startedPath=await add(path.join(tmpdir,`${stem}.started.json`));
  const eventsPath=await add(receipt.eventsPath);
  const broker=path.join(tmpdir,'stnl-runner-broker');
  const sequence=String(receipt.sequence).padStart(3,'0');
  const supervisorPath=await add(path.join(broker,`${sequence}.supervisor.json`));
  const latestPath=await add(path.join(broker,`${sequence}.latest.json`));
  const runtimeIdentityPaths=[];
  for(const item of Object.values(context.identity)) if(item?.sha256) {
    if(!controls.has(item.path)) await add(item.path);
    runtimeIdentityPaths.push(item.path);
  }
  runtimeIdentityPaths.sort((a,b)=>order(sha(controls.get(a)),sha(controls.get(b))));
  const uniqueRuntimeIdentityPaths=[...new Map(runtimeIdentityPaths.map(name=>[sha(controls.get(name)),name])).values()];
  for(const [name,bytes] of await continuityControls(f)) controls.set(name,bytes);
  return {controls,managedContexts:new Map([[context.owner.operationAttemptId,produced.contextBytes]]),
    boundary:{transport:'managed',receiptPath,responsePath,observationPath,manifestPath,publicationPath,
      managedContextId:context.owner.operationAttemptId,closure:{activePath:produced.activePath,
        startedPath,eventsPath,supervisorPath,latestPath,runtimeIdentityPaths:uniqueRuntimeIdentityPaths}}};
}

export async function managedFilePass(test,{form='standalone'}={}) {
  const seeded=await nativeFilePass(test,{stopAfterImplementation:true,form});
  const {f}=seeded;
  const checks=(await readRunnerVerification(f.specPath,'slice-01')).checks;
  const response={status:'PASS',head:'offline-working-tree',
    commands:checks.map(check=>({command:verificationCommand(check),exit:0})),
    evidence:'Prepared Node assertion executed; independent semantic PASS is a declared offline stimulus.',
    findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',
    persistenceSummary:'Preserve concluded managed formal PASS'};
  const produced=await withManagedExample(f,'VALIDATE_SLICE',response,async managed=>{
    const activePath=path.join(managed.tmpdir,'stnl-runner-broker','active.json');
    const activeBytes=await fs.readFile(activePath);
    const contextBytes=Buffer.from(managed.environment.STNL_MANAGED_CONTEXT,'utf8');
    assert.equal(JSON.parse(contextBytes).owner.operationAttemptId,managed.context.owner.operationAttemptId);
    const receipt=await managed.dispatch('Validate the reviewed greeting and report the result.');
    assert.equal(receipt.status,'RUNNER_RESPONSE_CAPTURED');
    const finalized=await managed.finalize();
    assert.equal(finalized.published,true);
    return {receipt,finalized,tmpdir:managed.tmpdir,context:managed.context,contextBytes,activePath,activeBytes};
  });
  const terminal=await readExecutionActivation(f.specPath);
  assert.equal(terminal.activation.activeAttempt,null);
  assert.equal(terminal.activation.lastAttempt.operationAttemptId,produced.context.owner.operationAttemptId);
  const capture=await managedBoundary(f,produced);
  const input=await captureLegacy(f,{controls:capture.controls,managedContexts:capture.managedContexts,
    imports:[{slice:'slice-01',implementation:[],validation:null,objects:new Map(),boundary:capture.boundary}]});
  return {...seeded,produced,input};
}

export async function managedFilelessPass(test,{form='standalone'}={}) {
  const f=await fixture({test,fileless:true,form});
  await approveFixture(f);
  const filelessReason='The approved result is a literal arithmetic check with no product files.';
  const recipe=await readRunnerVerification(f.specPath,'slice-01');
  const commands=recipe.checks.map(check=>({command:verificationCommand(check),exit:0}));
  const implementationResponse={status:'TESTS_PASS',automaticCheckRound:'1/3',head:'offline-working-tree',
    discoverySources:'approved Task and literal arithmetic recipe',
    discoveryActions:'checked the declared arithmetic result',verificationTypesConsidered:'prepared Node expression',
    nonApplicabilityRationale:'none',noVerificationCommandConfirmation:'none',commands,
    resultOfEachCommandAndExitCode:'Prepared arithmetic expression exited 0',
    selectedChecks:commands[0].command,selectionRationale:'Observe AC-001 command exit',coverage:'AC-001 exit zero',
    failures:'none',priorRoundFailure:'none',correctionApplied:'none',inSliceRationale:'none',
    evidenceOrFailureSummary:'Prepared arithmetic command exited zero',affectedFilesOrBehaviors:'No product file changed',
    blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Preserve concluded managed check',
    filelessReason};
  const first=await withManagedExample(f,'EXECUTE_SLICE',implementationResponse,async managed=>{
      const activePath=path.join(managed.tmpdir,'stnl-runner-broker','active.json');
      const activeBytes=await fs.readFile(activePath);
      const contextBytes=Buffer.from(managed.environment.STNL_MANAGED_CONTEXT,'utf8');
      let task=await fs.readFile(managed.copy.candidateTaskArtifact,'utf8');
      task=updateSection(task.replace('- [ ] 1.1','- [x] 1.1'),'Changed Areas','- none');
      task=updateSection(task,'Diff Summary','- Completed the prepared arithmetic check without product file changes.');
      await fs.writeFile(managed.copy.candidateTaskArtifact,task);
      const receipt=await managed.dispatch({automaticCheckRound:'1/3',changedAreas:[],filelessReason});
      assert.equal(receipt.status,'RUNNER_RESPONSE_CAPTURED');
      const finalized=await managed.finalize();
      assert.equal(finalized.published,true);
      return {receipt,finalized,context:managed.context,contextBytes,activePath,activeBytes,tmpdir:managed.tmpdir};
    });
  const firstCapture=await managedBoundary(f,first);
  const formalResponse={status:'PASS',head:'offline-working-tree',commands,
      evidence:'Prepared literal Node arithmetic check executed; independent semantic judgment is a declared offline stimulus.',
      findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',
      persistenceSummary:'Preserve concluded managed formal PASS'};
  const formal=await withManagedExample(f,'VALIDATE_SLICE',formalResponse,async managed=>{
      const activePath=path.join(managed.tmpdir,'stnl-runner-broker','active.json');
      const activeBytes=await fs.readFile(activePath);
      const contextBytes=Buffer.from(managed.environment.STNL_MANAGED_CONTEXT,'utf8');
      const receipt=await managed.dispatch('Validate the reviewed arithmetic result.');
      assert.equal(receipt.status,'RUNNER_RESPONSE_CAPTURED');
      const finalized=await managed.finalize();
      assert.equal(finalized.published,true);
      return {receipt,finalized,context:managed.context,contextBytes,activePath,activeBytes,tmpdir:managed.tmpdir};
  });
  const terminal=await readExecutionActivation(f.specPath);
  assert.equal(terminal.activation.activeAttempt,null);
  assert.equal(terminal.activation.lastAttempt.operationAttemptId,formal.context.owner.operationAttemptId);
  const formalCapture=await managedBoundary(f,formal);
  const controls=new Map([...firstCapture.controls,...formalCapture.controls]);
  const managedContexts=new Map([...firstCapture.managedContexts,...formalCapture.managedContexts]);
  const taskText=await fs.readFile(path.join(f.execution,'tasks/slice-01.md'),'utf8');
  const approvedBytes=await fs.readFile(path.join(f.execution,'approved-preparation.json'));
  const old=JSON.parse(approvedBytes),oldLeaf=old.normativeProjection.deliveries[0],plan=oldLeaf.plan;
  const delivery={deliveryId:oldLeaf.deliveryId,objectiveAndObservableResult:plan['Objective and Observable Result'],
    requirements:plan.Requirements,includedScope:plan['Included Scope'],
    outOfScopeAndBoundaries:plan['Out of Scope and Boundaries'],authorizedAreas:plan['Authorized Areas'],
    existingInputs:plan['Existing Inputs'],protectedResponsibilities:plan['Protected Responsibilities'],
    dependencies:[],risksAndStrategy:plan['Risks and Strategy'],expectedTests:plan['Expected Tests'],
    verificationRecipe:JSON.parse(plan['Verification Recipe'].slice('- Recipe: '.length)),
    completionCriterion:plan['Completion Criterion'],taskResult:oldLeaf.task.Result,obligations:oldLeaf.obligations};
  const contract={delivery,context:{requirementsAuthority:`sha256:${f.authority}`,
    objective:old.normativeProjection.global.Objective,strategy:old.normativeProjection.global.Strategy,
    risks:old.normativeProjection.risks},terminal:null,recipe:delivery.verificationRecipe};
  const objects=new Map(),put=bytes=>{const id=sha(bytes);objects.set(id,bytes);return id;};
  put(approvedBytes);
  const record=(kind,produced,capture)=>{
    const heading=kind==='validation'?'Validation Attempts':'Implementation Test Evidence';
    const marker=`## ${heading}\n\n`,at=taskText.indexOf(marker)+marker.length,end=taskText.indexOf('\n## ',at);
    const recordUtf8=taskText.slice(at,end<0?undefined:end).trim();
    const id=/^### ([a-z-]+-[0-9]{2,})$/mu.exec(recordUtf8)?.[1];assert.ok(id);
    const {boundary:link,controls:raws}=capture;
    const read=name=>{const bytes=raws.get(name);assert.ok(bytes,`${name}: captured raw`);return bytes.toString('utf8');};
    const receipt=JSON.parse(read(link.receiptPath)),manifest=JSON.parse(read(link.manifestPath));
    assert.equal(manifest.entries.some(item=>item.kind==='file'),false,'fileless managed manifest');
    const testedWork={format:'stnl-current-work-v1',entries:manifest.entries.filter(item=>item.kind!=='absent'
        || !manifest.entries.some(parent=>parent.path!==item.path && item.path.startsWith(`${parent.path}/`)
          && ['absent','directory'].includes(parent.kind))).map(item=>item.kind==='directory'
      ?{path:item.path,kind:'directory',children:manifest.entries.filter(child=>child.kind!=='absent'
        && path.posix.dirname(child.path)===item.path).map(child=>path.posix.basename(child.path)).sort(order)}
      :{path:item.path,kind:'absent'}).sort((a,b)=>order(a.path,b.path))};
    const sources={transport:'managed',rawResponse:put(raws.get(link.responsePath)),
      receipt:put(raws.get(link.receiptPath)),verificationObservation:put(raws.get(link.observationPath)),
      started:put(Buffer.from(JSON.stringify({format:'stnl-managed-imported-start-bundle-v1',
        contextUtf8:produced.contextBytes.toString('utf8'),activeUtf8:produced.activeBytes.toString('utf8'),
        startedUtf8:read(link.closure.startedPath),workManifestUtf8:read(link.manifestPath),
        publicationUtf8:read(link.publicationPath)})+'\n')),
      events:put(raws.get(link.closure.eventsPath)),
      closedSupervisor:put(Buffer.from(JSON.stringify({format:'stnl-managed-close-bundle-v1',
        supervisorUtf8:read(link.closure.supervisorPath),latestUtf8:read(link.closure.latestPath)})+'\n')),
      runtimeIdentity:link.closure.runtimeIdentityPaths.map(name=>put(raws.get(name))).sort(order),
      removalProofs:[],legacyPreparation:sha(approvedBytes)};
    return {kind,recordFormat:'stnl-task-record-v1-imported',id,
      origin:{operationAttemptId:receipt.owner.operationAttemptId,deliveryId:receipt.owner.deliveryId,
        slice:receipt.slice,operation:receipt.operation,preparationRevision:receipt.owner.preparationRevision,
        localRevision:null,normativeSha256:receipt.owner.normativeSha256,
        originActivationId:receipt.owner.originActivationId,transport:'managed',
        dispatchId:`${receipt.owner.operationAttemptId}:${receipt.sequence}`,runnerId:receipt.threadId},
      contract,recordUtf8,testedWork,sources};
  };
  const implementation=record('implementation-check',first,firstCapture);
  const validation=record('validation',formal,formalCapture);
  const input=await captureLegacy(f,{controls,managedContexts,imports:[{slice:'slice-01',
    implementation:[implementation],validation,objects,boundary:null}]});
  return {f,input,first,formal};
}


// Two independently approved delivery domains, including a shared input. All
// preparation/continuity bytes come from the real preparation publisher.
export async function disjointDomainS0(test,{roots=['src/first','src/second']}={}) {
  const f=await fixture({test,retiredSelector:true});
  for(const root of roots) await fs.mkdir(path.join(f.root,root),{recursive:true});
  await fs.mkdir(path.join(f.root,'shared'));
  await fs.writeFile(path.join(f.root,'shared/config.json'),'{}\n');
  const local=name=>path.relative(path.join(f.execution,'tasks'),path.join(f.root,name)).split(path.sep).join('/');
  for(const [index,root] of roots.entries()) {
    const recipe={format:'stnl-verification-recipe-v1',base:'workspace',cwd:'.',checks:[{
      id:'verification-01',executable:{literal:'node'},args:[{literal:'-e'},{literal:'if(2+2!==4) process.exit(1)'}],
      inputs:[{kind:'input',path:local('shared/config.json')}]}],dependencyReview:'Shared config is captured; the check uses literal arithmetic.'};
    for(const directory of ['plans','tasks']) {
      const file=path.join(f.candidate,directory,`slice-0${index+1}.md`);
      let content=await fs.readFile(file,'utf8');
      for(const [heading,body] of Object.entries({'Authorized Areas':`- directory: \`${local(root)}\``,
        'Expected Files':'- none','Existing Inputs':`- \`${local('shared/config.json')}\``,
        'Verification Recipe':`- Recipe: ${JSON.stringify(recipe)}`})) content=setPreparationSection(content,heading,body);
      await fs.writeFile(file,content);
    }
  }
  const global=path.join(f.candidate,'plan.md');
  let content=await fs.readFile(global,'utf8');
  content=content.split('\n').map(line=>{
    const index=line.includes('| plans/slice-01.md |')?0:line.includes('| plans/slice-02.md |')?1:-1;
    return index<0?line:line.replace(/directory: `[^`]+`/u,`directory: \`${path.relative(f.execution,path.join(f.root,roots[index])).split(path.sep).join('/')}\``);
  }).join('\n');
  await fs.writeFile(global,content);
  await normalizePreparation(f,f.candidate);
  await approveFixture(f);
  f.observedRoots=[...roots,'shared/config.json'];
  return {f,input:await captureLegacy(f)};
}

export async function nativeAbsentForecast(test) {
  const produced=await nativeFilePass(test,{fileless:true,absentForecast:true});
  const {boundary,controls}=await nativeBoundary(produced.f,produced.formalRound,produced.formalPublication);
  const boundaryInput=await captureLegacy(produced.f,{controls,imports:[{slice:'slice-01',implementation:[],validation:null,
    objects:new Map(),boundary}]});
  return {...produced,boundaryInput};
}
