import { ValidationError } from './core.mjs';

// JSON.parse silently accepts duplicate object keys. Lifecycle manifests,
// attestations, and journals deliberately reject them, so use a small strict
// recursive-descent parser built only from the ECMAScript JSON grammar.
export function parseStrictJson(text, duplicateMessage, invalidConstantMessage = null) {
  let index = 0;
  const source = String(text);

  function error(message) {
    throw new SyntaxError(`${message} at position ${index}`);
  }

  function whitespace() {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/u.test(source[index])) index += 1;
  }

  function string() {
    const start = index;
    if (source[index] !== '"') error('expected string');
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(source.slice(start, index));
      }
      if (character === '\\') {
        index += 1;
        if (index >= source.length || !/["\\/bfnrtu]/u.test(source[index])) error('invalid string escape');
        if (source[index] === 'u') {
          const digits = source.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/u.test(digits)) error('invalid unicode escape');
          index += 4;
        }
      } else if (character.codePointAt(0) < 0x20) {
        error('control character in string');
      }
      index += 1;
    }
    error('unterminated string');
  }

  function number() {
    const match = source.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u);
    if (match === null) error('invalid number');
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) error('number is out of range');
    return value;
  }

  function array() {
    index += 1;
    whitespace();
    const result = [];
    if (source[index] === ']') {
      index += 1;
      return result;
    }
    while (true) {
      result.push(value());
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return result;
      }
      if (source[index] !== ',') error("expected ',' or ']'");
      index += 1;
      whitespace();
    }
  }

  function object() {
    index += 1;
    whitespace();
    const result = Object.create(null);
    const keys = new Set();
    if (source[index] === '}') {
      index += 1;
      return result;
    }
    while (true) {
      if (source[index] !== '"') error('expected object key');
      const key = string();
      if (keys.has(key)) throw new ValidationError(duplicateMessage(key));
      keys.add(key);
      whitespace();
      if (source[index] !== ':') error("expected ':'");
      index += 1;
      whitespace();
      result[key] = value();
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return result;
      }
      if (source[index] !== ',') error("expected ',' or '}'");
      index += 1;
      whitespace();
    }
  }

  function value() {
    whitespace();
    const character = source[index];
    if (character === '"') return string();
    if (character === '{') return object();
    if (character === '[') return array();
    if (source.startsWith('true', index)) { index += 4; return true; }
    if (source.startsWith('false', index)) { index += 5; return false; }
    if (source.startsWith('null', index)) { index += 4; return null; }
    for (const [literal, constant] of [['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY]]) {
      if (source.startsWith(literal, index)) {
        index += literal.length;
        if (invalidConstantMessage !== null) throw new ValidationError(invalidConstantMessage(literal));
        return constant;
      }
    }
    if (character === '-' || /[0-9]/u.test(character ?? '')) return number();
    error('unexpected token');
  }

  const result = value();
  whitespace();
  if (index !== source.length) error('unexpected trailing content');
  return result;
}

export function exactObject(value, fields, label, prefix) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ValidationError(`${prefix} ${label} must be a JSON object`);
  }
  const actual = Object.keys(value);
  const expected = [...fields];
  const unknown = actual.filter((field) => !fields.has(field)).sort();
  const missing = expected.filter((field) => !Object.hasOwn(value, field)).sort();
  if (unknown.length || missing.length) {
    const quote = (entry) => `'${entry}'`;
    throw new ValidationError(
      `${prefix} ${label} fields are invalid; unknown=[${unknown.map(quote).join(', ')}], missing=[${missing.map(quote).join(', ')}]`,
    );
  }
  return value;
}
