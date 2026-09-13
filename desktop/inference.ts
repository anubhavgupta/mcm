import { z } from 'zod';
import type { DesktopInferenceBindings, NativeInferenceState } from '../src/shared/desktop';
import { defaultTheme, themeSchema, type ThemeId } from '../src/shared/themes';

export interface InferenceWindow {
  navigate(url: string): void;
  close(): void;
  isClosed(): boolean;
  focus(): void;
  setAlwaysOnTop(value: boolean): void;
  setSize(width: number, height: number): void;
  bind(name: string, handler: (...args: unknown[]) => unknown): void;
  executeJs(script: string): Promise<unknown>;
  addEventListener(type: 'close', listener: (event: Event) => void): void;
}

export interface InferenceWindowOptions {
  title: string;
  width: number;
  height: number;
  resizable: true;
  alwaysOnTop: true;
}

export class NativeInferenceError extends TypeError {
  override name = 'NativeInferenceError';
}

const optionsSchema = z.strictObject({
  width: z.number().finite().transform(value => Math.round(Math.min(600, Math.max(240, value)))),
  height: z.number().finite().transform(value => Math.round(Math.min(900, Math.max(200, value)))),
  theme: themeSchema.removeDefault(),
});

export async function evaluateNative(window: Pick<InferenceWindow, 'executeJs'>, script: string): Promise<unknown> {
  const result = await window.executeJs(script);
  // Laufey WebView 0.7 wraps results; CEF returns the value directly.
  if (result && typeof result === 'object' && 'ok' in result) {
    if (result.ok !== true) throw new Error(`Native JavaScript evaluation failed: ${JSON.stringify(result)}`);
    return 'value' in result ? result.value : undefined;
  }
  return result;
}

export class NativeInferenceManager<Window extends InferenceWindow = InferenceWindow> {
  private child: Window | undefined;
  private theme: ThemeId = defaultTheme;
  private stopping = false;
  private pending: Promise<unknown> = Promise.resolve();
  private closingWindows = new WeakSet<Window>();
  private readonly url: string;

  constructor(private readonly options: {
    main: InferenceWindow;
    origin: string;
    ready: Promise<unknown>;
    createWindow: (options: InferenceWindowOptions) => Window;
    reportError?: (error: unknown) => void;
  }) {
    const origin = new URL(options.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
      || origin.origin !== options.origin) {
      throw new NativeInferenceError('Inference requires the local native HTTP origin.');
    }
    this.url = `${origin.origin}/inference`;
  }

  get nativeWindow(): Window | undefined { return this.child; }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  private state(): NativeInferenceState {
    return { open: !!this.child && !this.child.isClosed() };
  }

  private async dispatch(window: InferenceWindow, name: string, detail: unknown): Promise<void> {
    if (window.isClosed()) return;
    try {
      await evaluateNative(window, `window.dispatchEvent(new CustomEvent(${JSON.stringify(name)}, { detail: ${JSON.stringify(detail)} }))`);
    } catch (error) {
      if (!window.isClosed()) throw error;
    }
  }

  private async didClose(window: Window): Promise<void> {
    if (this.child !== window) return;
    this.child = undefined;
    await this.dispatch(this.options.main, 'mcm-inference-state', { open: false });
  }

  private async closeChild(child = this.child, closeRequested = false): Promise<void> {
    if (!child || this.child !== child || this.closingWindows.has(child)) return;
    this.closingWindows.add(child);
    try {
      // Deno can mark isClosed() on an OS close request before the native window is destroyed.
      if (closeRequested || !child.isClosed()) child.close();
      await this.didClose(child);
    } finally { this.closingWindows.delete(child); }
  }

  readonly bindings = {
    mcmOpenInference: (input: unknown) => this.enqueue(async () => {
      const parsed = optionsSchema.safeParse(input);
      if (!parsed.success) throw new NativeInferenceError(`Invalid inference options: ${parsed.error.message}`);
      if (this.stopping) throw new NativeInferenceError('MCM is shutting down.');
      await this.options.ready;
      if (this.stopping) throw new NativeInferenceError('MCM is shutting down.');
      const { width, height, theme } = parsed.data;
      this.theme = theme;
      if (this.child && !this.child.isClosed()) {
        this.child.setSize(width, height);
        this.child.focus();
        await this.dispatch(this.child, 'mcm-inference-theme', { theme });
        return this.state();
      }
      const child = this.options.createWindow({
        title: 'MCM Inference', width, height, resizable: true, alwaysOnTop: true,
      });
      this.child = child;
      try {
        // Apply explicitly as well as at creation for native backend compatibility.
        child.setAlwaysOnTop(true);
        child.addEventListener('close', event => {
          event.preventDefault();
          void this.closeChild(child, true).catch(error => {
            if (this.options.reportError) this.options.reportError(error);
            else console.error('MCM inference window close failed:', error);
          });
        });
        // The child has no window-management or other privileged bindings.
        child.bind('mcmGetInferenceTheme', this.bindings.mcmGetInferenceTheme);
        child.navigate(this.url);
        return this.state();
      } catch (error) {
        try { await this.closeChild(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Inference window creation and cleanup failed.'); }
        throw error;
      }
    }),
    mcmCloseInference: () => this.enqueue(async () => {
      await this.closeChild();
      return this.state();
    }),
    mcmInferenceState: () => Promise.resolve(this.state()),
    mcmSetInferenceTheme: (input: unknown) => this.enqueue(async () => {
      const parsed = themeSchema.removeDefault().safeParse(input);
      if (!parsed.success) throw new NativeInferenceError('Invalid inference theme.');
      this.theme = parsed.data;
      if (this.child) await this.dispatch(this.child, 'mcm-inference-theme', { theme: this.theme });
    }),
    mcmGetInferenceTheme: () => Promise.resolve(this.theme),
  } satisfies DesktopInferenceBindings;

  registerBindings(): void {
    const main = this.options.main;
    main.bind('mcmOpenInference', this.bindings.mcmOpenInference);
    main.bind('mcmCloseInference', this.bindings.mcmCloseInference);
    main.bind('mcmInferenceState', this.bindings.mcmInferenceState);
    main.bind('mcmSetInferenceTheme', this.bindings.mcmSetInferenceTheme);
    main.bind('mcmGetInferenceTheme', this.bindings.mcmGetInferenceTheme);
  }

  shutdown(): Promise<void> {
    this.stopping = true;
    return this.enqueue(() => this.closeChild());
  }
}
