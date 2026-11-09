import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {runSyntheticCampaign,inspectHistoricalCampaign,presentHistoricalCampaign} from './lib/python-sql-campaign.mjs';
const located=spawnSync('python3',['-I','-S','-c','import sys;print(sys.executable)'],{encoding:'utf8'});
assert.equal(located.status,0,'Python3 stdlib is required to exercise the real SQL campaign');
const python=located.stdout.trim(),fixture=path.resolve('scripts/fixtures/python-sql-campaign');
const common=['checks/db_local.py','database/synthetic.sqlproj','database/schema.sql','database/PreDeployment.sql','database/PostDeployment.sql','fixtures/synthetic.csv'];
const standard=['schema','import','rebuild'].map(id=>({id,script:`checks/check_${id}.py`,declaredInputs:[...common,`checks/check_${id}.py`]}));
async function setup(t) {const parent=await fs.mkdtemp(path.join(os.tmpdir(),'stnl-python-sql-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));const fixtureRoot=path.join(parent,'fixture');await fs.cp(fixture,fixtureRoot,{recursive:true});return {parent,fixtureRoot,campaignRoot:path.join(parent,'campaign'),python,checks:structuredClone(standard)};}
const observation=async(f,id)=>JSON.parse(await fs.readFile(path.join(f.campaignRoot,id+'.observation.json'),'utf8')).payload;
const inspect=f=>inspectHistoricalCampaign(f);
const status=report=>Object.fromEntries(report.decisions.map(item=>[item.id,item.action]));
async function addScript(f,id,text,extra=[]) {const script='checks/'+id+'.py';await fs.writeFile(path.join(f.fixtureRoot,script),text);return {id,script,declaredInputs:[script,...extra]};}

test('actual Python/SQL campaign counts processes and presents original evidence without another invocation or formal PASS',async t=>{
 const f=await setup(t),begin=performance.now(),campaign=await runSyntheticCampaign(f),executionElapsed=performance.now()-begin;
 assert.equal(campaign.physicalInvocations,3);assert.equal(campaign.databaseConnectionCount,4);assert.equal(campaign.physicalDatabasePublications,0);assert.equal(campaign.sqlServerCertified,false);
 assert.deepEqual(campaign.checks.map(check=>check.status),['passed','passed','passed']);
 const original=await fs.readFile(path.join(f.campaignRoot,'campaign.json'));
 const sourceBytes=await Promise.all(standard.map(check=>fs.readFile(path.join(f.campaignRoot,check.id+'.observation.json'))));
 const rebuilding=await observation(f,'rebuild');assert.match(rebuilding.execution.stdout,/nonempty rebuild refused with exact data preservation/);assert.equal(rebuilding.execution.exit,0);
 const presenting=performance.now();const report=await presentHistoricalCampaign({...f,presentationFile:path.join(f.parent,'formal-review-input.json'),operationIdentity:'VALIDATE_SLICE:new-independent-operation',reviewerIdentity:'synthetic-independent-reviewer'});const presentationElapsed=performance.now()-presenting;
 assert.equal(report.physicalInvocations,0);assert.equal(report.priorInvocationsReferenced,3);assert.equal(report.automaticReuseAllowed,false);assert.equal(report.formalAcceptance,false);assert.equal(report.status,'historical-evidence-awaiting-independent-review');
 assert.deepEqual(await fs.readFile(path.join(f.campaignRoot,'campaign.json')),original);
 for(const [index,check] of standard.entries())assert.deepEqual(await fs.readFile(path.join(f.campaignRoot,check.id+'.observation.json')),sourceBytes[index]);
 assert.notEqual(report.operationIdentity,report.campaignId);assert.match(report.warning,/not execution.*formal acceptance/);
 console.log('[synthetic-campaign-measurement] '+JSON.stringify({physicalPythonExecutions:3,physicalPythonExecutionsDuringPresentation:0,sqliteMemoryConnections:4,sqlServerPublications:0,executionElapsedMs:executionElapsed,presentationElapsedMs:presentationElapsed,deltaMs:executionElapsed-presentationElapsed,scope:'this synthetic run only; presentation is not a skipped required check or formal PASS'}));
});

test('new unread verifier and local package shadows do not become dependencies of earlier checks',async t=>{
 const f=await setup(t);await runSyntheticCampaign(f);
 const additional=await addScript(f,'new-verifier','raise AssertionError("new verifier must not run during historical presentation")\n');
 await fs.writeFile(path.join(f.fixtureRoot,'checks/sqlite3.py'),'raise AssertionError("local shadow must never load")\n');
 const before=await inspect({...f,checks:[...f.checks,additional]});assert.deepEqual(status(before),{schema:'present-for-independent-review',import:'present-for-independent-review',rebuild:'present-for-independent-review','new-verifier':'execute'});
 const rerun=await runSyntheticCampaign({...f,campaignRoot:path.join(f.parent,'independent-rerun')});assert.ok(rerun.checks.every(check=>check.status==='passed'));
});
for(const changed of ['checks/db_local.py','database/schema.sql','database/PreDeployment.sql','database/PostDeployment.sql','database/synthetic.sqlproj','fixtures/synthetic.csv'])test('tracked dependency change invalidates its actual consumers: '+changed,async t=>{
 const f=await setup(t);await runSyntheticCampaign(f);await fs.appendFile(path.join(f.fixtureRoot,changed),'\n');
 const report=await inspect(f);for(const decision of report.decisions)assert.equal(decision.action,changed==='fixtures/synthetic.csv'&&decision.id==='schema'?'present-for-independent-review':'execute');
});
test('file mode changes are not hidden by identical bytes',async t=>{
 const f=await setup(t);await runSyntheticCampaign(f);await fs.chmod(path.join(f.fixtureRoot,'checks/db_local.py'),0o755);assert.ok((await inspect(f)).decisions.every(item=>item.action==='execute'));
});
test('glob membership is an observed dependency, not permission over a directory',async t=>{
 const f=await setup(t);await fs.mkdir(path.join(f.fixtureRoot,'checks/rules'));await fs.writeFile(path.join(f.fixtureRoot,'checks/rules/first.sql'),'SELECT 1;\n');
 const check=await addScript(f,'glob-check','from pathlib import Path\nroot=Path(__file__).parent / "rules"\nassert all(file.read_text().startswith("SELECT") for file in root.glob("*.sql"))\nprint("glob checked")\n',['checks/rules/first.sql']);f.checks=[check];
 assert.equal((await runSyntheticCampaign(f)).checks[0].status,'passed');assert.equal((await inspect(f)).decisions[0].action,'present-for-independent-review');
 await fs.writeFile(path.join(f.fixtureRoot,'checks/rules/second.sql'),'SELECT 2;\n');const changed=await inspect(f);assert.equal(changed.decisions[0].action,'execute');assert.ok(changed.decisions[0].reasons.includes('membership-changed:checks/rules'));
});
test('undeclared indirect PreDeployment input is discovered and cannot silently gain reuse eligibility',async t=>{
 const f=await setup(t);f.checks=f.checks.map(check=>({...check,declaredInputs:check.declaredInputs.filter(name=>name!=='database/PreDeployment.sql')}));await runSyntheticCampaign(f);
 for(const check of f.checks)assert.deepEqual((await observation(f,check.id)).undeclaredInputs,['database/PreDeployment.sql']);
 assert.ok((await inspect(f)).decisions.every(item=>item.action==='execute'&&item.reasons.includes('indirect-input-not-declared')));
});
test('check order cannot contaminate another isolated database',async t=>{
 const f=await setup(t);const forward=await runSyntheticCampaign(f),reverse=await runSyntheticCampaign({...f,campaignRoot:path.join(f.parent,'reverse'),checks:[...f.checks].reverse()});
 assert.equal(forward.physicalInvocations+reverse.physicalInvocations,6);assert.ok([...forward.checks,...reverse.checks].every(item=>item.status==='passed'));assert.equal(reverse.databaseConnectionCount,4);
});
for(const script of [
 'import time\nprint(time.perf_counter())\n',
 'from db_local import fresh_database\nwith fresh_database() as db: print(db.execute("SELECT random()").fetchone())\n'
])test('temporal/random observation is preserved but requires new execution',async t=>{
 const f=await setup(t);f.checks=[await addScript(f,'temporal',script,common)];await runSyntheticCampaign(f);const saved=await observation(f,'temporal');assert.equal(saved.status,'passed');assert.ok(saved.measured.ambientInputs.length);const decision=(await inspect(f)).decisions[0];assert.equal(decision.action,'execute');assert.ok(decision.reasons.includes('temporal-random-or-concurrent-input'));
});
test('mutable live database is rejected before execution and cannot be substituted in historical inspection',async t=>{
 const f=await setup(t);await runSyntheticCampaign(f);const db=path.join(f.parent,'synthetic-existing.db');await fs.writeFile(db,'synthetic external state version one');
 await assert.rejects(runSyntheticCampaign({...f,campaignRoot:path.join(f.parent,'live'),database:{kind:'sqlite-file',path:db}}),{code:'LIVE_STATE_UNSUPPORTED'});
 await fs.writeFile(db,'synthetic external state version two');await assert.rejects(inspectHistoricalCampaign({...f,database:{kind:'sqlite-file',path:db}}),{code:'LIVE_STATE_UNSUPPORTED'});
 assert.equal(await fs.readFile(db,'utf8'),'synthetic external state version two');
});
for(const source of [
 'import sqlite3\nsqlite3.connect("existing.db")\n',
 'from db_local import fresh_database\nwith fresh_database() as db: db.execute("ATTACH DATABASE \'existing.db\' AS foreign_db")\n',
 'import subprocess\nsubprocess.run(["echo","not allowed"])\n',
 'import socket\nsocket.socket()\n',
 'import sqlite3\nsqlite3.connect(":memory:").enable_load_extension(True)\n',
 'import sqlite3\nconnection=sqlite3.Connection(":memory:")\nconnection.execute("ATTACH DATABASE \'existing.db\' AS foreign_db")\n',
 'import sqlite3.dbapi2\nconnection=sqlite3.dbapi2.connect(":memory:")\nconnection.execute("ATTACH DATABASE \'existing.db\' AS foreign_db")\n',
 'import sqlite3\nconnection=sqlite3.connect(":memory:")\nconnection.set_authorizer(None)\n'
])test('unsupported capability fails closed without opening a live database or subprocess',async t=>{
 const f=await setup(t);f.checks=[await addScript(f,'unsupported',source,common)];const campaign=await runSyntheticCampaign(f);assert.equal(campaign.checks[0].status,'unsupported');assert.equal((await inspect(f)).decisions[0].action,'execute');assert.equal(await fs.stat(path.join(f.campaignRoot,'source/existing.db')).catch(()=>null),null);
});
test('functional failure, infrastructure failure and historical presentation remain distinct',async t=>{
 const f=await setup(t);f.checks=[await addScript(f,'failure','assert False, "synthetic functional mismatch"\n')];const functional=await runSyntheticCampaign(f);assert.equal(functional.checks[0].status,'functional-failure');
 const fake=path.join(f.parent,'unavailable-python');await fs.writeFile(fake,'#!/bin/sh\necho "synthetic backend unavailable" >&2\nexit 7\n',{mode:0o700});const infra=await runSyntheticCampaign({...f,campaignRoot:path.join(f.parent,'infra'),python:fake});assert.equal(infra.checks[0].status,'infrastructure-error');assert.equal(infra.physicalInvocations,1);
});
test('changed recipe, copied owner and tampered result cannot impersonate the original authenticated campaign',async t=>{
 const f=await setup(t);await runSyntheticCampaign(f);
 const different=f.checks.map(check=>({...check,declaredInputs:[...check.declaredInputs,'checks/additional.py']}));assert.ok((await inspect({...f,checks:different})).decisions.every(item=>item.action==='execute'&&item.reasons.includes('recipe-changed')));
 const copy=path.join(f.parent,'copied-campaign');await fs.cp(f.campaignRoot,copy,{recursive:true});await assert.rejects(inspect({...f,campaignRoot:copy}),{code:'OWNER_MISMATCH'});
 const name=path.join(f.campaignRoot,'schema.observation.json'),tampered=JSON.parse(await fs.readFile(name));tampered.payload.execution.stdout='FORGED PASS';await fs.writeFile(name,JSON.stringify(tampered));await assert.rejects(inspect(f),{code:'UNTRUSTED_PROOF'});
});

test('known unobserved metadata dependencies require execution rather than silently accepting the audit trace',async t=>{
 const f=await setup(t);f.checks=[await addScript(f,'metadata','from pathlib import Path\nassert not (Path(__file__).parent / "toggle").exists()\n')];await runSyntheticCampaign(f);
 assert.ok((await observation(f,'metadata')).measured.unclosedInputs.length);await fs.writeFile(path.join(f.fixtureRoot,'checks/toggle'),'new metadata-only input');
 const report=await inspect(f);assert.equal(report.decisions[0].action,'execute');assert.ok(report.decisions[0].reasons.includes('unobserved-or-dynamic-dependency'));assert.equal(report.automaticReuseAllowed,false);
});

test('nonregular reads are refused before an untracked open',async t=>{
 const f=await setup(t);f.checks=[await addScript(f,'nonregular','from pathlib import Path\nopen(Path(__file__).parent, "rb")\n')];
 assert.equal((await runSyntheticCampaign(f)).checks[0].status,'unsupported');
});
test('metadata mutation cannot change a test-owned sentinel outside the frozen source',async t=>{
 const f=await setup(t),sentinel=path.join(f.parent,'owned-sentinel.txt');await fs.writeFile(sentinel,'preserve synthetic sentinel');const before=await fs.stat(sentinel);
 f.checks=[await addScript(f,'metadata-mutation','import os\nos.utime('+JSON.stringify(sentinel)+', (1, 1))\n')];assert.equal((await runSyntheticCampaign(f)).checks[0].status,'unsupported');
 const after=await fs.stat(sentinel);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(await fs.readFile(sentinel,'utf8'),'preserve synthetic sentinel');
});
test('dynamic calls are flagged conservatively even when this synthetic invocation passed',async t=>{
 const f=await setup(t);f.checks=[await addScript(f,'dynamic','assert eval("1 + 1") == 2\n')];await runSyntheticCampaign(f);const saved=await observation(f,'dynamic');assert.equal(saved.status,'passed');assert.ok(saved.measured.unclosedInputs.length);const decision=(await inspect(f)).decisions[0];assert.equal(decision.action,'execute');assert.ok(decision.reasons.includes('unobserved-or-dynamic-dependency'));
});
test('SQL current_timestamp is explicitly temporal, not certified as deterministic',async t=>{
 const f=await setup(t);f.checks=[await addScript(f,'sql-time','from db_local import fresh_database\nwith fresh_database() as db: print(db.execute("SELECT current_timestamp").fetchone())\n',common)];await runSyntheticCampaign(f);const saved=await observation(f,'sql-time');assert.equal(saved.status,'passed');assert.ok(saved.measured.ambientInputs.includes('sqlite-temporal-or-random-function'));const decision=(await inspect(f)).decisions[0];assert.equal(decision.action,'execute');assert.ok(decision.reasons.includes('temporal-random-or-concurrent-input'));
});
test('new real Build Include is read and an omitted indirect dependency remains non-reusable',async t=>{
 const f=await setup(t);const project=path.join(f.fixtureRoot,'database/synthetic.sqlproj');await fs.writeFile(project,(await fs.readFile(project,'utf8')).replace('<Build Include="schema.sql" />','<Build Include="schema.sql" /><Build Include="additional.sql" />'));await fs.writeFile(path.join(f.fixtureRoot,'database/additional.sql'),'CREATE TABLE synthetic_additional(id INTEGER PRIMARY KEY);\n');
 await runSyntheticCampaign(f);for(const check of f.checks)assert.ok((await observation(f,check.id)).undeclaredInputs.includes('database/additional.sql'));assert.ok((await inspect(f)).decisions.every(item=>item.action==='execute'));
});

test('historical presentation cannot modify or conceal mutation of the original frozen source',async t=>{
 const f=await setup(t);await runSyntheticCampaign(f);await assert.rejects(presentHistoricalCampaign({...f,presentationFile:path.join(f.campaignRoot,'source/new-presentation.json'),operationIdentity:'next',reviewerIdentity:'reviewer'}),{code:'UNSAFE_PATH'});
 await fs.appendFile(path.join(f.campaignRoot,'source/checks/db_local.py'),'# changed original snapshot\n');await assert.rejects(inspect(f),{code:'INPUT_CHANGED'});
});

test('materialized previously absent import candidate invalidates its historical reference',async t=>{
 const f=await setup(t);await runSyntheticCampaign(f);const saved=await observation(f,'schema'),absent=saved.measured.absentReads.find(name=>name.includes('__pycache__'));assert.ok(absent,'the source-only helper import records its absent bytecode candidate');
 const target=path.join(f.fixtureRoot,absent);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'synthetic new import candidate');
 const decision=(await inspect(f)).decisions.find(item=>item.id==='schema');assert.equal(decision.action,'execute');assert.ok(decision.reasons.includes('absent-input-materialized:'+absent));
});

test('physical parent aliases are normalized for campaign ownership and cannot bypass presentation protection',async t=>{
 const f=await setup(t),alias=path.join(f.parent,'parent-alias');await fs.symlink(f.parent,alias,'dir');const aliased={...f,campaignRoot:path.join(alias,'campaign')};await runSyntheticCampaign(aliased);assert.ok((await inspect(aliased)).decisions.every(item=>item.action==='present-for-independent-review'));
 await assert.rejects(presentHistoricalCampaign({...aliased,presentationFile:path.join(alias,'campaign/source/alter.json'),operationIdentity:'next',reviewerIdentity:'reviewer'}),{code:'UNSAFE_PATH'});
});

// Exercise the actual callback with both CPython event representations even on
// interpreters that emit only one. The complete campaign above still executes
// real Python/SQLite; these callback regressions do not replace platform smoke.
test('SQLite audit identity accepts only exact owned memory str/bytes representations',()=>{
 const probe=String.raw`
import pathlib, sys
source_path = pathlib.Path(sys.argv[1]).resolve()
source = source_path.read_text()
# Load the driver's definitions before it installs process-global audit/import
# hooks or executes a fixture. No rewritten copy of the callback is tested.
prefix, separator, _ = source.partition("\noriginal_import = builtins.__import__")
assert separator, "driver definition boundary missing"
sys.argv = [str(source_path), str(source_path.parent), "unused.py", "audit-regression"]
namespace = {"__file__": str(source_path)}
exec(compile(prefix, str(source_path), "exec"), namespace)
audit = namespace["audit"]
unsupported = namespace["UnsupportedCapability"]
class EqualToMemory:
    def __eq__(self, other):
        return True
class MemoryPath:
    def __fspath__(self):
        return ":memory:"
class StringSubclass(str):
    pass
class BytesSubclass(bytes):
    pass
accepted = [":memory:", b":memory:"]
rejected = ["existing.db", b"existing.db", "", b"", "file::memory:?cache=shared",
            b"file::memory:?cache=shared", "file:existing.db?mode=ro", b"file:existing.db?mode=ro",
            ":memory:\x00", b":memory:\x00", b"\xff:memory:", ":MEMORY:", b":MEMORY:",
            pathlib.Path(":memory:"), MemoryPath(), ":memory:suffix", b":memory:suffix",
            None, 0, bytearray(b":memory:"), memoryview(b":memory:"), EqualToMemory(),
            StringSubclass(":memory:"), BytesSubclass(b":memory:")]
for owned in (True, False):
    for identity in accepted + rejected:
        namespace["creating_owned_connection"] = owned
        namespace["databases"].clear()
        namespace["denied"].clear()
        should_accept = owned and type(identity) in (str, bytes) and identity in accepted
        try:
            audit("sqlite3.connect", (identity,))
        except unsupported as error:
            assert not should_accept, repr(identity)
            expected = "live/file database has no closed state identity" if owned else "unowned SQLite constructor is unsupported"
            assert str(error) == expected, (repr(identity), str(error))
            assert namespace["denied"] == [expected]
            assert namespace["databases"] == []
        else:
            assert should_accept, repr(identity)
            assert namespace["denied"] == []
            assert namespace["databases"] == [{"kind": "sqlite-memory", "initialState": "empty", "ordinal": 1}]
        assert namespace["inside"] is False
print("52 owned/unowned audit identity cases passed")
`;
 const result=spawnSync(python,['-I','-S','-c',probe,path.resolve('scripts/lib/python-sql-check-driver.py')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr||result.stdout);
 assert.match(result.stdout,/52 owned\/unowned audit identity cases passed/);
});

for(const identity of ['b":memory:"','"file::memory:?cache=shared"','b"existing.db"'])test('public SQLite constructor profile remains string-only and URI/file closed: '+identity,async t=>{
 const f=await setup(t);f.checks=[await addScript(f,'constructor-profile','import sqlite3\nsqlite3.connect('+identity+')\n')];
 const campaign=await runSyntheticCampaign(f);assert.equal(campaign.checks[0].status,'unsupported');
 const saved=await observation(f,'constructor-profile');assert.equal(saved.measured.databases.length,0);
 assert.equal((await inspect(f)).decisions[0].action,'execute');
});
