# External native SQL Server gate

This is an explicit integration gate, not an npm-test skip or part of the normal
offline suite. Entry: `npm run verify:sqlserver-native`. Missing prerequisites fail
with exit 1 and `STNL_NATIVE_SQLSERVER_BLOCKED_OR_FAILED`, never PASS.

Status when authored: **not executed against SQL Server**. Only offline mock and
contract checks have run. The earlier standalone SQL Server campaign at commit
37f97ac12c9cd57cf586d3b13c1c6ca38335e11e is separate evidence, not a native bridge result.

## Exact-source and protocol contract

Run only from the reviewed final clean source commit. The CLI records commit, tree and hashes of all tracked regular files, refuses a dirty
checkout and compares those identities again before emitting PASS. It uses the public native operation APIs from
the existing SQLite regression, with synthetic author/reviewer judgments and no
model calls. Three fixed Python wrappers perform schema, import/history/summary
and nonempty-rebuild preservation checks against new synthetic databases.

Each wrapper performs a real SQL project restore/build, DACPAC publication and
SQLCMD checks. Source includes the project Build/PreDeploy/PostDeploy declarations,
T-SQL and CSV. All build outputs and command ledgers are outside the observed
product tree. Every invocation uses a new database name bound to the run ID and
a random check ID. Existing names fail; there is no DROP/reuse/cache path.

The gate requires EXECUTE 3, repairs/replay 0, VALIDATE 3 additional, repairs/replay 0.
It compares the entire command ledger between repair/replay stages, counts builds,
publications and sqlcmd processes, and checks original receipt/observation bytes
remain unchanged. Its final formal PASS is for this synthetic EXECUTE/VALIDATE protocol scenario. It does not exercise terminal COMPLETE/CLOSE or launch actual Claude/Codex model runners, and it does not certify a complete lifecycle or model semantic judgment.
Network connection count, arbitrary dependency closure, performance, concurrent
locks, private work scripts and model-decision quality are not certified.

## Preflight and resource boundaries

No code here creates, starts, stops or removes containers, changes Docker settings,
installs global tools, pulls an image, contacts a model or triggers CI. Provisioning
and cleanup are separate, explicitly authorized operator steps.

Before provisioning:
1. Use the final reviewed source and an isolated environment with sufficient headroom.
2. Check only aggregate available host/Docker-VM memory, disk and CPU capacity.
   An owned short-lived metadata probe is acceptable; do not inspect existing
   container data/configuration. Require headroom for a capped 4 GiB / 2 CPU test,
   plus existing workloads and temporary SDK/package/build disk use. If capacity
   is insufficient or uncertain, stop. Never stop other services or resize Docker.
3. Use a unique `stnl-synthetic-...` container name and numeric run ID. Confirm the
   existing image digest below without pulling. Record the newly created container
   ID and label. Never select a work container, database or old volume.

Provision one NEW disposable container with:
- Exact existing image:
  `mcr.microsoft.com/mssql/server@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718`.
- `--pull never --platform linux/amd64 --memory 4g --cpus 2`.
- `--label com.sentinel.synthetic=<run-id>`.
- No published ports, no existing bind mounts or volumes, no restart policy.
  Use explicit network mode bridge for isolated tool preparation, then disconnect
  that container. Host and container:<ID> network modes are forbidden even when
  NetworkSettings.Networks appears empty; only bridge/none modes are accepted.
- `MSSQL_PID=Developer`, approved `ACCEPT_EULA=Y`, and newly generated random
  `MSSQL_SA_PASSWORD` supplied by environment, never printed or saved as proof.
  Generate exactly `Stnl!` plus 48 lowercase hexadecimal characters from 24 random
  bytes (for example Python secrets.token_hex(24)). The CLI and adapter reject every
  other format before Docker/log/hash, including XML/connection-string delimiters.
  This fixed safe format avoids encoded variants of the credential in XML profiles.
- A private shell variable/environment `SQLCMDPASSWORD` holding the same
  ephemeral password. Do not enable shell tracing.
- A recorded UTC EULA acceptance time and the Microsoft license link.

The Mac's linux/arm64 Docker host executes this amd64 SQL Server image by emulation.
Set route `local-docker-emulated`. A pass means compatibility only. Microsoft does
not support SQL Server container emulation; do not label it native x64 certification.
The already completed standard GitHub x64 campaign remains separate reference evidence.

## Official tools inside the owned container

Required container-owned layout:
- `/tmp/stnl-tools-<run-id>/dotnet/dotnet`: official .NET SDK 10.0.403 Linux x64.
- `/tmp/stnl-tools-<run-id>/sqlpackage/sqlpackage`: Microsoft.SqlPackage 170.5.96.
- `/tmp/stnl-tools-<run-id>/home`: private DOTNET_CLI_HOME.
- `/tmp/stnl-tools-<run-id>/packages`: private NUGET_PACKAGES.
- `/tmp/stnl-tools-<run-id>/feed`: owned local feed directory.

Download the SDK only from Microsoft's official .NET distribution, using its
official installer with explicit version/architecture/OS into an owned temporary
directory. The installer URL is https://dot.net/v1/dotnet-install.sh; inspect its
current supported instructions before executing it. Copy only these newly obtained
tools into the owned container. Do not run a Linux SDK on the Mac host.

Within that container, with DOTNET_ROOT, DOTNET_CLI_HOME and NUGET_PACKAGES set to
the owned paths, set DOTNET_CLI_TELEMETRY_OPTOUT=1, DACFX_TELEMETRY_OPTOUT=1,
DOTNET_GENERATE_ASPNET_CERTIFICATE=false, DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false and
DOTNET_NOLOGO=1 before the first .NET invocation. Do not run dev-certs or modify
host trust. Then install the pinned tool with:
`dotnet tool install microsoft.sqlpackage --version 170.5.96 --tool-path <owned-sqlpackage-path> --source https://api.nuget.org/v3/index.json`.

Prepare the SDK resolver and NuGet cache by restoring/building only a copied
synthetic project from this fixture with Microsoft.Build.Sql 2.3.0. Keep preparation
counts separate from campaign counts. Use no host NuGet config or credential file.
Record actual tool versions and hashes before disconnecting network.

After official downloads/preparation, disconnect only the newly created container
from its network. Do not alter Docker's daemon or shared networks. The adapter
refuses any attached network except Docker's none network and refuses every host
port binding. During the campaign it restores from the owned local feed/cache,
builds and publishes with Docker exec. SQLCMD and SqlPackage connect to SQL Server
inside the same container at the fixed IPv4 TCP endpoint `tcp:127.0.0.1,1433`,
without hostname resolution or any host TCP port. Endpoint and SQLCMD startup
overrides are refused; this endpoint is not operator-configurable. Every effect uses the full recorded
container ID, not its mutable name. Each wrapper checks ID/name binding, exact image
and owner label, no mounts, fixed local Unix Docker context, CPU/memory caps, no
ports and disconnected networking before any data mutation. Ambient Docker host,
context or TLS overrides are refused.

## Execute after final-source approval

Set only the following task-specific environment in the private invoking process:
- STNL_SQLSERVER_NATIVE=1
- STNL_SQLSERVER_EULA_ACCEPTED=yes
- STNL_SQLSERVER_ROUTE=local-docker-emulated
- STNL_SQLSERVER_RUN_ID=<numeric run identity>
- STNL_SQLSERVER_CONTAINER=<new owned container name>
- STNL_SQLSERVER_CONTAINER_ID=<full 64-character newly created container ID>
- STNL_SQLSERVER_DOCKER_CONTEXT=<verified local Unix context name>
- SQLCMDPASSWORD=<the freshly generated ephemeral value>

Then invoke `npm run verify:sqlserver-native` from the final clean source clone.
For a supported Linux x64 container host use local-docker instead. For an explicitly
approved standard public GitHub runner use github-actions; it additionally verifies
repository, run ID and X64 architecture. No workflow is included or triggered here.

The native producer has a 120-second per-check timeout. A slow emulated run may
fail. Preserve that failure and its uncertain/pending native observation; never
remove it to retry within the same operation. No timeout or production gate is
weakened by this adapter.

## Proof, secrets and cleanup

The adapter sanitizes output before native capture or hashing. Before native
verification, the CLI moves the ephemeral credential to a new owned mode-0600
support file outside the product, removes it from the environment and refuses any
remaining environment value containing it. Thus the secret is not part of the
native environment hash. It removes that support file in its final cleanup.

SQLCMD receives the value only in its required subprocess environment. SqlPackage
receives a mode-0600 publish profile over stdin inside the owned container, uses
only the profile path in argv, and removes that profile in a finally block. No
password is in host or container argv. Input/profile bytes are not logged or hashed.
Private support/profile paths are redacted from public observations. Never upload
those files. No recipe, carrier, ledger or public result contains credential values.

Python security gates use explicit guards. Optimized Python exits 2 before Docker,
and the native recipe uses -E -s -B to ignore PYTHON environment overrides and user
site packages while preserving the known sibling adapter import.

The CLI canonicalizes its newly created evidence directory with realpath. The
adapter canonicalizes the support file parent while opening the file itself with
O_NOFOLLOW, permitting legitimate macOS /var aliases but refusing secret-file symlinks.

The CLI preserves an owned evidence directory containing the redacted physical
command ledger and public result. Native fixture data may contain producer authority
keys, so NEVER upload the entire fixture or evidence directory indiscriminately.
Report only reviewed public results/hashes. Do not export pre-existing Mac backups.

After a run, first preserve/check exit, log and evidence hashes, including failures.
Verify the container's exact recorded ID AND run label before removing only that
container. Its SDK/cache/databases live in its writable layer and are removed with
it. No global SDK/install, outside volume or recurring job exists. Remove owned host
tool-download temporary files only after their hashes and necessary evidence are
preserved. Leave QA logs and source patches available for review.

## Offline validation

`node --test scripts/test-sqlserver-bridge-contract.mjs scripts/test-test-catalog.mjs`

This runs four Node bridge contracts, seventeen mocked Python cases and the existing
catalog contract tests. It invokes no Docker, SQL Server or network operation.
The ordered normal catalog increases from 111 to 112 runnable files solely for
the offline bridge-contract file. Production runtime/distribution is unchanged.

Sources:
- https://learn.microsoft.com/en-us/sql/linux/containers/deploy?view=sql-server-ver16
- https://go.microsoft.com/fwlink/?LinkId=746388
- https://learn.microsoft.com/en-us/sql/tools/sqlpackage/sqlpackage-download
- https://dotnet.microsoft.com/en-us/download/dotnet/10.0
- https://www.nuget.org/packages/Microsoft.Build.Sql/2.3.0
