import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { emptyWorkspace } from '../../src/shared/config';
import { themes } from '../../src/shared/themes';
import { decodeWorkspace } from '../../src/shared/sharing';

async function settings(page: Page) {
  await page.getByRole('region', { name: 'Server controls' }).waitFor();
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('button', { name: 'Machine settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
}

const rgb = (hex: string) => `rgb(${hex.slice(1).match(/../g)!.map(value => parseInt(value, 16)).join(', ')})`;

test.beforeEach(async ({ request }) => {
  await request.post('/api/stop');
  expect((await request.put('/api/workspace', { data: emptyWorkspace() })).ok()).toBe(true);
  expect((await request.put('/api/settings', { data: { theme: 'light-plus', modelsDirectory: resolve('tests/fixtures/models') } })).ok()).toBe(true);
});

for (const theme of themes) {
  test(`${theme.name} theme previews, persists across reload, and covers the entire layout`, async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light-plus');
    await settings(page);
    const select = page.getByRole('combobox', { name: 'Theme', exact: true });
    await expect(select.locator('option')).toHaveText(themes.map(theme => theme.name));
    const before = (await (await request.get('/api/bootstrap')).json()).settings.theme;
    await select.selectOption(theme.id);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme.colorScheme);
    await expect(select).toHaveCSS('background-color', rgb(theme.colors.surface));
    await expect(page.locator('.dialog')).toHaveCSS('background-color', rgb(theme.colors.surface));
    await expect(page.locator('.dialog-actions')).toHaveCSS('background-color', rgb(theme.colors.surface));
    await expect(page.locator('.theme-preview')).toHaveCSS('background-color', rgb(theme.colors.editor));
    await expect.poll(() => select.evaluate(element => getComputedStyle(element).backgroundImage)).toContain(theme.colors.muted.slice(1));
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', theme.colors.canvas);
    expect((await (await request.get('/api/bootstrap')).json()).settings.theme).toBe(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(async () => (await (await request.get('/api/bootstrap')).json()).settings.theme).toBe(theme.id);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await expect(page.locator('body')).toHaveCSS('background-color', rgb(theme.colors.canvas));
    await expect(page.locator('.sidebar')).toHaveCSS('background-color', rgb(theme.colors.sidebar));
    for (const selector of ['.topbar', '.launch-strip', '.field-card:not(.dependency-disabled)', '.runtime-card', '.save-bar']) {
      await expect(page.locator(selector).first()).toHaveCSS('background-color', rgb(theme.colors.surface));
    }
    await expect(page.locator('.log-window')).toHaveCSS('background-color', rgb(theme.colors.editor));
    await expect(page.locator('.field-help').first()).toHaveCSS('color', rgb(theme.colors.muted));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  });
}

test('cancel and escape restore the saved theme without persisting preview changes', async ({ page, request }) => {
  await request.put('/api/settings', { data: { theme: 'github-dark' } });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'github-dark');
  for (const action of ['Cancel', 'Escape']) {
    await settings(page);
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light-plus');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light-plus');
    page.once('dialog', dialog => dialog.accept());
    if (action === 'Cancel') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'github-dark');
    expect((await (await request.get('/api/bootstrap')).json()).settings.theme).toBe('github-dark');
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'github-dark');
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const link = await page.getByRole('textbox', { name: 'Workspace share link', exact: true }).inputValue();
  expect(decodeWorkspace(new URL(link).hash.slice(8))).not.toHaveProperty('theme');
  await expect(page.locator('.dialog')).toHaveCSS('background-color', 'rgb(22, 27, 34)');
  await expect(page.locator('.share-summary')).toHaveCSS('background-color', 'rgb(16, 22, 30)');
});

test('failed saves keep the preview editable and cancel restores the server choice', async ({ page, request }) => {
  await page.goto('/');
  await settings(page);
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('monokai');
  await page.route('**/api/settings', route => route.fulfill({
    status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Settings could not be saved' }),
  }));
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.locator('.dialog-feedback[role="alert"]')).toContainText('Settings could not be saved');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'monokai');
  expect((await (await request.get('/api/bootstrap')).json()).settings.theme).toBe('light-plus');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light-plus');
});

test('legacy bootstrap uses Light+ but malformed theme data fails visibly', async ({ page }) => {
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    delete data.settings.theme;
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light-plus');
  await page.unroute('**/api/bootstrap');
  await page.route('**/api/bootstrap', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.settings.theme = 'unknown-theme';
    await route.fulfill({ response, json: data });
  });
  await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Machine settings', exact: true })).toHaveCount(0);
});
