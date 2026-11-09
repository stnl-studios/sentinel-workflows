import test from 'node:test';import assert from 'node:assert/strict';
import {initialArtifacts,REQUIREMENTS,STANDALONE} from './fixtures/current-initial-preparation.mjs';
import {restoreDocumentaryPreparationArtifacts,projectDocumentaryPreparation} from '../skills/workflows/stnl-slice-executor/runtime/execution-preparation-current.mjs';
const input=artifacts=>({context:STANDALONE,requirementsAuthority:REQUIREMENTS,artifacts});
test('retained completed pairs restore a disposable index without modifying source bytes',()=>{
 const artifacts=initialArtifacts({form:'standalone'});for(const name of ['plan.md','tasks.md'])artifacts.set(name,Buffer.from(artifacts.get(name).toString().split('\n').filter(line=>!line.includes('| 01 -')).join('\n').replaceAll('- Plan revision: 1','- Plan revision: 2')));
 for(const name of ['plans/slice-02.md','tasks/slice-02.md'])artifacts.set(name,Buffer.from(artifacts.get(name).toString().replaceAll('- Plan revision: 1','- Plan revision: 2')));
 const before=new Map([...artifacts].map(([name,bytes])=>[name,Buffer.from(bytes)]));
 const restored=restoreDocumentaryPreparationArtifacts(input(artifacts)),authority=projectDocumentaryPreparation(input(restored));
 assert.deepEqual(authority.deliveries.map(item=>item.slice),['slice-01','slice-02']);assert.deepEqual(artifacts,before);assert.equal(authority.normativeProjection.deliveries[1].dependencies[0],authority.deliveries[0].deliveryId);
});
test('conflicting existing index or missing pair never invents documentary scope',()=>{
 const artifacts=initialArtifacts({form:'standalone'});artifacts.set('plan.md',Buffer.from(artifacts.get('plan.md').toString().replace('Pay export prepared.','An unrelated output.')));
 assert.throws(()=>restoreDocumentaryPreparationArtifacts(input(artifacts)),/disagree/);
 const missing=initialArtifacts({form:'standalone'});missing.delete('tasks/slice-01.md');assert.throws(()=>restoreDocumentaryPreparationArtifacts(input(missing)),/slice-01.*Task.*missing/);
});
