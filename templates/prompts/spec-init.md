Use `stnl-spec-lifecycle-manager`.
MODE=INIT
SPEC_PATH={{SPEC_PATH}}
REQUIREMENTS_SOURCE={{REQUIREMENTS_SOURCE}}

Depois de concluir o candidate INIT isolado e antes de qualquer validação ou publicação, execute exatamente uma vez `node "<SKILL_ROOT>/runtime/prepare-init-candidate.mjs" <SPEC_PATH> <CANDIDATE>` substituindo os argumentos pelos paths reais. A ferramenta serializa somente o `owner` fixo do File Purpose Header; não a execute depois de uma rejeição. Em seguida, mantenha a validação oficial estrita e publique somente pelo publisher oficial.

Contexto adicional (opcional):
