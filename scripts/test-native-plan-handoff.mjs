import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStructuredCommandResults} from '../agents/codex/runtime/native-provider.mjs';


const authority = {
  requirementsAuthority: 'sha256:requirements',
  preparationRevision: 1,
  artifactHashes: [{path:'plan.md',sha256:'sha256:plan'}],
};
const request = (overrides = {}) => ({
  status:'AWAITING_REVIEW',
  candidateExecutionRoot:'/owned/initial-candidate',
  authority:structuredClone(authority),
  publication:'not-started',
  ...overrides,
});
test('structured command output keeps one and multiline JSON objects',()=>{
  const one=request();
  assert.deepEqual(parseStructuredCommandResults(JSON.stringify(one)),[one]);
  const pretty=JSON.stringify(one,null,2);
  assert.deepEqual(parseStructuredCommandResults(` \n${pretty}\n `),[one]);
});

test('structured command output preserves every whitespace-delimited JSON record',()=>{
  const first=request(),second=request({status:'OTHER'});
  assert.deepEqual(parseStructuredCommandResults(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`),[first,second]);
});

test('structured command output rejects prose, malformed tails, arrays, and concatenation without a delimiter',()=>{
  const valid=JSON.stringify(request());
  for (const output of [`status: AWAITING_REVIEW\n${valid}`,`${valid}\n{broken`,JSON.stringify([request()]),`${valid}${valid}`])
    assert.deepEqual(parseStructuredCommandResults(output),[]);
});
