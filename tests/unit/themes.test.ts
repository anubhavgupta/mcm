import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultTheme, getTheme, themeIds, themeSchema, themes } from '../../src/shared/themes';

function luminance(hex: string): number {
  const values = hex.slice(1).match(/../g)!.map(value => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('built-in MCM themes', () => {
  it('provides exactly ten stable, distinct palettes and names', () => {
    expect(themes.map(theme => theme.id)).toEqual(themeIds);
    expect(themes.map(theme => theme.name)).toEqual([
      'Dark+', 'Light+', 'Dracula', 'One Dark Pro', 'GitHub Dark',
      'GitHub Light', 'Nord', 'Tokyo Night', 'Solarized Dark', 'Monokai',
    ]);
    expect(new Set(themes.map(theme => JSON.stringify(theme.colors))).size).toBe(10);
    expect(new Set(themeIds).size).toBe(10);
    for (const theme of themes) {
      expect(getTheme(theme.id)).toBe(theme);
      expect(['light', 'dark']).toContain(theme.colorScheme);
      expect(Object.keys(theme.colors)).toEqual(Object.keys(themes[0].colors));
      for (const value of Object.values(theme.colors)) expect(value).toMatch(/^#[a-f0-9]{6}$/);
    }
  });
  it('defaults only absent settings and rejects unknown IDs', () => {
    expect(defaultTheme).toBe('light-plus');
    expect(themeSchema.parse(undefined)).toBe('light-plus');
    for (const value of ['unknown', '', 'Dark+', null, {}, 12]) {
      expect(themeSchema.safeParse(value).success).toBe(false);
    }
  });
  it.each(themes)('$name has readable normal, muted, accent and status text', ({ colors }) => {
    for (const background of [colors.canvas, colors.surface, colors.editor, colors.sidebar]) {
      expect(contrast(colors.text, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(colors.muted, background)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(colors.onAccent, colors.accent)).toBeGreaterThanOrEqual(4.5);
    for (const role of ['accent', 'success', 'warning', 'danger', 'info', 'special'] as const) {
      expect(contrast(colors[role], colors.surface), role).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('keeps the initial Light+ tokens aligned and component CSS semantic', () => {
    const tokens = readFileSync('src/client/tokens.css', 'utf8');
    for (const [role, value] of Object.entries(getTheme(defaultTheme).colors)) {
      expect(tokens).toContain(`--palette-${role}: ${value};`);
    }
    const css = readFileSync('src/client/styles.css', 'utf8');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/i);
    expect(css).not.toMatch(/(?:color|background)[^:;{}]*:\s*(?:white|black)\b/);
    const definitions = new Set([...tokens.matchAll(/(--[\w-]+):/g)].map(match => match[1]));
    for (const match of css.matchAll(/var\((--[\w-]+)/g)) {
      expect(definitions.has(match[1]) || match[1] === '--dialog-gutter', match[1]).toBe(true);
    }
  });
});
