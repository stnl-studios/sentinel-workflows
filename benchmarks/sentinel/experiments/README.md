# Experimentos de perfis do Sentinel

Estes resultados são diagnósticos. O histórico oficial em `../history/` não muda.

## Comparação de seis perfis (2026-11-22)

Uma campanha por perfil, três cenários independentes × duas repetições, até três células em paralelo. As 36 execuções usaram a mesma revisão do Sentinel, fixture, motor, CLI Codex 0.171.0 e limites; variaram os modelos e esforços configurados no JSON. A contagem por perfil usa todas as seis execuções, inclusive as bloqueadas.

| Perfil | PASS funcional | PASS com prova nativa | PASS com prova após rechecagem | Tempo da campanha | Tokens observados |
| --- | ---: | ---: | ---: | ---: | ---: |
| Básico | 3/6 | 3/6 | 3/6 | 58m25s | 38.510.338 |
| Balanceado | 2/6 | 2/6 | 2/6 | 47m58s | 32.947.473 |
| Balanceado Sol 6.2 | 1/6 | 1/6 | 1/6 | 32m18s | 23.188.521 |
| Astra Médio | 4/6 | 2/6 | 2/6 | 55m00s | 42.173.860 |
| Astra 6.2 Médio | 3/6 | 0/6 | 2/6 | 40m29s | 28.726.596 |
| Forte | 4/6 | 3/6 | 4/6 | 1h29m22s | 58.568.511 |

O PASS funcional exige CLOSE e teste de aceitação independente positivos. O PASS com prova exige também que a bancada consiga verificar a leitura do contrato pelos filhos responsáveis, além das demais checagens nativas. A rechecagem offline aplicou o mesmo verificador às 36 execuções, sem novos turnos nem alteração dos resultados nativos. Ela reconhece somente formas literais adicionais de leitura completa e SHA-256 do mesmo arquivo canônico, em comando concluído com código zero e atribuído ao filho certo. Outros formatos e evidências faltantes não viram PASS.

Astra 6.2: a correção reconheceu o contrato de query-1 (continua BLOCKED), query-2 e import-1. Em import-2, corrigiu a prova de um filho, mas outro não apresentou leitura completa comprovável; segue sem PASS com prova. Os dois imports de Astra Médio também seguiram sem PASS com prova. No Forte, a única execução funcionalmente aprovada de rename, repetição 2, passou a ter prova reconhecida. Dos outros 11 renames, 10 foram bloqueados pela autoridade e um pelo prazo do turno. O código de autoridade não resolve sozinho se a causa foi a passagem de contexto para o filho ou um problema do produto.

O JSON preserva por célula o resultado funcional, a prova nativa, a rechecagem, o tempo e a cobertura de consumo. `total = input + output`, `fresh = input - cache`; cache faz parte do input e reasoning faz parte do output. São tokens observados, não uma medição de faturamento; pode existir consumo não reportado. Tempo da campanha inclui falhas, esperas e sobreposição, não mede velocidade em casos equivalentes. A comparação tem duas repetições por cenário: é descritiva e não isola causalidade nem comprova superioridade geral. O benchmark oficial anterior usa outra versão de CLI e é apenas referência histórica.
