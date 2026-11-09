"""Offline mocks only. These checks never certify SQL Server execution."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import os
import sys
import unittest
import xml.etree.ElementTree as ET
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("adapter", Path(__file__).with_name("adapter.py"))
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
SECRET = "Stnl!" + "a" * 48


def env(route="local-docker"):
    return {"STNL_SQLSERVER_NATIVE": "1", "STNL_SQLSERVER_EULA_ACCEPTED": "yes",
        "STNL_SQLSERVER_ROUTE": route, "STNL_SQLSERVER_RUN_ID": "123",
        "STNL_SQLSERVER_CONTAINER": "stnl-synthetic-offline", "STNL_SQLSERVER_CONTAINER_ID": "a" * 64,
        "STNL_SQLSERVER_DOCKER_CONTEXT": "default", "STNL_SQLSERVER_NATIVE_CREDENTIAL_FILE": "/private/credential-support"}


class OfflineContract(unittest.TestCase):
    def test_explicit_preflight_rejects_without_subprocess(self):
        with patch.object(subprocess, "run", side_effect=AssertionError("must not execute")) as execute:
            for key in env():
                value = env()
                value.pop(key)
                with self.assertRaises(RuntimeError):
                    a.config_from_env(value)
            execute.assert_not_called()

    def test_route_and_repository_fail_closed(self):
        for value in ("other", ""):
            with self.assertRaises(RuntimeError):
                a.config_from_env({**env(), "STNL_SQLSERVER_ROUTE": value})
        with self.assertRaises(RuntimeError):
            a.config_from_env(env("github-actions"))
        configured = {**env("github-actions"), "GITHUB_ACTIONS": "true", "RUNNER_ARCH": "X64",
            "GITHUB_RUN_ID": "123", "GITHUB_REPOSITORY": "stnl-studios/sentinel-workflows"}
        self.assertEqual(a.config_from_env(configured)["runId"], "123")
        with self.assertRaises(RuntimeError):
            a.config_from_env({**configured, "GITHUB_REPOSITORY": "unapproved/repository"})

    def test_redaction_precedes_public_bytes(self):
        arg = "/TargetConnectionString:Server=localhost;Password=" + SECRET + ";User ID=sa"
        public = a.public_argument(arg, SECRET)
        self.assertNotIn("Password", public)
        self.assertNotIn(SECRET, public)
        self.assertEqual(a.parse_sql_json('{"a":\r\n[1,2]}'), {"a": [1, 2]})
        self.assertNotIn(SECRET, a.sanitize_text("Error: " + arg, SECRET))
        self.assertNotIn("Password=", a.sanitize_text("Password=" + SECRET, SECRET))

    def adapter(self, root, route="local-docker"):
        root = Path(root)
        ledger = root / "commands.jsonl"
        ledger.touch()
        return a.Adapter(a.config_from_env(env(route)), root, ledger, SECRET)

    def test_endpoint_and_startup_overrides_fail_before_subprocess(self):
        with patch.object(subprocess, "run", side_effect=AssertionError("must not execute")) as execute:
            for key in ("SQLCMDSERVER", "SQLCMDINI", "STNL_SQLSERVER_ENDPOINT",
                        "STNL_SQLSERVER_HOST", "STNL_SQLSERVER_PORT", "STNL_SQLSERVER_CONNECTION_STRING"):
                for endpoint in ("tcp:203.0.113.7,1433", "localhost", "tcp:127.0.0.1,1444", "tcp:127.0.0.1,1433"):
                    with self.subTest(key=key, endpoint=endpoint), self.assertRaisesRegex(RuntimeError, "overrides"):
                        a.config_from_env({**env(), key: endpoint})
            execute.assert_not_called()

    def test_sqlcmd_uses_fixed_ipv4_loopback_without_credential_argv(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = self.adapter(root)
            with patch.object(subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")) as execute:
                adapter.sql("SELECT 1", database="master")
            args, options = execute.call_args
            argv = args[0]
            self.assertEqual(argv[argv.index("-S") + 1], "tcp:127.0.0.1,1433")
            self.assertEqual(argv[argv.index("-l") + 1], "15")
            self.assertEqual(argv[argv.index("-t") + 1], "60")
            self.assertEqual(options["timeout"], 70)
            self.assertEqual(options["env"]["SQLCMDPASSWORD"], SECRET)
            self.assertNotIn(SECRET, json.dumps(argv))
            self.assertNotIn(SECRET, adapter.ledger.read_text())

    def test_private_publish_profile_uses_same_fixed_loopback_and_stays_private(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = self.adapter(root)
            calls = []
            def execute(argv, **options):
                calls.append((argv, options))
                if argv[3] == "cp" and argv[-1] == str(Path(root) / "dacpac"):
                    target = Path(root) / "dacpac"
                    target.mkdir()
                    with zipfile.ZipFile(target / "Synthetic.dacpac", "w") as archive:
                        archive.writestr("model.xml", "<Model/>")
                        archive.writestr("predeploy.sql", "STNL_PRE_DEPLOY_BASELINE")
                        archive.writestr("postdeploy.sql", "STNL_POST_DEPLOY_BASELINE")
                return subprocess.CompletedProcess(argv, 0, "STNL_PRE_DEPLOY_BASELINE STNL_POST_DEPLOY_BASELINE", "")
            with patch.object(subprocess, "run", side_effect=execute):
                adapter.build_publish()
            profiles = [options["input"] for argv, options in calls if "stnl-private-profile" in argv]
            self.assertEqual(len(profiles), 1)
            ns = {"m": "http://schemas.microsoft.com/developer/msbuild/2003"}
            connection = ET.fromstring(profiles[0]).find("m:PropertyGroup/m:TargetConnectionString", ns).text
            self.assertEqual(connection, "Server=tcp:127.0.0.1,1433;Initial Catalog=" + adapter.database +
                ";User ID=sa;Password=" + SECRET + ";Encrypt=True;TrustServerCertificate=True")
            publications = [argv for argv, _ in calls if "/Action:Publish" in argv]
            self.assertEqual(len(publications), 1)
            self.assertTrue(any(arg.startswith("/Profile:") for arg in publications[0]))
            self.assertFalse(any(arg.startswith("/Target") for arg in publications[0]))
            self.assertEqual(calls[-1][0][-4:-1], ["rm", "-f", "--"])
            for argv, _ in calls:
                self.assertNotIn(SECRET, json.dumps(argv))
            public = adapter.ledger.read_text()
            self.assertNotIn(SECRET, public)
            self.assertNotIn("credential.publish.xml", public)
            self.assertNotIn(connection, public)

    def test_real_subprocess_result_is_redacted_before_record(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = self.adapter(root)
            fake = subprocess.CompletedProcess([], 0, "stdout " + SECRET, "Password=" + SECRET)
            with patch.object(subprocess, "run", return_value=fake) as execute:
                result = adapter.command("offline-mock", ["/official/tool", "/TargetConnectionString:Password=" + SECRET])
            self.assertEqual(execute.call_count, 1)
            self.assertNotIn(SECRET, json.dumps(result))
            self.assertNotIn(SECRET, adapter.ledger.read_text())
            self.assertEqual(adapter.counts, {"offline-mock": 1})

    def test_timeout_never_renders_secret_argv(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = self.adapter(root)
            with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired(["tool", SECRET], 1)):
                with self.assertRaisesRegex(RuntimeError, "TimeoutExpired"):
                    adapter.command("offline-timeout", ["tool", SECRET])
            self.assertNotIn(SECRET, adapter.ledger.read_text())

    def test_owned_disconnected_native_or_explicit_emulated_container(self):
        cases = [
            ("local-docker", "amd64", {}, {}, True),
            ("local-docker", "arm64", {}, {}, False),
            ("local-docker-emulated", "arm64", {}, {}, True),
            ("local-docker-emulated", "amd64", {}, {}, False),
            ("local-docker", "amd64", {"1433/tcp": [{"HostIp": "0.0.0.0", "HostPort": "1433"}]}, {}, False),
            ("local-docker", "amd64", {}, {"bridge": {}}, False),
        ]
        for route, arch, ports, networks, allowed in cases:
            with self.subTest(route=route, arch=arch, ports=ports, networks=networks), tempfile.TemporaryDirectory() as root:
                adapter = self.adapter(root, route)
                outputs = iter(["unix:///owned/docker.sock", "a" * 64, arch, "123", a.IMAGE, "[]", str(4*1024**3), "2000000000", json.dumps(ports), '"bridge"', json.dumps(networks)])
                with patch.object(adapter, "command", side_effect=lambda *args, **kw: {"stdout": next(outputs)}):
                    if allowed:
                        adapter.authorize_container()
                    else:
                        with self.assertRaises(RuntimeError):
                            adapter.authorize_container()

    def test_wrong_owner_is_never_mutated(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = self.adapter(root)
            outputs = iter(["unix:///owned/docker.sock", "a" * 64, "amd64", "another-run"])
            with patch.object(adapter, "command", side_effect=lambda *args, **kw: {"stdout": next(outputs)}) as command:
                with self.assertRaisesRegex(RuntimeError, "not owned"):
                    adapter.authorize_container()
                self.assertEqual(command.call_count, 4)

    def test_tools_do_not_pass_credential_value_in_host_argv(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = self.adapter(root)
            command = adapter.tool("/official/dotnet", ["--version"])
            self.assertNotIn(SECRET, json.dumps(command))
            self.assertNotIn("SQLCMDPASSWORD", command)
            self.assertIn("a" * 64, command)
            self.assertNotIn("stnl-synthetic-offline", command)
            self.assertIn("NUGET_PACKAGES=/tmp/stnl-tools-123/packages", command)

    def test_replaced_mounts_uncapped_remote_and_credentials_are_rejected(self):
        standard = ["unix:///owned/docker.sock", "a" * 64, "amd64", "123", a.IMAGE, "[]", str(4*1024**3), "2000000000", "{}", '"bridge"', "{}"]
        for index, bad in [(0,"tcp://remote:2375"),(1,"b"*64),(5,'[{"Source":"/work"}]'),(6,"0"),(6,str(5*1024**3)),(7,"0"),(7,"3000000000")]:
            with self.subTest(index=index,bad=bad), tempfile.TemporaryDirectory() as root:
                adapter = self.adapter(root)
                values = list(standard); values[index] = bad; outputs = iter(values)
                with patch.object(adapter,"command",side_effect=lambda *args,**kw:{"stdout":next(outputs)}):
                    with self.assertRaises(RuntimeError): adapter.authorize_container()
        for extra in ({"SQLCMDPASSWORD":SECRET},{"MSSQL_SA_PASSWORD":SECRET},{"DOCKER_HOST":"tcp://remote"}):
            with self.assertRaises(RuntimeError): a.config_from_env({**env(),**extra})

    def test_optimized_python_refuses_before_docker(self):
        wrapper = str(Path(__file__).with_name("check_schema.py"))
        for args, environment in [([sys.executable,"-B","-O",wrapper],{}),([sys.executable,"-B",wrapper],{"PYTHONOPTIMIZE":"1"})]:
            result = subprocess.run(args,env=environment,capture_output=True,text=True)
            self.assertEqual(result.returncode,2)
            self.assertIn("Python optimization disables required verification",result.stderr)
            self.assertNotIn("passed",result.stdout)

    def test_shared_or_host_network_is_rejected_even_with_empty_networks(self):
        for mode, allowed in [("bridge",True),("none",True),("host",False),("container:"+"b"*64,False),("default",False),("other",False)]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as root:
                adapter = self.adapter(root)
                outputs = iter(["unix:///owned/docker.sock","a"*64,"amd64","123",a.IMAGE,"[]",str(4*1024**3),"2000000000","{}",json.dumps(mode),"{}"])
                with patch.object(adapter,"command",side_effect=lambda *args,**kw:{"stdout":next(outputs)}):
                    if allowed: adapter.authorize_container()
                    else:
                        with self.assertRaisesRegex(RuntimeError,"network modes"): adapter.authorize_container()

    def test_unsafe_or_encoded_credentials_reject_before_log_hash_or_subprocess(self):
        invalid = ["a"*40, "Stnl!"+"a"*47+"&", "Stnl!"+"a"*47+";", "Stnl!"+"a"*47+"<", "Stnl!"+"a"*47+'"', SECRET+"&amp;", SECRET+"\n", SECRET.upper()]
        with tempfile.TemporaryDirectory() as root, patch.object(subprocess,"run",side_effect=AssertionError("must not execute")) as execute:
            ledger = Path(root)/"commands.jsonl";ledger.touch()
            for value in invalid:
                with self.subTest(value=value), self.assertRaisesRegex(RuntimeError,"safe generated format"):
                    a.Adapter(a.config_from_env(env()),Path(root),ledger,value)
                self.assertEqual(ledger.read_text(),"")
            execute.assert_not_called()
        self.assertEqual(a.require_credential(SECRET),SECRET)

    def test_parent_alias_is_canonical_but_credential_symlink_is_never_followed(self):
        with tempfile.TemporaryDirectory() as root:
            base=Path(root).resolve();physical=base/"physical";physical.mkdir(mode=0o700)
            alias=base/"alias";alias.symlink_to(physical,target_is_directory=True)
            private=physical/"credential-support";private.write_text(SECRET);private.chmod(0o600)
            evidence,secret=a.read_credential(alias,alias/"credential-support")
            self.assertEqual(evidence,physical);self.assertEqual(secret,SECRET)
            private.rename(physical/"saved-private")
            private.symlink_to(physical/"saved-private")
            with self.assertRaises(OSError): a.read_credential(alias,alias/"credential-support")

    def test_project_root_is_created_by_container_user_before_copying_contents(self):
        class StopBeforeRestore(Exception): pass
        with tempfile.TemporaryDirectory() as root:
            adapter=self.adapter(root);calls=[]
            def command(kind,args,**kwargs):
                calls.append((kind,args))
                if kind=="project-restore": raise StopBeforeRestore()
                return {"exit":0,"stdout":"","stderr":""}
            with patch.object(adapter,"command",side_effect=command),self.assertRaises(StopBeforeRestore):
                adapter.build_publish()
            self.assertEqual([kind for kind,_ in calls],["copy-fixture","copy-fixture","project-restore"])
            mkdir=calls[0][1];copy=calls[1][1]
            self.assertEqual(mkdir[3:8],["exec","a"*64,"mkdir","-m","700"])
            self.assertEqual(mkdir[-1],mkdir[-2]+"/project")
            self.assertEqual(copy[3],"cp")
            self.assertTrue(copy[-2].endswith("/project/."))
            self.assertEqual(copy[-1],"a"*64+":"+mkdir[-1])


if __name__ == "__main__":
    unittest.main()
