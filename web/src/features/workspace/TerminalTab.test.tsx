import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetchMock } from '@/test/fetchMock';
import { sessionFixture } from '@/test/sessionFixtures';
import { availableTabs } from './SessionPanel';
import TerminalTab from './TerminalTab';

const written: string[] = [];
let typed: (data: string) => void = () => undefined;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 100;
    rows = 30;
    loadAddon() {}
    open() {}
    focus() {}
    dispose() {}
    write(data: string) { written.push(data); }
    onData(listener: (data: string) => void) { typed = listener; return { dispose() {} }; }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, ((event: { data?: unknown }) => void)[]> = {};
  constructor(readonly url: string) { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) { (this.listeners[type] ??= []).push(listener); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  fire(type: string, event: { data?: unknown } = {}) {
    if (type === 'open') this.readyState = 1;
    this.listeners[type]?.forEach((listener) => listener(event));
  }
}

class FakeResizeObserver {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  written.length = 0;
  FakeSocket.last = null;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => vi.unstubAllGlobals());

const TERMINAL = { id: 't1', sessionId: 's1', projectId: 'project-1', cwd: 'C:/work/session-1', openedAt: '2026-10-17T10:00:00Z' };

describe('Terminal tab (Phase 3c)', () => {
  it('is offered only for open edit sessions in their own worktree', () => {
    expect(availableTabs(sessionFixture())).toContain('terminal');
    expect(availableTabs(sessionFixture({ mode: 'readonly', cwdKind: 'integration' }))).not.toContain('terminal');
    expect(availableTabs(sessionFixture({ status: 'closed' }))).not.toContain('terminal');
  });

  it('opens a terminal only on click, then streams output and sends typed input over the WebSocket', async () => {
    let open = false;
    const network = installFetchMock({
      'GET /api/v2/terminals': () => ({ json: { terminals: open ? [TERMINAL] : [], unavailableReason: null } }),
      'POST /api/v2/sessions/s1/terminal': () => { open = true; return { status: 201, json: TERMINAL }; },
    });
    render(<TerminalTab session={sessionFixture()} />);
    const button = await screen.findByRole('button', { name: 'Open terminal' });
    expect(network.calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(FakeSocket.last).not.toBeNull());
    expect(network.calls.find((c) => c.method === 'POST')?.body).toEqual({ confirm: true, cols: 100, rows: 30 });
    expect(FakeSocket.last!.url).toMatch(/\/api\/v2\/terminals\/t1\/ws$/);

    act(() => FakeSocket.last!.fire('open'));
    act(() => FakeSocket.last!.fire('message', { data: 'PS C:\\work> ' }));
    expect(written).toContain('PS C:\\work> ');
    act(() => typed('dir\r'));
    expect(FakeSocket.last!.sent.map((m) => JSON.parse(m))).toContainEqual({ type: 'input', data: 'dir\r' });
  });

  it('explains why a terminal cannot be opened', async () => {
    installFetchMock({ 'GET /api/v2/terminals': { terminals: [{ ...TERMINAL, sessionId: 'a' }, { ...TERMINAL, id: 't2', sessionId: 'b' }], unavailableReason: null } });
    render(<TerminalTab session={sessionFixture()} />);
    expect(((await screen.findByRole('button', { name: 'Open terminal' })) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('2 terminals are already open; close one first')).toBeTruthy();
  });
});
