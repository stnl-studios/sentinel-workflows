Use `stnl-spec-lifecycle-manager`.
MODE=RESUME
SPEC_PATH={{SPEC_PATH}}
NEW_INFORMATION={{NEW_INFORMATION}}

Para mudanças de conteúdo, no início e antes de ler ou editar a SPEC, gere o manifesto externo com `node "<SKILL_ROOT>/runtime/create-resume-manifest.mjs" <SPEC_PATH>`. Preencha somente as autorizações exatas para `NEW_INFORMATION` e use o caminho impresso no comando de publicação RESUME. Não calcule nem substitua `pre_state_sha256` manualmente.

Contexto adicional (opcional):
