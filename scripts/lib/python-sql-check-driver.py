"""Observe real Python/SQLite checks. Audit instrumentation is NOT a hostile-code sandbox.

This driver emits historical observations, never certificates of determinism.
Only synthetic fixture scripts are supported. All SQL databases are fresh memory
connections. Live/file database state, extensions, network and subprocesses fail
closed. Temporal imports disable even proposal of a historical reference.
"""
import sys, os, json, pathlib, hashlib, traceback, builtins, sqlite3, time, importlib.util, ast
root = pathlib.Path(sys.argv[1]).resolve()
script = sys.argv[2]
request_id = sys.argv[3]
stdlib = pathlib.Path(os.__file__).resolve().parent
driver_file = pathlib.Path(__file__).resolve()
sys.dont_write_bytecode = True
# The local import namespace is fixed, not a scan of the whole editable folder.
# Unrelated verifier files cannot shadow stdlib or become implicit dependencies.
class LocalHelperFinder:
    def find_spec(self, fullname, path=None, target=None):
        if fullname in ('db_local', 'gc_local'):
            return importlib.util.spec_from_file_location(fullname, root / 'checks' / (fullname + '.py'))
sys.meta_path.insert(0, LocalHelperFinder())
reads, listings, runtime_reads, runtime_listings, ambient, databases, denied = {}, {}, {}, {}, set(), [], []
absent_reads, runtime_absent_reads = set(), set()
inside = False
creating_owned_connection = False
class UnsupportedCapability(RuntimeError):
    pass

def digest(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()

def guard(message):
    denied.append(message)
    raise UnsupportedCapability(message)

def local_path(value):
    if isinstance(value, int):
        return None
    return pathlib.Path(os.fsdecode(value)).absolute()

def capture_file(target):
    actual = target.resolve()
    if not actual.is_relative_to(root) and not actual.is_relative_to(stdlib) and actual != driver_file:
        guard('read outside synthetic fixture/runtime: ' + str(actual))
    if not actual.exists():
        if actual.is_relative_to(root):
            absent_reads.add(actual.relative_to(root).as_posix())
        else:
            runtime_absent_reads.add(str(actual))
        return
    if not actual.is_file():
        guard('nonregular read is not a closed input: ' + str(actual))
    if actual.is_relative_to(root):
        rel = actual.relative_to(root).as_posix()
        if target.is_symlink():
            guard('fixture symlink: ' + rel)
        reads[rel] = {'path': rel, 'sha256': digest(actual.read_bytes()), 'mode': actual.stat().st_mode & 0o777}
    else:
        runtime_reads[str(actual)] = {'path': str(actual), 'sha256': digest(actual.read_bytes()), 'mode': actual.stat().st_mode & 0o777}

def audit(event, args):
    global inside
    if inside:
        return
    inside = True
    try:
        if event == 'open':
            target = local_path(args[0])
            if target is None:
                guard('untracked file descriptor access')
            mode, flags = args[1], args[2]
            if isinstance(mode, str) and any(char in mode for char in 'wax+') or isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND):
                guard('check attempted filesystem write')
            capture_file(target)
        elif event in ('os.listdir', 'os.scandir'):
            target = local_path(args[0] if args else '.')
            if target is None:
                guard('untracked directory descriptor')
            if target.resolve().is_relative_to(root):
                rel = target.resolve().relative_to(root).as_posix()
                listings[rel] = sorted(os.listdir(target))
            elif target.resolve().is_relative_to(stdlib):
                runtime_listings[str(target.resolve())] = sorted(os.listdir(target))
            else:
                guard('directory scan outside synthetic fixture/runtime')
        elif event == 'sqlite3.connect':
            # This event is present on Python 3.9; /handle was added in 3.10.
            if not creating_owned_connection:
                guard('unowned SQLite constructor is unsupported')
            # CPython 3.9 may report the fixed constructor argument as bytes.
            # Accept only the two exact built-in representations, never decode
            # paths/URIs or trust an arbitrary object's equality implementation.
            identity = args[0]
            if not (type(identity) is str and identity == ':memory:' or
                    type(identity) is bytes and identity == b':memory:'):
                guard('live/file database has no closed state identity')
            databases.append({'kind': 'sqlite-memory', 'initialState': 'empty', 'ordinal': len(databases) + 1})
        elif event == 'sqlite3.connect/handle':
            if not creating_owned_connection:
                guard('unowned SQLite constructor is unsupported')
        elif event.startswith(('socket.', 'subprocess.', 'ctypes.')) or event in ('os.system', 'os.exec', 'os.posix_spawn', 'os.fork', 'os.forkpty', 'sqlite3.load_extension', 'sqlite3.enable_load_extension'):
            guard('unsupported external capability: ' + event)
        elif event.startswith(('os.remove', 'os.rename', 'os.rmdir', 'os.mkdir', 'os.link', 'os.symlink', 'os.chmod', 'os.chown', 'os.truncate', 'os.utime', 'os.setxattr', 'os.removexattr')):
            guard('check attempted filesystem mutation: ' + event)
    finally:
        inside = False

original_import = builtins.__import__
def observed_import(name, *args, **kwargs):
    if name.split('.')[0] in ('time', 'datetime', '_datetime', 'random', 'secrets', 'threading', 'multiprocessing', 'asyncio'):
        ambient.add(name.split('.')[0])
    if name.split('.')[0] in ('ctypes', '_ctypes', 'subprocess', 'socket', '_socket', 'resource', 'mmap'):
        guard('unsupported imported capability: ' + name)
    return original_import(name, *args, **kwargs)

original_connect = sqlite3.connect
class OwnedMemoryConnection(sqlite3.Connection):
    def enable_load_extension(self, enabled):
        guard('SQLite extension loading is unsupported')
    def load_extension(self, extension):
        guard('SQLite extension loading is unsupported')
    def set_authorizer(self, callback):
        guard('check cannot replace the campaign SQL authorizer')
def checked_connect(*args, **kwargs):
    global creating_owned_connection
    if args != (':memory:',) or kwargs:
        guard('only the fixed fresh memory connection profile is supported')
    creating_owned_connection = True
    try:
        connection = original_connect(':memory:', factory=OwnedMemoryConnection)
    finally:
        creating_owned_connection = False
    def authorize(action, arg1, arg2, database, trigger):
        if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH):
            denied.append('SQL ATTACH/DETACH is not a closed memory database')
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_FUNCTION and (arg2 or arg1 or '').lower() in ('random', 'randomblob', 'current_timestamp', 'current_date', 'current_time', 'datetime', 'date', 'time', 'julianday', 'unixepoch', 'strftime'):
            ambient.add('sqlite-temporal-or-random-function')
        if action == sqlite3.SQLITE_FUNCTION and (arg2 or arg1 or '').lower() == 'load_extension':
            denied.append('SQL extension loading is unsupported')
            return sqlite3.SQLITE_DENY
        return sqlite3.SQLITE_OK
    sqlite3.Connection.set_authorizer(connection, authorize)
    return connection
sqlite3.connect = checked_connect
builtins.__import__ = observed_import
sys.addaudithook(audit)
status, exit_code, diagnostic = 'passed', 0, None
try:
    capture_file(root / script)
    sys.argv = [str(root / script)]
    namespace = {'__name__': '__main__', '__file__': str(root / script), '__builtins__': builtins}
    exec(compile((root / script).read_bytes(), str(root / script), 'exec'), namespace)
except UnsupportedCapability as error:
    status, exit_code, diagnostic = 'unsupported', 2, str(error)
except AssertionError as error:
    status, exit_code, diagnostic = 'functional-failure', 1, str(error)
    traceback.print_exc()
except SystemExit as error:
    exit_code = error.code if isinstance(error.code, int) else (0 if error.code is None else 1)
    status = 'passed' if exit_code == 0 else 'functional-failure'
except (OSError, ImportError) as error:
    status, exit_code, diagnostic = 'infrastructure-error', 3, str(error)
except Exception as error:
    status, exit_code, diagnostic = 'functional-failure', 1, str(error)
    traceback.print_exc()
if denied:
    status, exit_code = 'unsupported', 2
    diagnostic = '; '.join(sorted(set(denied)))
# Fingerprint loaded native/runtime modules as well as observed runtime reads.
inside = True
for module in list(sys.modules.values()):
    filename = getattr(module, '__file__', None)
    if filename and pathlib.Path(filename).resolve().is_relative_to(stdlib):
        capture_file(pathlib.Path(filename))
inside = False
# Known audit blind spots are surfaced conservatively. This scan is a warning
# detector, not a proof that arbitrary Python has no other dependencies.
unclosed_inputs = []
metadata_names = {'exists', 'is_file', 'is_dir', 'stat', 'lstat', 'access', 'getmtime', 'getctime', 'getsize', 'getpid', 'getppid', 'getenv'}
dynamic_names = {'eval', 'exec', 'getattr', 'setattr', 'globals', 'locals', 'vars'}
inside = True
for name in list(reads):
    if not name.endswith('.py'):
        continue
    try:
        syntax = ast.parse((root / name).read_bytes())
        for node in ast.walk(syntax):
            if isinstance(node, ast.Call) and (isinstance(node.func, ast.Attribute) and node.func.attr in metadata_names or isinstance(node.func, ast.Name) and node.func.id in dynamic_names):
                unclosed_inputs.append(name + ': unobserved metadata or dynamic capability')
                break
    except (SyntaxError, OSError):
        unclosed_inputs.append(name + ': dependency scan unavailable')
inside = False
report = {'format': 'stnl-python-sql-observation-v1', 'requestId': request_id,
    'status': status, 'exit': exit_code, 'diagnostic': diagnostic,
    'reads': sorted(reads.values(), key=lambda item: item['path']),
    'absentReads': sorted(absent_reads), 'runtimeAbsentReads': sorted(runtime_absent_reads),
    'listings': [{'path': key, 'children': value} for key, value in sorted(listings.items())],
    'ambientInputs': sorted(ambient), 'unclosedInputs': sorted(set(unclosed_inputs)), 'databases': databases,
    'runtimeReads': sorted(runtime_reads.values(), key=lambda item: item['path']),
    'runtimeListings': [{'path': key, 'children': value} for key, value in sorted(runtime_listings.items())],
    'dependencyAssurance': 'observed-python-audit-events-not-hostile-sandbox',
    'determinism': 'not-certified', 'sqliteVersion': sqlite3.sqlite_version}
os.write(3, (json.dumps(report, sort_keys=True) + '\n').encode())
sys.exit(exit_code)
