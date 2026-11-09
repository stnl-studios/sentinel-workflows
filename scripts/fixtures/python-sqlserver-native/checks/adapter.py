"""Explicit external SQL Server gate. Never provisions a container or reuses a DB."""
import csv
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import stat
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
IMAGE = "mcr.microsoft.com/mssql/server@sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718"
SQL_ENDPOINT = "tcp:127.0.0.1,1433"
CHECKS = ("schema", "import", "rebuild")
if sys.flags.optimize:
    print("SQL_SERVER_GATE_BLOCKED: Python optimization disables required verification", file=sys.stderr)
    raise SystemExit(2)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)

def require_credential(secret):
    require(re.fullmatch(r"Stnl![0-9a-f]{48}", secret) is not None,
            "new credential must use the documented safe generated format")
    return secret


def read_credential(evidence_value, credential_value):
    evidence = Path(evidence_value).resolve(strict=True)
    require(not evidence.is_relative_to(ROOT.resolve()), "evidence must stay outside observed product source")
    credential = Path(credential_value)
    # Canonicalize only the parent. Never resolve/follow the secret file itself.
    require(credential.parent.resolve(strict=True) == evidence and credential.name == "credential-support",
            "credential support must belong to this evidence directory")
    descriptor = os.open(credential, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(descriptor, encoding="utf8") as private:
        metadata = os.fstat(private.fileno())
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_mode & 0o777 == 0o600 and metadata.st_uid == os.getuid(),
                "owned mode-0600 credential support required")
        require(metadata.st_size <= 512, "credential support size invalid")
        secret = private.read()
    return evidence, require_credential(secret)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value):
    return "sha256:" + hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def config_from_env(env):
    # This pure preflight performs no subprocess, daemon access or filesystem writes.
    require(env.get("STNL_SQLSERVER_NATIVE") == "1", "external SQL Server gate is not explicitly enabled")
    require(env.get("STNL_SQLSERVER_EULA_ACCEPTED") == "yes", "approved SQL Server EULA required")
    route = env.get("STNL_SQLSERVER_ROUTE")
    require(route in ("github-actions", "local-docker", "local-docker-emulated"), "explicit supported route required")
    run_id = env.get("STNL_SQLSERVER_RUN_ID", "")
    require(re.fullmatch(r"[0-9]{1,24}", run_id), "numeric owned run identity required")
    container = env.get("STNL_SQLSERVER_CONTAINER", "")
    require(re.fullmatch(r"stnl-synthetic-[a-z0-9-]{1,80}", container), "owned synthetic container name required")
    container_id = env.get("STNL_SQLSERVER_CONTAINER_ID", "")
    require(re.fullmatch(r"[a-f0-9]{64}", container_id), "full owned container ID required")
    context = env.get("STNL_SQLSERVER_DOCKER_CONTEXT", "")
    require(re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", context), "fixed Docker context required")
    require(not any(env.get(k) for k in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")), "ambient Docker overrides are not allowed")
    require(not env.get("SQLCMDPASSWORD") and not env.get("MSSQL_SA_PASSWORD"), "remove credentials from native process environment")
    require(Path(env.get("STNL_SQLSERVER_NATIVE_CREDENTIAL_FILE", "")).is_absolute(), "private credential support required")
    require(not any(env.get(k) for k in ("SQLCMDSERVER", "SQLCMDINI", "STNL_SQLSERVER_ENDPOINT",
            "STNL_SQLSERVER_HOST", "STNL_SQLSERVER_PORT", "STNL_SQLSERVER_CONNECTION_STRING")),
            "SQL endpoint and startup overrides are not allowed")
    tools = "/tmp/stnl-tools-" + run_id
    if route == "github-actions":
        require(env.get("GITHUB_ACTIONS") == "true", "GitHub Actions required")
        require(env.get("GITHUB_REPOSITORY") == "stnl-studios/sentinel-workflows", "approved repository required")
        require(env.get("RUNNER_ARCH") == "X64", "native x64 runner required")
        require(env.get("GITHUB_RUN_ID") == run_id, "GitHub run identity mismatch")
    return {"route": route, "runId": run_id, "container": container, "containerId": container_id, "context": context, "tools": tools,
            "dotnet": tools + "/dotnet/dotnet", "sqlpackage": tools + "/sqlpackage/sqlpackage"}


def sanitize_text(value, secret):
    text = str(value).replace(secret, "[EPHEMERAL_CREDENTIAL]") if secret else str(value)
    private_path = os.environ.get("STNL_SQLSERVER_NATIVE_CREDENTIAL_FILE", "")
    if private_path:
        text = text.replace(private_path, "[PRIVATE_CREDENTIAL_SUPPORT_REDACTED]")
    text = re.sub(r"[^\s'\"<>]*credential\.publish\.xml", "[PRIVATE_PUBLISH_PROFILE_REDACTED]", text)
    text = re.sub(r"/TargetConnectionString:[^\r\n]*", "[LOCAL_CONNECTION_REDACTED]", text, flags=re.I)
    return re.sub(r"(?i)(?:Password|Pwd)\s*=\s*[^;\s]*", "[CREDENTIAL_FIELD_REDACTED]", text)


def public_argument(value, secret):
    if "credential.publish.xml" in str(value) or "credential-support" in str(value):
        return "[PRIVATE_CREDENTIAL_SUPPORT_REDACTED]"
    if str(value).lower().startswith("/targetconnectionstring:"):
        return "/TargetConnectionString:[LOCAL_SYNTHETIC_CONNECTION_REDACTED]"
    if "/targetpassword:" in str(value).lower():
        return "[FIXED_PUBLICATION_CREDENTIAL_EXPANSION_REDACTED]"
    return sanitize_text(value, secret)


def parse_sql_json(value):
    return json.loads(value.replace("\r", "").replace("\n", "").strip())


class Adapter:
    def __init__(self, config, output, ledger, secret):
        self.config, self.output, self.ledger, self.secret = config, output, ledger, require_credential(secret)
        self.counts = {}
        self.check_id = uuid.uuid4().hex
        self.database = "stnl_synthetic_" + config["runId"] + "_" + self.check_id

    def record(self, item):
        encoded = canonical(item) + "\n"
        # Refuse an unforeseen secret rather than trusting provider-side masking.
        assert self.secret not in encoded, "credential escaped public redaction"
        with self.ledger.open("a", encoding="utf8") as out:
            out.write(encoded)
        return item

    def docker(self, *arguments):
        return ["docker", "--context", self.config["context"], *arguments]

    def command(self, kind, arguments, expected=0, timeout=70, input_text=None, sql_password=False):
        started = time.monotonic()
        try:
            environment = dict(os.environ)
            if sql_password:
                environment["SQLCMDPASSWORD"] = self.secret
            result = subprocess.run(arguments, input=input_text, env=environment, capture_output=True, text=True, timeout=timeout)
            stdout, stderr, code = result.stdout, result.stderr, result.returncode
        except (OSError, subprocess.TimeoutExpired) as error:
            self.record({"type": "process", "checkId": self.check_id, "kind": kind,
                         "argv": [public_argument(a, self.secret) for a in arguments],
                         "exit": None, "infrastructureError": type(error).__name__})
            raise RuntimeError("external command infrastructure failure: " + type(error).__name__) from None
        self.counts[kind] = self.counts.get(kind, 0) + 1
        public_args = [public_argument(a, self.secret) for a in arguments]
        item = self.record({"type": "process", "checkId": self.check_id, "kind": kind, "argv": public_args,
            "argvRedacted": public_args != list(arguments), "exit": code,
            "stdout": sanitize_text(stdout, self.secret), "stderr": sanitize_text(stderr, self.secret),
            "durationMs": round((time.monotonic() - started) * 1000, 3)})
        if expected == "nonzero":
            assert code != 0, "expected SQL rejection did not happen"
        else:
            assert code == expected, kind + " failed: " + item["stdout"] + item["stderr"]
        return item

    def authorize_container(self):
        c = self.config["containerId"]
        endpoint = self.command("preflight", self.docker("context", "inspect", self.config["context"], "--format", '{{.Endpoints.docker.Host}}'))["stdout"].strip()
        require(endpoint.startswith("unix:///"), "only a fixed local Unix Docker context is allowed")
        actual_id = self.command("preflight", self.docker("inspect", "--format", "{{.Id}}", self.config["container"]))["stdout"].strip()
        require(actual_id == c, "owned container name was replaced")
        arch = self.command("preflight", self.docker("info", "--format", "{{.Architecture}}"))["stdout"].strip()
        if self.config["route"] == "local-docker-emulated":
            require(arch in ("aarch64", "arm64"), "compatibility-only route requires the explicitly approved ARM Docker host")
        else:
            require(arch in ("x86_64", "amd64"), "Microsoft SQL Server requires native x86-64; emulation needs its separate compatibility route")
        owner = self.command("preflight", self.docker("inspect", "--format",
            '{{index .Config.Labels "com.sentinel.synthetic"}}', c))["stdout"].strip()
        require(owner == self.config["runId"], "existing container is not owned by this run")
        image = self.command("preflight", self.docker("inspect", "--format", "{{.Config.Image}}", c))["stdout"].strip()
        require(image == IMAGE, "container image differs from approved official digest")
        def metadata(template):
            return json.loads(self.command("preflight", self.docker("inspect", "--format", template, c))["stdout"])
        require(metadata('{{json .Mounts}}') == [], "no existing or external mounts are allowed")
        memory = metadata('{{json .HostConfig.Memory}}')
        cpu = metadata('{{json .HostConfig.NanoCpus}}')
        require(isinstance(memory, int) and 2 * 1024**3 <= memory <= 4 * 1024**3, "explicit memory limit between 2 and 4 GiB required")
        require(isinstance(cpu, int) and 0 < cpu <= 2_000_000_000, "explicit CPU cap of at most two required")
        require(metadata('{{json .HostConfig.PortBindings}}') in ({}, None), "the external gate permits no published ports")
        require(metadata('{{json .HostConfig.NetworkMode}}') in ("none", "bridge"),
                "host, shared-container and unrecognized network modes are forbidden")
        networks = metadata('{{json .NetworkSettings.Networks}}')
        require(not networks or set(networks) == {"none"}, "disconnect the owned container network after preparing official tools")

    def tool(self, executable, arguments):
        # No raw credential is passed in host argv. Only the name is inherited.
        tools = self.config["tools"]
        return self.docker("exec",
            "-e", "HOME=" + tools + "/home",
            "-e", "DOTNET_ROOT=" + tools + "/dotnet",
            "-e", "DOTNET_CLI_HOME=" + tools + "/home",
            "-e", "NUGET_PACKAGES=" + tools + "/packages",
            "-e", "DOTNET_CLI_TELEMETRY_OPTOUT=1", "-e", "DACFX_TELEMETRY_OPTOUT=1",
            "-e", "DOTNET_GENERATE_ASPNET_CERTIFICATE=false", "-e", "DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false",
            "-e", "DOTNET_NOLOGO=1",
            self.config["containerId"], executable, *arguments)

    def sql(self, query, database=None, expected=0):
        name = database or self.database
        assert name == "master" or name == self.database, "unowned SQL database"
        return self.command("sqlcmd", self.docker("exec", "-i", "-e", "SQLCMDPASSWORD",
            self.config["containerId"], "/opt/mssql-tools18/bin/sqlcmd", "-S", SQL_ENDPOINT, "-U", "sa",
            "-C", "-b", "-r", "1", "-l", "15", "-t", "60", "-y", "0", "-w", "65535",
            "-d", name, "-Q", "SET NOCOUNT ON; " + query), expected=expected, sql_password=True)

    def state(self):
        query = """
SELECT
 JSON_QUERY(COALESCE((SELECT Id,Payload FROM dbo.Imported ORDER BY Id FOR JSON PATH),N'[]')) AS imported,
 JSON_QUERY(COALESCE((SELECT Id,ImportedRows FROM dbo.ImportHistory ORDER BY Id FOR JSON PATH),N'[]')) AS history,
 JSON_QUERY((SELECT Id,Total FROM dbo.Summary ORDER BY Id FOR JSON PATH)) AS summary,
 JSON_QUERY((SELECT Id,Marker FROM dbo.DeploymentEvidence ORDER BY Id FOR JSON PATH)) AS deployment,
 JSON_QUERY((SELECT t.name AS tableName,c.name AS columnName,c.column_id,c.system_type_id,c.max_length,c.is_nullable,c.is_identity
   FROM sys.tables t JOIN sys.columns c ON c.object_id=t.object_id WHERE t.is_ms_shipped=0 ORDER BY t.name,c.column_id FOR JSON PATH)) AS columns,
 JSON_QUERY((SELECT OBJECT_NAME(object_id) AS tableName,name,CONVERT(nvarchar(100),seed_value) AS seed_value,CONVERT(nvarchar(100),increment_value) AS increment_value,CONVERT(nvarchar(100),last_value) AS last_value FROM sys.identity_columns ORDER BY object_id,column_id FOR JSON PATH)) AS identities,
 JSON_QUERY((SELECT o.name,o.type,m.definition FROM sys.objects o LEFT JOIN sys.sql_modules m ON m.object_id=o.object_id
   WHERE o.is_ms_shipped=0 ORDER BY o.type,o.name FOR JSON PATH)) AS objects
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
"""
        data = parse_sql_json(self.sql(query)["stdout"])
        return {"sha256": digest(canonical(data)), "dataAndSchema": data}

    def import_fixture(self):
        with (ROOT / "fixtures/synthetic.csv").open(newline="") as source:
            rows = [(int(row["id"]), row["payload"]) for row in csv.DictReader(source)]
        values = ",".join("(%d,N'%s')" % (key, value.replace("'", "''")) for key, value in rows)
        self.sql(f"BEGIN TRANSACTION; INSERT dbo.Imported(Id,Payload) VALUES {values}; INSERT dbo.ImportHistory(ImportedRows) VALUES ({len(rows)}); UPDATE dbo.Summary SET Total={len(rows)} WHERE Id=1; COMMIT;")
        return rows

    def build_publish(self):
        source = ROOT / "database"
        inputs = []
        for item in ET.parse(source / "Synthetic.sqlproj").iter():
            if item.tag in ("Build", "PreDeploy", "PostDeploy"):
                target = (source / item.attrib["Include"]).resolve()
                assert target.is_relative_to(source.resolve()) and target.is_file()
                inputs.append({"kind": item.tag, "path": target.name, "sha256": digest(target.read_bytes())})
        project = self.output / "project"
        shutil.copytree(source, project)
        target = self.output / "dacpac"
        owned = "/tmp/stnl-check-" + self.config["runId"] + "-" + self.check_id
        # docker cp creates copied directories as root. Keep the build root owned
        # by the container's non-root user so restore can create its obj directory.
        self.command("copy-fixture", self.docker("exec", self.config["containerId"], "mkdir", "-m", "700", owned, owned + "/project"))
        self.command("copy-fixture", self.docker("cp", str(project) + "/.", self.config["containerId"] + ":" + owned + "/project"))
        # Clear remote package sources. Only the prepared owned offline cache/feed
        # is used after the container network has been disconnected.
        feed = self.config["tools"] + "/feed"
        restored = self.command("project-restore", self.tool(self.config["dotnet"],
            ["restore", owned + "/project/Synthetic.sqlproj", "--source", feed, "--ignore-failed-sources", "--nologo"]))
        built = self.command("dacpac-build", self.tool(self.config["dotnet"],
            ["build", owned + "/project/Synthetic.sqlproj", "--no-restore",
             "--configuration", "Release", "--output", owned + "/dacpac", "--nologo"]))
        self.command("copy-dacpac", self.docker("cp", self.config["containerId"] + ":" + owned + "/dacpac", str(target)))
        dacpacs = list(target.glob("*.dacpac"))
        assert len(dacpacs) == 1, "one real DACPAC required"
        dacpac = dacpacs[0]
        with zipfile.ZipFile(dacpac) as archive:
            names = {name.lower(): name for name in archive.namelist()}
            assert all(name in names for name in ("model.xml", "predeploy.sql", "postdeploy.sql"))
            assert "STNL_PRE_DEPLOY_BASELINE" in archive.read(names["predeploy.sql"]).decode("utf-8-sig")
            assert "STNL_POST_DEPLOY_BASELINE" in archive.read(names["postdeploy.sql"]).decode("utf-8-sig")
        name = self.database
        self.sql(f"IF DB_ID(N'{name}') IS NOT NULL THROW 51003, 'database already exists', 1; CREATE DATABASE [{name}];", database="master")
        # Feed a private profile through stdin. No password enters any argv,
        # native process env, observation or hash. Delete only this owned profile.
        profile_path = owned + "/credential.publish.xml"
        profile = ET.Element("Project", {"ToolsVersion": "4.0", "xmlns": "http://schemas.microsoft.com/developer/msbuild/2003"})
        properties = ET.SubElement(profile, "PropertyGroup")
        ET.SubElement(properties, "TargetConnectionString").text = "Server=" + SQL_ENDPOINT + ";Initial Catalog=" + name + ";User ID=sa;Password=" + self.secret + ";Encrypt=True;TrustServerCertificate=True"
        ET.SubElement(properties, "TargetDatabaseName").text = name
        try:
            self.command("private-profile-write", self.docker("exec", "-i", self.config["containerId"], "/bin/sh", "-c",
                'umask 077; cat > "$1"', "stnl-private-profile", profile_path), input_text=ET.tostring(profile, encoding="unicode"))
            published = self.command("dacpac-publish", self.tool(self.config["sqlpackage"],
                ["/Action:Publish", "/SourceFile:" + owned + "/dacpac/" + dacpac.name,
                 "/Profile:" + profile_path, "/p:BlockOnPossibleDataLoss=True", "/p:DropObjectsNotInSource=False"]))
        finally:
            self.command("private-profile-remove", self.docker("exec", self.config["containerId"], "rm", "-f", "--", profile_path))
        for marker in ("STNL_PRE_DEPLOY_BASELINE", "STNL_POST_DEPLOY_BASELINE"):
            assert marker in published["stdout"] + published["stderr"], "deployment marker was not observed"
        return {"projectSha256": digest((source / "Synthetic.sqlproj").read_bytes()), "inputs": inputs,
            "dacpacSha256": digest(dacpac.read_bytes()), "restoreExit": restored["exit"], "buildExit": built["exit"], "publishExit": published["exit"]}

    def check(self, name):
        before = self.state()
        data = before["dataAndSchema"]
        assert data["imported"] == [] and data["history"] == [], "fresh database was contaminated"
        assert data["summary"] == [{"Id": 1, "Total": 0}]
        assert data["deployment"] == [{"Id": 1, "Marker": "STNL_POST_DEPLOY_BASELINE"}]
        result = {"baselineState": before["sha256"]}
        if name == "schema":
            assert {x["tableName"] for x in data["columns"]} == {"Imported", "ImportHistory", "Summary", "DeploymentEvidence"}
            result["finding"] = "schema and Pre/Post deployment PASS"
        elif name == "import":
            rows = self.import_fixture()
            after = self.state()["dataAndSchema"]
            assert after["imported"] == [{"Id": key, "Payload": value} for key, value in rows]
            assert after["history"] == [{"Id": 1, "ImportedRows": len(rows)}]
            assert after["summary"] == [{"Id": 1, "Total": len(rows)}]
            result["finding"] = "real SQL insertion, history and summary PASS"
        elif name == "rebuild":
            self.sql("EXEC dbo.RebuildSynthetic;")
            assert self.state() == before, "empty rebuild changed full baseline"
            self.import_fixture()
            populated = self.state()
            rejected = self.sql("EXEC dbo.RebuildSynthetic;", expected="nonzero")
            assert "refuse rebuild: imported is not empty" in rejected["stdout"] + rejected["stderr"]
            after = self.state()
            assert after == populated, "nonempty rebuild changed full data/schema/identity state"
            result.update({"finding": "rebuild refusal with exact data preservation PASS",
                           "beforeRefusal": populated["sha256"], "afterRefusal": after["sha256"],
                           "rejectionExit": rejected["exit"]})
        else:
            raise AssertionError("unknown fixed synthetic check")
        result["finalState"] = self.state()["sha256"]
        return result

    def versions(self):
        engine = parse_sql_json(self.sql("SELECT CONVERT(nvarchar(100),SERVERPROPERTY('ProductVersion')) AS productVersion,CONVERT(nvarchar(100),SERVERPROPERTY('Edition')) AS edition FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;")["stdout"])
        assert "Developer" in engine["edition"]
        assert engine["productVersion"].startswith("16.")
        return {"python": sys.version.split()[0], "image": IMAGE, "sqlserver": engine,
            "dotnet": self.command("version", self.tool(self.config["dotnet"], ["--version"]))["stdout"].strip(),
            "sqlpackage": self.command("version", self.tool(self.config["sqlpackage"], ["/Version"]))["stdout"].strip(),
            "sqlcmd": self.command("version", self.docker("exec", self.config["containerId"],
                "/opt/mssql-tools18/bin/sqlcmd", "-?"))["stdout"].splitlines()[:2]}


def invoke(name):
    secret = ""
    try:
        assert name in CHECKS
        config = config_from_env(os.environ)
        evidence, secret = read_credential(os.environ["STNL_SQLSERVER_NATIVE_EVIDENCE"],
                                          os.environ["STNL_SQLSERVER_NATIVE_CREDENTIAL_FILE"])
        ledger = evidence / "commands.jsonl"
        assert ledger.is_file() and not ledger.is_symlink(), "pre-created private command ledger required"
        output = evidence / uuid.uuid4().hex
        output.mkdir(mode=0o700)
        adapter = Adapter(config, output, ledger, secret)
        started = time.monotonic()
        adapter.record({"type": "check-start", "checkId": adapter.check_id, "check": name, "database": adapter.database})
        adapter.authorize_container()
        build = adapter.build_publish()
        checks = adapter.check(name)
        versions = adapter.versions()
        result = {"format": "stnl-native-sqlserver-check-v1", "check": name, "checkId": adapter.check_id,
            "database": adapter.database, "status": "passed", "checks": checks, "build": build,
            "versions": versions, "physicalProcesses": adapter.counts, "durationMs": round((time.monotonic()-started)*1000, 3),
            "automaticReuseAllowed": False, "crossPhaseReuse": False}
        adapter.record({"type": "check-complete", **result})
        public = canonical(result) + "\n"
        assert secret not in public
        (output / "observation.json").write_text(public)
        print(public, end="")
        return 0
    except Exception as error:
        # No traceback/argv/env may leak through the native stdout/stderr carrier.
        print("SQL_SERVER_GATE_FAILED " + type(error).__name__ + ": " + sanitize_text(error, secret), file=sys.stderr)
        return 1
