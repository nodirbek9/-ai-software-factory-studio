import { createSampleProject, expect, test, type SampleProject } from './fixtures';
import type { Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

let project: SampleProject;

async function newScriptedSession(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New Session' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title (optional)').fill(title);
  await dialog.getByRole('button', { name: 'Create session' }).click();
  await expect(page.getByRole('region', { name: title })).toBeVisible();
}

async function send(page: Page, title: string, message: string): Promise<void> {
  const panel = page.getByRole('region', { name: title });
  await panel.getByLabel(`Message to ${title}`).fill(message);
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByText('I am the offline scripted provider', { exact: false }).first()).toBeVisible({ timeout: 30_000 });
}

test('six panels, scripted turns in two sessions, layout survives a reload (P3-05)', async ({ page, request }) => {
  project = await createSampleProject(request, 'E2E Workspace');
  await page.goto('/#/workspace');
  await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  await page.getByLabel('Layout preset').selectOption('6');
  await expect(page.getByText('Start a session')).toHaveCount(6);

  // Six open panels start no agent process: the budget stays empty until a message is sent.
  const idle = await (await request.get('/api/v2/budget')).json();
  expect(idle.running ?? idle.active ?? []).toHaveLength(0);

  await newScriptedSession(page, 'Alpha');
  await newScriptedSession(page, 'Beta');
  await send(page, 'Alpha', 'Hello from the E2E test');
  await send(page, 'Beta', 'Second session message');

  const sessions = await (await request.get(`/api/v2/projects/${project.id}/sessions`)).json();
  expect(sessions.map((s: { title: string }) => s.title).sort()).toEqual(['Alpha', 'Beta']);

  // Layout is saved (debounced) and restored after a reload.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Alpha' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Beta' })).toBeVisible();
  await expect(page.getByLabel('Layout preset')).toHaveValue('6');
  await expect(page.getByRole('region', { name: 'Alpha' }).getByText('Hello from the E2E test')).toBeVisible();
});

test('terminals: available on loopback, offered only in edit sessions (Phase 3c, D-019)', async ({ page, request }) => {
  const list = await (await request.get('/api/v2/terminals')).json();
  expect(list).toEqual({ terminals: [], unavailableReason: null });
  await page.goto('/#/workspace');
  await page.getByRole('combobox', { name: 'Current project' }).selectOption(project.id);
  // The Scripted provider cannot edit files, so its sessions are read-only and get no Terminal tab.
  const alpha = page.getByRole('region', { name: 'Alpha' });
  await expect(alpha.getByRole('tab', { name: 'Chat' })).toBeVisible();
  await expect(alpha.getByRole('tab', { name: 'Terminal' })).toHaveCount(0);
});
