import { expect, test as base, type APIRequestContext, type Page } from '@playwright/test';

export { expect };

/** Fails the test on page errors and console errors (P1-04); ignores the browser's favicon and aborted-SSE noise. */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/favicon|ERR_ABORTED|net::ERR_INCOMPLETE_CHUNKED_ENCODING/.test(text)) return;
      errors.push(text);
    });
    await use(errors);
    expect(errors, 'console errors').toEqual([]);
  }, { auto: true }],
});

export interface SampleProject {
  id: string;
  name: string;
}

/** Creates the bundled todo-service sample through the API (the same call the New Project dialog makes). */
export async function createSampleProject(request: APIRequestContext, name: string): Promise<SampleProject> {
  const response = await request.post('/api/projects', {
    data: { name, spec: '', workspaceMode: 'sample', sampleName: 'todo-service', testCommand: 'npm test' },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json();
  const project = body.project ?? body;
  return { id: project.id, name: project.name };
}

export async function openView(page: Page, slug: string): Promise<void> {
  await page.goto(`/#/${slug}`);
  await expect(page.locator('h1').first()).toBeVisible();
}
