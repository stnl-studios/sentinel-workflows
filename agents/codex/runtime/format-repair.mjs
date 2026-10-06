const MAX_RESPONSE_BYTES = 64 * 1024;
const EMPTY_FINDING_FIELDS = ['findingReferences', 'findingDispositions'];

function unframe(text) {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  return fenced === null ? trimmed : fenced[1].trim();
}

function lex(text) {
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (/\s/u.test(character)) { index += 1; continue; }
    if ('{}[]:,'.includes(character)) {
      tokens.push({ kind: 'punctuation', value: character });
      index += 1;
      continue;
    }
    if (character === '"') {
      const start = index;
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '\\') { index += 2; continue; }
        if (text[index] === '"') { index += 1; closed = true; break; }
        index += 1;
      }
      if (!closed) return null;
      const value = text.slice(start, index);
      try { JSON.parse(value); } catch { return null; }
      tokens.push({ kind: 'scalar', value });
      continue;
    }
    const scalar = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/u.exec(text.slice(index));
    if (scalar === null) return null;
    tokens.push({ kind: 'scalar', value: scalar[0] });
    index += scalar[0].length;
  }
  return tokens;
}

export function formatRepairSource(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return null;
  const body = unframe(text);
  if (!body.startsWith('{')) return null;
  const originalTokens = lex(body);
  if (originalTokens === null) return null;
  // Deliberately bounded: remove only commas immediately before a closing
  // container and, if necessary, supply one final object brace. JSON.parse
  // must then prove a complete object. Missing keys/values, other separators,
  // truncated strings and prose are not recoverable here.
  const tokens = originalTokens.filter((token, index) => !(token.value === ','
    && ['}', ']'].includes(originalTokens[index + 1]?.value)));
  let canonicalText = tokens.map((token) => token.value).join('');
  let payload;
  try { payload = JSON.parse(canonicalText); }
  catch {
    canonicalText += '}';
    try { payload = JSON.parse(canonicalText); } catch { return null; }
    tokens.push({ kind: 'punctuation', value: '}' });
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  // Whitespace removal must not merge adjacent malformed scalar tokens (for
  // example, an ambiguous `1 2` into `12`). Such input has no safe reference.
  if (JSON.stringify(lex(canonicalText)) !== JSON.stringify(tokens)) return null;
  // These two fields describe sets; an empty array contains exactly the same
  // entries as their canonical `none` spelling. No nonempty array, other field,
  // missing value or semantic judgment is inferred. Preserve all other tokens.
  const emptyFindingFields = EMPTY_FINDING_FIELDS.filter((field) =>
    Array.isArray(payload[field]) && payload[field].length === 0);
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (tokens[index].kind === 'scalar' && emptyFindingFields.includes(JSON.parse(tokens[index].value))
      && tokens[index + 1].value === ':' && tokens[index + 2].value === '['
      && tokens[index + 3].value === ']') {
      tokens.splice(index + 2, 2, { kind: 'scalar', value: '"none"' });
    }
  }
  canonicalText = tokens.map((token) => token.value).join('');
  return { canonicalText, tokens, emptyFindingFields };
}

export function sameFormatOnlyContent(source, repaired) {
  if (source === null || typeof repaired !== 'string' || Buffer.byteLength(repaired) > MAX_RESPONSE_BYTES) return false;
  // The repaired response must be raw JSON. The caller validates its schema.
  if (!repaired.trimStart().startsWith('{')) return false;
  const tokens = lex(repaired);
  if (tokens === null) return false;
  // Compare punctuation in place alongside scalar bytes. Comparing separate
  // scalar/structure lists could allow the same values to move between fields.
  return JSON.stringify(source.tokens) === JSON.stringify(tokens);
}
