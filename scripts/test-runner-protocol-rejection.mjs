import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {projectNativeJudgment,NATIVE_JUDGMENT_VARIANT} from '../skills/workflows/stnl-slice-executor/runtime/execution-evidence-proof.mjs';
import {RunnerSemanticResultError,hasTemplatePlaceholder,parseSemanticExecutionPayload,parseSemanticValidationPayload} from '../skills/workflows/stnl-slice-executor/runtime/runner-result-contract.mjs';
import {payload,OWNER} from './fixtures/current-initial-evidence.mjs';
const hash=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
function fixture(operation) {
  const requestBytes=Buffer.from('{"approved":"exact bytes"}\n');
  const owner={...OWNER,operation};
  const origin={responseVariant:NATIVE_JUDGMENT_VARIANT,owner,attempt:1,dispatchId:'dispatch',requestSha256:hash(requestBytes)};
  const observation={format:'stnl-runner-verification-v3',owner,round:1,binding:{dispatchId:'dispatch',agentId:'agent',requestSha256:hash(requestBytes),head:'a'.repeat(40)}};
  const result=operation==='VALIDATE_SLICE'?{status:'PASS',commands:[{command:'node test.mjs',exit:0}],evidence:'Observed required behavior.',findingReferences:'none',findingDispositions:'none',blockers:'none',unexpectedWorkspaceEffects:'none',persistenceSummary:'Runner remains read-only.'}:(({head,...rest})=>rest)(payload(1));
  const response={format:NATIVE_JUDGMENT_VARIANT,result,...(operation==='VALIDATE_SLICE'?{newFindings:[]}:{})};
  return {origin,observation,requestBytes,agentId:'agent',operation,rawText:JSON.stringify(response)};
}
for(const operation of ['EXECUTE_SLICE','APPLY_FINDINGS','VALIDATE_SLICE']) {
  for(const mutation of ['root-head','root-request','result-head','result-request','wrong-format','unknown-root','invalid-json']) test(`${operation}: authenticated ${mutation} settles as semantic rejection`,()=>{
    const input=fixture(operation),response=JSON.parse(input.rawText);
    if(mutation==='root-head')response.head='b'.repeat(40);
    if(mutation==='root-request')response.requestSha256='sha256:'+'b'.repeat(64);
    if(mutation==='result-head')response.result.head='b'.repeat(40);
    if(mutation==='result-request')response.result.requestSha256='sha256:'+'b'.repeat(64);
    if(mutation==='wrong-format')response.format='foreign-v99';
    if(mutation==='unknown-root')response.extra=true;
    input.rawText=mutation==='invalid-json'?'{':JSON.stringify(response);
    assert.throws(()=>projectNativeJudgment(input),error=>error instanceof RunnerSemanticResultError&&error.code==='RUNNER_SEMANTIC_RESULT_INVALID');
  });
  for(const mutation of ['request-bytes','agent','round','owner','dispatch','variant']) test(`${operation}: stale ${mutation} never becomes a recoverable semantic refusal`,()=>{
    const input=fixture(operation);
    if(mutation==='request-bytes')input.requestBytes=Buffer.concat([input.requestBytes,Buffer.from(' ')]);
    if(mutation==='agent')input.agentId='foreign';
    if(mutation==='round')input.observation.round=2;
    if(mutation==='owner')input.observation.owner={...input.observation.owner,deliveryId:'foreign'};
    if(mutation==='dispatch')input.observation.binding.dispatchId='foreign';
    if(mutation==='variant')input.origin.responseVariant='foreign-v99';
    assert.throws(()=>projectNativeJudgment(input),error=>!(error instanceof RunnerSemanticResultError)&&['EVIDENCE_STALE','UNSUPPORTED_FORMAT'].includes(error.code));
  });
}
test('selected native protocol projects measured HEAD and preserves literal result bytes',()=>{
  for(const operation of ['EXECUTE_SLICE','VALIDATE_SLICE']) {
    const input=fixture(operation),original=input.rawText;
    const projected=JSON.parse(projectNativeJudgment(input));
    const result=operation==='EXECUTE_SLICE'?projected:projected.result;
    assert.equal(result.head,input.observation.binding.head);
    assert.equal(input.rawText,original);
    assert.equal(Object.hasOwn(JSON.parse(original).result,'head'),false);
    if(operation==='EXECUTE_SLICE')parseSemanticExecutionPayload(JSON.stringify(result),operation);
    else parseSemanticValidationPayload(JSON.stringify(result));
  }
});
test('template matcher rejects named markers while allowing literal emoticons and comparisons',()=>{
  for(const value of ['<semantic value>','<pending>','< pending >','<descrição>','prefix <required_value> suffix'])assert.equal(hasTemplatePlaceholder(value),true,value);
  for(const value of ['<3 ->','x < 3 -> y','3 < 4 > 2','plain evidence'])assert.equal(hasTemplatePlaceholder(value),false,value);
});
test('selected native contract explicitly overrides legacy head-bearing examples',async()=>{
  const contract=await fs.readFile(new URL('../agents/codex/.codex/agents/stnl_validation_runner.toml',import.meta.url),'utf8');
  assert.match(contract,/The selected responseVariant branch takes precedence over the legacy examples/u);
  assert.match(contract,/omita.*`head` e `requestSha256`/u);
  assert.match(contract,/Somente se `origin.responseVariant` estiver ausente:[^\n]*capture o `HEAD`/u);
});
