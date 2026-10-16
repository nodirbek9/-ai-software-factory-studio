import { randomUUID } from 'node:crypto';

export class TodoError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const MAX_TITLE = 200;

function normalizeTitle(title) {
  if (typeof title !== 'string') throw new TodoError('title must be a string', 400);
  const trimmed = title.trim();
  if (!trimmed) throw new TodoError('title is required', 400);
  if (trimmed.length > MAX_TITLE) throw new TodoError(`title must be at most ${MAX_TITLE} characters`, 400);
  return trimmed;
}

/** In-memory todo store. Returns copies so callers cannot mutate internal state. */
export function createTodoStore() {
  const todos = new Map();

  const find = (id) => {
    const todo = todos.get(id);
    if (!todo) throw new TodoError(`todo ${id} not found`, 404);
    return todo;
  };

  return {
    list() {
      return [...todos.values()].map((t) => ({ ...t }));
    },
    create(title) {
      const todo = { id: randomUUID(), title: normalizeTitle(title), done: false, createdAt: new Date().toISOString() };
      todos.set(todo.id, todo);
      return { ...todo };
    },
    update(id, patch) {
      const current = find(id);
      const next = { ...current };
      if (patch.title !== undefined) next.title = normalizeTitle(patch.title);
      if (patch.done !== undefined) {
        if (typeof patch.done !== 'boolean') throw new TodoError('done must be a boolean', 400);
        next.done = patch.done;
      }
      todos.set(id, next);
      return { ...next };
    },
    remove(id) {
      find(id);
      todos.delete(id);
    },
  };
}
