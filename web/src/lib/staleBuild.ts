const RELOAD_KEY = 'asf.staleBuildReload';
/** One automatic reload per minute at most, so a really broken build shows its error instead of looping. */
const RELOAD_GUARD_MS = 60_000;

/**
 * After the studio is updated, a tab that was open before still asks for the old build's page chunks, which no longer
 * exist. Reloading once loads the new build. Returns true when a reload was started.
 */
export function reloadForNewBuild(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSession(),
  reload: () => void = () => window.location.reload(), now = Date.now()): boolean {
  const last = Number(storage?.getItem(RELOAD_KEY) ?? 0);
  if (now - last < RELOAD_GUARD_MS) return false;
  storage?.setItem(RELOAD_KEY, String(now));
  reload();
  return true;
}

/** True for the errors browsers raise when a dynamically imported chunk cannot be fetched or parsed. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|MIME type/i.test(message);
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
