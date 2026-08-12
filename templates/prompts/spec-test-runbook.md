Use `stnl-spec-test-runbook`.
OPERATION=GENERATE_RUNBOOK
SPEC_PATH={{SPEC_PATH}}
RUNBOOK_SCOPE={{RUNBOOK_SCOPE}}
RUNBOOK_SELECTION={{RUNBOOK_SELECTION}}
RUNBOOK_OPTIONS={{RUNBOOK_OPTIONS}}
Gere ou regenere somente após esta invocação explícita; nunca encadeie lifecycle, execução, validação ou fechamento.

Guia de preenchimento:

- `SPEC_PATH`: caminho existente para a pasta da SPEC, para seu `feature_spec.md` ou para um arquivo avulso de requisitos.
- `RUNBOOK_SCOPE`: `TASK` para uma task; `SLICE` para uma slice; `MULTI_SLICE` para duas ou mais slices; `EXECUTION` para toda a execução; `SPEC` para toda a SPEC; `CUSTOM` para fontes delimitadas manualmente.
- `RUNBOOK_SELECTION`: objeto JSON. Use `{"slice":"1","task":"1.1"}` em `TASK`, `{"slice":"1"}` em `SLICE`, `{"slices":["1","3"]}` em `MULTI_SLICE`, `{}` em `EXECUTION` ou `SPEC`, e `{"anchors":["AC-001"],"paths":["docs/flow.md"]}` em `CUSTOM`.
- `RUNBOOK_OPTIONS`: objeto JSON; use `{}` para os defaults. Chaves opcionais: `audience` (públicos), `test_types` (tipos de teste), `environment` (ambiente), `depth` (`concise`, `detailed` ou `guided`), `data_preparation` (preferências de dados), `evidence` (evidências esperadas), `presentation` (booleano) e `helpers` (booleano; apenas autoriza helpers quando forem realmente necessários).
- Defaults de `RUNBOOK_OPTIONS={}`: audiência mista, profundidade detalhada, tipos sustentados pelas evidências, ambiente não presumido, reutilização de dados existentes, apresentação habilitada e nenhum helper.
- JSON deve usar aspas duplas, sem comentários nem vírgula final. Não informe secrets, tokens, cookies, credenciais ou dados pessoais reais.

Exemplo: caminho `docs/SPEC/invitation-acceptance`, escopo `SLICE`, seleção `{"slice":"1"}` e opções `{"audience":["functional_qa","product_owner"],"test_types":["smoke","functional","acceptance"],"environment":"staging","depth":"guided","data_preparation":["fixture"],"evidence":["screenshot","request_response"],"presentation":true,"helpers":false}`.

Contexto adicional (opcional):
