import { expect, test, type ConsoleMessage, type Page, type Response } from '@playwright/test';
import { createSampleProject } from './fixtures';

/**
 * Every-button audit: on each page, click every visible, enabled button and tab once; after each click, also click
 * the controls it revealed (a tab panel, a drawer, a menu) — one level deep. Records page errors, console errors and
 * 5xx responses per click path. Runs on the temp-data E2E studio with only the Scripted provider, so destructive
 * buttons cannot touch real data; confirm dialogs are dismissed. Run: `npx playwright test e2e/audit.spec.ts`.
 */
test.describe.configure({ mode: 'serial' });

interface Problem {
  page: string;
  path: string;
  error: string;
}

const PAGES = ['home', 'projects', 'projects/{id}', 'workspace', 'builder', 'tasks', 'runs', 'repos', 'quality', 'logs', 'models',
  'settings', 'board', 'task-graph', 'files'];
const SKIP = /^(Skip to content|Collapse sidebar|Expand sidebar|Collapse|Expand)$/;
const MAX_NESTED = 25;

let projectId = '';

test('seed: a finished scripted run and a workspace session', async ({ page, request }) => {
  test.setTimeout(240_000);
  const project = await createSampleProject(request, 'Audit Todo');
  projectId = project.id;
  await page.goto('/#/board');
  await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  await page.getByRole('banner').getByRole('button', { name: 'Generate plan' }).click();
  const approve = page.getByRole('button', { name: 'Approve' }).first();
  await expect(approve).toBeVisible({ timeout: 90_000 });
  await approve.click();
  await expect.poll(async () => (await (await request.get(`/api/projects/${project.id}`)).json()).project.status,
    { timeout: 200_000, intervals: [2000] }).toBe('completed');
  const created = await request.post(`/api/v2/projects/${project.id}/sessions`,
    { data: { role: 'architect', providerId: 'scripted', model: '', effort: '', mode: 'readonly', title: 'Audit session' } });
  expect(created.ok(), await created.text()).toBeTruthy();
});

function watch(page: Page, sink: string[]): () => void {
  const onError = (error: Error) => sink.push(`pageerror: ${error.message}`);
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error' && !/favicon|ERR_ABORTED|ERR_INCOMPLETE_CHUNKED_ENCODING/.test(message.text())) sink.push(`console: ${message.text()}`);
  };
  const onResponse = (response: Response) => {
    if (response.status() >= 500) sink.push(`HTTP ${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  page.on('response', onResponse);
  return () => {
    page.off('pageerror', onError);
    page.off('console', onConsole);
    page.off('response', onResponse);
  };
}

async function controlNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const names = new Set<string>();
    const selector = 'main button, main [role=tab], header button, [role=dialog] button, [role=menu] [role=menuitem]';
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const rect = element.getBoundingClientRect();
      const disabled = (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
      const name = (element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\s+/g, ' ');
      if (!disabled && rect.width > 0 && rect.height > 0 && name) names.add(name);
    }
    return [...names];
  });
}

function control(page: Page, name: string) {
  const scope = page.locator('main, header, [role=dialog], [role=menu]');
  return scope.getByRole('button', { name, exact: true })
    .or(scope.getByRole('tab', { name, exact: true }))
    .or(scope.getByRole('menuitem', { name, exact: true })).first();
}

/** Clicks each control of `path` in turn (the last one is the one under test) and records what broke. */
async function press(page: Page, slug: string, path: string[], problems: Problem[]): Promise<void> {
  const sink: string[] = [];
  const stop = watch(page, sink);
  try {
    for (const name of path) {
      const target = control(page, name);
      if (!(await target.isVisible().catch(() => false))) return;
      await target.click({ timeout: 3_000 }).catch((error: Error) => sink.push(`click failed: ${error.message.split('\n')[0]}`));
      await page.waitForTimeout(350);
    }
  } finally {
    stop();
  }
  for (const error of sink) if (!error.startsWith('click failed')) problems.push({ page: slug, path: path.join(' → '), error });
}

for (const slug of PAGES) {
  test(`every button on #/${slug}`, async ({ page }) => {
    test.setTimeout(900_000);
    page.on('dialog', (dialog) => void dialog.dismiss());
    const problems: Problem[] = [];
    const open = async () => {
      await page.goto(`/#/${slug.replace('{id}', projectId)}`);
      await page.getByRole('combobox', { name: 'Current project' }).selectOption(projectId).catch(() => undefined);
      await page.waitForLoadState('networkidle');
    };
    await open();
    const top = (await controlNames(page)).filter((name) => !SKIP.test(name));
    let clicks = 0;
    for (const name of top) {
      await press(page, slug, [name], problems);
      clicks += 1;
      const revealed = (await controlNames(page)).filter((inner) => !top.includes(inner) && !SKIP.test(inner)).slice(0, MAX_NESTED);
      for (const inner of revealed) {
        await open();
        await press(page, slug, [name, inner], problems);
        clicks += 1;
      }
      await open();
    }
    console.log(`AUDIT #/${slug}: ${clicks} clicks, ${problems.length} problems`);
    for (const p of problems) console.log(`AUDIT-PROBLEM #/${p.page} [${p.path}] ${p.error}`);
    expect(problems, `problems on #/${slug}`).toEqual([]);
  });
}
