Use `stnl-spec-lifecycle-manager`.
MODE=READINESS
SPEC_PATH={{SPEC_PATH}}
READINESS_SCOPE={{READINESS_SCOPE}}
READINESS_FOCUS={{READINESS_FOCUS}}
`READINESS_SCOPE` aceita somente `LOCAL` ou `GLOBAL`, com correspondência case-sensitive e sem aliases.
Com `LOCAL`, `READINESS_FOCUS` é obrigatório e delimitado, e o resultado nunca declara readiness global. `GLOBAL` avalia toda a autoridade material. Ambos os escopos são estritamente read-only.
Somente após verdict semântico `GLOBAL/READY`, gere a readiness attestation externa e efêmera com o comando determinístico canônico; nunca a escreva manualmente nem dentro do workspace.

Contexto adicional (opcional):
