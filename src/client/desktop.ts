import type { DesktopInferenceBindings, InferenceWindowBindings } from '../shared/desktop';
import { themeSchema } from '../shared/themes';

declare global {
  interface Window { bindings?: Partial<DesktopInferenceBindings & InferenceWindowBindings> }
}

export function desktopInference(): DesktopInferenceBindings | undefined {
  const bindings = window.bindings;
  if (!bindings) return undefined;
  const { mcmOpenInference, mcmCloseInference, mcmInferenceState, mcmSetInferenceTheme, mcmGetInferenceTheme } = bindings;
  if (!mcmOpenInference || !mcmCloseInference || !mcmInferenceState || !mcmSetInferenceTheme || !mcmGetInferenceTheme) return undefined;
  return {
    mcmOpenInference: options => mcmOpenInference(options),
    mcmCloseInference: () => mcmCloseInference(),
    mcmInferenceState: () => mcmInferenceState(),
    mcmSetInferenceTheme: theme => mcmSetInferenceTheme(theme),
    mcmGetInferenceTheme: () => mcmGetInferenceTheme(),
  };
}

export function currentTheme() {
  return themeSchema.parse(document.documentElement.dataset.theme);
}
