Use `stnl-spec-execution-manager`.

Fonte de requisitos: `{{SPEC_PATH}}`; diretório de execução: `{{EXECUTION_ROOT}}`; fases: `{{PARALLEL_PHASES}}`.
Antes de paralelizar, verifique ausência de arquivos, migrações, esquemas, arquivos de bloqueio, contratos, fixtures globais, código gerado, estado persistente, dependência de ordem ou recursos externos compartilhados.
Cada agente de trabalho lê somente sua fase, atualiza somente seu artefato detalhado, implementa, delega testes mecânicos quando disponível e retorna resumo curto.
Agentes de trabalho não podem atualizar concorrentemente `plan.md` nem `tasks.md`.
A sessão coordenadora integra resultados, executa ou coordena validações e atualiza índices, sem criar commits automaticamente.
Pare a paralelização se houver sobreposição ou bloqueio.

Retorne somente: fases executadas; resultado por fase; testes; conflitos; bloqueios.
