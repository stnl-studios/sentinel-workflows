# Sentinel production installer

The repository is the only installation source. The installer does not use a
registry, network access, global package installation, or content under
`targets/`.

Run it from this repository with an existing consumer-project directory:

```text
node scripts/install-sentinel.mjs --platform codex --project <path>
node scripts/install-sentinel.mjs --platform claude-code --project <path>
```

Add `--dry-run` to print the sorted source/destination plan, byte sizes, hashes,
and final distribution fingerprint without changing the consumer project.

## Locking

Each consumer project has one exclusive installer transaction lock at
`.sentinel/install.lock`. The installer creates it with Node's exclusive `wx`
file creation and records a random ownership token plus diagnostic process/time
metadata. A concurrent installer for the same project fails with `Sentinel
installation already in progress`; installers for other projects are
independent. The owner verifies its token and releases the lock during final
cleanup, including after pre-commit failure. Dry runs do not create the lock.

Locks are never stolen automatically. If an interrupted process leaves a stale
lock, first verify that no installer is active, then remove that exact
project-local lock file manually. `doctor` reports a present lock but never
removes it.

## Installed layout

Codex uses the current repository-local skill discovery path and the existing
native agent contract:

```text
.agents/skills/<canonical-skill>/...
.codex/agents/stnl_validation_runner.toml
.codex/agents/stnl_spec_context_scout.toml
.sentinel/prompts/<shared-or-codex-prompt>.md
.sentinel/install-manifest.json
```

Codex custom prompts are user-home-only and deprecated, so Sentinel does not
write `~/.codex/prompts` or invent a project-local `.codex/prompts` contract.
The checked-in, project-local `.sentinel/prompts/` directory is the explicit
portable launcher catalog for Codex.

Claude Code uses its native project-local skill, agent, and command paths:

```text
.claude/skills/<canonical-skill>/...
.claude/agents/stnl-validation-runner.md
.claude/agents/stnl-spec-context-scout.md
.claude/commands/<shared-or-claude-prompt>.md
.sentinel/install-manifest.json
```

Only the selected platform's three slice launchers and two agents are present.
All other classified prompts are shared production prompts.

## Production policy and ownership

Every canonical skill comes from `scripts/lib/skill-registry.mjs`. Production
installs include `SKILL.md`, operational `runtime/**` except `runtime/test/**`,
operational `templates/**`, and explicitly classified runtime references.
Codex also receives a skill's `agents/openai.yaml` when present; Claude Code
does not. Evals, examples, maintenance material, maintenance README files, and
the lifecycle manager's evaluation/token-economy references are excluded.
Unknown skill top-level content, unknown references, unknown prompts, symlinks,
special files, and path escapes fail planning.

The manifest is a small ownership receipt, not a package database. It records
the selected platform, deterministic fingerprint, installed files, and managed
publication units. A canonical Sentinel skill directory is owned as a unit, so
reinstalling replaces an old manual/full copy and removes stale tests, evals,
examples, and maintenance files. A pre-existing directory is claimed only when
its `SKILL.md` declares the expected canonical Sentinel name. Unrelated skills,
agents, commands, prompts, and neighboring project files are never swept.
A same-name agent or prompt without manifest ownership is claimed only when its
bytes equal the canonical source; differing content fails without replacement.

## Transaction semantics

The pipeline is source → plan → stage → validate staged installation → publish.
Staging occurs under the consumer project so renames remain on one filesystem.
Publication backs up only Sentinel-owned units, installs the validated units,
performs byte-for-byte readback, and validates the published manifest. That
successful readback is the logical commit point. Any failure before it attempts
rollback from the transaction backup. After it, the new installation is
committed: failure to delete the old backup is reported as a successful install
with a `POST_COMMIT_BACKUP_CLEANUP_FAILED` warning and a residual backup path;
the committed installation is not rolled back. Unpublished stages and other
transaction-finalization residuals are also surfaced explicitly.

Publication spans several native roots, so it is a rollback transaction rather
than a single filesystem-atomic rename. An abrupt process or machine termination
during the publication window can leave hidden stage/backup directories and
requires operator inspection; the installer does not claim crash atomicity.

The fingerprint covers the policy version, selected platform, sorted installed
relative paths, and file bytes. It contains no timestamps, UUIDs, temporary or
absolute paths. An identical verified installation is reported as `unchanged`.

## Doctor

Doctor is read-only and emits deterministic structured JSON:

```text
node scripts/doctor-sentinel.mjs --source-only
node scripts/doctor-sentinel.mjs --project <path>
```

Source-only mode validates the canonical registry/discovery inventory,
production classification, agent and launcher contracts, runtime/resource
closure, deterministic plans, and fingerprints for both Codex and Claude Code.
Installed-project mode derives the platform from
`.sentinel/install-manifest.json`, repeats source validation, and compares the
manifest, ownership units, managed file bytes, exact managed skill contents,
platform agents, prompts, and launchers with the current plan. Unrelated
third-party content is ignored.

`OK` means the source and live managed installation are healthy. `DRIFT` means
managed live state differs from the current plan. `BLOCKED` identifies an
unusable source/manifest or an active installer lock. Residual stage and backup
directories are warnings reported separately; a healthy committed installation
remains `OK` when only cleanup residuals exist. Doctor never repairs or removes
locks, stages, backups, or installed files.
