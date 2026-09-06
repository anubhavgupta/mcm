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

test('fits the viewport without horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await openNavigation(page);
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
  await page.getByRole('button', { name: 'Open inference picture-in-picture' }).click();
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
