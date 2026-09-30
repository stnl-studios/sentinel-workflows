import { TodoValidationError, validateId, validateTitle } from './validation.mjs';

export class TodoService {
  constructor(store) {
    if (store === null || typeof store?.read !== 'function' || typeof store?.write !== 'function') {
      throw new TypeError('store must provide read and write');
    }
    this.store = store;
  }

  async add(title) {
    const todos = await this.store.read();
    const nextId = todos.reduce((maximum, todo) => Math.max(maximum, todo.id), 0) + 1;
    const todo = { id: nextId, title: validateTitle(title), completed: false };
    await this.store.write([...todos, todo]);
    return todo;
  }

  async list() {
    return this.store.read();
  }

  async complete(id) {
    const normalizedId = validateId(id);
    const todos = await this.store.read();
    const index = todos.findIndex((todo) => todo.id === normalizedId);
    if (index < 0) throw new TodoValidationError(`todo ${normalizedId} does not exist`);
    const updated = { ...todos[index], completed: true };
    const next = [...todos];
    next[index] = updated;
    await this.store.write(next);
    return updated;
  }
}
