import fs from 'node:fs/promises';
import path from 'node:path';

import { TodoValidationError, validateStoredTodo } from './validation.mjs';

export class TodoStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath === '') {
      throw new TodoValidationError('store path is required');
    }
    this.filePath = path.resolve(filePath);
  }

  async read() {
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }

    let document;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw new TodoValidationError(`store contains invalid JSON: ${error.message}`);
    }
    if (document === null || typeof document !== 'object' || Array.isArray(document)
      || Object.keys(document).length !== 1 || !Array.isArray(document.todos)) {
      throw new TodoValidationError('store must be an object containing only a todos array');
    }
    const todos = document.todos.map(validateStoredTodo);
    const ids = new Set(todos.map((todo) => todo.id));
    if (ids.size !== todos.length) throw new TodoValidationError('store contains duplicate ids');
    return todos.sort((left, right) => left.id - right.id);
  }

  async write(todos) {
    const validated = todos.map(validateStoredTodo).sort((left, right) => left.id - right.id);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ todos: validated }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filePath);
  }
}
