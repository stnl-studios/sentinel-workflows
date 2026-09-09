# File Purpose Header

```yaml
purpose: Define runtime, scenario, adversarial, and visual evaluation for requirements refinement.
status: not_applicable
read_when: Changing refinement schema, reconciliation, publication, rendering, launchers, or workflow boundaries.
do_not_read_when: Using stable contracts to inspect an existing refinement.
contains: Automated suites, representative cases, browser matrix, print checks, and reporting boundaries.
owner: stnl-requirements-refiner
update_policy: Keep synchronized with cases.json, runtime fixtures, tests, launchers, and distribution validation.
```

# Requirements Refiner Eval Plan

`cases.json` is the machine-checked catalog. Run:

```sh
node --test skills/workflows/stnl-requirements-refiner/runtime/test/*.test.mjs
```

The runtime suite covers structured/unstructured and ID-less input, all finding types and severities, reference integrity, epistemic separation, bounded evidence, accepted/rejected/inconclusive resolutions, bypass, stable identity, source change, new evidence, reopen, all handoffs, strict JSON/UTF-8, paths, symlinks, hard links, secrets/PII, injection, deterministic HTML, stale writes, collisions, and prior-pair preservation.

Representative scenario expectations are:

- A — direct SPEC: one entity-alias capability and evident repository boundary → `READY_FOR_SPEC`.
- B — sprint multi-domain: Cart persistence, Coupon, Checkout, and Password Recovery; Cart→Checkout dependency, shared Pricing, independent recovery → `READY_FOR_ROADMAP` with relationships.
- C — cancellation race: `PAID → PACKING → SHIPPED` plus asynchronous worker → blocking eligibility/concurrency finding; compare-and-set with SHIPPED precedence → accepted and resolved.
- D — inadequate resolution: read status before cancellation → rejected because atomicity is absent.
- E — bypass: explicit retry-policy deferral → `bypassed`, known risk visible, no longer blocking.

Manual visual evaluation opens generated real pages for `BLOCKED`, `READY_FOR_SPEC`, and `READY_FOR_ROADMAP`; covers open, resolved, rejected, inconclusive, and bypassed cards; 20+ findings; long text; multi-source requirements; relationships; and technical surfaces. Confirm that `open + BLOCKING` remains critical, while `resolved + BLOCKING` and `bypassed + BLOCKING` preserve the original severity only as neutral historical context. An accepted resolution must render `Nenhum novo gap introduzido` as `PASS` with no contradictory `FAIL`. Inspect at desktop and narrow/mobile width, traverse by keyboard, exercise every filter/search, confirm zero network resources, and print/save to PDF. The central question is whether gap, proposal/resolution, validation, remaining risk, blockers, and next step are understandable without reading a prose wall.

Static/runtime evals do not claim that a model executed each prompt. Report a real-model eval only with platform, model, raw request, observed reads/writes, and actual result.
