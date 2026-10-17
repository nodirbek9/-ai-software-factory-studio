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
