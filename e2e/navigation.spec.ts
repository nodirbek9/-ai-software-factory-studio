import { createSampleProject, expect, test } from './fixtures';

const NAV = ['Home', 'Projects', 'Agent Workspace', 'Workflow Builder', 'Tasks', 'Runs', 'Repos', 'QA & Security', 'Logs',
  'Models & Providers', 'Settings'];

test.beforeAll(async ({ request }) => {
  const list = await (await request.get('/api/projects')).json();
  if (!list.length) await createSampleProject(request, 'E2E Todo');
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  test(`every nav item opens a page at ${viewport.width}x${viewport.height} (P1-04)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/#/home');
    const nav = page.getByRole('navigation').first();
    for (const label of NAV) {
      await nav.getByRole('button', { name: label, exact: true }).or(nav.getByRole('link', { name: label, exact: true })).first().click();
      await expect(page.locator('main h1, h1').first()).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(viewport.width);
  });
}

for (const width of [1024, 1280, 1366, 1920]) {
  test(`the header fits at ${width}px and the project picker stays readable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/#/home');
    const header = page.getByRole('banner');
    await expect(header.getByRole('combobox', { name: 'Current project' })).toBeVisible();
    const fit = await header.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(fit.scroll).toBeLessThanOrEqual(fit.client);
    const picker = await header.getByRole('combobox', { name: 'Current project' }).boundingBox();
    expect(picker!.width).toBeGreaterThanOrEqual(110);
  });
}

test('Home shows the current project and KPIs that match the API (P2-04)', async ({ page, request }) => {
  const projects = await (await request.get('/api/projects')).json();
  await page.goto('/#/home');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Current Project Workflow' })).toBeVisible();
  await expect(main.getByRole('group', { name: 'Active projects' })).toContainText(`${projects.length} total`);
  await expect(main.getByRole('list', { name: 'Pipeline stages' }).getByRole('listitem')).toHaveCount(6);
});

test('a tab opened before an update reloads itself instead of staying blank (stale build)', async ({ page, request, consoleErrors }) => {
  const missing = await request.get('/assets/Home-from-an-old-build.js');
  expect(missing.status()).toBe(404); // not the HTML page with a misleading MIME type
  await page.goto('/#/projects');
  await expect(page.getByRole('heading', { name: 'Projects' }).first()).toBeVisible();
  // The next request for the Home chunk fails once, as it does when the build changed under an open tab.
  await page.route(/\/assets\/Home-[^/]+\.js$/, (route) => route.fulfill({ status: 404, body: 'Not found' }), { times: 1 });
  const reloaded = page.waitForEvent('load');
  await page.evaluate(() => { window.location.hash = '#/home'; });
  await reloaded;
  await expect(page.getByRole('heading', { name: 'Current Project Workflow' })).toBeVisible();
  // The simulated missing chunk is expected to log its 404 and the failed import before the reload.
  const expected = /404|Not Found|dynamically imported module|Failed to load resource/i;
  consoleErrors.splice(0, consoleErrors.length, ...consoleErrors.filter((e) => !expected.test(e)));
});
