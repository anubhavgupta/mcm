import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { decodeWorkspace, encodeWorkspace } from '../../src/shared/sharing';
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
    executableOverrides: {},
    modelsDirectory: path.resolve('tests/fixtures/models'),
    serverPort: await freePort(),
    upstreamUrl: '',
    anthropicMode: 'passthrough',
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

test('sharing defaults to the selected model with an explicit all-configurations option', async ({ page, request }) => {
    await jsonPut(request, '/api/workspace', {
      ...fixture,
      models: [...fixture.models, { id: 'other', name: 'Other model', model: { filename: 'other.gguf' }, values: {} }],
      groups: [...fixture.groups, { id: 'unused', name: 'Unused group', values: {} }],
    });
    await page.goto('/');
    await selectModel(page);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const scope = page.getByRole('combobox', { name: 'Share scope', exact: true });
    await expect(scope).toHaveValue('model');
    const link = page.getByRole('textbox', { name: 'Workspace share link', exact: true });
    const shared = decodeWorkspace(new URL(await link.inputValue()).hash.slice(8));
    expect(shared).toEqual(fixture);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download JSON', exact: true }).click();
    const file = await downloaded;
    expect(JSON.parse(await readFile((await file.path())!, 'utf8'))).toEqual(fixture);
    let pushed: unknown;
    await page.route('**/api/hf/push', route => {
      pushed = route.request().postDataJSON();
      return route.fulfill({ json: { url: 'https://huggingface.co/datasets/example/configs/blob/main/mcm/workspace.json' } });
    });
    await page.getByRole('textbox', { name: 'Dataset repository', exact: true }).fill('example/configs');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Push workspace', exact: true }).click();
    await expect.poll(() => pushed).toEqual({ repo: 'example/configs', modelId: 'tiny' });
    await scope.selectOption('workspace');
    await expect.poll(async () => decodeWorkspace(new URL(await link.inputValue()).hash.slice(8)).models.length).toBe(2);
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

test('records model-priced usage and keeps totals after reloading the page', async ({ page, request }) => {
  await page.goto('/');
  await selectModel(page);
  await page.getByRole('button', { name: 'Override Input price (USD / 1M tokens)', exact: true }).click();
  await page.getByRole('button', { name: 'Override Output price (USD / 1M tokens)', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Input price (USD / 1M tokens)', exact: true }).fill('1.5');
  await page.getByRole('spinbutton', { name: 'Output price (USD / 1M tokens)', exact: true }).fill('6');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].values)
    .toMatchObject({ inputUsdPerMillion: 1.5, outputUsdPerMillion: 6 });
  const before = (await bootstrap(request)).usage;
  await page.getByRole('button', { name: 'Launch model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
  for (const stream of [false, true]) {
    const response = await request.post('/v1/chat/completions', {
      data: { model: 'mock-model', messages: [{ role: 'user', content: 'Hello' }], stream },
    });
    expect(response.ok()).toBe(true);
    await response.body();
  }
  await expect.poll(async () => (await bootstrap(request)).usage.allTime.requestCount)
    .toBe(before.allTime.requestCount + 2);
  const after = (await bootstrap(request)).usage;
  for (const scope of ['allTime', 'session'] as const) {
    expect(after[scope].inputTokens - before[scope].inputTokens).toBe(20);
    expect(after[scope].outputTokens - before[scope].outputTokens).toBe(4);
    expect(after[scope].costUsd! - (before[scope].costUsd ?? 0)).toBeCloseTo(0.000054, 10);
  }
  const allTime = page.getByRole('region', { name: 'All-time usage', exact: true });
  const session = page.getByRole('region', { name: 'Current session usage', exact: true });
  await expect(allTime.locator('dd').nth(2)).toHaveText((after.allTime.inputTokens + after.allTime.outputTokens).toLocaleString());
  await expect(session.locator('.usage-cost strong')).toHaveText(new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: 5, maximumFractionDigits: 5,
  }).format(after.session.costUsd!));
  await page.reload();
  await expect(page.getByRole('region', { name: 'All-time usage', exact: true }).locator('dd').nth(2))
    .toHaveText((after.allTime.inputTokens + after.allTime.outputTokens).toLocaleString());
  expect((await bootstrap(request)).usage).toEqual(after);
});

test('pricing overrides validate amounts, preserve zero and reset to inheritance', async ({ page, request }) => {
  await page.goto('/');
  await selectModel(page);
  const input = page.getByRole('spinbutton', { name: 'Input price (USD / 1M tokens)', exact: true });
  await expect(input).toBeDisabled();
  await page.getByRole('button', { name: 'Override Input price (USD / 1M tokens)', exact: true }).click();
  await input.fill('-1');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Minimum is 0');
  await input.fill('0');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].values.inputUsdPerMillion).toBe(0);
  await page.getByRole('button', { name: 'Reset Input price (USD / 1M tokens) to inherited', exact: true }).click();
  await expect(input).toHaveValue('0.25');
  await expect(input).toBeDisabled();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].values.inputUsdPerMillion).toBeUndefined();
  await page.getByRole('button', { name: 'Edit details', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('spinbutton')).toHaveCount(0);
});

test('base token prices provide a configurable fallback for a model without pricing', async ({ page, request }) => {
  await page.goto('/');
  const input = page.getByRole('spinbutton', { name: 'Input price (USD / 1M tokens)', exact: true });
  const output = page.getByRole('spinbutton', { name: 'Output price (USD / 1M tokens)', exact: true });
  await expect(input).toHaveValue('0.25');
  await expect(output).toHaveValue('2');
  await page.getByRole('button', { name: 'Override Input price (USD / 1M tokens)', exact: true }).click();
  await page.getByRole('button', { name: 'Override Output price (USD / 1M tokens)', exact: true }).click();
  await input.fill('0.5');
  await output.fill('3');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.base)
    .toMatchObject({ inputUsdPerMillion: 0.5, outputUsdPerMillion: 3 });
  const before = (await bootstrap(request)).usage;
  await selectModel(page);
  await page.getByRole('button', { name: 'Launch model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
  const response = await request.post('/v1/chat/completions', {
    data: { model: 'arbitrary-name', messages: [{ role: 'user', content: 'Hello' }], stream: false },
  });
  expect(response.ok()).toBe(true);
  await expect.poll(async () => (await bootstrap(request)).usage.session.requestCount)
    .toBe(before.session.requestCount + 1);
  const after = (await bootstrap(request)).usage;
  expect(after.session.costUsd! - (before.session.costUsd ?? 0)).toBeCloseTo(0.000011, 10);
  expect(after.session.unpricedTokens).toBe(before.session.unpricedTokens);
  await expect(page.getByRole('region', { name: 'Current session usage' })).toContainText('Estimated token value');
});

test('pricing cards inherit group rates, allow model overrides and apply them to token value', async ({ page, request }) => {
  await jsonPut(request, '/api/workspace', {
    ...fixture,
    base: { ...fixture.base, inputUsdPerMillion: 0.5, outputUsdPerMillion: 3 },
    groups: [{ ...fixture.groups[0], values: { ...fixture.groups[0].values, outputUsdPerMillion: 4 } }],
  });
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: 'Coding', exact: true }).click();
  const input = page.getByRole('spinbutton', { name: 'Input price (USD / 1M tokens)', exact: true });
  const output = page.getByRole('spinbutton', { name: 'Output price (USD / 1M tokens)', exact: true });
  await expect(input).toHaveValue('0.5');
  await expect(input).toBeDisabled();
  await expect(output).toHaveValue('4');
  await expect(output).toBeEnabled();
  await page.getByRole('button', { name: 'Override Input price (USD / 1M tokens)', exact: true }).click();
  await input.fill('0.75');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.groups[0].values.inputUsdPerMillion).toBe(0.75);
  await selectModel(page);
  await expect(input).toHaveValue('0.75');
  await expect(output).toHaveValue('4');
  await expect(output).toBeDisabled();
  const inputCard = page.locator('.field-card').filter({ has: input });
  await expect(inputCard.locator('.origin-badge')).toHaveText('Group');
  await page.getByRole('button', { name: 'Override Input price (USD / 1M tokens)', exact: true }).click();
  await input.fill('0');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].values.inputUsdPerMillion).toBe(0);
  await expect(inputCard.locator('.origin-badge')).toHaveText('Model');
  const before = (await bootstrap(request)).usage.session;
  await page.getByRole('button', { name: 'Launch model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
  await request.post('/v1/chat/completions', { data: { messages: [{ role: 'user', content: 'Hello' }], stream: true } });
  await expect.poll(async () => (await bootstrap(request)).usage.session.requestCount).toBe(before.requestCount + 1);
  expect((await bootstrap(request)).usage.session.costUsd! - (before.costUsd ?? 0)).toBeCloseTo(0.000008, 10);
  await page.getByRole('button', { name: 'Reset Input price (USD / 1M tokens) to inherited', exact: true }).click();
  await expect(input).toHaveValue('0.75');
  await expect(inputCard.locator('.origin-badge')).toHaveText('Group');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
});

test('optional Anthropic translation exposes live timing and valued usage before completion', async ({ page, request }) => {
  await jsonPut(request, '/api/workspace', {
    ...fixture, models: [{ ...fixture.models[0], values: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 } }],
  });
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  const mode = page.getByRole('combobox', { name: 'Anthropic proxy mode', exact: true });
  await expect(mode).toHaveValue('passthrough');
  await mode.selectOption('openai');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).settings.anthropicMode).toBe('openai');
  await selectModel(page);
  await page.getByRole('button', { name: 'Launch model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
  const before = (await bootstrap(request)).usage;
  let completed = false;
  const requestData = { model: 'mock-model', max_tokens: 128, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'Hello' }] };
  const responsePromise = request.post('/v1/messages', {
    headers: { 'anthropic-version': '2023-06-01' },
    data: { ...requestData, stream: true },
  }).then(response => { completed = true; return response; });
  try {
    await expect(page.getByText('125.5', { exact: true })).toBeVisible();
    await expect(page.getByText('32.5', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Current session usage', exact: true }).locator('dd').nth(1))
      .toHaveText((before.session.outputTokens + 1).toLocaleString());
    expect((await bootstrap(request)).usage.session.costUsd! - (before.session.costUsd ?? 0)).toBeCloseTo(0.000024, 10);
    expect(completed).toBe(false);
  } finally { await responsePromise; }
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('text/event-stream');
  const stream = await response.text();
  expect(stream).toMatch(/event:\s*message_start/);
  expect(stream).toMatch(/event:\s*message_stop/);
  expect(stream).not.toContain('"choices"');
  expect(stream).not.toContain('[DONE]');
  await expect.poll(async () => (await bootstrap(request)).usage.session.outputTokens).toBe(before.session.outputTokens + 2);
  const json = await request.post('/v1/messages', { data: { ...requestData, stream: false } });
  expect(json.ok()).toBe(true);
  expect(await json.json()).toMatchObject({
    type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello' }],
    usage: { input_tokens: 10, output_tokens: 2 },
  });
  await page.reload();
  await openNavigation(page);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await expect(mode).toHaveValue('openai');
});

test('both usage rows update while an inference stream is still running', async ({ page, request }) => {
  await page.goto('/');
  await selectModel(page);
  await expect(page.getByText('Measured throughput, not estimates.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Launch model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
  const before = (await bootstrap(request)).usage;
  let finished = false;
  const responsePromise = request.post('/v1/chat/completions', {
    data: { messages: [{ role: 'user', content: 'Hello' }], stream: true, timings_per_token: true },
  }).then(response => { finished = true; return response; });
  try {
    for (const [label, scope] of [['All-time usage', 'allTime'], ['Current session usage', 'session']] as const) {
      const row = page.getByRole('region', { name: label, exact: true });
      await expect(row.locator('dd').nth(0)).toHaveText((before[scope].inputTokens + 10).toLocaleString());
      await expect(row.locator('dd').nth(1)).toHaveText((before[scope].outputTokens + 1).toLocaleString());
    }
    expect(finished).toBe(false);
  } finally { await responsePromise; }
  await expect(page.getByRole('region', { name: 'Current session usage', exact: true }).locator('dd').nth(1))
    .toHaveText((before.session.outputTokens + 2).toLocaleString());
});

test('combines speculation methods and launches with draft settings without order controls', async ({ page, request }) => {
  await page.goto('/');
  await selectModel(page);
  await page.getByRole('button', { name: 'Override Speculation', exact: true }).click();
  await page.getByRole('checkbox', { name: 'ngram-mod', exact: true }).check();
  await expect(page.getByRole('combobox', { name: 'Draft model', exact: true })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'draft-simple', exact: true }).check();
  await expect(page.getByRole('button', { name: /Move .* (up|down)/ })).toHaveCount(0);
  await expect(page.getByText('Requested CLI order', { exact: true })).toHaveCount(0);
  const draft = page.getByRole('combobox', { name: 'Draft model', exact: true });
  await expect(draft).toBeVisible();
  await expect(draft).toBeDisabled();
  await page.getByRole('button', { name: 'Override Draft model', exact: true }).click();
  await draft.selectOption('mock-draft.gguf');
  await page.getByRole('button', { name: 'Override Draft GPU layers', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Draft GPU layers', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].values).toMatchObject({
    speculation: 'ngram-mod,draft-simple', draftModel: 'mock-draft.gguf', draftGpuLayers: 0,
  });
  await page.reload();
  await selectModel(page);
  await expect(draft).toHaveValue('mock-draft.gguf');
  await expect(page.getByRole('checkbox', { name: 'draft-simple', exact: true })).toBeChecked();
  const preview = await request.post('/api/preview', { data: { modelId: 'tiny' } });
  expect(preview.ok()).toBe(true);
  const { args } = await preview.json() as { args: string[] };
  expect(args[args.indexOf('--spec-type') + 1]).toBe('ngram-mod,draft-simple');
  expect(args[args.indexOf('--spec-draft-model') + 1]).toBe(path.resolve('tests/fixtures/models/mock-draft.gguf'));
  expect(args[args.indexOf('--spec-draft-ngl') + 1]).toBe('0');
  await page.getByRole('button', { name: 'Launch model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
});

test('speculation inherits selected methods and MTP does not require an external draft file', async ({ page, request }) => {
  await jsonPut(request, '/api/workspace', {
    ...fixture,
    groups: [{ ...fixture.groups[0], values: { speculation: 'ngram-mod,draft-mtp', draftMax: 8 } }],
  });
  await page.goto('/');
  await selectModel(page);
  await expect(page.getByRole('checkbox', { name: 'draft-mtp', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'draft-mtp', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Draft model', exact: true })).toHaveCount(0);
  await expect(page.getByRole('spinbutton', { name: 'Maximum draft tokens', exact: true })).toHaveValue('8');
  await page.getByRole('button', { name: 'Override Speculation', exact: true }).click();
  await page.getByRole('checkbox', { name: 'draft-mtp', exact: true }).uncheck();
  await page.getByRole('checkbox', { name: 'ngram-mod', exact: true }).uncheck();
  await expect(page.getByRole('spinbutton', { name: 'Maximum draft tokens', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].values.speculation).toBe('none');
  await page.getByRole('button', { name: 'Reset Speculation to inherited', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'draft-mtp', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].values.speculation).toBeUndefined();
});

test('draft bindings stay selected after discovery and remain separate from portable settings', async ({ page, request }) => {
  await jsonPut(request, '/api/workspace', {
    ...fixture, base: { speculation: 'draft-simple', draftModel: 'portable-draft.gguf' },
  });
  await jsonPut(request, '/api/settings', {
    draftModelBindings: { tiny: 'mock-draft.gguf' }, modelBindings: { tiny: 'mock-model.gguf' },
  });
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  const binding = page.getByRole('combobox', { name: 'Draft file for Tiny coder', exact: true });
  await expect(binding).toHaveValue('mock-draft.gguf');
  await expect(binding.getByRole('option', { name: /mock-draft.gguf.*GB/ })).toHaveCount(1);
  await expect(binding).toHaveValue('mock-draft.gguf');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await bootstrap(request)).settings.draftModelBindings).toEqual({ tiny: 'mock-draft.gguf' });
  const preview = await request.post('/api/preview', { data: { modelId: 'tiny' } });
  expect(preview.ok()).toBe(true);
  const { args } = await preview.json() as { args: string[] };
  expect(args[args.indexOf('--spec-draft-model') + 1]).toBe(path.resolve('tests/fixtures/models/mock-draft.gguf'));
  expect((await bootstrap(request)).workspace).not.toHaveProperty('draftModelBindings');
});

test('dropdown chevrons remain centered with consistent clearance in cards and dialogs', async ({ page }) => {
  await page.goto('/');
  const assertChevron = async (select: import('@playwright/test').Locator) => {
    await expect(select).toBeVisible();
    expect(await select.evaluate(element => {
      const style = getComputedStyle(element);
      return {
        appearance: style.appearance, position: style.backgroundPosition,
        size: style.backgroundSize, repeat: style.backgroundRepeat,
        padding: style.paddingRight, hasIcon: style.backgroundImage.startsWith('url('),
      };
    })).toEqual({
      appearance: 'none', position: 'calc(100% - 10px) 50%', size: '16px 16px',
      repeat: 'no-repeat', padding: '36px', hasIcon: true,
    });
  };
  await assertChevron(page.getByRole('combobox', { name: 'Load mode', exact: true }));
  await assertChevron(page.getByRole('combobox', { name: 'Key cache type', exact: true }));
  await openNavigation(page);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await assertChevron(page.getByRole('combobox', { name: 'Anthropic proxy mode', exact: true }));
});

test('dialog headers and footers remain fixed while their bodies scroll', async ({ page }) => {
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const lastAction of ['Save settings', 'Done']) {
    const header = dialog.locator('.dialog-header');
    const before = await header.boundingBox();
    const footer = dialog.locator('.dialog-actions');
    const footerBefore = await footer.boundingBox();
    await expect(dialog.getByRole('button', { name: lastAction, exact: true })).toBeInViewport();
    const body = dialog.locator('.dialog-body');
    await expect.poll(() => body.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const after = await header.boundingBox();
    const footerAfter = await footer.boundingBox();
    expect(after!.y).toBeCloseTo(before!.y, 1);
    expect(after!.height).toBeCloseTo(before!.height, 1);
    expect(Math.abs(footerAfter!.y - footerBefore!.y)).toBeLessThanOrEqual(1);
    expect(await dialog.evaluate(element => element.scrollTop)).toBe(0);
    await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: lastAction, exact: true })).toBeInViewport();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    if (lastAction === 'Save settings') await page.getByRole('button', { name: 'Share', exact: true }).click();
  }
});

test('Machine Settings checks the unsaved executable version before saving', async ({ page, request }) => {
  await page.goto('/');
  await openNavigation(page);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const other = path.resolve('tests/fixtures/llama-server-other.mjs');
  await dialog.getByRole('textbox', { name: 'llama-server executable path', exact: true }).fill(other);
  await dialog.getByRole('button', { name: 'Check version', exact: true }).click();
  await expect(dialog.getByText('b9001 (fedcba98)', { exact: true })).toBeVisible();
  expect((await bootstrap(request)).settings.executablePath).toBe(path.resolve('tests/fixtures/llama-server.mjs'));
  await dialog.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).settings.executablePath).toBe(other);
  expect((await bootstrap(request)).workspace.llamaVersion).toBe('b9001 (fedcba98)');
});

test('executable overrides inherit locally and shared version mismatches warn without blocking launch', async ({ page, request }) => {
  await page.goto('/');
  const input = page.getByRole('textbox', { name: 'llama-server executable path', exact: true });
  const machine = path.resolve('tests/fixtures/llama-server.mjs');
  const other = path.resolve('tests/fixtures/llama-server-other.mjs');
  await expect(input).toHaveValue(machine);
  await expect(input).toBeDisabled();
  await page.getByRole('button', { name: 'Override executable path', exact: true }).click();
  await input.fill(path.resolve('tests/fixtures/missing-server'));
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).settings.executableOverrides?.base).toContain('missing-server');
  await openNavigation(page);
  await page.getByRole('button', { name: 'Coding', exact: true }).click();
  await page.getByRole('button', { name: 'Override executable path', exact: true }).click();
  await input.fill(machine);
  await page.getByRole('button', { name: 'Check version', exact: true }).click();
  await expect(page.getByText('b9000 (abcdef12)', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).settings.executableOverrides?.groups?.coding).toBe(machine);
  await selectModel(page);
  await expect(input).toHaveValue(machine);
  await expect(input).toBeDisabled();
  await page.getByRole('button', { name: 'Override executable path', exact: true }).click();
  await input.fill(other);
  await page.getByRole('button', { name: 'Check version', exact: true }).click();
  await expect(page.locator('.executable-version-check .support-warning')).toContainText('b9000 (abcdef12)');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).workspace.models[0].llamaVersion).toBe('b9001 (fedcba98)');
  const preview = await request.post('/api/preview', { data: { modelId: 'tiny' } });
  expect((await preview.json()).executable).toBe(other);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const share = await page.getByRole('textbox', { name: 'Workspace share link', exact: true }).inputValue();
  const exported = decodeWorkspace(new URL(share).hash.slice(8));
  expect(exported.models[0].llamaVersion).toBe('b9001 (fedcba98)');
  expect(JSON.stringify(exported)).not.toContain(other);
  expect(JSON.stringify(exported)).not.toContain('executableOverrides');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Reset executable path to inherited', exact: true }).click();
  await expect(input).toHaveValue(machine);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).settings.executableOverrides?.models?.tiny).toBeUndefined();
  await page.getByRole('button', { name: 'Launch model', exact: true }).click();
  await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
  await expect(page.locator('.executable-card .support-warning')).toContainText('b9001 (fedcba98)');
  await expect(page.locator('.executable-card .support-warning')).toContainText('b9000 (abcdef12)');
});

test('fits the viewport without horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await openNavigation(page);
  await expect(page.getByText('My workspace', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Machine settings', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('inference floats and restores when native picture-in-picture is unavailable', async ({ page, request }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'documentPictureInPicture', { value: undefined }));
  const usage = (await bootstrap(request)).usage;
  usage.allTime.unpricedTokens = 7741;
  await page.route('**/api/events', route => route.fulfill({
    contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'usage', data: usage })}\n\n`,
  }));
  await page.goto('/');
  await expect(page.locator('.usage-unpriced-note')).toBeVisible();
  const pipButton = page.getByRole('button', { name: 'Open inference picture-in-picture' });
  await expect(page.locator('.runtime-card').filter({ has: pipButton }).getByRole('heading', { name: 'Inference', exact: true })).toBeVisible();
  await expect(pipButton).toHaveText('');
  await expect(pipButton.locator('svg')).toHaveCount(1);
  await pipButton.click();
  const floating = page.getByRole('region', { name: 'Floating inference card' });
  await expect(floating.getByText('Token generation', { exact: false })).toBeVisible();
  await expect(floating.locator('.usage-unpriced-note')).toBeHidden();
  await expect(floating.locator('.usage-summary-note')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(floating.getByRole('heading', { name: 'Executable', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Server logs', exact: true })).toBeVisible();
  await floating.getByRole('button', { name: 'Return inference to page' }).click();
  await expect(floating).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open inference picture-in-picture' })).toBeVisible();
  await expect(page.locator('.usage-unpriced-note')).toBeVisible();
  await expect(page.locator('.usage-summary-note')).toBeVisible();
});

test('native inference picture-in-picture restores after closing its window', async ({ request }) => {
  const browser = await chromium.launch({ channel: 'chromium', args: ['--screen-info={1920x1080}'] });
  try {
    const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined, isMobile: false, hasTouch: false });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:17838/');
    test.skip(!await page.evaluate(() => !!window.documentPictureInPicture), 'Document PiP is not supported by this browser.');
    const opened = context.waitForEvent('page');
    await page.getByRole('button', { name: 'Open inference picture-in-picture' }).click();
    const pip = await opened;
    await expect(pip.getByText('MCM Inference', { exact: true })).toHaveCount(0);
    await expect(pip.getByRole('button', { name: 'Return inference to page' })).toHaveCount(0);
    await expect(pip.getByRole('heading', { name: 'Inference', exact: true })).toBeVisible();
    await expect.poll(() => pip.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(320);
    await expect.poll(() => pip.evaluate(() => window.innerHeight -
      document.querySelector('.runtime-detached')!.getBoundingClientRect().height)).toBeGreaterThanOrEqual(28);
    await expect.poll(() => pip.evaluate(() => window.innerHeight -
      document.querySelector('.runtime-detached')!.getBoundingClientRect().height)).toBeLessThanOrEqual(40);
    await expect(pip.locator('.usage-summary-note')).toBeHidden();
    expect(await pip.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(pip.getByRole('heading', { name: 'Executable', exact: true })).toHaveCount(0);
    await expect(pip.getByRole('log')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Executable', exact: true })).toBeVisible();
    await expect(pip.getByText('Token generation', { exact: false })).toBeVisible();
    const launch = await request.post('/api/launch', { data: { modelId: 'tiny' } });
    expect(launch.ok()).toBe(true);
    await expect.poll(async () => (await bootstrap(request)).status.phase).toBe('ready');
    await request.post('/v1/chat/completions', { data: { messages: [{ role: 'user', content: 'Hello' }], stream: true } });
    await expect(pip.getByText('32.5', { exact: true })).toBeVisible();
    await expect(pip.locator('.token-counts')).toContainText('Request input');
    await expect.poll(() => pip.evaluate(() => Math.abs(window.innerHeight -
      document.querySelector('.runtime-detached')!.getBoundingClientRect().height))).toBeLessThanOrEqual(12);
    await expect(page.getByRole('log')).toContainText('Fixture model ready');
    await pip.close();
    await expect(page.getByRole('button', { name: 'Open inference picture-in-picture' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Runtime', exact: true })).toBeVisible();
    await expect(page.getByText('32.5', { exact: true })).toBeVisible();
  } finally { await browser.close(); }
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
