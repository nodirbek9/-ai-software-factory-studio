import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTodoStore, TodoError } from './todoStore.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 64 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new TodoError('request body too large', 413);
    chunks.push(chunk);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw new TodoError('invalid JSON body', 400);
  }
}

async function serveStatic(res, pathname) {
  const relative = normalize(pathname === '/' ? 'index.html' : pathname.slice(1));
  if (relative.startsWith('..')) return send(res, 404, { error: 'not found' });
  try {
    const content = await readFile(join(PUBLIC_DIR, relative));
    res.writeHead(200, { 'Content-Type': TYPES[extname(relative)] ?? 'application/octet-stream' }).end(content);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

export function createApp(store = createTodoStore()) {
  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/api/todos' && req.method === 'GET') return send(res, 200, store.list());
      if (pathname === '/api/todos' && req.method === 'POST') return send(res, 201, store.create((await readJson(req)).title));
      const match = /^\/api\/todos\/([\w-]+)$/.exec(pathname);
      if (match && req.method === 'PATCH') return send(res, 200, store.update(match[1], await readJson(req)));
      if (match && req.method === 'DELETE') {
        store.remove(match[1]);
        return send(res, 204);
      }
      if (pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET') return serveStatic(res, pathname);
      return send(res, 405, { error: 'method not allowed' });
    } catch (error) {
      if (error instanceof TodoError) return send(res, error.status, { error: error.message });
      return send(res, 500, { error: 'internal error' });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 3000);
  createApp().listen(port, '127.0.0.1', () => console.log(`todo-service on http://127.0.0.1:${port}`));
}
