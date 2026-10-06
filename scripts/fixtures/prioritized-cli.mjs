#!/usr/bin/env node
// Correct Case B reference for local regressions; never installed into the seed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateId, validateStoredTodo, validateTitle } from './validation.mjs';

const usage = 'usage: cli.mjs --store <path> <add [--priority <low|medium|high>] <title...> | list | complete <id>>';
const priorities = ['low', 'medium', 'high'];

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (argv[0] !== '--store' || !argv[1]) {
    stderr.write(`${usage}\n`);
    return 2;
  }
  const file = path.resolve(argv[1]);
  const [command, ...args] = argv.slice(2);
  const read = async () => {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const document = JSON.parse(text);
    if (!document || Array.isArray(document) || Object.keys(document).length !== 1 || !Array.isArray(document.todos)) {
      throw new Error('store must contain only a todos array');
    }
    const todos = document.todos.map(({ priority, ...todo }) => {
      if (priority !== undefined && !priorities.includes(priority)) throw new Error(`invalid priority: ${priority}`);
      return { ...validateStoredTodo(todo), priority: priority ?? 'medium' };
    }).sort((left, right) => left.id - right.id);
    if (new Set(todos.map((todo) => todo.id)).size !== todos.length) throw new Error('duplicate ids');
    return todos;
  };
  const write = async (todos) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, `${JSON.stringify({ todos }, null, 2)}\n`);
    await fs.rename(`${file}.tmp`, file);
  };
  const emit = (todo) => stdout.write(`${JSON.stringify(todo)}\n`);
  try {
    if (command === 'add' && args.length > 0) {
      let priority = 'medium';
      let title = args;
      if (args[0] === '--priority') {
        if (args.length < 3) { stderr.write(`${usage}\n`); return 2; }
        priority = args[1];
        if (!priorities.includes(priority)) throw new Error(`invalid priority: ${priority}`);
        title = args.slice(2);
      }
      const todos = await read();
      const todo = { id: todos.reduce((maximum, item) => Math.max(maximum, item.id), 0) + 1,
        title: validateTitle(title.join(' ')), completed: false, priority };
      await write([...todos, todo]);
      emit(todo);
      return 0;
    }
    if (command === 'list' && args.length === 0) {
      for (const todo of await read()) emit(todo);
      return 0;
    }
    if (command === 'complete' && args.length === 1) {
      const id = validateId(args[0]);
      const todos = await read();
      const index = todos.findIndex((todo) => todo.id === id);
      if (index < 0) throw new Error(`todo ${id} does not exist`);
      const updated = { ...todos[index], completed: true };
      todos[index] = updated;
      await write(todos);
      emit(updated);
      return 0;
    }
    stderr.write(`${usage}\n`);
    return 2;
  } catch (error) {
    stderr.write(`error: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
