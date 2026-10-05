// Offline Case C implementation fixture. The seed remains unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateId, validateStoredTodo, validateTitle } from './validation.mjs';
const usage = 'usage: cli.mjs --store <path> <add <title...> | list [--archived] | complete <id> | archive <id> | unarchive <id>>';
export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  const badUsage = () => { stderr.write(usage + '\n'); return 2; };
  if (argv[0] !== '--store' || !argv[1]) return badUsage();
  const file = path.resolve(argv[1]);
  const [command, ...args] = argv.slice(2);
  const read = async () => {
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const document = JSON.parse(text);
    if (!document || Array.isArray(document) || Object.keys(document).length !== 1 || !Array.isArray(document.todos)) throw new Error('invalid store');
    const todos = document.todos.map(({ archived, ...todo }) => {
      if (archived !== undefined && typeof archived !== 'boolean') throw new Error('archived must be boolean');
      return { ...validateStoredTodo(todo), ...(archived === undefined ? {} : { archived }) };
    }).sort((a, b) => a.id - b.id);
    if (new Set(todos.map((todo) => todo.id)).size !== todos.length) throw new Error('duplicate ids');
    return todos;
  };
  const write = async (todos) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify({ todos }, null, 2) + '\n');
    await fs.rename(file + '.tmp', file);
  };
  const emit = (todo) => stdout.write(JSON.stringify(todo) + '\n');
  try {
    if (command === 'add' && args.length) {
      const title = validateTitle(args.join(' '));
      const todos = await read();
      // Absence of the optional field is the compatible active representation.
      const todo = { id: todos.reduce((id, item) => Math.max(id, item.id), 0) + 1, title, completed: false };
      await write([...todos, todo]); emit(todo); return 0;
    }
    if (command === 'list') {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--archived')) return badUsage();
      for (const todo of await read()) if ((todo.archived ?? false) === (args[0] === '--archived')) emit(todo);
      return 0;
    }
    if (['complete', 'archive', 'unarchive'].includes(command) && args.length === 1) {
      const id = validateId(args[0]);
      const todos = await read(), index = todos.findIndex((todo) => todo.id === id);
      if (index < 0) throw new Error(`todo ${id} does not exist`);
      if (command === 'complete' && todos[index].archived) throw new Error(`todo ${id} is archived`);
      const updated = { ...todos[index], ...(command === 'complete' ? { completed: true } : { archived: command === 'archive' }) };
      todos[index] = updated; await write(todos); emit(updated); return 0;
    }
    return badUsage();
  } catch (error) { stderr.write(`error: ${error.message}\n`); return 1; }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await runCli(process.argv.slice(2));
