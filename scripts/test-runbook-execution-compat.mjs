import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {ancestorFixture} from './test-p1b-candidate-lifecycle.mjs';
import {implementOffline} from './test-p1b-publication.mjs';
import {setSection,evidence} from './test-p1b-continuity.mjs';
import {inspectWorkspace} from '../skills/workflows/stnl-spec-test-runbook/runtime/lib/core.mjs';
import {inspectExecutionState,readExecutionActivation,beginPreparedExecutionOperation,validateExecutionCandidate} from '../skills/workflows/stnl-execution-planner/runtime/execution-state.mjs';
import {publishExecutionCopy} from '../skills/workflows/stnl-slice-executor/runtime/prepare-execution-copy.mjs';

// U1 removed materializer/unactivated ready fixtures: use real joint producers.
test('operational runbook fixture is valid shared execution state',async()=>{
 const f=await ancestorFixture();const image=await readExecutionActivation(f.specPath);
 const admitted=await beginPreparedExecutionOperation(f.specPath,'EXECUTE_SLICE','1',image.activation.activationId);
 const implemented=await implementOffline(f,admitted,{directory:'specs'});
 await publishExecutionCopy({specPath:f.specPath,slice:'slice-01',candidateRoot:implemented.copy.candidateRoot});
 assert.equal((await inspectExecutionState(f.specPath)).state,'IMPLEMENTED_AWAITING_VALIDATION');
 const result=await inspectWorkspace(f.specPath,'EXECUTION',{});assert.equal(result.scope.kind,'EXECUTION');
 assert.ok(result.mandatory_sources.includes(path.join(f.workspace.executionRoot,'tasks/slice-01.md')));
 await evidence(f,'runbook-operational',{result});
});
test('real joint planner templates are accepted by both execution consumers',async()=>{
 const f=await ancestorFixture();assert.equal((await inspectExecutionState(f.specPath)).state,'MATERIALIZED_PRISTINE');
 const result=await inspectWorkspace(f.specPath,'EXECUTION',{});assert.equal(result.scope.kind,'EXECUTION');
 assert.equal(result.mandatory_sources.filter(p=>p.endsWith('execution/tasks/slice-01.md')).length,1);
 await evidence(f,'runbook-joint-templates',{result});
});
test('runbook rejects execution artifacts after current requirements authority changes',async()=>{
 const f=await ancestorFixture();await fs.appendFile(path.join(f.specPath,'shared/requirements.md'),'\nAdditional proof input for this controlled authority drift.\n');
 assert.equal((await inspectExecutionState(f.specPath)).state,'REQUIREMENTS_CHANGED');
 await assert.rejects(inspectWorkspace(f.specPath,'EXECUTION',{}),/Requirements authority is stale/);
 await evidence(f,'runbook-stale-authority');
});
test('runbook rejects malformed persisted execution evidence',async()=>{
 const f=await ancestorFixture();const file=path.join(f.workspace.executionRoot,'tasks/slice-01.md');const before=await fs.readFile(file);
 const candidate=path.join(f.root,'malformed-evidence');await fs.cp(f.workspace.executionRoot,candidate,{recursive:true});
 const bad=setSection(before.toString('utf8'),'Validation Findings','### finding-01\n\n- Severity: blocking\n- State: active\n- Origin: attempt-99\n- Problem: Orphan formal finding\n- Evidence: No matching formal attempt\n- Impact: Acceptance is ambiguous\n- Related authority: AC-001\n- Expected correction: Preserve and resolve provenance');
 await fs.writeFile(path.join(candidate,'tasks/slice-01.md'),bad);
 await assert.rejects(validateExecutionCandidate(f.specPath,candidate),/Origin must name an existing NEEDS_FIX attempt/);
 assert.deepEqual(await fs.readFile(file),before);
 await fs.writeFile(file,bad);await assert.rejects(inspectWorkspace(f.specPath,'EXECUTION',{}),/activation manifest does not cover current artifacts/);
 await fs.writeFile(file,before);assert.equal((await inspectWorkspace(f.specPath,'EXECUTION',{})).scope.kind,'EXECUTION');
 await evidence(f,'runbook-malformed-evidence',{candidate});
});
