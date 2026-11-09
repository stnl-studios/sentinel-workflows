# Experimental Python and SQL campaign evidence

## Status and boundaries

This is an isolated maintainer experiment, not an installed Sentinel capability.
It does **not** close cross-phase reuse for existing Python/SQL Server recipes.
The production native verification gate is unchanged. Arbitrary commands still
run normally. No source files, containers, credentials or databases from a work
project are used by this experiment.

The experiment executes real Python 3 stdlib programs against new SQLite memory
databases. The files in `scripts/fixtures/python-sql-campaign` were written for
this experiment. Their names and commands are not a reconstruction of any
historical user's invocation.

Run the complete focused experiment:

```sh
node scripts/test-python-sql-campaign.mjs
node scripts/test-python-sql-native-replay.mjs
```

Python 3.9 or newer with stdlib SQLite is required in addition to Node. No dependency or
global installation is performed. The test creates and removes only its own
synthetic temporary directories and memory databases.

## What physically executes

Three Python scripts check schema/pre-deployment/post-deployment, import with
history and a trigger-maintained summary, and rebuild behavior. The rebuild test
first inserts real SQL rows, refuses rebuilding nonempty data, and compares the
complete SQL dump before and after the refusal. A fresh empty database is then
rebuilt separately.

The helper follows explicit Build, PreDeploy and PostDeploy entries in a small
synthetic XML project. This is **not** an SSDT/MSBuild project evaluator. It does
not resolve MSBuild imports, conditions, variables or wildcards. SQLite SQL is
not a substitute for SQL Server T-SQL, stored procedures, `sp_getapplock`, user
permissions, SQL Server concurrency, performance, dacpac publishing or sqlcmd.

Every check starts a separate Python process. Every database connection is a new
`:memory:` database. Forward/reverse-order tests prove these synthetic checks do
not share data. Process counts come from the child's actual spawn event, not
from recipe text. Native recipe counters exclude Python lookup/preparation
processes and count only the three actual script commands. Database counts come from observed SQLite connection events.
There are zero SQL Server/dacpac publications in this experiment.

## Observation and historical presentation contract

`scripts/lib/python-sql-campaign.mjs` exposes:

- `runSyntheticCampaign`: freezes a synthetic source copy, executes selected
  scripts, captures stdout/stderr/exit and timing, and writes original evidence.
- `inspectHistoricalCampaign`: authenticates that original evidence and compares
  the current files, observed directory memberships and runtime fingerprints.
  It either recommends execution or prepares a source reference for review.
- `presentHistoricalCampaign`: writes a **new review-input document** with a new
  operation identity, reviewer identity and references to the original evidence.
  It never rewrites the original observations or starts another script process.

The original observations contain the exact script recipe, copied source
identity, script/helper/schema/seed reads, file modes, observed absent paths, directory scans, Python
binary and observed runtime-module fingerprints, process result and database
profile. The private campaign directory owns an HMAC key. Envelopes are bound to
the campaign ID and original physical directory. Tampering and transplanting the
campaign to another directory are rejected. This is producer-local integrity,
not protection against the owning OS account or a portable attestation service.
The HMAC key is not included in the review-input document.

A presentation always says:

- `automaticReuseAllowed: false`
- `formalAcceptance: false`
- `sqlServerCertified: false`
- `status: historical-evidence-awaiting-independent-review`

The same historical observation is being shown again. A presentation is **not**
a fresh execution receipt, a new current test PASS, proof of determinism or
permission to omit a required current check. Unknown live or temporal state
requires fresh execution. This interface does not offer a human waiver that
replaces a required check. Independent formal review is
still required and is not performed by this harness. Preparing this read-only
support document introduces no extra approval gate and supplies no waiver of
required checks.

## Dependency behavior exercised

The local helper namespace resolves exact `db_local.py`/`gc_local.py` files. It
never scans the entire editable checks directory to select an unrelated verifier
or lets local files shadow stdlib packages. Therefore adding another unread
verifier does not change the earlier observed inputs.

The focused tests cover:

- Helper, schema, seed, project Build Includes, PreDeployment and PostDeployment
  changes, including consumers that never read the CSV seed.
- File-mode changes with identical bytes.
- Glob membership changes when a script really scans a directory.
- An omitted indirect PreDeployment input being discovered and requiring work.
- Known metadata/dynamic-call audit blind spots requiring execution.
- Clock imports and SQL random/temporal functions requiring execution.
- Persistent/file databases and historical substitution of live state refused.
- SQL ATTACH, extension loading, subprocess and network capabilities refused.
- Functional failure, unsupported capability and infrastructure failure kept
  distinct, without turning infrastructure failure into a functional verdict.
- Reversed check order, nonempty-data rebuild refusal, copied ownership and
  tampered results.

## Existing native flow: real-script same-operation replay

`test-python-sql-native-replay.mjs` uses the public `begin`, `reserveDispatch`,
`bindNative`, `verifyNative`, `validateNativeResponse`, `captureNative` and
`publish` APIs with the real synthetic Python/SQLite recipe. Three scripts run
once in EXECUTE. Invalid envelope drafts and exact replay/capture retries run
zero additional scripts and preserve the original proof bytes. A separate
VALIDATE operation with an independent reviewer runs all three scripts again.
Its envelope repairs also add zero invocations. Total: six real Python script
invocations, not three across phases. No production gate changes or new user
approval steps were needed to demonstrate that existing behavior.

## Why this cannot authorize automatic caching

Python audit hooks are instrumentation, **not a hostile-code security sandbox**.
They do not prove all dependencies of arbitrary Python or native extension code.
The warning scan detects some metadata and dynamic-access patterns, but absence
of a warning is not a proof of closure. Imports, native libraries, filesystem
metadata, process identity, scheduling, clocks and randomness need a stronger
enforced execution contract before automatic reuse can be granted.

The harness explicitly reports this limitation. It must not be wired into the
native verification gate as if its historical presentation were another test
execution. This experiment's review-input identity is not a Sentinel native
owner/activation attestation. The optional document remains additional context only. Any future consumer must
continue distinguishing it from the native current verification receipt, without
adding a new approval ceremony or skipping the required recipe.

Measurements are printed for each synthetic test run. They report actual Python
processes, memory connections, execution time and presentation time. The test
adds no artificial sleep. Savings fluctuate with load and are only the cost of
showing earlier evidence again. They are not evidence that required SQL Server
checks have been safely skipped. A previous small run showed no time saving;
subsequent deduplication of runtime fingerprint reads within one guarded
presentation pass reduced that overhead. No cross-operation fingerprint cache
was added.

## SQL Server adapter: exact missing prerequisite and proposed scope

The synthetic campaign does not establish SQL Server capability. A real adapter requires Docker, sqlcmd and SqlPackage in a separately provisioned disposable environment. Missing tools or denied isolation capabilities must produce an explicit blocker rather than a weaker fallback or host security change. This original proposal is retained for technical context; the implemented opt-in bridge and its stricter no-mount isolation requirements are described in [the external gate contract](external-native-sqlserver-gate.md).

A supported SQL Server adapter needs a separately approved **disposable Linux
x86-64 environment**. Microsoft does not support SQL Server containers on
Rosetta, QEMU or other emulation/translation environments. Source:
[Microsoft deployment guidance](https://learn.microsoft.com/en-us/sql/linux/containers/deploy?view=sql-server-ver16).

Proposed test-only scope, not executed:

1. Use an official SQL Server Developer image pinned by digest and a specific
   sqlcmd/SqlPackage version. Provisioning must disclose the Microsoft EULA before
   accepting `ACCEPT_EULA=Y`. The official quickstart defaults to Developer:
   [Microsoft container quickstart](https://learn.microsoft.com/sql/linux/install-upgrade/quickstart-install-docker).
2. Allocate a unique new container, private network and disposable data volume.
   Do not attach any existing host database, work volume, credential or dump.
   A planning budget of two CPUs, 4 GiB RAM and 10 GiB disposable disk is a test
   allocation proposal, not a measured minimum or a price quotation.
3. Create only synthetic tables/procedures/users/data. Publish one synthetic
   dacpac, physically count the publication, record its image/schema/seed/server
   identities and establish a clean per-check baseline. Restore or recreate the
   baseline between checks. A read-only file digest cannot represent a live DB.
4. Execute the actual Python/sqlcmd profile against only that owned endpoint.
   Capture physical subprocess counts and complete outputs. Keep lock,
   permission, concurrency and performance tests outside automatic reuse unless
   their state/temporal contract is separately proven.
5. Preserve proof and review inputs. Clean up only the container and volume IDs
   created by the campaign, under the applicable deletion confirmation rules.

SqlPackage has a standalone distribution, so it need not be installed globally:
[Microsoft SqlPackage downloads](https://learn.microsoft.com/en-us/sql/tools/sqlpackage-download?view=sql-server-ver15).
Nothing was downloaded, accepted, installed or started for this proposed adapter.
New software/EULA, ephemeral authentication and any billable environment must be
approved under the applicable policy before provision. Acceptance of a Microsoft agreement requires its applicable disclosure and
authorization before provisioning.
