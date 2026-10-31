# File Purpose Header

```yaml
purpose: Define the normative verification recipe and its producer-owned observation.
status: not_applicable
read_when: Prepare, review, execute or validate a delivery using its explicit verification recipe.
do_not_read_when: No preparation or verification contract is being interpreted.
contains: Typed inputs, dependency review, native observations, provenance and durable allocation.
owner: stnl-slice-executor
update_policy: Preserve equivalent recipe semantics across distributed consumers.
```

# Reviewed verification recipe

Each detailed Plan and Task must contain the same `## Verification Recipe` between Expected Tests and the next section. Its single carrier is `- Recipe: <JSON object>`. This carrier is normative: review, projection, snapshot and activation bind it. Expected Tests and obligation proof prose describe intent; filenames, quotes, basenames and filesystem homonyms in prose never select mechanical inputs.

```json
{"format":"stnl-verification-recipe-v1","base":"workspace","cwd":".","checks":[{"id":"verification-01","executable":{"literal":"node"},"args":[{"literal":"--test"},{"file":{"kind":"input","path":"../../external.test.mjs"}}],"inputs":[]}],"dependencyReview":"The test imports src/implementation.mjs inside the approved product area; configuration and other indirect inputs have been reviewed and declared."}
```

The object has exactly format, base, cwd, checks and dependencyReview. Base is the physically resolved trusted command workspace. Cwd is a normalized relative directory inside that base (`.` is allowed). Checks are a nonempty bounded ordered list (at most 32), with distinct `verification-NN` IDs and exactly id, executable, args and inputs. Executable and each argument are either `{literal: string}` or `{file: {kind: product|input, path: string}}`. Each additional dependency in inputs is a typed `{kind, path}` reference. No independent free argv or optional duplicate input catalogue exists.

Canonical reference paths use the logical Plan/Task artifact-relative basis. The existing path serializer validates/projects the authored claims without rewriting files. Author canonical artifact-relative paths before review; it also accepts repository-relative target selections where the existing resolver admits them; for a leading dot, use the complete artifact-relative path (for example `../../.external.test.mjs`). A product reference must fall inside an Authorized Area. An input reference must match a regular, existing file in Existing Inputs, in both Plan and Task. Existing Inputs grants read/capture coverage and never write scope. Expected Files is a forecast and cannot authorize a product reference. The runtime constructs actual file arguments relative to the selected cwd, preserving an unformatted basename such as `external.test.mjs`.

Authors and reviewers must explicitly account for imports, scripts, configuration and indirect dependencies in the approved areas/Existing Inputs and dependencyReview. The runtime verifies declared references; it does not discover every read of an arbitrary program, infer file types from literals, parse shell prose, or certify dependencies deliberately mislabeled as literal arguments. Interpreter code and dependency expansion require explicit semantic review. The serializer parses and resolves the Plan and Task recipes independently. Equivalent typed target spellings can converge, but command, base, input or dependency-review differences and malformed/unknown Task fields block preparation before snapshot; never overwrite a discrepant Task recipe with the Plan. Missing recipes, unequal Plan/Task recipes, invalid references, control overlap and unlinked inputs block preparation.

The current native controller executes the reviewed executable/args directly without a shell. reserve-dispatch returns the exact verificationHelper and origin; the bound independent runner calls that helper with verify-native --origin-file ORIGIN_FILE once. Capture consumes the saved observation without replay and requires the same commands/exits. Discovery does not count as verification. Additional coverage requires an independently reviewed recipe revision; managed execution is unsupported and cannot supply current proof.

The operation-local `*.verification.json` records the recipe digest, resolved requests, numeric exits, bounded stdout/stderr and hashes. The receipt binds this exact producer observation. The producer compares the passive product/input image before and after execution, and rejects changes during the check. A completed observation is reused only for its exact recipe and unchanged work image; started/uncertain observations are retained and never replayed. The Tested state source is the official Task from the independently resolved workspace bound to its owned copy, in both standalone and lifecycle layouts. A missing copy marker or wrong owner cannot fall back to the candidate Task as source. Existing owner, freshness, response, Tested state, publication and CAS guards still apply. A nonzero observed recipe command cannot grant PASS/TESTS_PASS.

No old receipt is backfilled. A preparation without this carrier is incompatible as current/fresh authority. Strict retained-history readers can read its original reviewed contract explicitly in historical mode; a missing or changed recipe cannot be equivalent to the current proof or confer current PASS. Changing a recipe requires normal preparation review, and input drift requires revalidation while preserving the historical PASS and delivery identity.

# Durable preparation allocation

The official preparation producer creates its own destination under the common execution initialization lock and registers its creation before returning it. The per-execution `.stnl-execution-<execution key>.preparations.json` lives in the stable lock ancestor, outside candidate editing. Its path is derived from the independently resolved official execution, never from a marker's chosen registry path. The closed record contains format, executionRoot and allocations; each immutable association binds allocationId, executionRoot, specPath, candidate, dev/ino identity, operation, initial source/CAS and preparationRevision.

Guard and resolver share that association check, safe regular/single-link reads, physical identity and rechecks. Source/CAS determines freshness separately. Genuine stale candidates remain operational allocations and cannot become official SPECs, including candidates created before the first PLAN. Missing/corrupt/unsafe registry blocks candidate use; unproven neighboring hints cannot exclude a legitimate SPEC. Copied markers with updated physical witnesses still lack the trusted creation association. Creation/registration failures retain their bytes and return no usable candidate. Cleanup does not erase the association.

This is a local cooperative producer boundary. It protects marker fabrication/copying without tampering with the trusted registry. It does not defend against a host process rewriting both the registry and all associated filesystem state. There is no global registry, activation before review, event log, adoption API or scanner.
