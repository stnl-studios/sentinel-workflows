import test from 'node:test';import assert from 'node:assert/strict';
import{buildTrajectoryReport}from'../trajectory-report.mjs';import{CASES}from'../scenarios.mjs';
const h=n=>String(n).repeat(64),pass=slice=>({slice,deliveryId:'delivery-'+slice,formalStatus:'PASS',evidenceSha256:'sha256:'+h(slice==='one'?1:2)});
const authority=(state,deliveries=[])=>({specPath:'/work/specs/import',current:{exitCode:0,output:{state,deliveries}},lifecycle:{exitCode:0,output:{lifecycle_status:state==='SPEC_CLOSED'?'closed':'ready'}}});
function fixture(shared=true){const before={'src/service.mjs':h(0),'src/cli.mjs':h(0)},first={...before,'src/service.mjs':h(1)},second={...first,[shared?'src/service.mjs':'src/cli.mjs']:h(2)};return[
 {index:1,stage:'EXECUTE_SLICE',slice:'one',beforeAuthority:authority('ACTIVE'),afterAuthority:authority('ACTIVE'),productBefore:before,productAfter:first},
 {index:2,stage:'VALIDATE_SLICE',slice:'one',beforeAuthority:authority('ACTIVE'),afterAuthority:authority('ACTIVE',[pass('one')])},
 {index:3,stage:'EXECUTE_SLICE',slice:'two',beforeAuthority:authority('ACTIVE',[pass('one')]),afterAuthority:authority('ACTIVE',[pass('one')]),productBefore:first,productAfter:second},
 {index:4,stage:'VALIDATE_SLICE',slice:'two',beforeAuthority:authority('ACTIVE',[pass('one')]),afterAuthority:authority('COMPLETE',[pass('one'),pass('two')])},
 {index:5,stage:'CLOSE',beforeAuthority:authority('COMPLETE',[pass('one'),pass('two')]),afterAuthority:authority('SPEC_CLOSED')}
 ].map(r=>({...r,threadId:'controller',turnId:'turn-'+r.index,beforeAuthority:{...r.beforeAuthority,current:{...r.beforeAuthority.current,output:{...r.beforeAuthority.current.output,normalHandoff:['EXECUTE_SLICE','VALIDATE_SLICE'].includes(r.stage)?{slice:r.slice,deliveryId:'delivery-'+r.slice,operation:r.stage}:null}}}}));}
test('import metadata asks natural two-slice trajectory without changing oracle criteria',()=>{assert.equal(CASES.find(c=>c.id==='import').trajectory.minSlices,2);assert.equal(CASES.find(c=>c.id==='rename').trajectory.minSlices,1);assert.ok(Object.isFrozen(CASES[2].trajectory));});
test('later shared-file change preserves historical PASS and real final CLOSE',()=>{const snapshots=fixture(),before=JSON.stringify(snapshots),r=buildTrajectoryReport({caseId:'import',trajectory:{minSlices:2},snapshots});assert.equal(r.status,'PASS',JSON.stringify(r.checks));assert.equal(r.sharedFileChange.status,'OBSERVED');assert.deepEqual(r.sharedFileChange.paths,['src/service.mjs']);assert.equal(r.formalPassHistory.find(p=>p.slice==='one').observedAfter,2);assert.equal(r.sharedFileChange.observations[0].priorPass.evidenceSha256,pass('one').evidenceSha256);assert.equal(r.productAcceptance,'SEPARATE');assert.equal(JSON.stringify(snapshots),before);});
test('natural separate files can pass trajectory without claiming shared change',()=>{const r=buildTrajectoryReport({caseId:'import',snapshots:fixture(false)});assert.equal(r.status,'PASS');assert.equal(r.sharedFileChange.status,'NOT_OBSERVED');assert.deepEqual(r.sharedFileChange.paths,[]);});
test('executing next slice before prior approval is mismatch',()=>{const rows=fixture();rows[1].index=3;rows[2].index=2;rows[2].afterAuthority=authority('ACTIVE');const r=buildTrajectoryReport({caseId:'import',snapshots:rows});assert.equal(r.status,'MISMATCH');assert.ok(r.checks.some(c=>c.name==='previous PASS before next execution'&&c.status==='MISMATCH'));});
test('CLOSE before final PASS or without COMPLETE is mismatch',()=>{for(const variant of ['ordering','authority']){const rows=fixture();if(variant==='ordering'){rows[3].index=6;}else rows[4].beforeAuthority=authority('ACTIVE');assert.equal(buildTrajectoryReport({caseId:'import',snapshots:rows}).status,'MISMATCH');}});
test('missing evidence and incomplete trajectory are not fabricated PASS',()=>{const rows=fixture();rows[1].afterAuthority=authority('ACTIVE',[{slice:'one',formalStatus:'PASS'}]);rows[2].afterAuthority=authority('ACTIVE');rows[3].afterAuthority=authority('COMPLETE',[pass('two')]);const r=buildTrajectoryReport({caseId:'import',snapshots:rows});assert.equal(r.status,'INCOMPLETE');assert.equal(buildTrajectoryReport({caseId:'import',snapshots:[]}).status,'INCOMPLETE');});
test('missing product maps cannot prove overlap; duplicate index conflict rejected',()=>{const rows=fixture();delete rows[2].productBefore;let r=buildTrajectoryReport({caseId:'import',snapshots:rows});assert.equal(r.status,'INCOMPLETE');assert.equal(r.sharedFileChange.status,'NOT_OBSERVED');r=buildTrajectoryReport({caseId:'import',snapshots:[...fixture(),{...fixture()[0],stage:'CLOSE'}]});assert.equal(r.status,'MISMATCH');});

test('real reader completed entries preserve historical PASS with delivery identity',()=>{const rows=fixture();for(const index of [1,2,3]){const output=rows[index].afterAuthority.current.output;output.completed=output.deliveries.filter(d=>d.slice==='one');output.deliveries=output.deliveries.filter(d=>d.slice!=='one');}const r=buildTrajectoryReport({caseId:'import',snapshots:rows});assert.equal(r.status,'PASS',JSON.stringify(r.checks));assert.equal(r.formalPassHistory[0].deliveryId,'delivery-one');assert.deepEqual(r.formalPassHistory[0].collections,['completed']);assert.equal(r.sharedFileChange.status,'OBSERVED');});
test('same PASS present in deliveries and completed is counted once',()=>{const rows=fixture();rows[1].afterAuthority.current.output.completed=[pass('one')];const r=buildTrajectoryReport({caseId:'import',snapshots:rows});assert.equal(r.status,'PASS');assert.equal(r.formalPassHistory.filter(h=>h.deliveryId==='delivery-one').length,1);assert.deepEqual(r.formalPassHistory[0].collections,['deliveries','completed']);});
test('same slice label cannot borrow formal PASS from a different delivery ID',()=>{const rows=fixture();for(const row of rows)for(const d of row.afterAuthority.current.output.deliveries)if(d.slice==='two')d.deliveryId='unrelated-delivery';const r=buildTrajectoryReport({caseId:'import',snapshots:rows});assert.equal(r.status,'MISMATCH');assert.ok(r.checks.some(c=>c.name==='final slice PASS before CLOSE'&&c.status==='INCOMPLETE'));});

test('recovery missing pre-dispatch hashes remains incomplete on VALIDATE and CLOSE',()=>{
 for(const stage of ['VALIDATE_SLICE','CLOSE']){
  const rows=fixture(),row=rows.find(r=>r.stage===stage);
  row.trajectoryRecovery={status:'INCOMPLETE',reason:'PRE_DISPATCH_PRODUCT_HASHES_NOT_PERSISTED'};
  const report=buildTrajectoryReport({caseId:'import',snapshots:rows});
  assert.equal(report.status,'INCOMPLETE');
  assert.ok(report.checks.some(c=>c.name==='recovery trajectory evidence'&&c.stage===stage&&c.reason==='PRE_DISPATCH_PRODUCT_HASHES_NOT_PERSISTED'));
 }
});
test('preexisting PASS carried through EXECUTE and VALIDATE cannot certify fresh execution',()=>{
 const rows=fixture();
 rows[0].beforeAuthority.current.output.completed=[pass('one')];
 rows[0].afterAuthority.current.output.completed=[pass('one')];
 rows[1].beforeAuthority.current.output.completed=[pass('one')];
 const report=buildTrajectoryReport({caseId:'import',snapshots:rows});
 assert.equal(report.status,'MISMATCH');
 assert.ok(report.checks.some(c=>c.name==='slice execution followed by formal PASS'&&c.deliveryId==='delivery-one'&&c.status==='MISMATCH'));
 assert.equal(report.sharedFileChange.status,'NOT_OBSERVED');
});
test('previous snapshot PASS cannot be laundered by omitting it from execution beforeAuthority',()=>{
 const rows=fixture();rows.unshift({index:0,stage:'INSPECT',threadId:'controller',turnId:'old',beforeAuthority:authority('ACTIVE'),afterAuthority:authority('ACTIVE',[pass('one')])});
 const report=buildTrajectoryReport({caseId:'import',snapshots:rows});
 assert.equal(report.status,'MISMATCH');
});
test('genuine new validation hash after execution can replace prior proof without borrowing it',()=>{
 const rows=fixture(),old={...pass('one'),evidenceSha256:'sha256:'+h(9)};
 rows[0].beforeAuthority.current.output.completed=[old];rows[0].afterAuthority.current.output.completed=[old];rows[1].beforeAuthority.current.output.completed=[old];
 const report=buildTrajectoryReport({caseId:'import',snapshots:rows});
 assert.equal(report.status,'PASS',JSON.stringify(report.checks));
 assert.equal(report.linkedValidationProofs.find(p=>p.deliveryId==='delivery-one').evidenceSha256,pass('one').evidenceSha256);
});
test('two SPECs cannot lend each other slices or CLOSE evidence',()=>{
 for(const mode of ['later-slice','before-after','close']){
  const rows=fixture();
  if(mode==='later-slice')for(const index of [2,3])for(const side of ['beforeAuthority','afterAuthority'])rows[index][side].specPath='/work/specs/foreign';
  if(mode==='before-after')rows[1].afterAuthority.specPath='/work/specs/foreign';
  if(mode==='close')for(const side of ['beforeAuthority','afterAuthority'])rows[4][side].specPath='/work/specs/foreign';
  const report=buildTrajectoryReport({caseId:'import',snapshots:rows});assert.equal(report.status,'MISMATCH');assert.ok(report.checks.some(c=>c.name==='single SPEC binding'));
 }
});
test('SPEC identity missing is incomplete, noncanonical traversal mismatches',()=>{
 const missing=fixture();delete missing[1].beforeAuthority.specPath;assert.equal(buildTrajectoryReport({caseId:'import',snapshots:missing}).status,'INCOMPLETE');
 const traversal=fixture();traversal[1].beforeAuthority.specPath='/work/specs/../specs/import';assert.equal(buildTrajectoryReport({caseId:'import',snapshots:traversal}).status,'MISMATCH');
 const equivalent=fixture();equivalent[1].beforeAuthority.specPath+='/feature_spec.md';const report=buildTrajectoryReport({caseId:'import',snapshots:equivalent});assert.equal(report.status,'PASS');assert.equal(report.specPath,'/work/specs/import');
});
test('another execution after PASS requires another formal proof, even for same delivery',()=>{
 const rows=fixture(),again={...structuredClone(rows[0]),index:3,beforeAuthority:authority('ACTIVE',[pass('one')]),afterAuthority:authority('ACTIVE',[pass('one')]),deliveryId:'delivery-one',turnId:'rerun'};
 for(const row of rows)if(row.index>=3)row.index++;
 rows.push(again);assert.equal(buildTrajectoryReport({caseId:'import',snapshots:rows}).status,'MISMATCH');
});

test('formal validation requires positive native operation slice and delivery binding',()=>{
 for(const missing of ['all','deliveryId','operation','slice']){
  const rows=fixture(),row=rows[1];
  if(missing==='all')row.beforeAuthority.current.output.normalHandoff=null;
  else delete row.beforeAuthority.current.output.normalHandoff[missing];
  // A supplied snapshot label cannot replace absent authoritative handoff.
  row.deliveryId='delivery-one';
  const report=buildTrajectoryReport({caseId:'import',snapshots:rows});
  assert.equal(report.status,'INCOMPLETE');
  assert.ok(report.checks.some(c=>c.name==='formal validation delivery binding'&&c.status==='INCOMPLETE'));
  assert.equal(report.linkedValidationProofs.some(p=>p.deliveryId==='delivery-one'),false);
 }
});
test('formal validation rejects authoritative or snapshot identity divergences',()=>{
 for(const field of ['operation','slice','deliveryId','snapshot.slice','snapshot.deliveryId']){
  const rows=fixture(),row=rows[1];
  if(field.startsWith('snapshot.'))row[field.split('.')[1]]='different';
  else row.beforeAuthority.current.output.normalHandoff[field]=field==='operation'?'EXECUTE_SLICE':'different';
  const report=buildTrajectoryReport({caseId:'import',snapshots:rows});assert.equal(report.status,'MISMATCH');
  assert.ok(report.checks.some(c=>c.name==='formal validation delivery binding'&&c.status==='MISMATCH'));
  assert.equal(report.linkedValidationProofs.some(p=>p.deliveryId==='delivery-one'),false);
 }
});
