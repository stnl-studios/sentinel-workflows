import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCurrentJson, validateCurrentCandidate, validateCurrentContinuity,
  validateCurrentEvidence, logicalArtifactPath, resolveLogicalProductClaim } from './execution-current.mjs';
import { projectConversionPreparation, approveConversionPreparation } from './execution-preparation-current.mjs';
import { inspectConvertedExecution, verifyImportedEvidence, verifyLegacyOperationFacts, projectConversionObservedWork } from './execution-evidence-proof.mjs';
import { validateApprovedPreparation, projectPreparationAuthority,
  parsePreparationArtifact, parseVerificationRecipe } from './execution-preparation.mjs';
import { projectCurrentRequirements } from './execution-state.mjs';

// A capture is supplied by the future trusted adapter. This module only compares
// its closed in-memory bytes and identity; it cannot acquire a lock or attest to
// physical quiescence after capture.
const HASH=/^sha256:[a-f0-9]{64}$/u;
const UUID=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const ordinal=(a,b)=>a<b?-1:a>b?1:0;
const raw=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const utf8=value=>Buffer.from(value,'utf8');
function fail(code,message) { const error=new Error(message); error.code=code; throw error; }
const invalid=message=>fail('INVALID_CURRENT_IMAGE',message);
const incomplete=message=>fail('EVIDENCE_INCOMPLETE',message);
const stale=message=>fail('STALE_APPROVAL',message);
const ownerActive=message=>fail('OWNER_ACTIVE',message);
function plain(value,label) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || (Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null)
    || Reflect.ownKeys(value).length!==Object.keys(value).length
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item=>!Object.hasOwn(item,'value') || !item.enumerable))
    invalid(`${label}: ordinary data object required`);
  return value;
}
function exact(value,keys,label) {
  plain(value,label);
  if (Object.keys(value).sort(ordinal).join('\0')!==[...keys].sort(ordinal).join('\0'))
    invalid(`${label}: fields differ`);
  return value;
}
function array(value,label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype
    || Object.keys(value).length!==value.length || Reflect.ownKeys(value).length!==value.length+1
    || Object.entries(Object.getOwnPropertyDescriptors(value)).some(([key,item])=>key!=='length'
      && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || !Object.hasOwn(item,'value') || !item.enumerable)))
    invalid(`${label}: dense array required`);
  return value;
}
function integer(value,label,min=0) {
  if (!Number.isSafeInteger(value) || Object.is(value,-0) || value<min) invalid(`${label}: safe integer required`);
  return value;
}
function bytes(value,label) {
  if (!(value instanceof Uint8Array) || (!Buffer.isBuffer(value)
    && Object.getPrototypeOf(value)!==Uint8Array.prototype)
    || Reflect.ownKeys(value).length!==value.length) invalid(`${label}: bytes required`);
  return Buffer.from(value);
}
function text(value,label) {
  const copy=bytes(value,label);
  let decoded;
  try { decoded=new TextDecoder('utf-8',{fatal:true}).decode(copy); }
  catch { invalid(`${label}: invalid UTF-8`); }
  if (decoded.startsWith('\ufeff') || decoded.includes('\0') || !utf8(decoded).equals(copy))
    invalid(`${label}: noncanonical UTF-8`);
  return decoded;
}
function map(value,label) {
  if (!(value instanceof Map) || Object.getPrototypeOf(value)!==Map.prototype
    || Reflect.ownKeys(value).length) invalid(`${label}: ordinary Map required`);
  const copy=new Map();
  for (const [name,valueBytes] of Map.prototype.entries.call(value)) {
    if (typeof name!=='string' || !name || copy.has(name)) invalid(`${label}: invalid key`);
    copy.set(name,bytes(valueBytes,`${label} ${name}`));
  }
  return copy;
}
function canonical(value) {
  if (value===null || typeof value==='boolean') return String(value);
  if (typeof value==='string') return JSON.stringify(value);
  if (typeof value==='number') return String(integer(value,'canonical'));
  if (Array.isArray(value)) return `[${array(value,'canonical').map(canonical).join(',')}]`;
  plain(value,'canonical');
  return `{${Object.keys(value).sort(ordinal).map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const same=(a,b)=>canonical(a)===canonical(b);
const encoded=value=>utf8(`${canonical(value)}\n`);
function json(file,label) { return parseCurrentJson(text(file,label)); }
function field(body,name) {
  const rows=[...body.matchAll(new RegExp(`^- ${name}: (.+)$`,'gmu'))];
  if (rows.length!==1) incomplete(`${name}: absent or duplicate`);
  return rows[0][1];
}
function commandTuples(body,heading) {
  const marker=[...body.matchAll(new RegExp(`^- ${heading}:$`,'gmu'))];
  if (marker.length!==1) incomplete(`${heading}: missing or duplicate commands`);
  const tail=body.slice(marker[0].index+marker[0][0].length);
  const end=tail.search(/^- [^:\n]+:/mu);
  const lines=(end<0?tail:tail.slice(0,end)).replace(/^\n/u,'').trimEnd().split('\n');
  if (!lines.length || !lines[0]) incomplete(`${heading}: empty commands`);
  return lines.map(line=>{
    const found=/^  - (?:`([^`\r\n]+)`|json:(".*")) \| exit:([-]?[0-9]+)$/u.exec(line);
    if (!found) incomplete(`${heading}: malformed command tuple`);
    const command=found[1]??parseCurrentJson(found[2]);
    const exit=Number(found[3]);
    if (typeof command!=='string' || !command || !Number.isSafeInteger(exit)) incomplete(`${heading}: invalid command`);
    return {command,exit};
  });
}
function sections(source,label) {
  const found=[...source.matchAll(/^## ([^\n]+)\n\n/gmu)];
  if (!found.length || new Set(found.map(item=>item[1])).size!==found.length) invalid(`${label}: sections differ`);
  const result=new Map();
  for (let i=0;i<found.length;i+=1)
    result.set(found[i][1],source.slice(found[i].index+found[i][0].length,found[i+1]?.index).trim());
  return result;
}
function render(source,changes,remove=[]) {
  const markers=[...source.matchAll(/^## ([^\n]+)\n\n/gmu)];
  const header=source.slice(0,markers[0].index);
  const list=markers.filter(item=>!remove.includes(item[1])).map(item=>{
    const next=markers[markers.indexOf(item)+1];
    const body=changes.get(item[1])??source.slice(item.index+item[0].length,next?.index).trim();
    return `## ${item[1]}\n\n${body}\n\n`;
  });
  return header+list.join('');
}
function replaceField(body,name,value) {
  const matcher=new RegExp(`^- ${name}: .+$`,'gmu');
  if ([...body.matchAll(matcher)].length!==1) invalid(`${name}: ambiguous legacy carrier`);
  return body.replace(matcher,`- ${name}: ${value}`);
}
function appendLocalRevision(body) {
  if (/^- Local revision:/mu.test(body)) invalid('legacy local revision is unexpected');
  return body.replace(/(^- Plan revision: [1-9][0-9]*$)/mu,'$1\n- Local revision: 1');
}
function identifiers(taskTexts,section,prefix) {
  const seen=new Map();
  for (const task of taskTexts) {
    for (const body of taskRecords(task,section)) {
      const match=new RegExp(`^### (${prefix}-([0-9]{2,}))\\n`,'u').exec(body);
      if (!match) incomplete(`${prefix}: malformed historical record`);
      const number=Number(match[2]); integer(number,`${prefix} ordinal`,1);
      if (match[2]!==String(number).padStart(2,'0')) invalid(`${prefix}: noncanonical historical ID`);
      const prior=seen.get(number);
      const immutable=text=>text.split('\n').filter(line=>
        !/^- (?:State|Resolution|Superseded by|Resolution slice|Resolution revision):/u.test(line)).join('\n').trim();
      if (prior && (prefix!=='finding' || immutable(prior)!==immutable(body)))
        incomplete(`${prefix}: duplicate or conflicting historical ID`);
      seen.set(number,body);
    }
  }
  const ordinals=[...seen.keys()].sort((a,b)=>a-b);
  for (const [index,number] of ordinals.entries()) if (number!==index+1)
    incomplete(`${prefix}: missing historical ordinal ${index+1}`);
  return ordinals.length;
}
function captureSource(context,requirementsAuthority,source) {
  plain(source,'legacy source');
  exact(source,source.managedContexts===undefined
    ? ['format','requirementsFiles','files','tree','controls','selectorHistory','imports']
    : ['format','requirementsFiles','files','tree','controls','managedContexts','selectorHistory','imports'],'legacy source');
  if (source.format!=='stnl-legacy-conversion-capture-v1') fail('UNSUPPORTED_FORMAT','legacy capture format');
  const requirementsFiles=map(source.requirementsFiles,'captured requirements');
  const projectedRequirements=projectCurrentRequirements({workspace:{
    kind:context.logicalSpecRoot===null?'standalone':'lifecycle',
    specRoot:context.logicalSpecRoot,authorityPath:context.logicalAuthorityPath},files:requirementsFiles});
  if (projectedRequirements.requirementsAuthority!==requirementsAuthority)
    stale('captured documentary authority differs');
  if (context.logicalSpecRoot!==null && projectedRequirements.documentStatus!=='ready')
    stale('lifecycle requirements are not ready');
  const files=map(source.files,'official files'),controls=map(source.controls,'closed controls');
  const managedContexts=map(source.managedContexts??new Map(),'managed contexts');
  for (const [id,value] of managedContexts) {
    if (!UUID.test(id)) invalid('managed context key is not an operation attempt ID');
    const origin=json(value,'managed context');
    if (origin.version!==4 || origin.owner?.operationAttemptId!==id
      || typeof origin.specPath!=='string'
      || !(origin.specPath===context.logicalAuthorityPath || context.logicalSpecRoot!==null && origin.specPath===context.logicalSpecRoot)
      || origin.workspace!==context.productRoot)
      incomplete('managed context bytes or owner differ');
  }
  for (const name of controls.keys()) if (!path.isAbsolute(name) || path.normalize(name)!==name)
    invalid('closed control path is not canonical absolute');
  for (const [name,value] of controls) {
    let parsed;
    try { parsed=parseCurrentJson(text(value,name)); } catch { continue; }
    if (parsed?.format==='stnl-runner-rejection-v1'
      || parsed?.status==='RUNNER_RESULT_BLOCKED'
      || parsed?.status==='RUNNER_REJECTION_CAPTURED')
      incomplete('runner rejection/recovery history requires a separate closed successor proof');
  }
  exact(source.tree,['identity','files'],'legacy tree'); plain(source.tree.identity,'legacy tree identity');
  exact(source.tree.identity,['dev','ino'],'legacy physical root identity');
  if (![source.tree.identity.dev,source.tree.identity.ino].every(value=>typeof value==='string' && /^[0-9]+$/u.test(value)))
    invalid('legacy physical identity');
  const treeFiles=array(source.tree.files,'legacy tree files');
  const expected=new Map(),directories=new Set();
  for (const item of treeFiles) {
    if (item.type==='directory') {
      exact(item,['path','type'],'tree directory');
      if (!['plans','tasks'].includes(item.path) || directories.has(item.path)) invalid('unknown/duplicate legacy directory');
      directories.add(item.path);
      continue;
    }
    exact(item,['path','type','sha256','mode'],'tree file');
    if (item.type!=='file' || !HASH.test(item.sha256) || expected.has(item.path)) invalid('legacy tree file');
    if (!/^(?:activation|approved-preparation|continuity)\.json$|^(?:plan|tasks)\.md$|^(?:plans|tasks)\/slice-[0-9]{2,}\.md$/u.test(item.path))
      invalid('unknown official legacy artifact');
    integer(item.mode,'tree file mode'); expected.set(item.path,item.sha256);
  }
  if (!same([...directories].sort(ordinal),['plans','tasks'])) invalid('legacy directory layout differs');
  if (!same([...expected.keys()].sort(ordinal),[...files.keys()].sort(ordinal)))
    incomplete('official tree is not a closed captured file set');
  for (const [name,digest] of expected) if (raw(files.get(name))!==digest) incomplete(`${name}: captured tree differs`);
  const activation=json(files.get('activation.json'),'legacy activation');
  exact(activation,['format','activationId','sequence','previousActivationId','preparationRevision',
    'requirementsAuthority','normativeSha256','approvedSnapshotSha256','artifacts','activeAttempt','lastAttempt'],'legacy activation');
  if (activation.format!=='stnl-execution-activation-v1' || !UUID.test(activation.activationId)
    || activation.activeAttempt!==null || activation.requirementsAuthority!==requirementsAuthority)
    (activation.activeAttempt!==null?ownerActive:stale)('legacy activation is active or authority differs');
  integer(activation.sequence,'activation sequence',1);
  integer(activation.preparationRevision,'preparation revision',1);
  if (activation.preparationRevision===Number.MAX_SAFE_INTEGER) incomplete('preparation revision overflow');
  const manifest=new Map([...files].filter(([name])=>name!=='activation.json')
    .map(([name,value])=>[name,raw(value)]));
  const declared=array(activation.artifacts,'legacy activation artifacts');
  const declaredPaths=new Set();
  if (declared.length!==manifest.size || declared.some(item=>{
    exact(item,['path','sha256'],'legacy activation artifact');
    if (typeof item.path!=='string' || !HASH.test(item.sha256) || declaredPaths.has(item.path)) return true;
    declaredPaths.add(item.path);
    return manifest.get(item.path)!==item.sha256;
  }) || activation.approvedSnapshotSha256!==raw(files.get('approved-preparation.json')))
    incomplete('legacy A/B manifest differs');
  const snapshot=json(files.get('approved-preparation.json'),'legacy approved preparation');
  const approved=validateApprovedPreparation(snapshot);
  if (approved.preparationRevision!==activation.preparationRevision
    || approved.normativeSha256!==activation.normativeSha256
    || approved.requirementsAuthority!==requirementsAuthority) stale('legacy approved authority differs');
  const artifacts=new Map();
  for (const item of snapshot.reviewedArtifacts) {
    if (!files.has(item.path)) incomplete(`${item.path}: official artifact absent`);
    artifacts.set(item.path,text(files.get(item.path),item.path));
  }
  const projected=projectPreparationAuthority(artifacts);
  if (!same(projected.normativeProjection,approved.normativeProjection)) stale('legacy current normative carriers differ');
  const continuity=json(files.get('continuity.json'),'legacy continuity');
  exact(continuity,['format','deliveries'],'legacy continuity');
  if (continuity.format!=='stnl-delivery-continuity-v1'
    || !same(continuity.deliveries.map(item=>[item.slice,item.deliveryId]),
      approved.deliveries.map(item=>[item.slice,item.deliveryId]))) incomplete('legacy continuity identities differ');
  const witnesses=array(source.selectorHistory,'selector history');
  if (witnesses.length!==approved.preparationRevision-1)
    incomplete('selector history does not cover every prior preparation revision');
  const legacySnapshots=[{approved,bytes:files.get('approved-preparation.json')}];
  let selectorHighWater=0;
  const include=projection=>{
    for (const row of projection.order) {
      const value=Number(row.slice.slice(6));
      integer(value,'historical selector',1);
      selectorHighWater=Math.max(selectorHighWater,value);
    }
  };
  include(approved.normativeProjection);
  for (const [index,witness] of witnesses.entries()) {
    exact(witness,['revision','allocationRef','snapshotRef'],'selector witness');
    if (witness.revision!==index+1) incomplete('selector revision chain has a gap');
    const markerRef=exact(witness.allocationRef,['path','allocationId','sha256'],'selector allocation');
    const snapshotRef=exact(witness.snapshotRef,['path','sha256'],'selector snapshot');
    const snapshotPath=controlPath(context,snapshotRef.path);
    const markerBytes=controls.get(controlPath(context,markerRef.path)),oldBytes=controls.get(snapshotPath);
    if (!markerBytes || !oldBytes || raw(oldBytes)!==snapshotRef.sha256)
      incomplete('selector source bytes differ');
    const marker=json(markerBytes,'selector producer');
    retainedProducer(marker,context,['preparation-publication'],'selector');
    if (marker.allocationId!==markerRef.allocationId
      || raw(utf8(JSON.stringify(marker.retention)))!==markerRef.sha256
      || marker.executionRoot!==context.physicalExecutionRoot
      || !marker.retention?.retainedPaths?.some(item=>item.path===snapshotPath
        && item.sha256===snapshotRef.sha256)) incomplete('selector snapshot lacks producer retention');
    retainedPredecessor(marker,'approved-preparation.json',oldBytes,'selector snapshot');
    const prior=validateApprovedPreparation(json(oldBytes,'selector snapshot'),{historical:true});
    if (prior.preparationRevision!==witness.revision) incomplete('selector snapshot revision differs');
    include(prior.normativeProjection);
    legacySnapshots.push({approved:prior,bytes:oldBytes});
  }
  const retiredSlices=new Set(),retiredIds=new Set();
  let predecessor=null;
  for (const {approved:version} of [...legacySnapshots].sort((a,b)=>a.approved.preparationRevision-b.approved.preparationRevision)) {
    const leaves=version.normativeProjection.deliveries;
    for (const leaf of leaves) {
      const prior=predecessor?.find(item=>item.slice===leaf.slice);
      const relation=version.normativeProjection.continuity.find(item=>item.slice===leaf.slice);
      if (prior) {
        if (leaf.deliveryId!==prior.deliveryId || relation.relation!=='same'
          || relation.priorDeliveryId!==prior.deliveryId
          || relation.priorRevision!==Number(prior.task.References['Plan revision']))
          incomplete('selector identity/predecessor relation differs');
      } else if (relation.relation!=='new' || relation.priorDeliveryId!==null || relation.priorRevision!==null
        || retiredSlices.has(leaf.slice) || retiredIds.has(leaf.deliveryId))
        incomplete('selector reuses a retired identity or false predecessor');
    }
    if (predecessor) for (const prior of predecessor) if (!leaves.some(leaf=>leaf.slice===prior.slice)) {
      retiredSlices.add(prior.slice);retiredIds.add(prior.deliveryId);
    }
    // Previously seen IDs cannot move to another slice, including one introduced now.
    for (const leaf of leaves) if (predecessor?.some(prior=>prior.deliveryId===leaf.deliveryId && prior.slice!==leaf.slice))
      incomplete('delivery identity moved between selectors');
    predecessor=leaves;
  }
  if (selectorHighWater===Number.MAX_SAFE_INTEGER) incomplete('selector high-water overflow');
  return {requirementsFiles,files,controls,managedContexts,activation,approved,continuity,artifacts,
    tree:parseCurrentJson(canonical(source.tree)),selectorHighWater,legacySnapshots};
}

function retainedPredecessor(producer,artifact,value,label) {
  const entries=producer.expectedTree?.files;
  const selected=Array.isArray(entries)?entries.filter(item=>item.path===artifact):[];
  if (selected.length!==1 || selected[0].type!=='file' || selected[0].sha256!==raw(value))
    incomplete(`${label}: retained bytes differ from producer predecessor tree`);
}
function retainedProducer(producer,context,allowed,label) {
  if (producer.format!=='stnl-execution-publication-owner-v1' || !UUID.test(producer.allocationId)
    || producer.executionRoot!==context.physicalExecutionRoot
    || producer.retention?.executionRoot!==producer.executionRoot
    || producer.retention?.allocationId!==producer.allocationId
    || !allowed.includes(producer.retention?.producer)
    || producer.retentionRoot!==path.join(context.logicalSpecRoot===null
      ? path.dirname(context.physicalExecutionRoot) : path.dirname(context.logicalSpecRoot),
    `.stnl-execution-backup-${producer.allocationId}`))
    incomplete(`${label}: retained producer identity differs`);
  array(producer.retention.retainedPaths,`${label} retained paths`);
  const seen=new Set();
  for (const item of producer.retention.retainedPaths) {
    exact(item,['path','sha256'],`${label} retained path`);
    const rel=typeof item.path==='string'?path.relative(producer.retentionRoot,item.path):'';
    if (!path.isAbsolute(item.path??'') || !rel || rel==='..' || rel.startsWith(`..${path.sep}`)
      || path.isAbsolute(rel) || !HASH.test(item.sha256) || seen.has(item.path)) incomplete(`${label}: retained member differs`);
    seen.add(item.path);
  }
}
function controlPath(context,reference) {
  if (typeof reference!=='string' || path.posix.isAbsolute(reference)
    || reference.includes('\\') || path.posix.normalize(reference)!==reference)
    invalid('noncanonical legacy continuity reference');
  return path.resolve(context.physicalExecutionRoot,reference);
}
function historyTask(item,controls,delivery,context) {
  exact(item,['preparationRevision','requirementsAuthority','normativeSha256','allocationRef','taskRef','snapshotRef'],
    'history record');
  const allocationRef=exact(item.allocationRef,['path','allocationId','sha256'],'history allocation');
  const markerPath=controlPath(context,allocationRef.path);
  const marker=controls.get(markerPath);
  if (!marker) incomplete('history allocation marker absent');
  const producer=json(marker,'history allocation');
  retainedProducer(producer,context,['preparation-publication','pass-reopening'],'history');
  if (producer.allocationId!==allocationRef.allocationId
    || raw(utf8(JSON.stringify(producer.retention)))!==allocationRef.sha256
    || producer.retention?.executionRoot!==producer.executionRoot
    || producer.executionRoot!==context.physicalExecutionRoot)
    incomplete('history allocation producer differs');
  exact(item.taskRef,['path','sha256','logicalTaskPath'],'history task reference');
  exact(item.snapshotRef,['path','sha256'],'history snapshot reference');
  const selected=[];
  for (const [name,ref] of [['task',item.taskRef],['snapshot',item.snapshotRef]]) {
    const full=controlPath(context,ref.path);
    const retainedRelative=path.relative(producer.retentionRoot,full);
    const value=controls.get(full);
    if (!retainedRelative || retainedRelative==='..' || retainedRelative.startsWith(`..${path.sep}`)
      || path.isAbsolute(retainedRelative) || !value || raw(value)!==ref.sha256
      || !producer.retention?.retainedPaths?.some(row=>row.path===full && row.sha256===ref.sha256))
      incomplete(`history ${name} not retained by selected producer`);
    selected.push(value);
  }
  retainedPredecessor(producer,`tasks/${delivery.slice}.md`,selected[0],'history Task');
  retainedPredecessor(producer,'approved-preparation.json',selected[1],'history snapshot');
  if (item.taskRef.logicalTaskPath!==`tasks/${delivery.slice}.md`) incomplete('history task anchor differs');
  const old=validateApprovedPreparation(json(selected[1],'history snapshot'),{historical:true});
  if (old.preparationRevision!==item.preparationRevision
    || old.requirementsAuthority!==item.requirementsAuthority
    || old.normativeSha256!==item.normativeSha256
    || !old.deliveries.some(value=>value.slice===delivery.slice && value.deliveryId===delivery.deliveryId))
    incomplete('history snapshot identity differs');
  const task=parsePreparationArtifact(text(selected[0],'history task'),`tasks/${delivery.slice}.md`,{historical:true});
  const leaf=old.normativeProjection.deliveries.find(value=>value.deliveryId===delivery.deliveryId);
  if (task.fields['Delivery ID']!==delivery.deliveryId || task.fields.Slice!==delivery.slice.slice(6)
    || Object.entries(leaf.task).some(([heading,body])=>!same(heading==='References'?task.fields:task.sections[heading],body)))
    incomplete('history Task identity or normative content differs from retained snapshot');
  return {...task,legacyAuthority:old,historyProducer:producer};
}

function baselineCapture(entry,controls,delivery,context) {
  if (entry===null) return;
  exact(entry,['allocationRef','manifestRef'],'legacy baseline reference');
  const allocationRef=exact(entry.allocationRef,['path','allocationId','sha256'],'baseline allocation');
  const marker=controls.get(controlPath(context,allocationRef.path));
  if (!marker) incomplete('baseline allocation absent');
  const producer=json(marker,'baseline allocation');
  retainedProducer(producer,context,['preparation-publication'],'baseline');
  const ref=exact(entry.manifestRef,['path','sha256'],'baseline manifest reference');
  const manifestPath=controlPath(context,ref.path);
  const manifestBytes=controls.get(manifestPath);
  if (producer.allocationId!==allocationRef.allocationId
    || raw(utf8(JSON.stringify(producer.retention)))!==allocationRef.sha256
    || producer.executionRoot!==context.physicalExecutionRoot
    || !manifestBytes || raw(manifestBytes)!==ref.sha256
    || !producer.retention?.retainedPaths?.some(item=>item.path===manifestPath && item.sha256===ref.sha256))
    incomplete('baseline is not retained by selected producer');
  const manifest=json(manifestBytes,'baseline manifest');
  if (manifest.format!=='stnl-work-continuation-v1'
    || manifest.logicalExecutionRoot!==context.logicalExecutionRoot
    || manifest.logicalWorkspaceRoot!==context.productRoot
    || manifest.deliveryId!==delivery.deliveryId || manifest.slice!==delivery.slice)
    incomplete('baseline manifest identity differs');
}

function taskRecords(task,heading) {
  const body=task.sections[heading];
  if (body==='- none') return [];
  if (typeof body!=='string' || !body.startsWith('### ')) incomplete(`${heading}: malformed record section`);
  const records=body.split(/(?=^### )/mu).map(item=>item.trim()).filter(Boolean);
  for (const record of records) {
    const lines=record.split('\n');
    if (!/^### [a-z-]+-[0-9]{2,}$/u.test(lines[0])) incomplete(`${heading}: malformed record heading`);
    const fields=new Set();let nested=false;
    for (const line of lines.slice(1)) {
      if (line==='') continue;
      const match=/^- ([^:\n]+):(.*)$/u.exec(line);
      if (match) {
        if (fields.has(match[1])) incomplete(`${heading}: duplicate record field ${match[1]}`);
        fields.add(match[1]);nested=match[2]==='';
      } else if (!nested || !/^  - \S/u.test(line)) incomplete(`${heading}: content outside record fields`);
    }
  }
  return records;
}
function legacyFindingIds(value,label) {
  const ids=value==='none'?[]:value.split(', ');
  for (const [index,id] of ids.entries()) {
    const match=/^finding-([0-9]{2,})$/u.exec(id);
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1])<1
      || match[1]!==String(Number(match[1])).padStart(2,'0')
      || index && ids[index-1].localeCompare(id,'en')>=0) incomplete(`${label}: noncanonical finding set`);
  }
  return ids;
}
function legacyScalar(value) {
  if (!value.startsWith('json:')) return value;
  const parsed=parseCurrentJson(value.slice(5));
  if (typeof parsed!=='string' || `json:${JSON.stringify(parsed)}`!==value) incomplete('noncanonical legacy scalar');
  return parsed;
}
function historicalCheck(body,id,prefix,previous,archived) {
  const status=field(body,'Status'),roundText=field(body,'Automatic check round');
  if (!['TESTS_PASS','TESTS_FAIL','TESTS_NOT_APPLICABLE','BLOCKED'].includes(status) || !/^[123]\/3$/u.test(roundText))
    incomplete(`${id}: invalid historical auxiliary status/round`);
  const round=Number(roundText[0]),operation=field(body,'Operation attempt ID');
  const cycle=prefix==='findings-check'?field(body,'Findings cycle'):null;
  for (const name of ['HEAD','Tested scope','Discovery sources','Discovery actions','Verification types considered',
    'Selected checks','Selection rationale','Coverage','Failures','Blockers','Unexpected workspace effects','Persistence summary']) field(body,name);
  const present=(name)=>{const value=field(body,name);if (/^(?:none|pending|n\/a)$/iu.test(value)) incomplete(`${id}: placeholder ${name}`);return value;};
  if (status==='TESTS_PASS') for (const name of ['Tested scope','Verification types considered','Selected checks','Coverage']) present(name);
  const none=/^- Commands: none$/mu.test(body);
  if (none && !['TESTS_NOT_APPLICABLE','BLOCKED'].includes(status)) incomplete(`${id}: missing executed checks`);
  const commands=none?[]:commandTuples(body,'Commands');
  if (status==='TESTS_PASS' && commands.some(item=>item.exit!==0)
    || status==='TESTS_FAIL' && !commands.some(item=>item.exit!==0)) incomplete(`${id}: auxiliary status/commands differ`);
  if (status==='TESTS_NOT_APPLICABLE') {
    if (!none) incomplete(`${id}: non-applicable check executed commands`);
    present('Non-applicability rationale');present('No verification-command confirmation');
  }
  const stateMarker=[...body.matchAll(/^- Tested state:(?: (none))?$/gmu)];
  if (stateMarker.length!==1) incomplete(`${id}: missing Tested state`);
  const tail=body.slice(stateMarker[0].index+stateMarker[0][0].length),end=tail.search(/^- [^:\n]+:/mu);
  const state=(end<0?tail:tail.slice(0,end)).trim();
  if (stateMarker[0][1]) {if(state) incomplete(`${id}: false empty Tested state`);present('Fileless reason');}
  else if (!state || state.split('\n').some(line=>!/^\s*- `[^`]+` \| (?:sha256:[a-f0-9]{64}|REMOVED)$/u.test(line)))
    incomplete(`${id}: malformed Tested state`);
  const statePaths=[...state.matchAll(/`([^`]+)` \|/gu)].map(match=>match[1]);
  if (statePaths.some((name,index)=>index && statePaths[index-1].localeCompare(name,'en')>=0)
    || legacyScalar(field(body,'Tested scope'))!==(stateMarker[0][1]
      ?legacyScalar(field(body,'Fileless reason')):statePaths.join(', '))) incomplete(`${id}: historical tested scope differs`);
  const changedCycle=previous && (prefix==='findings-check'?cycle!==previous.cycle
    :previous.archived && !archived && previous.operation!==operation);
  if (!previous || changedCycle) {
    if (round!==1 || changedCycle && prefix==='findings-check' && Number(cycle.slice(8))<=Number(previous.cycle.slice(8)))
      incomplete(`${id}: auxiliary cycle did not start or advance`);
  } else if (previous.status==='TESTS_FAIL' && previous.round<3) {
    if (round!==previous.round+1) incomplete(`${id}: auxiliary round skipped`);
  } else if (previous.status==='BLOCKED') {
    if (round!==1) incomplete(`${id}: blocked auxiliary did not restart`);
  } else incomplete(`${id}: auxiliary record follows a terminal cycle`);
  if (round>1) {
    for (const name of ['Prior-round failure','Correction applied','Updated scope','In-slice rationale']) present(name);
    const corrections=field(body,'Correction paths');
    if (corrections==='none' && !stateMarker[0][1] && (prefix!=='implementation-check' || previous?.state!==state))
      incomplete(`${id}: correction paths do not explain changed tested work`);
  }
  return {id,body,status,round,operation,cycle,archived,state};
}
function historicalClosure(all,snapshots,delivery) {
  const attempts=[],checks=[],findings=new Map(),divergences=new Map(),reopened=new Set(),priorChecks=new Map();
  const sealedSections=[['Implementation Test Evidence','implementation-check'],['Findings Test Evidence','findings-check'],['Validation Attempts','attempt']];
  const ordinalOf=id=>Number(id.slice(id.lastIndexOf('-')+1));
  const immutable=body=>body.split('\n').filter(line=>!/^- (?:State|Resolution|Superseded by|Resolution slice|Resolution revision):/u.test(line)).join('\n').trim();
  const seen=new Map(sealedSections.map(([,prefix])=>[prefix,0]));
  for (const [sourceIndex,task] of all.entries()) {
    if (sourceIndex<all.length-1) {
      const priorPass=field(task.sections.Continuity,'Historical PASS');
      if (priorPass!=='none') reopened.add(priorPass);
      if (task.historyProducer?.retention.producer==='pass-reopening') {
        const prior=taskRecords(task,'Validation Attempts').at(-1);
        if (!prior || field(prior,'Status')!=='PASS' || task.sections['Final Result']!=='- PASS'
          || !task.historyProducer.confirmation || task.historyProducer.expectedInstalledActivation?.activeAttempt!==null)
          incomplete('reopening producer lacks an archived closed PASS');
        reopened.add(/^### (attempt-[0-9]{2,})/u.exec(prior)[1]);
      }
    }
    for (const [section,prefix] of sealedSections) for (const body of taskRecords(task,section)) {
      const id=/^### ([a-z-]+-[0-9]{2,})/u.exec(body)[1];
      if (!id.startsWith(`${prefix}-`) || ordinalOf(id)!==seen.get(prefix)+1)
        incomplete(`${prefix}: historical records are not in causal ordinal order`);
      seen.set(prefix,ordinalOf(id));
      for (const key of ['Operation attempt ID','Origin activation ID']) if (!UUID.test(field(body,key)))
        incomplete(`${id}: historical operation identity differs`);
      if (field(body,'Delivery ID')!==delivery.deliveryId) incomplete(`${id}: historical delivery differs`);
      const version=snapshots.find(item=>item.approved.preparationRevision===Number(field(body,'Preparation revision'))
        && item.approved.normativeSha256===field(body,'Normative sha256'))?.approved;
      const leaf=version?.normativeProjection.deliveries.find(item=>item.slice===delivery.slice && item.deliveryId===delivery.deliveryId);
      const retainedLeaf=task.legacyAuthority.normativeProjection.deliveries.find(item=>item.slice===delivery.slice);
      if (!leaf || version.preparationRevision>task.legacyAuthority.preparationRevision || !same(leaf.task,retainedLeaf.task))
        incomplete(`${id}: historical operation authority differs`);
      if (prefix==='attempt') {
        const status=field(body,'Status'),type=field(body,'Type');
        if (!['PASS','NEEDS_FIX','BLOCKED'].includes(status) || type!==(attempts.length?'revalidation':'initial'))
          incomplete(`${id}: formal status/type differs`);
        for (const name of ['HEAD','Verified scope','Evidence','Blockers','Unexpected workspace effects','Persistence summary']) field(body,name);
        if (status!=='BLOCKED' || !/^- Commands: none$/mu.test(body)) {
          const commands=commandTuples(body,'Commands');
          if (status==='PASS' && commands.some(item=>item.exit!==0)) incomplete(`${id}: PASS command failed`);
        }
        const refs=legacyFindingIds(field(body,'Finding references'),id);
        const text=field(body,'Finding dispositions'),dispositions=new Map();
        for (const value of text==='none'?[]:text.split(', ')) {
          const pair=/^(finding-[0-9]{2,})=(active|resolved|superseded)$/u.exec(value);
          if (!pair || dispositions.has(pair[1])) incomplete(`${id}: malformed finding disposition`);
          dispositions.set(pair[1],pair[2]);
        }
        if (!same([...dispositions.keys()],refs)) incomplete(`${id}: finding references/dispositions differ`);
        attempts.push({id,body,status,refs,dispositions,archived:sourceIndex<all.length-1});
      } else {
        const check=historicalCheck(body,id,prefix,priorChecks.get(prefix),sourceIndex<all.length-1);
        priorChecks.set(prefix,check);
        if (prefix==='findings-check') checks.push(check);
      }
    }
    for (const [section,prefix,target] of [['Validation Findings','finding',findings],['Divergences','divergence',divergences]]) {
      const localIds=new Set();
      for (const body of taskRecords(task,section)) {
        const id=/^### ([a-z-]+-[0-9]{2,})/u.exec(body)[1];
        if (!new RegExp(`^${prefix}-[0-9]{2,}$`,'u').test(id) || !Number.isSafeInteger(ordinalOf(id)) || ordinalOf(id)<1
          || id!==`${prefix}-${String(ordinalOf(id)).padStart(2,'0')}`) incomplete(`${prefix}: noncanonical declaration ID`);
        if (localIds.has(id)) incomplete(`${id}: duplicate declaration in one Task`);
        localIds.add(id);
        if (!target.has(id) && ordinalOf(id)!==target.size+1) incomplete(`${id}: missing historical declaration ordinal`);
        const state=field(body,'State'),severity=field(body,'Severity'),origin=field(body,'Origin');
        if (!['active','resolved','superseded'].includes(state) || !['blocking','advisory'].includes(severity))
          incomplete(`${id}: declaration state/severity differs`);
        for (const name of prefix==='finding'?['Problem','Evidence','Impact','Related authority','Expected correction']
          :['Problem','Evidence','Required authority operation']) field(body,name);
        if (prefix==='divergence' && !['RESUME','REPLAN'].includes(field(body,'Required authority operation')))
          incomplete(`${id}: invalid authority operation`);
        const optional=name=>new RegExp(`^- ${name}:`,'mu').test(body)?field(body,name):null;
        const resolution=optional('Resolution'),replacement=optional('Superseded by');
        if (state==='active' && (resolution!==null || replacement!==null)
          || state==='resolved' && (resolution===null || /^(?:none|pending|n\/a)$/iu.test(resolution) || replacement!==null)
          || state==='superseded' && (replacement===null || resolution!==null)) incomplete(`${id}: invalid declaration resolution`);
        const prior=target.get(id);
        if (prior && (immutable(prior.body)!==immutable(body)
          || prior.state!=='active' && (prior.state!==state || prior.resolution!==resolution || prior.replacement!==replacement)))
          incomplete(`${id}: historical declaration rewritten or reopened`);
        target.set(id,{id,body,state,severity,origin,resolution,replacement});
      }
    }
  }
  for (const id of reopened) if (!attempts.some(item=>item.id===id && item.status==='PASS' && item.archived))
    incomplete('reopening lacks a retained historical PASS');
  for (const attempt of attempts.slice(0,-1)) if (attempt.status==='PASS' && !reopened.has(attempt.id))
    incomplete(`${attempt.id}: PASS is terminal without retained reopening`);
  const byId=new Map(attempts.map((item,index)=>[item.id,{...item,index}]));
  for (const [prefix,records] of [['finding',findings],['divergence',divergences]]) for (const record of records.values()) {
    if (record.state==='active') incomplete(`${record.id}: active historical ${prefix}`);
    if (record.state==='superseded' && (!records.has(record.replacement) || ordinalOf(record.replacement)<=ordinalOf(record.id)))
      incomplete(`${record.id}: replacement declaration differs`);
    if (prefix==='divergence') {
      if (record.severity==='blocking') incomplete(`${record.id}: blocking recovery/supersession is not represented by this PASS`);
      continue;
    }
    const origin=byId.get(record.origin);
    if (!origin || origin.status!=='NEEDS_FIX') incomplete(`${record.id}: finding origin is not NEEDS_FIX`);
    const endId=record.state==='resolved'?/\battempt-[0-9]{2,}\b/u.exec(record.resolution)?.[0]:findings.get(record.replacement).origin;
    const end=byId.get(endId);
    if (!end || end.index<=origin.index || !['PASS','NEEDS_FIX'].includes(end.status))
      incomplete(`${record.id}: finding resolution is not a later formal operation`);
    record.start=origin.index;record.end=end.index;
  }
  const stateAt=(finding,index)=>index<finding.start?null:index>=finding.end?finding.state:'active';
  for (const [index,attempt] of attempts.entries()) {
    const applicable=[...findings.values()].filter(item=>stateAt(item,index)!==null).sort((a,b)=>a.id.localeCompare(b.id,'en'));
    if (!same(attempt.refs,applicable.map(item=>item.id))
      || applicable.some(item=>attempt.dispositions.get(item.id)!==stateAt(item,index)))
      incomplete(`${attempt.id}: finding timeline or declaration differs`);
  }
  for (const check of checks) {
    const cycle=byId.get(field(check.body,'Findings cycle'));
    if (!cycle || cycle.status!=='NEEDS_FIX') incomplete(`${check.id}: findings cycle differs`);
    const ids=legacyFindingIds(field(check.body,'Finding IDs'),check.id);
    const verified=legacyFindingIds(field(check.body,'Findings verified'),check.id);
    const unsupported=legacyFindingIds(field(check.body,'Unsupported active findings'),check.id);
    const active=[...findings.values()].filter(item=>stateAt(item,cycle.index)==='active').map(item=>item.id).sort();
    if (ids.some(id=>!active.includes(id)) || verified.some(id=>!ids.includes(id))
      || !same(unsupported,active.filter(id=>!verified.includes(id)))) incomplete(`${check.id}: findings check ownership differs`);
  }
}
function taskState(task,history,continuity,snapshots) {
  if (continuity.reopen!==null) incomplete(`${continuity.slice}: open legacy reopening`);
  for (const heading of ['Validation Findings','Divergences']) {
    const body=task.sections[heading];
    if (body!=='- none' && /^- State: active$/mu.test(body)) incomplete(`${continuity.slice}: active ${heading}`);
  }
  if (task.sections['Delegation Blocker']!=='- none') incomplete(`${continuity.slice}: delegation episode is not closed`);
  const all=[...history,task];
  const counters={implementationChecks:identifiers(all,'Implementation Test Evidence','implementation-check'),
    findingsChecks:identifiers(all,'Findings Test Evidence','findings-check'),
    validationAttempts:identifiers(all,'Validation Attempts','attempt'),
    findings:identifiers(all,'Validation Findings','finding')};
  historicalClosure(all,snapshots,continuity);
  const final=task.sections['Final Result'];
  if (!['- pending','- PASS'].includes(final)) incomplete(`${continuity.slice}: unsupported Final Result`);
  if (final==='- PASS') {
    const attempts=taskRecords(task,'Validation Attempts');
    const last=attempts.at(-1);
    if (!last || field(last,'Status')!=='PASS'
      || field(task.sections['Effective Validation Base'],'Origin attempt')!==/^### (attempt-[0-9]{2,})$/mu.exec(last)?.[1])
      incomplete(`${continuity.slice}: PASS/base/latest formal differ`);
    if (task.sections['Scope Expansion']!=='- none'
      || task.sections['Prior Validation Overlap']!=='- none')
      incomplete(`${continuity.slice}: unresolved scope/validation overlap`);
    const summary=task.sections['Diff Summary'].split('\n');
    if (!summary.length || summary.some(line=>!(/^- \S.*$/u.test(line))))
      incomplete(`${continuity.slice}: formal Diff Summary is not a closed flat carrier`);
  } else if (Object.values(counters).some(number=>number!==0)
    || task.sections['Changed Areas']!=='- pending'
    || task.sections['Effective Validation Base']!=='- none'
    || taskRecords(task,'Implementation Test Evidence').length
    || taskRecords(task,'Validation Attempts').length
    || /^- \[x\] /mu.test(task.sections.Checklist))
    incomplete(`${continuity.slice}: unfinished or consumed episode`);
  return {counters,final};
}
function importedObjects(value,controls,official,managedContexts,label) {
  const objects=map(value,`${label} objects`);
  const original=[...controls.values(),...official.values()].map(raw);
  for (const [id,body] of objects) {
    if (raw(body)!==id) incomplete(`${label}: object digest differs`);
    if (original.includes(id)) continue;
    const capsule=json(body,`${label} capsule`);
    if (!capsule.format?.endsWith('-bundle-v1')) incomplete(`${label}: synthetic raw source`);
    for (const [name,source] of Object.entries(capsule)) if (name.endsWith('Utf8')) {
      const contextCarrier=name==='contextUtf8' && capsule.format==='stnl-managed-imported-start-bundle-v1';
      if (name==='contextUtf8' && !contextCarrier) incomplete(`${label}: unsupported context carrier`);
      const origin=contextCarrier && typeof source==='string' ? parseCurrentJson(source) : null;
      const authentic=contextCarrier ? managedContexts.get(origin?.owner?.operationAttemptId) : null;
      if (typeof source!=='string' || !(contextCarrier
        ? authentic?.equals(utf8(source)) : original.includes(raw(utf8(source)))))
        incomplete(`${label}: capsule ${name} has no captured raw source`);
    }
  }
  return objects;
}
function boundaryObject(controls,name,label) {
  if (typeof name!=='string' || !path.isAbsolute(name) || path.normalize(name)!==name)
    invalid(`${label}: canonical absolute control path required`);
  const value=controls.get(name);
  if (!value) incomplete(`${label}: control absent`);
  return json(value,label);
}
function terminalTaskBinding(publication,taskBytes,delivery,context) {
  const rows=publication.expectedInstalledActivation?.artifacts;
  const logicalTaskPath=`tasks/${delivery.slice}.md`;
  if (!Array.isArray(rows) || rows.filter(row=>row.path===logicalTaskPath).length!==1
    || rows.find(row=>row.path===logicalTaskPath).sha256!==raw(taskBytes)
    || publication.executionRoot!==context.logicalExecutionRoot)
    incomplete(`${delivery.slice}: terminal publication does not bind source Task bytes`);
}
async function legacyBoundary(boundary,source,task,delivery,context,requiredFormalId) {
  const {controls,managedContexts}=source;
  exact(boundary,['transport','receiptPath','responsePath','observationPath','manifestPath',
    'publicationPath',boundary.transport==='managed'?'managedContextId':'originPath','closure'],'closed PASS boundary');
  if (!['native','managed'].includes(boundary.transport)) fail('UNSUPPORTED_FORMAT','legacy boundary transport');
  exact(boundary.closure,boundary.transport==='native'
    ? ['dispatchPath','agentPath','claimPath','resultPath']
    : ['activePath','startedPath','eventsPath','supervisorPath','latestPath','runtimeIdentityPaths'],'boundary closure');
  const get=(name,label)=>{boundaryObject(controls,name,label);return controls.get(name);};
  const receiptBytes=get(boundary.receiptPath,'formal receipt'),receipt=json(receiptBytes,'formal receipt');
  const manifestBytes=get(boundary.manifestPath,'formal manifest'),manifest=json(manifestBytes,'formal manifest');
  const publicationBytes=get(boundary.publicationPath,'formal publication'),publication=json(publicationBytes,'formal publication');
  const attempt=taskRecords(task,'Validation Attempts').at(-1);
  if (!attempt || /^### (attempt-[0-9]{2,})$/mu.exec(attempt)?.[1]!==requiredFormalId
    || receipt.owner?.deliveryId!==delivery.deliveryId || receipt.slice!==delivery.slice
    || receipt.semanticResponseFile!==boundary.responsePath || receipt.receiptFile!==boundary.receiptPath
    || boundary.manifestPath!==path.join(publication.retentionRoot,'preserved-product-manifest.json'))
    incomplete(`${delivery.slice}: formal source path or identity differs`);
  const common={transport:boundary.transport,receipt:receiptBytes,rawResponse:get(boundary.responsePath,'formal response'),
    verificationObservation:get(boundary.observationPath,'formal observation'),workManifest:manifestBytes,publication:publicationBytes,
    retainedFiles:array(manifest.entries,'formal manifest entries').filter(entry=>entry.kind==='file').map(entry=>({
      path:entry.storedPath,bytes:controls.get(entry.storedPath)??incomplete('retained file absent')}))};
  const closure=boundary.closure;
  let capture;
  if (boundary.transport==='native') {
    if (receipt.originFile!==boundary.originPath) incomplete('native selected origin differs');
    capture={...common,origin:get(boundary.originPath,'native origin'),dispatch:get(closure.dispatchPath,'native dispatch'),
      agentBinding:get(closure.agentPath,'native agent'),agentClaim:get(closure.claimPath,'native claim'),
      concludedToolResult:get(closure.resultPath,'native result')};
  } else {
    if (boundary.managedContextId!==receipt.owner.operationAttemptId || receipt.eventsPath!==closure.eventsPath)
      incomplete('managed selected origin/events differ');
    capture={...common,managedContext:managedContexts.get(boundary.managedContextId)??incomplete('managed context absent'),
      active:get(closure.activePath,'managed active'),started:get(closure.startedPath,'managed started'),
      events:controls.get(closure.eventsPath)??incomplete('managed events absent'),
      closedSupervisor:get(closure.supervisorPath,'managed supervisor'),latest:get(closure.latestPath,'managed latest'),
      runtimeIdentity:array(closure.runtimeIdentityPaths,'runtime paths').map(name=>controls.get(name)??incomplete('runtime bytes absent'))};
  }
  const snapshot=source.legacySnapshots.find(item=>item.approved.preparationRevision===receipt.owner.preparationRevision
    && item.approved.normativeSha256===receipt.owner.normativeSha256
    && item.approved.requirementsAuthority===manifest.requirementsAuthority
    && raw(item.bytes)===publication.expectedInstalledActivation?.approvedSnapshotSha256);
  if (!snapshot) incomplete('formal operation has no explicitly retained preparation');
  await verifyLegacyOperationFacts({context,legacyPreparationBytes:snapshot.bytes,operationRecordUtf8:attempt,capture});
  terminalTaskBinding(publication,source.files.get(`tasks/${delivery.slice}.md`),delivery,context);
  const base=task.sections['Effective Validation Base'];
  const commands=commandTuples(attempt,'Commands');
  if (field(base,'Origin attempt')!==requiredFormalId || field(base,'Attempt type')!==field(attempt,'Type')
    || field(base,'HEAD')!==field(attempt,'HEAD') || field(base,'Result')!=='PASS'
    || field(base,'Evidence summary')!==field(attempt,'Evidence')
    || !same(commandTuples(base,'Authoritative commands'),commands) || commands.some(item=>item.exit!==0))
    incomplete(`${delivery.slice}: Effective Validation Base is not this formal PASS`);
  const baseFileless=/^- Files: none$/mu.test(base);
  const files=[...base.matchAll(/^  - `([^`]+)` \| (sha256:[a-f0-9]{64}|REMOVED)$/gmu)]
    .map(match=>({path:path.relative(context.productRoot,
      resolveLogicalProductClaim(context,`tasks/${delivery.slice}.md`,match[1])).split(path.sep).join('/'),
    sha256:match[2]}));
  if (baseFileless) {
    if (field(attempt,'Verified scope')!=='fileless task state'
      || files.length || !/^- Fileless reason: \S.+$/mu.test(base)
      || manifest.entries.some(item=>item.kind==='file'))
      incomplete(`${delivery.slice}: false fileless formal base`);
  } else if (field(attempt,'Verified scope')!==[...base.matchAll(/^  - `([^`]+)` \| (sha256:[a-f0-9]{64}|REMOVED)$/gmu)].map(match=>match[1]).join(', ')
    || !files.length || files.some(item=>item.sha256==='REMOVED'
    || !manifest.entries.some(entry=>entry.path===item.path && entry.kind==='file'
      && entry.sha256===item.sha256)))
    incomplete(`${delivery.slice}: formal file claims differ from tested preimage`);
  return {operationAttemptId:receipt.owner.operationAttemptId,manifest};
}

function proofFor(source,delivery) {
  const entry=source.imports.find(item=>item.slice===delivery.slice);
  if (!entry) incomplete(`${delivery.slice}: import declaration absent`);
  exact(entry,['slice','implementation','validation','objects','boundary'],'delivery import');
  array(entry.implementation,'imported implementation records');
  if (entry.validation!==null) plain(entry.validation,'imported formal record');
  const objects=importedObjects(entry.objects,source.controls,source.files,source.managedContexts,delivery.slice);
  for (const record of [...entry.implementation,...(entry.validation?[entry.validation]:[])]) {
    if (record.sources?.transport!=='managed') continue;
    const capsule=json(objects.get(record.sources.started)??incomplete('managed start capsule absent'),'managed start capsule');
    if (capsule.format!=='stnl-managed-imported-start-bundle-v1'
      || capsule.contextUtf8!==text(source.managedContexts.get(record.origin?.operationAttemptId)
        ??incomplete('record managed context absent'),'record managed context'))
      incomplete('managed start capsule does not bind record owner');
  }
  return {...parseCurrentJson(canonical({...entry,objects:null})),objects};
}
function proposalDigest(base,authority,files,decisions) {
  const manifest=[...files].map(([name,value])=>({path:name,sha256:raw(bytes(value,name))}))
    .sort((a,b)=>ordinal(a.path,b.path));
  return raw(utf8(canonical({base,authority:{requirementsAuthority:authority.requirementsAuthority,
    preparationRevision:authority.preparationRevision,normativeSha256:authority.normativeSha256,
    deliveries:authority.deliveries.map(({slice,deliveryId,authoritySha256})=>({slice,deliveryId,authoritySha256}))},
  manifest,decisions})));
}
function sourceBase(context,requirementsAuthority,observedWork,capture) {
  return {context:parseCurrentJson(canonical(context)),requirementsAuthority,
    observedWorkSha256:raw(utf8(canonical(observedWork))),
    sourceActivationId:capture.activation.activationId,
    sourcePreparationRevision:capture.activation.preparationRevision,
    sourceSelectorHighWater:capture.selectorHighWater,
    sourceTree:parseCurrentJson(canonical(capture.tree)),
    requirementsManifest:[...capture.requirementsFiles].map(([name,value])=>({path:name,sha256:raw(value)}))
      .sort((a,b)=>ordinal(a.path,b.path)),
    sourceManifest:[...capture.files].map(([name,value])=>({path:name,sha256:raw(value)}))
      .sort((a,b)=>ordinal(a.path,b.path)),
    controlManifest:[...capture.controls].map(([name,value])=>({path:name,sha256:raw(value)}))
      .sort((a,b)=>ordinal(a.path,b.path)),
    managedContextManifest:[...capture.managedContexts].map(([operationAttemptId,value])=>
      ({operationAttemptId,sha256:raw(value)})).sort((a,b)=>ordinal(a.operationAttemptId,b.operationAttemptId))};
}
function convertedArtifacts(capture,sourceStates,revision,requirementsAuthority) {
  const artifacts=new Map();
  const oldPlan=capture.artifacts.get('plan.md');
  const planSections=sections(oldPlan,'legacy Plan');
  const global=planSections.get('Global Context').split('\n')
    .filter(line=>!(/^- (?:Replan reason|Revision mode|Supersedes open slices): /u.test(line))).join('\n');
  artifacts.set('plan.md',utf8(render(oldPlan,new Map([
    ['Global Context',replaceField(global,'Plan revision',String(revision))],
  ]),['Delivery Continuity'])));
  const oldTasks=capture.artifacts.get('tasks.md');
  const rows=oldTasks.split('\n').map(line=>{
    if (!/^\| \[[ x]\] \|/u.test(line)) return line;
    const columns=line.slice(1,-1).split('|').map(item=>item.trim());
    const slice=`slice-${columns[1].split(' - ')[0]}`;
    const state=sourceStates.get(slice);
    if (!state) invalid(`${slice}: Tasks row has no source delivery`);
    columns[0]=state.kind==='S1'?'[x]':'[ ]';
    columns[5]=state.validation;
    columns[6]=state.kind==='S1'?'PASS':'pending';
    return `| ${columns.join(' | ')} |`;
  }).join('\n');
  artifacts.set('tasks.md',utf8(rows));
  for (const [slice,state] of sourceStates) {
    const detailName=`plans/${slice}.md`,taskName=`tasks/${slice}.md`;
    const oldDetail=capture.artifacts.get(detailName),oldTask=capture.artifacts.get(taskName);
    if (!oldDetail || !oldTask) incomplete(`${slice}: preparation artifacts absent`);
    const detailSections=sections(oldDetail,detailName),taskSections=sections(oldTask,taskName);
    artifacts.set(detailName,utf8(render(oldDetail,new Map([
      ['References',appendLocalRevision(replaceField(detailSections.get('References'),'Plan revision',String(revision)))],
    ]))));
    const taskChanges=new Map([
      ['References',appendLocalRevision(replaceField(taskSections.get('References'),'Plan revision',String(revision)))],
      ['Continuity',`- Current validation: ${state.validation}\n- Current evidence: ${state.evidenceSha256??'none'}\n- Current action: ${state.kind==='S0'?'implement approved delivery':state.kind==='S1' && state.validation==='current'?'none':'validate'}`],
      ['Operational Changes','- none'],['Changed Areas',state.kind==='S1'?'- none':'- pending'],
      ['Scope Expansion','- none'],['Prior Validation Overlap','- none'],['Divergences','- none'],
      ['Delegation Blocker','- none'],
      ['Implementation Test Evidence',state.kind==='S1'?state.implementation.map(record=>record.recordUtf8.trim()).join('\n\n'):'- none'],
      ['Findings Test Evidence','- none'],
      ['Validation Attempts',state.kind==='S1'?state.formal.recordUtf8.trim():'- none'],
      ['Validation Findings','- none'],['Corrections Applied','- none'],
      ['Effective Validation Base',state.kind==='S1'?taskSections.get('Effective Validation Base'):'- none'],
      ['Diff Summary',state.kind==='S1'?taskSections.get('Diff Summary'):'- pending'],
      ['Final Result',state.kind==='S1'?'- PASS':'- pending'],
    ]);
    artifacts.set(taskName,utf8(render(oldTask,taskChanges)));
  }
  return artifacts;
}

function closedControlIndex(capture,source,states,context) {
  const selectedPaths=new Set(),selectedHashes=new Set(),selectedContexts=new Set();
  const reference=pathRef=>selectedPaths.add(controlPath(context,pathRef));
  for (const witness of source.selectorHistory) {
    reference(witness.allocationRef.path);reference(witness.snapshotRef.path);
  }
  for (const delivery of capture.continuity.deliveries) {
    if (delivery.baseline) {
      reference(delivery.baseline.allocationRef.path);reference(delivery.baseline.manifestRef.path);
    }
    for (const history of delivery.history) {
      reference(history.allocationRef.path);reference(history.taskRef.path);reference(history.snapshotRef.path);
    }
  }
  for (const state of states.values()) {
    for (const [id,value] of state.objects) {
      selectedHashes.add(id);
      let capsule;
      try { capsule=json(value,'imported capsule'); } catch { continue; }
      for (const [name,content] of Object.entries(capsule)) if (name.endsWith('Utf8'))
        selectedHashes.add(raw(utf8(content)));
      if (capsule.format==='stnl-managed-imported-start-bundle-v1')
        selectedContexts.add(parseCurrentJson(capsule.contextUtf8).owner?.operationAttemptId);
    }
    const boundary=source.imports.find(item=>item.slice===state.delivery.slice)?.boundary;
    if (boundary) {
      for (const name of ['receiptPath','responsePath','observationPath','manifestPath','publicationPath','originPath'])
        if (boundary[name]) selectedPaths.add(boundary[name]);
      if (boundary.managedContextId) selectedContexts.add(boundary.managedContextId);
      for (const value of Object.values(boundary.closure)) {
        if (Array.isArray(value)) value.forEach(name=>selectedPaths.add(name));
        else selectedPaths.add(value);
      }
      for (const entry of state.boundary.manifest.entries) if (entry.kind==='file') selectedPaths.add(entry.storedPath);
    }
  }
  for (const [name,value] of capture.controls) if (!selectedPaths.has(name) && !selectedHashes.has(raw(value)))
    incomplete(`closed source index contains an unbound control: ${name}`);
  for (const id of capture.managedContexts.keys()) if (!selectedContexts.has(id))
    incomplete(`closed source index contains an unbound managed context: ${id}`);
}

export async function prepareCurrentConversion(input) {
  exact(input,['context','requirementsAuthority','source','observedWork'],'conversion input');
  logicalArtifactPath(input.context,'plan.md');
  if (!HASH.test(input.requirementsAuthority)) invalid('requirements authority digest');
  const capture=captureSource(input.context,input.requirementsAuthority,input.source);
  input={...input,context:parseCurrentJson(canonical(input.context)),
    observedWork:parseCurrentJson(canonical(input.observedWork)),
    source:{...input.source,files:capture.files,controls:capture.controls,managedContexts:capture.managedContexts}};
  array(input.source.imports,'import declarations');
  for (const item of input.source.imports)
    exact(item,['slice','implementation','validation','objects','boundary'],'import declaration');
  if (!same(input.source.imports.map(item=>item.slice),capture.approved.deliveries.map(item=>item.slice)))
    incomplete('import declaration membership/order differs from legacy authority');
  const observedByDelivery=projectConversionObservedWork({context:input.context,observedWork:input.observedWork,
    deliveries:capture.approved.normativeProjection.deliveries.map(leaf=>({slice:leaf.slice,deliveryId:leaf.deliveryId,
      authorizedAreas:leaf.plan['Authorized Areas'],existingInputs:leaf.plan['Existing Inputs'],
      verificationRecipe:parseVerificationRecipe(leaf.task['Verification Recipe'])}))});
  const revision=capture.approved.preparationRevision+1;
  integer(revision,'next preparation revision',1);
  const states=new Map();
  for (const delivery of capture.approved.deliveries) {
    const entry=capture.continuity.deliveries.find(item=>item.slice===delivery.slice);
    exact(entry,['slice','deliveryId','baseline','history','reopen'],'legacy delivery continuity');
    baselineCapture(entry.baseline,capture.controls,delivery,input.context);
    const historical=array(entry.history,'delivery history').map(item=>historyTask(item,capture.controls,delivery,input.context));
    const current={...parsePreparationArtifact(capture.artifacts.get(`tasks/${delivery.slice}.md`),
      `tasks/${delivery.slice}.md`),legacyAuthority:capture.approved};
    const {counters,final}=taskState(current,historical,entry,capture.legacySnapshots);
    const proof=proofFor(input.source,delivery);
    let kind,validation,formal=null,boundary=null;
    if (final==='- pending') {
      if (proof.implementation.length || proof.validation!==null || proof.boundary!==null || proof.objects.size
        || current.sections['Validation Findings']!=='- none'
        || current.sections.Divergences!=='- none'
        || current.sections['Implementation Test Evidence']!=='- none'
        || current.sections['Findings Test Evidence']!=='- none'
        || current.sections['Validation Attempts']!=='- none'
        || current.sections['Scope Expansion']!=='- none'
        || current.sections['Operational Changes']!=='- none'
        || current.sections['Prior Validation Overlap']!=='- none'
        || current.sections['Corrections Applied']!=='- none'
        || current.sections['Diff Summary']!=='- pending'
        || field(current.sections.Continuity,'Historical PASS')!=='none'
        || field(current.sections.Continuity,'Current validation')!=='unvalidated'
        || capture.activation.lastAttempt?.slice===delivery.slice)
        incomplete(`${delivery.slice}: S0 has consumed source`);
      kind='S0';validation='unvalidated';
    } else {
      const formalText=taskRecords(current,'Validation Attempts').at(-1);
      const formalId=/^### (attempt-[0-9]{2,})$/mu.exec(formalText)?.[1];
      if (!formalId || proof.validation?.id!==formalId && proof.boundary===null)
        incomplete(`${delivery.slice}: latest formal identity is not captured`);
      if (proof.validation!==null && proof.boundary===null) {
        if (!proof.implementation.length || proof.validation.recordUtf8.trim()!==formalText
          || !same(proof.implementation.map(record=>record.recordUtf8.trim()),
            taskRecords(current,'Implementation Test Evidence')))
          incomplete(`${delivery.slice}: imported records differ from legacy Task`);
        if (capture.activation.lastAttempt?.slice===delivery.slice
          && capture.activation.lastAttempt.operationAttemptId!==proof.validation.origin.operationAttemptId)
          incomplete(`${delivery.slice}: later terminal episode follows the asserted PASS`);
        kind='S1';formal=proof.validation;
        validation=same(formal.testedWork,observedByDelivery.get(delivery.deliveryId))?'current':'revalidation-required';
      } else if (proof.validation===null && proof.boundary!==null && !proof.implementation.length && !proof.objects.size) {
        kind='S2';validation='revalidation-required';
        boundary=await legacyBoundary(proof.boundary,capture,current,delivery,input.context,formalId);
        if (capture.activation.lastAttempt?.slice===delivery.slice
          && capture.activation.lastAttempt.operationAttemptId!==boundary.operationAttemptId)
          incomplete(`${delivery.slice}: later terminal episode follows the asserted PASS`);
      } else incomplete(`${delivery.slice}: mixed or partial PASS proof`);
    }
    states.set(delivery.slice,{kind,validation,delivery,entry,current,historical,counters,
      implementation:proof.implementation,formal,objects:proof.objects,boundary,evidenceSha256:null});
  }
  closedControlIndex(capture,input.source,states,input.context);
  const files=convertedArtifacts(capture,states,revision,input.requirementsAuthority);
  let authority=projectConversionPreparation({context:input.context,
    requirementsAuthority:input.requirementsAuthority,artifacts:files});
  const decisions=[];
  for (const [slice,state] of states) {
    if (state.kind!=='S1') continue;
    const leaf=authority.normativeProjection.deliveries.find(item=>item.deliveryId===state.delivery.deliveryId);
    const approvedAuthority={snapshot:{normativeProjection:authority.normativeProjection,
      requirementsAuthority:input.requirementsAuthority,deliveries:authority.deliveries},delivery:leaf};
    for (const record of [...state.implementation,state.formal])
      await verifyImportedEvidence({context:input.context,record,objects:state.objects,
        approvedAuthority,observedWork:input.observedWork});
    const formalCapsule=json(state.objects.get(state.formal.sources.transport==='native'
      ? state.formal.sources.origin : state.formal.sources.started),'formal source capsule');
    terminalTaskBinding(parseCurrentJson(formalCapsule.publicationUtf8),
      capture.files.get(`tasks/${slice}.md`),state.delivery,input.context);
    const bundle={format:'stnl-current-evidence-v1',deliveryId:state.delivery.deliveryId,
      slice,logicalTaskPath:`tasks/${slice}.md`,currentAuthoritySha256:authority.deliveries.find(item=>item.slice===slice).authoritySha256,
      implementation:state.implementation,findingsChecks:[],validation:state.formal,
      openFindings:[],openDivergences:[],support:[],
      objects:[...state.objects].map(([id,value])=>({id,bytesBase64:value.toString('base64')}))
        .sort((a,b)=>ordinal(a.id,b.id))};
    validateCurrentEvidence(bundle);
    const bundleBytes=encoded(bundle);
    state.evidenceSha256=raw(bundleBytes);
    files.set(`evidence/${state.delivery.deliveryId}.json`,bundleBytes);
    decisions.push({deliveryId:state.delivery.deliveryId,evidenceSha256:state.evidenceSha256,
      disposition:state.validation==='current'?'retain-current':'revalidate'});
  }
  const finalArtifacts=convertedArtifacts(capture,states,revision,input.requirementsAuthority);
  for (const [name,value] of finalArtifacts) files.set(name,value);
  authority=projectConversionPreparation({context:input.context,
    requirementsAuthority:input.requirementsAuthority,artifacts:files});
  const nextSliceOrdinal=capture.selectorHighWater+1;
  if (!Number.isSafeInteger(nextSliceOrdinal)) incomplete('next slice ordinal overflow');
  const continuity={format:'stnl-delivery-continuity-v2',nextSliceOrdinal,
    deliveries:[...states].map(([slice,state])=>({slice,deliveryId:state.delivery.deliveryId,localRevision:1,
      authoritySha256:authority.deliveries.find(item=>item.slice===slice).authoritySha256,
      validation:state.validation,
      evidence:state.kind==='S1'?{path:`evidence/${state.delivery.deliveryId}.json`,sha256:state.evidenceSha256}:null,
      counters:state.counters,baseline:observedByDelivery.get(state.delivery.deliveryId),normalization:null,
      lastDiagnostic:state.kind==='S2'?{code:'EVIDENCE_INCOMPLETE',
        operationAttemptId:state.boundary.operationAttemptId,
        reason:state.boundary.manifest.entries.some(item=>item.kind==='file')
          ? 'Legacy tested work does not prove the original file mode; formal revalidation is required.'
          : 'Legacy test proof is incomplete; formal revalidation is required.',
        affectedPaths:state.boundary.manifest.entries.filter(item=>item.kind==='file').map(item=>item.path).sort(ordinal),
        nextAction:'validate'}:null})),completed:[]};
  validateCurrentContinuity(continuity);
  files.set('continuity.json',encoded(continuity));
  const base=sourceBase(input.context,input.requirementsAuthority,input.observedWork,capture);
  const proposedDecisions=decisions.sort((a,b)=>ordinal(a.deliveryId,b.deliveryId));
  return {phase:'reviewable',files,base,proposedDecisions,
    proposalSha256:proposalDigest(base,authority,files,proposedDecisions)};
}

function checkedProposal(context,requirementsAuthority,observedWork,proposal,review) {
  exact(proposal,['phase','files','base','proposedDecisions','proposalSha256'],'conversion proposal');
  if (proposal.phase!=='reviewable') stale('conversion proposal is not reviewable');
  const files=map(proposal.files,'reviewable files');
  if (files.has('activation.json') || files.has('approved-preparation.json'))
    invalid('reviewable files contain an activation or snapshot');
  const base=exact(proposal.base,['context','requirementsAuthority','observedWorkSha256',
    'sourceActivationId','sourcePreparationRevision','sourceSelectorHighWater',
    'sourceTree','requirementsManifest','sourceManifest','controlManifest','managedContextManifest'],'conversion base');
  if (!same(base.context,context) || base.requirementsAuthority!==requirementsAuthority
    || base.observedWorkSha256!==raw(utf8(canonical(observedWork))))
    stale('conversion context, authority or observation changed after review');
  if (!UUID.test(base.sourceActivationId) || !HASH.test(base.observedWorkSha256)) invalid('conversion base identity');
  integer(base.sourcePreparationRevision,'source preparation revision',1);
  integer(base.sourceSelectorHighWater,'source selector high-water',1);
  exact(review,['proposalSha256','globalReview','deliveries'],'conversion review');
  array(proposal.proposedDecisions,'proposed evidence decisions');
  array(review.deliveries,'reviewed deliveries');
  for (const item of review.deliveries) {
    exact(item,['deliveryId','review'],'reviewed delivery');
    exact(item.review,['scope','decision','authoritySha256','examinedArtifactHashes',
      'evidenceDecisions','summary'],'delivery review');
    array(item.review.evidenceDecisions,'reviewed evidence decisions');
  }
  const authority=projectConversionPreparation({context,requirementsAuthority,artifacts:files});
  const digest=proposalDigest(base,authority,files,proposal.proposedDecisions);
  if (proposal.proposalSha256!==digest || review.proposalSha256!==digest)
    stale('final review did not examine these exact conversion bytes and dispositions');
  for (const decision of proposal.proposedDecisions) {
    exact(decision,['deliveryId','evidenceSha256','disposition'],'proposed decision');
    if (!UUID.test(decision.deliveryId) || !HASH.test(decision.evidenceSha256)
      || !['retain-current','revalidate'].includes(decision.disposition)) invalid('proposed evidence decision');
  }
  if (proposal.proposedDecisions.some((item,index)=>index>0
    && ordinal(proposal.proposedDecisions[index-1].deliveryId,item.deliveryId)>=0))
    invalid('proposed evidence decisions are not ordered and unique');
  const reviewed=review.deliveries.flatMap(item=>item.review.evidenceDecisions.map(({deliveryId,evidenceSha256,disposition})=>
    ({deliveryId,evidenceSha256,disposition}))).sort((a,b)=>ordinal(a.deliveryId,b.deliveryId));
  if (!same(reviewed,proposal.proposedDecisions)) stale('conversion evidence disposition changed');
  return {files,authority,base};
}

export async function finalizeCurrentConversion(input) {
  exact(input,['context','requirementsAuthority','observedWork','proposal','review'],'final conversion input');
  const {files,base}=checkedProposal(input.context,input.requirementsAuthority,
    input.observedWork,input.proposal,input.review);
  const seal=approveConversionPreparation({context:input.context,
    requirementsAuthority:input.requirementsAuthority,artifacts:files,
    review:{globalReview:input.review.globalReview,deliveries:input.review.deliveries}});
  files.set('approved-preparation.json',seal.bytes);
  validateCurrentCandidate({files});
  const inspection=await inspectConvertedExecution({context:input.context,
    requirementsAuthority:input.requirementsAuthority,files,observedWork:input.observedWork});
  return {files,base,inspection};
}

export async function validateCurrentConversion(input) {
  exact(input,['context','requirementsAuthority','candidate','source','review','observedWork'],
    'conversion comparison input');
  plain(input.candidate,'conversion candidate');
  if (!same(Object.keys(input.candidate).sort(ordinal),['base','files'])
    && !same(Object.keys(input.candidate).sort(ordinal),['base','files','inspection']))
    invalid('conversion candidate fields');
  const expected=await prepareCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,source:input.source,observedWork:input.observedWork});
  if (!same(expected.base,input.candidate.base)) stale('source CAS identity or captured manifest changed');
  const rebuilt=await finalizeCurrentConversion({context:input.context,
    requirementsAuthority:input.requirementsAuthority,observedWork:input.observedWork,
    proposal:expected,review:input.review});
  const actual=map(input.candidate.files,'conversion candidate files');
  if (!same([...actual.keys()].sort(ordinal),[...rebuilt.files.keys()].sort(ordinal))
    || [...actual].some(([name,value])=>!value.equals(rebuilt.files.get(name))))
    stale('candidate bytes differ from source-derived reviewed conversion');
  return {base:rebuilt.base,inspection:rebuilt.inspection,sourceCompared:true};
}
