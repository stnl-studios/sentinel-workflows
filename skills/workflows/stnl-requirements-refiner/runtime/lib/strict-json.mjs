import { ValidationError } from "./core.mjs";

// JSON.parse accepts duplicate keys. Refinement candidates, authorities, and
// journals are contracts, so parse the ECMAScript JSON grammar strictly.
export function parseStrictJson(text, duplicateMessage, invalidConstantMessage = null) {
  const source = String(text);
  let index = 0;

  function error(message) {
    throw new SyntaxError(`${message} at position ${index}`);
  }

  function whitespace() {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/u.test(source[index])) index += 1;
  }

  function string() {
    const start = index;
    if (source[index] !== '"') error("expected string");
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (character === "\\") {
        index += 1;
        if (index >= source.length || !/["\\/bfnrtu]/u.test(source[index])) error("invalid string escape");
        if (source[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(index + 1, index + 5))) error("invalid unicode escape");
          index += 4;
        }
      } else if (character.codePointAt(0) < 0x20) {
        error("control character in string");
      }
      index += 1;
    }
    error("unterminated string");
  }

  function number() {
    const match = source.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (match === null) error("invalid number");
    index += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) error("number is out of range");
    return parsed;
  }

  function array() {
    index += 1;
    whitespace();
    const result = [];
    if (source[index] === "]") {
      index += 1;
      return result;
    }
    while (true) {
      result.push(value());
      whitespace();
      if (source[index] === "]") {
        index += 1;
        return result;
      }
      if (source[index] !== ",") error("expected ',' or ']'");
      index += 1;
      whitespace();
    }
  }

  function object() {
    index += 1;
    whitespace();
    const result = Object.create(null);
    const keys = new Set();
    if (source[index] === "}") {
      index += 1;
      return result;
    }
    while (true) {
      if (source[index] !== '"') error("expected object key");
      const key = string();
      if (keys.has(key)) throw new ValidationError(duplicateMessage(key));
      keys.add(key);
      whitespace();
      if (source[index] !== ":") error("expected ':'");
      index += 1;
      whitespace();
      result[key] = value();
      whitespace();
      if (source[index] === "}") {
        index += 1;
        return result;
      }
      if (source[index] !== ",") error("expected ',' or '}'");
      index += 1;
      whitespace();
    }
  }

  function value() {
    whitespace();
    const character = source[index];
    if (character === '"') return string();
    if (character === "{") return object();
    if (character === "[") return array();
    if (source.startsWith("true", index)) { index += 4; return true; }
    if (source.startsWith("false", index)) { index += 5; return false; }
    if (source.startsWith("null", index)) { index += 4; return null; }
    for (const literal of ["NaN", "Infinity", "-Infinity"]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        if (invalidConstantMessage !== null) throw new ValidationError(invalidConstantMessage(literal));
        return Number.NaN;
      }
    }
    if (character === "-" || /[0-9]/u.test(character ?? "")) return number();
    error("unexpected token");
  }

  const result = value();
  whitespace();
  if (index !== source.length) error("unexpected trailing content");
  return result;
}
