export class TodoValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TodoValidationError';
  }
}

export function validateTitle(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TodoValidationError('title must be a non-empty string');
  }
  return value.trim();
}

export function validateId(value) {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^[1-9][0-9]*$/u.test(text)) {
    throw new TodoValidationError('id must be a positive integer');
  }
  return Number(text);
}

export function validateStoredTodo(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TodoValidationError('stored todo must be an object');
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['completed', 'id', 'title'])) {
    throw new TodoValidationError('stored todo has an invalid shape');
  }
  if (typeof value.completed !== 'boolean') throw new TodoValidationError('completed must be boolean');
  return { id: validateId(value.id), title: validateTitle(value.title), completed: value.completed };
}
