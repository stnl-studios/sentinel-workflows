Use `stnl-execution-closer`.
OPERATION=CLOSE
SPEC_PATH={{SPEC_PATH}}
Execute primeiro o preflight determinístico read-only empacotado pela skill. Retorne somente `EXECUTION_APPROVED` ou `EXECUTION_BLOCKED`. Para drift imutável, gap de integração ou autoridade stale, forneça `REPLAN_REASON` e roteie para `REPLAN`; nunca prescreva `VALIDATE_SLICE` de slice concluída. Bloqueie somente path de execução não canônico ou entrada SPEC reservada insegura; preserve siblings user-owned. Não apague resíduos nem produza artefatos.

Contexto adicional (opcional):
