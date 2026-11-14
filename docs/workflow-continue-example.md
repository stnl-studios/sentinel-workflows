# Exemplo de pedido de continuidade

Este é um pedido ao agente principal para coordenar operações existentes, não um launcher ou uma operação nova do runtime.

Continue a execução já aprovada deste trabalho.
SPEC_PATH={{SPEC_PATH}}

Leia Plan/Tasks aprovados e inspecione o estado atual. Recupere qualquer operação pendente pelo handle existente antes de seguir o handoff. Mantenha validação independente e os limites de correção. Inclua runbook/QA quando estiverem no escopo aprovado e solicite julgamento terminal explícito no momento admitido. Pare antes do CLOSE e em decisões materiais, permissões ou bloqueios reais. Não execute RECONCILE, merge ou mudanças de escopo por inferência.

## Distinção de RESUME

MODE=RESUME altera o contexto documental e exige NEW_INFORMATION. Para apenas retomar execução aprovada após interrupção, use o pedido acima e o handoff atual, sem inventar NEW_INFORMATION nem executar CLOSE.
