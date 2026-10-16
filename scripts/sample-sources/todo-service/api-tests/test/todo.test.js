import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTodoStore } from '../src/todoStore.js';
import { createApp } from '../src/server.js';

describe('todo store', () => {
  test('creates, updates and removes todos', () => {
    const store = createTodoStore();
    const todo = store.create('  write tests  ');
    assert.equal(todo.title, 'write tests');
    assert.equal(todo.done, false);
    assert.equal(store.update(todo.id, { done: true }).done, true);
    store.remove(todo.id);
    assert.deepEqual(store.list(), []);
  });

  test('rejects invalid titles', () => {
    const store = createTodoStore();
    assert.throws(() => store.create('   '), /title is required/);
    assert.throws(() => store.create('x'.repeat(201)), /at most 200/);
  });

  test('reports unknown ids as not found', () => {
    assert.throws(() => createTodoStore().remove('missing'), (error) => error.status === 404);
  });
});

describe('HTTP API', () => {
  let server;
  let base;

  before(async () => {
    server = createApp();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  test('full todo lifecycle', async () => {
    const created = await fetch(`${base}/api/todos`, { method: 'POST', body: JSON.stringify({ title: 'ship it' }) });
    assert.equal(created.status, 201);
    const todo = await created.json();

    const patched = await fetch(`${base}/api/todos/${todo.id}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
    assert.equal((await patched.json()).done, true);

    const list = await (await fetch(`${base}/api/todos`)).json();
    assert.equal(list.length, 1);

    assert.equal((await fetch(`${base}/api/todos/${todo.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${base}/api/todos/${todo.id}`, { method: 'DELETE' })).status, 404);
  });

  test('validates input', async () => {
    const response = await fetch(`${base}/api/todos`, { method: 'POST', body: JSON.stringify({ title: '' }) });
    assert.equal(response.status, 400);
    const bad = await fetch(`${base}/api/todos`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
  });

  test('serves the web UI', async () => {
    const response = await fetch(`${base}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<h1>Todos<\/h1>/);
  });
});
