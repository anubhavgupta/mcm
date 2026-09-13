import { defaultTheme, getTheme, themeSchema, type ThemeId } from '../shared/themes';

let savedTheme: ThemeId = defaultTheme;

function setBrowserColor(target: Document, color: string): void {
  let meta = target.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = target.createElement('meta');
    meta.name = 'theme-color';
    target.head.append(meta);
  }
  meta.content = color;
}

export function applyTheme(id: ThemeId, documentToTheme: Document = document): void {
  const theme = getTheme(id);
  const root = documentToTheme.documentElement;
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.colorScheme;
  setBrowserColor(documentToTheme, theme.colors.canvas);
  for (const [role, color] of Object.entries(theme.colors)) root.style.setProperty(`--palette-${role}`, color);
  root.style.setProperty('--select-chevron', `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='${theme.colors.muted.replace('#', '%23')}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`);
}

export function applySavedTheme(value: unknown): ThemeId {
  savedTheme = themeSchema.parse(value);
  applyTheme(savedTheme);
  return savedTheme;
}

export function restoreSavedTheme(): void {
  applyTheme(savedTheme);
}

export function mirrorTheme(target: Document): () => void {
  const source = document.documentElement;
  const sync = () => {
    target.documentElement.style.cssText = source.style.cssText;
    setBrowserColor(target, source.style.getPropertyValue('--palette-canvas'));
    if (source.dataset.theme) target.documentElement.dataset.theme = source.dataset.theme;
    else delete target.documentElement.dataset.theme;
  };
  sync();
  const observer = new MutationObserver(sync);
  observer.observe(source, { attributes: true, attributeFilter: ['data-theme', 'style'] });
  return () => observer.disconnect();
}
