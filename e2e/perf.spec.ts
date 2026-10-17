import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSampleProject, expect, test } from './fixtures';

/**
 * Phase 7 performance check against docs/v2/PERFORMANCE_BASELINE.md "V2 targets". Prints the measured values (copied
 * into docs/v2/phases/PHASE_7.md) and fails only on the hard targets.
 */
const DIST = path.resolve('web/dist');
const KB = 1024;

function gzipSizeOf(url: string): number {
  const file = path.join(DIST, new URL(url).pathname);
  return fs.existsSync(file) ? zlib.gzipSync(fs.readFileSync(file)).length : 0;
}

test('V2 performance targets', async ({ page, request }) => {
  test.setTimeout(180_000);
  const projects = await (await request.get('/api/projects')).json();
  if (!projects.length) await createSampleProject(request, 'E2E Perf');

  const apiSizes = new Map<string, number>();
  page.on('response', async (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith('/api/') || url.pathname === '/api/events') return;
    const body = await response.body().catch(() => Buffer.alloc(0));
    const key = `${response.request().method()} ${url.pathname}`;
    apiSizes.set(key, Math.max(apiSizes.get(key) ?? 0, body.length));
  });

  const started = Date.now();
  const overview = page.waitForResponse((r) => r.url().includes('/api/v2/overview'));
  await page.goto('/#/home');
  await overview;
  const homeFirstDataMs = Date.now() - started;
  await expect(page.getByRole('heading', { name: 'Current Project Workflow' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  const scripts = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => (e as PerformanceResourceTiming).initiatorType === 'script' || e.name.endsWith('.js')).map((e) => e.name));
  const initialJsGzip = scripts.reduce((sum, url) => sum + gzipSizeOf(url), 0);
  const heap = await page.evaluate(() => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0);

  for (const slug of ['projects', 'workspace', 'builder', 'tasks', 'runs', 'repos', 'quality', 'logs', 'models', 'settings']) {
    await page.goto(`/#/${slug}`);
    await expect(page.locator('h1').first()).toBeVisible();
    await page.waitForLoadState('networkidle');
  }

  await page.goto('/#/workspace');
  await page.getByLabel('Layout preset').selectOption('8');
  await expect(page.getByText('Start a session')).toHaveCount(8);
  const budget = await (await request.get('/api/v2/budget')).json();
  const health = await (await request.get('/api/v2/system/health')).json();

  const largest = [...apiSizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const report = {
    homeFirstDataMs,
    initialJsGzipKB: Math.round(initialJsGzip / KB),
    initialScripts: scripts.map((s) => new URL(s).pathname),
    homeHeapMB: Math.round(heap / KB / KB),
    serverRssMB: Math.round(health.server.rssBytes / KB / KB),
    workspace8PanelsRunning: budget.running.length,
    largestApiPayloadsKB: largest.map(([key, size]) => `${key} ${Math.round(size / KB)} KB`),
  };
  console.log(`PERF ${JSON.stringify(report, null, 2)}`);

  expect(report.initialJsGzipKB).toBeLessThanOrEqual(160);
  expect(report.homeFirstDataMs).toBeLessThanOrEqual(1500); // cold page load incl. JS; the API call itself is checked below
  expect(report.homeHeapMB).toBeLessThanOrEqual(40);
  expect(report.serverRssMB).toBeLessThanOrEqual(150);
  expect(report.workspace8PanelsRunning).toBe(0);
  expect(largest[0]?.[1] ?? 0).toBeLessThanOrEqual(150 * KB);

  const apiStart = Date.now();
  await request.get('/api/v2/overview');
  expect(Date.now() - apiStart).toBeLessThanOrEqual(300);
});
