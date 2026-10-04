#!/usr/bin/env node

// Sanitized implementation snapshot from run-20261003171055-73934965, Case A.
// A regression fixture only; it does not change the benchmark seed or product.

import { pathToFileURL } from 'node:url';

import { TodoService } from './todo-service.mjs';
import { TodoStore } from './todo-store.mjs';

const usage = 'usage: cli.mjs --store <path> <add <title...> | list [--completed | --pending] | complete <id>>';

export async function runCli(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  if (argv[0] !== '--store' || !argv[1]) {
    stderr.write(`${usage}\n`);
    return 2;
  }
  const service = new TodoService(new TodoStore(argv[1]));
  const [command, ...args] = argv.slice(2);
  try {
    if (command === 'add' && args.length > 0) {
      stdout.write(`${JSON.stringify(await service.add(args.join(' ')))}\n`);
      return 0;
    }
    if (command === 'list') {
      if (args.length > 1 || (args.length === 1 && args[0] !== '--completed' && args[0] !== '--pending')) {
        stderr.write(`${usage}\n`);
        return 2;
      }
      const filter = args[0];
      const todos = await service.list();
      const listed = filter === '--completed'
        ? todos.filter((todo) => todo.completed === true)
        : filter === '--pending'
          ? todos.filter((todo) => todo.completed === false)
          : todos;
      for (const todo of listed) stdout.write(`${JSON.stringify(todo)}\n`);
      return 0;
    }
    if (command === 'complete' && args.length === 1) {
      stdout.write(`${JSON.stringify(await service.complete(args[0]))}\n`);
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
