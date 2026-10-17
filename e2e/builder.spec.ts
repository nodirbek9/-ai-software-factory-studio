import { createSampleProject, expect, test } from './fixtures';

test('Builder: Standard → Duplicate → Validate → Simulate → Run with live status (P4-05)', async ({ page, request }) => {
  test.setTimeout(240_000);
  const project = await createSampleProject(request, 'E2E Builder');
  await page.goto('/#/builder');
  await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  await expect(page.getByRole('combobox', { name: 'Workflow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await page.getByRole('button', { name: 'Duplicate this template' }).click();
  await expect(page.getByRole('button', { name: 'Rename' })).toBeEnabled();

  await page.getByRole('button', { name: /^Validate$/ }).click();
  await expect(page.getByRole('tab', { name: /Validation/ })).toBeVisible();

  await page.getByRole('button', { name: /^Simulate$/ }).click();
  await expect(page.getByRole('tab', { name: /Simulat/ })).toBeVisible();

  await page.getByRole('button', { name: /^Run$/ }).click();
  const approve = page.getByRole('button', { name: 'Approve' }).first();
  await page.goto('/#/board');
  await expect(approve).toBeVisible({ timeout: 90_000 });
  await approve.click();
  await expect.poll(async () => {
    const runs = await (await request.get(`/api/v2/projects/${project.id}/runs`)).json();
    const list = runs.runs ?? runs;
    return list[0]?.status;
  }, { timeout: 200_000, intervals: [2000] }).toBe('completed');

  await page.goto('/#/builder');
  await expect(page.getByText('Completed').first()).toBeVisible();
});
