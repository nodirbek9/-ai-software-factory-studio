import { describe, expect, it } from 'vitest';
import { installFetchMock } from './fetchMock';

describe('fetch mock', () => {
  it('routes by method and path, returns real JSON responses and records parsed bodies', async () => {
    const network = installFetchMock({ 'GET /api/item': { name: '模型🚀' }, 'PUT /api/item': null });
    const response = await fetch('/api/item');
    expect(response instanceof Response).toBe(true);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ name: '模型🚀' });
    expect(await (await fetch('/api/item', { method: 'PUT', body: 'null' })).json()).toBeNull();
    expect(network.calls).toEqual([
      { method: 'GET', path: '/api/item', body: undefined },
      { method: 'PUT', path: '/api/item', body: null },
    ]);
  });

  it('passes parsed JSON and request options to async handlers and preserves status', async () => {
    const network = installFetchMock({
      'POST /api/item': async (body: unknown, init: RequestInit) => ({ status: 201, json: { body, method: init.method } }),
    });
    const response = await fetch('/api/item', { method: 'POST', body: JSON.stringify({ items: [] }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ body: { items: [] }, method: 'POST' });
    expect(network.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns a 404 JSON error for unknown routes', async () => {
    installFetchMock({});
    const response = await fetch('/api/missing');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'No mock route for GET /api/missing' });
  });
});
