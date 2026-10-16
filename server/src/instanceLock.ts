import fs from 'node:fs';
import path from 'node:path';

export class StudioAlreadyRunningError extends Error {}

const LOCK_WAIT_MS = 5000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One studio per data directory. Two instances on the same database would both run "crash recovery" and the
 * scheduler, re-queueing and deleting each other's running work. A stale lock (dead pid) is taken over.
 */
export async function acquireInstanceLock(dataDir: string, waitMs = LOCK_WAIT_MS): Promise<() => void> {
  const file = path.join(dataDir, 'studio.pid');
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => {
        try {
          if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.rmSync(file, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number(fs.readFileSync(file, 'utf8').trim());
      if (owner && owner !== process.pid && isAlive(owner)) {
        // A watcher restart can overlap the old process for a moment; give it time to exit.
        if (Date.now() < deadline) { await new Promise((r) => setTimeout(r, 250)); continue; }
        throw new StudioAlreadyRunningError(
          `AI Software Factory Studio is already running (pid ${owner}) on this data folder. Open the running one instead of starting a second copy.`);
      }
      fs.rmSync(file, { force: true }); // stale lock from a process that no longer exists
    }
  }
}
