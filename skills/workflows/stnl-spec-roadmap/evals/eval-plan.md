# File Purpose Header

```yaml
purpose: Define executable and model-eval expectations for Sentinel SPEC roadmap initialization and reconciliation.
status: not_applicable
read_when: Changing roadmap model, projection, rendering, security, publication, launcher, or UX contracts.
do_not_read_when: Using stable contracts to inspect an existing roadmap.
contains: Eval catalog coverage, executable runner, visual checks, and mandatory negative cases.
owner: stnl-spec-roadmap
update_policy: Keep synchronized with cases.json, runtime fixtures, tests, launchers, and distribution validation.
```

# SPEC Roadmap Eval Cases

`cases.json` is the machine-checked catalog. Run `node --test skills/workflows/stnl-spec-roadmap/runtime/test/*.test.mjs` from the repository root. The suite covers both operations, default/custom paths, strict schema and complete coverage, graph safety, lifecycle/execution projection, stable reconciliation, collision-safe recoverable publication, security, deterministic rendering, offline UX contracts, and representative generation.

Manual real-browser visual evaluation opens the actual generated page at desktop and mobile widths, exercises search/filter/focus/local progress/export/import/reset and keyboard navigation, records zero remote requests, and prints the full page to PDF. The two catalog entries marked `automated: false` require this evaluation. These checks validate presentation only; they never become Sentinel execution or acceptance evidence.

These are static/runtime evals, not a claim that a model executed each prompt. A real-model eval is reportable only with platform, model, raw request, observed reads/writes, and actual result.
