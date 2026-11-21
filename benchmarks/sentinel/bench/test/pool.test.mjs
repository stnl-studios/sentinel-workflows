import test from'node:test';import assert from'node:assert/strict';import{runPool}from'../pool.mjs';
test('bounded concurrency isolates failures',async()=>{let active=0,max=0;const r=await runPool([1,2,3,4],2,async id=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;if(id===2)throw Error('broken');return{id,status:'PASS'};});assert.equal(max,2);assert.equal(r.results.length,4);assert.equal(r.results.filter(x=>x.status==='HARNESS_FAILED').length,1);});
test('stop leaves planned cells visible',async()=>{let count=0;const r=await runPool([1,2,3],1,async id=>{count++;return{id};},{admit:()=>count<1});assert.equal(r.started,1);assert.equal(r.notStarted,2);assert.equal(r.stopped,true);});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const schedule=['rename-1','query-1','import-1','rename-2','query-2','import-2'];
test('C3 immediately refills FIFO including overlap with same scenario',async()=>{
 const began=[],release=new Map();
 const run=runPool(schedule,3,async(id,d)=>{began.push({id,...d});await new Promise(r=>release.set(id,r));if(id==='query-1')throw Error('independent failure');return{id,status:'PASS'};});
 assert.deepEqual(began.map(x=>x.id),schedule.slice(0,3));
 release.get('query-1')();await settle();
 assert.equal(began[3].id,'rename-2');assert.equal(began[3].slot,began[1].slot); // rename-1 is still running
 release.get('import-1')();await settle();assert.equal(began[4].id,'query-2');
 release.get('rename-2')();await settle();assert.equal(began[5].id,'import-2');
 for(const id of ['rename-1','query-2','import-2'])release.get(id)();
 const result=await run;assert.deepEqual(began.map(x=>x.queueIndex),[0,1,2,3,4,5]);assert.equal(result.results.length,6);assert.equal(result.results.filter(x=>x.status==='HARNESS_FAILED').length,1);
});
test('report/persistence failure stops refill and waits for other launched workers',async()=>{
 const release=new Map(),began=[],recorded=[];let terminal=false;
 const run=runPool(schedule,3,async(id)=>{began.push(id);await new Promise(r=>release.set(id,r));return {id};},{onResult:({id})=>{recorded.push(id);if(id==='query-1')throw Error('report blocked');}});
 const ended=run.catch(error=>{terminal=true;return error;});
 release.get('query-1')();await settle();assert.equal(terminal,false);assert.deepEqual(began,schedule.slice(0,3));
 release.get('import-1')();await settle();assert.equal(terminal,false);
 release.get('rename-1')();assert.match((await ended).message,/report blocked/);assert.deepEqual(recorded,['query-1','import-1','rename-1']);
});
test('unconfirmed direct-process exit stops refill and drains independent active cells',async()=>{
 const release=new Map(),recorded=[];const e=Object.assign(Error('unknown exit'),{code:'APP_SERVER_EXIT_UNCONFIRMED'});
 const run=runPool(schedule,3,async(id)=>{await new Promise(r=>release.set(id,r));if(id==='query-1')throw e;return {id};},{isFatal:x=>x.code===e.code,onResult:r=>recorded.push(r)});
 const ended=run.catch(x=>x);release.get('query-1')();await settle();assert.equal(release.size,3);release.get('import-1')();release.get('rename-1')();assert.equal(await ended,e);assert.equal(recorded.length,3);
});

test('direct process uncertainty takes precedence over an earlier report failure after draining',async()=>{
 const release=new Map(),recorded=[];let terminal=false;
 const e=Object.assign(Error('unknown exit'),{code:'APP_SERVER_EXIT_UNCONFIRMED'});
 const run=runPool(schedule,3,async(id)=>{await new Promise(r=>release.set(id,r));if(id==='import-1')throw e;return {id};},{isFatal:x=>x.code===e.code,onResult:r=>{recorded.push(r);if(r.id==='query-1')throw Error('I/O failed');}});
 const ended=run.catch(x=>{terminal=true;return x;});release.get('query-1')();await settle();release.get('import-1')();await settle();
 assert.equal(release.size,3);assert.equal(terminal,false);release.get('rename-1')();
 assert.equal(await ended,e);assert.equal(recorded.length,3);
});
