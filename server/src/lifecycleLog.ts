import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 256 * 1024;

/**
 * One line per start and stop of the studio in `<dataDir>/logs/lifecycle.log`, so "why did the studio stop?" has an
 * answer when the console window is gone: a signal (Ctrl+C, a closed window = SIGHUP on Windows), an uncaught error
 * with its stack, or the exit code. Never throws; the file is cut to its newest half past 256 KB.
 */
export function createLifecycleLog(dataDir: string): (message: string) => void {
  const file = path.join(dataDir, 'logs', 'lifecycle.log');
  return (message) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) {
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, text.slice(text.length / 2));
      }
      fs.appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${message}\n`);
    } catch {
      // logging must never stop the studio
    }
  };
}
