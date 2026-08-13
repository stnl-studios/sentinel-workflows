# File Purpose Header

```yaml
purpose: Define executable and model-eval expectations for explicit Sentinel test runbook generation.
status: not_applicable
read_when: Changing runbook scope, discovery, manifest, rendering, security, publication, launcher, or UX contracts.
do_not_read_when: Generating an ordinary runbook under stable contracts.
contains: Eval catalog coverage, executable runner, model-eval boundary, and required negative cases.
owner: stnl-spec-test-runbook
update_policy: Keep synchronized with cases.json, runtime fixtures, automated tests, and launcher validation.
```

# Test Runbook Eval Cases

`cases.json` is the machine-checked catalog. Run `node --test skills/stnl-spec-test-runbook/runtime/test/*.test.mjs` from the repository root. The suite validates every catalog ID and exercises deterministic discovery, manifest validation, security, HTML behavior contracts, publication, and a real representative generation.

The catalog covers:

1. a complete ready SPEC;
2. one explicitly selected slice;
3. missing required selection;
4. requirements with traceable scenarios;
5. insufficient evidence represented as a gap;
6. reuse of an existing seed;
7. a requested but unnecessary seed;
8. secret exposure rejection;
9. XSS content escaping;
10. safe deterministic regeneration;
11. no automatic generation on execution or SPEC close;
12. a blocked scenario;
13. combined test types;
14. functional audience;
15. technical audience;
16. presentation mode;
17. print output;
18. absent or inconsistent authority, including invalid documentary status or an artifact index that disagrees with `shared/`;
19. deterministic runtime enforcement and normalization of every `RUNBOOK_OPTIONS` field;
20. omitted or explicit `en-US` localization without host-locale inference;
21. explicit `pt-BR` localization with UTF-8 accents and unchanged canonical technical identifiers.

These are static/runtime evals, not a claim that a model executed each prompt. A real-model eval is reportable only with platform, model, raw request, observed reads/writes, and actual result.
