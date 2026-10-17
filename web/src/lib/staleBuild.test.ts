import { describe, expect, it, vi } from 'vitest';
import { isChunkLoadError, reloadForNewBuild } from './staleBuild';

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

describe('stale build reload', () => {
  it('reloads once, then not again within a minute (no reload loop on a really broken build)', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadForNewBuild(storage, reload, 1_000_000)).toBe(true);
    expect(reloadForNewBuild(storage, reload, 1_030_000)).toBe(false);
    expect(reloadForNewBuild(storage, reload, 1_061_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('recognises chunk load errors of Chromium, Firefox and Safari', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://x/assets/Home-1.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Request failed with 500'))).toBe(false);
  });
});
