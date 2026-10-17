import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLifecycleLog } from '../src/lifecycleLog.ts';
import { tempDir } from './helpers.ts';

describe('lifecycle log', () => {
  it('appends one line per event under data/logs and keeps the file small', () => {
    const dir = tempDir('lifecycle');
    const log = createLifecycleLog(dir);
    log('started v0.1.0');
    log('stopping: SIGHUP received (the console window was closed)');
    const file = path.join(dir, 'logs', 'lifecycle.log');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/pid=\d+ stopping: SIGHUP/);
    fs.writeFileSync(file, 'x'.repeat(300 * 1024));
    log('after trim');
    expect(fs.statSync(file).size).toBeLessThan(200 * 1024);
  });
});
