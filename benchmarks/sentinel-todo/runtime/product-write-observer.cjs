// Bounded oracle instrumentation for the Todo CLI subprocess, not a host sandbox
// or a Sentinel skill hook. Only the externally supplied storage root is observed.
'use strict';
const fs = require('node:fs');
const promises = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const child = require('node:child_process');
const workers = require('node:worker_threads');
const root = fs.realpathSync(process.env.STNL_PRODUCT_OBSERVER_ROOT);
const trace = process.env.STNL_PRODUCT_OBSERVER_FILE;
const output = fs.openSync(trace, 'wx', 0o600);
const rawWrite = fs.writeSync.bind(fs);
const descriptors = new Map();
const storageInodes = new Set();
function indexStorage(directory) {
  for (const name of fs.readdirSync(directory)) {
    const file = path.join(directory, name);
    const metadata = fs.lstatSync(file);
    if (metadata.isDirectory()) indexStorage(file);
    else if (metadata.isFile()) storageInodes.add(`${metadata.dev}:${metadata.ino}`);
  }
}
indexStorage(root);
let events = 0;
function record(value) {
  if (++events <= 1024) rawWrite(output, `${JSON.stringify(value)}\n`);
}
function lexical(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  return typeof value === 'string' ? path.resolve(value) : null;
}
function resolve(value) {
  const absolute = lexical(value);
  if (absolute === null) return null;
  let existing = absolute;
  while (true) {
    try { return path.join(fs.realpathSync(existing), path.relative(existing, absolute)); }
    catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return absolute;
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      existing = parent;
    }
  }
}
function observe(method, values) {
  for (const value of values) {
    const original = typeof value === 'number' ? descriptors.get(value) : value;
    const logical = lexical(original);
    const target = resolve(original);
    let sharedInode = false;
    if (target) try {
      const stat = typeof value === 'number' ? fs.fstatSync(value) : fs.statSync(target);
      sharedInode = storageInodes.has(`${stat.dev}:${stat.ino}`);
    } catch {}
    if (target && (logical === root || logical?.startsWith(`${root}${path.sep}`)
      || target === root || target.startsWith(`${root}${path.sep}`) || sharedInode)) {
      record({ type: 'write-attempt', method, path: target });
      return;
    }
  }
}
const writes = ['writeFile', 'appendFile', 'truncate', 'unlink', 'rm', 'rmdir', 'mkdir', 'mkdtemp', 'chmod', 'lchmod', 'chown', 'lchown', 'utimes', 'lutimes'];
const destinations = { rename: [0, 1], copyFile: [1], cp: [1], link: [0, 1], symlink: [1] };
for (const object of [fs, promises]) {
  for (const name of [...writes, ...Object.keys(destinations)]) {
    for (const method of object === fs ? [name, `${name}Sync`] : [name]) {
      const original = object[method];
      if (typeof original !== 'function') continue;
      object[method] = function (...args) {
        observe(method, (destinations[name] ?? [0]).map(index => args[index]));
        return Reflect.apply(original, this, args);
      };
    }
  }
}
const writeFlags = flags => typeof flags === 'string' ? /[wa+]/u.test(flags)
  : typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
const openSync = fs.openSync;
fs.openSync = function (file, flags, ...args) {
  const openedPath = lexical(file);
  if (writeFlags(flags)) observe('openSync', [openedPath]);
  const fd = Reflect.apply(openSync, this, [openedPath ?? file, flags, ...args]);
  descriptors.set(fd, openedPath); return fd;
};
const open = fs.open;
fs.open = function (file, flags, ...args) {
  const openedPath = lexical(file);
  if (writeFlags(flags)) observe('open', [openedPath]);
  const callback = args.pop();
  return Reflect.apply(open, this, [openedPath ?? file, flags, ...args, (error, fd) => {
    if (!error) descriptors.set(fd, openedPath);
    callback(error, fd);
  }]);
};
const closeSync = fs.closeSync;
fs.closeSync = function (fd) {
  const result = Reflect.apply(closeSync, this, [fd]);
  descriptors.delete(fd); return result;
};
const close = fs.close;
fs.close = function (fd, callback) {
  return Reflect.apply(close, this, [fd, error => {
    if (!error) descriptors.delete(fd);
    callback(error);
  }]);
};
const openPromise = promises.open;
promises.open = async function (file, flags, ...args) {
  const openedPath = lexical(file);
  if (writeFlags(flags)) observe('promises.open', [openedPath]);
  const handle = await Reflect.apply(openPromise, this, [openedPath ?? file, flags, ...args]);
  descriptors.set(handle.fd, openedPath);
  const descriptor = handle.fd;
  const closeHandle = handle.close;
  handle.close = async function (...values) {
    const result = await Reflect.apply(closeHandle, this, values);
    descriptors.delete(descriptor); return result;
  };
  for (const name of ['write', 'writev', 'writeFile', 'appendFile', 'truncate', 'chmod', 'chown', 'utimes', 'createWriteStream']) {
    const original = handle[name];
    if (typeof original !== 'function') continue;
    handle[name] = function (...values) { observe(`FileHandle.${name}`, [openedPath, descriptor]); return Reflect.apply(original, this, values); };
  }
  return handle;
};
for (const name of ['write', 'writev', 'ftruncate', 'fchmod', 'fchown', 'futimes']) {
  for (const method of [name, `${name}Sync`]) {
    const original = fs[method];
    if (typeof original !== 'function') continue;
    fs[method] = function (...args) { observe(method, [args[0]]); return Reflect.apply(original, this, args); };
  }
}
const stream = fs.createWriteStream;
fs.createWriteStream = function (file, options) {
  observe('createWriteStream', [file, options?.fd]);
  return Reflect.apply(stream, this, [file, options]);
};
// Unobserved subprocess/native writes cannot justify read-only evidence. Refuse
// these escape surfaces in this bounded check, even if the candidate catches it.
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  child[name] = () => {
    record({ type: 'unobserved-capability', method: name });
    throw new Error('product observer cannot observe subprocess effects');
  };
}
process.dlopen = () => {
  record({ type: 'unobserved-capability', method: 'dlopen' });
  throw new Error('product observer cannot observe native addon effects');
};
workers.Worker = new Proxy(workers.Worker, { construct() {
  record({ type: 'unobserved-capability', method: 'Worker' });
  throw new Error('product observer cannot observe worker effects');
} });
syncBuiltinESMExports();
record({ type: 'ready', contract: 'sentinel-product-write-observer-v1', root });
process.on('exit', () => record({ type: 'complete', overflow: events >= 1024 }));
