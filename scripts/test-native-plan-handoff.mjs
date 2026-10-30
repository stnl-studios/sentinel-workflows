import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStructuredCommandResults} from '../agents/codex/runtime/native-provider.mjs';
import {preparationHandoff} from '../benchmarks/sentinel-todo/runtime/native-evidence.mjs';

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
const officialProduct = (candidate = request(),ownedRoot = candidate.candidateExecutionRoot) => ({
  assertPreparationCandidate:async root=>({root:ownedRoot,marker:{operation:'PLAN'}}),
  serializePlanPathClaims:async ({candidateExecutionRoot})=>({
    status:'PASS',authority:structuredClone(candidate.authority),candidateExecutionRoot,
  }),
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

test('normal official PLAN handoff accepts a single complete producer return',async()=>{
  const result=await preparationHandoff(officialProduct(),'/spec',[request()]);
  assert.deepEqual(result,request());
});

test('identical complete returns from one PLAN operation count as one handoff',async()=>{
  const candidate=request();
  const result=await preparationHandoff(officialProduct(candidate),'/spec',[candidate,structuredClone(candidate)]);
  assert.deepEqual(result,candidate);
});

test('different candidate roots or any differing evidence content remain ambiguous',async()=>{
  const candidate=request();
  await assert.rejects(preparationHandoff(officialProduct(candidate),'/spec',[
    candidate,request({candidateExecutionRoot:'/owned/other-candidate'}),
  ]),{code:'NATIVE_EVIDENCE_UNPROVEN'});
  await assert.rejects(preparationHandoff(officialProduct(candidate),'/spec',[
    candidate,request({extra:'different full return content'}),
  ]),{code:'NATIVE_EVIDENCE_UNPROVEN'});
  await assert.rejects(preparationHandoff(officialProduct(candidate),'/spec',[
    candidate,request({publication:'confirmed'}),
  ]),{code:'NATIVE_EVIDENCE_UNPROVEN'});
});

test('a return with forged or stale authority is rejected against current serialization',async()=>{
  const candidate=request({authority:{...authority,artifactHashes:[{path:'plan.md',sha256:'sha256:stale'}]}});
  await assert.rejects(preparationHandoff(officialProduct(request()),'/spec',[candidate]),
    {code:'NATIVE_EVIDENCE_UNPROVEN'});
});

test('redelivery still requires the retained same root and complete authority',async()=>{
  const candidate=request();
  const redelivery={candidateExecutionRoot:candidate.candidateExecutionRoot,authority:structuredClone(authority)};
  assert.deepEqual(await preparationHandoff(officialProduct(candidate),'/spec',[candidate],redelivery),candidate);
  await assert.rejects(preparationHandoff(officialProduct(candidate),'/spec',[candidate],{
    ...redelivery,authority:{...authority,requirementsAuthority:'sha256:other'},
  }),{code:'NATIVE_EVIDENCE_UNPROVEN'});
  await assert.rejects(preparationHandoff(officialProduct(candidate),'/spec',[candidate],{
    ...redelivery,candidateExecutionRoot:'/owned/other-operation-candidate',
  }),{code:'NATIVE_EVIDENCE_UNPROVEN'});
});

test('AWAITING_REVIEW text without a complete official candidate is not evidence',async()=>{
  const candidate=request({authority:{requirementsAuthority:'sha256:wrong'}});
  await assert.rejects(preparationHandoff(officialProduct(request()),'/spec',[candidate]),
    {code:'NATIVE_EVIDENCE_UNPROVEN'});
  await assert.rejects(preparationHandoff(officialProduct(),'/spec',[{status:'AWAITING_REVIEW'}]),
    {code:'NATIVE_EVIDENCE_UNPROVEN'});
});

test('public ownership proof must bind the candidate root even when the return is duplicated',async()=>{
  const candidate=request();
  await assert.rejects(preparationHandoff(officialProduct(candidate,'/owned/foreign-owner'),'/spec',
    [candidate,structuredClone(candidate)]),{code:'NATIVE_EVIDENCE_UNPROVEN'});
});
