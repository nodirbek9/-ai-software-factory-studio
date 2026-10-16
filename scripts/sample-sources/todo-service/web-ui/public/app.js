const list = document.querySelector('#list');
const form = document.querySelector('#add-form');
const input = document.querySelector('#title');
const errorBox = document.querySelector('#error');

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? response.statusText);
  return response.status === 204 ? null : response.json();
}

function render(todos) {
  list.replaceChildren(...todos.map((todo) => {
    const item = document.createElement('li');
    item.className = todo.done ? 'done' : '';
    const checkbox = Object.assign(document.createElement('input'), { type: 'checkbox', checked: todo.done });
    checkbox.addEventListener('change', () => run(() => api(`/api/todos/${todo.id}`, { method: 'PATCH', body: JSON.stringify({ done: checkbox.checked }) })));
    const title = document.createElement('span');
    title.textContent = todo.title; // textContent escapes user input
    const remove = Object.assign(document.createElement('button'), { className: 'delete', textContent: 'Delete' });
    remove.addEventListener('click', () => run(() => api(`/api/todos/${todo.id}`, { method: 'DELETE' })));
    item.append(checkbox, title, remove);
    return item;
  }));
}

async function run(action) {
  try {
    errorBox.textContent = '';
    await action();
    render(await api('/api/todos'));
  } catch (error) {
    errorBox.textContent = error.message;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const title = input.value;
  input.value = '';
  run(() => api('/api/todos', { method: 'POST', body: JSON.stringify({ title }) }));
});

run(async () => {});
