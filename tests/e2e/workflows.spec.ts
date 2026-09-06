import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { encodeWorkspace } from '../../src/shared/sharing';
import type { Bootstrap, Workspace } from '../../src/shared/types';

const fixture: Workspace = {
  version: 1,
  base: { temperature: 0.7, topK: 20 },
  groups: [{ id: 'coding', name: 'Coding', values: { temperature: 0.3 } }],
  models: [{
    id: 'tiny', name: 'Tiny coder', model: { filename: 'mock-model.gguf' },
    groupId: 'coding', values: { topK: 0 },
  }],
};

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No available test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function jsonPut(request: APIRequestContext, endpoint: string, data: unknown) {
  const response = await request.put(endpoint, { data });
  expect(response.ok(), await response.text()).toBe(true);
}

async function bootstrap(request: APIRequestContext): Promise<Bootstrap> {
  return (await request.get('/api/bootstrap')).json();
}

async function openNavigation(page: Page) {
  await page.getByRole('region', { name: 'Server controls' }).waitFor();
  const navigationToggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await navigationToggle.isVisible()) await navigationToggle.click();
}

async function selectModel(page: Page) {
  await openNavigation(page);
  await page.getByText('Tiny coder', { exact: true }).first().click();
}

test.beforeEach(async ({ request }) => {
  await request.post('/api/stop');
  await jsonPut(request, '/api/workspace', fixture);
  await jsonPut(request, '/api/settings', {
    executablePath: path.resolve('tests/fixtures/llama-server.mjs'),
    modelsDirectory: path.resolve('tests/fixtures/models'),
    serverPort: await freePort(),
    upstreamUrl: '',
    modelBindings: {},
    hfRepo: '',
    clearHfToken: true,
  });
});

test.afterEach(async ({ request }) => {
  await request.post('/api/stop');
});

test('shows inherited configuration and saves explicit model overrides', async ({ page, request }) => {
  await page.goto('/');
  await selectModel(page);
  const temperature = page.getByRole('spinbutton', { name: 'Temperature', exact: true });
  await expect(temperature).toHaveValue('0.3');
  await expect(page.getByRole('spinbutton', { name: 'Top K', exact: true })).toHaveValue('0');
  const override = page.getByRole('button', { name: /override temperature/i });
  if (await override.isVisible()) await override.click();
  await temperature.fill('0');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].values.temperature).toBe(0);
  await page.reload();
  await selectModel(page);
  await expect(page.getByRole('spinbutton', { name: 'Temperature', exact: true })).toHaveValue('0');
});

test('dependent settings follow effective configuration', async ({ page }) => {
  await page.goto('/');
  await selectModel(page);
  const toggle = page.getByRole('checkbox', { name: 'Customize KV cache types', exact: true });
  const override = page.getByRole('button', { name: /override customize KV cache types/i });
  if (await override.isVisible()) await override.click();
  await toggle.check();
  const keyCache = page.getByRole('combobox', { name: 'Key cache type', exact: true });
  await expect(keyCache).toBeVisible();
  const cacheOverride = page.getByRole('button', { name: /override key cache type/i });
  if (await cacheOverride.isVisible()) await cacheOverride.click();
  await keyCache.selectOption('q8_0');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await toggle.uncheck();
  await expect(keyCache).toBeDisabled();
});

test('deep-links require confirmation and never replace machine settings', async ({ page, request }) => {
  const before = (await bootstrap(request)).settings;
  const imported: Workspace = {
    ...fixture,
    models: [{ ...fixture.models[0], name: 'Shared model', values: { temperature: 0.15 } }],
  };
  await page.goto(`/#config=${encodeWorkspace(imported)}`);
  await expect(page.getByRole('dialog')).toBeVisible();
  expect((await bootstrap(request)).workspace.models[0].name).toBe('Tiny coder');
  await page.getByRole('button', { name: /import workspace|confirm import|replace workspace/i }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].name).toBe('Shared model');
  expect((await bootstrap(request)).settings).toEqual(before);
  expect((await bootstrap(request)).status.phase).toBe('stopped');
});

test('malformed links surface an error without replacing workspace', async ({ page, request }) => {
  await page.goto('/#config=not-valid-json');
  await expect(page.getByRole('alert')).toContainText(/invalid|unsupported/i);
  expect((await bootstrap(request)).workspace).toEqual(fixture);
});

test('creates groups and models with a real inherited false override', async ({ page, request }) => {
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: 'New group', exact: true }).click();
  await page.getByRole('textbox', { name: 'Group name', exact: true }).fill('Writing');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await openNavigation(page);
  await page.getByRole('button', { name: 'New model', exact: true }).click();
  await page.getByRole('textbox', { name: 'Model name', exact: true }).fill('Writing model');
  await page.getByRole('combobox', { name: 'GGUF model', exact: true }).selectOption('mock-model.gguf');
  await page.getByRole('combobox', { name: 'Configuration group', exact: true }).selectOption({ label: 'Writing' });
  await page.getByRole('button', { name: 'Create model', exact: true }).click();
  await page.getByRole('button', { name: 'Override Jinja templates', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Jinja templates', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => {
    const { workspace } = await bootstrap(request);
    const model = workspace.models.find(item => item.name === 'Writing model');
    return {
      jinja: model?.values.jinja,
      group: workspace.groups.find(group => group.id === model?.groupId)?.name,
    };
  }).toEqual({ jinja: false, group: 'Writing' });
});

test('selecting a discovered model fills its configuration name automatically', async ({ page, request }) => {
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: 'New model', exact: true }).click();
  await page.getByRole('combobox', { name: 'GGUF model', exact: true }).selectOption('mock-model.gguf');
  await expect(page.getByRole('textbox', { name: 'Model name', exact: true })).toHaveValue('mock-model');
  await page.getByRole('button', { name: 'Create model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models.find(model => model.name === 'mock-model')?.model.filename).toBe('mock-model.gguf');
});

test('model discovery errors can be retried without entering a filename', async ({ page }) => {
  let fail = true;
  await page.route('**/api/models', route => route.fulfill(fail
    ? { status: 400, json: { error: 'Models directory is missing.' } }
    : { json: { models: [{ filename: 'restored.gguf', relativePath: 'restored.gguf', size: 123 }] } }));
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: 'New model', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Models directory is missing');
  fail = false;
  await page.getByRole('button', { name: 'Refresh models', exact: true }).click();
  await page.getByRole('combobox', { name: 'GGUF model', exact: true }).selectOption('restored.gguf');
  await expect(page.getByRole('textbox', { name: 'Model name', exact: true })).toHaveValue('restored');
});

test('Hugging Face exchange requires explicit push and confirmed pull', async ({ page, request }) => {
  await jsonPut(request, '/api/settings', { hfRepo: 'example/configs', hfToken: 'synthetic-test-token' });
  const before = (await bootstrap(request)).settings;
  expect(before).not.toHaveProperty('hfToken');
  let pushedRepo: unknown;
  await page.route('**/api/hf/push', async route => {
    pushedRepo = route.request().postDataJSON();
    await route.fulfill({ json: { url: 'https://huggingface.co/datasets/example/configs/blob/main/mcm/workspace.json' } });
  });
  await page.route('**/api/hf/pull', async route => {
    await route.fulfill({
      json: { workspace: { ...fixture, models: [{ ...fixture.models[0], name: 'From Hugging Face' }] } },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Push workspace', exact: true }).click();
  await expect.poll(() => pushedRepo).toEqual({ repo: 'example/configs' });
  await page.getByRole('button', { name: 'Preview pull', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Replace workspace', exact: true })).toBeVisible();
  expect((await bootstrap(request)).workspace).toEqual(fixture);
  await page.getByRole('button', { name: 'Replace workspace', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].name).toBe('From Hugging Face');
  expect((await bootstrap(request)).settings).toEqual(before);
});

test('JSON backup excludes machine settings and can be imported with review', async ({ page, request }) => {
  await jsonPut(request, '/api/settings', { hfToken: 'synthetic-private-test-token' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
  const download = await downloadPromise;
  const filePath = await download.path();
  expect(filePath).not.toBeNull();
  const contents = await readFile(filePath!, 'utf8');
  expect(JSON.parse(contents)).toEqual(fixture);
  expect(contents).not.toContain('synthetic-private-test-token');
  expect(contents).not.toContain('executablePath');
  const imported = { ...fixture, base: { temperature: 0.1 } };
  await page.getByLabel('Import workspace JSON').setInputFiles({
    name: 'workspace.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.getByRole('button', { name: 'Replace workspace', exact: true })).toBeVisible();
  expect((await bootstrap(request)).workspace.base).toEqual(fixture.base);
  await page.getByRole('button', { name: 'Replace workspace', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.base).toEqual(imported.base);
});

test('launch, proxy inference, and stop work through the UI', async ({ page, request }) => {
  await page.goto('/');
  await selectModel(page);
  await page.getByRole('button', { name: 'Launch model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase, { timeout: 15_000 }).toBe('ready');
  // Changing the next launch port must not disconnect traffic from the current child.
  await jsonPut(request, '/api/settings', { serverPort: await freePort() });
  const response = await request.post('/v1/chat/completions', {
    data: { model: 'mock-model', messages: [{ role: 'user', content: 'Hello' }], stream: true },
  });
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('text/event-stream');
  expect(await response.text()).toContain('[DONE]');
  await expect(page.getByText('32.5', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Request timings', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Restart server', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase, { timeout: 15_000 }).toBe('ready');
  await page.getByRole('button', { name: 'Stop server', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('stopped');
});

test('fits the viewport without horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await openNavigation(page);
  await expect(page.getByRole('button', { name: 'Machine settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('inference floats and restores when native picture-in-picture is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open inference picture-in-picture' }).click();
  const floating = page.getByRole('region', { name: 'Floating inference card' });
  await expect(floating.getByText('Token generation', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(floating.getByRole('heading', { name: 'Executable', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Server logs', exact: true })).toBeVisible();
  await floating.getByRole('button', { name: 'Return inference to page' }).click();
  await expect(floating).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open inference picture-in-picture' })).toBeVisible();
});

test('native inference picture-in-picture restores after closing its window', async ({ page, context, request }) => {
  await page.goto('/');
  test.skip(!await page.evaluate(() => !!window.documentPictureInPicture), 'Document PiP is not supported by this browser.');
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open inference picture-in-picture' }).click();
  const pip = await opened;
  await expect(pip.getByRole('heading', { name: 'Inference', exact: true })).toBeVisible();
  await expect(pip.getByRole('heading', { name: 'Executable', exact: true })).toHaveCount(0);
  await expect(pip.getByRole('log')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Executable', exact: true })).toBeVisible();
  await expect(pip.getByText('Token generation', { exact: false })).toBeVisible();
  const launch = await request.post('/api/launch', { data: { modelId: 'tiny' } });
  expect(launch.ok()).toBe(true);
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
  await request.post('/v1/chat/completions', { data: { messages: [{ role: 'user', content: 'Hello' }], stream: true } });
  await expect(pip.getByText('32.5', { exact: true })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('Fixture model ready');
  await pip.close();
  await expect(page.getByRole('button', { name: 'Open inference picture-in-picture' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Runtime', exact: true })).toBeVisible();
  await expect(page.getByText('32.5', { exact: true })).toBeVisible();
});

test('picture-in-picture rejection leaves runtime on the page', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'documentPictureInPicture', {
    value: { requestWindow: () => Promise.reject(new Error('Permission denied')) },
  }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open inference picture-in-picture' }).click();
  await expect(page.getByRole('alert')).toContainText('Permission denied');
  await expect(page.getByRole('complementary', { name: 'Runtime', exact: true })).toBeVisible();
});
