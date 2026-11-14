# QA da correção do runbook, 2026-11-13

Complementa 08-browser-qa.md, que permanece imutável e descreve a versão anterior. Após terminal BLOCKED publicado e owner liberado, gerador oficial produziu o runbook c5d09263d7b805ea12a2d4c0a892510693b13fef0bead633f410a5bc854f450f (11-runbook-generation.json). Código do produto, requisitos, Plan/Tasks e HEAD do piloto não foram alterados.

Na janela Chrome Juninho indicada por Aj, por controle nativo CUA autorizado, reload exibiu o fingerprint novo. Apresentação passou a exibir índice 1/10 com TR-010 e foco no mesmo TR-010, corrigindo o cenário excluído que permanecia em foco. Retorno a Operacional funcionou. Após busca completed e Apresentação, a navegação continuou funcional.

Print/Save as PDF real gerou 13 páginas em qa-runbook-print-fixed-20261113.pdf (SHA256 a067a68ac607e8a0017e70e3f71db9cdecaa50e976a77ce80eea3156617cfadf). Prévia primeira página mostrou STATUS GERAL LOCAL, Bloqueado e barra/0 de 10 separados, sem sobreposição. Extração textual confirma dez cenários. Revisão de todas as páginas será registrada separadamente, sem inferir inspeção de pixels a partir de texto.

DevTools Network, filtro All, captura de reload e interações: exatamente uma requisição ao documento http://127.0.0.1:8765/, status304. Nenhuma requisição remota. HAR sanitizado preservado em qa-runbook-network-fixed.har (SHA256 e993065ffb78606ddaf2eadd96a9755afe2a402de50f8c454d81ab4304c7deaf). HAR original também preservado; não é evidência de provider simulado.

Após QA: DevTools fechado, viewport normal, JavaScript ativo, modo Operacional, busca vazia, persistência off e notas vazias após reload. Reset/persistência, teclado, viewport375 e sem JavaScript já observados na versão anterior; mudanças posteriores limitadas ao layout de impressão e seleção do foco. Não reexecutados integralmente após regeneração; regressão focada cobre os pontos alterados.

Texto de bloqueio de autorização e status locais são snapshot do momento da geração inicial, não afirmação sobre permissão atual nem veredito formal. A permissão foi concedida depois. Não foi forjado PASS no browser. O julgamento independente deve avaliar provas CLI e esta QA em nova tentativa admitida, preservando BLOCKED histórico.
