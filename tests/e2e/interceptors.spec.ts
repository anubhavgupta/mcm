import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import type { InterceptorPipeline } from '../../src/shared/types';

async function openInterceptors(page: Page): Promise<void> {
  await page.getByRole('region', { name: 'Server controls' }).waitFor();
  const navigation = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await navigation.isVisible()) await navigation.click();
  await page.getByRole('button', { name: 'Interceptors', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Interceptors', exact: true })).toBeVisible();
  await expect(page.getByText('Token and cost telemetry', { exact: true })).toBeVisible();
}
async function add(page: Page, name: string, modulePath: string): Promise<void> {
  await page.getByLabel('Friendly name', { exact: true }).fill(name);
  await page.getByLabel('Absolute local module path', { exact: true }).fill(modulePath);
  await page.getByRole('checkbox', { name: 'I trust this module and allow it to execute with MCM’s permissions.' }).check();
  await page.getByRole('button', { name: 'Add interceptor', exact: true }).click();
}
async function pipeline(request: APIRequestContext): Promise<InterceptorPipeline> {
  return (await request.get('/api/interceptors')).json();
}
async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save interceptors', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Interceptors saved.' })).toBeVisible();
}
let upstream: Server | undefined;
test.beforeEach(async ({ request }) => {
  expect((await request.put('/api/interceptors', { data: { entries: [], trustedCodeAcknowledged: true } })).ok()).toBe(true);
});
test.afterEach(async ({ request }) => {
  await request.put('/api/interceptors', { data: { entries: [], trustedCodeAcknowledged: true } });
  await request.put('/api/settings', { data: { upstreamUrl: '' } });
  if (upstream) {
    await new Promise<void>(resolve => { upstream!.close(() => resolve()); upstream!.closeAllConnections(); });
    upstream = undefined;
  }
});

test('adds, sequences and removes trusted modules while keeping telemetry required', async ({ page, request }) => {
  test.setTimeout(60_000);
  upstream = createServer((incoming, response) => {
    incoming.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ tag: incoming.headers['x-mcm-request-id'] ?? null }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  await request.put('/api/settings', { data: { upstreamUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` } });
  const tag = async () => (await (await request.post('/v1/chat/completions', { data: {} })).json()).tag as string | null;
  await page.goto('/');
  await openInterceptors(page);
  const sequence = page.getByRole('list', { name: 'Interceptor sequence' });
  const required = sequence.getByRole('listitem').filter({ hasText: 'Token and cost telemetry' });
  await expect(required.getByText('Required', { exact: true })).toBeVisible();
  await expect(required.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save interceptors', exact: true })).toBeDisabled();
  await page.getByLabel('Friendly name', { exact: true }).fill('Request tag');
  await page.getByLabel('Absolute local module path', { exact: true }).fill(resolve('examples/request-tag.ts'));
  await page.getByRole('button', { name: 'Add interceptor', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Confirm that you trust this code');
  expect((await pipeline(request)).entries).toHaveLength(1);
  await page.getByRole('checkbox', { name: /I trust this module/ }).check();
  await page.getByRole('button', { name: 'Add interceptor', exact: true }).click();
  await add(page, 'Prefix tag', resolve('tests/fixtures/interceptor-prefix.ts'));
  expect((await pipeline(request)).entries).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Move Request tag up', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move Prefix tag down', exact: true })).toBeDisabled();
  await save(page);
  expect(await tag()).toMatch(/^tagged:[a-f0-9-]{36}$/);
  await page.getByRole('button', { name: 'Move Prefix tag up', exact: true }).click();
  await expect(sequence.getByRole('listitem').nth(1)).toContainText('Prefix tag');
  expect((await pipeline(request)).entries.at(-1)?.name).toBe('Prefix tag');
  await save(page);
  expect(await tag()).toMatch(/^[a-f0-9-]{36}$/);
  await page.reload();
  await openInterceptors(page);
  await expect(sequence.getByRole('listitem').nth(1)).toContainText('Prefix tag');
  await page.getByRole('button', { name: 'Remove Request tag', exact: true }).click();
  await save(page);
  expect(await tag()).toBe('tagged:unset');
  await page.getByRole('button', { name: 'Remove Prefix tag', exact: true }).click();
  await save(page);
  expect(await tag()).toBeNull();
  await expect(sequence.getByRole('listitem')).toHaveCount(1);
  expect((await pipeline(request)).entries).toEqual([
    { id: 'builtin-telemetry', name: 'Token and cost telemetry', source: 'builtin', locked: true },
  ]);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('rejects remote paths, reports failed module loads without changing the pipeline, and confirms discard', async ({ page, request }) => {
  await page.goto('/');
  await openInterceptors(page);
  await add(page, 'Remote module', 'https://example.test/untrusted.js');
  await expect(page.getByRole('alert')).toContainText('Use an absolute local file path');
  await page.getByRole('button', { name: 'Clear add form', exact: true }).click();
  await add(page, 'Missing module', resolve('tests/fixtures/does-not-exist.mjs'));
  await page.getByRole('button', { name: 'Save interceptors', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Cannot load interceptor module');
  expect((await pipeline(request)).entries).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Remove Missing module', exact: true })).toBeEnabled();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await openInterceptors(page);
  await expect(page.getByRole('button', { name: 'Remove Missing module', exact: true })).toHaveCount(0);
  await expect(page.getByText('Token and cost telemetry', { exact: true })).toBeVisible();
});
