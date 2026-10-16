import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {inspectCurrentExecution} from '../skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs';
import * as legacy from '../skills/workflows/stnl-slice-executor/runtime/execution-state.mjs';
import {authoredImage,producerInitialImage,producerFormalPass,producerTwoFormalPass,producerAppliedImage,producerPostApplyPass,
  authoredCyclesImage,authoredCompletedImage,authoredCompletedWithActiveProof,storeRetainedActiveBundle,
  repackBundle,replaceRecordCapture,storeBundle,
  writeImage,reseal,editSection,cleanup,raw,canonical} from './fixtures/current-quiet-reader.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,'..');
const reader=path.join(repo,'skills/workflows/stnl-slice-executor/runtime/execution-current-reader.mjs');
const quality=path.join(repo,'skills/workflows/stnl-slice-quality-manager/runtime/execution-current-reader.mjs');
const worker=path.join(here,'fixtures/current-quiet-reader.mjs');
const DELIVERY='11111111-1111-4111-8111-111111111111';
const noAttempts=observed=>assert.deepEqual(observed.log.attempts,[],'read-only/history guard must have zero attempts');
const digest=bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function using(builder,action) {
  const fixture=await builder();let preserve=false;
  try {return await action(fixture);}
  catch(error) {preserve=error?.preserveFixture===true;throw error;}
  finally {if(!preserve) await cleanup(fixture);}
}
async function rejected(action,code,relation) {
  let observed;
  try {await action();} catch(error) {observed=error;}
  assert.ok(observed,`expected ${code} / ${relation??'*'}, but action resolved`);
  const detail=`expected ${code} / ${relation??'*'}; observed ${observed.code??'(no code)'}: ${observed.message}; diagnostics: ${JSON.stringify(observed.diagnostics??[])}`;
  assert.equal(observed.code,code,detail);
  if(relation!==undefined) assert.ok(String(observed.message).includes(relation)
    || observed.diagnostics?.some(item=>item.field===relation || item.kind===relation
      || String(item.reason).includes(relation)),detail);
}
async function manifest(root) {
  const result=[];
  async function visit(location,relative='') {
    const meta=await fs.lstat(location);
    const item={path:relative||'.',kind:meta.isDirectory()?'directory':meta.isFile()?'file':meta.isSymbolicLink()?'symlink':'other',
      mode:meta.mode&0o777,dev:meta.dev,ino:meta.ino,nlink:meta.nlink};
    if (meta.isFile()) item.sha256=digest(await fs.readFile(location));
    if (meta.isSymbolicLink()) item.target=await fs.readlink(location);
    result.push(item);
    if (meta.isDirectory()) for (const name of (await fs.readdir(location)).sort()) await visit(path.join(location,name),relative?`${relative}/${name}`:name);
  }
  await visit(root);return result;
}
function changeBody(text,heading,mutate) {
  const start=text.indexOf(`## ${heading}\n\n`)+heading.length+5;
  assert.ok(start>=heading.length+5,`missing section ${heading}`);
  const next=text.indexOf('\n## ',start),end=next<0?text.length:next;
  return text.slice(0,start)+mutate(text.slice(start,end))+text.slice(end);
}
async function workerRun(fixture,{selected=reader,mode='api',env={}}={}) {
  const before=await manifest(fixture.project);
  const log=path.join(fixture.temporary,`worker-${Math.random().toString(36).slice(2)}.json`);
  let entry=selected;
  if(mode==='import-only') {
    const folder=path.join(fixture.temporary,'foreign-main');await fs.mkdir(folder);
    entry=path.join(folder,'execution-current-reader.mjs');
    await fs.writeFile(entry,`import * as api from ${JSON.stringify(pathToFileURL(selected).href)};\nprocess.stdout.write(JSON.stringify({exports:Object.keys(api).sort()})+'\\n');\n`);
  }
  const preloaded=mode==='cli' || mode==='import-only';
  const args=preloaded?['--import',worker,entry,fixture.specPath]
    :[worker,'--worker',mode,selected,fixture.specPath,log,fixture.project];
  const result=spawnSync(process.execPath,args,{cwd:os.tmpdir(),encoding:'utf8',
    timeout:20000,env:{...process.env,...env,STNL_QUIET_PROFILE:fixture.composed?'evidence':'pristine',
      ...(fixture.activeProof?{STNL_QUIET_ACTIVE_PROOF:'1'}:{}),...(preloaded?{STNL_QUIET_PRELOAD:'1',STNL_QUIET_IMPORT_WRAPPER:mode==='import-only'?'1':'0',STNL_QUIET_LOG:log,
      STNL_QUIET_PROJECT:fixture.project}:{})}});
  assert.deepEqual(await manifest(fixture.project),before,'child preserved bytes, modes, identities and topology');
  return {process:result,log:JSON.parse(await fs.readFile(log,'utf8'))};
}
async function barrier(fixture,target,change,occurrence=2,{abortBeforeGo=false}={}) {
  const token=randomUUID();
  const log=path.join(fixture.temporary,'barrier-log.json');
  let child=null;
  const events=[],signals=[];
  let stderr='',phase='WAIT_READY',readySeen=false,commandIssued=null,sendSettled=false;
  let disconnectSeen=false,exitResult=null,closed=false,closeResult=null,channelAtClose=null,protocolError=null,active=null;
  let pendingOperations=0,failure=null,fdAtFailure=null,timer,result;
  const note=(event,detail={})=>events.push({event,...detail});
  const settle=(kind,value)=>{
    if(active?.kind!==kind) return;
    const waiter=active;active=null;waiter.resolve(value);
  };
  const fail=error=>{
    if(!protocolError) {protocolError=error instanceof Error?error:new Error(String(error));note('FAIL',{message:protocolError.message,phase});}
    if(active) {const waiter=active;active=null;waiter.reject(protocolError);}
  };
  const waitFor=kind=>{
    if(protocolError) return Promise.reject(protocolError);
    if(kind==='READY' && readySeen) return Promise.resolve();
    if(kind==='SEND' && sendSettled) return Promise.resolve();
    if(kind==='CLOSE' && closed) return Promise.resolve(closeResult);
    assert.equal(active,null,'barrier has only one active wait');
    return new Promise((resolve,reject)=>{active={kind,resolve,reject};});
  };
  const step=(kind,operation)=>{
    if(protocolError) return Promise.reject(protocolError);
    assert.equal(active,null,'barrier has only one active wait');
    pendingOperations+=1;
    return new Promise((resolve,reject)=>{
      const waiter={kind,resolve,reject};active=waiter;
      Promise.resolve().then(()=>{if(protocolError) throw protocolError;return operation();}).then(value=>{
        pendingOperations-=1;
        if(active===waiter) {active=null;resolve(value);}
      },error=>{
        pendingOperations-=1;
        if(active===waiter) {active=null;reject(error);}
        else note('LATE_OPERATION_ERROR',{kind,message:String(error?.message??error)});
      });
    });
  };
  const onStderr=part=>{stderr+=part;};
  const onMessage=message=>{
    if(protocolError || phase!=='WAIT_READY' || readySeen || message?.type!=='READY' || message.token!==token
      || message.path!==target || message.ordinal!==occurrence) {
      fail(new Error(`unexpected barrier message in ${phase}: ${JSON.stringify(message)}`));return;
    }
    readySeen=true;phase='PREPARE';note('READY');settle('READY');
  };
  const onDisconnect=()=>{
    note('DISCONNECT',{phase});
    if(disconnectSeen) {fail(new Error('duplicate barrier IPC disconnect'));return;}
    disconnectSeen=true;
    if(!commandIssued) fail(new Error(`barrier IPC disconnected before ${readySeen?'GO/ABORT':'READY'}`));
  };
  const onExit=(code,signal)=>{
    note('EXIT',{code,signal,phase});
    if(closed) {fail(new Error('barrier worker exited after close'));return;}
    if(exitResult) {fail(new Error('duplicate barrier worker exit'));return;}
    exitResult={code,signal};
    if(!commandIssued) fail(new Error(`barrier worker exited before ${readySeen?'GO/ABORT':'READY'}`));
  };
  const onClose=(code,signal)=>{
    note('CLOSE',{code,signal,phase});
    if(closed) {fail(new Error('duplicate barrier worker close'));return;}
    closed=true;closeResult={code,signal};
    channelAtClose={connected:child.connected,channelPresent:child.channel!=null};
    if(!exitResult && !protocolError) fail(new Error('barrier worker closed without exit'));
    if(!commandIssued && !protocolError) fail(new Error(`barrier worker closed before ${readySeen?'GO/ABORT':'READY'}`));
    settle('CLOSE',closeResult);
  };
  const onError=error=>{note('CHILD_ERROR',{message:error.message,phase});fail(error);};
  const signal=name=>{
    if(!child || child.pid==null) {signals.push({name,skipped:'process was not spawned'});return;}
    if(exitResult || child.exitCode!==null || child.signalCode!==null) {
      signals.push({name,skipped:'exit already observed'});return;
    }
    try {const delivered=child.kill(name);signals.push({name,delivered});}
    catch(error) {signals.push({name,error:error.message});}
  };
  const waitForCleanupClose=ms=>!child || closed?Promise.resolve(true):new Promise(resolve=>{
    const done=()=>{clearTimeout(limit);resolve(true);};
    const limit=setTimeout(()=>{child.off('close',done);resolve(closed);},ms);
    child.once('close',done);
  });
  const command=async type=>{
    if(protocolError) throw protocolError;
    commandIssued=type;phase=`SEND_${type}`;note('COMMAND',{type});
    try {child.send({type,token,path:target,ordinal:occurrence},error=>{
      if(sendSettled) {fail(new Error(`duplicate ${type} send callback`));return;}
      sendSettled=true;
      if(error) fail(new Error(`${type} send failed: ${error.message}`));
      else {note('SEND_COMPLETE',{type});settle('SEND');}
    });}
    catch(error) {fail(error);}
    await waitFor('SEND');
    phase='WAIT_CLOSE';
    const end=await waitFor('CLOSE');
    if(protocolError) throw protocolError;
    assert.ok(exitResult,'barrier worker exit must precede close');
    assert.deepEqual(end,exitResult,'barrier exit and close must agree');
    assert.deepEqual(channelAtClose,{connected:false,channelPresent:false},
      'worker IPC channel must be closed by child close');
    return end;
  };
  try {
    child=spawn(process.execPath,[worker,'--worker','api',reader,fixture.specPath,log,fixture.project],{
      cwd:os.tmpdir(),env:{...process.env,STNL_QUIET_PROFILE:fixture.composed?'evidence':'pristine',STNL_BARRIER_TARGET:target,
        STNL_BARRIER_OCCURRENCE:String(occurrence),STNL_BARRIER_TOKEN:token},stdio:['ignore','ignore','pipe','ipc']});
    child.on('error',onError);
    child.on('message',onMessage);
    child.on('disconnect',onDisconnect);
    child.on('exit',onExit);
    child.on('close',onClose);
    child.stderr?.on('data',onStderr);
    timer=setTimeout(()=>{
      fail(new Error(`barrier transaction timeout in ${active?.kind??phase}`));
    },15000);
    await waitFor('READY');
    if(abortBeforeGo) {
      const end=await command('ABORT');
      assert.equal(end.code,0,`aborted barrier worker ${end.code}/${end.signal}: ${stderr}`);
      const observed=JSON.parse(await step('READ_LOG',()=>fs.readFile(log,'utf8')));
      assert.deepEqual(observed.barrierEvents,[
        {phase:'READY',path:target,ordinal:occurrence},{phase:'ABORT',path:target,ordinal:occurrence},
      ],'ABORT before GO cannot reach the real open');
      assert.equal(observed.openAttempts[target],occurrence);
      assert.equal(observed.opens[target],occurrence-1);
      assert.match(observed.result.error?.message??'',/barrier ABORT before GO/u);
      result=observed;
    } else {
      const before=await step('MANIFEST_BEFORE',()=>manifest(fixture.project));
      await step('MUTATION',change);
      assert.notDeepEqual(await step('MANIFEST_AFTER',()=>manifest(fixture.project)),before,
        'barrier mutation must change the physical fixture before GO');
      const end=await command('GO');
      assert.equal(end.code,0,`barrier worker ${end.code}/${end.signal}: ${stderr}`);
      const observed=JSON.parse(await step('READ_LOG',()=>fs.readFile(log,'utf8')));
      assert.deepEqual(observed.barrierEvents,[
        {phase:'READY',path:target,ordinal:occurrence},{phase:'GO',path:target,ordinal:occurrence},
        {phase:'OPEN_START',path:target,ordinal:occurrence},{phase:'OPEN_COMPLETE',path:target,ordinal:occurrence},
      ],'one bound physical open must follow GO');
      result=observed;
    }
    if(protocolError) throw protocolError;
  } catch(error) {
    failure=error instanceof Error?error:new Error(String(error));
    fdAtFailure=await fs.readdir('/dev/fd').catch(()=>null);
  } finally {
    clearTimeout(timer);
    if(child && !closed) {
      phase='CLEANUP';
      if(child.connected) {
        try {child.disconnect();note('PARENT_DISCONNECT');}
        catch(error) {note('PARENT_DISCONNECT_ERROR',{message:error.message});}
      }
      if(!await waitForCleanupClose(1000)) {
        if(exitResult) child.stderr?.destroy();
        else signal('SIGTERM');
        if(!await waitForCleanupClose(1000)) {
          signal('SIGKILL');await waitForCleanupClose(1000);
        }
      }
    }
    if(child && (!closed || pendingOperations)) {
      failure??=new Error('barrier cleanup could not prove child close and settled operations');
      failure.preserveFixture=true;
    }
    if(failure) {
      try {
        const observed=await fs.readFile(log,'utf8').catch(()=>null);
        const report=path.join(repo,'tmp/u3-reconstruction/l25-test-runs',`barrier-failure-${token}.json`);
        await fs.writeFile(report,JSON.stringify({parentPid:process.pid,childPid:child?.pid??null,target,occurrence,
          reason:failure.message,phase,readySeen,commandIssued,sendSettled,disconnectSeen,exitResult,closeResult,
          channelAtClose,closed,pendingOperations,signals,events,stderr,fdAtFailure,observed},null,2)+'\n');
      } catch(reportError) {
        failure.preserveFixture=true;
        failure.message+=`; barrier diagnostic write failed: ${reportError.message}`;
      }
    }
    if(child) {
      try {
        child.off('message',onMessage);child.off('disconnect',onDisconnect);child.off('exit',onExit);
        child.off('close',onClose);child.stderr?.off('data',onStderr);
        if(closed) child.off('error',onError);
        else {child.unref();child.channel?.unref();child.stderr?.destroy();}
      } catch(error) {
        failure??=error;failure.preserveFixture=true;
      }
    }
  }
  if(failure) throw failure;
  return result;
}
const PRISTINE_OBSERVED_FILES=['src/pay.mjs','src/pay.test.mjs'];
const FORMAL_OBSERVED_FILES=['src/pay.mjs','config/settings.json'];
function barrierReads(observed,fixture,target,{deliveries,activation,artifactCapture,documentCaptures,productFiles}) {
  assert.deepEqual(observed.attempts,[],'no forbidden filesystem attempt');
  const expected={[fixture.source]:documentCaptures,
    [path.join(fixture.execution,'activation.json')]:activation};
  const relativeTarget=path.relative(fixture.execution,target).split(path.sep).join('/');
  for(const item of fixture.activation.artifacts) {
    const second=artifactCapture==='full' || artifactCapture==='prefix' && item.path<=relativeTarget;
    expected[path.join(fixture.execution,...item.path.split('/'))]=second?2:1;
  }
  for(const relative of productFiles) {
    const file=path.join(fixture.project,relative);
    expected[file]=deliveries*2;
  }
  assert.equal(expected[target],2,'the selected path must be reached in its declared second phase');
  assert.deepEqual(observed.openAttempts,expected,'exact opens attempted across documents, artifacts and product');
  assert.deepEqual(observed.opens,expected,'every attempted open completed, with no hidden retry');
}

test('R01 initial official image and absence',async t=>{
  await t.test('pristine baseline drift blocks EXECUTE',async()=>using(authoredImage,async f=>{
    await fs.writeFile(path.join(f.project,'src/pay.mjs'),'drift\n');
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.state,'EVIDENCE_STALE');assert.equal(result.normalHandoff?.operation,'VALIDATE_SLICE');
  }));

  for (const kind of ['standalone','lifecycle']) await t.test(kind,async()=>using(()=>authoredImage({kind}),async f=>{
    const before=await manifest(f.project),result=await inspectCurrentExecution(f.specPath);
    assert.deepEqual(result.deliveries.map(item=>[item.slice,item.deliveryId,item.persistedValidation,item.observedValidation]),
      [['slice-01',DELIVERY,'unvalidated','unvalidated'],['slice-02','22222222-2222-4222-8222-222222222222','unvalidated','unvalidated']]);
    assert.deepEqual(result.deliveries.map(item=>item.counters),[0,1].map(()=>({
      implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0})));
    assert.equal(result.requirementsAuthority,f.authority);assert.equal(result.state,'MATERIALIZED_PRISTINE');
    assert.deepEqual(result.normalHandoff,{operation:'EXECUTE_SLICE',slice:'slice-01',deliveryId:DELIVERY});
    assert.deepEqual(await manifest(f.project),before);
  }));
  await t.test('no execution is descriptive',async()=>using(()=>authoredImage({withExecution:false}),async f=>{
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.state,'NO_EXECUTION');assert.equal(result.normalHandoff,null);
  }));
});

test('R02 cosmetic carriers and stale normative approval',async t=>{
  for(const stage of ['pristine','Initial','formal','APPLY']) await t.test(`${stage} full presentation profile`,async()=>using(
    stage==='pristine'?authoredImage:stage==='Initial'?producerInitialImage:stage==='formal'?producerFormalPass:producerAppliedImage,async f=>{
      const before=await inspectCurrentExecution(f.specPath),snapshot=Buffer.from(f.files.get('approved-preparation.json'));
      const literal={
        pristine:['MATERIALIZED_PRISTINE','EXECUTE_SLICE',0,0,0,0],
        Initial:['IMPLEMENTED_AWAITING_VALIDATION','VALIDATE_SLICE',1,0,0,0],
        formal:['VALIDATION_BLOCKED',null,1,0,1,0],
        APPLY:['FINDINGS_CORRECTED','VALIDATE_SLICE',1,1,1,1],
      }[stage];
      assert.equal(before.state,literal[0]);assert.equal(before.normalHandoff?.operation??null,literal[1]);
      assert.equal(before.deliveries[0].deliveryId,DELIVERY);
      assert.deepEqual(before.deliveries[0].counters,{implementationChecks:literal[2],findingsChecks:literal[3],validationAttempts:literal[4],findings:literal[5]});
      for(const [name,bytes] of f.files) if(name.endsWith('.md')) {
        let text=bytes.toString('utf8');
        if(name.startsWith('tasks/')) text=changeBody(text,'Checklist',body=>body
          .replace(/(\[[ xX]\] )([0-9]+\.[0-9]+)/gu,'$1`$2`').replace(/obligations: (obligation-[0-9]+)/gu,'obligations: `$1`'));
        text=text.replace(/^## /gmu,'##   ')
          .replace(/^- /gmu,'+ ').replace(/^  - /gmu,'  * ')
          .replace(/\|---/gu,'|:-----').replace(/ \| /gu,'   |   ');
        text=text.replace(/^(\+ (?:Status|Current validation|Current evidence|Delivery ID|Local revision|Plan revision|Requirements authority):) (.+)$/gmu,'$1 `$2`');
        text=text.replace('Pay command runs.','Pay command\n  runs.').replace('Prepare the pay export.','Prepare the pay\n  export.')
          .replace('Build pay command.','Build pay\n  command.').replace('Implement the approved pay check','Implement the\n  approved pay check');
        text=text.replace(/^\+ Recipe: (.+)$/gmu,(_,recipe)=>'+ Recipe: '+JSON.stringify(JSON.parse(recipe),null,2));
        // Reorder named reference fields, with values still bound individually.
        text=text.replace(/(\+ Local revision: [^\n]+)\n(\+ Global (?:plan|tasks): [^\n]+)/gu,'$2\n$1');
        f.files.set(name,Buffer.from(text.replaceAll('\n\n','\n\n\n').replaceAll('\n','\r\n')));
      }
      reseal(f);await writeImage(f);
      const after=await inspectCurrentExecution(f.specPath);
      assert.deepEqual(after,before);assert.deepEqual(f.files.get('approved-preparation.json'),snapshot);
    }));
  await t.test('cosmetic edit without raw reseal is integrity failure',async()=>using(authoredImage,async f=>{
    const name='tasks/slice-01.md';f.files.set(name,Buffer.from(f.files.get(name).toString('utf8')+'\n'));
    await writeImage(f);await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','integrity');
  }));
  for(const [field,body] of [['Expected Files','- `../../../../src/extra.mjs`'],
    ['Checklist','- [ ] 1.1 Different technical step | obligations: obligation-01'],['Operational Changes','- Changed technical approach']])
    await t.test(`technical ${field} exceeds profile`,async()=>using(authoredImage,async f=>{
      editSection(f,'slice-01',field,body);reseal(f);await writeImage(f);
      await rejected(()=>inspectCurrentExecution(f.specPath),'UNSUPPORTED_FORMAT',field);
    }));

  await t.test('presentation is equivalent',async()=>using(authoredImage,async f=>{
    const before=await inspectCurrentExecution(f.specPath);
    let task=f.files.get('tasks/slice-01.md').toString('utf8');
    task=task.replace('- Current action: implement approved delivery','* Current action : Continue this approved work.')
      .replace('- [ ] 1.1 Implement','+ [X] 1.1 Implement').replaceAll('\n','\r\n');
    f.files.set('tasks/slice-01.md',Buffer.from(task));reseal(f);await writeImage(f);
    const after=await inspectCurrentExecution(f.specPath);
    assert.equal(after.requirementsAuthority,before.requirementsAuthority);
    assert.deepEqual(after.normalHandoff,before.normalHandoff);
    assert.deepEqual(after.diagnostics,[]);
  }));
  await t.test('APPLY carrier presentation is equivalent',async()=>using(producerAppliedImage,async f=>{
    const before=await inspectCurrentExecution(f.specPath),name='tasks/slice-01.md';
    const task=f.files.get(name).toString('utf8')
      .replace('- State: active','* State : `active`')
      .replace('- Current action: VALIDATE_SLICE','* Current action: Review the corrected delivery.');
    f.files.set(name,Buffer.from(task.replaceAll('\n','\r\n')));
    reseal(f);await writeImage(f);
    const after=await inspectCurrentExecution(f.specPath);
    assert.deepEqual(after.normalHandoff,before.normalHandoff);
    assert.deepEqual(after.deliveries[0].counters,before.deliveries[0].counters);
  }));
  await t.test('normative field',async()=>using(authoredImage,async f=>{
    const name='plans/slice-01.md';f.files.set(name,Buffer.from(f.files.get(name).toString('utf8')
      .replace('Prepare the pay export.','Prepare a different export.')));
    reseal(f);await writeImage(f);await rejected(()=>inspectCurrentExecution(f.specPath),'STALE_APPROVAL','Objective and Observable Result');
  }));
  for (const [label,needle,replacement,field] of [
    ['authorized area','- directory: `../../../../src`','- directory: `../../../../config`','Authorized Areas'],
    ['expected tests command','--test','--check','Expected Tests'],
    ['recipe argument','--test','--check','Verification Recipe'],
    ['acceptance condition','Pay export compiles','Pay export checks','Acceptance Obligations'],
  ]) await t.test(label,async()=>using(authoredImage,async f=>{
    const name=label==='acceptance condition'?'tasks/slice-01.md':'plans/slice-01.md';
    const old=f.files.get(name).toString('utf8');assert.ok(old.includes(needle));
    let changed;
    if(label==='recipe argument') {
      const expectedTests=old.match(/## Expected Tests\n\n([\s\S]*?)(?=\n## |$)/u)?.[1];
      assert.ok(expectedTests?.includes(needle),'Expected Tests preimage is required');
      changed=changeBody(old,'Verification Recipe',body=>{
        assert.ok(body.includes(needle),'recipe preimage must contain the argument');
        return body.replace(needle,replacement);
      });
      assert.equal(changed.match(/## Expected Tests\n\n([\s\S]*?)(?=\n## |$)/u)?.[1],expectedTests);
      assert.notEqual(changed,old,'recipe argument must change');
    } else if(label==='expected tests command') changed=changeBody(old,'Expected Tests',body=>{
      assert.ok(body.includes(needle),'Expected Tests preimage must contain the command');
      return body.replace(needle,replacement);
    });
    else changed=old.replace(needle,replacement);
    f.files.set(name,Buffer.from(changed));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'STALE_APPROVAL',field);
  }));
  await t.test('malformed normative carrier',async()=>using(authoredImage,async f=>{
    editSection(f,'slice-01','Authorized Areas','directory src without a bullet');
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Authorized Areas');
  }));
  await t.test('review binding',async()=>using(authoredImage,async f=>{
    f.snapshot.deliveries[0].review.decision='pending';
    f.files.set('approved-preparation.json',Buffer.from(canonical(f.snapshot)+'\n'));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
});

test('R03b completed A and active B with retained local proof',async t=>{
  await t.test('both local proofs are current without global completion',async()=>using(authoredCompletedWithActiveProof,async f=>{
    const before=await manifest(f.project),result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.completed[0].deliveryId,DELIVERY);
    assert.equal(result.completed[0].observedValidation,'current');
    assert.equal(result.deliveries[0].deliveryId,'22222222-2222-4222-8222-222222222222');
    assert.equal(result.deliveries[0].formalStatus,'PASS');
    assert.equal(result.deliveries[0].observedValidation,'current');
    assert.notEqual(result.state,'COMPLETE');assert.equal(result.normalHandoff,null);
    assert.equal(result.diagnostics[0].field,'terminal');
    for(const selected of [reader,quality]) {
      const observed=await workerRun(f,{selected});assert.equal(observed.process.status,0);noAttempts(observed);
      assert.deepEqual(observed.log.result,result);
      const cli=await workerRun(f,{selected,mode:'cli'});assert.equal(cli.process.status,0);noAttempts(cli);
      assert.deepEqual(JSON.parse(cli.process.stdout),result);
    }
    assert.deepEqual(await manifest(f.project),before);
  }));
  await t.test('B-only drift preserves A current and requires B revalidation',async()=>using(authoredCompletedWithActiveProof,async f=>{
    const aBytes=Buffer.from(f.files.get(f.continuity.completed[0].evidence.path));
    await fs.writeFile(path.join(f.project,'verify/check.mjs'),'B drift\n');
    const before=await manifest(f.project),result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.completed[0].observedValidation,'current');
    assert.equal(result.deliveries[0].persistedValidation,'current');
    assert.equal(result.deliveries[0].observedValidation,'revalidation-required');
    assert.equal(result.state,'EVIDENCE_STALE');assert.equal(result.normalHandoff.slice,'slice-02');
    assert.ok(aBytes.equals(await fs.readFile(path.join(f.execution,f.continuity.completed[0].evidence.path))));
    assert.deepEqual(await manifest(f.project),before);
  }));
  for(const target of ['src/pay.mjs','config/settings.json']) await t.test(`B PASS cannot mask A drift in ${target}`,async()=>using(authoredCompletedWithActiveProof,async f=>{
    await fs.writeFile(path.join(f.project,target),'drift\n');
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE','slice-01');
  }));
  await t.test('auxiliary evidence alone is not formal PASS',async()=>using(()=>authoredCompletedWithActiveProof({formal:false}),async f=>{
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.completed[0].observedValidation,'current');
    assert.equal(result.deliveries[0].formalStatus,null);
    assert.notEqual(result.deliveries[0].observedValidation,'current');
    assert.notEqual(result.state,'COMPLETE');
  }));
  await t.test('B foreign captured owner is not replaced by A proof',async()=>using(authoredCompletedWithActiveProof,async f=>{
    const oracle=await import('./fixtures/current-findings-evidence.mjs');
    const bundle=JSON.parse(f.files.get(f.continuity.deliveries[0].evidence.path));
    const cap=structuredClone(f.activeProof.capture),receipt=oracle.decode(cap.receipt);
    receipt.owner.deliveryId=DELIVERY;cap.receipt=Buffer.from(JSON.stringify(receipt)+'\n');
    replaceRecordCapture(bundle,bundle.validation,cap,oracle);await storeRetainedActiveBundle(f,bundle);
    await rejected(()=>inspectCurrentExecution(f.specPath),'OWNER_MISMATCH');
  }));
  await t.test('B without a matching retention decision requires official current admission',async()=>using(authoredCompletedWithActiveProof,async f=>{
    f.snapshot.globalReview.evidenceDecisions.pop();
    f.files.set('approved-preparation.json',Buffer.from(canonical(f.snapshot)+'\n'));reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'OWNER_MISMATCH');
  }));
  await t.test('B decision cannot bind the digest of A',async()=>using(authoredCompletedWithActiveProof,async f=>{
    f.snapshot.globalReview.evidenceDecisions[1].evidenceSha256=f.continuity.completed[0].evidence.sha256;
    f.files.set('approved-preparation.json',Buffer.from(canonical(f.snapshot)+'\n'));reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
  await t.test('B counter and carrier remain independently checked',async()=>using(authoredCompletedWithActiveProof,async f=>{
    f.continuity.deliveries[0].counters.validationAttempts+=1;reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
  await t.test('B carrier cannot omit the verified PASS',async()=>using(authoredCompletedWithActiveProof,async f=>{
    editSection(f,'slice-02','Final Result','- pending');reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Final Result');
  }));
  await t.test('unknown B evidence remains unsupported',async()=>using(authoredCompletedWithActiveProof,async f=>{
    const bundle=JSON.parse(f.files.get(f.continuity.deliveries[0].evidence.path));
    bundle.format='stnl-current-evidence-v99';await storeRetainedActiveBundle(f,bundle);
    await rejected(()=>inspectCurrentExecution(f.specPath),'UNSUPPORTED_FORMAT');
  }));
});

test('R03 mixed format, duplicate JSON, and closed profile',async t=>{
  await t.test('completed A with unproved historical shared owner requires Q19 despite a valid envelope',async()=>using(authoredCompletedImage,async f=>{
    const {validateCurrentImage}=await import('../skills/workflows/stnl-slice-executor/runtime/execution-current.mjs');
    const envelope=validateCurrentImage({activationBytes:await fs.readFile(path.join(f.execution,'activation.json')),files:f.files});
    assert.equal(envelope.continuity.completed[0].deliveryId,DELIVERY);
    const before=await manifest(f.project);
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE','historical owner');
    assert.deepEqual(await manifest(f.project),before);
  }));
  await t.test('completed evidence without formal proof is incomplete',async()=>using(authoredCompletedImage,async f=>{
    const done=f.continuity.completed[0],bundle=JSON.parse(f.files.get(done.evidence.path));
    bundle.validation=null;repackBundle(bundle);
    const bytes=Buffer.from(JSON.stringify(bundle)+'\n');f.files.set(done.evidence.path,bytes);
    done.evidence.sha256=digest(bytes);f.snapshot.completed[0].evidenceSha256=done.evidence.sha256;
    f.snapshot.globalReview.evidenceDecisions[0].evidenceSha256=done.evidence.sha256;
    f.files.set('approved-preparation.json',Buffer.from(canonical(f.snapshot)+'\n'));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE');
  }));
  await t.test('completed NEEDS_FIX cannot be advertised as current',async()=>using(
    ()=>authoredCompletedImage({pass:false}),async f=>{
      await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE');
    }));
  await t.test('completed retention decision is required',async()=>using(authoredCompletedImage,async f=>{
    f.snapshot.globalReview.evidenceDecisions=[];
    f.files.set('approved-preparation.json',Buffer.from(canonical(f.snapshot)+'\n'));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'STALE_APPROVAL');
  }));
  await t.test('unknown completed evidence format remains unsupported',async()=>using(authoredCompletedImage,async f=>{
    const done=f.continuity.completed[0],bundle=JSON.parse(f.files.get(done.evidence.path));
    bundle.format='stnl-current-evidence-v99';
    const bytes=Buffer.from(JSON.stringify(bundle)+'\n');f.files.set(done.evidence.path,bytes);
    done.evidence.sha256=digest(bytes);f.snapshot.completed[0].evidenceSha256=done.evidence.sha256;
    f.snapshot.globalReview.evidenceDecisions[0].evidenceSha256=done.evidence.sha256;
    f.files.set('approved-preparation.json',Buffer.from(canonical(f.snapshot)+'\n'));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'UNSUPPORTED_FORMAT');
  }));
  await t.test('completed identity collision and old detail artifact are inconsistent',async()=>using(authoredCompletedImage,async f=>{
    f.continuity.completed[0].deliveryId=f.continuity.deliveries[0].deliveryId;
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
  await t.test('completed old detail artifact is not official',async()=>using(authoredCompletedImage,async f=>{
    await fs.writeFile(path.join(f.execution,'plans','slice-01.md'),'stale plan\n');
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
  await t.test('completed product drift never becomes current',async()=>using(authoredCompletedImage,async f=>{
    await fs.writeFile(path.join(f.project,'src','pay.mjs'),'drifted product\n');
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE');
  }));
  for(const field of ['preparationRevision','localRevision']) await t.test(`valid envelope beyond ${field}`,async()=>using(authoredImage,async f=>{
    if(field==='preparationRevision') {f.snapshot.preparationRevision=2;f.activation.preparationRevision=2;}
    else {f.snapshot.deliveries[0].localRevision=2;f.continuity.deliveries[0].localRevision=2;}
    f.files.set('approved-preparation.json',Buffer.from(JSON.stringify(f.snapshot)+'\n'));reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),
      field==='preparationRevision'?'INVALID_CURRENT_IMAGE':'UNSUPPORTED_FORMAT',
      field==='preparationRevision'?'snapshot bytes or revision':field);
  }));

  await t.test('mixed snapshot',async()=>using(authoredImage,async f=>{
    const snapshot={...f.snapshot,format:'stnl-preparation-v2'};
    f.files.set('approved-preparation.json',Buffer.from(JSON.stringify(snapshot)+'\n'));reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','mixed');
  }));
  await t.test('duplicate activation key',async()=>using(authoredImage,async f=>{
    const activation=path.join(f.execution,'activation.json');
    await fs.writeFile(activation,Buffer.from('{"format":"stnl-execution-activation-v2","format":"stnl-execution-activation-v2"}\n'));
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','activation');
  }));
  await t.test('extra activation field',async()=>using(authoredImage,async f=>{
    f.activation.unapproved=true;await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE');
  }));
  await t.test('orphan evidence directory',async()=>using(authoredImage,async f=>{
    await fs.mkdir(path.join(f.execution,'evidence'));
    await fs.writeFile(path.join(f.execution,'evidence','orphan.json'),'{}\n');
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','root');
  }));
  await t.test('missing sealed artifact',async()=>using(authoredImage,async f=>{
    await fs.rm(path.join(f.execution,'plans','slice-01.md'));
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','plans');
  }));
  await t.test('foreign sealed artifact',async()=>using(authoredImage,async f=>{
    await fs.writeFile(path.join(f.execution,'plans','extra.md'),'foreign\n');
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','plans');
  }));
  await t.test('inconsistent local revision is invalid before capability restriction',async()=>using(authoredImage,async f=>{
    assert.equal(f.snapshot.deliveries[0].localRevision,1);
    f.continuity.deliveries[0].localRevision=2;reseal(f);await writeImage(f);
    assert.notEqual(f.continuity.deliveries[0].localRevision,f.snapshot.deliveries[0].localRevision);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','active delivery binding mismatch');
  }));
  await t.test('superseded task status is outside the quiet profile',async()=>using(authoredImage,async f=>{
    const name='tasks/slice-01.md';
    f.files.set(name,Buffer.from(f.files.get(name).toString('utf8').replace('status: ready','status: superseded')));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','header');
  }));
  await t.test('well-formed imported record requests migration',async()=>using(producerInitialImage,async f=>{
    const bundle=structuredClone(f.composed.bundle),record=bundle.implementation[0];
    record.recordFormat='stnl-task-record-v1-imported';record.origin.localRevision=null;
    const source=Buffer.from('{"format":"historical-preparation"}\n');
    record.sources.legacyPreparation=raw(source);
    bundle.objects.push({id:raw(source),bytesBase64:source.toString('base64')});
    bundle.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    f.files.set(`evidence/${DELIVERY}.json`,Buffer.from(JSON.stringify(bundle)+'\n'));
    f.continuity.deliveries[0].evidence.sha256=raw(f.files.get(`evidence/${DELIVERY}.json`));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'MIGRATION_REQUIRED');
  }));
});

test('R04 Initial native and managed capture, no external origin read',async t=>{
  for (const transport of ['native','managed']) await t.test(transport,async()=>using(
    ()=>producerInitialImage({transport}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),first=result.deliveries[0];
      assert.equal(first.auxiliaryStatus,'TESTS_PASS');assert.equal(first.formalStatus,null);
      assert.deepEqual(first.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0});
      assert.equal(first.persistedValidation,'unvalidated');assert.equal(first.observedValidation,'unvalidated');
      assert.deepEqual(result.normalHandoff,{operation:'VALIDATE_SLICE',slice:'slice-01',deliveryId:DELIVERY});
      const processResult=await workerRun(f);assert.equal(processResult.process.status,0);
      assert.deepEqual(processResult.log.attempts,[]);
    }));
  for (const transport of ['native','managed']) for(const failures of [1,2]) await t.test(`${transport} ${failures} FAIL then PASS`,async()=>using(
    ()=>producerInitialImage({transport,statuses:[...Array(failures).fill('TESTS_FAIL'),'TESTS_PASS']}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),first=result.deliveries[0];
      assert.deepEqual(first.counters,{implementationChecks:failures+1,findingsChecks:0,validationAttempts:0,findings:0});
      assert.equal(first.auxiliaryStatus,'TESTS_PASS');assert.equal(first.formalStatus,null);
      assert.equal(first.persistedValidation,'unvalidated');
      assert.equal(result.normalHandoff?.operation,'VALIDATE_SLICE');
      assert.deepEqual(f.composed.bundle.implementation.map(item=>item.id),failures===1
        ?['implementation-check-01','implementation-check-02']:['implementation-check-01','implementation-check-02','implementation-check-03']);
    }));
});

test('R05 NEEDS_FIX then APPLY retains formal admission',async t=>{
  for(const [label,build] of [['NEEDS_FIX',()=>producerFormalPass({status:'NEEDS_FIX'})],['APPLY',producerAppliedImage]])
    await t.test(`${label} drift is visible despite already stale sealed enum`,async()=>using(build,async f=>{
      const before=await inspectCurrentExecution(f.specPath);
      assert.equal(before.state,label==='APPLY'?'FINDINGS_CORRECTED':'VALIDATION_NEEDS_FIX');
      await fs.writeFile(path.join(f.project,'src/pay.mjs'),'post-capture drift\n');
      const result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.deliveries[0].persistedValidation,'revalidation-required');
      assert.equal(result.deliveries[0].observedValidation,'revalidation-required');
      assert.equal(result.state,'EVIDENCE_STALE');assert.equal(result.normalHandoff?.operation,'VALIDATE_SLICE');
    }));

  await t.test('retained admission and next formal action',async()=>using(producerAppliedImage,async f=>{
    const result=await inspectCurrentExecution(f.specPath),first=result.deliveries[0];
    assert.deepEqual(first.counters,{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1});
    assert.equal(first.formalStatus,'NEEDS_FIX');assert.equal(first.auxiliaryStatus,'TESTS_PASS');
    assert.equal(first.persistedValidation,'revalidation-required');assert.equal(result.state,'FINDINGS_CORRECTED');
    assert.deepEqual(result.normalHandoff,{operation:'VALIDATE_SLICE',slice:'slice-01',deliveryId:DELIVERY});
    assert.equal(f.applied.bundle.implementation.length,0);
    assert.equal(f.applied.bundle.openFindings[0].id,'finding-01');
  }));
  await t.test('APPLY cannot claim formal finding resolution',async()=>using(producerAppliedImage,async f=>{
    const name='tasks/slice-01.md';
    f.files.set(name,Buffer.from(f.files.get(name).toString('utf8').replace('- State: active','- State: resolved')));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Validation Findings');
  }));
});

test('R06 formal v2 PASS after APPLY with local terminal null',async t=>{
  for(const transport of ['native','managed']) await t.test(`${transport} authored v2 with literal serial successor`,async()=>using(
    ()=>authoredCyclesImage({transport,retainSecond:true}),async f=>{
      const result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.deliveries[0].observedValidation,'current');
      assert.deepEqual(result.deliveries[0].counters,{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1});
      assert.deepEqual(result.normalHandoff,{operation:'EXECUTE_SLICE',slice:'slice-02',deliveryId:'22222222-2222-4222-8222-222222222222'});
      assert.deepEqual(f.authored.bundle.support.map(item=>item.id),['attempt-01']);
      assert.equal(f.authored.bundle.validation.contract.terminal,null);
    }));
  await t.test('complete Initial-backed v1 base cannot replace post-APPLY v2',async()=>using(authoredCyclesImage,async f=>{
    const oracle=await import('./fixtures/current-findings-evidence.mjs');
    const bundle=structuredClone(f.authored.bundle),cap=structuredClone(f.finalCapture);
    const request=oracle.decode(cap.validationRequest);
    request.format='stnl-current-validation-request-v1';delete request.base.auxiliary;
    request.base.evidenceSha256=raw(f.firstFormal.bytes);request.base.counters=structuredClone(f.firstFormal.counters);
    request.base.openFindings=structuredClone(f.firstFormal.bundle.openFindings);request.base.priorScopePaths=['src/pay.mjs'];
    cap.validationRequest=Buffer.from(JSON.stringify(request)+'\n');
    const response=oracle.decode(cap.rawResponse);response.requestSha256=raw(cap.validationRequest);
    oracle.rebindRaw(cap,response);replaceRecordCapture(bundle,bundle.validation,cap,oracle);
    await storeBundle(f,bundle);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','requires request v2');
  }));

  for (const transport of ['native','managed']) await t.test(transport,async()=>using(
    ()=>producerPostApplyPass({transport}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),first=result.deliveries[0];
      assert.equal(first.formalStatus,'PASS');assert.equal(first.observedValidation,'current');
      assert.deepEqual(first.counters,{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1});
      assert.equal(f.postApply.bundle.validation.contract.terminal,null);
      assert.equal(result.state,'VALIDATION_BLOCKED');assert.equal(result.normalHandoff,null);
      assert.match(result.diagnostics[0].reason,/terminal/u);
    }));
  await t.test('equivalent retained bundle serialization',async()=>using(producerPostApplyPass,async f=>{
    const name=`evidence/${DELIVERY}.json`,pretty=Buffer.from(JSON.stringify(f.postApply.bundle,null,2)+'\n');
    f.files.set(name,pretty);f.continuity.deliveries[0].evidence.sha256=raw(pretty);
    reseal(f);await writeImage(f);
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].formalStatus,'PASS');assert.equal(result.normalHandoff,null);
  }));
  await t.test('rebound v2 auxiliary digest is wrong',async()=>using(producerPostApplyPass,async f=>{
    const oracle=await import('./fixtures/current-findings-evidence.mjs');
    const template=await import('./fixtures/current-validation-evidence.mjs');
    const bundle=structuredClone(f.postApply.bundle);
    const cap=structuredClone(f.postApplyCapture);
    const request=JSON.parse(Buffer.from(cap.validationRequest).toString('utf8'));
    assert.equal(request.format,'stnl-current-validation-request-v2');
    request.base.auxiliary.recordsSha256=raw(Buffer.from('wrong auxiliary records'));
    cap.validationRequest=Buffer.from(JSON.stringify(request)+'\n');
    const response=JSON.parse(Buffer.from(cap.rawResponse).toString('utf8'));
    response.requestSha256=raw(cap.validationRequest);template.rebindRaw(cap,response);
    replaceRecordCapture(bundle,bundle.validation,cap,oracle);
    f.files.set(`evidence/${DELIVERY}.json`,Buffer.from(JSON.stringify(bundle)+'\n'));
    f.continuity.deliveries[0].evidence.sha256=raw(f.files.get(`evidence/${DELIVERY}.json`));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE','auxiliary');
  }));
});

test('R07 product output, input, and mode drift after PASS',async t=>{
  for (const [label,change] of [
    ['output',f=>fs.writeFile(path.join(f.project,'src/pay.mjs'),'changed\n')],
    ['input',f=>fs.writeFile(path.join(f.project,'config/settings.json'),'settings=changed\n')],
    ['mode',f=>fs.chmod(path.join(f.project,'src/pay.mjs'),0o600)],
    ['hidden child',f=>fs.writeFile(path.join(f.project,'src/.unexpected'),'hidden\n')],
    ['kind',async f=>{const target=path.join(f.project,'src/pay.mjs');await fs.rm(target);await fs.mkdir(target);}],
  ]) await t.test(label,async()=>using(producerPostApplyPass,async f=>{
    await change(f);const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].persistedValidation,'current');
    assert.equal(result.deliveries[0].observedValidation,'revalidation-required');
    assert.equal(result.state,'EVIDENCE_STALE');assert.equal(result.normalHandoff?.slice,'slice-01');
  }));
});

test('R08 missing retained proof cannot be replaced by a claimed hash',async t=>{
  await t.test('recreated removed path is independently stale',async()=>using(()=>producerFormalPass({retainedRemoval:true}),async f=>{
    await fs.writeFile(path.join(f.project,'src/old.mjs'),'recreated\n');
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].observedValidation,'revalidation-required');assert.equal(result.state,'EVIDENCE_STALE');
  }));

  await t.test('retained removal with real preimage',async()=>using(
    ()=>producerFormalPass({retainedRemoval:true}),async f=>{
      const absent=f.formal.bundle.validation.testedWork.entries.find(item=>item.path==='src/old.mjs');
      assert.deepEqual(absent,{path:'src/old.mjs',kind:'absent'});
      const result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.deliveries[0].formalStatus,'PASS');
      assert.equal(result.deliveries[0].observedValidation,'current');
    }));
  await t.test('removal witness removed',async()=>using(
    ()=>producerFormalPass({retainedRemoval:true}),async f=>{
      const bundle=structuredClone(f.formal.bundle);
      const witness=bundle.implementation[0].sources.removalProofs[0];
      assert.ok(witness,'retained initial removal witness');
      bundle.objects=bundle.objects.filter(item=>item.id!==witness);
      f.files.set(`evidence/${DELIVERY}.json`,Buffer.from(JSON.stringify(bundle)+'\n'));
      f.continuity.deliveries[0].evidence.sha256=raw(f.files.get(`evidence/${DELIVERY}.json`));
      reseal(f);await writeImage(f);
      await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE');
    }));
  await t.test('invented witness with recomputed envelopes',async()=>using(
    ()=>producerFormalPass({retainedRemoval:true}),async f=>{
      const bundle=structuredClone(f.formal.bundle),record=bundle.implementation[0];
      const previous=record.sources.removalProofs[0];
      const object=bundle.objects.find(item=>item.id===previous);
      assert.ok(object,'removal witness object');
      const proof=JSON.parse(Buffer.from(object.bytesBase64,'base64').toString('utf8'));
      const invented=Buffer.from('invented old bytes\n');
      proof.bytesBase64=invented.toString('base64');proof.sha256=raw(invented);
      const packed=Buffer.from(JSON.stringify(proof)+'\n');
      object.id=raw(packed);object.bytesBase64=packed.toString('base64');
      record.sources.removalProofs=[object.id];
      bundle.objects.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
      f.files.set(`evidence/${DELIVERY}.json`,Buffer.from(JSON.stringify(bundle)+'\n'));
      f.continuity.deliveries[0].evidence.sha256=raw(f.files.get(`evidence/${DELIVERY}.json`));
      reseal(f);await writeImage(f);
      await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE');
    }));
  await t.test('missing source object',async()=>using(producerPostApplyPass,async f=>{
    const bundle=structuredClone(f.postApply.bundle);
    assert.equal(bundle.support.filter(item=>item.id==='attempt-01').length,1);
    const required=bundle.validation.sources.rawResponse;
    bundle.objects=bundle.objects.filter(item=>item.id!==required);
    f.files.set(`evidence/${DELIVERY}.json`,Buffer.from(JSON.stringify(bundle)+'\n'));
    f.continuity.deliveries[0].evidence.sha256=raw(f.files.get(`evidence/${DELIVERY}.json`));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE');
  }));
  await t.test('external literal remains unused',async()=>using(producerPostApplyPass,async f=>{
    const canary=path.join(f.project,'tmp','historic','receipt.json');
    await fs.mkdir(path.dirname(canary),{recursive:true});await fs.writeFile(canary,'old');
    const observed=await workerRun(f);assert.equal(observed.process.status,0);
    assert.deepEqual(observed.log.attempts,[]);
  }));
});

test('R09 counters and retained object roots have independent authority',async t=>{
  await t.test('nextSliceOrdinal gap is preserved without invented predecessors',async()=>using(authoredImage,async f=>{
    f.continuity.nextSliceOrdinal=105;reseal(f);await writeImage(f);
    const result=await inspectCurrentExecution(f.specPath);
    assert.deepEqual(result.deliveries.map(item=>item.slice),['slice-01','slice-02']);
    assert.equal(result.normalHandoff?.slice,'slice-01');assert.equal(f.continuity.nextSliceOrdinal,105);
  }));

  for(const [cycles,transport,producer] of [[3,'native',false],[6,'native',false],[6,'managed',false],[3,'native',true]])
    await t.test(`${cycles} pruned cycles ${transport} ${producer?'producer':'authored'}`,async()=>using(
      ()=>authoredCyclesImage({cycles,transport,removal:true,pass:false,producer}),async f=>{
        const result=await inspectCurrentExecution(f.specPath),number=String(cycles).padStart(2,'0');
        assert.deepEqual(result.deliveries[0].counters,{implementationChecks:1,findingsChecks:cycles,validationAttempts:cycles+1,findings:1});
        assert.deepEqual(f.authored.bundle.findingsChecks.map(item=>item.id),[`findings-check-${number}`]);
        assert.deepEqual(f.authored.bundle.support.map(item=>item.id),['findings-check-01','attempt-01',`attempt-${number}`]);
        assert.equal(f.authored.bundle.validation.id,`attempt-${String(cycles+1).padStart(2,'0')}`);
        assert.deepEqual(f.authored.bundle.openFindings.map(item=>[item.id,item.originAttempt]),[['finding-01','attempt-01']]);
        assert.deepEqual(result.normalHandoff,{operation:'APPLY_FINDINGS',slice:'slice-01',deliveryId:DELIVERY});
        assert.equal(f.authored.bundle.implementation.length,0);
        const objectCounts=f.chain.filter(item=>/^apply-[3-6]$/u.test(item.label)).map(item=>item.roots.support.length);
        assert.ok(objectCounts.every(count=>count===2));
        const child=await workerRun(f);noAttempts(child);assert.equal(child.log.result.state,'VALIDATION_NEEDS_FIX');
      }));
  for(const missing of ['attempt-01','findings-check-01']) await t.test(`pruned chain loses required ${missing}`,async()=>using(
    ()=>authoredCyclesImage({cycles:6,removal:true,pass:false}),async f=>{
      const bundle=structuredClone(f.authored.bundle);bundle.support=bundle.support.filter(item=>item.id!==missing);
      if(missing==='attempt-01') {
        assert.equal(bundle.openFindings[0].originAttempt,'attempt-01');
        assert.ok(f.authored.bundle.support.some(item=>item.id==='attempt-01'));
        assert.ok(!bundle.support.some(item=>item.id==='attempt-01'));
      }
      repackBundle(bundle);await storeBundle(f,bundle);
      await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE',missing==='attempt-01'
        ?'finding origin is absent from current/support records':'REMOVED lacks witness');
    }));

  await t.test('retained origin with formal counter gap 99 to 100',async()=>using(producerPostApplyPass,async f=>{
    const oracle=await import('./fixtures/current-findings-evidence.mjs');
    const template=await import('./fixtures/current-validation-evidence.mjs');
    const bundle=structuredClone(f.postApply.bundle);
    const cap=structuredClone(f.postApplyCapture);
    const request=JSON.parse(Buffer.from(cap.validationRequest).toString('utf8'));
    request.base.counters.validationAttempts=99;request.attemptId='attempt-100';
    cap.validationRequest=Buffer.from(JSON.stringify(request)+'\n');
    const response=JSON.parse(Buffer.from(cap.rawResponse).toString('utf8'));
    response.requestSha256=raw(cap.validationRequest);template.rebindRaw(cap,response);
    replaceRecordCapture(bundle,bundle.validation,cap,oracle);
    bundle.validation.id='attempt-100';
    bundle.validation.recordUtf8=bundle.validation.recordUtf8.replace('### attempt-02','### attempt-100');
    const task='tasks/slice-01.md';
    f.files.set(task,Buffer.from(f.files.get(task).toString('utf8').replaceAll('attempt-02','attempt-100')));
    f.continuity.deliveries[0].counters.validationAttempts=100;
    f.files.set(`evidence/${DELIVERY}.json`,Buffer.from(JSON.stringify(bundle)+'\n'));
    f.continuity.deliveries[0].evidence.sha256=raw(f.files.get(`evidence/${DELIVERY}.json`));
    reseal(f);await writeImage(f);
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].counters.validationAttempts,100);
    assert.equal(result.deliveries[0].formalStatus,'PASS');
    assert.equal(result.normalHandoff,null);
  }));
  for (const [field,delta] of [['implementationChecks',-1],['findingsChecks',-1],
    ['validationAttempts',1],['findings',-1]])
    await t.test(field,async()=>using(producerPostApplyPass,async f=>{
      f.continuity.deliveries[0].counters[field]+=delta;reseal(f);await writeImage(f);
      await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','counter');
    }));
  await t.test('required formal origin removed with objects repacked',async()=>using(producerPostApplyPass,async f=>{
    const bundle=structuredClone(f.postApply.bundle);
    bundle.support=bundle.support.filter(item=>item.id!=='attempt-01');
    const references=new Set();
    for (const record of [...bundle.implementation,...bundle.findingsChecks,
      ...(bundle.validation?[bundle.validation]:[]),...bundle.support])
      for (const [name,reference] of Object.entries(record.sources)) {
        if (name==='transport' || reference===null) continue;
        for (const id of Array.isArray(reference)?reference:[reference]) references.add(id);
      }
    bundle.objects=bundle.objects.filter(item=>references.has(item.id));
    f.files.set(`evidence/${DELIVERY}.json`,Buffer.from(JSON.stringify(bundle)+'\n'));
    f.continuity.deliveries[0].evidence.sha256=raw(f.files.get(`evidence/${DELIVERY}.json`));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE');
  }));
});

test('R10 BLOCKED formal and Initial FAIL prefix do not invent recovery',async t=>{
  for(const field of ['Changed Areas','Corrections Applied']) await t.test(`concluded refusal still checks ${field}`,async()=>using(
    ()=>producerAppliedImage({semanticRejection:true}),async f=>{
      editSection(f,'slice-01',field,'- `../../../../src/pay.mjs`');reseal(f);await writeImage(f);
      await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE',field);
    }));
  for(const count of [2,3]) await t.test(`Initial refusal after ${count} consumed invocations`,async()=>using(
    ()=>producerInitialImage({semanticRejection:true,statuses:Array(count).fill('TESTS_FAIL')}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),refusal=f.composed.bundle.support.at(-1);
      assert.equal(result.deliveries[0].counters.implementationChecks,count-1);assert.equal(refusal.consumedInvocations,count);
      assert.equal(refusal.round,count);assert.equal(result.normalHandoff,null);assert.equal(result.deliveries[0].observedValidation,'uncertain');
    }));

  for(const transport of ['native','managed']) {
    await t.test(`${transport} Initial BLOCKED is outside quiet capability`,async()=>using(()=>producerInitialImage({transport,status:'BLOCKED'}),async f=>{
      await rejected(()=>inspectCurrentExecution(f.specPath),'UNSUPPORTED_FORMAT','Initial BLOCKED');
    }));
    await t.test(`${transport} APPLY BLOCKED`,async()=>using(()=>producerAppliedImage({transport,status:'BLOCKED'}),async f=>{
      const result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.deliveries[0].auxiliaryStatus,'BLOCKED');assert.equal(result.normalHandoff,null);
      assert.deepEqual(result.deliveries[0].counters,{implementationChecks:1,findingsChecks:1,validationAttempts:1,findings:1});
    }));
    await t.test(`${transport} APPLY FAIL3 exhausted`,async()=>using(()=>producerAppliedImage({transport,statuses:Array(3).fill('TESTS_FAIL')}),async f=>{
      const result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.state,'FINDINGS_RETRY_EXHAUSTED');assert.equal(result.normalHandoff?.operation,'VALIDATE_SLICE');
      assert.deepEqual(result.deliveries[0].counters,{implementationChecks:1,findingsChecks:3,validationAttempts:1,findings:1});
    }));
  }
  for(const count of [1,2]) await t.test(`APPLY FAIL prefix ${count} cannot become quiet`,async()=>using(producerAppliedImage,async f=>{
    // The pure producer refuses incomplete prefixes; construct a coherent raw
    // prefix independently so the reader itself must reach that same boundary.
    const initial=await import('./fixtures/current-initial-evidence.mjs');
    const oracle=await import('./fixtures/current-findings-evidence.mjs');
    const first=structuredClone(f.applyCapture),request=oracle.decode(first.applyRequest),caps=[];
    for(let round=1;round<=count;round+=1) {
      const cap=Object.fromEntries(Object.entries(first).map(([name,value])=>[name,value instanceof Uint8Array
        ?Buffer.from(Buffer.from(value).toString('utf8').replaceAll('/round-1.',`/round-${round}.`)):structuredClone(value)])),asked=structuredClone(request);
      asked.round=round;asked.checkId=`findings-check-0${round}`;
      asked.previousCheck=round===1?null:{id:`findings-check-0${round-1}`,roundCaptureSha256:oracle.roundLink(caps.at(-1))};
      cap.applyRequest=Buffer.from(JSON.stringify(asked)+'\n');
      const response=oracle.decode(cap.rawResponse);response.requestSha256=raw(cap.applyRequest);
      response.result=oracle.applyPayload(round,'TESTS_FAIL',1);
      const observation=oracle.decode(cap.verificationObservation);observation.round=round;observation.checks[0].exit=1;
      cap.verificationObservation=Buffer.from(JSON.stringify(observation)+'\n');
      const baseline=oracle.decode(cap.baselineCapture);baseline.round=round;if(round>1)baseline.manifest=initial.manifest(2);
      cap.baselineCapture=Buffer.from(JSON.stringify(baseline)+'\n');
      const origin=oracle.decode(cap.origin);origin.attempt=round;cap.origin=Buffer.from(JSON.stringify(origin)+'\n');cap.dispatch=cap.origin;
      const binding=oracle.decode(cap.agentBinding);binding.agentId=`prefix-${round}`;cap.agentBinding=Buffer.from(JSON.stringify(binding)+'\n');
      const claim=oracle.decode(cap.agentClaim);claim.agentId=binding.agentId;cap.agentClaim=Buffer.from(JSON.stringify(claim)+'\n');
      const tool=oracle.decode(cap.concludedToolResult);tool.agentId=binding.agentId;cap.concludedToolResult=Buffer.from(JSON.stringify(tool)+'\n');
      const receipt=oracle.decode(cap.receipt);receipt.attempt=round;receipt.threadId=binding.agentId;receipt.verification=observation;receipt.semanticResponseStatus='TESTS_FAIL';
      cap.receipt=Buffer.from(JSON.stringify(receipt)+'\n');oracle.rebindRaw(cap,response);caps.push(cap);
    }
    const bundle=structuredClone(f.applied.bundle);bundle.findingsChecks=[];
    for(const [i,cap] of caps.entries()) {
      const record=oracle.authoredCheck(cap,`findings-check-0${i+1}`,oracle.findingsGolden(cap,{priorFailure:i?'Pay check failed.':null}),request.authority);
      bundle.findingsChecks.push(record);replaceRecordCapture(bundle,record,cap,oracle);
    }
    f.continuity.deliveries[0].counters.findingsChecks=count;await storeBundle(f,bundle);
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE','incomplete FAIL prefix');
  }));
  for(const count of [2,3]) await t.test(`APPLY refusal at invocation ${count} keeps accepted count ${count-1}`,async()=>using(
    ()=>producerAppliedImage({semanticRejection:true,statuses:Array(count).fill('TESTS_FAIL')}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),rejection=f.applied.bundle.support.at(-1);
      assert.equal(rejection.consumedInvocations,count);assert.equal(rejection.round,count);
      assert.equal(result.deliveries[0].counters.findingsChecks,count-1);assert.equal(result.normalHandoff,null);
    }));
  await t.test('first Initial APPLY refusal has terminal consumption and no accepted check',async()=>using(
    ()=>producerAppliedImage({semanticRejection:true}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),first=result.deliveries[0];
      assert.equal(first.persistedValidation,'uncertain');assert.equal(result.normalHandoff,null);
      assert.equal(first.counters.findingsChecks,0);
      assert.equal(f.applied.bundle.support.at(-1).kind,'rejection');
      assert.deepEqual(f.applied.bundle.findingsChecks,[]);
    }));
  for(const field of ['normalization','lastDiagnostic'])
    await t.test(`first Initial APPLY refusal rejects altered ${field}`,async()=>using(
      ()=>producerAppliedImage({semanticRejection:true}),async f=>{
        f.continuity.deliveries[0][field]=null;
        reseal(f);await writeImage(f);
        await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Initial refusal state differs');
      }));

  await t.test('concluded Initial semantic rejection has no implementation record',async()=>using(
    ()=>producerInitialImage({semanticRejection:true}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),first=result.deliveries[0];
      assert.equal(first.persistedValidation,'uncertain');assert.equal(result.normalHandoff,null);
      assert.deepEqual(first.counters,{implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0});
      assert.deepEqual(f.composed.bundle.implementation,[]);
      assert.equal(f.composed.bundle.support.at(-1).kind,'rejection');
      assert.equal(f.activation.lastAttempt.outcome,'rejected');
    }));
  for(const field of ['normalization','lastDiagnostic'])
    await t.test(`concluded Initial refusal rejects altered ${field}`,async()=>using(
      ()=>producerInitialImage({semanticRejection:true}),async f=>{
        f.continuity.deliveries[0][field]=null;
        reseal(f);await writeImage(f);
        await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Initial refusal state differs');
      }));
  await t.test('concluded formal semantic rejection preserves consumption',async()=>using(
    ()=>producerFormalPass({semanticRejection:true}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),first=result.deliveries[0];
      assert.equal(first.persistedValidation,'uncertain');assert.equal(first.observedValidation,'uncertain');
      assert.equal(first.formalStatus,null);assert.equal(result.normalHandoff,null);
      assert.deepEqual(first.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:0,findings:0});
      assert.equal(f.formal.bundle.support.at(-1).kind,'rejection');
      assert.equal(f.activation.lastAttempt.outcome,'rejected');
    }));
  await t.test('concluded APPLY semantic rejection preserves admission',async()=>using(
    ()=>producerAppliedImage({semanticRejection:true}),async f=>{
      const result=await inspectCurrentExecution(f.specPath),first=result.deliveries[0];
      assert.equal(first.persistedValidation,'uncertain');assert.equal(first.formalStatus,'NEEDS_FIX');
      assert.equal(result.normalHandoff,null);
      assert.deepEqual(first.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:1,findings:1});
      assert.equal(f.applied.bundle.support.at(-1).kind,'rejection');
      assert.equal(f.activation.lastAttempt.outcome,'rejected');
    }));
  await t.test('formal BLOCKED',async()=>using(()=>producerFormalPass({status:'BLOCKED'}),async f=>{
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].formalStatus,'BLOCKED');assert.equal(result.normalHandoff,null);
  }));
  for (const count of [1,2]) await t.test(`Initial FAIL prefix ${count}`,async()=>using(
    ()=>producerInitialImage({statuses:Array(count).fill('TESTS_FAIL')}),async f=>{
      await rejected(()=>inspectCurrentExecution(f.specPath),'UNSUPPORTED_FORMAT','Initial FAIL prefix');
    }));
  await t.test('Initial FAIL round 3 is exhausted',async()=>using(
    ()=>producerInitialImage({statuses:Array(3).fill('TESTS_FAIL')}),async f=>{
      const result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.deliveries[0].auxiliaryStatus,'TESTS_FAIL');
      assert.deepEqual(result.deliveries[0].counters,{implementationChecks:3,findingsChecks:0,validationAttempts:0,findings:0});
      assert.equal(result.normalHandoff?.operation,'VALIDATE_SLICE');
      assert.equal(result.state,'IMPLEMENTATION_RETRY_EXHAUSTED');
    }));
});

test('R11 typed operational carriers and presentation variants',async t=>{
  for(const margin of [' ','   ','\t']) await t.test(`structural field margin ${JSON.stringify(margin)}`,async()=>using(producerPostApplyPass,async f=>{
    const name='tasks/slice-01.md',before=f.files.get(name).toString('utf8'),proof=Buffer.from(f.files.get(`evidence/${DELIVERY}.json`));
    const after=changeBody(before,'Validation Attempts',body=>body.replace(/^- /gmu,margin+'- ').replace(/^  - /gmu,margin+' - '));
    assert.notEqual(after,before);f.files.set(name,Buffer.from(after));reseal(f);await writeImage(f);
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].observedValidation,'current');assert.equal(result.normalHandoff,null);
    assert.deepEqual(result.deliveries[0].counters,{implementationChecks:1,findingsChecks:1,validationAttempts:2,findings:1});
    assert.deepEqual(f.files.get(`evidence/${DELIVERY}.json`),proof);
  }));
  await t.test('typed path with spaces has optional backticks but exact interior',async()=>using(()=>producerFormalPass({extraOutput:true}),async f=>{
    assert.equal(await fs.readFile(path.join(f.project,'src/pay report.mjs'),'utf8'),'pay report\n');
    const name='tasks/slice-01.md',before=f.files.get(name).toString('utf8'),proof=Buffer.from(f.files.get(`evidence/${DELIVERY}.json`));
    assert.equal((await inspectCurrentExecution(f.specPath)).deliveries[0].observedValidation,'current');
    const after=before.replaceAll('`../../../../src/pay report.mjs`','../../../../src/pay report.mjs');
    assert.notEqual(after,before);f.files.set(name,Buffer.from(after));reseal(f);await writeImage(f);
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].observedValidation,'current');assert.equal(result.normalHandoff,null);
    assert.deepEqual(f.files.get(`evidence/${DELIVERY}.json`),proof);
    f.files.set(name,Buffer.from(changeBody(after,'Changed Areas',body=>body.replace('pay report.mjs','pay  report.mjs'))));
    reseal(f);await writeImage(f);await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Changed Areas');
  }));
  for(const operation of ['PLAN','REVIEW_PLAN','REPLAN','INIT','RESUME','READINESS','CLOSE'])
    await t.test(`known whole operation ${operation} is never free prose`,async()=>using(producerFormalPass,async f=>{
      for(const action of [operation,'`'+operation+'`']) {
        editSection(f,'slice-01','Continuity',`- Current validation: current\n- Current evidence: evidence/${DELIVERY}.json\n- Current action: ${action}`);
        reseal(f);await writeImage(f);await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Continuity.Current action');
      }
      editSection(f,'slice-01','Continuity',`- Current validation: current\n- Current evidence: evidence/${DELIVERY}.json\n- Current action: Discuss ${operation} after reviewing these facts.`);
      reseal(f);await writeImage(f);const result=await inspectCurrentExecution(f.specPath);
      assert.equal(result.deliveries[0].observedValidation,'current');assert.equal(result.normalHandoff,null);
    }));
  await t.test('raw embedded record remains byte-exact even for presentation',async()=>using(producerPostApplyPass,async f=>{
    const bundle=structuredClone(f.postApply.bundle);bundle.validation.recordUtf8=bundle.validation.recordUtf8.replace('- Status: PASS','- Status:  PASS');
    await storeBundle(f,bundle);await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_STALE','formal record');
  }));

  for(const [field,mutate] of [
    ['Validation Attempts',text=>text.replace('- Status: PASS','- Status: NEEDS_FIX')],
    ['Validation Attempts',text=>text.replace('node src/pay.mjs` | exit:0','node src/pay.mjs` | exit:7')],
    ['Validation Attempts',text=>text.replace('node src/pay.mjs` | exit:0','node  src/pay.mjs` | exit:0')],
    ['Current validation',text=>text.replace('- Current validation: current','- Current validation: unvalidated')],
    ['Current evidence',text=>text.replace(`- Current evidence: evidence/${DELIVERY}.json`,'- Current evidence: evidence/22222222-2222-4222-8222-222222222222.json')],
    ['Effective Validation Base',text=>text.replace('- Origin attempt: attempt-02','- Origin attempt: attempt-01')],
    ['Validation Findings',text=>text.replace('- Resolution: attempt-02 confirmed correction','- Resolution: attempt-020 confirmed correction')],
    ['Validation Findings',text=>text.replace('- State: resolved','- State: active')],
    ['Corrections Applied',text=>text.replace('## Corrections Applied\n\n- `../../../../src/pay.mjs`','## Corrections Applied\n\n- none')],
    ['Changed Areas',text=>text.replace('## Changed Areas\n\n- `../../../../src/pay.mjs`','## Changed Areas\n\n- none')],
    ['Prior Validation Overlap',text=>text.replace('## Prior Validation Overlap\n\n- none','## Prior Validation Overlap\n\n- Slice 02 overlap: `../../../../src/pay.mjs`; Claimed overlap.')],
  ]) await t.test(`typed negative ${field} ${mutate.toString().slice(-45)}`,async()=>using(producerPostApplyPass,async f=>{
    const name='tasks/slice-01.md',before=f.files.get(name).toString('utf8'),after=field==='Validation Attempts'?changeBody(before,field,mutate):mutate(before);
    assert.notEqual(after,before);f.files.set(name,Buffer.from(after));reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE',field);
  }));
  await t.test('operational explanatory reflow preserves raw record bytes',async()=>using(producerPostApplyPass,async f=>{
    const original=Buffer.from(f.files.get(`evidence/${DELIVERY}.json`));
    const name='tasks/slice-01.md';f.files.set(name,Buffer.from(f.files.get(name).toString('utf8')
      .replaceAll('Direct recipe observation and file hash.','Direct recipe observation\n  and file hash.')
      .replace('finding-01 pay behavior differs from AC-001','finding-01 pay behavior\n  differs from AC-001')
      .replace('- Current action: validation complete','- Current action: VALIDATE_SLICE is mentioned here as prose.')));
    reseal(f);await writeImage(f);const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].observedValidation,'current');assert.deepEqual(f.files.get(`evidence/${DELIVERY}.json`),original);
  }));
  await t.test('baseline key order is not authority',async()=>using(producerPostApplyPass,async f=>{
    const baseline=f.continuity.deliveries[0].baseline;
    f.continuity.deliveries[0].baseline={entries:baseline.entries.map(item=>Object.fromEntries(Object.entries(item).reverse())),format:baseline.format};
    reseal(f);await writeImage(f);assert.equal((await inspectCurrentExecution(f.specPath)).deliveries[0].observedValidation,'current');
  }));
  await t.test('extra base field is syntax',async()=>using(producerPostApplyPass,async f=>{
    const name='tasks/slice-01.md';f.files.set(name,Buffer.from(f.files.get(name).toString('utf8')
      .replace('## Effective Validation Base\n','## Effective Validation Base\n\n- Extra: PASS\n')));
    reseal(f);await writeImage(f);await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','carrier-syntax');
  }));

  await t.test('equivalent JSON presentation',async()=>using(producerPostApplyPass,async f=>{
    const name='continuity.json',pretty=Buffer.from(JSON.stringify(f.continuity,null,2)+'\n');
    f.files.set(name,pretty);
    f.activation.artifacts.find(item=>item.path===name).sha256=raw(pretty);
    await writeImage(f);
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].formalStatus,'PASS');
  }));
  await t.test('action prose and spacing',async()=>using(producerPostApplyPass,async f=>{
    editSection(f,'slice-01','Continuity',`* Current validation : current\n* Current evidence : \`evidence/${DELIVERY}.json\`\n* Current action: The formal check is complete.`);
    reseal(f);await writeImage(f);const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].observedValidation,'current');
  }));
  await t.test('record bullets, padding and scalar backticks',async()=>using(producerFormalPass,async f=>{
    const name='tasks/slice-01.md';
    const before=f.files.get(name).toString('utf8');
    const after=before.replace('- Status: PASS','* Status : `PASS`')
      .replace('  - `node src/pay.mjs` | exit:0','  * `node src/pay.mjs`   |   exit:0')
      .replaceAll('\n','\r\n');
    assert.notEqual(after,before);f.files.set(name,Buffer.from(after));
    reseal(f);await writeImage(f);
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.deliveries[0].formalStatus,'PASS');
  }));
  for (const [field,body] of [['Effective Validation Base','- none'],
    ['Corrections Applied','- `../../../../src/forged.mjs`'],['Validation Findings','- none']])
    await t.test(field,async()=>using(producerPostApplyPass,async f=>{
      editSection(f,'slice-01',field,body);reseal(f);await writeImage(f);
      await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE',field);
    }));
  await t.test('wrong cycle baseline',async()=>using(producerPostApplyPass,async f=>{
    f.continuity.deliveries[0].baseline=structuredClone(f.postApply.bundle.validation.testedWork);
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','baseline');
  }));
  await t.test('record command carrier',async()=>using(producerPostApplyPass,async f=>{
    const name='tasks/slice-01.md';
    f.files.set(name,Buffer.from(changeBody(f.files.get(name).toString('utf8'),'Validation Attempts',text=>text.replace('node src/pay.mjs` | exit:0','node src/forged.mjs` | exit:0'))));
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Validation Attempts');
  }));
  await t.test('action token contradiction',async()=>using(producerPostApplyPass,async f=>{
    editSection(f,'slice-01','Continuity',`- Current validation: current\n- Current evidence: evidence/${DELIVERY}.json\n- Current action: EXECUTE_SLICE`);
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Current action');
  }));
});

test('R12 A/B detects activation bytes and inode replacement',async t=>{
  await t.test('IPC ABORT before GO closes child without opening target',async()=>using(authoredImage,async f=>{
    const target=path.join(f.execution,'activation.json');
    const observed=await barrier(f,target,()=>{throw new Error('mutation must not run after abort');},2,{abortBeforeGo:true});
    assert.deepEqual(observed.attempts,[]);
  }));
  for (const [label,change] of [
    ['bytes',async f=>{const file=path.join(f.execution,'activation.json');
      const value=JSON.parse(await fs.readFile(file,'utf8'));value.sequence+=1;
      await fs.writeFile(file,JSON.stringify(value)+'\n');}],
    ['same bytes new inode',async f=>{const file=path.join(f.execution,'activation.json');
      const bytes=await fs.readFile(file),replacement=path.join(f.execution,'activation.swap');
      await fs.writeFile(replacement,bytes);await fs.rename(replacement,file);}],
  ]) await t.test(label,async()=>using(authoredImage,async f=>{
    const observed=await barrier(f,path.join(f.execution,'activation.json'),()=>change(f));
    assert.equal(observed.result.error?.code,'STALE_BASE');
    barrierReads(observed,f,path.join(f.execution,'activation.json'),{deliveries:2,activation:2,
      artifactCapture:'full',documentCaptures:2,productFiles:PRISTINE_OBSERVED_FILES});
  }));
  await t.test('artifact changes between captures',async()=>using(authoredImage,async f=>{
    const file=path.join(f.execution,'plan.md');
    const observed=await barrier(f,file,()=>fs.appendFile(file,'\n'));
    assert.equal(observed.result.error?.code,'STALE_BASE');
    barrierReads(observed,f,file,{deliveries:2,activation:1,artifactCapture:'prefix',
      documentCaptures:1,productFiles:PRISTINE_OBSERVED_FILES});
  }));
  await t.test('artifact directory replacement with identical bytes',async()=>using(authoredImage,async f=>{
    const original=path.join(f.execution,'plans'),replacement=path.join(f.spec,'.plans.swap');
    await fs.cp(original,replacement,{recursive:true});
    const observed=await barrier(f,path.join(original,'slice-01.md'),async()=>{
      await fs.rename(original,path.join(f.spec,'.plans.old'));
      await fs.rename(replacement,original);
    });
    assert.equal(observed.result.error?.code,'STALE_BASE');
    barrierReads(observed,f,path.join(original,'slice-01.md'),{deliveries:2,activation:1,
      artifactCapture:'full',documentCaptures:1,productFiles:PRISTINE_OBSERVED_FILES});
  }));
  await t.test('root replacement with identical bytes',async()=>using(authoredImage,async f=>{
    const replacement=path.join(f.spec,'.replacement-execution');
    await fs.cp(f.execution,replacement,{recursive:true});
    const observed=await barrier(f,path.join(f.execution,'activation.json'),async()=>{
      await fs.rename(f.execution,path.join(f.spec,'.old-execution'));
      await fs.rename(replacement,f.execution);
    });
    assert.equal(observed.result.error?.code,'STALE_BASE');
    barrierReads(observed,f,path.join(f.execution,'activation.json'),{deliveries:2,activation:2,
      artifactCapture:'full',documentCaptures:2,productFiles:PRISTINE_OBSERVED_FILES});
  }));
});

test('R13 authority and product changes inside a stable activation read',async t=>{
  await t.test('document',async()=>using(authoredImage,async f=>{
    const observed=await barrier(f,f.source,()=>fs.appendFile(f.source,'changed\n'));
    assert.equal(observed.result.error?.code,'REQUIREMENTS_CHANGED');
    barrierReads(observed,f,f.source,{deliveries:2,activation:1,artifactCapture:'full',
      documentCaptures:2,productFiles:PRISTINE_OBSERVED_FILES});
  }));
  await t.test('product',async()=>using(producerFormalPass,async f=>{
    const target=path.join(f.project,'src/pay.mjs');
    const observed=await barrier(f,target,()=>fs.writeFile(target,'changed\n'));
    assert.equal(observed.result.error?.code,'EVIDENCE_STALE');
    barrierReads(observed,f,target,{deliveries:1,activation:1,artifactCapture:'none',
      documentCaptures:1,productFiles:FORMAL_OBSERVED_FILES});
  }));
});

test('R14 declared active owner and incompatible lastAttempt block quietly',async t=>{
  await t.test('input ancestor inventory cannot authorize historical child metadata',async()=>using(producerFormalPass,async f=>{
    const historical=path.join(f.project,'config/history');await fs.mkdir(historical);
    await fs.writeFile(path.join(historical,'receipt.json'),'historical canary');
    const observed=await workerRun(f);noAttempts(observed);
    assert.equal(observed.log.result.error.code,'UNSAFE_PATH');
    assert.match(observed.log.result.error.message,/approved observation domain/u);
  }));
  for(const field of ['terminalActivationId','operation','outcome']) await t.test(`lastAttempt binding ${field}`,async()=>using(producerFormalPass,async f=>{
    f.activation.lastAttempt[field]=field==='operation'?'APPLY_FINDINGS':field==='outcome'?'rejected':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await writeImage(f);await rejected(()=>inspectCurrentExecution(f.specPath),field==='terminalActivationId'?'INVALID_CURRENT_IMAGE':'EVIDENCE_INCOMPLETE','lastAttempt');
  }));

  await t.test('untrusted retained manifest cannot cause historical metadata I/O',async()=>using(authoredImage,async f=>{
    f.continuity.deliveries[0].baseline.entries.push({path:'tmp',kind:'directory',children:['historic']},
      {path:'tmp/historic',kind:'directory',children:['receipt.json']},
      {path:'tmp/historic/receipt.json',kind:'file',sha256:raw(Buffer.from('old')),mode:420});
    reseal(f);await writeImage(f);const observed=await workerRun(f);noAttempts(observed);
    assert.equal(observed.log.result.error?.code,'UNSAFE_PATH');assert.match(observed.log.result.error.message,/approved observation domain/u);
  }));

  await t.test('active owner',async()=>using(authoredImage,async f=>{
    f.activation.activeAttempt={operationAttemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ownershipToken:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',deliveryId:DELIVERY,slice:'slice-01',
      operation:'EXECUTE_SLICE',preparationRevision:1,localRevision:1,normativeSha256:f.snapshot.normativeSha256,
      originActivationId:f.activation.activationId,operationRef:{operationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        allocationSha256:raw(Buffer.from('missing operation'))}};
    await writeImage(f);await rejected(()=>inspectCurrentExecution(f.specPath),'OWNER_UNCERTAIN','activeAttempt');
    const child=await workerRun(f);noAttempts(child);assert.equal(child.log.result.error?.code,'OWNER_UNCERTAIN');
  }));
  await t.test('lastAttempt',async()=>using(producerFormalPass,async f=>{
    f.activation.lastAttempt.operationAttemptId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'EVIDENCE_INCOMPLETE','lastAttempt');
  }));
  await t.test('raw historical pointer remains literal',async()=>using(
    ()=>producerInitialImage({historicalCanary:true}),async f=>{
      assert.ok(Buffer.from(f.capture.receipt).includes(Buffer.from(f.historicalCanary)));
      const observed=await workerRun(f);
      assert.equal(observed.process.status,0);assert.deepEqual(observed.log.attempts,[]);
      assert.equal(observed.log.result.normalHandoff?.operation,'VALIDATE_SLICE');
    }));
});

test('R15 physical roots, symlinks and cwd independence',async t=>{
  for(const present of [false,true]) await t.test(`known EC-1 namespace refuses selector with execution ${present?'present':'absent'}`,async()=>using(
    ()=>authoredImage({kind:'lifecycle',withExecution:present}),async f=>{
      const operation=path.join(f.project,'tmp/sentinel','a'.repeat(64),'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
      const candidate=path.join(operation,'candidate');await fs.mkdir(candidate,{recursive:true});
      await fs.copyFile(f.source,path.join(candidate,'feature_spec.md'));
      await fs.writeFile(path.join(operation,'allocation.json'),'unread allocation canary');
      if(present) await fs.cp(f.execution,path.join(candidate,'execution'),{recursive:true});
      for(const selector of [candidate,path.join(candidate,'feature_spec.md')]) {
        const before=await manifest(f.project);
        await rejected(()=>inspectCurrentExecution(selector),'TEMP_ROOT_UNPROVEN','known EC-1 operational namespace');
        assert.deepEqual(await manifest(f.project),before);
        const observed=await workerRun({...f,specPath:selector});noAttempts(observed);
        assert.equal(observed.log.result.error.code,'TEMP_ROOT_UNPROVEN');
        assert.match(observed.log.result.error.message,/known EC-1 operational namespace/u);
        assert.deepEqual(observed.log.opens,{},'selector refusal precedes documentary/artifact/allocation reads');
      }
    }));
  await t.test('ordinary tmp SPEC beside sentinel namespace remains official',async()=>using(()=>authoredImage({kind:'lifecycle',withExecution:false}),async f=>{
    const selected=path.join(f.project,'tmp/sentinel-not-operational/pay');await fs.mkdir(selected,{recursive:true});
    await fs.copyFile(f.source,path.join(selected,'feature_spec.md'));
    const observed=await workerRun({...f,specPath:selected});noAttempts(observed);
    assert.equal(observed.log.result.state,'NO_EXECUTION');assert.equal(observed.log.result.normalHandoff,null);
  }));
  await t.test('prefix alone does not disqualify a legitimate official SPEC',async()=>using(()=>authoredImage({kind:'lifecycle'}),async f=>{
    const selected=path.join(f.project,'specs','.stnl-execution-stage-99999999-9999-4999-8999-999999999999');
    await fs.cp(f.spec,selected,{recursive:true});
    const result=await inspectCurrentExecution(selected);assert.equal(result.state,'MATERIALIZED_PRISTINE');
  }));
  await t.test('product hardlink is refused without reading its bytes',async()=>using(producerFormalPass,async f=>{
    await fs.link(path.join(f.project,'src/pay.mjs'),path.join(f.temporary,'second-product-name'));
    await rejected(()=>inspectCurrentExecution(f.specPath),'UNSAFE_PATH');
  }));

  await t.test('cwd independent',async()=>using(authoredImage,async f=>{
    const old=process.cwd();try {process.chdir(os.tmpdir());
      assert.equal((await inspectCurrentExecution(f.specPath)).state,'MATERIALIZED_PRISTINE');
    } finally {process.chdir(old);}
  }));
  await t.test('product symlink',async()=>using(producerFormalPass,async f=>{
    const target=path.join(f.project,'src/pay.mjs');await fs.rm(target);
    await fs.symlink(f.source,target);await rejected(()=>inspectCurrentExecution(f.specPath),'UNSAFE_PATH','symlink');
  }));
  await t.test('artifact hardlink',async()=>using(authoredImage,async f=>{
    await fs.link(path.join(f.execution,'plan.md'),path.join(f.temporary,'linked-plan'));
    await rejected(()=>inspectCurrentExecution(f.specPath),'UNSAFE_PATH');
  }));
  await t.test('official root replaced by symlink',async()=>using(authoredImage,async f=>{
    const parked=path.join(f.spec,'parked-execution');
    await fs.rename(f.execution,parked);await fs.symlink(parked,f.execution);
    await rejected(()=>inspectCurrentExecution(f.specPath),'UNSAFE_PATH');
  }));
  await t.test('product escape',async()=>using(authoredImage,async f=>{
    editSection(f,'slice-01','Expected Files','- `../../../../../outside.mjs`');
    reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'UNSAFE_PATH');
  }));
  await t.test('owned candidate cannot be passed as official',async()=>using(
    ()=>authoredImage({kind:'lifecycle'}),async f=>{
      const candidate=path.join(f.project,'specs','candidate with spaces');
      await fs.cp(f.spec,candidate,{recursive:true});
      const owner={operationAttemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ownershipToken:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',deliveryId:DELIVERY,slice:'slice-01',
        operation:'EXECUTE_SLICE',preparationRevision:1,normativeSha256:f.snapshot.normativeSha256,
        originActivationId:f.activation.activationId,
        workCapture:{path:path.join(f.temporary,'capture.json'),sha256:raw(Buffer.from('capture'))}};
      const envelope={format:'stnl-execution-copy-v1',allocationId:'99999999-9999-4999-8999-999999999999',
        producer:'execution-copy',executionRoot:f.execution,retentionRoot:candidate,candidate,owner,
        slice:'slice-01',expectedActivationId:f.activation.activationId,specPath:candidate,tree:{files:[]}};
      await fs.writeFile(`${candidate}.copy.json`,JSON.stringify(envelope)+'\n');
      await rejected(()=>inspectCurrentExecution(candidate),'TEMP_ROOT_UNPROVEN');
    }));
  await t.test('owned publication backup cannot be passed as official',async()=>using(
    ()=>authoredImage({kind:'lifecycle'}),async f=>{
      const allocationId='99999999-9999-4999-8999-999999999999';
      const backup=path.join(f.project,'specs',`.stnl-execution-backup-${allocationId}`);
      await fs.cp(f.spec,backup,{recursive:true});
      const owner={operationAttemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ownershipToken:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',deliveryId:DELIVERY,slice:'slice-01',
        operation:'EXECUTE_SLICE',preparationRevision:1,normativeSha256:f.snapshot.normativeSha256,
        originActivationId:f.activation.activationId,
        workCapture:{path:path.join(f.temporary,'capture.json'),sha256:raw(Buffer.from('capture'))}};
      const parent=path.dirname(backup);
      const envelope={format:'stnl-execution-publication-owner-v1',allocationId,
        executionRoot:f.execution,retentionRoot:backup,owner,
        expectedActivationId:f.activation.activationId,expectedTree:{files:[]},
        candidate:path.join(parent,'prospective'),stage:path.join(parent,`.stnl-execution-stage-${allocationId}`),
        backup:path.join(backup,'previous')};
      await fs.writeFile(path.join(parent,`.stnl-execution-publication-${allocationId}.json`),
        JSON.stringify(envelope)+'\n');
      await rejected(()=>inspectCurrentExecution(backup),'TEMP_ROOT_UNPROVEN');
    }));
});

test('R16 serial frontier and terminal absence',async t=>{
  for(const disposition of ['rejected','BLOCKED']) await t.test(`stale predecessor cannot hide later ${disposition}`,async()=>using(
    ()=>producerTwoFormalPass({secondStatus:disposition==='BLOCKED'?'BLOCKED':'PASS',secondSemanticRejection:disposition==='rejected'}),async f=>{
      await fs.writeFile(path.join(f.project,'src/pay.mjs'),'drift after the second formal attempt\n');
      const result=await inspectCurrentExecution(f.specPath);
      assert.deepEqual(result.deliveries.map(item=>[item.slice,item.deliveryId]),[
        ['slice-01',DELIVERY],['slice-02','22222222-2222-4222-8222-222222222222']]);
      assert.equal(result.deliveries[0].persistedValidation,'current');assert.equal(result.deliveries[0].observedValidation,'revalidation-required');
      const second=result.deliveries[1];
      assert.equal(second.observedValidation,disposition==='rejected'?'uncertain':'revalidation-required');
      assert.equal(second.formalStatus,disposition==='rejected'?null:'BLOCKED');
      assert.deepEqual(second.counters,{implementationChecks:1,findingsChecks:0,validationAttempts:disposition==='rejected'?0:1,findings:0});
      assert.equal(result.state,'VALIDATION_BLOCKED');assert.equal(result.normalHandoff,null);
      assert.deepEqual(result.diagnostics,[{kind:'evidence',artifact:'slice-02',field:'status',
        reason:disposition==='rejected'?'uncertain incorporation':'blocked incorporation'}]);
      const observed=await workerRun(f);noAttempts(observed);
      assert.equal(observed.log.result.state,'VALIDATION_BLOCKED');assert.equal(observed.log.result.normalHandoff,null);
      assert.equal(observed.log.result.diagnostics[0].artifact,'slice-02');
    }));
  await t.test('shared input drift blocks the pending dependent independently',async()=>using(()=>producerFormalPass({retainSecond:true}),async f=>{
    await fs.writeFile(path.join(f.project,'config/settings.json'),'settings=drift\n');
    const stale=await inspectCurrentExecution(f.specPath);
    assert.equal(stale.deliveries[0].observedValidation,'revalidation-required');
    assert.equal(stale.normalHandoff?.slice,'slice-01');assert.equal(stale.state,'EVIDENCE_STALE');
  }));

  for(const presentation of ['compact','structured']) await t.test(`${presentation} verified overlap cannot hide predecessor drift`,async()=>using(
    ()=>producerTwoFormalPass({changeSecond:true}),async f=>{
      if(presentation==='structured') {
        editSection(f,'slice-02','Prior Validation Overlap','### overlap-01\n* Paths: `../../../../src/pay.mjs`\n* Regressions: Direct pay regression.\n* Prior slice: `slice-01`\n* Affected behavior: The pay export\n  remains observable.');
        reseal(f);await writeImage(f);
      }
      const result=await inspectCurrentExecution(f.specPath);
      assert.deepEqual(result.deliveries.map(item=>item.observedValidation),['revalidation-required','current']);
      assert.equal(result.normalHandoff?.slice,'slice-01');assert.equal(result.state,'EVIDENCE_STALE');
    }));
  for(const [label,body] of [
    ['required overlap omitted','- none'],
    ['required overlap duplicated','- Slice 01 overlap: `../../../../src/pay.mjs`; Direct pay regression.\n- Slice 01 overlap: `../../../../src/pay.mjs`; Duplicate claim.'],
    ['wrong prior slice','- Slice 02 overlap: `../../../../src/pay.mjs`; Wrong predecessor.'],
  ]) await t.test(label,async()=>using(()=>producerTwoFormalPass({changeSecond:true}),async f=>{
    assert.ok(f.files.get('tasks/slice-02.md').toString('utf8').includes('Slice 01 overlap:'));
    editSection(f,'slice-02','Prior Validation Overlap',body);reseal(f);await writeImage(f);
    await rejected(()=>inspectCurrentExecution(f.specPath),'INVALID_CURRENT_IMAGE','Prior Validation Overlap');
  }));

  await t.test('prior PASS and pending dependent slice',async()=>using(
    ()=>producerFormalPass({retainSecond:true}),async f=>{
      const result=await inspectCurrentExecution(f.specPath);
      assert.deepEqual(result.deliveries.map(item=>[item.deliveryId,item.formalStatus,item.observedValidation]),[
        [DELIVERY,'PASS','current'],
        ['22222222-2222-4222-8222-222222222222',null,'unvalidated']]);
      assert.deepEqual(result.normalHandoff,{operation:'EXECUTE_SLICE',slice:'slice-02',
        deliveryId:'22222222-2222-4222-8222-222222222222'});
    }));
  await t.test('two local PASS results have no terminal judgment',async()=>using(producerTwoFormalPass,async f=>{
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.state,'VALIDATION_BLOCKED');assert.equal(result.normalHandoff,null);
    assert.deepEqual(result.deliveries.map(item=>[item.deliveryId,item.formalStatus,item.observedValidation]),[
      [DELIVERY,'PASS','current'],
      ['22222222-2222-4222-8222-222222222222','PASS','current']]);
    assert.match(result.diagnostics[0].reason,/terminal/u);
  }));
});

test('R17 new processes read official image with historical canary denied',async t=>{
  for(const transport of ['native','managed']) for(const mode of ['api','cli']) await t.test(`${transport} authored ${mode}`,async()=>using(
    ()=>authoredCyclesImage({transport,cycles:3,removal:true}),async f=>{
      const observed=await workerRun(f,{mode});assert.equal(observed.process.status,0,observed.process.stderr);noAttempts(observed);
      const result=mode==='api'?observed.log.result:JSON.parse(observed.process.stdout);
      assert.equal(result.activationId,f.activation.activationId);assert.equal(result.sequence,9);
      assert.deepEqual(result.deliveries[0].counters,{implementationChecks:1,findingsChecks:3,validationAttempts:4,findings:1});
      assert.equal(result.deliveries[0].observedValidation,'current');assert.equal(result.state,'VALIDATION_BLOCKED');
      assert.equal(result.normalHandoff,null);assert.match(result.diagnostics[0].reason,/terminal/u);
      assert.equal(observed.log.opens[path.join(f.execution,'activation.json')],2);
      assert.equal(observed.log.opens[path.join(f.project,'src/pay.mjs')],2);
    }));

  for (const mode of ['api','cli']) await t.test(mode,async()=>using(producerPostApplyPass,async f=>{
    const canary=path.join(f.project,'tmp','historic','receipt.json');
    await fs.mkdir(path.dirname(canary),{recursive:true});await fs.writeFile(canary,'historical bytes');
    const observed=await workerRun(f,{mode});
    assert.equal(observed.process.status,0);assert.deepEqual(observed.log.attempts,[]);
    const result=mode==='api'?observed.log.result:JSON.parse(observed.process.stdout);
    assert.equal(result.activationId,'77777777-7777-4777-8777-777777777777');
    assert.equal(result.deliveries[0].formalStatus,'PASS');assert.equal(result.normalHandoff,null);
  }));
});

test('R18 guard self-test records caught historical reads and process/write attempts',async()=>using(producerInitialImage,async f=>{
  const canary=path.join(f.project,'tmp','historic','receipt.json');
  await fs.mkdir(path.dirname(canary),{recursive:true});await fs.writeFile(canary,'old');
  const inputHistory=path.join(f.project,'config/history');await fs.mkdir(inputHistory);
  await fs.writeFile(path.join(inputHistory,'receipt.json'),'outside approved input');
  const swallowed=await workerRun(f,{mode:'canary-caught'});
  assert.equal(swallowed.log.result.caught,true);
  assert.throws(()=>noAttempts(swallowed),assert.AssertionError);
  const observed=await workerRun(f,{mode:'selftest'});
  assert.equal(observed.process.status,0);assert.equal(observed.log.result.selftest,true);
  assert.throws(()=>noAttempts(observed),assert.AssertionError);
  for(const name of ['receipt.json','absent.json']) for(const method of ['fs.readFileSync','promises.lstat','promises.stat','promises.open'])
    assert.ok(observed.log.attempts.some(item=>item.method===method && item.path===path.join(inputHistory,name)),`${method}: ${name} outside input was not trapped`);
  assert.ok(observed.log.attempts.some(item=>item.method==='promises.readFile' && item.path===path.join(f.project,'config')),
    'parent directory permits inventory, not arbitrary byte reads');
  for (const method of ['fs.existsSync','fs.readFileSync','fs.statSync','fs.realpathSync','fs.readdirSync',
    'fs.stat','promises.lstat','promises.access','promises.realpath','promises.readdir','promises.opendir',
    'promises.open','fs.openSync','fs.createReadStream','fs.createWriteStream',
    'promises.writeFile','fs.openSync.write','fs.writeSync','FileHandle.writeFile','child_process.spawnSync'])
    assert.ok(observed.log.attempts.some(item=>item.method===method),`${method} was not trapped`);
  assert.ok(observed.log.attempts.filter(item=>item.method==='promises.stat').length>=1,
    'the promises namespace must route through the installed guard');
}));

test('R19 isolated reader closure and copy equivalence',async t=>{
  const names=['execution-current-reader.mjs','execution-state.mjs','execution-preparation.mjs',
    'execution-publication.mjs','runner-result-recovery.mjs','runner-result-contract.mjs',
    'execution-current.mjs','execution-preparation-current.mjs','current-evidence-state.mjs',
    'execution-evidence-current.mjs','execution-evidence-proof.mjs'];
  const legacyNames=['execution-state.mjs','execution-preparation.mjs','execution-publication.mjs',
    'runner-result-recovery.mjs','runner-result-contract.mjs'];
  const skillRoot=path.join(repo,'skills/workflows');
  const c6=['stnl-execution-planner','stnl-plan-reviewer','stnl-slice-executor',
    'stnl-slice-quality-manager','stnl-spec-roadmap','stnl-spec-test-runbook'];
  const install=async(f,skill,files,label)=>{
    const runtime=path.join(f.temporary,label,'runtime');await fs.mkdir(runtime,{recursive:true});
    for(const name of files) await fs.copyFile(path.join(skillRoot,skill,'runtime',name),path.join(runtime,name));
    return runtime;
  };
  for(const skill of c6) await t.test(`${skill} legacy state has its five-module closure`,async()=>using(authoredImage,async f=>{
    const state=await fs.readFile(path.join(skillRoot,skill,'runtime/execution-state.mjs'));
    assert.deepEqual(state,await fs.readFile(path.join(skillRoot,c6[0],'runtime/execution-state.mjs')));
    assert.doesNotMatch(state.toString('utf8'),/(?:from ['"]|import\(['"]).*(?:execution-current-reader|current-evidence-state|execution-preparation-current)/u);
    const runtime=await install(f,skill,legacyNames,'legacy');
    const isolated=await import(pathToFileURL(path.join(runtime,'execution-state.mjs')).href);
    assert.equal(typeof isolated.resolveExecutionWorkspace,'function');
    await rejected(()=>isolated.resolveExecutionWorkspace(f.specPath),'UNSUPPORTED_FORMAT','EC-1');
  }));
  for(const skill of c6.slice(0,4)) await t.test(`${skill} preparation with L1 and unchanged legacy CLI`,async()=>using(authoredImage,async f=>{
    const prepBytes=await fs.readFile(path.join(skillRoot,skill,'runtime/execution-preparation-current.mjs'));
    assert.deepEqual(prepBytes,await fs.readFile(path.join(skillRoot,c6[0],'runtime/execution-preparation-current.mjs')));
    const runtime=await install(f,skill,['execution-current.mjs','execution-preparation-current.mjs'],'preparation');
    const api=await import(pathToFileURL(path.join(runtime,'execution-preparation-current.mjs')).href);
    assert.deepEqual(Object.keys(api).sort(),['approveConversionPreparation','approveInitialPreparation',
      'finalizeCurrentLocalReview','prepareCurrentLocalReview',
      'projectConversionPreparation','projectInitialPreparation','validateConversionApprovedPreparation',
      'validateCurrentPreparation','validateInitialApprovedPreparation']);
    const prepared=api.validateCurrentPreparation({context:{logicalSpecRoot:null,logicalAuthorityPath:f.source,
      logicalExecutionRoot:f.execution,physicalExecutionRoot:f.execution,productRoot:f.project},
      requirementsAuthority:f.authority,snapshotBytes:f.files.get('approved-preparation.json'),artifacts:f.artifacts});
    assert.equal(prepared.authority.normativeSha256,f.snapshot.normativeSha256);
    assert.equal(digest(await fs.readFile(path.join(skillRoot,skill,'runtime/validate-execution-state.mjs'))),
      'sha256:528a40dfbdcb4282aebe0cac31291f1072fe4b7aa876ea99663c25fb12756611');
    const cliRoot=await install(f,skill,[...legacyNames,'validate-execution-state.mjs'],'cli');
    const cli=spawnSync(process.execPath,[path.join(cliRoot,'validate-execution-state.mjs'),f.specPath],{encoding:'utf8',cwd:os.tmpdir(),timeout:15000});
    assert.equal(cli.status,1,cli.stderr);assert.match(cli.stderr,/activation.json/u);assert.doesNotMatch(cli.stdout,/PASS/u);
  }));
  for(const skill of ['stnl-slice-executor','stnl-slice-quality-manager']) {
    await t.test(`${skill} reader API and real CLI in eleven siblings`,async()=>using(authoredImage,async f=>{
      for(const name of ['current-evidence-state.mjs','execution-current-reader.mjs'])
        assert.deepEqual(await fs.readFile(path.join(skillRoot,skill,'runtime',name)),
          await fs.readFile(path.join(skillRoot,'stnl-slice-executor','runtime',name)));
      const runtime=await install(f,skill,names,'reader');
      const api=await import(pathToFileURL(path.join(runtime,'execution-current-reader.mjs')).href);
      const result=await api.inspectCurrentExecution(f.specPath);
      assert.deepEqual(result.normalHandoff,{operation:'EXECUTE_SLICE',slice:'slice-01',deliveryId:DELIVERY});
      assert.equal(result.state,'MATERIALIZED_PRISTINE');assert.equal(result.activationId,'33333333-3333-4333-8333-333333333333');
      assert.deepEqual(result.deliveries.map(item=>item.counters),[0,1].map(()=>({implementationChecks:0,findingsChecks:0,validationAttempts:0,findings:0})));
      const cli=spawnSync(process.execPath,[path.join(runtime,'execution-current-reader.mjs'),f.specPath],{encoding:'utf8',cwd:os.tmpdir(),timeout:15000});
      assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),result);
    }));
    await t.test(`${skill} missing proof cannot fall back to another package`,async()=>using(authoredImage,async f=>{
      const runtime=await install(f,skill,names.filter(name=>name!=='execution-evidence-proof.mjs'),'missing');
      const cli=spawnSync(process.execPath,[path.join(runtime,'execution-current-reader.mjs'),f.specPath],{encoding:'utf8',timeout:15000});
      assert.notEqual(cli.status,0);assert.match(cli.stderr,/ERR_MODULE_NOT_FOUND/u);assert.match(cli.stderr,/execution-evidence-proof.mjs/u);
    }));
  }
  await t.test('foreign main basename does not execute the imported reader',async()=>using(authoredImage,async f=>{
    const imported=await workerRun(f,{mode:'import-only'});noAttempts(imported);
    assert.equal(imported.process.status,0,imported.process.stderr);assert.deepEqual(JSON.parse(imported.process.stdout),
      {exports:['captureCurrentActiveExecution','captureCurrentExecution','inspectCurrentExecution','main','observeCurrentDeliveryWork','validateCurrentReviewCandidate']});
    assert.deepEqual(imported.log.opens,{});
  }));
  for(const label of ['no argument','mutating flag','unknown flag']) await t.test(`CLI usage ${label}`,async()=>using(authoredImage,async f=>{
    const args=label==='no argument'?[]:label==='mutating flag'?[f.specPath,'--repair']:['--unknown'];
    const cli=spawnSync(process.execPath,[reader,...args],{encoding:'utf8',timeout:15000});
    assert.equal(cli.status,2);assert.match(cli.stderr,/Usage:/u);
  }));
});

test('R20 legacy entrypoints refuse EC-1 before effects, including candidate',async t=>{
  for(const action of ['resolve','inspect','read','preflight','begin','recovery','resume','repair','continuity','history','workcapture'])
    await t.test(`guarded legacy ${action} has zero effects or historical queries`,async()=>using(authoredImage,async f=>{
      const observed=await workerRun(f,{mode:`legacy:${action}`,selected:path.join(path.dirname(reader),'execution-state.mjs')});
      noAttempts(observed);assert.equal(observed.log.result.error?.code,'UNSUPPORTED_FORMAT');
      assert.match(observed.log.result.error.message,/EC-1/u);
    }));
  for(const discriminator of ['approved-preparation.json','continuity.json'])
    await t.test(`partial EC-1 ${discriminator} is fenced before legacy admission`,async()=>using(authoredImage,async f=>{
      await fs.rm(path.join(f.execution,'activation.json'));
      if(discriminator==='continuity.json') await fs.rm(path.join(f.execution,'approved-preparation.json'));
      const observed=await workerRun(f,{mode:'legacy:begin',selected:path.join(path.dirname(reader),'execution-state.mjs')});
      noAttempts(observed);assert.equal(observed.log.result.error?.code,'UNSUPPORTED_FORMAT');
      assert.match(observed.log.result.error.message,new RegExp(discriminator.replaceAll('.','\\.')));
    }));
  await t.test('invalid discriminator does not authorize legacy fallback',async()=>using(authoredImage,async f=>{
    await fs.writeFile(path.join(f.execution,'activation.json'),'{');
    const observed=await workerRun(f,{mode:'legacy:begin',selected:path.join(path.dirname(reader),'execution-state.mjs')});
    noAttempts(observed);assert.equal(observed.log.result.error?.code,'INVALID_CURRENT_IMAGE');
    assert.match(observed.log.result.error.message,/activation.json/u);
  }));

  await t.test('new reader refuses legacy activation',async()=>using(authoredImage,async f=>{
    await fs.writeFile(path.join(f.execution,'activation.json'),' {"format":"stnl-execution-activation-v1"}\n');
    await rejected(()=>inspectCurrentExecution(f.specPath),'MIGRATION_REQUIRED');
  }));
  await t.test('closed lifecycle without execution',async()=>using(()=>authoredImage({kind:'lifecycle',withExecution:false}),async f=>{
    const current=await fs.readFile(f.source,'utf8');
    await fs.writeFile(f.source,current.replace('status: ready','status: closed')
      .replace('## Scope\n','## Final Scope\n').replace('## Relevant Contracts\n','## Important Contracts\n'));
    const result=await inspectCurrentExecution(f.specPath);
    assert.equal(result.state,'SPEC_CLOSED');assert.equal(result.normalHandoff,null);
  }));
  await t.test('live EC-1',async()=>using(authoredImage,async f=>{
    const before=await manifest(f.project);
    for (const operation of [()=>legacy.resolveExecutionWorkspace(f.specPath),
      ()=>legacy.inspectExecutionState(f.specPath),
      ()=>legacy.preflightExecutionOperation(f.specPath,'EXECUTE_SLICE',1),
      ()=>legacy.beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE',1,f.activation.activationId),
      ()=>legacy.beginRunnerResultRecovery(f.specPath,'EXECUTE_SLICE',1,{}),
      ()=>legacy.repairExecutionContract(f.specPath),
      ()=>legacy.resumeOwnedExecutionOperation(f.specPath,'EXECUTE_SLICE',1,{}),
      ()=>legacy.readDeliveryContinuity({executionRoot:f.execution,specRoot:f.spec,authorityPath:f.source,kind:'lifecycle'}),
      ()=>legacy.readDeliveryHistory({executionRoot:f.execution,specRoot:f.spec,authorityPath:f.source,kind:'lifecycle'},
        {history:[]},''),
      ()=>legacy.readContinuationWorkCapture({executionRoot:f.execution,specRoot:f.spec,authorityPath:f.source,kind:'lifecycle'},
        {path:path.join(f.execution,'history','missing.json'),sha256:raw(Buffer.from('missing'))},
        {slice:'slice-01',deliveryId:DELIVERY}),
    ]) await rejected(operation,'UNSUPPORTED_FORMAT','EC-1');
    assert.deepEqual(await manifest(f.project),before);
  }));
  await t.test('candidate EC-1 with absent live',async()=>using(()=>authoredImage({withExecution:false}),async live=>{
    await using(authoredImage,async candidate=>{
      const before=await manifest(live.project);
      await rejected(()=>legacy.validateExecutionCandidate(live.specPath,candidate.execution),
        'UNSUPPORTED_FORMAT','EC-1');
      assert.deepEqual(await manifest(live.project),before);
      const guarded=await workerRun(live,{mode:'legacy:candidate',selected:path.join(path.dirname(reader),'execution-state.mjs'),
        env:{STNL_CANDIDATE:candidate.execution}});
      noAttempts(guarded);assert.equal(guarded.log.result.error?.code,'UNSUPPORTED_FORMAT');
      assert.match(guarded.log.result.error.message,/EC-1/u);
    });
  }));
  await t.test('candidate EC-1 with legacy live',async()=>using(()=>authoredImage({withExecution:false}),async live=>{
    await fs.mkdir(live.execution,{recursive:true});
    await fs.writeFile(path.join(live.execution,'activation.json'),' {"format":"stnl-execution-activation-v1"}\n');
    await using(authoredImage,async candidate=>{
      const before=await manifest(live.project);
      await rejected(()=>legacy.validateExecutionCandidate(live.specPath,candidate.execution),
        'UNSUPPORTED_FORMAT','EC-1');
      assert.deepEqual(await manifest(live.project),before);
      const guarded=await workerRun(live,{mode:'legacy:candidate',selected:path.join(path.dirname(reader),'execution-state.mjs'),
        env:{STNL_CANDIDATE:candidate.execution}});
      noAttempts(guarded);assert.equal(guarded.log.result.error?.code,'UNSUPPORTED_FORMAT');
      assert.match(guarded.log.result.error.message,/EC-1/u);
    });
  }));
});
