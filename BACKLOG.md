# Sentinel — próximas melhorias

Este backlog resume acompanhamentos e direções futuras do produto. Cada item exige seleção explícita antes de iniciar trabalho.

## Acompanhamentos

- **Claude Code:** preservar paridade dos arquivos e contratos por verificações offline. O uso real no Claude corporativo é manual pelo usuário quando houver uma tarefa de trabalho; não iniciar piloto automático nem consumir tokens corporativos.
- **Bancada App Server:** implementação nova em branch de trabalho, com diagnóstico completo e gates de qualificação ainda explícitos. Resultados A/B/C anteriores foram preservados como legado, não como baseline da bancada nova. Consultar `benchmarks/sentinel/bench/READINESS.md` antes de alegações de custo, desempenho ou prontidão.
- **Revisão de utilidade da suíte:** avaliar redundância, custo e valor de detecção de regressões dos testes existentes antes de propor qualquer remoção ou ampliação.

Esses acompanhamentos não bloqueiam o uso nem a entrega atual do Sentinel. A medição incompleta não deve ser tratada como zero ou como resultado qualificado.

## Direções futuras

- Melhorar a apresentação do roadmap quando houver uma necessidade concreta.
- Ajudar a converter histórias de usuário em tarefas para ferramentas de gestão, mantendo-as distintas das Tasks operacionais do Sentinel.
- Evoluir o runbook de QA quando um processo de aceite exigir mudanças.
- Considerar uma orquestração mais ampla após validar a necessidade e os limites do produto.
- Planejar uma plataforma somente depois de definir os requisitos de operação e escala.

A reescrita da bancada App Server está em validação na branch de trabalho, sem integração em main. O histórico A/B/C anterior é legado; não representa medições oficiais da bancada nova. Consulte `benchmarks/sentinel/bench/READINESS.md` para os gates ainda pendentes.
