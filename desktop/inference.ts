import { z } from 'zod';
import type { DesktopInferenceBindings, NativeInferenceState } from '../src/shared/desktop';
import { defaultTheme, themeSchema, type ThemeId } from '../src/shared/themes';
import { inferenceGeometrySchema, type GeometryPersistence, type InferenceGeometry } from './inference-geometry';

export interface InferenceWindow {
  navigate(url: string): void;
  close(): void;
  isClosed(): boolean;
  focus(): void;
  setAlwaysOnTop(value: boolean): void;
  setSize(width: number, height: number): void;
  getSize(): [number, number];
  getPosition(): [number, number];
  setPosition(x: number, y: number): void;
  bind(name: string, handler: (...args: unknown[]) => unknown): void;
  executeJs(script: string): Promise<unknown>;
  addEventListener(type: 'close' | 'resize' | 'move', listener: (event: Event) => void): void;
}

export interface InferenceWindowOptions {
  title: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  resizable: true;
  alwaysOnTop: true;
  frameless: true;
}

export class NativeInferenceError extends TypeError {
  override name = 'NativeInferenceError';
}

const optionsSchema = z.strictObject({
  width: z.number().finite().transform(value => Math.round(Math.min(600, Math.max(240, value)))),
  height: z.number().finite().transform(value => Math.round(Math.min(900, Math.max(200, value)))),
  theme: themeSchema.removeDefault(),
});
const dragSchema = z.strictObject({
  phase: z.enum(['start', 'move', 'end']),
  screenX: z.number().finite().min(-1_000_000).max(1_000_000),
  screenY: z.number().finite().min(-1_000_000).max(1_000_000),
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
  private drag: { child: Window; screenX: number; screenY: number; x: number; y: number } | undefined;
  private readonly url: string;
  private geometry: InferenceGeometry | undefined;
  private geometryLoaded = false;
  private geometryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: {
    main: InferenceWindow;
    origin: string;
    ready: Promise<unknown>;
    createWindow: (options: InferenceWindowOptions) => Window;
    reportError?: (error: unknown) => void;
    geometry?: GeometryPersistence;
  }) {
    const origin = new URL(options.origin);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
      || origin.origin !== options.origin) {
      throw new NativeInferenceError('Inference requires the local native HTTP origin.');
    }
    this.url = `${origin.origin}/inference`;
  }

  get nativeWindow(): Window | undefined { return this.child; }

  private captureGeometry(child: Window): void {
    const [width, height] = child.getSize();
    const [x, y] = child.getPosition();
    // Minimized/native-closing windows can report zero dimensions; retain the last usable bounds.
    if (width <= 0 || height <= 0) return;
    this.geometry = inferenceGeometrySchema.parse({
      width: Math.round(width), height: Math.round(height), x: Math.round(x), y: Math.round(y),
    });
  }

  private async saveGeometry(): Promise<void> {
    if (this.geometryTimer) clearTimeout(this.geometryTimer);
    this.geometryTimer = undefined;
    if (this.geometry && this.options.geometry) await this.options.geometry.save(this.geometry);
  }

  private reportGeometryError(error: unknown): void {
    const message = 'Could not save inference window size and position. Check data-directory permissions and free space.';
    if (this.options.reportError) this.options.reportError(error);
    else console.error(message, error);
    void this.dispatch(this.options.main, 'mcm-inference-error', { message }).catch(failure => console.error(message, failure));
  }

  private geometryChanged(child: Window): void {
    if (this.child !== child || child.isClosed() || this.closingWindows.has(child)) return;
    try {
      this.captureGeometry(child);
      if (this.geometryTimer) clearTimeout(this.geometryTimer);
      this.geometryTimer = setTimeout(() => { void this.saveGeometry().catch(error => this.reportGeometryError(error)); }, 250);
    } catch (error) { this.reportGeometryError(error); }
  }

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
    this.drag = undefined;
    this.child = undefined;
    await this.dispatch(this.options.main, 'mcm-inference-state', { open: false });
  }

  private async closeChild(child = this.child, closeRequested = false): Promise<void> {
    if (!child || this.child !== child || this.closingWindows.has(child)) return;
    this.closingWindows.add(child);
    try {
      try {
        this.captureGeometry(child);
      } catch (error) { this.reportGeometryError(error); }
      // Deno can mark isClosed() on an OS close request before the native window is destroyed.
      if (closeRequested || !child.isClosed()) child.close();
      await this.didClose(child);
      try { await this.saveGeometry(); }
      catch (error) { this.reportGeometryError(error); }
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
        this.child.focus();
        await this.dispatch(this.child, 'mcm-inference-theme', { theme });
        return this.state();
      }
      if (!this.geometryLoaded) {
        this.geometry = await this.options.geometry?.load();
        this.geometryLoaded = true;
      }
      if (this.stopping) throw new NativeInferenceError('MCM is shutting down.');
      const child = this.options.createWindow({
        title: 'MCM Inference', width, height, resizable: true, alwaysOnTop: true, frameless: true,
        ...this.geometry,
      });
      this.child = child;
      try {
        // Apply explicitly as well as at creation for native backend compatibility.
        child.setAlwaysOnTop(true);
        child.addEventListener('resize', () => this.geometryChanged(child));
        child.addEventListener('move', () => this.geometryChanged(child));
        child.addEventListener('close', event => {
          event.preventDefault();
          void this.closeChild(child, true).catch(error => {
            if (this.options.reportError) this.options.reportError(error);
            else console.error('MCM inference window close failed:', error);
          });
        });
        // Child controls affect only this particular inference window, never a replacement or the main app.
        child.bind('mcmGetInferenceTheme', this.bindings.mcmGetInferenceTheme);
        child.bind('mcmCloseInference', () => this.enqueue(async () => {
          await this.closeChild(child, true);
          return this.state();
        }));
        child.bind('mcmDragInference', input => this.enqueue(async () => {
          const parsed = dragSchema.safeParse(input);
          if (!parsed.success) throw new NativeInferenceError('Invalid inference drag coordinates.');
          if (this.child !== child || child.isClosed()) throw new NativeInferenceError('Inference window is closed.');
          const { phase, screenX, screenY } = parsed.data;
          if (phase === 'start') {
            const [x, y] = child.getPosition();
            this.drag = { child, screenX, screenY, x, y };
          } else if (this.drag?.child === child) {
            const drag = this.drag;
            child.setPosition(Math.round(drag.x + screenX - drag.screenX), Math.round(drag.y + screenY - drag.screenY));
            if (phase === 'end') {
              this.drag = undefined;
              this.geometryChanged(child);
            }
          }
        }));
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
