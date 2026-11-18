import test from 'node:test';
import assert from 'node:assert/strict';
import {stagePrompt} from '../workflow.mjs';
const manifest={workspace:'/isolated/workspace',codexHome:'/isolated/home/.codex',profile:{roles:Object.fromEntries(['execute_check','formal_validate','plan_review'].map(r=>[r,{model:'gpt-test',effort:'high'}]))},runnerContract:{path:'/isolated/source/runner.toml',sha256:'a'.repeat(64)}};
const authority={specPath:'/isolated/workspace/specs/import'};
test('reading guard preserves state-sensitive rereads and independent child fidelity',()=>{
 for(const operation of ['INIT','READINESS','PLAN','REVIEW_PLAN']){
  const p=stagePrompt({manifest,operation,authority,plan:{candidateExecutionRoot:'/isolated/draft',captureSha256:'sha256:'+'b'.repeat(64)}});
  for(const text of ['mesmo contexto','mesmo estado confirmado','saída integral já persistida','mudança, truncamento, dúvida de identidade ou contexto novo','selecione campos necessários','leitura integral exigida pelo contrato','mensagem de cada filho delegado','leitura do coordenador não conta como leitura do filho'])assert(p.includes(text),operation+': '+text);
 }
});
test('PLAN preserves official structure and explicit canonical YAML spacing without approval',()=>{
 const p=stagePrompt({manifest,operation:'PLAN',authority,plan:{candidateExecutionRoot:'/isolated/draft'}});
 assert(p.includes('exatamente uma linha em branco'));assert(p.includes('Não aloque outro candidato'));assert(p.includes('NÃO aprove, revise, ative ou execute'));assert(p.includes('preencha o conteúdo sem renomear sua estrutura'));
});
test('delegated validation retains complete candidate runner contract and stopping boundary',()=>{
 const a={...authority,lifecycle:{exitCode:0,output:{lifecycle_status:'ready'}},current:{exitCode:0,output:{state:'ACTIVE',normalHandoff:{operation:'VALIDATE_SLICE',slice:'slice-01'}}}};
 const p=stagePrompt({manifest,operation:'VALIDATE_SLICE',authority:a});
 assert(p.includes('arquivo COMPLETO por cat direto'));assert(p.includes('max_output_tokens 20000'));assert(p.includes(manifest.runnerContract.sha256));assert(p.includes('leitura do coordenador não conta como leitura do filho'));assert(p.includes('Não altere implementação. Pare antes CLOSE'));
});
test('native identity operations preserve transport stdout and forbid evidentiary replay',()=>{
 const p=stagePrompt({manifest,operation:'INIT',authority});
 for(const text of ['Para reserve-dispatch e bind-native','chamada canônica direta de Node','argumentos literais e stdout disponível no transporte','sem redirecionamento, encadeamento ou composição','não dispensa quoting seguro quando necessário','Não repita operações já concluídas só para coletar logs','se a saída oficial faltar, preserve o estado e pare bloqueado'])assert(p.includes(text),text);
});

test('begin retains original receipt and handle without replay or renewed budget',()=>{
 const p=stagePrompt({manifest,operation:'INIT',authority});
 for(const text of ['arquivo privado novo e exclusivo sob o TMPDIR autorizado','stdout original integral','sem sobrescrever outro recibo','readback/parse JSON','antes de qualquer próxima operação Sentinel','recibo original integral foi observado mas ainda não salvo','use somente o handle real com resume oficial','Nunca repita begin para recuperar handle','nem reconstrua recibo por inferência','Saída ausente, truncada, conflitante','não renovam prazo, orçamento ou tentativa','envelope {handle,...}','preserve esse stdout bruto integral','exatamente o campo handle extraído por parse','outro arquivo privado novo e exclusivo para --handle, não o envelope inteiro','sem inferir, acrescentar ou alterar campos','não autoriza redirecionar reserve-dispatch/bind-native','sem redirecionamento, encadeamento ou composição','Node como último comando da shell'])assert(p.includes(text),text);
});

test('execution and close route to exact already-installed skill entrypoints',()=>{
 for(const [operation,skill,entry]of [['EXECUTE_SLICE','stnl-slice-executor','execution-current-operation.mjs'],['APPLY_FINDINGS','stnl-slice-executor','execution-current-operation.mjs'],['VALIDATE_SLICE','stnl-slice-quality-manager','execution-current-operation.mjs'],['CLOSE','stnl-spec-lifecycle-manager','publish-spec-lifecycle.mjs']]){
  const a={...authority,lifecycle:{exitCode:0,output:{lifecycle_status:'ready'}},current:{exitCode:0,output:{state:operation==='CLOSE'?'COMPLETE':'ACTIVE',normalHandoff:operation==='CLOSE'?null:{operation,slice:'slice-01'}}}};
  const p=stagePrompt({manifest,operation,authority:a});
  assert(p.includes(`${manifest.codexHome}/skills/${skill}/SKILL.md`));assert(p.includes(`${manifest.codexHome}/skills/${skill}/runtime/${entry}`));
  assert(p.includes('nem exija Sentinel ou SDK no package.json do produto'));assert(p.includes('Não instale dependências para descobrir o controlador'));assert(p.includes('realmente ausente ou ilegível'));assert(p.includes('Nunca repita begin para recuperar handle'));assert(p.includes('sem redirecionamento, encadeamento ou composição'));
 }
});
