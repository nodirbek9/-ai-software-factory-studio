import { vi } from 'vitest';

export interface FetchCall {
  method: string;
  path: string;
  body: unknown;
}

export interface JsonReply {
  status?: number;
  json: unknown;
}

type Handler = (body: unknown, init: RequestInit) => JsonReply | Promise<JsonReply>;
type Routes = Record<string, unknown | Handler>;

export function installFetchMock(routes: Routes) {
  const calls: FetchCall[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const route = routes[key];
    const reply: JsonReply = !Object.hasOwn(routes, key)
      ? { status: 404, json: { error: `No mock route for ${key}` } }
      : typeof route === 'function' ? await (route as Handler)(body, init) : { json: route };
    return new Response(JSON.stringify(reply.json), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetch);
  return { calls, fetch };
}
