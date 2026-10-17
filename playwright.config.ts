import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * Browser E2E (D-017): installed Microsoft Edge against a studio on a fresh temp ASF_DATA_DIR with only the offline
 * Scripted provider enabled (the default for a new database). Workers inherit the env, so the data dir is created once.
 * Run with `npm run test:e2e` (builds web/dist first; the API serves it).
 */
const PORT = Number(process.env.ASF_E2E_PORT ?? 4397);
process.env.ASF_E2E_DATA ??= fs.mkdtempSync(path.join(os.tmpdir(), 'asf-e2e-'));

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalTeardown: './e2e/teardown.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'msedge',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  outputDir: path.join(process.env.ASF_E2E_DATA, 'results'),
  webServer: {
    command: 'node node_modules/tsx/dist/cli.mjs server/src/index.ts',
    url: `http://127.0.0.1:${PORT}/api/info`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { ASF_PORT: String(PORT), ASF_HOST: '127.0.0.1', ASF_DATA_DIR: process.env.ASF_E2E_DATA, ASF_APPROVED_ROOTS: '' },
  },
});
