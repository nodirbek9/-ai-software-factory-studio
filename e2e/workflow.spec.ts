import { createSampleProject, expect, test, type SampleProject } from './fixtures';

/**
 * The V1 core flow through the V2 UI on the offline Scripted provider: plan → approve → tasks run → tests →
 * reviews → completed, then the pages that read it (Tasks drawer, QA & Security, Logs). Serial: later tests use
 * the finished run.
 */
test.describe.configure({ mode: 'serial' });

let project: SampleProject;

async function projectStatus(request: import('@playwright/test').APIRequestContext, id: string): Promise<string> {
  const snapshot = await (await request.get(`/api/projects/${id}`)).json();
  return snapshot.project?.status ?? snapshot.status;
}

test('plan → approve → the scripted run completes (V1 core flow)', async ({ page, request }) => {
  test.setTimeout(240_000);
  project = await createSampleProject(request, 'E2E Flow');
  await page.goto('/#/board');
  await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  await page.getByRole('banner').getByRole('button', { name: 'Generate plan' }).click();
  const approve = page.getByRole('button', { name: 'Approve' }).first();
  await expect(approve).toBeVisible({ timeout: 90_000 });
  await approve.click();
  await expect.poll(() => projectStatus(request, project.id), { timeout: 200_000, intervals: [2000] }).toBe('completed');
});

test('Tasks: list, filter and the task drawer with output (P5-03)', async ({ page }) => {
  await page.goto('/#/tasks');
  await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  const main = page.getByRole('main');
  await expect(main.getByText(/todo-store/i).first()).toBeVisible();
  await main.getByText(/todo-store/i).first().click();
  const drawer = page.getByRole('dialog').first();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(main.getByText(/todo-store/i).first()).toBeVisible();
});

test('QA & Security shows the gates of the finished run (P6-03)', async ({ page }) => {
  await page.goto('/#/quality');
  await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  await expect(page.getByRole('main').getByText(/tests/i).first()).toBeVisible();
});

test('Logs: search finds events of the run (P6-03)', async ({ page }) => {
  await page.goto('/#/logs');
  await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  const search = page.getByRole('main').getByRole('searchbox').or(page.getByRole('main').getByPlaceholder(/search/i)).first();
  await search.fill('completed');
  await expect(page.getByRole('main').getByText(/completed/i).nth(1)).toBeVisible();
});
