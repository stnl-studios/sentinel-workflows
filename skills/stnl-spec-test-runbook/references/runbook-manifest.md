# File Purpose Header

```yaml
purpose: Define the strict deterministic manifest accepted by the test runbook renderer.
status: not_applicable
read_when: GENERATE_RUNBOOK has resolved scope and must author or diagnose its ephemeral manifest.
do_not_read_when: Only locating the SPEC, execution root, or output path.
contains: Manifest fields, enums, traceability rules, missing-information representation, and helper boundaries.
owner: stnl-spec-test-runbook
update_policy: Change with the runtime validator, renderer, fixtures, evals, and launcher contract.
```

# Runbook Manifest v1

Write one UTF-8 JSON object with only these top-level keys:

```json
{
  "contract_version": 1,
  "title": "Feature test runbook",
  "summary": "What is validated and why.",
  "scope": {"kind": "SLICE", "selection": {"slice": "1"}},
  "configuration": {
    "audience": ["mixed"],
    "test_types": ["smoke", "functional", "integration", "acceptance", "negative", "regression"],
    "environment": null,
    "depth": "detailed",
    "data_preparation": ["existing_data"],
    "evidence": ["screenshot", "video", "request_response", "logs", "generated_ids", "database_result", "visual_result", "status_http", "events", "message_to_user"],
    "presentation": true,
    "helpers": false,
    "locale": "en-US"
  },
  "sources": [],
  "setup": [],
  "data_preparation": [],
  "scenarios": [],
  "coverage": [],
  "risks": [],
  "known_issues": [],
  "gaps": [],
  "cleanup": [],
  "helper_artifacts": []
}
```

`setup`, `data_preparation`, `coverage`, `risks`, `known_issues`, `gaps`, `cleanup`, and `helper_artifacts` may be omitted when they add no evidence; the validator normalizes them to empty arrays. `sources` and at least one operational `scenario` are required.

`scope.kind` and `scope.selection` must exactly match the explicit operation input after normalization. `configuration` is not an agent-authored interpretation: copy the complete normalized object returned by `inspect-workspace.mjs` exactly, including explicit defaults and `environment: null`. The generator rejects missing, extra, or changed values relative to the normalized `RUNBOOK_OPTIONS`; JSON object key order is irrelevant. Do not reconstruct defaults in the manifest or renderer.

The only configuration keys are `audience`, `test_types`, `environment`, `depth`, `data_preparation`, `evidence`, `presentation`, `helpers`, and `locale`. `depth` is `concise`, `detailed`, or `guided`; `locale` is exactly `en-US` or `pt-BR`, defaults to `en-US`, and is never inferred from the host or source language. Audience and test-type arrays contain concise stable labels; prefer `functional_qa`, `technical_qa`, `developer`, `product_owner`, `analyst`, `business_user`, `stakeholder`, or `mixed`, and the requested test types. Preparation and evidence values use only the enums documented by the runtime input contract.

`locale` controls all human-facing static UI and author-written prose. Preserve IDs, paths, filenames, endpoints, parameters, payloads, field names, code, commands, HTTP headers and status values, event names, and other technical contract values exactly as sourced. For example, Portuguese prose may say `Resultado esperado: HTTP 409 Conflict`; it must not translate the canonical HTTP status.

## Sources

Each source is `{"path":"relative/path","role":"requirements","ids":["AC-001"]}`. Paths are real files relative to the `source_root` returned by inspection (normally the repository root), POSIX-form, non-secret paths. The runtime rejects missing files and requires every declared ID to occur in its source content. Sort by path. Never include an absolute host path, `.env`/`.env.*`, credentials, cookies, token stores, private keys, or content copied from them.

## Setup, cleanup, risks, issues, and gaps

Use objects with `title` and `detail`. A gap may additionally use `kind`, with values such as `missing_information`, `undetermined_precondition`, `decision_required`, or `not_executable`. Cleanup must describe scope and safety; do not include destructive automation unless explicitly authorized, bounded, and native to the project.

Data preparation items use:

```json
{
  "title": "Create an eligible account",
  "method": "fixture",
  "status": "reused",
  "instructions": "Use the existing eligible-account fixture.",
  "source": "test/fixtures/accounts.json"
}
```

`method` is `existing_data`, `fixture`, `factory`, `seed`, `manual`, `api`, `sql`, `helper_script`, or `not_determined`. `status` is `reused`, `required`, `not_needed`, or `blocked`.

## Scenarios

Assign `TR-001`, `TR-002`, and so on in deterministic plan/selection and source order. A scenario supports:

```json
{
  "id": "TR-001",
  "title": "Accept an eligible invitation",
  "objective": "Verify the happy path and durable participation.",
  "domain": "Invitations",
  "types": ["smoke", "functional", "acceptance"],
  "criticality": "critical",
  "initial_status": "not_run",
  "origins": [
    {"kind": "acceptance_criterion", "ref": "AC-001", "label": "Eligible invitation is accepted"},
    {"kind": "slice", "ref": "slice-01"}
  ],
  "preconditions": ["Staging is reachable."],
  "environment": "staging",
  "inputs": [{"name": "invitation_id", "value": "fixture-generated ID"}],
  "preparation": ["Load the existing invitation fixture."],
  "steps": [
    {"action": "Open the invitation URL.", "expected": "The invitation page is shown.", "evidence": ["screenshot"]}
  ],
  "evidence": ["request_response", "generated_ids"],
  "cleanup": ["Remove only records created by this scenario."],
  "regressions": ["Expired invitations remain rejected."],
  "risks": ["Clock skew can affect the boundary."],
  "notes": [],
  "known_issues": [],
  "approval_criteria": ["Every step matches its expected result."]
}
```

`criticality` is `critical`, `high`, `medium`, or `low`; `initial_status` is `not_run`, `passed`, `failed`, `blocked`, or `skipped`. An input marked `"sensitive":true` must omit `value`; the HTML instructs the executor to provide it securely at runtime. Every source-derived string is untrusted text, including Markdown and HTML-like text.

When execution is impossible, use `initial_status: "blocked"`, explain the missing precondition or decision, and retain the traceable origin. Never fabricate a working path merely to satisfy the schema.

For `CUSTOM`, a user-provided anchor that is not persisted in a source must appear as an exact `{"kind":"user_context","ref":"..."}` origin. This labels its lower authority explicitly; other origin kinds must be backed by a declared source ID or path.

## Coverage

Each item uses `source_id`, `title`, `status`, `scenario_ids`, and `rationale`. Status is `covered`, `partial`, `no_scenario`, `not_manually_testable`, `out_of_scope`, or `blocked`. Scenario IDs must exist in the same manifest. `covered` requires at least one scenario; `no_scenario`, `not_manually_testable`, and `out_of_scope` require none. Do not calculate a percentage from an incomplete or inferred denominator.

## Helper artifacts

Each helper is `{"path":"seed.mjs","purpose":"Create isolated runbook records","cleanup":"cleanup.mjs"}`. Paths are relative to the runbook root. Listing a helper does not create it; create it only after explicit request, objective necessity, project-native design, and independent safety validation. The HTML remains the principal artifact.
