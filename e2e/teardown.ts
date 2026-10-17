import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Removes the temp data dir unless a test failed and left artifacts worth keeping (ASF_E2E_KEEP=1 keeps it always). */
export default async function teardown(): Promise<void> {
  const dir = process.env.ASF_E2E_DATA;
  if (!dir || !path.resolve(dir).startsWith(path.resolve(os.tmpdir())) || process.env.ASF_E2E_KEEP === '1') return;
  const results = path.join(dir, 'results');
  const failed = fs.existsSync(results) && fs.readdirSync(results).length > 0;
  if (failed) {
    console.log(`E2E artifacts kept in ${dir}`);
    return;
  }
  // The server child is killed before teardown; retry briefly while Windows releases the SQLite handles.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  console.log(`Could not remove ${dir}; delete it by hand.`);
}
