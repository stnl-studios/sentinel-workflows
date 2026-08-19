import path from 'node:path';

export function cliError(message, usage = null) {
  if (usage) process.stderr.write(`usage: ${usage}\n`);
  process.stderr.write(`${path.basename(process.argv[1])}: error: ${message}\n`);
  process.exitCode = 2;
}

export function helpRequested(tokens) {
  for (const token of tokens) {
    if (token === '--') return false;
    if (token === '-h' || token === '--help') return true;
  }
  return false;
}

export function printHelp(usage) {
  process.stdout.write(`usage: ${usage}\n`);
}

export function parseOptions(tokens, specifications) {
  const positional = [];
  const options = Object.create(null);
  let optionsEnded = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    const separator = token.startsWith('--') ? token.indexOf('=') : -1;
    const name = separator > 2 ? token.slice(0, separator) : token;
    const specification = specifications[name];
    if (!specification) return { error: `unrecognized arguments: ${token}` };
    if (separator > 2) {
      const value = token.slice(separator + 1);
      if (!value) return { error: `argument ${name}: expected one argument` };
      options[name] = value;
    } else {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith('-')) return { error: `argument ${name}: expected one argument` };
      options[name] = value;
      index += 1;
    }
  }
  for (const [name, specification] of Object.entries(specifications)) {
    if (specification.required && options[name] === undefined) return { error: `the following arguments are required: ${name}` };
    if (options[name] !== undefined && specification.choices && !specification.choices.includes(options[name])) {
      return { error: `argument ${name}: invalid choice: '${options[name]}' (choose from ${specification.choices.map((value) => `'${value}'`).join(', ')})` };
    }
  }
  return { positional, options };
}
