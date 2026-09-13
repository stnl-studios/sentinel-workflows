# Install Sentinel

Install or update Sentinel once for the current user, on every supported AI
coding platform:

```text
node scripts/install-sentinel.mjs
```

Validate that installation:

```text
node scripts/doctor-sentinel.mjs
```

These no-argument commands are the normal workflow. They mean `scope=user` and
`platform=all`; `all` currently resolves from the production platform registry
to Codex and Claude Code. The repository is the only source. Installation does
not use the network, a remote registry, a global npm package, administrator
access, or content under `targets/`.

Running the install command again is the update operation.

## User installation layout

The installer resolves the current user's home with Node's portable home
directory API. Callers do not provide `HOME`, a project path, or native
destination paths.

Codex receives:

```text
~/.agents/skills/<canonical-skill>/...
~/.codex/agents/stnl_spec_context_scout.toml
~/.codex/agents/stnl_validation_runner.toml
~/.sentinel/prompts/<shared-or-codex-prompt>.md
```

Claude Code receives:

```text
~/.claude/skills/<canonical-skill>/...
~/.claude/agents/stnl-spec-context-scout.md
~/.claude/agents/stnl-validation-runner.md
~/.claude/commands/<shared-or-claude-prompt>.md
```

Shared Sentinel metadata for the complete user installation is:

```text
~/.sentinel/install-manifest.json
~/.sentinel/install.lock
```

The lock exists only while an install transaction is active. The Codex prompt
catalog remains explicitly Sentinel-owned at `~/.sentinel/prompts/`; the
installer does not use deprecated global Codex custom-prompt mechanisms.

All paths above are logical layouts. The implementation uses Node path APIs and
does not assume Unix separators or shell expansion of `~`.
The resolved installation root must be an existing real directory rather than
a symlink; an install also verifies that the root is user-writable before it
creates a lock or stage. Tests inject nested temporary homes and never install
into the test runner's real home.

## Explicit alternatives

Filter a user installation to one platform:

```text
node scripts/install-sentinel.mjs --platform codex
node scripts/install-sentinel.mjs --platform claude-code
```

Create an isolated project installation:

```text
node scripts/install-sentinel.mjs --scope project --project <path>
node scripts/install-sentinel.mjs --scope project --project <path> --platform codex
node scripts/install-sentinel.mjs --scope project --project <path> --platform claude-code
```

Project scope defaults to all platforms when no filter is supplied. Its native
destinations remain unchanged:

```text
# Codex
<project>/.agents/skills/<canonical-skill>/...
<project>/.codex/agents/...
<project>/.sentinel/prompts/...

# Claude Code
<project>/.claude/skills/<canonical-skill>/...
<project>/.claude/agents/...
<project>/.claude/commands/...

# Shared project metadata
<project>/.sentinel/install-manifest.json
<project>/.sentinel/install.lock
```

For compatibility, an existing explicit form such as the following still means
project scope; it is never reinterpreted as a user install:

```text
node scripts/install-sentinel.mjs --platform codex --project <path>
```

`--scope user --project <path>`, project scope without `--project`, and unknown
scope or platform values fail closed. The only scopes are `user` and `project`;
the platform selector accepts `all`, `codex`, or `claude-code`.

## Dry run

Use `--dry-run` with any valid scope/platform combination:

```text
node scripts/install-sentinel.mjs --dry-run
node scripts/install-sentinel.mjs --platform codex --dry-run
node scripts/install-sentinel.mjs --scope project --project <path> --dry-run
```

The output identifies the scope, selected platforms, resolved installation root
and root type, combined fingerprint, and every sorted source/destination
mapping with byte size and content hash. A dry run creates no lock, stage,
manifest, or installed file. Absolute installation roots may be displayed for
operator clarity, but they are not inputs to the fingerprint.

## One multi-platform transaction

An `all` install is one logical transaction, not two committed platform runs:

```text
validate canonical source
→ build one deterministic scope/platform plan
→ stage every selected platform under the installation root
→ validate the complete stage
→ publish all selected managed units with one backup/rollback boundary
→ read back all managed bytes and the manifest
→ commit
```

The common installation root is the user's home for user scope and the consumer
project for project scope. Stages and backups are created directly under that
root so publication renames remain on one filesystem as much as practical.
Publication never begins until the complete Codex/Claude stage validates. A
pre-commit failure removes newly published units and restores the previous
installation across every selected platform. Success is reported only after
all selected bytes and the final manifest read back correctly.

Residual stages or backups from interrupted/cleanup-constrained operations are
untrusted. They are reported for operator review and are never resumed or
consumed automatically.

## Plan, fingerprint, manifest, and transitions

The deterministic plan records schema and policy versions, scope, the canonical
ordered platform set, artifact ownership, normalized logical destination paths,
source mappings, and bytes. `all` is resolved from the single exported
production-platform authority shared by installer, doctor, and source doctor.

The combined fingerprint covers policy version, scope, selected platforms,
each entry's platform/logical destination, length, and bytes. It deliberately
excludes absolute user/project roots, usernames, OS separators, timestamps,
UUIDs, temporary paths, and traversal order. Scope is included even when two
layouts currently use the same relative mapping: user and project installs have
different operational identity, ownership roots, and doctor expectations.
Changing material Codex or Claude content changes an `all` fingerprint.

Manifest schema v2 uses an explicit platform array:

```json
{
  "schemaVersion": 2,
  "scope": "user",
  "platforms": ["codex", "claude-code"]
}
```

The full manifest also records policy, fingerprint, files, and managed
publication units. Schema-v1 project manifests with singular `platform` remain
readable and retain their ownership data. Doctor reports them as requiring an
upgrade. The next successful project install normalizes that ownership and
publishes an unambiguous schema-v2 manifest; doctor never upgrades metadata.

Transitions between `all`, `codex`, and `claude-code` reconcile exact known
Sentinel units. Artifacts owned by the previous manifest but omitted by the new
selection may be removed. Unrelated skills, agents, commands, prompts, and
neighboring files are preserved.

## Ownership and collision safety

Every canonical skill comes from `scripts/lib/skill-registry.mjs`. Production
installs include `SKILL.md`, operational `runtime/**` except `runtime/test/**`,
operational `templates/**`, explicitly classified production references, and
Codex `agents/openai.yaml` metadata where applicable. Development-only material
remains excluded.

Unknown skill content, references, prompts, symlinks, special files, path
escapes, drive-qualified paths, and incomplete plans fail closed. A Sentinel
skill root is claimed only when `SKILL.md` declares its canonical Sentinel
identity. A known agent, prompt, or command without manifest ownership is
claimable only when its bytes match canonical source. Native directories are
never swept; only exact Sentinel-known managed paths can be replaced or
removed.

## Locking and cleanup

There is one lock per installation root:

```text
user:    ~/.sentinel/install.lock
project: <project>/.sentinel/install.lock
```

It protects the complete selected platform set and uses exclusive `wx`
creation, a random ownership token, and diagnostic process/time metadata. Lock
release rechecks token ownership on every bounded cleanup attempt. Missing,
malformed, or replaced metadata fails closed. Locks are never stolen
automatically. A user lock does not block an unrelated project install, and
different project roots remain independent.

If an interrupted process leaves a lock, first verify that no installer is
active, then remove that exact lock manually. Doctor observes locks and
residuals but never deletes or repairs them. Common transient Windows cleanup
errors are retried a bounded number of times; a post-commit cleanup failure is
reported without misreporting the committed installation as rolled back.

## Doctor

The default doctor expects one coherent user-scope all-platform installation:

```text
node scripts/doctor-sentinel.mjs
```

Explicit checks are also available:

```text
node scripts/doctor-sentinel.mjs --scope user --platform codex
node scripts/doctor-sentinel.mjs --scope user --platform claude-code
node scripts/doctor-sentinel.mjs --scope project --project <path>
node scripts/doctor-sentinel.mjs --scope project --project <path> --platform codex
node scripts/doctor-sentinel.mjs --source-only
```

For backward compatibility, `doctor --project <path>` without an explicit scope
or platform diagnoses the platform selection recorded by an existing
single-platform project manifest. Explicit project scope defaults to `all`.

Installed doctor validates manifest schema, scope, platform set, policy,
combined fingerprint, exact managed bytes and skill contents, ownership units,
omitted-platform residue, active lock, residual stage, and residual backup. A
default `all` check cannot be healthy when only one platform matches. `OK` means
source and live managed state are healthy; `DRIFT` means live state differs;
`BLOCKED` identifies unusable source/metadata or an active lock. Doctor is
read-only.

Source-only doctor validates every platform from the same canonical production
authority and performs no installation writes:

```text
node scripts/doctor-sentinel.mjs --source-only
```

## Windows and constrained VDI validation

The implementation uses Node home/path APIs, accepts nested roots containing
spaces, rejects Windows drive-qualified relative destinations, and requires
only user-writable native paths. It does not require administrator privileges.

On the actual Windows or corporate VDI image, run from this repository in
PowerShell or Command Prompt:

```text
node --check scripts/lib/sentinel-distribution.mjs
node --check scripts/lib/sentinel-doctor.mjs
node --test scripts/test-sentinel-distribution.mjs scripts/test-sentinel-doctor.mjs scripts/test-sentinel-global-installation.mjs
node scripts/doctor-sentinel.mjs --source-only
node scripts/install-sentinel.mjs --dry-run
```

Then install and doctor user/all plus a representative deeply nested,
space-containing project/all target. The portable suite injects common Windows
cleanup error codes, but physical execution is still required to validate local
antivirus, indexing, filesystem policy, VDI redirection, and path-length
behavior.
