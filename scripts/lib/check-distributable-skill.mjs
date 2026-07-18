import { isBuiltin } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const FORBIDDEN_EXECUTABLE_EXTENSIONS = new Set([
  ".js", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx",
  ".py", ".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd",
  ".exe", ".dll", ".dylib", ".so", ".wasm", ".node",
]);
const PACKAGE_MANIFESTS = new Set(["package.json"]);
const DEPENDENCY_LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
]);
const DYNAMIC_CODE_PROPERTY_NAMES = new Set([
  "eval",
  "Function",
  "AsyncFunction",
  "GeneratorFunction",
  "AsyncGeneratorFunction",
  "getBuiltinModule",
  "compileFunction",
  "SourceTextModule",
  "SyntheticModule",
  "runInThisContext",
  "runInNewContext",
  "runInContext",
  "dlopen",
  "_load",
]);
const DYNAMIC_CODE_IDENTIFIER_PATTERN = new RegExp(
  `\\b(?:${[...DYNAMIC_CODE_PROPERTY_NAMES].join("|")})\\b`,
  "u",
);
const DYNAMIC_CODE_MODULES = new Set(["vm", "node:vm"]);

export const LIFECYCLE_DISTRIBUTION_POLICY = Object.freeze({
  allowedRuntimeExtensions: [".mjs"],
  requiredEntrypoints: [
    "validate-spec-lifecycle.mjs",
    "create-readiness-attestation.mjs",
    "build-closed-spec.mjs",
    "publish-spec-lifecycle.mjs",
  ],
  forbiddenOperationalPatterns: [
    [/(?:^|[^A-Za-z])python3?(?:[^A-Za-z]|$)/iu, "Python runtime reference"],
    [/\.py(?:\b|$)/iu, "Python script reference"],
    [/validate_spec_lifecycle\.py/iu, "legacy validator path"],
    [/create_readiness_attestation\.py/iu, "legacy attestation path"],
    [/build_closed_spec\.py/iu, "legacy renderer path"],
    [/publish_spec_lifecycle\.py/iu, "legacy publisher path"],
    [/(?:\.\.\/){2,}scripts(?:\/|\b)/u, "repository-relative scripts dependency"],
    [/(?:^|\s)npm\s+install(?:\s|$)/iu, "package installation instruction"],
    [
      /(?:^|[\s"'`(])\/(?:Users|home|root|workspace|workspaces|work|repo|repos|opt|srv|mnt|private|tmp|var)(?:\/|$)/iu,
      "host-specific absolute path",
    ],
    [
      /(?:^|[\s"'`(=:\[])\/(?!\/)(?:[A-Za-z0-9._~-]+\/){2,}[A-Za-z0-9._~-]+(?:[/?#][^\s"'`<>)]*)?/mu,
      "host-specific absolute path",
    ],
    [/(?:^|[\s"'`(])[A-Za-z]:[\\/][^\s"'`<>]*/u, "host-specific absolute path"],
    [/(?:^|[\s"'`(])\\\\[^\\\s"'`<>]+\\[^\s"'`<>]*/u, "host-specific absolute path"],
    [/(?:^|[\s"'`(])\/\/[^/\s"'`<>]+\/[^/\s"'`<>]+(?:\/[^\s"'`<>]*)?/u, "host-specific absolute path"],
  ],
});

function normalizedRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

async function regularFiles(root, findings) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (
        entry.name === ".DS_Store" ||
        entry.name === "__MACOSX" ||
        entry.name === "Thumbs.db" ||
        entry.name.toLowerCase() === "desktop.ini" ||
        entry.name.startsWith("._")
      ) {
        findings.push(`distributed skill contains OS metadata: ${normalizedRelative(root, path)}`);
        continue;
      }
      if (entry.name === "node_modules") {
        findings.push(`distributed skill contains vendored dependencies: ${normalizedRelative(root, path)}`);
        continue;
      }
      if (entry.isSymbolicLink()) {
        findings.push(`distributed skill contains a symlink: ${normalizedRelative(root, path)}`);
      } else if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        result.push(path);
      } else {
        findings.push(`distributed skill contains a special entry: ${normalizedRelative(root, path)}`);
      }
    }
  }
  await visit(root);
  return result;
}

function maskedCharacter(character) {
  return character === "\n" || character === "\r" ? character : " ";
}

function previousWord(output, end) {
  let index = end;
  while (index >= 0 && /\s/u.test(output[index])) index -= 1;
  const wordEnd = index + 1;
  while (index >= 0 && /[A-Za-z0-9_$]/u.test(output[index])) index -= 1;
  return { before: index, word: output.slice(index + 1, wordEnd).join("") };
}

function closesControlHeader(output, close) {
  let depth = 1;
  for (let index = close - 1; index >= 0; index -= 1) {
    if (output[index] === ")") depth += 1;
    else if (output[index] === "(") {
      depth -= 1;
      if (depth !== 0) continue;
      let preceding = previousWord(output, index - 1);
      if (preceding.word === "await") preceding = previousWord(output, preceding.before - 1);
      return /^(?:for|if|while|with)$/u.test(preceding.word) &&
        !/[.\w$]/u.test(output[preceding.before] ?? "");
    }
  }
  return false;
}

function regexCanStart(output, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/u.test(output[previous])) previous -= 1;
  if (previous < 0) return true;
  if (output[previous] === ")" && closesControlHeader(output, previous)) return true;
  if (
    (output[previous] === "+" || output[previous] === "-") &&
    output[previous - 1] === output[previous]
  ) {
    return false;
  }
  if ("([{=,:;!?&|+-*%^~<>".includes(output[previous])) return true;
  if (!/[A-Za-z0-9_$]/u.test(output[previous])) return false;
  let start = previous;
  while (start > 0 && /[A-Za-z0-9_$]/u.test(output[start - 1])) start -= 1;
  return /^(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/u.test(
    output.slice(start, previous + 1).join(""),
  );
}

function analyzeJavaScript(source) {
  const input = String(source);
  // Preserve UTF-16 offsets so token positions always index the original source.
  const output = input.split("");
  const strings = [];

  function mask(index) {
    output[index] = maskedCharacter(input[index]);
  }

  function scanString(start) {
    const quote = input[start];
    let index = start;
    mask(index);
    index += 1;
    while (index < input.length) {
      if (input[index] === "\\") {
        mask(index);
        index += 1;
        if (index < input.length) {
          mask(index);
          index += 1;
        }
        continue;
      }
      const closing = input[index] === quote;
      if (closing) output[index] = "_";
      else mask(index);
      index += 1;
      if (closing) {
        strings.push({ start, end: index, value: input.slice(start + 1, index - 1), quote });
        return index;
      }
    }
    return index;
  }

  function scanLineComment(start) {
    let index = start;
    while (index < input.length && input[index] !== "\n") {
      mask(index);
      index += 1;
    }
    return index;
  }

  function scanBlockComment(start) {
    let index = start;
    mask(index);
    mask(index + 1);
    index += 2;
    while (index < input.length) {
      if (input[index] === "*" && input[index + 1] === "/") {
        mask(index);
        mask(index + 1);
        return index + 2;
      }
      mask(index);
      index += 1;
    }
    return index;
  }

  function scanRegex(start) {
    let index = start;
    let characterClass = false;
    mask(index);
    index += 1;
    while (index < input.length) {
      if (input[index] === "\\") {
        mask(index);
        index += 1;
        if (index < input.length) {
          mask(index);
          index += 1;
        }
        continue;
      }
      if (input[index] === "\n" || input[index] === "\r") return index;
      if (input[index] === "[") characterClass = true;
      if (input[index] === "]") characterClass = false;
      const closing = input[index] === "/" && !characterClass;
      if (closing) output[index] = "_";
      else mask(index);
      index += 1;
      if (closing) {
        while (/[A-Za-z]/u.test(input[index] ?? "")) {
          mask(index);
          index += 1;
        }
        return index;
      }
    }
    return index;
  }

  function scanTemplate(start) {
    let index = start;
    mask(index);
    index += 1;
    while (index < input.length) {
      if (input[index] === "\\") {
        mask(index);
        index += 1;
        if (index < input.length) {
          mask(index);
          index += 1;
        }
        continue;
      }
      if (input[index] === "`") {
        output[index] = "_";
        return index + 1;
      }
      if (input[index] === "$" && input[index + 1] === "{") {
        mask(index);
        output[index + 1] = "{";
        index = scanCode(index + 2, true);
        continue;
      }
      mask(index);
      index += 1;
    }
    return index;
  }

  function scanCode(start, stopAtTemplateBrace = false) {
    let index = start;
    let braceDepth = 0;
    while (index < input.length) {
      const character = input[index];
      const next = input[index + 1];
      if (character === "/" && next === "/") {
        index = scanLineComment(index);
        continue;
      }
      if (character === "/" && next === "*") {
        index = scanBlockComment(index);
        continue;
      }
      if (character === "/" && regexCanStart(output, index)) {
        index = scanRegex(index);
        continue;
      }
      if (character === '"' || character === "'") {
        index = scanString(index);
        continue;
      }
      if (character === "`") {
        index = scanTemplate(index);
        continue;
      }
      if (stopAtTemplateBrace && character === "}") {
        if (braceDepth === 0) {
          mask(index);
          return index + 1;
        }
        braceDepth -= 1;
        index += 1;
        continue;
      }
      if (stopAtTemplateBrace && character === "{") braceDepth += 1;
      index += 1;
    }
    return index;
  }

  scanCode(0);
  return { code: output.join(""), strings };
}

function importProjection(analysis) {
  const output = analysis.code.split("");
  for (const token of analysis.strings) {
    output[token.start] = token.quote;
    output[token.end - 1] = token.quote;
  }
  return output.join("");
}

export function importSpecifiers(source) {
  const analysis = analyzeJavaScript(source);
  const projection = importProjection(analysis);
  const result = [];
  const seen = new Set();
  const patterns = [
    /(?<![.\w$])(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'][^"']*["']/gu,
    /(?<![.\w$])(?:import|export)\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\{[^{};]*\}\s*from\s*["'][^"']*["']/gu,
    /(?<![.\w$])import\s*\(\s*["'][^"']*["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of projection.matchAll(pattern)) {
      const end = match.index + match[0].length;
      let token = null;
      for (let index = analysis.strings.length - 1; index >= 0; index -= 1) {
        const candidate = analysis.strings[index];
        if (candidate.start >= match.index && candidate.end <= end) {
          token = candidate;
          break;
        }
      }
      if (token && !seen.has(token.start)) {
        seen.add(token.start);
        result.push(token.value);
      }
    }
  }
  return result;
}

function executableCode(source) {
  return analyzeJavaScript(source).code;
}

function hasComputedDynamicCodeAccess(source) {
  const analysis = analyzeJavaScript(source);
  for (const token of analysis.strings) {
    if (!DYNAMIC_CODE_PROPERTY_NAMES.has(token.value) && token.value !== "constructor") continue;
    let before = token.start - 1;
    while (before >= 0 && /\s/u.test(analysis.code[before])) before -= 1;
    let after = token.end;
    while (/\s/u.test(analysis.code[after] ?? "")) after += 1;
    if (analysis.code[before] === "[" && analysis.code[after] === "]") return true;
  }
  return false;
}

function literalDynamicImportEndsAtCallClose(analysis, start) {
  const token = analysis.strings.find((candidate) => candidate.start === start);
  if (!token) return false;
  let index = token.end;
  while (/\s/u.test(analysis.code[index] ?? "")) index += 1;
  return analysis.code[index] === ")";
}

export function nonliteralDynamicImportCount(source) {
  const input = String(source);
  const analysis = analyzeJavaScript(input);
  let count = 0;
  for (const match of analysis.code.matchAll(/(?<![.\w$])import\s*\(/gu)) {
    const open = match.index + match[0].lastIndexOf("(");
    let argument = open + 1;
    while (
      !analysis.strings.some((candidate) => candidate.start === argument) &&
      /\s/u.test(analysis.code[argument] ?? "")
    ) {
      argument += 1;
    }
    if (!literalDynamicImportEndsAtCallClose(analysis, argument)) count += 1;
  }
  return count;
}

export async function checkDistributableSkill(skillRoot, policy = {}) {
  const root = resolve(skillRoot);
  const findings = [];
  const files = await regularFiles(root, findings);
  const relativeFiles = new Set(files.map((path) => normalizedRelative(root, path)));
  for (const entrypoint of policy.requiredEntrypoints ?? []) {
    if (!relativeFiles.has(`runtime/${entrypoint}`)) {
      findings.push(`missing runtime entrypoint: ${entrypoint}`);
    }
  }
  for (const path of files) {
    const relativePath = normalizedRelative(root, path);
    const filename = relativePath.split("/").at(-1);
    const extension = extname(path).toLowerCase();
    if (PACKAGE_MANIFESTS.has(filename)) {
      findings.push(`the distributed skill must not require package.json: ${relativePath}`);
    }
    if (DEPENDENCY_LOCKFILES.has(filename)) {
      findings.push(`the distributed skill must not contain dependency lockfile: ${relativePath}`);
    }
    if (FORBIDDEN_EXECUTABLE_EXTENSIONS.has(extension)) {
      findings.push(`distributed skill contains unsupported executable source format: ${relativePath}`);
    }
    if (
      relativePath.startsWith("runtime/") &&
      Array.isArray(policy.allowedRuntimeExtensions) &&
      !policy.allowedRuntimeExtensions.includes(extension)
    ) {
      findings.push(`runtime file must use an allowed source format: ${relativePath}`);
    }
    if (![".md", ".json", ".mjs"].includes(extension)) {
      continue;
    }
    const source = await readFile(path, "utf8");
    for (const [pattern, label] of policy.forbiddenOperationalPatterns ?? []) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) {
        findings.push(`${label} in ${relativePath}`);
      }
    }
    if (extension !== ".mjs") {
      continue;
    }
    const code = executableCode(source);
    if (nonliteralDynamicImportCount(source) > 0) {
      findings.push(`non-literal dynamic import is forbidden in ${relativePath}`);
    }
    if (/\bcreateRequire\b/u.test(code)) {
      findings.push(`createRequire is forbidden in ${relativePath}`);
    }
    if (/\brequire\s*\(/u.test(code)) {
      findings.push(`CommonJS require is forbidden in ${relativePath}`);
    }
    if (
      DYNAMIC_CODE_IDENTIFIER_PATTERN.test(code) ||
      /\.\s*constructor\b/u.test(code) ||
      hasComputedDynamicCodeAccess(source)
    ) {
      findings.push(`dynamic code loading is forbidden in ${relativePath}`);
    }
    const specifiers = importSpecifiers(source);
    for (const specifier of specifiers) {
      if (DYNAMIC_CODE_MODULES.has(specifier)) {
        findings.push(`dynamic code module is forbidden in ${relativePath}: ${specifier}`);
        continue;
      }
      if (isBuiltin(specifier)) {
        if (!specifier.startsWith("node:")) {
          findings.push(`native import must use node: in ${relativePath}: ${specifier}`);
        }
        continue;
      }
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        findings.push(`external module import in ${relativePath}: ${specifier}`);
        continue;
      }
      const importedPath = resolve(dirname(path), specifier);
      const escaped = relative(root, importedPath);
      if (escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
        findings.push(`import escapes the distributed skill in ${relativePath}: ${specifier}`);
        continue;
      }
      const importedMetadata = await stat(importedPath).catch(() => null);
      if (!importedMetadata?.isFile()) {
        findings.push(`missing relative import in ${relativePath}: ${specifier}`);
      }
    }
    if (
      relativePath.startsWith("runtime/") &&
      !relativePath.startsWith("runtime/test/") &&
      specifiers.includes("node:child_process")
    ) {
      findings.push(`operational runtime must not execute external commands: ${relativePath}`);
    }
  }
  return findings.sort();
}
