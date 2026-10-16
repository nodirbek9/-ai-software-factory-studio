import { act, renderHook } from '@testing-library/react';
import type { StudioEvent } from '@asf/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStudio } from '@/store/studio';
import { useV2 } from './useV2';

interface Payload { value: string }

/** A minimal fetch reply made of microtasks only, so fake timers can drive the whole flow. */
function reply(body: unknown, status = 200) {
  return {
    ok: status < 400, status, statusText: String(status), headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  };
}

function stubFetch(handler: (path: string) => unknown | Promise<unknown>) {
  const fetchMock = vi.fn(async (path: string) => reply(await handler(path)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const event = (id: number, type: string): StudioEvent => ({
  id, projectId: null, taskId: null, role: null, type, level: 'info', message: type, data: null, createdAt: '2026-10-16T10:00:00Z',
});

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

beforeEach(() => {
  useStudio.setState(useStudio.getInitialState(), true);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

describe('useV2', () => {
  it('loads the path and exposes data', async () => {
    const fetchMock = stubFetch(() => ({ value: 'one' }));
    const { result } = renderHook(() => useV2<Payload>('/api/v2/thing'));
    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current).toMatchObject({ data: { value: 'one' }, error: null, loading: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/thing');
  });

  it('does nothing for a null path', async () => {
    const fetchMock = stubFetch(() => ({}));
    const { result } = renderHook(() => useV2<Payload>(null));
    await flush(20_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ data: null, error: null, loading: false });
  });

  it('reports a failed request and recovers on reload', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async () => (fail ? reply({ error: 'boom' }, 500) : reply({ value: 'ok' }))));
    const { result } = renderHook(() => useV2<Payload>('/api/v2/thing'));
    await flush();
    expect(result.current).toMatchObject({ data: null, error: 'boom', loading: false });

    fail = false;
    act(() => result.current.reload());
    expect(result.current.loading).toBe(true);
    await flush();
    expect(result.current).toMatchObject({ data: { value: 'ok' }, error: null, loading: false });
  });

  it('reloads once, 1.5 s after a burst of studio events', async () => {
    const fetchMock = stubFetch(() => ({ value: 'x' }));
    renderHook(() => useV2<Payload>('/api/v2/thing'));
    await flush();
    act(() => useStudio.setState({ events: [event(1, 'task.updated')] }));
    await flush(500);
    act(() => useStudio.setState({ events: [event(1, 'task.updated'), event(2, 'project.updated')] }));
    await flush(900);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await flush(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await flush(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('ignores agent.output events and events that existed before it mounted', async () => {
    useStudio.setState({ events: [event(1, 'task.updated')] });
    const fetchMock = stubFetch(() => ({ value: 'x' }));
    renderHook(() => useV2<Payload>('/api/v2/thing'));
    await flush(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => useStudio.setState({ events: [event(1, 'task.updated'), event(2, 'agent.output'), event(3, 'agent.output')] }));
    await flush(3_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('polls every 15 s only while the page is visible', async () => {
    const fetchMock = stubFetch(() => ({ value: 'x' }));
    renderHook(() => useV2<Payload>('/api/v2/thing'));
    await flush();
    await flush(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    await flush(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    setVisibility('visible');
    await flush(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ignores a response that arrives after the path changed', async () => {
    let releaseA: (value: Payload) => void = () => {};
    const slowA = new Promise<Payload>((resolve) => { releaseA = resolve; });
    stubFetch((path) => (path === '/api/v2/a' ? slowA : { value: 'b' }));
    const { result, rerender } = renderHook(({ path }) => useV2<Payload>(path), { initialProps: { path: '/api/v2/a' } });
    await flush();
    expect(result.current.loading).toBe(true);

    rerender({ path: '/api/v2/b' });
    await flush();
    expect(result.current).toMatchObject({ data: { value: 'b' }, loading: false });

    releaseA({ value: 'a' });
    await flush();
    expect(result.current.data).toEqual({ value: 'b' });
  });

  it('clears its timers on unmount', async () => {
    const fetchMock = stubFetch(() => ({ value: 'x' }));
    const { unmount } = renderHook(() => useV2<Payload>('/api/v2/thing'));
    await flush();
    act(() => useStudio.setState({ events: [event(1, 'task.updated')] }));
    unmount();
    await flush(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
