import { describe, expect, it, vi } from 'vitest';
import { evaluateNative, NativeInferenceError, NativeInferenceManager, type InferenceWindow, type InferenceWindowOptions } from '../../desktop/inference';
import { desktopNativeOrigin } from '../../desktop/options';
import type { GeometryPersistence } from '../../desktop/inference-geometry';

class FakeWindow extends EventTarget implements InferenceWindow {
  closed = false;
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  navigate = vi.fn<(url: string) => void>();
  close = vi.fn(() => { this.closed = true; });
  isClosed = () => this.closed;
  focus = vi.fn();
  setAlwaysOnTop = vi.fn();
  setSize = vi.fn();
  getSize = vi.fn<() => [number, number]>().mockReturnValue([300, 320]);
  getPosition = vi.fn<() => [number, number]>().mockReturnValue([100, 200]);
  setPosition = vi.fn();
  executeJs = vi.fn<(script: string) => Promise<unknown>>().mockResolvedValue({ ok: true, value: true });
  bind = vi.fn((name: string, handler: (...args: unknown[]) => unknown) => { this.handlers.set(name, handler); });
  userClose() {
    const event = new Event('close', { cancelable: true });
    this.dispatchEvent(event);
  }
}

const defaults = { width: 300, height: 320, theme: 'nord' as const };

function fixture(ready: Promise<unknown> = Promise.resolve(), geometry?: GeometryPersistence) {
  const main = new FakeWindow();
  const children: FakeWindow[] = [];
  const createWindow = vi.fn((_options: InferenceWindowOptions) => {
    const child = new FakeWindow();
    children.push(child);
    return child;
  });
  const reportError = vi.fn();
  const manager = new NativeInferenceManager({ main, origin: 'http://127.0.0.1:45678', ready, createWindow, reportError, geometry });
  manager.registerBindings();
  return { manager, bindings: manager.bindings, main, children, createWindow, reportError };
}

describe('native inference window', () => {
  it('registers the exact main bindings before startup and creates only at the ready native origin', async () => {
    let resolve!: () => void;
    const ready = new Promise<void>(done => { resolve = done; });
    const { main, bindings, children, createWindow } = fixture(ready);
    expect([...main.handlers.keys()].sort()).toEqual([
      'mcmCloseInference', 'mcmGetInferenceTheme', 'mcmInferenceState',
      'mcmOpenInference', 'mcmSetInferenceTheme',
    ]);
    const opening = main.handlers.get('mcmOpenInference')!(defaults);
    await Promise.resolve();
    expect(createWindow).not.toHaveBeenCalled();
    resolve();
    await expect(opening).resolves.toEqual({ open: true });
    expect(createWindow).toHaveBeenCalledWith({
      title: 'MCM Inference', width: 300, height: 320, alwaysOnTop: true, resizable: true, frameless: true,
    });
    expect(children[0].navigate).toHaveBeenCalledWith('http://127.0.0.1:45678/inference');
    expect(children[0].setAlwaysOnTop).toHaveBeenCalledWith(true);
    expect([...children[0].handlers.keys()]).toEqual(['mcmGetInferenceTheme', 'mcmCloseInference', 'mcmDragInference']);
    await expect(children[0].handlers.get('mcmGetInferenceTheme')!()).resolves.toBe('nord');
    await expect(bindings.mcmInferenceState()).resolves.toEqual({ open: true });
  });

  it('validates native addresses without permitting another origin or route', () => {
    expect(desktopNativeOrigin({ DENO_SERVE_ADDRESS: 'tcp:127.0.0.1:45678' })).toBe('http://127.0.0.1:45678');
    expect(() => desktopNativeOrigin({})).toThrow('DENO_SERVE_ADDRESS');
    expect(() => desktopNativeOrigin({ DENO_SERVE_ADDRESS: 'tcp:example.com:45678' })).toThrow('DENO_SERVE_ADDRESS');
    for (const origin of ['https://127.0.0.1:45678', 'http://example.com', 'http://127.0.0.1:45678/spoof', 'http://user@127.0.0.1:45678']) {
      expect(() => new NativeInferenceManager({
        main: new FakeWindow(), origin, ready: Promise.resolve(), createWindow: () => new FakeWindow(),
      })).toThrow(NativeInferenceError);
    }
  });

  it.each([
    [-1, 9999, 240, 900], [9999, -1, 600, 200], [300.8, 320.2, 301, 320],
  ])('clamps and rounds initial dimensions %s x %s', async (width, height, expectedWidth, expectedHeight) => {
    const { bindings, createWindow } = fixture();
    await bindings.mcmOpenInference({ ...defaults, width, height });
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({ width: expectedWidth, height: expectedHeight }));
  });

  it.each([
    undefined, null, [], {}, { ...defaults, url: 'https://example.com' },
    { ...defaults, width: NaN }, { ...defaults, height: Infinity },
    { ...defaults, width: '300' }, { ...defaults, theme: undefined },
    { ...defaults, theme: 'not-a-theme' }, { ...defaults, theme: '</script>' },
  ])('rejects malformed options explicitly: %j', async input => {
    const { bindings, createWindow } = fixture();
    await expect(bindings.mcmOpenInference(input)).rejects.toBeInstanceOf(NativeInferenceError);
    expect(createWindow).not.toHaveBeenCalled();
    await expect(bindings.mcmInferenceState()).resolves.toEqual({ open: false });
  });

  it('serializes overlapping opens, reuses and focuses one native window', async () => {
    const { bindings, createWindow, children } = fixture();
    await Promise.all([
      bindings.mcmOpenInference(defaults),
      bindings.mcmOpenInference({ ...defaults, theme: 'dracula' }),
      bindings.mcmOpenInference(defaults),
    ]);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(children[0].focus).toHaveBeenCalledTimes(2);
    expect(children[0].setSize).not.toHaveBeenCalled();
    expect(children[0].executeJs).toHaveBeenCalledWith(expect.stringContaining('"mcm-inference-theme"'));
  });
  it('restores saved bounds and remembers adjustments on close and subsequent reopen', async () => {
    const geometry = {
      load: vi.fn().mockResolvedValue({ width: 420, height: 650, x: -800, y: 125 }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const { bindings, createWindow, children } = fixture(Promise.resolve(), geometry);
    await bindings.mcmOpenInference(defaults);
    expect(createWindow).toHaveBeenCalledWith(expect.objectContaining({ width: 420, height: 650, x: -800, y: 125 }));
    children[0].getSize.mockReturnValue([500, 700]);
    children[0].getPosition.mockReturnValue([-600, 150]);
    await bindings.mcmCloseInference();
    expect(geometry.save).toHaveBeenLastCalledWith({ width: 500, height: 700, x: -600, y: 150 });
    await bindings.mcmOpenInference(defaults);
    expect(createWindow).toHaveBeenLastCalledWith(expect.objectContaining({ width: 500, height: 700, x: -600, y: 150 }));
    expect(geometry.load).toHaveBeenCalledTimes(1);
  });
  it('debounces move/resize persistence and flushes on shutdown', async () => {
    vi.useFakeTimers();
    try {
      const geometry = { load: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined) };
      const { bindings, children, manager } = fixture(Promise.resolve(), geometry);
      await bindings.mcmOpenInference(defaults);
      children[0].getSize.mockReturnValue([400, 500]);
      children[0].dispatchEvent(new Event('resize'));
      children[0].getPosition.mockReturnValue([200, 250]);
      children[0].dispatchEvent(new Event('move'));
      expect(geometry.save).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(geometry.save).toHaveBeenCalledTimes(1);
      expect(geometry.save).toHaveBeenLastCalledWith({ width: 400, height: 500, x: 200, y: 250 });
      children[0].getPosition.mockReturnValue([300, 350]);
      children[0].dispatchEvent(new Event('move'));
      await manager.shutdown();
      expect(geometry.save).toHaveBeenLastCalledWith({ width: 400, height: 500, x: 300, y: 350 });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('reports persistence errors without trapping the user in the popup', async () => {
    const geometry = { load: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockRejectedValue(new Error('disk full')) };
    const { bindings, children, main, reportError } = fixture(Promise.resolve(), geometry);
    await bindings.mcmOpenInference(defaults);
    await bindings.mcmCloseInference();
    expect(children[0].closed).toBe(true);
    expect(reportError).toHaveBeenCalled();
    expect(main.executeJs).toHaveBeenCalledWith(expect.stringContaining('mcm-inference-error'));
  });

  it('OS close restores the parent state without closing main, and permits reopen', async () => {
    const { bindings, children, main } = fixture();
    await bindings.mcmOpenInference(defaults);
    children[0].userClose();
    expect(children[0].close).toHaveBeenCalledTimes(1);
    expect(children[0].closed).toBe(true);
    await expect(bindings.mcmInferenceState()).resolves.toEqual({ open: false });
    expect(main.executeJs).toHaveBeenCalledWith(expect.stringContaining('"mcm-inference-state", { detail: {"open":false}'));
    expect(main.close).not.toHaveBeenCalled();
    await bindings.mcmOpenInference(defaults);
    expect(children).toHaveLength(2);
    children[0].dispatchEvent(new Event('close'));
    await expect(bindings.mcmInferenceState()).resolves.toEqual({ open: true });
  });
  it('explicitly closes on an OS request even when Deno already reports isClosed', async () => {
    const { bindings, children, main } = fixture();
    await bindings.mcmOpenInference(defaults);
    children[0].closed = true;
    children[0].userClose();
    expect(children[0].close).toHaveBeenCalledTimes(1);
    await expect(bindings.mcmInferenceState()).resolves.toEqual({ open: false });
    expect(main.close).not.toHaveBeenCalled();
    await bindings.mcmOpenInference(defaults);
    expect(children).toHaveLength(2);
  });
  it('handles reentrant native close events without repeated close calls or notifications', async () => {
    const { bindings, children, main } = fixture();
    await bindings.mcmOpenInference(defaults);
    children[0].close.mockImplementation(() => {
      children[0].userClose();
      children[0].closed = true;
    });
    children[0].userClose();
    await expect(bindings.mcmInferenceState()).resolves.toEqual({ open: false });
    expect(children[0].close).toHaveBeenCalledTimes(1);
    expect(main.executeJs).toHaveBeenCalledTimes(1);
  });

  it('programmatic close notifies main even when the runtime emits no close event', async () => {
    const { bindings, children, main } = fixture();
    await bindings.mcmOpenInference(defaults);
    await expect(bindings.mcmCloseInference()).resolves.toEqual({ open: false });
    await bindings.mcmCloseInference();
    expect(children[0].close).toHaveBeenCalledTimes(1);
    expect(main.executeJs).toHaveBeenCalledTimes(1);
  });
  it('moves the frameless child relative to the initial screen position and stops after release', async () => {
    const { bindings, children } = fixture();
    await bindings.mcmOpenInference(defaults);
    const drag = children[0].handlers.get('mcmDragInference')!;
    await drag({ phase: 'start', screenX: 400, screenY: 500 });
    await drag({ phase: 'move', screenX: 430, screenY: 540 });
    expect(children[0].setPosition).toHaveBeenLastCalledWith(130, 240);
    await drag({ phase: 'end', screenX: 450, screenY: 560 });
    expect(children[0].setPosition).toHaveBeenLastCalledWith(150, 260);
    await drag({ phase: 'move', screenX: 900, screenY: 900 });
    expect(children[0].setPosition).toHaveBeenCalledTimes(2);
    await expect(drag({ phase: 'start', screenX: Infinity, screenY: 0 })).rejects.toThrow('Invalid inference drag');
    await children[0].handlers.get('mcmCloseInference')!();
    expect(children[0].closed).toBe(true);
    await bindings.mcmOpenInference(defaults);
    await children[0].handlers.get('mcmCloseInference')!();
    expect(children[1].closed).toBe(false);
    await expect(drag({ phase: 'start', screenX: 0, screenY: 0 })).rejects.toThrow('window is closed');
  });

  it('persists the latest valid theme while closed, propagates it live and reads it after reopen', async () => {
    const { bindings, children } = fixture();
    await expect(bindings.mcmGetInferenceTheme()).resolves.toBe('light-plus');
    await bindings.mcmSetInferenceTheme('monokai');
    await expect(bindings.mcmGetInferenceTheme()).resolves.toBe('monokai');
    await bindings.mcmOpenInference({ ...defaults, theme: 'monokai' });
    await bindings.mcmSetInferenceTheme('tokyo-night');
    expect(children[0].executeJs).toHaveBeenCalledWith('window.dispatchEvent(new CustomEvent("mcm-inference-theme", { detail: {"theme":"tokyo-night"} }))');
    for (const theme of [undefined, null, 'invalid', { theme: 'nord' }]) {
      await expect(bindings.mcmSetInferenceTheme(theme)).rejects.toBeInstanceOf(NativeInferenceError);
    }
    await expect(bindings.mcmGetInferenceTheme()).resolves.toBe('tokyo-night');
    await bindings.mcmCloseInference();
    await bindings.mcmSetInferenceTheme('github-light');
    await bindings.mcmOpenInference({ ...defaults, theme: 'github-light' });
    await expect(children[1].handlers.get('mcmGetInferenceTheme')!()).resolves.toBe('github-light');
  });

  it('shutdown closes the child before finishing and prevents reopen', async () => {
    const { bindings, manager, children } = fixture();
    await bindings.mcmOpenInference(defaults);
    await manager.shutdown();
    expect(children[0].closed).toBe(true);
    await expect(bindings.mcmOpenInference(defaults)).rejects.toThrow('shutting down');
    await manager.shutdown();
    expect(children[0].close).toHaveBeenCalledTimes(1);
  });

  it('does not create a child if shutdown starts while open is awaiting startup', async () => {
    let resolve!: () => void;
    const { bindings, manager, createWindow } = fixture(new Promise<void>(done => { resolve = done; }));
    const opening = bindings.mcmOpenInference(defaults);
    await Promise.resolve();
    const stopped = manager.shutdown();
    resolve();
    await expect(opening).rejects.toThrow('shutting down');
    await stopped;
    expect(createWindow).not.toHaveBeenCalled();
  });

  it('reports backend startup failure without constructing a window', async () => {
    const { bindings, createWindow } = fixture(Promise.reject(new Error('backend failed')));
    await expect(bindings.mcmOpenInference(defaults)).rejects.toThrow('backend failed');
    expect(createWindow).not.toHaveBeenCalled();
  });

  it.each(['setAlwaysOnTop', 'bind', 'navigate'] as const)('cleans up a child after %s fails and allows retry', async method => {
    const { bindings, createWindow, main } = fixture();
    const child = new FakeWindow();
    child[method].mockImplementation(() => { throw new Error('native failed'); });
    createWindow.mockReturnValueOnce(child);
    await expect(bindings.mcmOpenInference(defaults)).rejects.toThrow('native failed');
    expect(child.closed).toBe(true);
    expect(main.close).not.toHaveBeenCalled();
    await expect(bindings.mcmInferenceState()).resolves.toEqual({ open: false });
    await expect(bindings.mcmOpenInference(defaults)).resolves.toEqual({ open: true });
  });

  it('propagates construction failure and preserves a failed-close child for shutdown retry', async () => {
    const { bindings, manager, createWindow } = fixture();
    createWindow.mockImplementationOnce(() => { throw new Error('creation failed'); });
    await expect(bindings.mcmOpenInference(defaults)).rejects.toThrow('creation failed');
    const child = new FakeWindow();
    child.navigate.mockImplementationOnce(() => { throw new Error('navigation failed'); });
    child.close.mockImplementationOnce(() => { throw new Error('close failed'); });
    createWindow.mockReturnValueOnce(child);
    await expect(bindings.mcmOpenInference(defaults)).rejects.toBeInstanceOf(AggregateError);
    expect(manager.nativeWindow).toBe(child);
    await manager.shutdown();
    expect(child.closed).toBe(true);
  });

  it('reports execution failures and ignores only windows known to have closed', async () => {
    const { bindings, children, main, reportError } = fixture();
    await bindings.mcmOpenInference(defaults);
    children[0].executeJs.mockResolvedValueOnce({ ok: false, error: 'no window' });
    await expect(bindings.mcmSetInferenceTheme('dracula')).rejects.toThrow('Native JavaScript evaluation failed');
    children[0].executeJs.mockImplementationOnce(async () => {
      children[0].closed = true;
      throw new Error('window closed during evaluation');
    });
    await expect(bindings.mcmSetInferenceTheme('nord')).resolves.toBeUndefined();
    await bindings.mcmOpenInference(defaults);
    main.executeJs.mockRejectedValueOnce(new Error('parent execution failed'));
    children[1].userClose();
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'parent execution failed' })));
  });

  it('decodes Laufey result envelopes without misinterpreting false as a successful assertion', async () => {
    const window = new FakeWindow();
    window.executeJs.mockResolvedValueOnce({ ok: true, value: false });
    await expect(evaluateNative(window, 'false')).resolves.toBe(false);
    window.executeJs.mockResolvedValueOnce(true);
    await expect(evaluateNative(window, 'true')).resolves.toBe(true);
    window.executeJs.mockResolvedValueOnce({ ok: false });
    await expect(evaluateNative(window, 'broken')).rejects.toThrow('evaluation failed');
  });
});
