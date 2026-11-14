# File Purpose Header

```yaml
purpose: Prevent accidental cross-slice proof overlap before Plan approval.
status: not_applicable
read_when: Authoring or reviewing shared output areas and verification dependencies.
do_not_read_when: No planning scope or proof boundary is being decided.
contains: Exact output guidance, conservative dependency limits and terminal planning.
owner: stnl-execution-planner
update_policy: Preserve current observation and approval contracts without inferring dependency completeness.
```

# Compact proof scope before approval

Plan a compact serial sequence of observable results, not a new slice for each file or verification command. Before capture, review which later edits would intersect an earlier proof. Prefer exact `file:` Authorized Areas for known outputs in an existing shared directory when concrete inspection supports that boundary. Do not authorize the whole `verificacao/` directory merely because every slice adds its own verifier there. Existing Inputs captures shared read-only helpers/configuration; Expected Files is not an alternative permission or an exclusion from observation.

The current reader observes the union of Authorized Areas, Existing Inputs, Expected Files and typed recipe references (plus retained in-domain evidence). A `directory:` claim observes recursive membership, so adding an unrelated sibling invalidates earlier proof in that area. A `file:` claim avoids that particular overlap; it is not proof that the program reads only that file. Inspect the actual verifier, imports, scripts, project files and build configuration before narrowing. Record the concrete grounds and remaining uncertainty in Risks and Strategy and dependencyReview, not just “dependencies reviewed.” Never narrow an already approved contract silently or edit retained snapshots to keep PASS.

Keep directory coverage when globs, directory enumeration or implicit project membership affect the result. For SQL projects inspect actual Build Includes, Pre/PostDeployment and imported build configuration; do not assume the SDK or rewrite the recipe/language. A shared helper, mutable database, external service, dynamic read or unknown dependency defeats a claim of independent reusable proof unless the existing verification contract actually controls/observes it. A script hash or dependency list cannot establish that. If completeness is unresolved, retain conservative coverage and report the limitation; if the existing contract cannot observe the required state, block the independence/acceptance claim rather than treating a directory hash as sufficient.

Plan an unambiguous final validation target and verification of the finished product from the outset using the existing terminal contract. State the target, complete requirements/variants, executable proof and explicit terminal dispatch in the Plan strategy and final Task checklist. The last slice may judge the whole combination without owning every requirement locally; a dedicated validation slice is optional. Require a concrete dependency, risk or independently meaningful result for every slice boundary. A boundary created only for a file, check or tool call is not enough. Local PASS and advancing a slice do not imply terminal acceptance. Do not add a cache, new dependency carrier, automatic independence rule or RECONCILE to solve scope overlap. See references/verification-recipe.md for the unchanged recipe boundary.

